"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  ANALYSIS_ROOT,
  RAW_TRANSCRIPT_REL,
  PROMPT_REVISION,
  SCHEMA_REVISION,
  JOB_STATUS,
  STAGE
} = require("./constants");
const { sanitizeErrorMessage } = require("../transcription/sanitize");

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

async function readJson(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    const err = new Error(`json corrupt: ${error.message}`);
    err.code = "analysis_artifact_corrupt";
    err.path = filePath;
    throw err;
  }
}

function sha256Buffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function sha256Text(text) {
  return sha256Buffer(Buffer.from(String(text ?? ""), "utf8"));
}

function nowIso() {
  return new Date().toISOString();
}

function canonicalFingerprint(obj) {
  return sha256Text(JSON.stringify(obj));
}

function createAnalysisJobStore({ sessionDir } = {}) {
  if (!sessionDir) {
    const error = new Error("sessionDir required");
    error.code = "invalid_argument";
    throw error;
  }
  const root = path.join(sessionDir, ANALYSIS_ROOT);
  const jobPath = path.join(root, "job.json");
  const rawPath = path.join(sessionDir, RAW_TRANSCRIPT_REL);

  async function init() {
    await ensureDir(root);
    return root;
  }

  async function readRawBytes() {
    try {
      return await fsp.readFile(rawPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        const err = new Error("raw-transcript.json missing; run Stage 2 transcription first");
        err.code = "analysis_raw_missing";
        throw err;
      }
      throw error;
    }
  }

  async function loadRawTranscript() {
    const bytes = await readRawBytes();
    const sha = sha256Buffer(bytes);
    let doc;
    try {
      doc = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      const err = new Error("raw-transcript.json corrupt");
      err.code = "analysis_raw_corrupt";
      throw err;
    }
    return { doc, bytes, sha, path: rawPath };
  }

  async function assertRawUnchanged(expectedSha) {
    const bytes = await readRawBytes();
    const sha = sha256Buffer(bytes);
    if (expectedSha && sha !== expectedSha) {
      const error = new Error("raw-transcript.json changed during analysis");
      error.code = "analysis_raw_changed";
      throw error;
    }
    return sha;
  }

  async function loadJob() {
    try {
      const raw = await fsp.readFile(jobPath, "utf8");
      try {
        return JSON.parse(raw);
      } catch {
        const err = new Error("analysis job.json corrupt");
        err.code = "job_corrupt";
        throw err;
      }
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function saveJob(job) {
    job.updatedAt = nowIso();
    delete job.apiKey;
    delete job.credentials;
    if (job.lastError?.message) {
      job.lastError = {
        code: job.lastError.code,
        message: sanitizeErrorMessage(job.lastError.message)
      };
    }
    // Persist without secret keys; keep structural fields
    const snapshot = {
      schema: job.schema,
      version: job.version,
      generation: job.generation,
      activeGenerationDir: job.activeGenerationDir,
      sessionId: job.sessionId,
      status: job.status,
      stage: job.stage,
      template: job.template,
      templateSource: job.templateSource,
      templateRequested: job.templateRequested || job.templateSource || "auto",
      modelId: job.modelId,
      profile: job.profile
        ? {
            provider: "openai-compatible",
            modelId: job.modelId || job.profile.modelId || null,
            contextWindowTokens: job.profile.contextWindowTokens,
            maxOutputTokens: job.profile.maxOutputTokens,
            budgetRatio: job.profile.budgetRatio,
            reasoningEffort: job.profile.reasoningEffort || null
          }
        : null,
      source: job.source,
      fingerprintSha256: job.fingerprintSha256,
      promptRevision: job.promptRevision,
      schemaRevision: job.schemaRevision,
      batches: job.batches,
      attempts: job.attempts,
      lastError: job.lastError,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    };
    await writeJsonAtomic(jobPath, snapshot);
    return job;
  }

  function generationDir(generation) {
    return path.join(root, `g${Number(generation) || 1}`);
  }

  function relativeGenerationDir(generation) {
    return path.join(ANALYSIS_ROOT, `g${Number(generation) || 1}`).replace(/\\/g, "/");
  }

  function assertSafeRelName(relName) {
    const name = String(relName || "");
    if (!name || name !== name.trim()) {
      const error = new Error("empty or unsafe artifact name");
      error.code = "analysis_path_denied";
      throw error;
    }
    if (path.isAbsolute(name) || /^[A-Za-z]:[\\/]/.test(name)) {
      const error = new Error("absolute artifact path denied");
      error.code = "analysis_path_denied";
      throw error;
    }
    const norm = name.replace(/\\/g, "/");
    if (norm.split("/").some((p) => p === ".." || p === "")) {
      const error = new Error("path traversal denied");
      error.code = "analysis_path_denied";
      throw error;
    }
    if (norm.startsWith("/") || norm.includes("\0")) {
      const error = new Error("unsafe artifact name");
      error.code = "analysis_path_denied";
      throw error;
    }
    return norm.endsWith(".json") ? norm : `${norm}.json`;
  }

  function resolveUnderGeneration(generation, relName) {
    const safe = assertSafeRelName(relName);
    const base = path.resolve(generationDir(generation));
    const resolved = path.resolve(base, safe);
    const prefix = base.endsWith(path.sep) ? base : base + path.sep;
    if (resolved !== base && !resolved.startsWith(prefix)) {
      const error = new Error("artifact path escapes generation dir");
      error.code = "analysis_path_denied";
      throw error;
    }
    return resolved;
  }

  async function ensureGenerationDir(generation) {
    const dir = generationDir(generation);
    await ensureDir(path.join(dir, "batches"));
    await ensureDir(path.join(dir, "state"));
    await ensureDir(path.join(dir, "merge"));
    return dir;
  }

  async function writeStageArtifact(generation, relName, value) {
    await ensureGenerationDir(generation);
    const filePath = resolveUnderGeneration(generation, relName);
    const { outputSha256: _drop, ...rest } =
      value && typeof value === "object" ? value : { value };
    const contentSha = sha256Text(JSON.stringify(rest));
    const finalDoc = { ...rest, outputSha256: contentSha };
    await writeJsonAtomic(filePath, finalDoc);
    return { path: filePath, outputSha256: contentSha, doc: finalDoc };
  }

  /**
   * Read and validate artifact integrity. Returns null if missing.
   * Corrupted hash / JSON → null (not reusable) unless throwOnCorrupt.
   */
  async function readStageArtifact(generation, relName, { throwOnCorrupt = false } = {}) {
    let filePath;
    try {
      filePath = resolveUnderGeneration(generation, relName);
    } catch (error) {
      if (error.code === "analysis_path_denied") throw error;
      return null;
    }
    let doc;
    try {
      const raw = await fsp.readFile(filePath, "utf8");
      doc = JSON.parse(raw);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (throwOnCorrupt) {
        const err = new Error("stage artifact corrupt");
        err.code = "analysis_artifact_corrupt";
        throw err;
      }
      return null;
    }
    if (!doc || typeof doc !== "object") return null;
    const { outputSha256, ...rest } = doc;
    const recomputed = sha256Text(JSON.stringify(rest));
    if (!outputSha256 || outputSha256 !== recomputed) {
      if (throwOnCorrupt) {
        const err = new Error("stage artifact hash mismatch");
        err.code = "analysis_artifact_hash_mismatch";
        throw err;
      }
      return null;
    }
    return doc;
  }

  async function writeFinal(generation, name, doc) {
    const dir = await ensureGenerationDir(generation);
    const filePath = path.join(dir, name);
    await writeJsonAtomic(filePath, doc);
    // also copy to analysis/ root stable names for IPC convenience
    const stable = path.join(root, name);
    await writeJsonAtomic(stable, doc);
    return filePath;
  }

  async function readFinal(name) {
    const job = await loadJob();
    const generation = Number(job?.generation) || 0;
    if (generation) {
      const active = await readJson(path.join(generationDir(generation), name));
      if (active) return active;

      // A new forced generation may be running while stable root files still
      // belong to the previous generation. Never expose those stale results.
      const stable = await readJson(path.join(root, name));
      if (stable && Number(stable.generation) === generation) return stable;
      return null;
    }
    return readJson(path.join(root, name));
  }

  return {
    root,
    jobPath,
    rawPath,
    init,
    loadRawTranscript,
    assertRawUnchanged,
    loadJob,
    saveJob,
    generationDir,
    relativeGenerationDir,
    ensureGenerationDir,
    assertSafeRelName,
    resolveUnderGeneration,
    writeStageArtifact,
    readStageArtifact,
    writeFinal,
    readFinal,
    sha256Text,
    sha256Buffer,
    canonicalFingerprint,
    writeJsonAtomic
  };
}

module.exports = {
  createAnalysisJobStore,
  sha256Text,
  sha256Buffer,
  canonicalFingerprint,
  writeJsonAtomic
};
