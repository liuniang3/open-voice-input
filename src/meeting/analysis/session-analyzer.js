"use strict";

const path = require("node:path");
const { getSessionDir, assertPathInsideRoot } = require("../paths");
const { createAnalysisJobStore } = require("./job-store");
const { createAnalysisPipeline } = require("./pipeline");
const { resolveMeetingAnalysisCredentials } = require("./credentials");
const { JOB_STATUS, STAGE, TEMPLATES } = require("./constants");
const { sanitizeErrorMessage } = require("../transcription/sanitize");
const { scrubString } = require("../processing/sanitize-ipc");
const { validateSummaryEvidence } = require("./evidence");

const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const CANCEL_WAIT_MS = 8000;
const SHUTDOWN_WAIT_MS = 4000;

function assertValidSessionId(sessionId) {
  const id = String(sessionId || "");
  if (!id || !SESSION_ID_RE.test(id)) {
    const error = new Error("invalid sessionId");
    error.code = "invalid_session_id";
    throw error;
  }
  if (id.replace(/[^a-zA-Z0-9._-]/g, "_") !== id) {
    const error = new Error("invalid sessionId");
    error.code = "invalid_session_id";
    throw error;
  }
  return id;
}

function toAnalysisStatusDto(job, handle) {
  if (!job) {
    return {
      status: "none",
      stage: STAGE.IDLE,
      generation: null,
      template: null,
      batches: { total: 0, completed: 0 },
      lastError: null
    };
  }
  let status = job.status || "none";
  let stage = job.stage || STAGE.IDLE;
  if (handle?.cancelling) {
    stage = "cancelling";
    status = "cancelling";
  } else if (handle?.runActive && status === JOB_STATUS.RUNNING) {
    status = JOB_STATUS.RUNNING;
  }
  return {
    status,
    stage,
    generation: job.generation ?? null,
    template: job.template || null,
    templateSource: job.templateSource || null,
    modelId: job.modelId || null,
    batches: {
      total: Number(job.batches?.total) || 0,
      completed: Number(job.batches?.completed) || 0
    },
    fingerprintSha256: job.fingerprintSha256 || null,
    lastError: job.lastError
      ? {
          code: job.lastError.code || "error",
          message: scrubString(sanitizeErrorMessage(job.lastError.message || ""))
        }
      : null
  };
}

