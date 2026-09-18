"use strict";

const { createMimoClient } = require("./mimo-client");
const { createOpenAiCompatibleClient } = require("./openai-compatible-client");
const {
  API_STYLES,
  PROVIDER_FAMILIES,
  connectionBaseUrl,
  normalizeProviderConnection
} = require("../settings/provider-connections");

const TEST_AUDIO_URL = "https://dashscope.oss-cn-beijing.aliyuncs.com/audios/welcome.mp3";

function textModelFor(settings, family) {
  const candidates = [settings?.meetingAnalysisModel, settings?.cleanerModel];
  if (family === PROVIDER_FAMILIES.MIMO) {
    return candidates.find(model => /^mimo-/i.test(String(model || "")) && !/-asr(?:-|$)/i.test(model)) || "mimo-v2.5";
  }
  return candidates.find(model => /^(?:gpt|chatgpt|o[134](?:-|$))/i.test(String(model || ""))) || "gpt-5.4-mini";
}

async function testProviderConnection({ settings, provider, fetchImpl = null } = {}) {
  if (!Object.values(PROVIDER_FAMILIES).includes(provider)) {
    throw Object.assign(new Error("不支持的供应商连接。"), { code: "provider_not_supported" });
  }
  const connection = normalizeProviderConnection(provider, settings?.providerConnections?.[provider]);
  if (!connection.apiKey) {
    throw Object.assign(new Error("请先保存该供应商的 API Key。"), { code: "provider_credentials_missing" });
  }

  const startedAt = Date.now();
  if (provider === PROVIDER_FAMILIES.MIMO) {
    const model = textModelFor(settings, provider);
    const client = createMimoClient({
      getSettings: () => ({ ...connection, model, requestTimeoutMs: 30000 }),
      useEnvironmentFallback: false,
      fetchImpl
    });
    await client.requestChat([
      { role: "system", content: "Reply with OK only." },
      { role: "user", content: "OK" }
    ], { maxTokens: 16, includeSampling: false });
  } else if (provider === PROVIDER_FAMILIES.ALIYUN) {
    const client = createOpenAiCompatibleClient({
      apiKey: connection.apiKey,
      baseUrl: connectionBaseUrl(provider, connection, "compatible"),
      model: "qwen3-asr-flash",
      requestTimeoutMs: 30000,
      fetchImpl
    });
    await client.requestChat([
      {
        role: "user",
        content: [{ type: "input_audio", input_audio: { data: TEST_AUDIO_URL } }]
      }
    ], { maxTokens: 32 });
  } else {
    const client = createOpenAiCompatibleClient({
      apiKey: connection.apiKey,
      baseUrl: connection.baseUrl,
      model: textModelFor(settings, provider),
      apiStyle: connection.apiStyle || API_STYLES.RESPONSES,
      requestTimeoutMs: 30000,
      fetchImpl
    });
    await client.requestChat([
      { role: "system", content: "Reply with OK only." },
      { role: "user", content: "OK" }
    ], { maxTokens: 16 });
  }

  return { ok: true, provider, latencyMs: Date.now() - startedAt };
}

module.exports = { testProviderConnection, textModelFor };
