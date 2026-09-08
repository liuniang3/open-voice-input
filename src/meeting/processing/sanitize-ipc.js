"use strict";

const { sanitizeErrorMessage } = require("../transcription/sanitize");

const ABS_PATH_RE = /[A-Za-z]:\\[^\s"']+|\/(?:Users|home|var|tmp|private)\/[^\s"']+|meeting-sessions[\\/][^\s"']+/i;
const SECRET_RE =
  /\b(Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|tp-[A-Za-z0-9_-]{8,}|LTAI[A-Za-z0-9]{12,}|data:audio\/)/i;

function scrubString(s) {
  let out = String(s || "");
  out = out.replace(
    /\b(Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|tp-[A-Za-z0-9_-]{8,}|LTAI[A-Za-z0-9]{12,}|data:audio\/)/gi,
    "[redacted]"
  );
  // Strip query/hash from any http(s) URL (signed OSS URLs, etc.)
  out = out.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname || ""}`;
    } catch {
      return "[redacted-url]";
    }
  });
  out = out.replace(ABS_PATH_RE, "[path]");
  if (out.length > 400) out = `${out.slice(0, 400)}…`;
  return out;
}

function sanitizeIpcError(error) {
  const code = error?.code || "meeting_error";
  let message = sanitizeErrorMessage(error?.message || String(error || "error"));
  message = scrubString(message);
  return { ok: false, error: { code, message } };
}

function stripForbiddenKeys(obj, depth = 0) {
  if (depth > 10 || obj == null) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((x) => stripForbiddenKeys(x, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (/apiKey|authorization|credential|password|token|secret|signedUrl|accessKey/i.test(k)) continue;
    if (k === "url" && typeof v === "string" && /^https?:\/\//i.test(v)) continue;
    if (typeof v === "string") {
      if (SECRET_RE.test(v) || ABS_PATH_RE.test(v)) continue;
      out[k] = v;
    } else {
      out[k] = stripForbiddenKeys(v, depth + 1);
    }
  }
  return out;
}

/** Status/list/scan DTO — no transcript text, no paths, no secrets. */
function toProcessStatusDto(processing) {
  if (!processing || typeof processing !== "object") {
    return {
      stage: "idle",
      mode: "basic",
      processMode: "basic",
      tracks: {},
      transcription: { status: "none", segmentCompleted: 0, segmentTotal: 0 },
      lastError: null
    };
  }
  const rawMode = String(processing.processMode || processing.mode || "basic").toLowerCase();
  const processMode =
    rawMode === "file" ||
    rawMode === "import" ||
    rawMode === "file_transcription" ||
    rawMode === "file-asr"
      ? "file"
      : rawMode === "enhanced" ||
          rawMode === "enhanced_diarize" ||
          rawMode === "diarize" ||
          rawMode === "diarization"
        ? "enhanced"
        : "basic";
  const mode =
    processMode === "enhanced" || processMode === "file"
      ? processMode
      : processing.mode === "qwen_no_bucket"
        ? "basic"
        : processing.mode || "basic";
  return stripForbiddenKeys({
    schema: processing.schema || "meeting_process_v1",
    stage: processing.stage || "idle",
    mode,
    processMode,
    bitrateKbps:
      processing.bitrateKbps == null || processing.bitrateKbps === ""
        ? null
        : Number(processing.bitrateKbps) || null,
    phase: processing.phase || null,
    progress: processing.progress == null ? null : processing.progress,
    remoteCleanup: processing.remoteCleanup || null,
    generation: processing.generation || 1,
    tracks: processing.tracks || {},
    transcription: {
      status: processing.transcription?.status || "none",
      segmentCompleted: Number(processing.transcription?.segmentCompleted) || 0,
      segmentTotal: Number(processing.transcription?.segmentTotal) || 0,
      jobGeneration: processing.transcription?.jobGeneration || null
    },
    updatedAt: processing.updatedAt || null,
    lastError: processing.lastError
      ? {
          code: processing.lastError.code || "error",
          message: scrubString(processing.lastError.message || "")
        }
      : null
  });
}

/**
 * Transcript DTO for meeting:transcript:get.
 * Preserves item.text exactly — no secret-pattern redaction on body text.
 */
function toTranscriptDto(transcript) {
  if (!transcript || typeof transcript !== "object") return null;
  const items = Array.isArray(transcript.items) ? transcript.items : [];
  return {
    schema: transcript.schema || "meeting_raw_transcript_v1",
    sessionId: transcript.sessionId || null,
    generation: transcript.generation || 1,
    provider: transcript.provider || null,
    modelId: transcript.modelId || null,
    mode: transcript.mode || "no_bucket",
    diarization: Boolean(transcript.diarization),
    timestampPrecision: transcript.timestampPrecision || "segment",
    speakers: transcript.speakers || {},
    policy: stripForbiddenKeys(transcript.policy || {}),
    count: items.length,
    items: items.map((item) => ({
      id: item.id ?? null,
      track: item.track ?? null,
      role: item.role ?? null,
      speakerId: item.speakerId ?? null,
      speakerLabel: item.speakerLabel ?? null,
      text: typeof item.text === "string" ? item.text : String(item.text ?? ""),
      providerBeginMs: item.providerBeginMs ?? null,
      providerEndMs: item.providerEndMs ?? null,
      artifactBeginMs: item.artifactBeginMs ?? null,
      artifactEndMs: item.artifactEndMs ?? null,
      sessionBeginMs: item.sessionBeginMs ?? null,
      sessionEndMs: item.sessionEndMs ?? null,
      beginMs: item.beginMs ?? null,
      endMs: item.endMs ?? null,
      timestampPrecision: item.timestampPrecision || "segment",
      sourceIndex: item.sourceIndex ?? null
    }))
  };
}

function toDeviceDto(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    id: String(raw.id || raw.device_id || "").slice(0, 512),
    name: String(raw.name || raw.friendly_name || raw.deviceName || "Device").slice(0, 256),
    kind: raw.flow || raw.kind || raw.type || null,
    isDefault: Boolean(raw.is_default || raw.isDefault)
  };
}

function sanitizeDevicesPayload(data) {
  const d = data && typeof data === "object" ? data : {};
  const mapList = (list) =>
    (Array.isArray(list) ? list : []).map(toDeviceDto).filter((x) => x && x.id);
  return {
    capture: mapList(d.capture || d.devices),
    render: mapList(d.render),
    devices: mapList(d.devices || d.capture)
  };
}

function pickAllowlist(payload, keys) {
  const src = payload && typeof payload === "object" ? payload : {};
  const out = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(src, key)) out[key] = src[key];
  }
  return out;
}

/** Merge processing into session list row without paths/transcript. */
function attachProcessingSummary(sessionRow, processing) {
  const row = stripForbiddenKeys({ ...(sessionRow || {}) });
  delete row.sessionDir;
  delete row.path;
  row.processing = toProcessStatusDto(processing);
  return row;
}

module.exports = {
  sanitizeIpcError,
  scrubString,
  toProcessStatusDto,
  toTranscriptDto,
  sanitizeDevicesPayload,
  pickAllowlist,
  attachProcessingSummary,
  stripForbiddenKeys
};
