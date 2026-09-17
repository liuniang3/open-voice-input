function normalizeBaseUrl(url, fallback) {
  const normalized = String(url || fallback || "").replace(/\/+$/, "");
  try {
    const parsed = new URL(normalized);
    if (!parsed.pathname || parsed.pathname === "/") {
      return `${normalized}/v1`;
    }
  } catch {
    return normalized;
  }
  return normalized;
}

function resolveMaybeFunction(value) {
  return typeof value === "function" ? value() : value;
}

function createOpenAiCompatibleClient({
  apiKey,
  baseUrl,
  model,
  requestTimeoutMs = 60000,
  headerName = "Authorization",
  headerValuePrefix = "Bearer ",
  fetchImpl = null
}) {
  const fetchFn = fetchImpl || globalThis.fetch.bind(globalThis);

  function resolveApiKey() {
    return resolveMaybeFunction(apiKey) || "";
  }

  function resolveBaseUrl() {
    return normalizeBaseUrl(resolveMaybeFunction(baseUrl), "https://api.openai.com/v1");
  }

  function resolveModel() {
    return resolveMaybeFunction(model) || "";
  }

  function resolveRequestTimeoutMs() {
    const timeoutMs = Number(resolveMaybeFunction(requestTimeoutMs));
    return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60000;
  }

  /**
   * @param {Array} messages
   * @param {{ extraBody?: object, maxTokens?: number, signal?: AbortSignal }} [options]
   * Caller abort => error.code = "aborted"
   * Internal timer => timeout error (not aborted)
   */
  async function requestChat(messages, { extraBody = {}, maxTokens = 1024, signal = null } = {}) {
    if (signal?.aborted) {
      const err = new Error("aborted");
      err.code = "aborted";
      throw err;
    }

    const resolvedApiKey = resolveApiKey();
    if (!resolvedApiKey) {
      throw new Error("OpenAI-compatible API key is not configured.");
    }

    const limit = resolveRequestTimeoutMs();
    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => controller.abort();
    if (signal) {
      signal.addEventListener("abort", onCallerAbort, { once: true });
      if (signal.aborted) onCallerAbort();
    }
    const timer = setTimeout(() => {
      if (controller.signal.aborted) return;
      timedOut = true;
      controller.abort();
    }, limit);

    const headers = {
      "Content-Type": "application/json"
    };
    headers[headerName] = `${headerValuePrefix}${resolvedApiKey}`;

    try {
      controller.signal.throwIfAborted();
      const response = await fetchFn(`${resolveBaseUrl()}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers,
        body: JSON.stringify({
          model: resolveModel(),
          messages,
          max_completion_tokens: maxTokens,
          temperature: 0,
          top_p: 0.1,
          stream: false,
          ...extraBody
        })
      });

      controller.signal.throwIfAborted();
      const bodyText = await response.text();
      controller.signal.throwIfAborted();
      if (!response.ok) {
        throw new Error(
          `OpenAI-compatible API ${response.status} at ${resolveBaseUrl()}: ${String(bodyText).slice(0, 500)}`
        );
      }

      const parsed = parseChatCompletionBody(bodyText);
      const message = parsed.message;
      return {
        content: String(message.content || "").trim(),
        reasoningContent: String(message.reasoning_content || "").trim(),
        finishReason: parsed.finishReason,
        body: parsed.body
      };
    } catch (error) {
      if (timedOut) {
        const err = new Error(`OpenAI-compatible request timed out after ${limit} ms.`);
        err.code = "request_timeout";
        throw err;
      }
      if (signal?.aborted) {
        const err = new Error("aborted");
        err.code = "aborted";
        throw err;
      }
      if (error?.name === "AbortError" || error?.code === "ABORT_ERR") {
        const err = new Error("aborted");
        err.code = "aborted";
        throw err;
      }
      if (error?.code === "aborted") throw error;
      if (error instanceof TypeError) {
        throw new Error(`OpenAI-compatible network request failed: ${error.cause?.message || error.message}`, {
          cause: error
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onCallerAbort);
    }
  }

  return {
    requestChat,
    resolveApiKey,
    resolveModel,
    resolveBaseUrl
  };
}

function parseChatCompletionBody(bodyText) {
  const text = String(bodyText || "").trim();
  if (!text) {
    throw new SyntaxError("Empty OpenAI-compatible response body.");
  }

  if (!/^data\s*:/im.test(text)) {
    const body = JSON.parse(text);
    const choice = firstChoice(body);
    return {
      body,
      finishReason: choice.finish_reason ?? null,
      message: choice.message ?? {}
    };
  }

  const { chunks, done } = parseServerSentEvents(text);
  const contentParts = [];
  const reasoningParts = [];
  let lastBody = null;
  let finishReason = null;

  for (const chunk of chunks) {
    lastBody = chunk;
    const choice = firstChoice(chunk);
    if (choice.finish_reason != null) finishReason = choice.finish_reason;
    const message = choice.message ?? {};
    const delta = choice.delta ?? {};
    const content = message.content ?? delta.content ?? chunk.output_text ?? "";
    const reasoning = message.reasoning_content ?? delta.reasoning_content ?? "";
    if (content) contentParts.push(String(content));
    if (reasoning) reasoningParts.push(String(reasoning));
  }

  // Graceful HTTP EOF is not evidence that the model completed its response.
  // Legacy compatible servers may send only [DONE], or only finish_reason.
  if (!done && !finishReason) {
    throw Object.assign(new Error("Model response ended before completion."), { code: "response_incomplete" });
  }

  return {
    body: lastBody || { choices: [] },
    finishReason,
    message: {
      content: contentParts.join(""),
      reasoning_content: reasoningParts.join("")
    }
  };
}

function parseServerSentEventChunks(text) {
  return parseServerSentEvents(text).chunks;
}

function firstChoice(body) {
  const choices = Array.isArray(body?.choices) ? body.choices : [];
  return choices.find(choice => choice?.index === 0) ?? choices.find(choice => choice?.index == null) ?? {};
}

function parseServerSentEvents(text) {
  const chunks = [];
  const events = String(text || "").split(/\r?\n\r?\n/);
  for (const event of events) {
    let dataLines = event
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^data\s*:/i.test(line))
      .map((line) => line.replace(/^data\s*:\s*/i, "").trim())
      .filter(Boolean);
    if (!dataLines.length) continue;
    const doneIndex = dataLines.indexOf("[DONE]");
    if (doneIndex !== -1) dataLines = dataLines.slice(0, doneIndex);

    const standalonePayloads = dataLines.filter(looksLikeJsonPayload);
    if (standalonePayloads.length === dataLines.length) {
      for (const payload of standalonePayloads) {
        chunks.push(JSON.parse(payload));
      }
    } else {
      const payload = dataLines.join("\n").trim();
      if (payload) chunks.push(JSON.parse(payload));
    }
    if (doneIndex !== -1) return { chunks, done: true };
  }
  return { chunks, done: false };
}

function looksLikeJsonPayload(value) {
  return /^[{[]/.test(String(value || "").trim());
}

module.exports = {
  createOpenAiCompatibleClient,
  normalizeBaseUrl,
  parseChatCompletionBody,
  parseServerSentEventChunks
};
