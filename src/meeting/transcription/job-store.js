"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { QWEN_NO_BUCKET, JOB_STATUS, SEGMENT_STATUS } = require("./constants");
const {
  sha256Text,
  sanitizeForPersist,
  pickSafeProfile,
  sanitizeErrorMessage,
  sanitizeTranscriptForPersist,
  sanitizeResultMeta,
  sanitizeIdentifier
} = require("./sanitize");

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function writeJsonAtomic(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString("hex")}.part`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(tmp, filePath);
}

function nowIso() {
  return new Date().toISOString();
}

function createJobStore({ sessionDir, workDirName = QWEN_NO_BUCKET.workDirName } = {}) {
  if (!sessionDir) {
    const error = new Error("sessionDir required");
    error.code = "invalid_argument";
    throw error;
  }
  const root = path.join(sessionDir, workDirName);
  const jobPath = path.join(root, "job.json");
  const segmentsDir = path.join(root, "segments");
  const resultsDir = path.join(root, "results");
  const transcriptPath = path.join(root, "raw-transcript.json");

  async function init() {
    await ensureDir(segmentsDir);
    await ensureDir(resultsDir);
    return root;
  }

  /**
   * Pure load. ENOENT => null. Malformed JSON => job_corrupt (file preserved).
   */
  async function loadJob() {
    let raw;
    try {
      raw = await fsp.readFile(jobPath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") return null;
      throw error;
    }
    try {
      return JSON.parse(raw);
    } catch (error) {
      const err = new Error(`job.json corrupt: ${error.message}`);
      err.code = "job_corrupt";
      err.jobPath = jobPath;
      throw err;
    }
  }

  async function saveJob(job) {
    // Mutate in place so callers retain segment object identity across saves.
    job.updatedAt = nowIso();
    delete job.credentials;
    delete job.apiKey;
    delete job.authorization;
    if (job.profile) job.profile = pickSafeProfile(job.profile);
    if (job.lastError?.message) {
      job.lastError = {
        ...job.lastError,
        message: sanitizeErrorMessage(job.lastError.message)
      };
    }
    // Persist a sanitized deep snapshot; return the same working object.
    const snapshot = sanitizeForPersist(job);
    await writeJsonAtomic(jobPath, snapshot);
    return job;
  }

  async function createJob({
    sessionId,
    provider = QWEN_NO_BUCKET.provider,
    modelId = null,
    sourceArtifacts = {},
    profile = {},
    generation = 1
  } = {}) {
    await init();
    const job = {
      schema: QWEN_NO_BUCKET.schema,
      version: 1,
      generation,
      sessionId: sessionId || null,
      status: JOB_STATUS.PREPARING,
      provider,
      modelId: modelId || null,
      profile: pickSafeProfile({
        provider,
        mode: QWEN_NO_BUCKET.mode,
        targetSegmentSeconds: QWEN_NO_BUCKET.targetSegmentSeconds,
        modelId,
        ...profile
      }),
      sourceArtifacts: sanitizeForPersist(sourceArtifacts),
      tracks: {
        microphone: { segments: [], status: SEGMENT_STATUS.PENDING },
        system: { segments: [], status: SEGMENT_STATUS.PENDING }
      },
      attempts: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastError: null,
      diarization: false,
      limitations: [
        "no_bucket",
        "no_remote_diarization",
        "segment_level_timestamps_only",
        "qwen3_asr_flash_base64_limits",
        "in_process_single_flight_only"
      ]
    };
    return saveJob(job);
  }

  /**
   * Disk recovery when no in-process run is active.
   * running segments → pending; job running → ready.
   * Does not touch cancelled/failed exhausted semantics.
   */
  async function recoverJob() {
    const job = await loadJob();
    if (!job) return null;
    let dirty = false;
    if (job.status === JOB_STATUS.RUNNING) {
      job.status = JOB_STATUS.READY;
      dirty = true;
    }
    for (const track of ["microphone", "system"]) {
      const t = job.tracks?.[track];
      if (!t?.segments) continue;
      for (const seg of t.segments) {
        if (seg.status === SEGMENT_STATUS.RUNNING) {
          seg.status = SEGMENT_STATUS.PENDING;
          seg.recoveredFromRunning = true;
          dirty = true;
        }
      }
    }
    if (dirty) return saveJob(job);
    return job;
  }

  async function writeSegmentResult({
    track,
    seq,
    text,
    segmentContentSha256,
    generation = 1,
    rawMeta = {}
  }) {
    await init();
    // Transcript text is authoritative — never sanitize/truncate content.
    const exactText = String(text ?? "");
    const meta = sanitizeResultMeta(rawMeta);
    const name = `${track}_seg_${String(seq).padStart(4, "0")}.json`;
    const filePath = path.join(resultsDir, name);
    const body = {
      schema: "meeting_qwen_segment_result_v1",
      track: sanitizeIdentifier(track, null),
      seq,
      generation,
      text: exactText,
      textSha256: sha256Text(exactText),
      segmentContentSha256: segmentContentSha256 || null,
      provider: meta.provider || QWEN_NO_BUCKET.provider,
      model: meta.model,
      completedAt: nowIso()
    };
    await writeJsonAtomic(filePath, body);
    return { path: filePath, ...body };
  }

  /**
   * Validated reader. Returns { ok, result?, code? }.
   * When expectedGeneration is supplied, result.generation must be present and equal.
   */
  async function readValidatedSegmentResult(track, seq, expectedSegmentSha, expectedGeneration = null) {
    const name = `${track}_seg_${String(seq).padStart(4, "0")}.json`;
    const filePath = path.join(resultsDir, name);
    let raw;
    try {
      raw = await fsp.readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { ok: false, code: "result_missing" };
      }
      return { ok: false, code: "result_unreadable" };
    }
    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      return { ok: false, code: "result_corrupt" };
    }
    if (typeof result.text !== "string") {
      return { ok: false, code: "result_corrupt" };
    }
    const expectedSha = String(expectedSegmentSha || "").toLowerCase();
    const actualSegSha = String(result.segmentContentSha256 || "").toLowerCase();
    if (expectedSha) {
      if (!actualSegSha) {
        return { ok: false, code: "result_segment_hash_missing", result };
      }
      if (actualSegSha !== expectedSha) {
        return { ok: false, code: "result_segment_hash_mismatch", result };
      }
    }
    const expectedTextHash = sha256Text(result.text);
    if (!result.textSha256 || String(result.textSha256).toLowerCase() !== expectedTextHash) {
      return { ok: false, code: "result_text_hash_mismatch", result };
    }
    if (expectedGeneration != null) {
      if (result.generation == null || result.generation === "") {
        return { ok: false, code: "result_generation_missing", result };
      }
      if (Number(result.generation) !== Number(expectedGeneration)) {
        return { ok: false, code: "result_generation_mismatch", result };
      }
    }
    return { ok: true, result };
  }

  async function readSegmentResult(track, seq) {
    const name = `${track}_seg_${String(seq).padStart(4, "0")}.json`;
    try {
      return JSON.parse(await fsp.readFile(path.join(resultsDir, name), "utf8"));
    } catch {
      return null;
    }
  }

  async function writeTranscript(transcript) {
    await init();
    // Schema-specific: preserve item.text fully; sanitize metadata only.
    const safe = sanitizeTranscriptForPersist(transcript);
    await writeJsonAtomic(transcriptPath, safe);
    return transcriptPath;
  }

  async function readTranscript() {
    try {
      return JSON.parse(await fsp.readFile(transcriptPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      const err = new Error(`transcript corrupt: ${error.message}`);
      err.code = "transcript_corrupt";
      throw err;
    }
  }

  return {
    root,
    jobPath,
    segmentsDir,
    resultsDir,
    transcriptPath,
    init,
    loadJob,
    saveJob,
    createJob,
    recoverJob,
    writeSegmentResult,
    readValidatedSegmentResult,
    readSegmentResult,
    writeTranscript,
    readTranscript
  };
}

module.exports = {
  createJobStore,
  writeJsonAtomic,
  JOB_STATUS,
  SEGMENT_STATUS
};
