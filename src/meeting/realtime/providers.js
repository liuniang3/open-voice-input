"use strict";

const { createMimoClient } = require("../../providers/mimo-client");
const { createMimoAsrProvider } = require("../../providers/asr/mimo-asr-provider");
const { createOpenAiCompatibleClient } = require("../../providers/openai-compatible-client");
const { createOpenCodeGoClient, createOpenCodeGoSessionId } = require("../../providers/opencode-go-client");
const { createQwen3AsrProvider } = require("../../providers/asr/qwen3-asr-provider");
const { isSupportedAliMeetingModel } = require("../../providers/asr/ali-meeting-stream");
const { buildTextCleanupMessages, parseAndValidateCleanupResponse } = require("../../providers/cleaner/text-cleanup-method");
const { resolveProviderConnection } = require("../../settings/provider-connections");
const DEFAULT_LIVE_MODEL = "qwen-audio-3.0-asr-flash-streaming";
const MIMO_BATCH_MODEL = "mimo-v2.5-asr";

function meetingTransportFor(modelId) {
  if (isSupportedAliMeetingModel(modelId)) return "ali-streaming";
  if (modelId === MIMO_BATCH_MODEL) return "mimo-batch";
  return null;
}

function previewProfileFor(settings, modelId = DEFAULT_LIVE_MODEL) {
  if (!isSupportedAliMeetingModel(modelId)) {
    throw Object.assign(new Error("请选择阿里 Streaming 或 Fun-ASR 实时模型；MiMo 可在停止后用于音频核对。"), { code: "live_model_unsupported" });
  }
  const profiles = [settings.meetingRealtimeProfiles, settings.meetingQwenProfiles, settings.asrProfiles]
    .map(map => map?.[modelId]).filter(Boolean);
  let p = profiles.find(value => value.apiKey) || profiles[0];
  for (const prefix of ["meetingQwen", "asr"]) {
    if (!p?.apiKey && settings[`${prefix}Model`] === modelId && settings[`${prefix}ApiKey`]) {
      p = { apiKey: settings[`${prefix}ApiKey`], baseUrl: settings[`${prefix}BaseUrl`] };
    }
  }
  const connection = resolveProviderConnection(settings, {
    modelId,
    provider: "aliyun-streaming",
    operation: "streaming",
    fallback: p || {}
  });
  if (!connection.apiKey) throw Object.assign(new Error("请在会议模型设置中为所选实时模型配置 API Key。"), { code: "live_credentials_missing" });
  if (!connection.baseUrl) throw Object.assign(new Error("请为所选实时模型填写所在地域的 API 地址。"), { code: "live_credentials_missing" });
  return { apiKey: connection.apiKey, baseUrl: connection.baseUrl, model: modelId, provider: "aliyun-streaming" };
}

