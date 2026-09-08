"use strict";

const { createSessionStore } = require("./session-store");
const { createAudioCaptureSupervisor } = require("./supervisor");
const paths = require("./paths");
const protocol = require("./protocol");
const constants = require("./constants");
const {
  exportTrackArchive,
  verifyArchiveIntegrity,
  mapArtifactTimeRange,
  PAUSE_HOLE_POLICY
} = require("./archive/export-track-wav");
const { resolveL0SampleEncoding } = require("./archive/l0-format");
const {
  createOfflineMeetingAudioPublisher,
  createRemoteUrlMeetingAudioPublisher,
  requirePublicUrlPublisher,
  MeetingPublisherError
} = require("./publish/meeting-audio-publisher");
const { mergeMeetingTimeline, SELF_SPEAKER_ID } = require("./timeline/merge-timeline");
const {
  createNoBucketMeetingTranscriptionService,
  buildRawTranscriptFromJob
} = require("./transcription/no-bucket-service");
const { prepareTrackSegments, segmentToDataUrl } = require("./transcription/segment-prep");
const { QWEN_NO_BUCKET, JOB_STATUS, SEGMENT_STATUS } = require("./transcription/constants");
const {
  createMeetingSessionProcessor,
  buildHelperReadyErrorResponse,
  assertValidSessionId
} = require("./processing/session-processor");
const {
  resolveMeetingQwenCredentials,
  assertMeetingCompatibleBaseUrl
} = require("./processing/meeting-credentials");
const {
  toProcessStatusDto,
  toTranscriptDto,
  sanitizeIpcError,
  sanitizeDevicesPayload
} = require("./processing/sanitize-ipc");
const {
  createMeetingSessionAnalyzer,
  toAnalysisStatusDto
} = require("./analysis/session-analyzer");
const { resolveMeetingAnalysisCredentials } = require("./analysis/credentials");
const analysisConstants = require("./analysis/constants");

/**
 * Stage 0B meeting capture facade.
 * Does not share recording state with short-voice IPC.
 */
