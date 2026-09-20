"use strict";

const {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT,
  DEFAULT_TIMEOUT_MS,
  BUDGET_RATIO
} = require("./constants");
const { resolveProviderConnection } = require("../../settings/provider-connections");

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

function positiveInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Isolated from short-voice cleaner/ASR and meeting Qwen ASR keys.
 */
function resolveMeetingAnalysisCredentials({ env = process.env, settings = {} } = {}) {
  const s = settings && typeof settings === "object" ? settings : {};
  const modelId = firstNonEmpty(
    s.meetingAnalysisModel,
    env.OVI_MEETING_ANALYSIS_MODEL,
    "gpt-5.4-mini"
  );
  const profile = s.meetingAnalysisProfiles?.[modelId] || {};
  const provider = firstNonEmpty(profile.provider, /^mimo-/i.test(modelId) ? "mimo" : "openai-compatible");
  const connection = resolveProviderConnection(s, {
    modelId,
    provider,
    operation: "compatible",
    fallback: {
      apiKey: firstNonEmpty(profile.apiKey, s.meetingAnalysisApiKey, env.OVI_MEETING_ANALYSIS_API_KEY),
      baseUrl: firstNonEmpty(profile.baseUrl, s.meetingAnalysisBaseUrl, env.OVI_MEETING_ANALYSIS_BASE_URL),
      apiStyle: profile.apiStyle ?? profile.wire_api ?? s.meetingAnalysisApiStyle ?? s.wire_api
    }
  });
  const apiKey = connection.apiKey;
  const baseUrl = connection.baseUrl;

  if (!apiKey) {
    const error = new Error(
      "Meeting analysis API key not configured. Set OVI_MEETING_ANALYSIS_API_KEY (not short-voice cleaner keys)."
    );
    error.code = "analysis_credentials_missing";
    throw error;
  }
  if (!baseUrl) {
    const error = new Error(
      "Meeting analysis Base URL not configured. Set OVI_MEETING_ANALYSIS_BASE_URL."
    );
    error.code = "analysis_credentials_missing";
    throw error;
  }

  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    const error = new Error("meeting analysis Base URL is invalid");
    error.code = "analysis_base_url_invalid";
    throw error;
  }
  if (parsed.protocol !== "https:") {
    const error = new Error("meeting analysis Base URL must use https://");
    error.code = "analysis_base_url_invalid";
    throw error;
  }

  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiStyle: connection.apiStyle,
    provider: provider,
    providerFamily: connection.family,
    modelId,
    contextWindowTokens: positiveInt(
      s.meetingAnalysisContextWindow || env.OVI_MEETING_ANALYSIS_CONTEXT_WINDOW,
      DEFAULT_CONTEXT_WINDOW
    ),
    maxOutputTokens: positiveInt(
      s.meetingAnalysisMaxOutput || env.OVI_MEETING_ANALYSIS_MAX_OUTPUT,
      DEFAULT_MAX_OUTPUT
    ),
    reasoningEffort: firstNonEmpty(
      s.meetingAnalysisReasoning,
      env.OVI_MEETING_ANALYSIS_REASONING,
      ""
    ),
    timeoutMs: positiveInt(
      s.meetingAnalysisTimeoutMs || env.OVI_MEETING_ANALYSIS_TIMEOUT,
      DEFAULT_TIMEOUT_MS
    ),
    budgetRatio: BUDGET_RATIO,
    _sensitive: true
  };
}

module.exports = {
  resolveMeetingAnalysisCredentials
};
