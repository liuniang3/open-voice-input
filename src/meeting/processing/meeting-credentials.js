"use strict";

/**
 * Runtime-only meeting Qwen credentials. Never persist resolved values.
 * Isolated from short-voice provider/profile selection.
 */

const DEFAULT_PUBLIC_COMPAT =
  "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen3-asr-flash";

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

/**
 * Reject DashScope REST /api/v1 for the OpenAI-compatible Qwen path.
 * Never auto-rewrite.
 */
function assertMeetingCompatibleBaseUrl(baseUrl) {
  const value = trimStr(baseUrl);
  if (!value) {
    const error = new Error("meeting Base URL is empty");
    error.code = "meeting_base_url_invalid";
    throw error;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    const error = new Error(`meeting Base URL is not a valid URL: ${value}`);
    error.code = "meeting_base_url_invalid";
    throw error;
  }
  if (parsed.protocol !== "https:") {
    const error = new Error("meeting Base URL must use https://");
    error.code = "meeting_base_url_invalid";
    throw error;
  }
  const path = (parsed.pathname || "/").replace(/\/+$/, "") || "/";
  // Exact /api/v1 or ends with /api/v1 without compatible-mode
  if (path === "/api/v1" || /\/api\/v1$/i.test(path)) {
    if (!/compatible-mode/i.test(path)) {
      const error = new Error(
        "meeting Base URL must not use /api/v1 for Qwen OpenAI-compatible calls. " +
          "Use https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1 " +
          "or https://dashscope.aliyuncs.com/compatible-mode/v1"
      );
      error.code = "meeting_base_url_invalid";
      throw error;
    }
  }
  return value.replace(/\/+$/, "");
}

function buildWorkspaceTemplateUrl(workspaceId) {
  const id = trimStr(workspaceId);
  if (!id) return "";
  // Official Beijing workspace OpenAI-compatible template
  return `https://${id}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`;
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, settings?: object }} [opts]
 * settings may only contribute meeting-scoped fields (meetingQwen*), never voice asr profiles.
 */
function resolveMeetingQwenCredentials({ env = process.env, settings = {} } = {}) {
  const s = settings && typeof settings === "object" ? settings : {};

  const apiKey = firstNonEmpty(
    s.meetingQwenApiKey,
    env.OVI_MEETING_QWEN_API_KEY,
    env.QWEN_ASR_API_KEY,
    env.DASHSCOPE_API_KEY
  );

  const workspaceUrl = buildWorkspaceTemplateUrl(
    firstNonEmpty(env.OVI_DASHSCOPE_WORKSPACE_ID, s.meetingDashScopeWorkspaceId)
  );

  const baseUrlRaw = firstNonEmpty(
    s.meetingQwenBaseUrl,
    env.OVI_MEETING_DASHSCOPE_BASE_URL,
    env.OVI_MEETING_QWEN_BASE_URL,
    env.QWEN_ASR_BASE_URL,
    workspaceUrl,
    DEFAULT_PUBLIC_COMPAT
  );

  const modelId = firstNonEmpty(
    s.meetingQwenModel,
    env.OVI_MEETING_QWEN_MODEL,
    DEFAULT_MODEL
  );

  if (!apiKey) {
    const error = new Error(
      "Meeting Qwen API key not configured. Set OVI_MEETING_QWEN_API_KEY, QWEN_ASR_API_KEY, or DASHSCOPE_API_KEY."
    );
    error.code = "meeting_credentials_missing";
    throw error;
  }

  const baseUrl = assertMeetingCompatibleBaseUrl(baseUrlRaw);

  return {
    apiKey,
    baseUrl,
    modelId,
    // Never return key in logs — callers must not stringify this object into DTOs
    _sensitive: true
  };
}

module.exports = {
  DEFAULT_PUBLIC_COMPAT,
  DEFAULT_MODEL,
  assertMeetingCompatibleBaseUrl,
  buildWorkspaceTemplateUrl,
  resolveMeetingQwenCredentials
};