function languageModel(profile) {
  const client = profile.provider === "mimo"
    ? createMimoClient({ getSettings: () => ({ ...profile, model: profile.modelId }), useEnvironmentFallback: false })
    : profile.provider === "opencode-go"
      ? createOpenCodeGoClient({
          ...profile,
          model: profile.modelId,
          sessionId: createOpenCodeGoSessionId("meeting-live")
        })
      : createOpenAiCompatibleClient({ ...profile, model: profile.modelId });
  return async ({ messages, signal, maxTokens = 8192 }) => {
    const response = await client.requestChat(messages, { signal, maxTokens });
    if (response.finishReason && response.finishReason !== "stop") throw Object.assign(new Error("Incomplete model response"), { code: "analysis_response_incomplete" });
    return response.content;
  };
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function profileFor(settings, modelId, cleanup = false, env = process.env) {
  const maps = cleanup ? [settings.meetingAnalysisProfiles, settings.cleanerProfiles] : [settings.meetingFileAsrProfiles, settings.asrProfiles];
  const profiles = maps.map(map => map?.[modelId]).filter(Boolean);
  let p = profiles.find(value => value.apiKey) || profiles[0] || {};
  const prefixes = cleanup ? ["meetingAnalysis", "cleaner"] : ["meetingFileAsr", "asr"];
  if (!p.apiKey) {
    for (const prefix of prefixes) {
      if (settings[`${prefix}Model`] === modelId && settings[`${prefix}ApiKey`]) {
        p = { apiKey: settings[`${prefix}ApiKey`], baseUrl: settings[`${prefix}BaseUrl`], provider: settings[`${prefix}Provider`] };
        break;
      }
    }
  }
  const provider = p.provider || (modelId.startsWith("mimo-") ? "mimo" : modelId.includes("qwen") && !cleanup ? "qwen3-asr" : "openai-compatible");
  const operation = cleanup ? "compatible" : /fun-asr/i.test(modelId) ? "rest" : provider === "qwen3-asr" ? "compatible" : "default";
  const fallbackBaseUrl = p.baseUrl || (provider === "mimo"
    ? "https://api.xiaomimimo.com/v1"
    : cleanup ? "" : "https://dashscope.aliyuncs.com/compatible-mode/v1");
  const connection = resolveProviderConnection(settings, {
    modelId,
    provider,
    operation,
    fallback: {
      ...p,
      apiKey: p.apiKey || (!cleanup && provider === "mimo" ? env.MIMO_API_KEY : ""),
      baseUrl: fallbackBaseUrl
    }
  });
  const apiKey = connection.apiKey;
  if (!apiKey) throw Object.assign(new Error("请先在设置中配置所选模型的 API Key"), { code: "live_credentials_missing" });
  if (!cleanup && (provider !== "mimo" && provider !== "qwen3-asr" || /realtime|filetrans/i.test(modelId)
    || provider === "mimo" && !/^mimo-.*asr/i.test(modelId))) {
    throw Object.assign(new Error("会议实时分段目前支持 MiMo ASR 或 Qwen3-ASR-Flash 非实时接口"), { code: "live_model_unsupported" });
  }
  if (cleanup && provider !== "mimo" && !connection.baseUrl) {
    throw Object.assign(new Error("请为所选清理模型填写明确的 API 地址"), { code: "live_credentials_missing" });
  }
  const baseUrl = connection.baseUrl;
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("live_https_required");
  const requestTimeoutMs = positiveInteger(
    p.timeoutMs ?? p.requestTimeoutMs ?? (cleanup ? settings.meetingAnalysisTimeoutMs : settings.requestTimeoutMs),
    cleanup ? 120000 : 45000
  );
  const maxOutputTokens = positiveInteger(
    p.maxOutput ?? p.maxOutputTokens ?? (cleanup ? settings.meetingAnalysisMaxOutput : undefined),
    8192
  );
  return {
    ...p,
    provider,
    modelId,
    apiKey,
    baseUrl,
    apiStyle: connection.apiStyle,
    requestTimeoutMs,
    maxOutputTokens
  };
}

function transcriber(profile) {
  if (profile.provider === "mimo") {
    const client = createMimoClient({ getSettings: () => ({ ...profile, model: profile.modelId }), useEnvironmentFallback: false });
    return createMimoAsrProvider({ client, cleanTranscript: text => String(text || "").trim(), getOptions: () => ({ model: profile.modelId }) }).transcribeMeetingSegment;
  }
  const client = createOpenAiCompatibleClient({ ...profile, model: profile.modelId });
  return createQwen3AsrProvider({ client, cleanTranscript: text => text }).transcribeMeetingSegment;
}

function cleaner(profile) {
  const client = profile.provider === "mimo"
    ? createMimoClient({ getSettings: () => ({ ...profile, model: profile.modelId }), useEnvironmentFallback: false })
    : profile.provider === "opencode-go"
      ? createOpenCodeGoClient({
          ...profile,
          model: profile.modelId,
          sessionId: createOpenCodeGoSessionId("meeting-cleanup")
        })
      : createOpenAiCompatibleClient({ ...profile, model: profile.modelId });
  return async (text, signal) => {
    const response = await client.requestChat(
      buildTextCleanupMessages(text, "", { policy: "conservative" }),
      { maxTokens: 8192, model: profile.modelId, signal }
    );
    const cleaned = parseAndValidateCleanupResponse(response.content, text, { policy: "conservative" });
    if (!cleaned && text.trim()) throw Object.assign(new Error("清理结果未通过原文保留校验；原文保持不变"), { code: "live_cleanup_validation_failed" });
    return cleaned;
  };
}

module.exports = {
  profileFor,
  transcriber,
  cleaner,
  previewProfileFor,
  meetingTransportFor,
  DEFAULT_LIVE_MODEL,
  MIMO_BATCH_MODEL,
  languageModel,
  isSupportedAliMeetingModel
};
