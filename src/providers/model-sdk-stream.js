"use strict";

const OpenAI = require("openai");
const { classifyRequestError } = require("./model-request-error");
const { retryAfterMs } = require("./request-retry");
const { modelStreamError } = require("./llm-stream");

function sanitizeSdkError(error) {
  if (!(error instanceof OpenAI.APIError)) return error;
  if (error.status) return Object.assign(classifyRequestError(error.error, error.status), { retryAfterMs: retryAfterMs(error.headers) });
  return modelStreamError({ error: error.error || {} });
}

// Retry, idle deadlines and cancellation are owned by the application. The
// SDK handles the wire protocol; all provider error bodies stay in memory.
async function requestSdkStream({ apiKey, baseUrl, style, body, headers, signal, fetchImpl, onBytes }) {
  const sdk = new OpenAI({ apiKey, baseURL: baseUrl, maxRetries: 0, logLevel: "off",
    organization: null, project: null, adminAPIKey: null, webhookSecret: null,
    defaultHeaders: { Authorization: null },
    fetch: async (url, init) => {
      const response = await fetchImpl(String(url), { ...init, headers: Object.fromEntries(new Headers(init.headers)) });
      if (!response.body?.getReader || !response.ok) return response;
      const reader = response.body.getReader();
      let bytes = 0;
      const cancel = () => { reader.cancel().catch(() => {}); };
      signal.addEventListener("abort", cancel, { once: true });
      return new Response(new ReadableStream({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) { signal.removeEventListener("abort", cancel); controller.close(); }
            else {
              bytes += chunk.value?.length || 0;
              if (bytes > 32 * 1024 * 1024) throw Object.assign(new Error("Model stream exceeds local limit."), { code: "stream_size_limit" });
              if (chunk.value?.length) onBytes(); controller.enqueue(chunk.value);
            }
          } catch (error) { signal.removeEventListener("abort", cancel); controller.error(error); }
        },
        cancel(reason) { signal.removeEventListener("abort", cancel); return reader.cancel(reason).catch(() => {}); }
      }), { status: response.status, statusText: response.statusText, headers: response.headers });
    }
  });
  try {
    const request = style === "responses" ? sdk.responses.create(body, { signal, headers })
      : sdk.chat.completions.create(body, { signal, headers });
    const { data, response } = await request.withResponse();
    return { response, events: /text\/event-stream/i.test(response.headers.get("content-type") || "") ? data : null };
  } catch (error) {
    if (error.status) {
      throw sanitizeSdkError(error);
    }
    if (error.cause?.code) throw error.cause;
    if (error instanceof OpenAI.APIConnectionError) {
      throw Object.assign(new Error("Model network connection interrupted."), { code: "network_error" });
    }
    throw error;
  }
}

module.exports = { requestSdkStream, sanitizeSdkError };
