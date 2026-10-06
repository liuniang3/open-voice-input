const { cleanTranscript } = require("../transcript-cleaner");
const { resolveAsrAudioPolicy } = require("../audio-policy");
const { joinTranscriptSegments } = require("../audio-utils");
const { createFunAsrProvider, FUN_ASR_REST_BASE_URL, normalizeFunAsrModel } = require("./asr/fun-asr-provider");
const { createMimoAsrProvider, normalizeMimoAsrModel } = require("./asr/mimo-asr-provider");
const { createQwen3AsrProvider } = require("./asr/qwen3-asr-provider");
const { createMimoCleanerProvider } = require("./cleaner/mimo-cleaner-provider");
const { createOpenAiCompatibleCleanerProvider } = require("./cleaner/openai-compatible-cleaner-provider");
const { createOpenCodeGoCleanerProvider } = require("./cleaner/opencode-go-cleaner-provider");
const { createMimoClient } = require("./mimo-client");
const { createOpenAiCompatibleClient, normalizeBaseUrl } = require("./openai-compatible-client");
const { AsyncLocalStorage } = require("node:async_hooks");
const { textModelSelectionFor } = require("../settings/text-suppliers");
const { createTextSupplierChat, resolveTextLlmProfile } = require("./text-supplier-llm");
const { buildTextCleanupMessages, parseAndValidateCleanupResponse } = require("./cleaner/text-cleanup-method");
const { createOpenCodeGoClient } = require("./opencode-go-client");
const { resolveProviderConnection } = require("../settings/provider-connections");

const QWEN_ASR_OPENAI_MODEL = "qwen3-asr-flash";
const QWEN_ASR_OPENAI_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const QWEN_ASR_MODES = new Set(["batch", "realtime"]);