function createMeetingCaptureService(options = {}) {
  const {
    userDataPath,
    isPackaged = false,
    resourcesPath = "",
    appRoot = "",
    logger = () => {},
    helperPath
  } = options;

  const store = createSessionStore({ userDataPath });
  let supervisor = null;
  let lifecycle = {
    status: "idle",
    sessionId: null,
    lastError: null,
    startedAtMs: null
  };

  function getSupervisor() {
    if (!supervisor) {
      supervisor = createAudioCaptureSupervisor({
        isPackaged,
        resourcesPath,
        appRoot,
        sessionRoot: store.sessionsRoot,
        parentPid: process.pid,
        helperPath,
        logger
      });
      supervisor.onFault(async (message) => {
        const sid = message.session_id || lifecycle.sessionId;
        lifecycle = {
          status: "faulted",
          sessionId: sid || lifecycle.sessionId,
          lastError: {
            code: message.detail?.code || message.event || "session_fault",
            message: message.detail?.message || "capture fault",
            track: message.track || null
          },
          startedAtMs: lifecycle.startedAtMs || null
        };
        if (sid) {
          try {
            await store.updateSession(sid, {
              status: "faulted",
              lastError: lifecycle.lastError
            });
          } catch {
            // ignore store errors during fault
          }
        }
      });
    }
    return supervisor;
  }

  function helperAvailability() {
    try {
      const sup = getSupervisor();
      const ready = sup.ensureHelperBinary();
      return { available: true, helperPath: ready.path };
    } catch (error) {
      return {
        available: false,
        code: error.code || "helper_missing",
        message: error.message,
        helperPath: error.helperPath || (supervisor ? supervisor.helperPath() : null)
      };
    }
  }

  async function ensureReady() {
    await store.init();
    const avail = helperAvailability();
    if (!avail.available) {
      const error = new Error(avail.message || "helper not ready");
      error.code = avail.code || "helper_missing";
      error.helperPath = avail.helperPath;
      throw error;
    }
    return {
      sessionsRoot: store.sessionsRoot,
      helperPath: avail.helperPath,
      helperAvailable: true
    };
  }

  async function createAndPrepareSession({ title } = {}) {
    const created = await store.createSession({ title: String(title || "").slice(0, 200) });
    const sup = getSupervisor();
    await sup.start();
    await sup.configure({ root: store.sessionsRoot, pid: process.pid });
    lifecycle = {
      status: "prepared",
      sessionId: created.session.id,
      lastError: null,
      startedAtMs: null
    };
    return {
      sessionId: created.session.id,
      status: created.session.status,
      createdAt: created.session.createdAt
    };
  }

  async function startMicrophone(sessionId, { deviceId } = {}) {
    const id = String(sessionId || "");
    const current = await store.readSession(id);
    if (!current) {
      const error = new Error(`session not found: ${id}`);
      error.code = "session_not_found";
      throw error;
    }
    const micDir = store.getMicrophoneTrackDir(current.sessionDir);
    const sup = getSupervisor();
    if (!sup.getState().configured) {
      await sup.start();
      await sup.configure({ root: store.sessionsRoot, pid: process.pid });
    }
    const response = await sup.startCapture({
      sessionId: id,
      outputDir: micDir,
      deviceId: deviceId ? String(deviceId).slice(0, 512) : null
    });
    await store.updateSession(id, {
      status: "recording",
      tracks: {
        ...current.session.tracks,
        microphone: {
          ...(current.session.tracks?.microphone || {}),
          status: "recording",
          role: "self"
        }
      }
    });
    const startedAtMs =
      response.idempotent && lifecycle.sessionId === id && lifecycle.startedAtMs
        ? lifecycle.startedAtMs
        : Date.now();
    lifecycle = { status: "recording", sessionId: id, lastError: null, startedAtMs };
    return {
      ok: true,
      sessionId: id,
      started: true,
      captureMode: "microphone",
      idempotent: Boolean(response.idempotent),
      archivePending: true,
      startedAtMs
    };
  }

  async function startDual(sessionId, { deviceId = null, systemDeviceId = null } = {}) {
    const id = String(sessionId || "");
    const current = await store.readSession(id);
    if (!current) {
      const error = new Error(`session not found: ${id}`);
      error.code = "session_not_found";
      throw error;
    }
    const micDir = store.getMicrophoneTrackDir(current.sessionDir);
    const sysDir = store.getSystemTrackDir(current.sessionDir);
    const sup = getSupervisor();
    if (!sup.getState().configured) {
      await sup.start();
      await sup.configure({ root: store.sessionsRoot, pid: process.pid });
    }
    const response = await sup.startDualCapture({
      sessionId: id,
      microphoneOutputDir: micDir,
      systemOutputDir: sysDir,
      microphoneDeviceId: deviceId ? String(deviceId).slice(0, 512) : null,
      systemDeviceId: systemDeviceId ? String(systemDeviceId).slice(0, 512) : null
    });
    await store.updateSession(id, {
      status: "recording",
      tracks: {
        microphone: {
          ...(current.session.tracks?.microphone || {}),
          relativeDir: "audio/microphone",
          status: "recording",
          role: "self"
        },
        system: {
          ...(current.session.tracks?.system || {}),
          relativeDir: "audio/system",
          status: "recording",
          role: "remote_mix_for_diarization"
        }
      }
    });
    const startedAtMs =
      response.idempotent && lifecycle.sessionId === id && lifecycle.startedAtMs
        ? lifecycle.startedAtMs
        : Date.now();
    lifecycle = { status: "recording", sessionId: id, lastError: null, startedAtMs };
    return {
      ok: true,
      sessionId: id,
      started: true,
      captureMode: "dual",
      idempotent: Boolean(response.idempotent),
      archivePending: true,
      startedAtMs,
      tracks: {
        microphone: { role: "self" },
        system: { role: "remote_mix_for_diarization", captureScope: "endpoint_mix" }
      }
    };
  }

  async function pause(sessionId) {
    const id = sessionId ? String(sessionId) : lifecycle.sessionId;
    const sup = getSupervisor();
    try {
      const response = await sup.pause();
      if (response.ok === false) {
        const err = {
          code: response.error?.code || "pause_failed",
          message: response.error?.message || "pause failed"
        };
        lifecycle = { ...lifecycle, lastError: err };
        return { ok: false, sessionId: id, error: err };
      }
      if (id) await store.updateSession(id, { status: "paused" });
      lifecycle = {
        ...lifecycle,
        status: "paused",
        sessionId: id || lifecycle.sessionId,
        lastError: null
      };
      return {
        ok: true,
        sessionId: id,
        paused: true,
        holeQpc: response.result?.result?.data?.holeQpc
      };
    } catch (error) {
      const err = { code: error.code || "pause_failed", message: error.message };
      lifecycle = { ...lifecycle, lastError: err };
      throw error;
    }
  }

  async function resume(sessionId) {
    const id = sessionId ? String(sessionId) : lifecycle.sessionId;
    const sup = getSupervisor();
    try {
      const response = await sup.resume();
      if (response.ok === false) {
        const err = {
          code: response.error?.code || "resume_failed",
          message: response.error?.message || "resume failed"
        };
        lifecycle = { ...lifecycle, lastError: err };
        return { ok: false, sessionId: id, error: err };
      }
      if (id) await store.updateSession(id, { status: "recording" });
      lifecycle = {
        ...lifecycle,
        status: "recording",
        sessionId: id || lifecycle.sessionId,
        lastError: null
      };
      return { ok: true, sessionId: id, paused: false };
    } catch (error) {
      const err = { code: error.code || "resume_failed", message: error.message };
      lifecycle = { ...lifecycle, lastError: err };
      throw error;
    }
  }

  async function stop(sessionId) {
    const id = sessionId ? String(sessionId) : lifecycle.sessionId;
    const sup = getSupervisor();
    try {
      const response = await sup.stopCapture();
      if (response.ok === false) {
        const err = {
          code: response.error?.code || "stop_failed",
          message: response.error?.message || "stop failed"
        };
        lifecycle = { ...lifecycle, lastError: err };
        return { ok: false, sessionId: id, error: err };
      }
      if (id) await store.updateSession(id, { status: "stopped" });
      lifecycle = {
        status: "stopped",
        sessionId: id || lifecycle.sessionId,
        lastError: null,
        startedAtMs: null
      };
      return {
        ok: true,
        sessionId: id,
        stopped: true,
        idempotent: Boolean(response.result?.result?.data?.idempotent)
      };
    } catch (error) {
      const err = { code: error.code || "stop_failed", message: error.message };
      lifecycle = { ...lifecycle, lastError: err };
      throw error;
    }
  }

  async function shutdown() {
    if (supervisor) {
      await supervisor.shutdown();
      supervisor = null;
    }
    lifecycle = { status: "idle", sessionId: null, lastError: null, startedAtMs: null };
  }

  function getLifecycle() {
    const avail = helperAvailability();
    return {
      ...lifecycle,
      supervisor: supervisor
        ? {
            started: supervisor.getState().started,
            configured: supervisor.getState().configured,
            activeSessionId: supervisor.getState().activeSessionId,
            activeCaptureMode: supervisor.getState().activeCaptureMode,
            pendingCount: supervisor.getState().pendingCount
          }
        : null,
      isolatedFromVoiceIpc: true,
      stage: "0B",
      implemented: {
        microphoneCaptureHelper: true,
        systemLoopback: true,
        dualTrack: true,
        processLoopback: false,
        asr: false,
        summary: false,
        meetingUi: false
      },
      available: {
        microphoneCaptureHelper: Boolean(avail.available),
        systemLoopback: Boolean(avail.available),
        dualTrack: Boolean(avail.available),
        helperPathPresent: Boolean(avail.available),
        reason: avail.available ? null : avail.code || "helper_missing"
      },
      limitations: [
        "endpoint_mix_includes_this_app_audio",
        "drm_may_silence_loopback",
        "no_process_isolation",
        "no_asr",
        "no_2h_reliability_claim"
      ]
    };
  }

  async function listSessionsSafe() {
    const list = await store.listSessions();
    return list.map((s) => {
      const rawTitle = s.title == null ? "" : String(s.title);
      const title = rawTitle.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
      return {
        id: s.id,
        title,
        status: s.status,
        source: s.source || "capture",
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        importMeta: s.import || null,
        recoverable: Boolean(s.recovery?.recoverable),
        committedCount:
          s.dualRecovery?.committedCount ?? s.recovery?.authoritativeCommitted?.length ?? null
      };
    });
  }

  async function renameSession(sessionId, title) {
    const id = String(sessionId || "");
    const cleaned = String(title ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 200);
    const next = await store.updateSession(id, { title: cleaned });
    return { id: next.id, title: next.title || cleaned, updatedAt: next.updatedAt };
  }

  async function scanSessionSafe(sessionId) {
    const scanned = await store.scanSession(String(sessionId || ""));
    if (!scanned) return null;
    return {
      id: scanned.session.id,
      status: scanned.session.status,
      recovery: {
        recoverable: scanned.recovery.recoverable,
        committedCount: scanned.recovery.authoritativeCommitted?.length ?? 0,
        hasPart: Boolean(scanned.recovery.partFile),
        archivePending: scanned.recovery.archivePending,
        indexTailErrors: scanned.recovery.indexTailErrors?.length || 0,
        actualL0Format: scanned.recovery.actualL0Format
      },
      tracks: {
        microphone: {
          committedCount: scanned.microphone?.committed?.length || 0,
          hasPart: Boolean(scanned.microphone?.partFile),
          role: scanned.microphone?.manifest?.role || "self"
        },
        system: {
          committedCount: scanned.system?.committed?.length || 0,
          hasPart: Boolean(scanned.system?.partFile),
          role: scanned.system?.manifest?.role || "remote_mix_for_diarization"
        }
      }
    };
  }

  return {
    store,
    ensureReady,
    helperAvailability,
    createAndPrepareSession,
    startMicrophone,
    startDual,
    pause,
    resume,
    stop,
    shutdown,
    getLifecycle,
    listSessions: listSessionsSafe,
    scanSession: scanSessionSafe,
    renameSession,
    queryDevices: async () => {
      const sup = getSupervisor();
      if (!sup.getState().started) await sup.start();
      return sup.queryDevices();
    }
  };
}

