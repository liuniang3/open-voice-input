"use strict";

const crypto = require("node:crypto");

const SECRET_KEY_RE = /api[_-]?key|token|secret|authorization|credential|password|bearer/i;
const SECRET_VALUE_RE = /\b(Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|tp-[A-Za-z0-9_-]{8,}|data:audio\/[^\s"]+)/i;

const PROFILE_ALLOWLIST = new Set([
  "provider",
  "mode",
  "modelId",
  "targetSegmentSeconds",
  "hardSegmentSeconds",
  "targetSampleRate",
  "maxBase64Chars",
  "maxDataUriChars",
  "workDirName",
  "timestampPrecision",
  "diarization"
]);

function sha256Text(text) {
  return crypto.createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

function looksSecretKey(key) {
  return SECRET_KEY_RE.test(String(key || ""));
}

function looksSecretValue(value) {
  if (typeof value !== "string") return false;
  return SECRET_VALUE_RE.test(value);
}

/**
 * Deep-clone sanitizing secrets. Mutates nothing on input.
 * Drops secret keys; redacts secret-like string values.
 */
function sanitizeForPersist(value, depth = 0) {
  if (depth > 12) return "[truncated]";
  if (value == null) return value;
  if (typeof value === "string") {
    if (looksSecretValue(value)) return "[redacted]";
    // Cap free-form error-like strings
    if (value.length > 500) return `${value.slice(0, 500)}…`;
    return value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeForPersist(v, depth + 1));
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (looksSecretKey(k)) continue;
    if (typeof v === "string" && looksSecretValue(v)) {
      out[k] = "[redacted]";
      continue;
    }
    out[k] = sanitizeForPersist(v, depth + 1);
  }
  return out;
}

function pickSafeProfile(profile = {}) {
  const src = profile && typeof profile === "object" ? profile : {};
  const out = {};
  for (const key of PROFILE_ALLOWLIST) {
    if (src[key] != null && !looksSecretKey(key)) {
      const v = src[key];
      if (typeof v === "string" && looksSecretValue(v)) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        out[key] = v;
      }
    }
  }
  return out;
}

function stripUrlQueryAndHash(message) {
  return String(message || "").replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname || ""}`;
    } catch {
      return "[redacted-url]";
    }
  });
}

function sanitizeErrorMessage(message) {
  let s = String(message || "");
  s = s.replace(SECRET_VALUE_RE, "[redacted]");
  s = s.replace(/data:audio\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]+/gi, "[redacted-data-uri]");
  s = stripUrlQueryAndHash(s);
  if (s.length > 300) s = s.slice(0, 300);
  return s;
}

function sanitizeLogDetail(detail) {
  return sanitizeForPersist(detail || {});
}

/** Safe identifier: short string, no secret-like content. */
function sanitizeIdentifier(value, fallback = null) {
  if (value == null) return fallback;
  const s = String(value);
  if (looksSecretValue(s)) return fallback;
  if (s.length > 200) return s.slice(0, 200);
  return s;
}

/**
 * Schema-specific transcript sanitizer.
 * Authoritative `text` on each item is preserved byte-for-byte (JSON encoding only).
 * Metadata is allowlisted / secret-scrubbed. Never uses the 500-char job/log cap on text.
 */
function sanitizeTranscriptForPersist(transcript) {
  if (!transcript || typeof transcript !== "object") {
    const error = new Error("transcript must be an object");
    error.code = "transcript_invalid";
    throw error;
  }
  const src = transcript;
  const out = {
    schema: sanitizeIdentifier(src.schema, null),
    sessionId: src.sessionId == null ? null : sanitizeIdentifier(src.sessionId, null),
    generation: Number.isFinite(Number(src.generation)) ? Number(src.generation) : 1,
    provider: sanitizeIdentifier(src.provider, null),
    modelId: src.modelId == null ? null : sanitizeIdentifier(src.modelId, null),
    mode: sanitizeIdentifier(src.mode, "no_bucket"),
    source: src.source == null ? null : sanitizeIdentifier(src.source, null),
    sourceFileName: src.sourceFileName == null ? null : sanitizeIdentifier(src.sourceFileName, null),
    mediaKind: src.mediaKind == null ? null : sanitizeIdentifier(src.mediaKind, null),
    importer: src.importer == null ? null : sanitizeIdentifier(src.importer, null),
    diarization: Boolean(src.diarization),
    timestampPrecision: sanitizeIdentifier(src.timestampPrecision, "segment"),
    speakers: sanitizeForPersist(src.speakers || {}),
    policy: sanitizeForPersist(src.policy || {}),
    count: 0,
    items: []
  };

  const items = Array.isArray(src.items) ? src.items : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const exactText = typeof item.text === "string" ? item.text : String(item.text ?? "");
    out.items.push({
      id: item.id == null ? null : sanitizeIdentifier(item.id, null),
      track: sanitizeIdentifier(item.track, null),
      role: item.role == null ? null : sanitizeIdentifier(item.role, null),
      speakerId: sanitizeIdentifier(item.speakerId, null),
      speakerLabel: item.speakerLabel == null ? null : sanitizeIdentifier(item.speakerLabel, null),
      // Authoritative transcript — never truncate, never secret-redact as generic string
      text: exactText,
      providerBeginMs: item.providerBeginMs ?? null,
      providerEndMs: item.providerEndMs ?? null,
      artifactBeginMs: item.artifactBeginMs ?? null,
      artifactEndMs: item.artifactEndMs ?? null,
      sessionBeginMs: item.sessionBeginMs ?? null,
      sessionEndMs: item.sessionEndMs ?? null,
      beginMs: item.beginMs ?? null,
      endMs: item.endMs ?? null,
      qpcBegin: item.qpcBegin ?? null,
      qpcEnd: item.qpcEnd ?? null,
      timestampPrecision: sanitizeIdentifier(item.timestampPrecision, "segment"),
      timeline: item.timeline == null ? null : sanitizeIdentifier(item.timeline, null),
      contentSha256: item.contentSha256 == null ? null : sanitizeIdentifier(item.contentSha256, null),
      textSha256: item.textSha256 == null ? null : sanitizeIdentifier(item.textSha256, null),
      sourceIndex: item.sourceIndex ?? null
    });
  }
  out.count = out.items.length;
  return out;
}

/**
 * Allowlist provider/model for segment result artifacts. Never touches text.
 */
function sanitizeResultMeta(rawMeta = {}) {
  const src = rawMeta && typeof rawMeta === "object" ? rawMeta : {};
  return {
    provider: sanitizeIdentifier(src.provider, null),
    model: src.model == null ? null : sanitizeIdentifier(src.model, null)
  };
}

module.exports = {
  SECRET_KEY_RE,
  SECRET_VALUE_RE,
  PROFILE_ALLOWLIST,
  sha256Text,
  looksSecretKey,
  looksSecretValue,
  sanitizeForPersist,
  pickSafeProfile,
  sanitizeErrorMessage,
  stripUrlQueryAndHash,
  sanitizeLogDetail,
  sanitizeIdentifier,
  sanitizeTranscriptForPersist,
  sanitizeResultMeta
};