function createVoicePipeline({ getSettings, logEvent, providerOverrides = {}, onTranscript }) {
  // Per-invocation settings scope: concurrent requests each keep their own
  // snapshot instead of clobbering a shared override mid-flight.
  const settingsScope = new AsyncLocalStorage();
  const readSettings = () => settingsScope.getStore() || getSettings();
  const mimoClient = createMimoClient({
    getSettings: () => {
      const settings = readSettings();
      const model = settings.asrModel || "mimo-v2.5-asr";
      const connection = resolveProviderConnection(settings, {
        scope: "asr",
        modelId: model,
        provider: "mimo",
        fallback: { apiKey: settings.asrApiKey, baseUrl: settings.asrBaseUrl }
      });
      return {
        ...settings,
        apiKey: connection.apiKey,
        baseUrl: connection.baseUrl,
        model
      };
    },
    useEnvironmentFallback: false
  });
  const mimoCleanerClient = createMimoClient({
    getSettings: () => {
      const settings = readSettings();
      const model = settings.cleanerModel || settings.model || "mimo-v2.5";
      const connection = resolveProviderConnection(settings, {
        modelId: model,
        provider: "mimo",
        fallback: { apiKey: settings.cleanerApiKey, baseUrl: settings.cleanerBaseUrl }
      });
      return {
        ...settings,
        apiKey: connection.apiKey,
        baseUrl: connection.baseUrl,
        model
      };
    },
    useEnvironmentFallback: false
  });
  const qwenAsrClient = createOpenAiCompatibleClient({
    apiKey: resolveDashScopeAsrApiKey,
    baseUrl: resolveQwenAsrBaseUrl,
    model: resolveQwenAsrModel,
    requestTimeoutMs: resolveRequestTimeoutMs
  });
  const openAiCleanerClient = createOpenAiCompatibleClient({
    apiKey: resolveCleanerApiKey,
    baseUrl: resolveCleanerBaseUrl,
    model: resolveCleanerModel,
    apiStyle: resolveCleanerApiStyle,
    requestTimeoutMs: resolveRequestTimeoutMs
  });
  const openCodeGoCleanerClient = createOpenCodeGoClient({
    apiKey: resolveCleanerApiKey,
    baseUrl: resolveCleanerBaseUrl,
    model: resolveCleanerModel,
    requestTimeoutMs: resolveRequestTimeoutMs
  });
  const asrProviders = providerOverrides.asrProviders || {
    mimo: createMimoAsrProvider({
      client: mimoClient,
      cleanTranscript,
      getOptions: () => {
        const settings = readSettings();
        return {
          language: settings.asrLanguage || "",
          model: settings.asrModel || settings.model || ""
        };
      }
    }),
    "qwen3-asr": createQwen3AsrProvider({
      client: qwenAsrClient,
      cleanTranscript,
      getOptions: () => {
        const settings = readSettings();
        return {
          enableItn: Boolean(settings.asrEnableItn),
          language: settings.asrLanguage || ""
        };
      }
    }),
    "fun-asr": createFunAsrProvider({
      apiKey: resolveDashScopeAsrApiKey,
      baseUrl: resolveFunAsrBaseUrl,
      model: resolveFunAsrModel,
      realtimeModel: resolveFunAsrRealtimeModel,
      requestTimeoutMs: resolveRequestTimeoutMs,
      cleanTranscript,
      onLog: logEvent,
      getOptions: () => {
        const settings = readSettings();
        return {
          enableItn: Boolean(settings.asrEnableItn),
          enableSemanticPunctuation: normalizeQwenAsrMode(settings.asrMode) !== "realtime",
          language: settings.asrLanguage || ""
        };
      }
    })
  };
  const cleanerProviders = providerOverrides.cleanerProviders || {
    mimo: createMimoCleanerProvider({ client: mimoCleanerClient, getModel: resolveCleanerModel }),
    "openai-compatible": createOpenAiCompatibleCleanerProvider({ client: openAiCleanerClient }),
    "opencode-go": createOpenCodeGoCleanerProvider({ client: openCodeGoCleanerClient })
  };

  function createTextSupplierCleanerProvider(profile) {
    const chat = createTextSupplierChat(profile);
    return {
      id: `text-supplier:${profile.supplierId}`,
      modelId: profile.modelId,
      async clean({ rawText, shortContext }) {
        // Use the selected model's configured output capability. The shared
        // supplier adapter already caps requests at that model-specific value;
        // dictation cleanup must not impose a separate fixed budget.
        const response = await chat(buildTextCleanupMessages(rawText, shortContext));
        return {
          provider: "text-supplier",
          text: parseAndValidateCleanupResponse(response.content, rawText),
          raw: response
        };
      }
    };
  }

  function normalizeTranscriptionMode(mode) {
    return mode === "fast" ? "fast" : "stable";
  }

  async function completed(text, rawText, mode, history, cleanupApplied = false) {
    if (history?.requestId && text && typeof onTranscript === "function") {
      const settings = readSettings();
      try {
        await onTranscript({ requestId: history.requestId, durationMs: history.durationMs,
          rawText, text, transcriptionMode: mode, cleanupApplied,
          asrModel: settings.asrMode === "realtime" ? settings.asrRealtimeModel : settings.asrModel,
          cleanerModel: cleanupApplied ? settings.textModelSelections?.cleanup?.modelId || settings.cleanerModel : "" });
      } catch { logEvent?.("voice-history: persistence unavailable"); }
    }
    return text;
  }

  async function transcribe({ audioDataUrl, pcm16Base64, audioSegments, shortContext, transcriptionMode, settingsSnapshot, history }) {
    return withSettingsSnapshot(settingsSnapshot, async () => {
      const settings = readSettings();
      const mode = normalizeTranscriptionMode(transcriptionMode || settings.transcriptionMode);
      const asrProvider = resolveAsrProvider(settings);
      const segments = normalizeAudioSegments({ audioDataUrl, pcm16Base64, audioSegments });
      // The cleaner resolves lazily: fast mode never needs it, and a missing or
      // deleted supplier degrades to the raw transcript instead of failing the
      // dictation or rerouting through another supplier.
      const cleanerLabel = () => {
        try {
          return resolveCleanerProvider(settings).id;
        } catch (error) {
          return `unavailable:${error?.code || "error"}`;
        }
      };
      logEvent?.("voice-pipeline: mode", `${mode} asr=${asrProvider.id}:${asrProvider.kind || "audio-chat"} cleaner=${cleanerLabel()}`);

      if (mode === "fast") {
        const texts = await transcribeAudioSegments(asrProvider, "transcribeFast", segments, shortContext);
        const rawText = joinTranscriptSegments(texts);
        const text = cleanTranscript(rawText);
        return completed(text, rawText, mode, history);
      }

      const rawTexts = await transcribeAudioSegments(asrProvider, "transcribeRaw", segments, shortContext);
      const historyRaw = joinTranscriptSegments(rawTexts);
      const rawTranscript = cleanTranscript(historyRaw);
      if (!rawTranscript) return "";

      try {
        const cleanerProvider = resolveCleanerProvider(settings);
        logEvent?.("voice-pipeline: cleaner start", `${cleanerProvider.id}:${resolveCleanerModel()}`);
        const cleanedResult = await cleanerProvider.clean({ rawText: rawTranscript, shortContext });
        logEvent?.("voice-pipeline: cleaner done", cleanedResult.text ? "accepted" : "fallback-empty-or-unsafe");
        return completed(cleanedResult.text || rawTranscript, historyRaw, mode, history, Boolean(cleanedResult.text));
      } catch (error) {
        logEvent?.("voice-pipeline: cleaner failed, using raw", error?.message || String(error));
        return completed(rawTranscript, historyRaw, mode, history);
      }
    });
  }

  async function cleanText({ rawText, shortContext, settingsSnapshot, history }) {
    return withSettingsSnapshot(settingsSnapshot, async () => {
      const text = cleanTranscript(rawText);
      if (!text) return "";
      const settings = readSettings();
      try {
        // Missing/deleted suppliers throw supplier_not_found here and degrade
        // to the raw text; they never fall through to another supplier.
        const cleanerProvider = resolveCleanerProvider(settings);
        logEvent?.("voice-pipeline: cleaner start", `${cleanerProvider.id}:${resolveCleanerModel()}`);
        const cleanedResult = await cleanerProvider.clean({ rawText: text, shortContext });
        logEvent?.("voice-pipeline: cleaner done", cleanedResult.text ? "accepted" : "fallback-empty-or-unsafe");
        return completed(cleanedResult.text || text, String(rawText).trim(), "stable", history, Boolean(cleanedResult.text));
      } catch (error) {
        logEvent?.("voice-pipeline: cleaner failed, using raw", error?.message || String(error));
        return completed(text, String(rawText).trim(), "stable", history);
      }
    });
  }

  async function transcribeSegment({ audioDataUrl, pcm16Base64, shortContext = "", settingsSnapshot }) {
    return withSettingsSnapshot(settingsSnapshot, async () => {
      const asrProvider = resolveAsrProvider(readSettings());
      const result = await transcribeWithAsr(asrProvider, "transcribeRaw", {
        audioDataUrl,
        pcm16Base64,
        shortContext
      });
      return cleanTranscript(result.text);
    });
  }

  async function transcribeAudioSegments(asrProvider, method, segments, shortContext) {
    const texts = [];
    for (let index = 0; index < segments.length; index += 1) {
      logEvent?.("voice-pipeline: asr segment", `${index + 1}/${segments.length}`);
      const result = await transcribeWithAsr(asrProvider, method, {
        ...segments[index],
        shortContext
      });
      texts.push(result.text || "");
    }
    return texts;
  }

  async function transcribeWithAsr(asrProvider, method, payload) {
    logEvent?.("voice-pipeline: asr start", `${asrProvider.id}:${method}`);
    try {
      const result = await asrProvider[method](payload);
      logEvent?.("voice-pipeline: asr done", `${asrProvider.id} chars=${result.text?.length || 0}`);
      return result;
    } catch (error) {
      const detail = error?.message || String(error);
      logEvent?.("voice-pipeline: asr failed", `${asrProvider.id} ${detail}`);
      throw new Error(`语音识别请求失败（${asrProvider.id}）：${detail}`, { cause: error });
    }
  }

  async function testConnection() {
    const settings = readSettings();
    const asrProvider = resolveAsrProvider(settings);
    const cleanerProvider = settings.transcriptionMode === "fast" ? null : resolveCleanerProvider(settings);
    const checks = [];

    checks.push({
      name: "语音识别",
      ok: Boolean(resolveApiKey()),
      detail: `${asrProvider.id} · ${resolveBaseUrl()}`
    });

    checks.push({
      name: "表达整理",
      ok: settings.transcriptionMode === "fast" || Boolean(resolveCleanerApiKey()),
      detail: settings.transcriptionMode === "fast"
        ? "快速模式不调用二次清理"
        : `${cleanerProvider.id} · ${resolveActiveCleanerBaseUrl(settings)}`
    });

    const failed = checks.find((check) => !check.ok);
    if (failed) {
      throw new Error(`${failed.name}连接配置不完整：${failed.detail}`);
    }

    if (typeof asrProvider.testConnection === "function") {
      await asrProvider.testConnection();
    } else if (settings.asrProvider === "qwen3-asr" && normalizeQwenAsrMode(settings.asrMode) === "batch") {
      await qwenAsrClient.requestChat(
        [
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                input_audio: {
                  data: "https://dashscope.oss-cn-beijing.aliyuncs.com/audios/welcome.mp3"
                }
              }
            ]
          }
        ],
        { maxTokens: 64 }
      );
    }

    if (settings.transcriptionMode !== "fast") {
      const messages = [
        { role: "system", content: "Return exactly {\"text\":\"ok\"}." },
        { role: "user", content: "ok" }
      ];
      if (textModelSelectionFor(settings, "cleanup")) {
        await createTextSupplierChat(resolveTextLlmProfile(settings, { slot: "cleanup" }))(messages, { maxTokens: 32 });
      } else if (settings.cleanerProvider === "opencode-go") {
        await openCodeGoCleanerClient.requestChat(messages, { maxTokens: 32 });
      } else if (["openai", "openai-compatible"].includes(settings.cleanerProvider)) {
        await openAiCleanerClient.requestChat(messages, { maxTokens: 32 });
      } else {
        await mimoCleanerClient.requestChat(messages, { maxTokens: 32, model: resolveCleanerModel() });
      }
    }

    return checks;
  }

  return {
    cleanerProviders,
    asrProviders,
    cleanText,
    getAudioPolicy: () => resolveAsrAudioPolicy(readSettings()),
    normalizeTranscriptionMode,
    normalizeQwenAsrMode,
    resolveApiKey,
    resolveBaseUrl,
    testConnection,
    transcribe,
    transcribeSegment
  };

  function resolveAsrProvider(settings) {
    return asrProviders[settings.asrProvider] || asrProviders.mimo;
  }

  function resolveCleanerProvider(settings) {
    const pair = textModelSelectionFor(settings, "cleanup");
    if (pair || settings._languageSuppliersMigrated) {
      // Explicit (supplierId, modelId) selection: resolve it or fail cleanly,
      // never fall through to the family-based cleaner providers.
      const profile = resolveTextLlmProfile(settings, { slot: "cleanup" });
      return createTextSupplierCleanerProvider(profile);
    }
    const provider = settings.cleanerProvider === "openai" ? "openai-compatible" : settings.cleanerProvider;
    return cleanerProviders[provider] || cleanerProviders.mimo;
  }

  function resolveApiKey() {
    const settings = readSettings();
    if (settings.asrProvider === "qwen3-asr" || settings.asrProvider === "fun-asr") return resolveDashScopeAsrApiKey();
    return mimoClient.resolveApiKey();
  }

  function resolveBaseUrl() {
    const settings = readSettings();
    if (settings.asrProvider === "qwen3-asr") return qwenAsrClient.resolveBaseUrl();
    if (settings.asrProvider === "fun-asr") return resolveFunAsrBaseUrl();
    return mimoClient.resolveBaseUrl(mimoClient.resolveApiKey());
  }

  function resolveRequestTimeoutMs() {
    return readSettings().requestTimeoutMs || 60000;
  }

  function resolveDashScopeAsrApiKey() {
    const settings = readSettings();
    return resolveProviderConnection(settings, {
      scope: "asr",
      modelId: settings.asrModel,
      provider: settings.asrProvider,
      operation: settings.asrProvider === "fun-asr" ? "rest" : "compatible",
      fallback: { apiKey: settings.asrApiKey || process.env.QWEN_ASR_API_KEY || process.env.DASHSCOPE_API_KEY }
    }).apiKey;
  }

  function resolveQwenAsrBaseUrl() {
    const settings = readSettings();
    const connection = resolveProviderConnection(settings, {
      scope: "asr",
      modelId: settings.asrModel,
      provider: "qwen3-asr",
      operation: "compatible",
      fallback: {
        apiKey: settings.asrApiKey || process.env.QWEN_ASR_API_KEY || process.env.DASHSCOPE_API_KEY,
        baseUrl: settings.asrBaseUrl || process.env.QWEN_ASR_BASE_URL || process.env.DASHSCOPE_BASE_URL || QWEN_ASR_OPENAI_BASE_URL
      }
    });
    return normalizeBaseUrl(connection.baseUrl, QWEN_ASR_OPENAI_BASE_URL);
  }

  function resolveQwenAsrModel() {
    return normalizeQwenAsrModel(readSettings().asrModel);
  }

  function resolveFunAsrBaseUrl() {
    const settings = readSettings();
    const connection = resolveProviderConnection(settings, {
      scope: "asr",
      modelId: settings.asrModel,
      provider: "fun-asr",
      operation: "rest",
      fallback: {
        apiKey: settings.asrApiKey || process.env.DASHSCOPE_API_KEY,
        baseUrl: settings.asrBaseUrl || process.env.FUN_ASR_BASE_URL || process.env.DASHSCOPE_BASE_URL || FUN_ASR_REST_BASE_URL
      }
    });
    return normalizeBaseUrl(connection.baseUrl, FUN_ASR_REST_BASE_URL);
  }

  function resolveFunAsrModel() {
    return normalizeFunAsrModel(readSettings().asrModel);
  }

  function resolveFunAsrRealtimeModel() {
    return readSettings().asrRealtimeModel || "fun-asr-realtime";
  }

  function resolveCleanerApiKey() {
    const settings = readSettings();
    return resolveCleanerConnection(settings).apiKey;
  }

  function resolveCleanerBaseUrl() {
    const settings = readSettings();
    return normalizeBaseUrl(resolveCleanerConnection(settings).baseUrl, "https://api.openai.com/v1");
  }

  function resolveCleanerApiStyle() {
    return resolveCleanerConnection(readSettings()).apiStyle;
  }

  function resolveCleanerConnection(settings) {
    const pair = textModelSelectionFor(settings, "cleanup");
    if (pair || settings._languageSuppliersMigrated) {
      const profile = resolveTextLlmProfile(settings, { slot: "cleanup" });
      return { apiKey: profile.apiKey, baseUrl: profile.baseUrl, apiStyle: profile.apiStyle };
    }
    return resolveProviderConnection(settings, {
      modelId: settings.cleanerModel,
      provider: settings.cleanerProvider,
      operation: "compatible",
      fallback: {
        apiKey: settings.cleanerApiKey || process.env.CLEANER_API_KEY || "",
        baseUrl: settings.cleanerBaseUrl || process.env.CLEANER_BASE_URL || "https://api.openai.com/v1",
        apiStyle: settings.cleanerApiStyle
      }
    });
  }

  function resolveActiveCleanerBaseUrl(settings) {
    return settings.cleanerProvider === "mimo"
      ? mimoCleanerClient.resolveBaseUrl(mimoCleanerClient.resolveApiKey())
      : resolveCleanerBaseUrl();
  }

  function resolveCleanerModel() {
    const settings = readSettings();
    const pair = textModelSelectionFor(settings, "cleanup");
    return pair ? pair.modelId : settings.cleanerModel || "gpt-5.4-mini";
  }

  async function withSettingsSnapshot(settingsSnapshot, action) {
    if (!settingsSnapshot) return action();
    return settingsScope.run(settingsSnapshot, () => action());
  }
}

function normalizeAudioSegments({ audioDataUrl, pcm16Base64, audioSegments }) {
  const segments = Array.isArray(audioSegments)
    ? audioSegments.filter((segment) => segment?.audioDataUrl || segment?.pcm16Base64)
    : [];
  if (segments.length) return segments;
  if (audioDataUrl || pcm16Base64) return [{ audioDataUrl, pcm16Base64 }];
  throw new Error("没有可用于语音识别的音频数据。");
}

function normalizeQwenAsrMode(mode) {
  return QWEN_ASR_MODES.has(mode) ? mode : "batch";
}

function normalizeQwenAsrModel(model) {
  const value = String(model || "").trim();
  if (!value || value === "mimo-v2.5" || value === "mimo-v2.5-asr") return QWEN_ASR_OPENAI_MODEL;
  if (value.includes("realtime") || value.includes("filetrans")) return QWEN_ASR_OPENAI_MODEL;
  return value;
}

module.exports = {
  createVoicePipeline,
  normalizeMimoAsrModel,
  normalizeQwenAsrModel,
  QWEN_ASR_OPENAI_BASE_URL,
  QWEN_ASR_OPENAI_MODEL,
  normalizeQwenAsrMode
};
