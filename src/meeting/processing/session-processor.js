"use strict";

const path = require("node:path");
const fsp = require("node:fs/promises");
const {
  exportTrackArchive,
  verifyArchiveIntegrity
} = require("../archive/export-track-wav");
const {
  createNoBucketMeetingTranscriptionService
} = require("../transcription/no-bucket-service");
const { JOB_STATUS, SEGMENT_STATUS, QWEN_NO_BUCKET } = require("../transcription/constants");
const { getSessionDir, assertPathInsideRoot } = require("../paths");
const { resolveMeetingQwenCredentials } = require("./meeting-credentials");
const { resolveMeetingFileAsrCredentials } = require("./file-asr-credentials");
const { resolveMeetingFunAsrCredentials } = require("./fun-asr-credentials");
const { resolveMeetingOssCredentials } = require("./oss-credentials");
const { toProcessStatusDto, toTranscriptDto } = require("./sanitize-ipc");
const { sanitizeErrorMessage } = require("../transcription/sanitize");
const { createFunAsrProvider } = require("../../providers/asr/fun-asr-provider");
const { createMimoAsrProvider } = require("../../providers/asr/mimo-asr-provider");
const { createAliyunOssMeetingAudioPublisher } = require("../publish/aliyun-oss-publisher");
const { createOfflineMeetingAudioPublisher } = require("../publish/meeting-audio-publisher");
const {
  createFunAsrDiarizeService,
  enhancedFingerprint,
  qwenItemsToMicSentences,
  buildEnhancedRawTranscript,
  atomicWriteAuthoritativeRawTranscript,
  mergeMeetingTimeline,
  PHASES: FUN_PHASES
} = require("../transcription/fun-asr-diarize-service");
const { normalizeBitrateKbps, DEFAULT_BITRATE_KBPS } = require("../transcription/encode-upload-mp3");

const PROCESS_SCHEMA = "meeting_process_v1";
const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const CANCEL_WAIT_MS = 8000;
const SHUTDOWN_WAIT_MS = 4000;

function normalizeProcessMode(mode) {
  const m = String(mode || "basic").toLowerCase();
  if (m === "file" || m === "import" || m === "file_transcription" || m === "file-asr") return "file";
  return m === "enhanced" || m === "diarize" || m === "diarization" ? "enhanced" : "basic";
}

function nowIso() {
  return new Date().toISOString();
}

function idleProcessing() {
  return {
    schema: PROCESS_SCHEMA,
    stage: "idle",
    mode: "basic",
    processMode: "basic",
    bitrateKbps: null,
    phase: null,
    progress: null,
    remoteCleanup: null,
    generation: 1,
    tracks: {
      microphone: "absent",
      system: "absent"
    },
    transcription: {
      status: "none",
      segmentCompleted: 0,
      segmentTotal: 0,
      jobGeneration: null
    },
    updatedAt: nowIso(),
    lastError: null
  };
}

/** Reject IDs that path sanitization would rewrite (collision / escape). */
function assertValidSessionId(sessionId) {
  const id = String(sessionId || "");
  if (!id || !SESSION_ID_RE.test(id)) {
    const error = new Error("invalid sessionId");
    error.code = "invalid_session_id";
    throw error;
  }
  const sanitized = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (sanitized !== id) {
    const error = new Error("invalid sessionId");
    error.code = "invalid_session_id";
    throw error;
  }
  return id;
}

function countSegments(job) {
  let total = 0;
  let completed = 0;
  for (const track of ["microphone", "system"]) {
    for (const seg of job?.tracks?.[track]?.segments || []) {
      total += 1;
      if (seg.status === SEGMENT_STATUS.COMPLETED || seg.status === "completed") completed += 1;
    }
  }
  return { segmentTotal: total, segmentCompleted: completed };
}

function sourceFingerprintFromArtifacts(artifacts, modelId, mode = "basic", provider = null) {
  const normalizedMode = mode === "enhanced" ? "enhanced_mic" : mode === "file" ? "file" : "no_bucket";
  return JSON.stringify({
    mode: normalizedMode,
    provider: provider || null,
    modelId: modelId || null,
    // Align with 2A job.sourceArtifacts.*.sourceWavSha256 (archive wav content hash)
    mic: artifacts?.microphone?.contentSha256 || null,
    sys: artifacts?.system?.contentSha256 || null,
    hasMic: Boolean(artifacts?.microphone),
    hasSys: Boolean(artifacts?.system)
  });
}

function jobSourceFingerprint(job) {
  if (!job) return null;
  const mode =
    job.fingerprintMode ||
    (job.transcriptDeferred || job.skipTranscriptWrite ? "enhanced_mic" : "no_bucket");
  return JSON.stringify({
    mode,
    provider: job.provider || null,
    modelId: job.modelId || null,
    mic: job.sourceArtifacts?.microphone?.sourceWavSha256 || null,
    sys: job.sourceArtifacts?.system?.sourceWavSha256 || null,
    hasMic: Boolean(job.sourceArtifacts?.microphone),
    hasSys: Boolean(job.sourceArtifacts?.system)
  });
}