module.exports = {
  createMeetingCaptureService,
  createSessionStore,
  createAudioCaptureSupervisor,
  paths,
  protocol,
  constants,
  // Stage 1A archive / ASR handoff (isolated from short-voice path)
  exportTrackArchive,
  verifyArchiveIntegrity,
  mapArtifactTimeRange,
  PAUSE_HOLE_POLICY,
  resolveL0SampleEncoding,
  createOfflineMeetingAudioPublisher,
  createRemoteUrlMeetingAudioPublisher,
  requirePublicUrlPublisher,
  MeetingPublisherError,
  mergeMeetingTimeline,
  SELF_SPEAKER_ID,
  // Stage 2A no-bucket Qwen foundation
  createNoBucketMeetingTranscriptionService,
  buildRawTranscriptFromJob,
  prepareTrackSegments,
  segmentToDataUrl,
  QWEN_NO_BUCKET,
  JOB_STATUS,
  SEGMENT_STATUS,
  // Stage 2B post-process orchestration + IPC DTOs
  createMeetingSessionProcessor,
  buildHelperReadyErrorResponse,
  assertValidSessionId,
  resolveMeetingQwenCredentials,
  assertMeetingCompatibleBaseUrl,
  toProcessStatusDto,
  toTranscriptDto,
  sanitizeIpcError,
  sanitizeDevicesPayload,
  // Stage 4C enhanced diarization (OSS + Fun-ASR system track)
  resolveMeetingFunAsrCredentials: require("./processing/fun-asr-credentials")
    .resolveMeetingFunAsrCredentials,
  resolveMeetingOssCredentials: require("./processing/oss-credentials")
    .resolveMeetingOssCredentials,
  createAliyunOssMeetingAudioPublisher: require("./publish/aliyun-oss-publisher")
    .createAliyunOssMeetingAudioPublisher,
  buildObjectKey: require("./publish/aliyun-oss-publisher").buildObjectKey,
  createFunAsrDiarizeService: require("./transcription/fun-asr-diarize-service")
    .createFunAsrDiarizeService,
  enhancedFingerprint: require("./transcription/fun-asr-diarize-service").enhancedFingerprint,
  buildEnhancedRawTranscript: require("./transcription/fun-asr-diarize-service")
    .buildEnhancedRawTranscript,
  atomicWriteAuthoritativeRawTranscript: require("./transcription/fun-asr-diarize-service")
    .atomicWriteAuthoritativeRawTranscript,
  encodeArchiveWavToUploadMp3: require("./transcription/encode-upload-mp3")
    .encodeArchiveWavToUploadMp3,
  normalizeBitrateKbps: require("./transcription/encode-upload-mp3").normalizeBitrateKbps,
  DEFAULT_BITRATE_KBPS: require("./transcription/encode-upload-mp3").DEFAULT_BITRATE_KBPS,
  ALLOWED_BITRATES: require("./transcription/encode-upload-mp3").ALLOWED_BITRATES,
  normalizeProcessMode: require("./processing/session-processor").normalizeProcessMode,
  sanitizeFunJobForDisk: require("./transcription/fun-asr-diarize-service").sanitizeFunJobForDisk,
  // Stage 3A analysis
  createMeetingSessionAnalyzer,
  toAnalysisStatusDto,
  resolveMeetingAnalysisCredentials,
  analysisConstants,
  // Stage 4B-core / 4B-video
  speakerMap: require("./speaker-map"),
  sessionExport: require("./export/session-export"),
  importWav: require("./import/import-wav"),
  importMedia: require("./import/import-media"),
  importJob: require("./import/import-job"),
  ffmpegRunner: require("./import/ffmpeg-runner"),
  resolveFfmpeg: require("./import/resolve-ffmpeg"),
  mediaToken: require("./playback/media-token")
};
