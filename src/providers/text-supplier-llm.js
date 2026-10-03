"use strict";

// Shared text-supplier request routing (stage 3B). Meeting summary and file
// summary resolve the same (supplierId, modelId) pair here, then talk to that
// supplier's own HTTPS endpoint with its own key, API style and compatibility
// headers. A missing or deleted supplier fails cleanly: routing never falls
// back to another supplier and never infers one from the model name.

const {
  catalogFor,
  normalizeTextModelSelection,
  resolveTextModel,
  sanitizeModelId,
  sanitizeSupplierId
} = require("../settings/text-suppliers");
const { expandSupplierHeaders } = require("./provider-model-catalog");
const { createOpenAiCompatibleClient } = require("./openai-compatible-client");
const { resolveModelCapability } = require("../settings/model-capabilities");

const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

// Pair-first resolution: an explicit pair or the persisted slot selection wins;
// with neither, callers keep their legacy family fallback (return null).
function resolveTextLlmProfile(settings, { slot, supplierId, modelId, requestTimeoutMs } = {}) {
  const explicitSupplierId = sanitizeSupplierId(supplierId);
  if (supplierId != null && String(supplierId).trim() && !explicitSupplierId) {
    throw Object.assign(new Error("供应商 ID 无效。"), { code: "supplier_invalid" });
  }
  const explicitModelId = sanitizeModelId(modelId);
  let pair = null;
  if (explicitSupplierId) {
    if (!explicitModelId) {
      throw Object.assign(new Error("请选择要使用的模型。"), { code: "supplier_model_missing" });
    }
    pair = { supplierId: explicitSupplierId, modelId: explicitModelId };
  } else if (slot) {
    pair = normalizeTextModelSelection(settings?.textModelSelections?.[slot]);
    if (!pair && settings?.textModelSelections?.[slot]) {
      // A stored selection that no longer validates is a user error, not a
      // reason to silently borrow another supplier's credentials.
      throw Object.assign(new Error("保存的供应商模型选择无效，请重新选择。"), { code: "supplier_invalid" });
    }
    if (!pair && settings?._languageSuppliersMigrated) {
      throw Object.assign(new Error("请在语言处理供应商中配置连接，并选择用于表达整理或摘要的模型。"), { code: "supplier_model_missing" });
    }
    if (!pair) return null;
  } else {
    return null;
  }
  const resolved = resolveTextModel(settings, pair);
  if (!resolved) {
    throw Object.assign(new Error("所选文本供应商不存在或已被删除，请重新选择。"), { code: "supplier_not_found" });
  }
  const capability = catalogFor(settings, pair.supplierId).capabilities[pair.modelId] || {};
  const defaults = resolveModelCapability(pair.modelId);
  return {
    provider: "text-supplier",
    supplierId: pair.supplierId,
    modelId: pair.modelId,
    name: resolved.name,
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
    apiStyle: resolved.apiStyle,
    authStyle: resolved.authStyle,
    requestHeaders: expandSupplierHeaders(resolved.requestHeaders),
    requestTimeoutMs: positiveInteger(requestTimeoutMs,
      positiveInteger(capability.timeoutMs, positiveInteger(slot === "summary" ? settings.meetingAnalysisTimeoutMs : undefined,
        defaults.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS))),
    // Limits come from the selected supplier's own catalog metadata.
    maxOutputTokens: positiveInteger(capability.maxOutput, defaults.maxOutput || DEFAULT_MAX_OUTPUT_TOKENS),
    contextWindow: positiveInteger(capability.contextWindow, defaults.contextWindow),
    reasoning: capability.reasoning ?? defaults.reasoning
  };
}

// Chat call for a resolved supplier profile. maxTokens is capped by the
// catalog's output limit; headers merge profile compat headers with per-call
// additions (auto session tokens already expanded in the profile).
function createTextSupplierChat(profile, { fetchImpl = null, sleepImpl, random } = {}) {
  if (!profile || profile.provider !== "text-supplier") {
    throw Object.assign(new Error("无效的文本供应商配置。"), { code: "supplier_invalid" });
  }
  const client = createOpenAiCompatibleClient({
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    model: profile.modelId,
    apiStyle: profile.apiStyle,
    headerName: profile.authStyle === "api-key" ? "api-key" : "Authorization",
    headerValuePrefix: profile.authStyle === "api-key" ? "" : "Bearer ",
    requestTimeoutMs: profile.requestTimeoutMs,
    fetchImpl, sleepImpl, random
  });
  return async (messages, options = {}) => {
    const requested = positiveInteger(options.maxTokens, profile.maxOutputTokens);
    return client.requestChat(messages, {
      signal: options.signal,
      maxTokens: Math.min(requested, profile.maxOutputTokens),
      stream: options.stream,
      onProgress: options.onProgress,
      maxRetries: options.maxRetries,
      idleTimeoutMs: options.idleTimeoutMs,
      progressTimeoutMs: options.progressTimeoutMs,
      extraBody: { ...(options.stream && profile.reasoning ? { reasoning_effort: profile.reasoning } : {}), ...options.extraBody },
      requestHeaders: {
        ...profile.requestHeaders,
        ...(options.requestHeaders && typeof options.requestHeaders === "object" ? options.requestHeaders : {})
      }
    });
  };
}

module.exports = {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  createTextSupplierChat,
  resolveTextLlmProfile
};
