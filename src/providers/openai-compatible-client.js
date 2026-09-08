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
    const resolvedApiKey = resolveApiKey();
    if (!resolvedApiKey) {
      throw new Error("OpenAI-compatible API key is not configured.");
    }

    if (signal?.aborted) {
      const err = new Error("aborted");
      err.code = "aborted";
      throw err;
    }

    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => controller.abort();
    if (signal) {
      signal.addEventListener("abort", onCallerAbort, { once: true });
    }
    const limit = resolveRequestTimeoutMs();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, limit);

    const headers = {
      "Content-Type": "application/json"
    };
    headers[headerName] = `${headerValuePrefix}${resolvedApiKey}`;

    try {
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

      const bodyText = await response.text();
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
        body: parsed.body
      };
    } catch (error) {
      if (signal?.aborted && !timedOut) {
        const err = new Error("aborted");
        err.code = "aborted";
        throw err;
      }
      if (error?.name === "AbortError" || error?.code === "ABORT_ERR") {
        if (timedOut) {
          const err = new Error(`OpenAI-compatible request timed out after ${limit} ms.`);
          err.code = "request_timeout";
          throw err;
        }
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
    return {
      body,
      message: body?.choices?.[0]?.message ?? {}
    };
  }

  const chunks = parseServerSentEventChunks(text);
  const contentParts = [];
  const reasoningParts = [];
  let lastBody = null;

  for (const chunk of chunks) {
    lastBody = chunk;
    const choice = chunk?.choices?.[0] ?? {};
    const message = choice.message ?? {};
    const delta = choice.delta ?? {};
    const content = message.content ?? delta.content ?? chunk.output_text ?? "";
    const reasoning = message.reasoning_content ?? delta.reasoning_content ?? "";
    if (content) contentParts.push(String(content));
    if (reasoning) reasoningParts.push(String(reasoning));
  }

  return {
    body: lastBody || { choices: [] },
    message: {
      content: contentParts.join(""),
      reasoning_content: reasoningParts.join("")
    }
  };
}

function parseServerSentEventChunks(text) {
  const chunks = [];
  const events = String(text || "").split(/\r?\n\r?\n/);
  for (const event of events) {
    const dataLines = event
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^data\s*:/i.test(line))
      .map((line) => line.replace(/^data\s*:\s*/i, "").trim())
      .filter(Boolean);
    if (!dataLines.length) continue;

    const standalonePayloads = dataLines.filter((line) => line === "[DONE]" || looksLikeJsonPayload(line));
    if (standalonePayloads.length === dataLines.length) {
      for (const payload of standalonePayloads) {
        if (payload !== "[DONE]") chunks.push(JSON.parse(payload));
      }
      continue;
    }

    const payload = dataLines.join("\n").trim();
    if (!payload || payload === "[DONE]") continue;
    chunks.push(JSON.parse(payload));
  }
  return chunks;
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
