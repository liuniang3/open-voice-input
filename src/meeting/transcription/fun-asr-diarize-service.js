"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const { assertPathInsideRoot } = require("../paths");
const { sha256File } = require("../archive/export-track-wav");
const { mergeMeetingTimeline, SELF_SPEAKER_ID } = require("../timeline/merge-timeline");
const { QWEN_NO_BUCKET } = require("./constants");
const { encodeArchiveWavToUploadMp3, normalizeBitrateKbps } = require("./encode-upload-mp3");
const { requirePublicUrlPublisher } = require("../publish/meeting-audio-publisher");

const FUN_JOB_SCHEMA = "meeting_fun_asr_diarize_job_v1";
const FUN_WORK_DIR = "transcription/fun-asr-diarize";
const PHASES = Object.freeze({
  idle: "idle",
  preparing_audio: "preparing_audio",
  uploading: "uploading",
  submitted: "submitted",
  polling: "polling",
  merging: "merging",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled"
});

function nowIso() {
  return new Date().toISOString();
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error("aborted");
    error.code = "aborted";
    throw error;
  }
}

const FUN_JOB_ALLOWLIST = Object.freeze([
  "schema",
  "sessionId",
  "generation",
  "phase",
  "fingerprint",
  "bitrateKbps",
  "funModelId",
  "inputSha",
  "funTaskId",
  "objectKey",
  "bucket",
  "region",
  "remoteCleanup",
  "lastError",
  "createdAt",
  "updatedAt"
]);

