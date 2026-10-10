const { normalizeApiStyle } = require("../settings/provider-connections");
const { createSseDecoder, createStreamAccumulator, modelStreamError } = require("./llm-stream");
const { abortError, abortable, retryAfterMs, withRetries } = require("./request-retry");

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
  apiStyle = "chat-completions",
  requestTimeoutMs = 60000,
  headerName = "Authorization",
  headerValuePrefix = "Bearer ",
  extraHeaders = null,
  fetchImpl = null,
  sleepImpl,
  random
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

  function resolveApiStyle() {
    return normalizeApiStyle(resolveMaybeFunction(apiStyle));
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
  async function requestChat(messages, {
    extraBody = {},
    maxTokens = 1024,
    includeSampling = true,
    signal = null,
    requestHeaders = null,
    stream = false,
    onProgress = null,
    maxRetries = 5,
    idleTimeoutMs,
    progressTimeoutMs
  } = {}) {
    if (stream) {
      return withRetries(attempt => requestStream(messages, {
        extraBody, maxTokens, includeSampling, signal, requestHeaders, onProgress, attempt, idleTimeoutMs, progressTimeoutMs
      }), { signal, maxRetries, sleepImpl, random, onRetry: value => notify(onProgress, { stage: "retrying", ...value }) });
    }
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

    const configuredHeaders = resolveMaybeFunction(extraHeaders);
    const headers = {
      "Content-Type": "application/json",
      ...(configuredHeaders && typeof configuredHeaders === "object" ? configuredHeaders : {}),
      ...(requestHeaders && typeof requestHeaders === "object" ? requestHeaders : {})
    };
    headers[headerName] = `${headerValuePrefix}${resolvedApiKey}`;

    try {
      controller.signal.throwIfAborted();
      const style = resolveApiStyle();
      const endpoint = style === "responses" ? "responses" : "chat/completions";
      const response = await fetchFn(`${resolveBaseUrl()}/${endpoint}`, {
        method: "POST",
        signal: controller.signal,
        headers,
        body: JSON.stringify(style === "responses"
          ? buildResponsesRequest(resolveModel(), messages, maxTokens, extraBody)
          : {
              model: resolveModel(),
              messages,
              ...(maxTokens == null ? {} : { max_completion_tokens: maxTokens }),
              ...(includeSampling ? { temperature: 0, top_p: 0.1 } : {}),
              stream: false,
              ...extraBody
            })
      });

      controller.signal.throwIfAborted();
      const bodyText = await response.text();
      controller.signal.throwIfAborted();
      if (!response.ok) {
        throw new Error(`OpenAI-compatible API ${response.status} at ${resolveBaseUrl()}.`);
      }

      const parsed = style === "responses"
        ? parseResponsesBody(bodyText)
        : parseChatCompletionBody(bodyText);
      const message = parsed.message;
      return {
        content: String(message.content || "").trim(),
        reasoningContent: String(message.reasoning_content || "").trim(),
        finishReason: parsed.finishReason,
        completed: parsed.completed || parsed.finishReason === "stop",
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

  function notify(observer, value) {
    try { observer?.(value); } catch { /* Progress observers cannot break a request. */ }
  }

  async function requestStream(messages, options) {
    const { signal, onProgress, attempt, extraBody, maxTokens, requestHeaders } = options;
    const key = resolveApiKey();
    if (!key) throw Object.assign(new Error("OpenAI-compatible API key is not configured."), { code: "credentials_missing" });
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const limit = resolveRequestTimeoutMs();
    const idleLimit = Number(options.idleTimeoutMs) > 0 ? Number(options.idleTimeoutMs) : Math.max(300000, limit);
    const progressLimit = Number(options.progressTimeoutMs) > 0 ? Number(options.progressTimeoutMs) : limit;
    let deadline, warning, timeoutCode, reader;
    let outputChars = 0, reasoningChars = 0;
    function progress(value) {
      outputChars = value.outputChars ?? outputChars;
      reasoningChars = value.reasoningChars ?? reasoningChars;
      notify(onProgress, { attempt, outputChars, reasoningChars, ...value });
    }
    function armDeadline(code, milliseconds) {
      clearTimeout(deadline);
      deadline = setTimeout(() => { timeoutCode = code; controller.abort(); }, milliseconds);
    }
    function armWarning() {
      clearTimeout(warning);
      warning = setTimeout(() => progress({ stage: "waiting" }), progressLimit);
    }
    try {
      if (controller.signal.aborted) throw abortError();
      progress({ stage: "connecting" });
      armDeadline("connection_timeout", limit);
      const style = resolveApiStyle();
      const headers = { "Content-Type": "application/json", Accept: "text/event-stream",
        ...(resolveMaybeFunction(extraHeaders) || {}), ...(requestHeaders || {}) };
      headers[headerName] = `${headerValuePrefix}${key}`;
      const body = style === "responses"
        ? buildResponsesRequest(resolveModel(), messages, maxTokens, { ...extraBody, stream: true })
        : { model: resolveModel(), messages,
            ...(maxTokens == null ? {} : { max_completion_tokens: maxTokens }),
            ...extraBody, stream: true };
      const response = await abortable(fetchFn(`${resolveBaseUrl()}/${style === "responses" ? "responses" : "chat/completions"}`, {
        method: "POST", headers, body: JSON.stringify(body), signal: controller.signal
      }), controller.signal);
      armDeadline("stream_idle_timeout", idleLimit);
      armWarning();
      progress({ stage: "thinking" });
      if (!response.ok) {
        // Classify locally, but never expose the gateway's body or echo it to logs.
        let details = "";
        if (response.status === 400 || response.status === 413) {
          details = String(await abortable(response.text(), controller.signal)).slice(0, 64000);
        }
        const code = /context.{0,30}(length|window|limit)|maximum.{0,30}tokens|too many tokens/i.test(details)
          ? "request_context_limit" : "http_error";
        throw Object.assign(new Error(`Model API returned HTTP ${response.status}.`), {
          code, status: response.status, retryAfterMs: retryAfterMs(response.headers)
        });
      }
      const accumulator = createStreamAccumulator(style, { onProgress: value => { armWarning(); progress(value); } });
      const parser = createSseDecoder((event, done) => accumulator.accept(event, done));
      let parsed;
      if (response.body?.getReader) {
        reader = response.body.getReader();
        let mode = /text\/event-stream/i.test(response.headers?.get?.("content-type") || "") ? "sse" : "";
        let prefix = Buffer.alloc(0), json = "";
        const decoder = new TextDecoder();
        for (;;) {
          const chunk = await abortable(reader.read(), controller.signal);
          if (chunk.done) break;
          if (!chunk.value?.length) continue;
          armDeadline("stream_idle_timeout", idleLimit);
          if (!mode) {
            prefix = Buffer.concat([prefix, Buffer.from(chunk.value)]);
            const start = prefix.toString("utf8").trimStart();
            if (!start) { if (prefix.length > 8192) throw Object.assign(new Error("Invalid stream"), { code: "stream_invalid_json" }); continue; }
            if (/^[{[]/.test(start)) mode = "json";
            else if (/^(?:data:|event:|:)/.test(start)) mode = "sse";
            else if (prefix.length < 16) continue;
            else throw Object.assign(new Error("Invalid stream"), { code: "stream_invalid_json" });
            if (mode === "sse") parser.push(prefix); else json += decoder.decode(prefix, { stream: true });
            prefix = Buffer.alloc(0);
          } else if (mode === "sse") parser.push(chunk.value);
          else json += decoder.decode(chunk.value, { stream: true });
          if (json.length > 8 * 1024 * 1024) throw Object.assign(new Error("Response exceeds local limit"), { code: "stream_size_limit" });
          if (mode === "sse" && accumulator.terminal) break;
        }
        if (mode === "sse") { parser.finish(); parsed = accumulator.result(parseCompletedResponse); }
        else {
          json += decoder.decode();
          parsed = style === "responses" ? parseResponsesBody(json) : parseChatCompletionBody(json);
        }
      } else {
        // Mock/legacy fetch implementations, and gateways ignoring stream:true.
        const text = await abortable(response.text(), controller.signal);
        parsed = style === "responses" ? parseResponsesBody(text) : parseChatCompletionBody(text);
      }
      if (parsed.finishReason && parsed.finishReason !== "stop") {
        throw Object.assign(new Error("Model output was not complete"), {
          code: parsed.finishReason === "length" ? "response_output_limit" : "response_failed"
        });
      }
      if (style !== "responses" && !parsed.finishReason && !parsed.completed) {
        throw Object.assign(new Error("Model response ended before completion."), { code: "response_incomplete" });
      }
      progress({ stage: "validating", outputChars: String(parsed.message.content || "").length });
      return { content: String(parsed.message.content || "").trim(), reasoningContent: String(parsed.message.reasoning_content || "").trim(),
        finishReason: parsed.finishReason, completed: true, body: parsed.body };
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (timeoutCode) throw Object.assign(new Error(timeoutCode), { code: timeoutCode });
      if (error instanceof SyntaxError) {
        throw Object.assign(new Error("Model response was not valid JSON."), { code: "stream_invalid_json" });
      }
      if (error instanceof TypeError || ["ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(error?.code)) {
        throw Object.assign(new Error("Model network connection interrupted."), { code: "network_error" });
      }
      throw error;
    } finally {
      clearTimeout(deadline); clearTimeout(warning);
      signal?.removeEventListener("abort", abort);
      // Completion can precede HTTP EOF. Release the body without waiting for it.
      if (reader) Promise.resolve(reader.cancel()).catch(() => {});
      controller.abort();
    }
  }

  return {
    requestChat,
    resolveApiKey,
    resolveApiStyle,
    resolveModel,
    resolveBaseUrl
  };
}

function buildResponsesRequest(model, messages, maxTokens, extraBody) {
  const extras = { ...(extraBody && typeof extraBody === "object" ? extraBody : {}) };
  const reasoningEffort = extras.reasoning_effort;
  delete extras.reasoning_effort;
  if (reasoningEffort && !extras.reasoning) extras.reasoning = { effort: reasoningEffort };
  return {
    model,
    input: Array.isArray(messages) ? messages : [],
    ...(maxTokens == null ? {} : { max_output_tokens: maxTokens }),
    stream: false,
    ...extras
  };
}

function parseResponsesBody(bodyText) {
  const text = String(bodyText || "").trim();
  if (!text) throw new SyntaxError("Empty OpenAI Responses API response body.");
  if (!/^data\s*:/im.test(text)) return parseCompletedResponse(JSON.parse(text));

  const { chunks } = parseServerSentEvents(text);
  const deltas = [];
  let completedResponse = null;
  for (const chunk of chunks) {
    const type = String(chunk?.type || "");
    if (chunk?.error || ["response.failed", "error"].includes(type)) throw modelStreamError(chunk);
    if (type === "response.incomplete") throw Object.assign(new Error("Model response ended before completion."), {
      code: chunk.response?.incomplete_details?.reason === "max_output_tokens" ? "response_output_limit" : "response_incomplete"
    });
    if (type === "response.output_text.delta" && chunk.delta != null) deltas.push(String(chunk.delta));
    if (type === "response.completed") { completedResponse = chunk.response || chunk; break; }
  }
  if (!completedResponse) {
    throw Object.assign(new Error("Model response ended before completion."), { code: "response_incomplete" });
  }
  const parsed = parseCompletedResponse(completedResponse);
  if (!parsed.message.content && deltas.length) parsed.message.content = deltas.join("").trim();
  return parsed;
}

function parseCompletedResponse(body) {
  if (body?.error) {
    throw modelStreamError(body);
  }
  const status = String(body?.status || "").toLowerCase();
  if (status !== "completed") {
    throw Object.assign(new Error("Model response ended before completion."), {
      code: body?.incomplete_details?.reason === "max_output_tokens" ? "response_output_limit"
        : status === "failed" ? "response_failed" : "response_incomplete"
    });
  }
  const contentParts = [];
  const reasoningParts = [];
  if (typeof body.output_text === "string") contentParts.push(body.output_text);
  for (const item of typeof body.output_text === "string" ? [] : (Array.isArray(body?.output) ? body.output : [])) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === "output_text" && content.text != null) contentParts.push(String(content.text));
      if (["reasoning_text", "summary_text"].includes(content?.type) && content.text != null) {
        reasoningParts.push(String(content.text));
      }
    }
    for (const summary of Array.isArray(item?.summary) ? item.summary : []) {
      if (summary?.text != null) reasoningParts.push(String(summary.text));
    }
  }
  return {
    body,
    finishReason: "stop",
    message: {
      content: contentParts.join("").trim(),
      reasoning_content: reasoningParts.join("\n").trim()
    }
  };
}

function parseChatCompletionBody(bodyText) {
  const text = String(bodyText || "").trim();
  if (!text) {
    throw new SyntaxError("Empty OpenAI-compatible response body.");
  }

  if (!/^data\s*:/im.test(text)) {
    const body = JSON.parse(text);
    if (body?.error) throw modelStreamError(body);
    const choice = firstChoice(body);
    return {
      body,
      completed: choice.finish_reason != null,
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
    completed: done || finishReason != null,
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
  buildResponsesRequest,
  normalizeBaseUrl,
  parseChatCompletionBody,
  parseResponsesBody,
  parseServerSentEventChunks
};