function createMeetingSessionProcessor({
  userDataPath,
  getCaptureService,
  createTranscribeSegment = null,
  resolveCredentials = null,
  resolveFileAsrCredentials = null,
  resolveFunAsrCredentials = null,
  resolveOssCredentials = null,
  createPublisher = null,
  createFunAsrProviderImpl = null,
  encodeMp3 = null,
  ffmpegOptions = null,
  logger = () => {},
  cancelWaitMs = CANCEL_WAIT_MS,
  shutdownWaitMs = SHUTDOWN_WAIT_MS
} = {}) {
  if (!userDataPath) {
    throw new Error("userDataPath required");
  }
  if (typeof getCaptureService !== "function") {
    throw new Error("getCaptureService required");
  }

  /**
   * @type {Map<string, {
   *   runActive: boolean,
   *   controller: AbortController|null,
   *   service: object|null,
   *   settlePromise: Promise<void>|null,
   *   cancelling: boolean
   * }>}
   */
  const handles = new Map();

  function log(event, detail = {}) {
    const safe = { ...detail };
    delete safe.apiKey;
    delete safe.audioDataUrl;
    delete safe.text;
    delete safe.credentials;
    logger({ event, ...safe });
  }

  function peekHandle(sessionId) {
    return handles.get(String(sessionId || "")) || null;
  }

  function getOrCreateHandle(sessionId) {
    const id = String(sessionId || "");
    if (!handles.has(id)) {
      handles.set(id, {
        runActive: false,
        controller: null,
        service: null,
        funService: null,
        settlePromise: null,
        cancelling: false
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
    const dir = getSessionDir(root, id);
    return assertPathInsideRoot(root, dir);
  }

  async function readSessionJson(sessionId) {
    const dir = sessionDirOf(sessionId);
    try {
      return JSON.parse(await fsp.readFile(path.join(dir, "session.json"), "utf8"));
    } catch {
      return null;
    }
  }

  async function patchSessionProcessing(sessionId, processing) {
    const store = getCaptureService().store;
    const current = await store.readSession(sessionId);
    if (!current) {
      const error = new Error(`session not found: ${sessionId}`);
      error.code = "session_not_found";
      throw error;
    }
    const nextProcessing = {
      ...idleProcessing(),
      ...(current.session.processing || {}),
      ...processing,
      updatedAt: nowIso()
    };
    await store.updateSession(sessionId, { processing: nextProcessing });
    return nextProcessing;
  }

  function mergeJobIntoProcessing(processing, job, handle) {
    const base = { ...idleProcessing(), ...(processing || {}) };
    const enhanced =
      base.processMode === "enhanced" || base.mode === "enhanced" || base.mode === "enhanced_diarize";
    const file =
      !enhanced &&
      (base.processMode === "file" ||
        base.mode === "file" ||
        job?.fingerprintMode === "file" ||
        job?.transcriptMeta?.mode === "file");
    const counts = countSegments(job);
    let transcriptionStatus = base.transcription?.status || "none";
    if (job) {
      if (job.status === JOB_STATUS.COMPLETED) transcriptionStatus = "completed";
      else if (job.status === JOB_STATUS.FAILED) transcriptionStatus = "failed";
      else if (job.status === JOB_STATUS.CANCELLED) transcriptionStatus = "cancelled";
      else if (job.status === JOB_STATUS.RUNNING) transcriptionStatus = "running";
      else if (job.status === JOB_STATUS.PAUSED) transcriptionStatus = "paused";
      else if (job.status === JOB_STATUS.READY) transcriptionStatus = "ready";
    }
    let stage = base.stage || "idle";
    if (handle?.cancelling) stage = "cancelling";
    else if (handle?.runActive) {
      if (stage !== "exporting" && stage !== "uploading" && stage !== "merging") {
        stage = "transcribing";
      }
    } else if (job?.status === JOB_STATUS.COMPLETED && base.processMode !== "enhanced") {
      stage = "completed";
    } else if (job?.status === JOB_STATUS.FAILED) stage = "failed";
    else if (job?.status === JOB_STATUS.CANCELLED) stage = "cancelled";
    else if (job?.status === JOB_STATUS.RUNNING || job?.status === JOB_STATUS.PAUSED) {
      stage = job.status === JOB_STATUS.PAUSED ? "paused" : "transcribing";
    }

    return {
      ...base,
      stage,
      processMode:
        enhanced ? "enhanced" : file ? "file" : base.processMode || "basic",
      mode:
        enhanced ? "enhanced" : file ? "file" : base.mode === "qwen_no_bucket" ? "basic" : base.mode || "basic",
      generation: job?.generation || base.generation || 1,
      transcription: {
        ...base.transcription,
        status: transcriptionStatus,
        segmentCompleted: counts.segmentTotal ? counts.segmentCompleted : base.transcription?.segmentCompleted || 0,
        segmentTotal: counts.segmentTotal || base.transcription?.segmentTotal || 0,
        jobGeneration: job?.generation ?? base.transcription?.jobGeneration ?? null,
        asrProvider: job?.transcriptMeta?.provider || base.transcription?.asrProvider || null,
        asrModel: job?.transcriptMeta?.modelId || base.transcription?.asrModel || null
      },
      lastError: job?.lastError
        ? {
            code: job.lastError.code || "error",
            message: sanitizeErrorMessage(job.lastError.message || "")
          }
        : base.lastError
    };
  }

  /**
   * Disk-read-only status. Does not create handle entries or mutate job/session.
   */
  async function getProcessStatus(sessionId) {
    const id = assertValidSessionId(sessionId);
    const session = await readSessionJson(id);
    if (!session) return null;
    const handle = peekHandle(id);
    let processing = session.processing || idleProcessing();

    // Read 2A job without recover/mutate
    try {
      const sessionDir = sessionDirOf(id);
      const nb = createNoBucketMeetingTranscriptionService({
        sessionDir,
        sessionId: id,
        transcribeSegment: async () => {
          const error = new Error("status must not transcribe");
          error.code = "invalid_operation";
          throw error;
        }
      });
      const job = await nb.store.loadJob();
      processing = mergeJobIntoProcessing(processing, job, handle);
    } catch (error) {
      if (error?.code === "job_corrupt") {
        processing = {
          ...processing,
          lastError: { code: "job_corrupt", message: sanitizeErrorMessage(error.message) }
        };
      }
    }

    if (handle?.runActive && !handle.cancelling && processing.stage !== "exporting") {
      processing = { ...processing, stage: "transcribing" };
    }
    if (handle?.cancelling) {
      processing = { ...processing, stage: "cancelling" };
    }
    return toProcessStatusDto(processing);
  }

  function assertNotRecording(lifecycle, sessionId) {
    const life = lifecycle || {};
    const status = String(life.status || "");
    const activeId = life.sessionId || null;
    if (
      activeId &&
      String(activeId) === String(sessionId) &&
      (status === "recording" || status === "paused")
    ) {
      const error = new Error("session is still recording or paused; stop capture before processing");
      error.code = "session_still_recording";
      throw error;
    }
  }

  async function assertSessionStoppedOnDisk(sessionId) {
    const session = await readSessionJson(sessionId);
    if (!session) {
      const error = new Error(`session not found: ${sessionId}`);
      error.code = "session_not_found";
      throw error;
    }
    const st = String(session.status || "");
    if (st === "recording" || st === "paused") {
      const error = new Error("session is still recording or paused; stop capture before processing");
      error.code = "session_still_recording";
      throw error;
    }
    return session;
  }

  async function tryReuseImportArchive(sessionDir, track, sessionMeta) {
    // Only import sessions skip L0 re-export; capture path unchanged.
    if (sessionMeta?.source !== "import" && !sessionMeta?.import) return null;
    const wavPath = path.join(sessionDir, "archive", `${track}.mono.wav`);
    const sidecarPath = `${wavPath}.sidecar.json`;
    try {
      assertPathInsideRoot(sessionDir, wavPath);
      assertPathInsideRoot(sessionDir, sidecarPath);
      await verifyArchiveIntegrity({ wavPath, sidecarPath });
      const raw = await fsp.readFile(sidecarPath, "utf8");
      const sidecar = JSON.parse(raw);
      const expected = sessionMeta?.import?.archiveContentSha256;
      if (expected && sidecar.contentSha256 && expected !== sidecar.contentSha256) {
        return null;
      }
      if (!sidecar.import && sessionMeta?.source !== "import") return null;
      return {
        wavPath,
        sidecarPath,
        role: sidecar.role || (track === "microphone" ? "self" : "remote_mix_for_diarization"),
        contentSha256: sidecar.contentSha256,
        reused: true
      };
    } catch {
      return null;
    }
  }

  async function exportTracks(sessionId, sessionDir, scan) {
    const archiveDir = path.join(sessionDir, "archive");
    await fsp.mkdir(archiveDir, { recursive: true });
    assertPathInsideRoot(sessionsRoot(), archiveDir);

    const tracks = { microphone: "absent", system: "absent" };
    const artifacts = {};
    const sessionMeta = scan?.session || null;

    for (const track of ["microphone", "system"]) {
      const trackScan = scan[track];
      const committed = trackScan?.committed || [];
      const reused = await tryReuseImportArchive(sessionDir, track, sessionMeta);
      if (reused) {
        artifacts[track] = {
          wavPath: reused.wavPath,
          sidecarPath: reused.sidecarPath,
          role: reused.role,
          contentSha256: reused.contentSha256,
          reused: true
        };
        tracks[track] = "exported";
        continue;
      }
      if (!committed.length) {
        tracks[track] = "absent";
        continue;
      }
      tracks[track] = "pending";
      const role =
        trackScan?.manifest?.role ||
        (track === "microphone" ? "self" : "remote_mix_for_diarization");
      const result = await exportTrackArchive({
        trackDir: trackScan.trackDir,
        track,
        role,
        sessionId,
        outputDir: archiveDir,
        artifactBaseName: `${track}.mono`,
        committed,
        indexEntries: trackScan.index?.entries || null,
        manifest: trackScan.manifest || null
      });
      await verifyArchiveIntegrity({
        wavPath: result.wavPath,
        sidecarPath: result.sidecarPath
      });
      assertPathInsideRoot(sessionDir, result.wavPath);
      assertPathInsideRoot(sessionDir, result.sidecarPath);
      artifacts[track] = {
        wavPath: result.wavPath,
        sidecarPath: result.sidecarPath,
        role,
        contentSha256: result.contentSha256
      };
      tracks[track] = "exported";
    }

    if (!artifacts.microphone && !artifacts.system) {
      const error = new Error("no committed L0 audio on microphone or system tracks");
      error.code = "no_audio";
      throw error;
    }

    return { tracks, artifacts };
  }

  function buildTranscribeSegment(creds) {
    if (typeof createTranscribeSegment === "function") {
      return createTranscribeSegment(creds);
    }
    const { createOpenAiCompatibleClient } = require("../../providers/openai-compatible-client");
    const { createQwen3AsrProvider } = require("../../providers/asr/qwen3-asr-provider");
    let provider;
    if (creds.provider === "mimo") {
      const { createMimoClient } = require("../../providers/mimo-client");
      provider = createMimoAsrProvider({
        client: createMimoClient({
          getSettings: () => ({
            apiKey: creds.apiKey,
            baseUrl: creds.baseUrl,
            model: creds.modelId,
            requestTimeoutMs: 120000
          }),
          useEnvironmentFallback: false
        }),
        cleanTranscript: (t) => t,
        getOptions: () => ({ model: creds.modelId })
      });
    } else if (creds.provider === "qwen3-asr") {
      const client = createOpenAiCompatibleClient({
        apiKey: creds.apiKey,
        baseUrl: creds.baseUrl,
        model: creds.modelId,
        requestTimeoutMs: 120000
      });
      provider = createQwen3AsrProvider({
        client,
        cleanTranscript: (t) => t,
        getOptions: () => ({})
      });
    } else {
      const error = new Error(`文件转写暂不支持 ${creds.provider || "unknown"} ASR provider`);
      error.code = "meeting_file_asr_provider_unsupported";
      throw error;
    }
    if (typeof provider.transcribeMeetingSegment !== "function") {
      const error = new Error(`文件转写 provider ${creds.provider} 不支持分段转写`);
      error.code = "meeting_file_asr_provider_unsupported";
      throw error;
    }
    return async ({ audioDataUrl, signal }) =>
      provider.transcribeMeetingSegment({ audioDataUrl, signal });
  }

  function makeNoBucket(
    sessionDir,
    id,
    creds,
    signal,
    logTag,
    {
      skipTranscriptWrite = false,
      limits = QWEN_NO_BUCKET,
      fingerprintMode = null,
      transcriptMeta = {}
    } = {}
  ) {
    const transcribeSegment = buildTranscribeSegment(creds);
    const effectiveLimits = {
      ...QWEN_NO_BUCKET,
      ...limits,
      provider: creds?.provider || limits.provider,
      mode: fingerprintMode === "file" ? "file" : limits.mode
    };
    return createNoBucketMeetingTranscriptionService({
      sessionDir,
      sessionId: id,
      maxAttempts: 3,
      retryBackoffMs: 200,
      limits: effectiveLimits,
      provider: creds?.provider || effectiveLimits.provider,
      transcriptMeta,
      skipTranscriptWrite: Boolean(skipTranscriptWrite),
      logger: (e) => log(logTag, e),
      transcribeSegment: async (args) =>
        transcribeSegment({
          audioDataUrl: args.audioDataUrl,
          signal: args.signal || signal,
          track: args.track,
          seq: args.seq
        })
    });
  }

  function resolveFileCreds(preferred = {}) {
    if (typeof resolveFileAsrCredentials === "function") return resolveFileAsrCredentials(preferred);
    return resolveMeetingFileAsrCredentials({
      env: process.env,
      settings: {
        ...(preferred.modelId ? { meetingFileAsrModel: preferred.modelId } : {}),
        ...(preferred.provider ? { meetingFileAsrProvider: preferred.provider } : {})
      }
    });
  }

  function buildFileTranscriptMeta(sessionMeta, creds) {
    const imported = sessionMeta?.import && typeof sessionMeta.import === "object" ? sessionMeta.import : {};
    return {
      mode: "file",
      source: "import",
      provider: creds?.provider || null,
      modelId: creds?.modelId || null,
      sourceFileName: imported.sourceFileName || null,
      mediaKind: imported.mediaKind || null,
      importer: imported.importer || null,
      note: "Imported audio/video is transcribed as one local audio track; no OSS upload or speaker diarization."
    };
  }

  function resolveFunCreds() {
    if (typeof resolveFunAsrCredentials === "function") return resolveFunAsrCredentials();
    return resolveMeetingFunAsrCredentials({ env: process.env, settings: {} });
  }

  function resolveOssCreds() {
    if (typeof resolveOssCredentials === "function") return resolveOssCredentials();
    return resolveMeetingOssCredentials({ env: process.env, settings: {} });
  }

  function buildPublisher() {
    if (typeof createPublisher === "function") return createPublisher();
    try {
      const creds = resolveOssCreds();
      return createAliyunOssMeetingAudioPublisher({ credentials: creds });
    } catch (error) {
      if (error?.code === "meeting_oss_credentials_missing") {
        return createOfflineMeetingAudioPublisher();
      }
      throw error;
    }
  }

  function buildFunProvider(creds) {
    if (typeof createFunAsrProviderImpl === "function") {
      return createFunAsrProviderImpl(creds);
    }
    return createFunAsrProvider({
      apiKey: () => creds.apiKey,
      baseUrl: () => creds.baseUrl,
      model: () => creds.modelId,
      cleanTranscript: (t) => t,
      getOptions: () => ({}),
      onLog: () => {}
    });
  }

  async function loadSidecarJson(sidecarPath) {
    if (!sidecarPath) return null;
    try {
      return JSON.parse(await fsp.readFile(sidecarPath, "utf8"));
    } catch {
      return null;
    }
  }

  function finalizeProcessingFromJob(job, tracks, extras = {}) {
    const counts = countSegments(job);
    const completed = job.status === JOB_STATUS.COMPLETED;
    return {
      stage: completed ? "completed" : job.status === JOB_STATUS.CANCELLED ? "cancelled" : "failed",
      tracks: tracks || undefined,
      processMode: extras.processMode || "basic",
      mode: extras.mode || (extras.processMode === "enhanced" ? "enhanced" : "basic"),
      bitrateKbps: extras.bitrateKbps != null ? extras.bitrateKbps : null,
      phase: extras.phase != null ? extras.phase : null,
      progress: extras.progress != null ? extras.progress : null,
      remoteCleanup: extras.remoteCleanup != null ? extras.remoteCleanup : null,
      transcription: {
        status: completed ? "completed" : job.status,
        segmentCompleted: counts.segmentCompleted,
        segmentTotal: counts.segmentTotal,
        jobGeneration: job.generation || 1,
        asrProvider: extras.asrProvider || job.transcriptMeta?.provider || null,
        asrModel: extras.asrModel || job.transcriptMeta?.modelId || null
      },
      generation: job.generation || 1,
      lastError: job.lastError
        ? {
            code: job.lastError.code || "transcribe_failed",
            message: sanitizeErrorMessage(job.lastError.message || "")
          }
        : null
    };
  }

  function enhancedSourceFingerprint(artifacts, { qwenModelId, funModelId, bitrateKbps }) {
    return enhancedFingerprint({
      micSha: artifacts?.microphone?.contentSha256 || null,
      sysSha: artifacts?.system?.contentSha256 || null,
      qwenModelId: qwenModelId || null,
      funModelId: funModelId || null,
      bitrateKbps: normalizeBitrateKbps(bitrateKbps),
      mode: "enhanced"
    });
  }

  async function readAuthoritativeRawIfPresent(sessionDir) {
    const p = path.join(sessionDir, QWEN_NO_BUCKET.workDirName, "raw-transcript.json");
    try {
      assertPathInsideRoot(sessionDir, p);
      const raw = JSON.parse(await fsp.readFile(p, "utf8"));
      if (raw && Array.isArray(raw.items)) return { path: p, transcript: raw };
    } catch {
      /* missing/corrupt */
    }
    return null;
  }

  /**
   * Gate processSession for enhanced (not retryProcess).
   * Same fingerprint + failed/cancelled → process_needs_retry.
   * Same fingerprint + completed + authoritative raw → short-circuit completed.
   */
  async function shouldResumeEnhanced(sessionDir, artifacts, meta, { allowRetryEntry = false } = {}) {
    const funSvc = createFunAsrDiarizeService({ sessionDir, sessionId: "peek" });
    const funJob = await funSvc.loadJob();
    const fp = enhancedSourceFingerprint(artifacts, meta);
    if (!funJob) return { resume: false, funJob: null, fingerprint: fp, sourceChanged: false };
    const same = funJob.fingerprint === fp;
    if (!same) return { resume: false, funJob, fingerprint: fp, sourceChanged: true };

    if (!allowRetryEntry && (funJob.phase === FUN_PHASES.failed || funJob.phase === FUN_PHASES.cancelled)) {
      const error = new Error(
        funJob.phase === FUN_PHASES.cancelled
          ? "enhanced job cancelled; call meeting:process:retry before re-run"
          : "enhanced job failed; call meeting:process:retry — processSession will not reset"
      );
      error.code = "process_needs_retry";
      error.funJob = funJob;
      throw error;
    }

    if (funJob.phase === FUN_PHASES.completed) {
      const raw = await readAuthoritativeRawIfPresent(sessionDir);
      if (raw?.transcript?.mode === "enhanced_diarize" || raw?.transcript?.diarization === true) {
        return {
          resume: false,
          shortCircuitCompleted: true,
          funJob,
          fingerprint: fp,
          sourceChanged: false,
          raw: raw.transcript
        };
      }
      // completed fun job but raw missing (e.g. crash after merge) → resume merge path
      return { resume: true, funJob, fingerprint: fp, sourceChanged: false, resumeMergeOnly: true };
    }

    if (
      funJob.phase === FUN_PHASES.polling ||
      funJob.phase === FUN_PHASES.merging ||
      funJob.phase === FUN_PHASES.submitted ||
      funJob.phase === FUN_PHASES.uploading ||
      funJob.phase === FUN_PHASES.preparing_audio
    ) {
      return { resume: true, funJob, fingerprint: fp, sourceChanged: false };
    }
    return { resume: false, funJob, fingerprint: fp, sourceChanged: false };
  }

  async function runEnhancedPipeline({
    id,
    sessionDir,
    artifacts,
    tracks,
    signal,
    handle,
    forceResubmit = false,
    bitrateKbps,
    isExplicitRetry = false
  }) {
    const br = normalizeBitrateKbps(
      bitrateKbps != null ? bitrateKbps : DEFAULT_BITRATE_KBPS
    );
    const hasMic = Boolean(artifacts.microphone);
    const hasSys = Boolean(artifacts.system);

    // Lazy credential resolution: only what the present tracks need.
    let qwenCreds = null;
    let funCreds = null;
    let publisher = null;

    if (hasMic) {
      const resolveCreds =
        typeof resolveCredentials === "function"
          ? resolveCredentials
          : () => resolveMeetingQwenCredentials({ env: process.env, settings: {} });
      qwenCreds = resolveCreds();
    }
    if (hasSys) {
      funCreds = resolveFunCreds();
      try {
        publisher =
          typeof createPublisher === "function"
            ? createPublisher()
            : createAliyunOssMeetingAudioPublisher({ credentials: resolveOssCreds() });
      } catch (error) {
        if (error?.code === "meeting_oss_credentials_missing") {
          const err = new Error(
            "Enhanced speaker separation requires OSS credentials (OVI_MEETING_OSS_*)."
          );
          err.code = "meeting_oss_credentials_missing";
          throw err;
        }
        throw error;
      }
      const caps = typeof publisher.capabilities === "function" ? publisher.capabilities() : {};
      if (!caps.canProvidePublicUrl || !caps.uploads) {
        const err = new Error(
          "Enhanced mode requires a MeetingAudioPublisher that uploads and returns HTTPS URLs."
        );
        err.code = "meeting_oss_publisher_required";
        throw err;
      }
    }

    const fp = enhancedSourceFingerprint(artifacts, {
      qwenModelId: qwenCreds?.modelId || null,
      funModelId: funCreds?.modelId || null,
      bitrateKbps: br
    });

    const gate = await shouldResumeEnhanced(
      sessionDir,
      artifacts,
      {
        qwenModelId: qwenCreds?.modelId || null,
        funModelId: funCreds?.modelId || null,
        bitrateKbps: br
      },
      { allowRetryEntry: isExplicitRetry || forceResubmit }
    );

    if (gate.shortCircuitCompleted && !forceResubmit) {
      const session = await readSessionJson(id);
      const prev = session?.processing || {};
      const processing = await patchSessionProcessing(id, {
        stage: "completed",
        processMode: "enhanced",
        mode: "enhanced",
        bitrateKbps: br,
        phase: FUN_PHASES.completed,
        progress: 1,
        remoteCleanup: prev.remoteCleanup || gate.funJob?.remoteCleanup || "deleted",
        tracks: tracks || prev.tracks,
        transcription: {
          status: "completed",
          segmentCompleted: prev.transcription?.segmentCompleted || 0,
          segmentTotal: prev.transcription?.segmentTotal || 0,
          jobGeneration: gate.funJob?.generation || prev.transcription?.jobGeneration || 1
        },
        generation: gate.funJob?.generation || prev.generation || 1,
        lastError: null
      });
      log("process_enhanced_short_circuit", { sessionId: id });
      return toProcessStatusDto(processing);
    }

    // Explicit retry: failed Fun job → force resubmit (clear bad taskId).
    // cancelled/polling/merging with taskId → resume (no force unless caller asks).
    let effectiveForceResubmit = forceResubmit;
    if (isExplicitRetry && !forceResubmit && hasSys && gate.funJob) {
      if (gate.funJob.phase === FUN_PHASES.failed) {
        effectiveForceResubmit = true;
      }
    }

    await patchSessionProcessing(id, {
      stage: "transcribing",
      processMode: "enhanced",
      mode: "enhanced",
      bitrateKbps: br,
      phase: "preparing",
      tracks,
      remoteCleanup: null,
      transcription: {
        status: "running",
        segmentCompleted: 0,
        segmentTotal: 0,
        jobGeneration: null
      },
      lastError: null
    });

    let micTranscript = null;
    let micJob = null;

    if (hasMic) {
      const nb = makeNoBucket(sessionDir, id, qwenCreds, signal, "no_bucket_enhanced_mic", {
        skipTranscriptWrite: true
      });
      handle.service = nb;
      const prepArgs = {
        microphone: {
          wavPath: artifacts.microphone.wavPath,
          sidecarPath: artifacts.microphone.sidecarPath,
          role: artifacts.microphone.role || "self"
        },
        modelId: qwenCreds.modelId
      };
      const decision = await shouldResumeJob(
        nb,
        { microphone: artifacts.microphone },
        qwenCreds.modelId,
        "enhanced",
        qwenCreds.provider
      );
      if (!decision.resume) {
        await nb.prepare({
          ...prepArgs,
          modelId: qwenCreds.modelId,
          fingerprintMode: "enhanced_mic"
        });
      }
      micJob = await nb.run({ signal });
      micTranscript = micJob._transcript || null;
      if (!micTranscript) {
        const resultsByKey = {};
        for (const seg of micJob.tracks?.microphone?.segments || []) {
          if (seg.status !== SEGMENT_STATUS.COMPLETED) continue;
          const v = await nb.store.readValidatedSegmentResult(
            "microphone",
            seg.seq,
            seg.contentSha256,
            micJob.generation ?? 1
          );
          if (v.ok) resultsByKey[`microphone:${seg.seq}`] = v.result;
        }
        const { buildRawTranscriptFromJob } = require("../transcription/no-bucket-service");
        micTranscript = buildRawTranscriptFromJob(micJob, { resultsByKey });
      }
    }

    let systemSentences = [];
    let funResult = null;
    if (hasSys) {
      await patchSessionProcessing(id, {
        stage: "uploading",
        processMode: "enhanced",
        mode: "enhanced",
        bitrateKbps: br,
        phase: FUN_PHASES.uploading
      });
      const funProvider = buildFunProvider(funCreds);
      const funSvc = createFunAsrDiarizeService({
        sessionDir,
        sessionId: id,
        funAsrProvider: funProvider,
        publisher,
        encodeMp3: typeof encodeMp3 === "function" ? encodeMp3 : undefined,
        logger: (e) => log("fun_diarize", e),
        ffmpegOptions
      });
      handle.funService = funSvc;
      const sysSide = await loadSidecarJson(artifacts.system.sidecarPath);
      const expectedDurationMs =
        sysSide?.durationMs ??
        (sysSide?.totalFrames != null && sysSide?.sampleRate
          ? (Number(sysSide.totalFrames) / Number(sysSide.sampleRate)) * 1000
          : null);
      funResult = await funSvc.runSystemDiarization({
        systemWavPath: artifacts.system.wavPath,
        systemContentSha256: artifacts.system.contentSha256,
        expectedDurationMs,
        bitrateKbps: br,
        generation: micJob?.generation || gate.funJob?.generation || 1,
        fingerprint: fp,
        funModelId: funCreds.modelId,
        signal,
        forceResubmit: effectiveForceResubmit
      });
      systemSentences = funResult.sentences || [];
      await patchSessionProcessing(id, {
        stage: "merging",
        processMode: "enhanced",
        mode: "enhanced",
        bitrateKbps: br,
        phase: FUN_PHASES.merging,
        remoteCleanup: funResult.job?.remoteCleanup || "pending"
      });
    } else {
      await patchSessionProcessing(id, {
        stage: "merging",
        processMode: "enhanced",
        mode: "enhanced",
        bitrateKbps: br,
        phase: FUN_PHASES.merging
      });
    }

    throwIfAborted(signal);

    const micSide = hasMic ? await loadSidecarJson(artifacts.microphone.sidecarPath) : null;
    const sysSide = hasSys ? await loadSidecarJson(artifacts.system.sidecarPath) : null;
    const micSentences = qwenItemsToMicSentences(micTranscript?.items || []);
    const merged = mergeMeetingTimeline({
      microphoneSentences: micSentences,
      systemSentences,
      microphoneSidecar: micSide,
      systemSidecar: sysSide,
      sessionId: id
    });
    const raw = buildEnhancedRawTranscript({
      sessionId: id,
      generation: micJob?.generation || funResult?.job?.generation || 1,
      merged,
      qwenModelId: qwenCreds?.modelId || null,
      funModelId: funCreds?.modelId || null,
      bitrateKbps: br,
      fingerprint: fp
    });
    // Leave fun job in merging until raw is committed so crash can resume task.
    await atomicWriteAuthoritativeRawTranscript(sessionDir, raw);

    let remoteCleanup = "none";
    if (funResult?._publisher && funResult.objectKey) {
      const del = await funResult._publisher.deleteObject({
        objectKey: funResult.objectKey,
        sessionId: id,
        track: "system"
      });
      remoteCleanup = del?.ok ? "deleted" : "delete_failed";
      const funSvc = createFunAsrDiarizeService({ sessionDir, sessionId: id });
      await funSvc.markRemoteCleaned(Boolean(del?.ok)).catch(() => {});
      await funSvc.completeJob().catch(() => {});
    } else if (funResult) {
      const funSvc = createFunAsrDiarizeService({ sessionDir, sessionId: id });
      await funSvc.completeJob().catch(() => {});
      remoteCleanup = funResult.job?.remoteCleanup || "none";
    }

    const counts = micJob
      ? countSegments(micJob)
      : { segmentCompleted: 0, segmentTotal: 0 };
    const processing = await patchSessionProcessing(id, {
      stage: "completed",
      processMode: "enhanced",
      mode: "enhanced",
      bitrateKbps: br,
      phase: FUN_PHASES.completed,
      progress: 1,
      remoteCleanup,
      tracks,
      transcription: {
        status: "completed",
        segmentCompleted: counts.segmentCompleted,
        segmentTotal: counts.segmentTotal,
        jobGeneration: micJob?.generation || funResult?.job?.generation || 1
      },
      generation: micJob?.generation || funResult?.job?.generation || 1,
      lastError: null
    });
    log("process_enhanced_done", { sessionId: id, remoteCleanup });
    return toProcessStatusDto(processing);
  }

  /**
   * Connectivity probes for enhanced path (Fun sample + OSS put/sign/delete).
   * Returns DTO without bucket/region/URL/keys.
   */
  async function testEnhancedConnection({ target = "all" } = {}) {
    const t = String(target || "all").toLowerCase();
    const wantFun = t === "all" || t === "fun" || t === "fun-asr";
    const wantOss = t === "all" || t === "oss";
    const results = [];

    if (wantFun) {
      const started = Date.now();
      try {
        const funCreds = resolveFunCreds();
        const provider = buildFunProvider(funCreds);
        if (typeof provider.testConnection !== "function") {
          const err = new Error("Fun-ASR testConnection unavailable");
          err.code = "meeting_fun_asr_test_unavailable";
          throw err;
        }
        await provider.testConnection();
        results.push({
          ok: true,
          target: "fun",
          latencyMs: Date.now() - started,
          error: null
        });
      } catch (error) {
        results.push({
          ok: false,
          target: "fun",
          latencyMs: Date.now() - started,
          error: {
            code: error?.code || "meeting_fun_asr_test_failed",
            message: sanitizeErrorMessage(error?.message || String(error)).slice(0, 200)
          }
        });
      }
    }

    if (wantOss) {
      const started = Date.now();
      try {
        let publisher;
        if (typeof createPublisher === "function") {
          publisher = createPublisher();
        } else {
          const ossCreds = resolveOssCreds();
          publisher = createAliyunOssMeetingAudioPublisher({ credentials: ossCreds });
        }
        if (typeof publisher.testConnection !== "function") {
          const err = new Error("OSS testConnection unavailable");
          err.code = "meeting_oss_test_unavailable";
          throw err;
        }
        await publisher.testConnection();
        results.push({
          ok: true,
          target: "oss",
          latencyMs: Date.now() - started,
          error: null
        });
      } catch (error) {
        results.push({
          ok: false,
          target: "oss",
          latencyMs: Date.now() - started,
          error: {
            code: error?.code || "meeting_oss_test_failed",
            message: sanitizeErrorMessage(error?.message || String(error)).slice(0, 200)
          }
        });
      }
    }

    if (!results.length) {
      return {
        ok: false,
        target: t,
        results: [],
        error: { code: "invalid_target", message: "target must be fun, oss, or all" }
      };
    }
    const ok = results.every((r) => r.ok);
    return {
      ok,
      target: t === "fun-asr" ? "fun" : t,
      results
    };
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) {
      const error = new Error("aborted");
      error.code = "aborted";
      throw error;
    }
  }

  /**
   * Decide whether to resume existing 2A job vs prepare fresh.
   * Fingerprint (source SHA + model + track set) is compared FIRST.
   * Changed inputs → prepare (even if old job is FAILED/CANCELLED).
   * Same inputs + FAILED/CANCELLED → explicit retryProcess required.
   */
  async function shouldResumeJob(nb, artifacts, modelId, mode = "basic", provider = null) {
    let job;
    try {
      job = await nb.store.loadJob();
    } catch (error) {
      if (error?.code === "job_corrupt") throw error;
      throw error;
    }
    if (!job) return { resume: false, job: null };

    const want = sourceFingerprintFromArtifacts(artifacts, modelId, mode, provider);
    const have = jobSourceFingerprint(job);
    if (want !== have) {
      // New model/source/tracks/mode: discard terminal-state gate; prepare fresh generation
      return { resume: false, job, sourceChanged: true };
    }

    // Same inputs: terminal jobs require explicit retry
    if (job.status === JOB_STATUS.FAILED || job.status === JOB_STATUS.CANCELLED) {
      const error = new Error(
        job.status === JOB_STATUS.CANCELLED
          ? "job cancelled; call meeting:process:retry (retryProcess) before re-run"
          : "job failed; call meeting:process:retry (retryProcess) — processSession will not reset attempts"
      );
      error.code = "process_needs_retry";
      error.job = job;
      throw error;
    }

    // Matching source: resume for RUNNING/PAUSED/READY/COMPLETED
    if (
      job.status === JOB_STATUS.RUNNING ||
      job.status === JOB_STATUS.PAUSED ||
      job.status === JOB_STATUS.READY ||
      job.status === JOB_STATUS.COMPLETED ||
      job.status === JOB_STATUS.PREPARING
    ) {
      return { resume: true, job };
    }
    return { resume: false, job };
  }

  async function processSession(sessionId, options = {}) {
    const id = assertValidSessionId(sessionId);
    const requestedMode = options.mode || options.processMode || null;
    let processMode = normalizeProcessMode(requestedMode);
    const bitrateKbps = normalizeBitrateKbps(
      options.bitrateKbps != null ? options.bitrateKbps : DEFAULT_BITRATE_KBPS
    );
    const handle = getOrCreateHandle(id);
    if (handle.runActive || handle.cancelling) {
      const error = new Error(
        handle.cancelling ? "process is cancelling" : "process already running for this session"
      );
      error.code = handle.cancelling ? "process_cancelling" : "process_already_running";
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
      const capture = getCaptureService();
      assertNotRecording(capture.getLifecycle(), id);
      const sessionMeta = await assertSessionStoppedOnDisk(id);
      if (!requestedMode && sessionMeta?.source === "import") processMode = "file";

      const sessionDir = sessionDirOf(id);
      const scanned = await capture.store.scanSession(id);
      if (!scanned) {
        const error = new Error(`session not found: ${id}`);
        error.code = "session_not_found";
        throw error;
      }

      await patchSessionProcessing(id, {
        stage: "exporting",
        lastError: null,
        processMode,
        mode: processMode,
        bitrateKbps: processMode === "enhanced" ? bitrateKbps : null,
        phase: null,
        remoteCleanup: null
      });

      const { tracks, artifacts } = await exportTracks(id, sessionDir, scanned);

      if (processMode === "enhanced") {
        return await runEnhancedPipeline({
          id,
          sessionDir,
          artifacts,
          tracks,
          signal,
          handle,
          forceResubmit: false,
          bitrateKbps,
          isExplicitRetry: false
        });
      }

      if (processMode === "file") {
        const creds = resolveFileCreds();
        const fileLimits = {
          ...QWEN_NO_BUCKET,
          provider: creds.provider,
          mode: "file",
          note: "Imported audio/video file mode uses local Base64 segments without OSS upload or speaker diarization."
        };
        const transcriptMeta = buildFileTranscriptMeta(sessionMeta, creds);
        const fileTrack =
          sessionMeta?.import?.track === "system" && artifacts.system
            ? "system"
            : artifacts.microphone
              ? "microphone"
              : artifacts.system
                ? "system"
                : null;
        if (!fileTrack) {
          const error = new Error("imported session has no archive audio track");
          error.code = "no_audio";
          throw error;
        }

        await patchSessionProcessing(id, {
          stage: "transcribing",
          processMode: "file",
          mode: "file",
          bitrateKbps: null,
          tracks,
          transcription: {
            status: "running",
            segmentCompleted: 0,
            segmentTotal: 0,
            jobGeneration: null
          },
          lastError: null
        });

        const nb = makeNoBucket(sessionDir, id, creds, signal, "file_asr", {
          limits: fileLimits,
          fingerprintMode: "file",
          transcriptMeta
        });
        handle.service = nb;
        const prepArgs = {
          [fileTrack]: {
            wavPath: artifacts[fileTrack].wavPath,
            sidecarPath: artifacts[fileTrack].sidecarPath,
            role: artifacts[fileTrack].role || "self"
          }
        };
        const decision = await shouldResumeJob(
          nb,
          { [fileTrack]: artifacts[fileTrack] },
          creds.modelId,
          "file",
          creds.provider
        );
        if (!decision.resume) {
          await nb.prepare({
            ...prepArgs,
            modelId: creds.modelId,
            fingerprintMode: "file"
          });
        }
        const job = await nb.run({ signal });
        const patch = finalizeProcessingFromJob(job, tracks, {
          processMode: "file",
          mode: "file",
          asrProvider: creds.provider,
          asrModel: creds.modelId
        });
        const processing = await patchSessionProcessing(id, patch);
        log("file_asr_done", { sessionId: id, provider: creds.provider, stage: processing.stage });
        return toProcessStatusDto(processing);
      }

      await patchSessionProcessing(id, {
        stage: "transcribing",
        processMode: "basic",
        mode: "basic",
        bitrateKbps: null,
        tracks,
        transcription: {
          status: "running",
          segmentCompleted: 0,
          segmentTotal: 0,
          jobGeneration: null
        },
        lastError: null
      });

      const resolveCreds =
        typeof resolveCredentials === "function"
          ? resolveCredentials
          : () => resolveMeetingQwenCredentials({ env: process.env, settings: {} });
      const creds = resolveCreds();
      const nb = makeNoBucket(sessionDir, id, creds, signal, "no_bucket");
      handle.service = nb;

      const prepArgs = {};
      if (artifacts.microphone) {
        prepArgs.microphone = {
          wavPath: artifacts.microphone.wavPath,
          sidecarPath: artifacts.microphone.sidecarPath,
          role: artifacts.microphone.role
        };
      }
      if (artifacts.system) {
        prepArgs.system = {
          wavPath: artifacts.system.wavPath,
          sidecarPath: artifacts.system.sidecarPath,
          role: artifacts.system.role
        };
      }

      const decision = await shouldResumeJob(
        nb,
        artifacts,
        creds.modelId,
        "basic",
        creds.provider || QWEN_NO_BUCKET.provider
      );
      if (!decision.resume) {
        await nb.prepare({ ...prepArgs, modelId: creds.modelId });
      }
      // Always run() — includes recoverJob; never silent retryFailed
      const job = await nb.run({ signal });
      const patch = finalizeProcessingFromJob(job, tracks, {
        processMode: "basic",
        mode: "basic"
      });
      const processing = await patchSessionProcessing(id, patch);
      log("process_done", { sessionId: id, stage: processing.stage });
      return toProcessStatusDto(processing);
    } catch (error) {
      if (error?.code === "aborted") {
        const job = handle.service
          ? await handle.service.store.loadJob().catch(() => null)
          : null;
        const counts = countSegments(job);
        const processing = await patchSessionProcessing(id, {
          stage: "cancelled",
          processMode,
          mode: processMode,
          bitrateKbps: processMode === "enhanced" ? bitrateKbps : null,
          transcription: {
            status: "cancelled",
            segmentCompleted: counts.segmentCompleted,
            segmentTotal: counts.segmentTotal,
            jobGeneration: job?.generation ?? null
          },
          lastError: { code: "aborted", message: "cancelled" }
        }).catch(() => idleProcessing());
        return toProcessStatusDto(processing);
      }
      if (error?.code === "process_needs_retry" || error?.code === "job_corrupt") {
        const processing = await patchSessionProcessing(id, {
          stage: "failed",
          processMode,
          mode: processMode,
          lastError: {
            code: error.code,
            message: sanitizeErrorMessage(error.message || String(error))
          }
        }).catch(() => idleProcessing());
        const err = new Error(error.message);
        err.code = error.code;
        err.processing = toProcessStatusDto(processing);
        throw err;
      }
      const processing = await patchSessionProcessing(id, {
        stage: "failed",
        processMode,
        mode: processMode,
        bitrateKbps: processMode === "enhanced" ? bitrateKbps : null,
        transcription: {
          status: "failed",
          segmentCompleted: 0,
          segmentTotal: 0,
          jobGeneration: null
        },
        lastError: {
          code: error.code || "process_failed",
          message: sanitizeErrorMessage(error.message || String(error))
        }
      }).catch(() => idleProcessing());
      const err = new Error(error.message || "process failed");
      err.code = error.code || "process_failed";
      err.processing = toProcessStatusDto(processing);
      throw err;
    } finally {
      handle.runActive = false;
      handle.cancelling = false;
      handle.controller = null;
      handle.service = null;
      handle.funService = null;
      const done = settleResolve;
      handle.settlePromise = null;
      if (done) done();
    }
  }

  async function cancelProcess(sessionId) {
    const id = assertValidSessionId(sessionId);
    const handle = peekHandle(id);
    if (!handle || !handle.runActive || !handle.controller) {
      const st = await getProcessStatus(id);
      return st || toProcessStatusDto(idleProcessing());
    }
    handle.cancelling = true;
    handle.controller.abort();
    const settle = handle.settlePromise;
    if (settle) {
      const raced = await Promise.race([
        settle.then(() => "settled"),
        new Promise((r) => setTimeout(() => r("timeout"), cancelWaitMs))
      ]);
      if (raced === "timeout") {
        // Lock still held by run finally — report cancelling, not false cancelled
        const session = await readSessionJson(id);
        return toProcessStatusDto({
          ...(session?.processing || idleProcessing()),
          stage: "cancelling",
          transcription: {
            ...(session?.processing?.transcription || {}),
            status: "cancelling"
          },
          lastError: { code: "cancelling", message: "cancel in progress" }
        });
      }
    }
    return (await getProcessStatus(id)) || toProcessStatusDto({ stage: "cancelled" });
  }

  async function retryProcess(sessionId, options = {}) {
    const id = assertValidSessionId(sessionId);
    const resetAttempts = options.resetAttempts !== false;
    const session = await readSessionJson(id);
    if (!session) {
      const error = new Error(`session not found: ${id}`);
      error.code = "session_not_found";
      throw error;
    }
    const priorMode = normalizeProcessMode(
      options.mode || options.processMode || session.processing?.processMode || session.processing?.mode
    );
    const bitrateKbps = normalizeBitrateKbps(
      options.bitrateKbps != null
        ? options.bitrateKbps
        : session.processing?.bitrateKbps != null
          ? session.processing.bitrateKbps
          : DEFAULT_BITRATE_KBPS
    );

    const handle = getOrCreateHandle(id);
    if (handle.runActive || handle.cancelling) {
      const error = new Error(
        handle.cancelling ? "process is cancelling" : "process already running for this session"
      );
      error.code = handle.cancelling ? "process_cancelling" : "process_already_running";
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
      const capture = getCaptureService();
      assertNotRecording(capture.getLifecycle(), id);
      await assertSessionStoppedOnDisk(id);
      const sessionDir = sessionDirOf(id);

      if (priorMode === "enhanced") {
        const scanned = await capture.store.scanSession(id);
        if (!scanned) {
          const error = new Error(`session not found: ${id}`);
          error.code = "session_not_found";
          throw error;
        }
        const { tracks, artifacts } = await exportTracks(id, sessionDir, scanned);
        // Explicit retry entry: failed → resubmit; cancelled/in-flight task → resume.
        return await runEnhancedPipeline({
          id,
          sessionDir,
          artifacts,
          tracks,
          signal,
          handle,
          forceResubmit: options.forceResubmit === true,
          bitrateKbps,
          isExplicitRetry: true
        });
      }

      const fileMode = priorMode === "file";
      const resolveCreds = fileMode
        ? resolveFileCreds
        : typeof resolveCredentials === "function"
          ? resolveCredentials
          : () => resolveMeetingQwenCredentials({ env: process.env, settings: {} });
      const creds = fileMode
        ? resolveCreds({
            provider: session.processing?.transcription?.asrProvider,
            modelId: session.processing?.transcription?.asrModel
          })
        : resolveCreds();
      const nb = makeNoBucket(sessionDir, id, creds, signal, fileMode ? "file_asr_retry" : "no_bucket_retry", {
        limits: fileMode ? { ...QWEN_NO_BUCKET, provider: creds.provider, mode: "file" } : QWEN_NO_BUCKET,
        fingerprintMode: fileMode ? "file" : "no_bucket",
        transcriptMeta: fileMode ? buildFileTranscriptMeta(session, creds) : {}
      });
      handle.service = nb;

      await nb.retryFailed({ resetAttempts });
      await patchSessionProcessing(id, {
        stage: "transcribing",
        processMode: priorMode,
        mode: priorMode,
        transcription: { status: "running", segmentCompleted: 0, segmentTotal: 0 },
        lastError: null
      });
      const job = await nb.run({ signal });
      const patch = finalizeProcessingFromJob(job, null, {
        processMode: priorMode,
        mode: priorMode,
        asrProvider: fileMode ? creds.provider : null,
        asrModel: fileMode ? creds.modelId : null
      });
      const processing = await patchSessionProcessing(id, patch);
      return toProcessStatusDto(processing);
    } catch (error) {
      if (error?.code === "aborted") {
        const job = handle.service
          ? await handle.service.store.loadJob().catch(() => null)
          : null;
        const counts = countSegments(job);
        const processing = await patchSessionProcessing(id, {
          stage: "cancelled",
          processMode: priorMode,
          mode: priorMode,
          transcription: {
            status: "cancelled",
            segmentCompleted: counts.segmentCompleted,
            segmentTotal: counts.segmentTotal,
            jobGeneration: job?.generation ?? null
          },
          lastError: { code: "aborted", message: "cancelled" }
        }).catch(() => idleProcessing());
        return toProcessStatusDto(processing);
      }
      if (error?.code === "retry_not_applicable") throw error;
      const processing = await patchSessionProcessing(id, {
        stage: "failed",
        processMode: priorMode,
        mode: priorMode,
        lastError: {
          code: error.code || "retry_failed",
          message: sanitizeErrorMessage(error.message || String(error))
        }
      }).catch(() => idleProcessing());
      const err = new Error(error.message || "retry failed");
      err.code = error.code || "retry_failed";
      err.processing = toProcessStatusDto(processing);
      throw err;
    } finally {
      handle.runActive = false;
      handle.cancelling = false;
      handle.controller = null;
      handle.service = null;
      handle.funService = null;
      const done = settleResolve;
      handle.settlePromise = null;
      if (done) done();
    }
  }

  async function getRawTranscript(sessionId) {
    const id = assertValidSessionId(sessionId);
    const sessionDir = sessionDirOf(id);
    const nb = createNoBucketMeetingTranscriptionService({
      sessionDir,
      sessionId: id,
      transcribeSegment: async () => {
        const error = new Error("transcript read must not transcribe");
        error.code = "invalid_operation";
        throw error;
      }
    });
    const tr = await nb.getTranscript();
    return toTranscriptDto(tr);
  }

  async function listProcessSummaries() {
    const capture = getCaptureService();
    const list = await capture.listSessions();
    const out = [];
    for (const row of list) {
      const st = await getProcessStatus(row.id).catch(() => null);
      out.push({ sessionId: row.id, processing: st });
    }
    return out;
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
    // Do not force runActive=false — each run's finally owns that
  }

  return {
    processSession,
    getProcessStatus,
    retryProcess,
    cancelProcess,
    getRawTranscript,
    listProcessSummaries,
    testEnhancedConnection,
    shutdown,
    _handles: handles,
    assertValidSessionId
  };
}

/**
 * Build sanitized helper-ready failure payload (no filesystem paths).
 */
function buildHelperReadyErrorResponse(error) {
  const { sanitizeIpcError } = require("./sanitize-ipc");
  const base = sanitizeIpcError(error);
  return {
    ok: false,
    helperAvailable: false,
    error: base.error
  };
}

module.exports = {
  createMeetingSessionProcessor,
  idleProcessing,
  PROCESS_SCHEMA,
  assertValidSessionId,
  buildHelperReadyErrorResponse,
  SESSION_ID_RE,
  normalizeProcessMode
};