function scrubPersistedErrorMessage(message) {
  let out = String(message || "");
  out = out.replace(
    /\b(Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|tp-[A-Za-z0-9_-]{8,}|LTAI[A-Za-z0-9]{12,})/gi,
    "[redacted]"
  );
  out = out.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname || ""}`;
    } catch {
      return "[redacted-url]";
    }
  });
  if (out.length > 300) out = `${out.slice(0, 300)}…`;
  return out;
}

function sanitizeFunJobForDisk(job) {
  const src = job && typeof job === "object" ? job : {};
  const out = {};
  for (const key of FUN_JOB_ALLOWLIST) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
    if (key === "lastError" && src.lastError && typeof src.lastError === "object") {
      out.lastError = {
        code: src.lastError.code == null ? null : String(src.lastError.code).slice(0, 120),
        message: scrubPersistedErrorMessage(src.lastError.message || "")
      };
      continue;
    }
    const v = src[key];
    if (v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[key] = v;
    } else {
      out[key] = String(v).slice(0, 500);
    }
  }
  // Never persist secrets / URLs even if caller stuffed them under allowlisted names incorrectly
  delete out.url;
  delete out.signedUrl;
  delete out.apiKey;
  delete out.accessKeyId;
  delete out.accessKeySecret;
  delete out.authorization;
  return out;
}

async function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const part = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(part, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fsp.rename(part, filePath);
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function enhancedFingerprint({
  micSha = null,
  sysSha = null,
  qwenModelId = null,
  funModelId = null,
  bitrateKbps = 48,
  mode = "enhanced"
} = {}) {
  return JSON.stringify({
    mode: mode || "enhanced",
    mic: micSha || null,
    sys: sysSha || null,
    qwenModelId: qwenModelId || null,
    funModelId: funModelId || null,
    bitrateKbps: normalizeBitrateKbps(bitrateKbps)
  });
}

function qwenItemsToMicSentences(items) {
  const list = Array.isArray(items) ? items : [];
  return list
    .filter((it) => it && (it.track === "microphone" || !it.track))
    .map((it, i) => ({
      text: it.text,
      beginMs: it.artifactBeginMs ?? it.beginMs ?? it.providerBeginMs ?? null,
      endMs: it.artifactEndMs ?? it.endMs ?? it.providerEndMs ?? null,
      speakerId: SELF_SPEAKER_ID,
      confidence: null,
      channelId: null,
      _sourceIndex: i
    }));
}

function buildEnhancedRawTranscript({
  sessionId,
  generation,
  merged,
  qwenModelId,
  funModelId,
  bitrateKbps,
  fingerprint
}) {
  const items = (merged?.items || []).map((it, idx) => ({
    id: it.id || `${it.track}:${idx}`,
    track: it.track,
    role: it.role,
    speakerId: it.speakerId,
    speakerLabel: it.speakerLabel,
    text: typeof it.text === "string" ? it.text : String(it.text ?? ""),
    providerBeginMs: it.providerBeginMs ?? null,
    providerEndMs: it.providerEndMs ?? null,
    artifactBeginMs: it.artifactBeginMs ?? it.beginMs ?? null,
    artifactEndMs: it.artifactEndMs ?? it.endMs ?? null,
    sessionBeginMs: it.sessionBeginMs ?? null,
    sessionEndMs: it.sessionEndMs ?? null,
    beginMs: it.beginMs ?? it.artifactBeginMs ?? null,
    endMs: it.endMs ?? it.artifactEndMs ?? null,
    timestampPrecision: it.track === "system" ? "sentence" : "segment",
    sourceIndex: it.sourceIndex ?? idx,
    confidence: it.confidence ?? null,
    channelId: it.channelId ?? null
  }));

  return {
    schema: QWEN_NO_BUCKET.transcriptSchema,
    sessionId,
    generation: generation || 1,
    provider: "mixed",
    modelId: {
      microphone: qwenModelId || null,
      system: funModelId || null
    },
    mode: "enhanced_diarize",
    diarization: true,
    timestampPrecision: "mixed",
    speakers: {
      microphone: SELF_SPEAKER_ID,
      system: "fun_asr_diarization"
    },
    policy: {
      remoteDiarization: true,
      providerTimestamps: true,
      systemUploadBitrateKbps: normalizeBitrateKbps(bitrateKbps),
      fingerprint,
      note:
        "Enhanced mode: microphone via Qwen no-bucket (self); system mix via Fun-ASR diarization. " +
        "Raw transcript is authoritative and immutable after atomic commit."
    },
    count: items.length,
    items
  };
}

function createFunAsrDiarizeService({
  sessionDir,
  sessionId,
  funAsrProvider,
  publisher,
  encodeMp3 = encodeArchiveWavToUploadMp3,
  logger = () => {},
  ffmpegOptions = null
} = {}) {
  if (!sessionDir) {
    const error = new Error("sessionDir required");
    error.code = "invalid_argument";
    throw error;
  }
  const workDir = path.join(sessionDir, FUN_WORK_DIR);
  const jobPath = path.join(workDir, "job.json");

  function log(event, detail = {}) {
    const safe = { ...(detail || {}) };
    delete safe.url;
    delete safe.apiKey;
    delete safe.accessKeySecret;
    delete safe.accessKeyId;
    delete safe.authorization;
    logger({ event, sessionId, ...safe });
  }

  async function loadJob() {
    return readJsonIfExists(jobPath);
  }

  async function saveJob(job) {
    const safe = sanitizeFunJobForDisk(job);
    await writeJsonAtomic(jobPath, safe);
    return safe;
  }

  async function bestEffortDeleteRemote(objectKey) {
    if (!objectKey || !publisher || typeof publisher.deleteObject !== "function") {
      return { ok: false, code: "object_key_missing" };
    }
    try {
      return await publisher.deleteObject({ objectKey, sessionId, track: "system" });
    } catch {
      return { ok: false, code: "oss_delete_failed" };
    }
  }

  /**
   * System-track Fun-ASR diarization: encode MP3 → publish → structured diarize.
   * Does not write authoritative raw transcript.
   *
   * Retry semantics (same fingerprint):
   * - forceResubmit / phase=failed → clear failed taskId, re-encode/upload/submit
   * - cancelled|polling|merging|submitted + taskId → resume poll (no resubmit)
   * - raw write left phase=merging → resume successful task
   */
  async function runSystemDiarization({
    systemWavPath,
    systemContentSha256 = null,
    expectedDurationMs = null,
    bitrateKbps = 48,
    generation = 1,
    fingerprint = null,
    funModelId = null,
    signal = null,
    forceResubmit = false
  } = {}) {
    throwIfAborted(signal);
    await fsp.mkdir(workDir, { recursive: true });
    assertPathInsideRoot(sessionDir, workDir);
    assertPathInsideRoot(sessionDir, systemWavPath);

    const pub = requirePublicUrlPublisher(publisher);
    const inputSha =
      systemContentSha256 || (await sha256File(systemWavPath).catch(() => null));
    const fp =
      fingerprint ||
      enhancedFingerprint({
        sysSha: inputSha,
        funModelId,
        bitrateKbps,
        mode: "enhanced"
      });

    let job = (await loadJob()) || {
      schema: FUN_JOB_SCHEMA,
      sessionId,
      generation: generation || 1,
      phase: PHASES.idle,
      fingerprint: fp,
      bitrateKbps: normalizeBitrateKbps(bitrateKbps),
      funModelId: funModelId || null,
      inputSha,
      funTaskId: null,
      objectKey: null,
      bucket: null,
      region: null,
      remoteCleanup: "none",
      lastError: null,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };

    const sameFp = job.fingerprint === fp && job.inputSha === inputSha;
    const phase = job.phase || PHASES.idle;

    // Failed task is not trusted: always clear and resubmit on retry entry.
    const mustResubmit =
      forceResubmit ||
      !sameFp ||
      phase === PHASES.failed ||
      (phase === PHASES.cancelled && !job.funTaskId) ||
      (sameFp &&
        !job.funTaskId &&
        (phase === PHASES.idle ||
          phase === PHASES.preparing_audio ||
          phase === PHASES.uploading));

    const canResumeTask =
      sameFp &&
      !mustResubmit &&
      Boolean(job.funTaskId) &&
      (phase === PHASES.cancelled ||
        phase === PHASES.polling ||
        phase === PHASES.merging ||
        phase === PHASES.submitted ||
        phase === PHASES.completed);

    if (!sameFp || mustResubmit) {
      const oldKey = job.objectKey;
      if (mustResubmit && oldKey) {
        await bestEffortDeleteRemote(oldKey);
      }
      job = {
        schema: FUN_JOB_SCHEMA,
        sessionId,
        generation: !sameFp ? (job.generation || 1) + 1 : generation || job.generation || 1,
        phase: PHASES.idle,
        fingerprint: fp,
        bitrateKbps: normalizeBitrateKbps(bitrateKbps),
        funModelId: funModelId || null,
        inputSha,
        funTaskId: null,
        objectKey: null,
        bucket: null,
        region: null,
        remoteCleanup: "none",
        lastError: null,
        createdAt: job.createdAt || nowIso(),
        updatedAt: nowIso()
      };
      await saveJob(job);
    }

    try {
      let publishedUrl = null;

      if (canResumeTask) {
        job.phase = PHASES.polling;
        job.updatedAt = nowIso();
        job.remoteCleanup =
          job.objectKey && job.remoteCleanup !== "deleted"
            ? "pending_retained"
            : job.remoteCleanup || "none";
        await saveJob(job);
        throwIfAborted(signal);

        const structured = await funAsrProvider.transcribeMeetingStructured({
          existingTaskId: job.funTaskId,
          diarizationEnabled: true,
          mono: true,
          channels: 1,
          signal
        });

        job.funTaskId = structured.taskId || job.funTaskId;
        job.phase = PHASES.merging;
        job.updatedAt = nowIso();
        job.lastError = null;
        await saveJob(job);

        return {
          sentences: structured.sentences || [],
          text: structured.text || "",
          taskId: structured.taskId || job.funTaskId,
          job,
          objectKey: job.objectKey,
          resumedTask: true,
          _publisher: pub
        };
      }

      job.phase = PHASES.preparing_audio;
      job.updatedAt = nowIso();
      await saveJob(job);
      throwIfAborted(signal);

      const encoded = await encodeMp3({
        inputWavPath: systemWavPath,
        outputDir: workDir,
        sessionDir,
        bitrateKbps: job.bitrateKbps,
        expectedDurationMs,
        signal,
        ...(typeof ffmpegOptions === "function" ? ffmpegOptions() : ffmpegOptions || {})
      });

      job.phase = PHASES.uploading;
      job.updatedAt = nowIso();
      await saveJob(job);
      throwIfAborted(signal);

      const published = await pub.publish({
        localPath: encoded.mp3Path,
        contentType: "audio/mpeg",
        track: "system",
        sessionId,
        purpose: "fun_asr_diarize",
        contentSha256: inputSha,
        generation: job.generation,
        signal
      });
      publishedUrl = published.url || null;
      job.objectKey = published.objectKey || null;
      job.bucket = published.bucket || null;
      job.region = published.region || null;
      job.remoteCleanup = "pending";
      job.phase = PHASES.submitted;
      job.updatedAt = nowIso();
      await saveJob(job);
      throwIfAborted(signal);

      job.phase = PHASES.polling;
      job.updatedAt = nowIso();
      await saveJob(job);

      const structured = await funAsrProvider.transcribeMeetingStructured({
        audioUrl: publishedUrl,
        diarizationEnabled: true,
        mono: true,
        channels: 1,
        signal,
        onTaskId: async (taskId) => {
          job.funTaskId = taskId;
          job.phase = PHASES.polling;
          job.updatedAt = nowIso();
          await saveJob(job);
        }
      });

      job.funTaskId = structured.taskId || job.funTaskId;
      job.phase = PHASES.merging;
      job.updatedAt = nowIso();
      job.lastError = null;
      await saveJob(job);

      return {
        sentences: structured.sentences || [],
        text: structured.text || "",
        taskId: structured.taskId || job.funTaskId,
        job,
        objectKey: job.objectKey,
        resumedTask: false,
        _publisher: pub
      };
    } catch (error) {
      if (error?.code === "aborted") {
        job.phase = PHASES.cancelled;
        job.lastError = { code: "aborted", message: "cancelled" };
        if (job.objectKey) job.remoteCleanup = "pending_retained";
        job.updatedAt = nowIso();
        await saveJob(job).catch(() => {});
        throw error;
      }
      job.phase = PHASES.failed;
      job.lastError = {
        code: error?.code || "fun_asr_failed",
        message: String(error?.message || error).slice(0, 300)
      };
      if (job.objectKey) job.remoteCleanup = "pending_retained";
      job.updatedAt = nowIso();
      await saveJob(job).catch(() => {});
      throw error;
    }
  }

  async function markRemoteCleaned(ok, { retained = false } = {}) {
    const job = await loadJob();
    if (!job) return;
    if (retained && !ok) job.remoteCleanup = "pending_retained";
    else job.remoteCleanup = ok ? "deleted" : "delete_failed";
    job.updatedAt = nowIso();
    await saveJob(job);
  }

  async function completeJob() {
    const job = await loadJob();
    if (!job) return null;
    job.phase = PHASES.completed;
    job.updatedAt = nowIso();
    job.lastError = null;
    return saveJob(job);
  }

  return {
    workDir,
    jobPath,
    loadJob,
    saveJob,
    runSystemDiarization,
    markRemoteCleaned,
    completeJob,
    bestEffortDeleteRemote,
    PHASES,
    FUN_WORK_DIR
  };
}

async function atomicWriteAuthoritativeRawTranscript(sessionDir, transcript) {
  const dir = path.join(sessionDir, QWEN_NO_BUCKET.workDirName);
  await fsp.mkdir(dir, { recursive: true });
  assertPathInsideRoot(sessionDir, dir);
  const target = path.join(dir, "raw-transcript.json");
  assertPathInsideRoot(sessionDir, target);
  const part = `${target}.${process.pid}.${Date.now()}.tmp`;
  assertPathInsideRoot(sessionDir, part);
  await fsp.writeFile(part, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
  await fsp.rename(part, target);
  return target;
}

module.exports = {
  FUN_JOB_SCHEMA,
  FUN_WORK_DIR,
  PHASES,
  FUN_JOB_ALLOWLIST,
  enhancedFingerprint,
  qwenItemsToMicSentences,
  buildEnhancedRawTranscript,
  createFunAsrDiarizeService,
  atomicWriteAuthoritativeRawTranscript,
  mergeMeetingTimeline,
  writeJsonAtomic,
  sanitizeFunJobForDisk,
  scrubPersistedErrorMessage,
  SELF_SPEAKER_ID
};
