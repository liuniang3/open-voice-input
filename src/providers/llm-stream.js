"use strict";

// Chunks can split UTF-8, CRLF or SSE data fields. Only event buffers and the
// selected choice are retained, rather than the entire HTTP response body.
function streamFault(code) { return Object.assign(new Error(code), { code }); }

function modelStreamError(event) {
  const details = event?.response?.error || event?.error || event || {};
  const kind = String(details.code || details.type || "").toLowerCase();
  if (["context_length_exceeded", "context_window_exceeded", "request_too_large"].includes(kind)) {
    return streamFault("request_context_limit");
  }
  const knownStatus = { rate_limit_exceeded: 429, rate_limit_error: 429, too_many_requests: 429,
    server_error: 500, internal_server_error: 500, overloaded_error: 503, service_unavailable: 503,
    timeout: 408, request_timeout: 408, invalid_api_key: 401, authentication_error: 401,
    permission_denied: 403, permission_error: 403 };
  const reported = Number(details.status_code ?? details.status ?? event?.status_code);
  const status = knownStatus[kind] || (Number.isInteger(reported) && reported >= 400 && reported <= 599 ? reported : null);
  return status ? Object.assign(streamFault("http_error"), { status }) : streamFault("response_failed");
}

function createSseDecoder(onEvent, maxEventChars = 8 * 1024 * 1024) {
  const decoder = new TextDecoder();
  let pending = "", lines = [], size = 0;
  function flush() {
    if (lines.length) {
      const payload = lines.join("\n");
      if (payload.trim() === "[DONE]") onEvent(null, true);
      else {
        let value;
        try { value = JSON.parse(payload); }
        catch {
          // Compatibility with gateways missing blank lines between events.
          let values;
          try { values = lines.map(line => JSON.parse(line)); }
          catch { throw streamFault("stream_invalid_json"); }
          for (const value of values) onEvent(value, false);
          lines = []; size = 0; return;
        }
        onEvent(value, false);
      }
    }
    lines = []; size = 0;
  }
  function line(value) {
    if (!value) return flush();
    if (!value.startsWith("data:")) return;
    lines.push(value.slice(5).replace(/^ /, ""));
    size += value.length;
    if (size > maxEventChars) throw streamFault("stream_size_limit");
  }
  function consume(final = false) {
    let position;
    while ((position = pending.indexOf("\n")) >= 0) {
      const value = pending.slice(0, position).replace(/\r$/, "");
      pending = pending.slice(position + 1);
      line(value);
    }
    if (pending.length + size > maxEventChars) throw streamFault("stream_size_limit");
    if (final) { if (pending) line(pending.replace(/\r$/, "")); pending = ""; flush(); }
  }
  return {
    push(bytes) { pending += decoder.decode(bytes, { stream: true }); consume(); },
    finish() { pending += decoder.decode(); consume(true); }
  };
}

function createStreamAccumulator(style, { onProgress, maxChars = 8 * 1024 * 1024 } = {}) {
  let content = "", reasoning = "", finishReason = null, terminal = false, completed = null;
  let seen = false;
  function notify(stage) { onProgress?.({ stage, outputChars: content.length, reasoningChars: reasoning.length }); }
  function append(text, thinking = false) {
    if (thinking) reasoning += String(text || ""); else content += String(text || "");
    if (content.length + reasoning.length > maxChars) throw streamFault("stream_size_limit");
    notify(thinking ? "thinking" : "receiving");
  }
  function accept(event, done) {
    if (terminal) return;
    if (done) { if (style !== "responses") terminal = true; return; }
    seen = true;
    if (event?.error || ["error", "response.failed"].includes(event?.type)) throw modelStreamError(event);
    if (style === "responses") {
      const type = String(event?.type || "");
      if (type === "response.incomplete") {
        throw streamFault(event.response?.incomplete_details?.reason === "max_output_tokens"
          ? "response_output_limit" : "response_incomplete");
      }
      if (type === "response.output_text.delta") append(event.delta);
      else if (/^response\.reasoning.*\.delta$/.test(type)) append(event.delta, true);
      else if (type === "response.completed") { completed = event.response; terminal = true; }
      else notify("thinking");
      return;
    }
    const choices = Array.isArray(event?.choices) ? event.choices : [];
    const choice = choices.find(item => item?.index === 0) || choices.find(item => item?.index == null);
    if (!choice) return;
    const delta = choice.delta || choice.message || {};
    if (delta.content) append(delta.content);
    if (delta.reasoning_content) append(delta.reasoning_content, true);
    if (choice.finish_reason != null) { finishReason = choice.finish_reason; terminal = true; }
    if (finishReason && finishReason !== "stop") throw streamFault(finishReason === "length" ? "response_output_limit" : "response_failed");
  }
  function result(parseCompletedResponse) {
    if (!seen || !terminal) throw streamFault("response_incomplete");
    if (style === "responses") {
      if (!completed) throw streamFault("response_incomplete");
      const parsed = parseCompletedResponse(completed);
      if (!parsed.message.content) parsed.message.content = content;
      if (!parsed.message.reasoning_content) parsed.message.reasoning_content = reasoning;
      return parsed;
    }
    return { body: { choices: [{ message: { content }, finish_reason: finishReason }] }, finishReason, completed: true,
      message: { content, reasoning_content: reasoning } };
  }
  return { accept, result, get terminal() { return terminal; } };
}

module.exports = { createSseDecoder, createStreamAccumulator, modelStreamError };
