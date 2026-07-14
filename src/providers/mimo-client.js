const { parseChatCompletionBody } = require("./openai-compatible-client");

function createMimoClient({ getSettings, cleanTranscript }) {
  function resolveApiKey() {
    const settings = getSettings();
    return settings.apiKey || process.env.MIMO_API_KEY || "";
  }

  function resolveBaseUrl(apiKey) {
    const settings = getSettings();
    const configured = settings.baseUrl || process.env.MIMO_BASE_URL;
    if (configured) {
      const normalized = configured.replace(/\/+$/, "");
      if (!apiKey?.startsWith("tp-") && /token-plan/i.test(normalized)) {
        return "https://api.xiaomimimo.com/v1";
      }
      return normalized;
    }
    if (apiKey?.startsWith("tp-")) {
      return "https://token-plan-cn.xiaomimimo.com/v1";
    }
    return "https://api.xiaomimimo.com/v1";
  }

  async function requestChat(messages, {
    extraBody = {},
    includeSampling = true,
    maxTokens = 1024,
    model,
    stream = false
  } = {}) {
    const settings = getSettings();
    const apiKey = resolveApiKey();
    if (!apiKey) {
      throw new Error("MiMo API key is not configured.");
    }
    const baseUrl = resolveBaseUrl(apiKey);
    const body = {
      model: model || settings.model,
      messages,
      max_completion_tokens: maxTokens,
      stream,
      ...extraBody
    };
    if (includeSampling) {
      body.temperature = 0;
      body.top_p = 0.1;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.requestTimeoutMs);

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "api-key": apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      const bodyText = await response.text();
      if (!response.ok) {
        throw new Error(`MiMo API ${response.status} at ${baseUrl}: ${bodyText}`);
      }

      const { message } = parseChatCompletionBody(bodyText);
      return {
        content: String(message.content || "").trim(),
        reasoningContent: String(message.reasoning_content || "").trim()
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function parseStrictJsonText(value) {
    try {
      const parsed = JSON.parse(String(value || "").trim());
      if (parsed && typeof parsed.text === "string") {
        return cleanTranscript(parsed.text);
      }
    } catch {
      return "";
    }
    return "";
  }

  function responseText(response, { allowReasoningFallback = false } = {}) {
    if (response.content) return response.content;
    return allowReasoningFallback ? response.reasoningContent : "";
  }

  return {
    parseStrictJsonText,
    requestChat,
    resolveApiKey,
    resolveBaseUrl,
    responseText
  };
}

module.exports = { createMimoClient };
