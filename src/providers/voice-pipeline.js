const { cleanTranscript } = require("../transcript-cleaner");
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
  const mimoClient = createMimoClient({ getSettings: readSettings, cleanTranscript });
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
    mimo: createMimoCleanerProvider({ client: mimoClient }),
    "openai-compatible": createOpenAiCompatibleCleanerProvider({
      client: openAiCleanerClient,
      cleanTranscript
    })
  };

  function normalizeTranscriptionMode(mode) {
    return mode === "fast" ? "fast" : "stable";
  }

  async function transcribe({ audioDataUrl, pcm16Base64, shortContext, transcriptionMode, settingsSnapshot }) {
    return withSettingsSnapshot(settingsSnapshot, async () => {
      const settings = readSettings();
      const mode = normalizeTranscriptionMode(transcriptionMode || settings.transcriptionMode);
      const asrProvider = resolveAsrProvider(settings);
      const cleanerProvider = resolveCleanerProvider(settings);
      logEvent?.("voice-pipeline: mode", `${mode} asr=${asrProvider.id}:${asrProvider.kind || "audio-chat"} cleaner=${cleanerProvider.id}`);

      if (mode === "fast") {
        const fastResult = await asrProvider.transcribeFast({ audioDataUrl, pcm16Base64, shortContext });
        return cleanTranscript(fastResult.text);
      }

      const rawResult = await asrProvider.transcribeRaw({ audioDataUrl, pcm16Base64, shortContext });
      const rawTranscript = cleanTranscript(rawResult.text);
      if (!rawTranscript) return "";

      const cleanedResult = await cleanerProvider.clean({ rawText: rawTranscript, shortContext });
      return cleanedResult.text || rawTranscript;
    });
  }

  async function cleanText({ rawText, shortContext }) {
    const text = cleanTranscript(rawText);
    if (!text) return "";
    const settings = readSettings();
    const cleanerProvider = resolveCleanerProvider(settings);
    const cleanedResult = await cleanerProvider.clean({ rawText: text, shortContext });
    return cleanedResult.text || text;
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
        : `${cleanerProvider.id} · ${resolveCleanerBaseUrl()}`
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
    } else if (settings.cleanerProvider === "openai-compatible" && settings.transcriptionMode !== "fast") {
      await openAiCleanerClient.requestChat(
        [
          { role: "system", content: "Return exactly {\"text\":\"ok\"}." },
          { role: "user", content: "ok" }
        ],
        { maxTokens: 32 }
      );
    }

    return checks;
  }

  return {
    cleanerProviders,
    asrProviders,
    cleanText,
    normalizeTranscriptionMode,
    normalizeQwenAsrMode,
    resolveApiKey,
    resolveBaseUrl,
    testConnection,
    transcribe
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
    return settings.asrApiKey || process.env.QWEN_ASR_API_KEY || process.env.DASHSCOPE_API_KEY || settings.apiKey || process.env.MIMO_API_KEY || "";
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
    return settings.cleanerApiKey || process.env.CLEANER_API_KEY || settings.apiKey || process.env.MIMO_API_KEY || "";
  }

  function resolveCleanerBaseUrl() {
    const settings = readSettings();
    return normalizeBaseUrl(settings.cleanerBaseUrl || process.env.CLEANER_BASE_URL, "https://api.openai.com/v1");
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