function createMeetingSessionAnalyzer({
  userDataPath,
  getCaptureService,
  resolveCredentials = null,
  createChatClient = null,
  requestChat = null,
  logger = () => {},
  cancelWaitMs = CANCEL_WAIT_MS,
  shutdownWaitMs = SHUTDOWN_WAIT_MS
} = {}) {
  if (!userDataPath) throw new Error("userDataPath required");
  if (typeof getCaptureService !== "function") throw new Error("getCaptureService required");

  /** @type {Map<string, any>} */
  const handles = new Map();

  function log(event, detail = {}) {
    const safe = { ...detail };
    delete safe.apiKey;
    delete safe.text;
    delete safe.content;
    logger({ event, ...safe });
  }

  function peekHandle(id) {
    return handles.get(id) || null;
  }

  function getOrCreateHandle(id) {
    if (!handles.has(id)) {
      handles.set(id, {
        runActive: false,
        cancelling: false,
        controller: null,
        settlePromise: null
      });
    }
    return handles.get(id);
  }

  function sessionsRoot() {
    return getCaptureService().store.sessionsRoot;
  }

  function sessionDirOf(sessionId) {
    const id = assertValidSessionId(sessionId);
    const root = sessionsRoot();
    return assertPathInsideRoot(root, getSessionDir(root, id));
  }

  function buildRequestChat(creds) {
    if (typeof requestChat === "function") {
      return (messages, opts) => requestChat(messages, opts);
    }
    if (typeof createChatClient === "function") {
      const client = createChatClient(creds);
      return (messages, opts) => client.requestChat(messages, opts);
    }
    const { createOpenAiCompatibleClient } = require("../../providers/openai-compatible-client");
    const client = createOpenAiCompatibleClient({
      apiKey: creds.apiKey,
      baseUrl: creds.baseUrl,
      model: creds.modelId,
      requestTimeoutMs: creds.timeoutMs
    });
    return (messages, opts) => client.requestChat(messages, opts);
  }

  async function getAnalysisStatus(sessionId) {
    const id = assertValidSessionId(sessionId);
    const sessionDir = sessionDirOf(id);
    const store = createAnalysisJobStore({ sessionDir });
    const job = await store.loadJob();
    return toAnalysisStatusDto(job, peekHandle(id));
  }

  async function startAnalysis(
    sessionId,
    { template = TEMPLATES.AUTO, force = false } = {}
  ) {
    const id = assertValidSessionId(sessionId);
    const handle = getOrCreateHandle(id);
    if (handle.runActive || handle.cancelling) {
      const error = new Error(
        handle.cancelling ? "analysis is cancelling" : "analysis already running"
      );
      error.code = handle.cancelling ? "analysis_cancelling" : "analysis_already_running";
      throw error;
    }

    handle.runActive = true;
    handle.cancelling = false;
    handle.controller = new AbortController();
    const signal = handle.controller.signal;
    let settleResolve;
    handle.settlePromise = new Promise((r) => {
      settleResolve = r;
    });

    try {
      const sessionDir = sessionDirOf(id);
      const store = createAnalysisJobStore({ sessionDir });
      await store.init();

      const resolveCreds =
        typeof resolveCredentials === "function"
          ? resolveCredentials
          : () => resolveMeetingAnalysisCredentials({ env: process.env, settings: {} });
      const creds = resolveCreds();
      const chat = buildRequestChat(creds);

      const pipeline = createAnalysisPipeline({
        store,
        sessionId: id,
        requestChat: chat,
        profile: creds,
        templateRequest: template,
        forceRefresh: Boolean(force),
        signal,
        logger: (e) => log("analysis", e)
      });

      const result = await pipeline.run();
      return toAnalysisStatusDto(result.job, handle);
    } catch (error) {
      if (error?.code === "aborted") {
        const store = createAnalysisJobStore({ sessionDir: sessionDirOf(id) });
        const job = await store.loadJob().catch(() => null);
        if (job) {
          job.status = JOB_STATUS.CANCELLED;
          job.lastError = { code: "aborted", message: "cancelled" };
          await store.saveJob(job).catch(() => {});
        }
        return toAnalysisStatusDto(job || { status: JOB_STATUS.CANCELLED, stage: "cancelled" }, handle);
      }
      try {
        const store = createAnalysisJobStore({ sessionDir: sessionDirOf(id) });
        const job = await store.loadJob();
        if (job && job.status !== JOB_STATUS.COMPLETED) {
          job.status = JOB_STATUS.FAILED;
          job.lastError = {
            code: error.code || "analysis_failed",
            message: sanitizeErrorMessage(error.message || String(error))
          };
          await store.saveJob(job);
        }
      } catch {
        // ignore
      }
      const err = new Error(error.message || "analysis failed");
      err.code = error.code || "analysis_failed";
      throw err;
    } finally {
      handle.runActive = false;
      handle.cancelling = false;
      handle.controller = null;
      const done = settleResolve;
      handle.settlePromise = null;
      if (done) done();
    }
  }

  async function cancelAnalysis(sessionId) {
    const id = assertValidSessionId(sessionId);
    const handle = peekHandle(id);
    if (!handle || !handle.runActive || !handle.controller) {
      return getAnalysisStatus(id);
    }
    handle.cancelling = true;
    handle.controller.abort();
    if (handle.settlePromise) {
      const raced = await Promise.race([
        handle.settlePromise.then(() => "settled"),
        new Promise((r) => setTimeout(() => r("timeout"), cancelWaitMs))
      ]);
      if (raced === "timeout") {
        return {
          status: "cancelling",
          stage: "cancelling",
          generation: null,
          template: null,
          batches: { total: 0, completed: 0 },
          lastError: { code: "cancelling", message: "cancel in progress" }
        };
      }
    }
    return getAnalysisStatus(id);
  }

  async function retryAnalysis(sessionId, { resetAttempts = true } = {}) {
    const id = assertValidSessionId(sessionId);
    const handle = getOrCreateHandle(id);
    if (handle.runActive || handle.cancelling) {
      const error = new Error(
        handle.cancelling ? "analysis is cancelling" : "analysis already running"
      );
      error.code = handle.cancelling ? "analysis_cancelling" : "analysis_already_running";
      throw error;
    }
    const store = createAnalysisJobStore({ sessionDir: sessionDirOf(id) });
    const job = await store.loadJob();
    if (!job) {
      const error = new Error("no analysis job");
      error.code = "analysis_missing";
      throw error;
    }
    if (job.status === JOB_STATUS.COMPLETED) {
      const error = new Error("cannot retry completed analysis");
      error.code = "retry_not_applicable";
      throw error;
    }
    if (
      job.status !== JOB_STATUS.FAILED &&
      job.status !== JOB_STATUS.CANCELLED
    ) {
      const error = new Error(`retry not applicable for status=${job.status}`);
      error.code = "retry_not_applicable";
      throw error;
    }
    job.status = JOB_STATUS.READY;
    job.lastError = null;
    if (resetAttempts) job.attempts = 0;
    job.stage = STAGE.IDLE;
    await store.saveJob(job);
    // Persist original request — never auto-detect drift on retry
    const tmpl =
      job.templateRequested ||
      (job.templateSource === "manual" ? job.template : job.templateRequested) ||
      job.template ||
      "auto";
    return startAnalysis(id, { template: tmpl });
  }

  async function getCorrectedTranscript(sessionId) {
    const id = assertValidSessionId(sessionId);
    const store = createAnalysisJobStore({ sessionDir: sessionDirOf(id) });
    return store.readFinal("corrected-transcript.json");
  }

  async function getSummary(sessionId) {
    const id = assertValidSessionId(sessionId);
    const store = createAnalysisJobStore({ sessionDir: sessionDirOf(id) });
    const saved = await store.readFinal("summary.json");
    if (!saved) return null;

    // Older completed jobs may have a sparse final summary even though the
    // merge artifact contains usable, evidence-linked fields. Rehydrate the
    // delivery document without making another model request.
    try {
      const job = await store.loadJob();
      const raw = await store.loadRawTranscript();
      const merged = job?.generation
        ? await store.readStageArtifact(job.generation, "merge/merged_extract.json")
        : null;
      const draft = merged?.draft;
      if (!draft || typeof draft !== "object") return saved;

      const mergedSummary = { ...draft, ...saved };
      for (const key of [
        "facts",
        "entities",
        "decisions",
        "actionItems",
        "openIssues",
        "risks",
        "speakerPoints",
        "keyQuotes",
        "coreIdeas",
        "argumentOutline",
        "supportingPoints",
        "assumptions",
        "openQuestions",
        "nextSteps",
        "flaggedUncertain",
        "topicsOutline",
        "timeline"
      ]) {
        if ((!Array.isArray(saved[key]) || saved[key].length === 0) && Array.isArray(draft[key])) {
          mergedSummary[key] = draft[key];
        }
      }
      if (
        (!saved.executiveSummary || !String(saved.executiveSummary.text || "").trim()) &&
        draft.executiveSummary
      ) {
        mergedSummary.executiveSummary = draft.executiveSummary;
      }
      const normalized = validateSummaryEvidence(mergedSummary, raw.doc?.items || []);
      const previousDrops = Array.isArray(saved.verification?.droppedClaims)
        ? saved.verification.droppedClaims
        : [];
      const currentDrops = Array.isArray(normalized?.verification?.droppedClaims)
        ? normalized.verification.droppedClaims
        : [];
      const dropKey = (item) => JSON.stringify(item || {});
      const mergedDrops = [];
      for (const item of [...previousDrops, ...currentDrops]) {
        if (!mergedDrops.some((existing) => dropKey(existing) === dropKey(item))) {
          mergedDrops.push(item);
        }
      }
      if (normalized?.verification) {
        normalized.verification.droppedClaims = mergedDrops;
        normalized.verification.notes = [
          ...new Set([
            ...(saved.verification?.notes || []),
            ...(normalized.verification.notes || [])
          ])
        ];
      }
      return normalized || saved;
    } catch {
      return saved;
    }
  }

  async function shutdown() {
    const pending = [];
    for (const [, handle] of handles) {
      if (handle.controller) {
        try {
          handle.controller.abort();
        } catch {
          // ignore
        }
        handle.cancelling = true;
      }
      if (handle.settlePromise) pending.push(handle.settlePromise);
    }
    if (pending.length) {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise((r) => setTimeout(r, shutdownWaitMs))
      ]);
    }
  }

  return {
    startAnalysis,
    getAnalysisStatus,
    retryAnalysis,
    cancelAnalysis,
    getCorrectedTranscript,
    getSummary,
    shutdown,
    _handles: handles,
    assertValidSessionId
  };
}

module.exports = {
  createMeetingSessionAnalyzer,
  toAnalysisStatusDto,
  assertValidSessionId
};
