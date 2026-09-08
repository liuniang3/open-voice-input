"use strict";

const DEFAULT_MIMO_BASE_URL = "https://api.xiaomimimo.com/v1";
const DEFAULT_QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_FUN_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
const DEFAULT_MODEL = "mimo-v2.5-asr";

function trimStr(value) {
  return String(value || "").trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = trimStr(value);
    if (text) return text;
  }
  return "";
}

function normalizeProvider(provider, model) {
  const p = trimStr(provider).toLowerCase();
  if (p === "qwen" || p === "qwen3" || p === "qwen3-asr") return "qwen3-asr";
  if (p === "fun" || p === "fun-asr") return "fun-asr";
  if (p === "mimo" || p === "mimo-asr") return "mimo";
  const id = trimStr(model).toLowerCase();
  if (id.includes("qwen")) return "qwen3-asr";
  if (id.includes("fun-asr")) return "fun-asr";
  return "mimo";
}

function defaultBaseUrl(provider) {
  if (provider === "qwen3-asr") return DEFAULT_QWEN_BASE_URL;
  if (provider === "fun-asr") return DEFAULT_FUN_BASE_URL;
  return DEFAULT_MIMO_BASE_URL;
}

function validateHttpsBaseUrl(value, code, label) {
  const normalized = trimStr(value).replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    const error = new Error(`${label} Base URL is not a valid URL`);
    error.code = code;
    throw error;
  }
  if (parsed.protocol !== "https:") {
    const error = new Error(`${label} Base URL must use https://`);
    error.code = code;
    throw error;
  }
  return normalized;
}

function normalizeQwenBaseUrl(value) {
  const normalized = validateHttpsBaseUrl(value, "meeting_file_asr_base_url_invalid", "Qwen");
  const pathname = (new URL(normalized).pathname || "/").replace(/\/+$/, "") || "/";
  if ((pathname === "/api/v1" || /\/api\/v1$/i.test(pathname)) && !/compatible-mode/i.test(pathname)) {
    const error = new Error("Qwen 文件转写必须使用 /compatible-mode/v1 Base URL");
    error.code = "meeting_file_asr_base_url_invalid";
    throw error;
  }
  return normalized;
}

/**
 * Resolve only the independent file-import ASR profile. It intentionally does
 * not fall back to meeting Qwen, short-voice ASR, cleaner, or OSS credentials.
 */
function resolveMeetingFileAsrCredentials({ env = process.env, settings = {} } = {}) {
  const s = settings && typeof settings === "object" ? settings : {};
  const modelId = firstNonEmpty(s.meetingFileAsrModel, env.OVI_MEETING_FILE_ASR_MODEL, DEFAULT_MODEL);
  const profile = s.meetingFileAsrProfiles?.[modelId] || {};
  const provider = normalizeProvider(
    firstNonEmpty(profile.provider, s.meetingFileAsrProvider, env.OVI_MEETING_FILE_ASR_PROVIDER),
    modelId
  );
  const apiKey = firstNonEmpty(profile.apiKey, s.meetingFileAsrApiKey, env.OVI_MEETING_FILE_ASR_API_KEY);
  if (!apiKey) {
    const error = new Error("文件转写 ASR API Key 未配置，请在会议设置中填写当前文件 ASR 模型的 Key");
    error.code = "meeting_file_asr_credentials_missing";
    throw error;
  }

  const baseUrlRaw = firstNonEmpty(
    profile.baseUrl,
    s.meetingFileAsrBaseUrl,
    env.OVI_MEETING_FILE_ASR_BASE_URL,
    defaultBaseUrl(provider)
  );
  const baseUrl =
    provider === "qwen3-asr"
      ? normalizeQwenBaseUrl(baseUrlRaw)
      : validateHttpsBaseUrl(baseUrlRaw, "meeting_file_asr_base_url_invalid", provider === "mimo" ? "MiMo" : "Fun-ASR");

  if (provider === "fun-asr") {
    const error = new Error("Fun-ASR 文件导入暂不支持无 OSS 的本地分段流程，请使用 MiMo 或 Qwen3-ASR");
    error.code = "meeting_file_asr_provider_unsupported";
    throw error;
  }

  return {
    provider,
    apiKey,
    baseUrl,
    modelId,
    _sensitive: true
  };
}

module.exports = {
  DEFAULT_MIMO_BASE_URL,
  DEFAULT_QWEN_BASE_URL,
  DEFAULT_FUN_BASE_URL,
  DEFAULT_MODEL,
  normalizeProvider,
  normalizeQwenBaseUrl,
  resolveMeetingFileAsrCredentials
};
