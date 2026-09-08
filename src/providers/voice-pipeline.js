const { cleanTranscript } = require("../transcript-cleaner");
const { resolveAsrAudioPolicy } = require("../audio-policy");
const { joinTranscriptSegments } = require("../audio-utils");
const { createFunAsrProvider, FUN_ASR_REST_BASE_URL, normalizeFunAsrModel } = require("./asr/fun-asr-provider");
const { createMimoAsrProvider, normalizeMimoAsrModel } = require("./asr/mimo-asr-provider");
const { createQwen3AsrProvider } = require("./asr/qwen3-asr-provider");
const { createMimoCleanerProvider } = require("./cleaner/mimo-cleaner-provider");
const { createOpenAiCompatibleCleanerProvider } = require("./cleaner/openai-compatible-cleaner-provider");
const { createMimoClient } = require("./mimo-client");
const { createOpenAiCompatibleClient, normalizeBaseUrl } = require("./openai-compatible-client");

const QWEN_ASR_OPENAI_MODEL = "qwen3-asr-flash";
const QWEN_ASR_OPENAI_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const QWEN_ASR_MODES = new Set(["batch", "realtime"]);

function createVoicePipeline({ getSettings, logEvent, providerOverrides = {} }) {
  let overrideSettings = null;
  const readSettings = () => overrideSettings || getSettings();
  const mimoClient = createMimoClient({
    getSettings: () => {
      const settings = readSettings();
      return {
        ...settings,
        apiKey: settings.asrApiKey || "",
        baseUrl: settings.asrBaseUrl || "",
        model: settings.asrModel || "mimo-v2.5-asr"
      };
    },
    useEnvironmentFallback: false
  });
  const mimoCleanerClient = createMimoClient({
    getSettings: () => {
      const settings = readSettings();
      return {
        ...settings,
        apiKey: settings.cleanerApiKey || "",
        baseUrl: settings.cleanerBaseUrl || "",
        model: settings.cleanerModel || settings.model || "mimo-v2.5"
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
    "openai-compatible": createOpenAiCompatibleCleanerProvider({ client: openAiCleanerClient })
  };

  function normalizeTranscriptionMode(mode) {
    return mode === "fast" ? "fast" : "stable";
  }

  async function transcribe({ audioDataUrl, pcm16Base64, audioSegments, shortContext, transcriptionMode, settingsSnapshot }) {
    return withSettingsSnapshot(settingsSnapshot, async () => {
      const settings = readSettings();
      const mode = normalizeTranscriptionMode(transcriptionMode || settings.transcriptionMode);
      const asrProvider = resolveAsrProvider(settings);
      const cleanerProvider = resolveCleanerProvider(settings);
      const segments = normalizeAudioSegments({ audioDataUrl, pcm16Base64, audioSegments });
      logEvent?.("voice-pipeline: mode", `${mode} asr=${asrProvider.id}:${asrProvider.kind || "audio-chat"} cleaner=${cleanerProvider.id}`);

      if (mode === "fast") {
        const texts = await transcribeAudioSegments(asrProvider, "transcribeFast", segments, shortContext);
        return cleanTranscript(joinTranscriptSegments(texts));
      }

      const rawTexts = await transcribeAudioSegments(asrProvider, "transcribeRaw", segments, shortContext);
      const rawTranscript = cleanTranscript(joinTranscriptSegments(rawTexts));
      if (!rawTranscript) return "";

      logEvent?.("voice-pipeline: cleaner start", `${cleanerProvider.id}:${resolveCleanerModel()}`);
      try {
        const cleanedResult = await cleanerProvider.clean({ rawText: rawTranscript, shortContext });
        logEvent?.("voice-pipeline: cleaner done", cleanedResult.text ? "accepted" : "fallback-empty-or-unsafe");
        return cleanedResult.text || rawTranscript;
      } catch (error) {
        logEvent?.("voice-pipeline: cleaner failed, using raw", error?.message || String(error));
        return rawTranscript;
      }
    });
  }

  async function cleanText({ rawText, shortContext, settingsSnapshot }) {
    return withSettingsSnapshot(settingsSnapshot, async () => {
      const text = cleanTranscript(rawText);
      if (!text) return "";
      const settings = readSettings();
      const cleanerProvider = resolveCleanerProvider(settings);
      logEvent?.("voice-pipeline: cleaner start", `${cleanerProvider.id}:${resolveCleanerModel()}`);
      try {
        const cleanedResult = await cleanerProvider.clean({ rawText: text, shortContext });
        logEvent?.("voice-pipeline: cleaner done", cleanedResult.text ? "accepted" : "fallback-empty-or-unsafe");
        return cleanedResult.text || text;
      } catch (error) {
        logEvent?.("voice-pipeline: cleaner failed, using raw", error?.message || String(error));
        return text;
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
    const cleanerProvider = resolveCleanerProvider(settings);
    const checks = [];

    checks.push({
      name: "语音识别",
      ok: Boolean(resolveApiKey()),
      detail: `${asrProvider.id} · ${resolveBaseUrl()}`
    });

    checks.push({
      name: "文本清理",
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
      if (settings.cleanerProvider === "openai-compatible") {
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
    return cleanerProviders[settings.cleanerProvider] || cleanerProviders.mimo;
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
    return settings.asrApiKey || process.env.QWEN_ASR_API_KEY || process.env.DASHSCOPE_API_KEY || "";
  }

  function resolveQwenAsrBaseUrl() {
    const settings = readSettings();
    return normalizeBaseUrl(settings.asrBaseUrl || process.env.QWEN_ASR_BASE_URL || process.env.DASHSCOPE_BASE_URL, QWEN_ASR_OPENAI_BASE_URL);
  }

  function resolveQwenAsrModel() {
    return normalizeQwenAsrModel(readSettings().asrModel);
  }

  function resolveFunAsrBaseUrl() {
    const settings = readSettings();
    return normalizeBaseUrl(settings.asrBaseUrl || process.env.FUN_ASR_BASE_URL || process.env.DASHSCOPE_BASE_URL, FUN_ASR_REST_BASE_URL);
  }

  function resolveFunAsrModel() {
    return normalizeFunAsrModel(readSettings().asrModel);
  }

  function resolveFunAsrRealtimeModel() {
    return readSettings().asrRealtimeModel || "fun-asr-realtime";
  }

  function resolveCleanerApiKey() {
    const settings = readSettings();
    return settings.cleanerApiKey || process.env.CLEANER_API_KEY || "";
  }

  function resolveCleanerBaseUrl() {
    const settings = readSettings();
    return normalizeBaseUrl(settings.cleanerBaseUrl || process.env.CLEANER_BASE_URL, "https://api.openai.com/v1");
  }

  function resolveActiveCleanerBaseUrl(settings) {
    return settings.cleanerProvider === "openai-compatible"
      ? resolveCleanerBaseUrl()
      : mimoCleanerClient.resolveBaseUrl(mimoCleanerClient.resolveApiKey());
  }

  function resolveCleanerModel() {
    return readSettings().cleanerModel || "gpt-5.4-mini";
  }

  async function withSettingsSnapshot(settingsSnapshot, action) {
    if (!settingsSnapshot) return action();
    const previous = overrideSettings;
    overrideSettings = settingsSnapshot;
    try {
      return await action();
    } finally {
      overrideSettings = previous;
    }
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
