"use strict";

/**
 * Runtime-only Fun-ASR credentials for meeting enhanced mode.
 * Never persist resolved values. Do NOT fall back to meetingQwenApiKey.
 */

const DEFAULT_FUN_REST = "https://dashscope.aliyuncs.com/api/v1";
const DEFAULT_FUN_MODEL = "fun-asr";

function trimStr(v) {
  return String(v || "").trim();
}

function firstNonEmpty(...values) {
  for (const v of values) {
    const s = trimStr(v);
    if (s) return s;
  }
  return "";
}

function normalizeFunRestBaseUrl(baseUrl) {
  let value = trimStr(baseUrl) || DEFAULT_FUN_REST;
  value = value.replace(/\/+$/, "");
  // Strip accidental compatible-mode suffix for REST async API
  value = value.replace(/\/compatible-mode\/v1$/i, "");
  if (!value.endsWith("/api/v1")) {
    // allow full origin
    if (/^https:\/\/[^/]+$/i.test(value)) {
      value = `${value}/api/v1`;
    }
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    const error = new Error("meeting Fun-ASR Base URL is not a valid URL");
    error.code = "meeting_fun_asr_base_url_invalid";
    throw error;
  }
  if (parsed.protocol !== "https:") {
    const error = new Error("meeting Fun-ASR Base URL must use https://");
    error.code = "meeting_fun_asr_base_url_invalid";
    throw error;
  }
  return value.replace(/\/+$/, "");
}

/**
 * settings may only contribute meetingFunAsr* fields.
 * Fallback: OVI_MEETING_FUN_ASR_API_KEY → DASHSCOPE_API_KEY → FUN_ASR_API_KEY
 * Explicitly does NOT use meetingQwenApiKey or short-voice asr profiles.
 */
function resolveMeetingFunAsrCredentials({ env = process.env, settings = {} } = {}) {
  const s = settings && typeof settings === "object" ? settings : {};
  const apiKey = firstNonEmpty(
    s.meetingFunAsrApiKey,
    env.OVI_MEETING_FUN_ASR_API_KEY,
    env.DASHSCOPE_API_KEY,
    env.FUN_ASR_API_KEY
  );
  const baseUrl = normalizeFunRestBaseUrl(
    firstNonEmpty(s.meetingFunAsrBaseUrl, env.OVI_MEETING_FUN_ASR_BASE_URL, DEFAULT_FUN_REST)
  );
  const modelId = firstNonEmpty(
    s.meetingFunAsrModel,
    env.OVI_MEETING_FUN_ASR_MODEL,
    DEFAULT_FUN_MODEL
  );
  if (!apiKey) {
    const error = new Error(
      "Meeting Fun-ASR API key not configured. Set OVI_MEETING_FUN_ASR_API_KEY or DASHSCOPE_API_KEY."
    );
    error.code = "meeting_fun_asr_credentials_missing";
    throw error;
  }
  return {
    apiKey,
    baseUrl,
    modelId,
    _sensitive: true
  };
}

module.exports = {
  DEFAULT_FUN_REST,
  DEFAULT_FUN_MODEL,
  normalizeFunRestBaseUrl,
  resolveMeetingFunAsrCredentials
};
