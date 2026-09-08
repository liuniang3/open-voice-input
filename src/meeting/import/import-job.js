"use strict";

const path = require("node:path");
const { importWavToSession } = require("./import-wav");
const { importMediaToSession } = require("./import-media");

const PATH_IN_MSG_RE = /([A-Za-z]:\\|\\\\|\/(?:Users|home|tmp|var|opt)\/|[A-Za-z]:\/)/i;
const SECRET_IN_MSG_RE = /(sk-[A-Za-z0-9]{10,}|api[_-]?key|bearer\s+\S+)/i;

/** Safe short message for session.json / IPC — strip absolute paths and secrets. */
function sanitizeImportErrorMessage(message, maxLen = 160) {
  let s = String(message || "import failed");
  s = s.replace(SECRET_IN_MSG_RE, "[redacted]");
  s = s.replace(/[A-Za-z]:\\[^\s"']+/g, "[path]");
  s = s.replace(/\\\\[^\s"']+/g, "[path]");
  s = s.replace(/\/(?:Users|home|tmp|var|opt)\/[^\s"']+/g, "[path]");
  if (PATH_IN_MSG_RE.test(s)) s = s.replace(PATH_IN_MSG_RE, "[path]");
  s = s.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s || "import failed";
}

/**
 * In-process import job table. One active job per sessionId.
 * Absolute source paths stay in memory only — never written to session/IPC/logs.
 * Background failures return results (never throw out of the tracked promise).
 */
function createImportJobManager({
  getStore,
  logger = () => {},
  ffmpegOptions = null
} = {}) {
  /**
   * @type {Map<string, {
   *   controller: AbortController,
   *   promise: Promise<any>,
   *   status: string,
   *   phase: string,
   *   progress: { bytes?: number, total?: number }|null
   * }>}
   */
  const jobs = new Map();

  function log(event, detail = {}) {
    const safe = { ...detail };
    delete safe.sourcePath;
    delete safe.absSource;
    delete safe.path;
    if (safe.message) safe.message = sanitizeImportErrorMessage(safe.message, 120);
    logger({ event, ...safe });
  }

  function setJobProgress(id, phase, progress = null) {
    const job = jobs.get(id);
    if (!job) return;
    job.phase = phase || job.phase;
    if (progress) job.progress = progress;
  }

  async function startImport({
    sourcePath,
    sessionId,
    sessionDir,
    title = "",
    reimport = false,
    kind = "wav",
    track = "microphone",
    role = null
  } = {}) {
    const id = String(sessionId || "");
    if (!id || !sessionDir || !sourcePath) {
      const error = new Error("import start requires sessionId, sessionDir, sourcePath");
      error.code = "import_invalid";
      throw error;
    }
    if (jobs.has(id)) {
      const error = new Error("import already running for session");
      error.code = "import_already_running";
      throw error;
    }
    const store = getStore();
    const importer = kind === "media" ? "media" : "wav";
    await store.updateSession(id, {
      status: "importing",
      source: "import",
      title: String(title || "").slice(0, 200),
      import: {
        phase: "starting",
        importer,
        track: track === "system" ? "system" : "microphone",
        startedAt: new Date().toISOString()
      }
    });

    const controller = new AbortController();
    const jobRec = {
      controller,
      promise: null,
      status: "importing",
      phase: "starting",
      progress: null
    };
    jobs.set(id, jobRec);

    const promise = (async () => {
      try {
        const onProgress = (p) => {
          setJobProgress(id, p?.phase || "running", {
            bytes: p?.bytes,
            total: p?.total
          });
        };
        const common = {
          sourcePath,
          sessionDir,
          sessionId: id,
          title,
          track,
          role,
          signal: controller.signal,
          reimport,
          onProgress
        };
        const result =
          importer === "media"
            ? await importMediaToSession({
                ...common,
                ...(ffmpegOptions && typeof ffmpegOptions === "function"
                  ? ffmpegOptions()
                  : ffmpegOptions || {})
              })
            : await importWavToSession(common);
        await store.updateSession(id, result.sessionPatch);
        log("import_done", { sessionId: id, status: "stopped", importer });
        return {
          ok: true,
          sessionId: id,
          status: "stopped",
          archive: result.archive,
          import: result.import
        };
      } catch (error) {
        const aborted = error?.code === "aborted" || controller.signal.aborted;
        const status = aborted ? "import_cancelled" : "import_failed";
        const safeMsg = sanitizeImportErrorMessage(error?.message || error);
        await store
          .updateSession(id, {
            status,
            source: "import",
            import: {
              phase: aborted ? "cancelled" : "failed",
              importer,
              code: aborted ? "import_cancelled" : error?.code || "import_failed",
              message: safeMsg
            }
          })
          .catch(() => {});
        log("import_end", {
          sessionId: id,
          status,
          code: error?.code || null,
          message: safeMsg,
          importer
        });
        return {
          ok: false,
          sessionId: id,
          status,
          cancelled: aborted,
          error: { code: aborted ? "import_cancelled" : error?.code || "import_failed", message: safeMsg }
        };
      } finally {
        jobs.delete(id);
      }
    })();

    // Prevent unhandled rejection if nobody awaits
    promise.catch(() => {});
    jobRec.promise = promise;
    return { ok: true, sessionId: id, status: "importing", kind: importer };
  }

  function getImportStatus(sessionId) {
    const id = String(sessionId || "");
    const job = jobs.get(id);
    if (job) {
      return {
        ok: true,
        sessionId: id,
        status: "importing",
        running: true,
        phase: job.phase || "running",
        progress: job.progress
          ? {
              bytes: Number(job.progress.bytes) || 0,
              total: Number(job.progress.total) || 0
            }
          : null
      };
    }
    return { ok: true, sessionId: id, status: null, running: false, phase: null, progress: null };
  }

  async function cancelImport(sessionId) {
    const id = String(sessionId || "");
    const job = jobs.get(id);
    if (!job) {
      return { ok: true, sessionId: id, status: "idle", cancelled: false };
    }
    job.controller.abort();
    const result = await job.promise.catch(() => ({
      ok: false,
      sessionId: id,
      status: "import_cancelled",
      cancelled: true
    }));
    return {
      ok: true,
      sessionId: id,
      status: result?.status || "import_cancelled",
      cancelled: true
    };
  }

  async function awaitImport(sessionId) {
    const job = jobs.get(String(sessionId || ""));
    if (!job) return null;
    return job.promise;
  }

  async function abortAll() {
    const pending = [];
    for (const [id, job] of jobs) {
      try {
        job.controller.abort();
      } catch {
        /* ignore */
      }
      pending.push(job.promise.catch(() => ({ sessionId: id, status: "import_cancelled" })));
    }
    if (pending.length) {
      await Promise.allSettled(pending);
    }
    jobs.clear();
  }

  async function shutdown(timeoutMs = 3000) {
    const wait = Promise.resolve().then(() => abortAll());
    await Promise.race([
      wait,
      new Promise((r) => setTimeout(r, Math.max(100, Number(timeoutMs) || 3000)))
    ]);
  }

  return {
    startImport,
    getImportStatus,
    cancelImport,
    awaitImport,
    abortAll,
    shutdown,
    _jobs: jobs
  };
}

/**
 * Fixed relative paths for list flags — existence only, no body read.
 * Must include Stage 2A canonical: transcription/qwen-no-bucket/raw-transcript.json
 */
async function probeSessionArtifacts(sessionDir, fsp) {
  const fs = fsp || require("node:fs/promises");
  async function exists(rel) {
    const p = path.join(sessionDir, ...String(rel).split(/[/\\]+/).filter(Boolean));
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }
  const hasRaw =
    (await exists("transcription/qwen-no-bucket/raw-transcript.json")) ||
    (await exists("transcription/raw-transcript.json")) ||
    (await exists("transcription/transcript.json")) ||
    (await exists("raw-transcript.json"));
  const hasSummary =
    (await exists("analysis/summary.json")) ||
    (await exists("analysis/final-summary.json"));
  const micArchive = await exists("archive/microphone.mono.wav");
  const sysArchive = await exists("archive/system.mono.wav");
  const archiveTracks = [];
  if (micArchive) archiveTracks.push("microphone");
  if (sysArchive) archiveTracks.push("system");
  return {
    hasRaw,
    hasSummary,
    hasArchive: archiveTracks.length > 0,
    archiveTracks
  };
}

module.exports = {
  createImportJobManager,
  probeSessionArtifacts,
  sanitizeImportErrorMessage
};
