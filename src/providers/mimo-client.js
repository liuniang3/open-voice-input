const { parseChatCompletionBody } = require("./openai-compatible-client");

function createMimoClient({ getSettings, useEnvironmentFallback = true, fetchImpl = null }) {
  function resolveApiKey() {
    const settings = getSettings();
    return settings.apiKey || (useEnvironmentFallback ? process.env.MIMO_API_KEY : "") || "";
  }

  function resolveBaseUrl(apiKey) {
    const settings = getSettings();
    const configured = settings.baseUrl || (useEnvironmentFallback ? process.env.MIMO_BASE_URL : "");
    if (configured) {
      return configured.replace(/\/+$/, "");
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
    stream = false,
    signal = null
  } = {}) {
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { code: "aborted" });
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
    let timedOut = false;
    const onCallerAbort = () => controller.abort();
    if (signal) {
      signal.addEventListener("abort", onCallerAbort, { once: true });
      if (signal.aborted) onCallerAbort();
    }
    const timeoutMs = Number(settings.requestTimeoutMs) > 0 ? Number(settings.requestTimeoutMs) : 60000;
    const timer = setTimeout(() => {
      if (controller.signal.aborted) return;
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      controller.signal.throwIfAborted();
      const response = await (fetchImpl || globalThis.fetch)(`${baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "api-key": apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      controller.signal.throwIfAborted();
      const bodyText = await response.text();
      controller.signal.throwIfAborted();
      if (!response.ok) {
        throw new Error(`MiMo API ${response.status} at ${baseUrl}.`);
      }

      const parsed = parseChatCompletionBody(bodyText);
      const { message } = parsed;
      return {
        content: String(message.content || "").trim(),
        finishReason: parsed.finishReason,
        reasoningContent: String(message.reasoning_content || "").trim()
      };
    } catch (error) {
      if (timedOut) {
        const timeout = new Error(`MiMo request timed out after ${timeoutMs} ms.`);
        timeout.code = "request_timeout";
        throw timeout;
      }
      if (signal?.aborted || error?.name === "AbortError" || error?.code === "ABORT_ERR") {
        const aborted = new Error("aborted");
        aborted.code = "aborted";
        throw aborted;
      }
      if (error instanceof TypeError) {
        throw new Error(`MiMo network request failed: ${error.cause?.message || error.message}`, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onCallerAbort);
    }
  }

  function responseText(response, { allowReasoningFallback = false } = {}) {
    if (response.content) return response.content;
    return allowReasoningFallback ? response.reasoningContent : "";
  }

  return {
    requestChat,
    resolveApiKey,
    resolveBaseUrl,
    responseText
  };
}

module.exports = { createMimoClient };
