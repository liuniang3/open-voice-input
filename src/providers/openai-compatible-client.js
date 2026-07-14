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
  headerValuePrefix = "Bearer "
}) {
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

  async function requestChat(messages, { extraBody = {}, maxTokens = 1024 } = {}) {
    const resolvedApiKey = resolveApiKey();
    if (!resolvedApiKey) {
      throw new Error("OpenAI-compatible API key is not configured.");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), resolveRequestTimeoutMs());
    const headers = {
      "Content-Type": "application/json"
    };
    headers[headerName] = `${headerValuePrefix}${resolvedApiKey}`;

    try {
      const response = await fetch(`${resolveBaseUrl()}/chat/completions`, {
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
        throw new Error(`OpenAI-compatible API ${response.status} at ${resolveBaseUrl()}: ${bodyText}`);
      }

      const parsed = parseChatCompletionBody(bodyText);
      const message = parsed.message;
      return {
        content: String(message.content || "").trim(),
        reasoningContent: String(message.reasoning_content || "").trim(),
        body: parsed.body
      };
    } finally {
      clearTimeout(timer);
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
