"use strict";

const { randomBytes } = require("node:crypto");
const WebSocket = require("ws");

// Cached official guide: output/docs/aliyun-realtime.html (__ICE_PAGE_PROPS__).
// Qwen3-ASR-Flash-Realtime uses /realtime, not this run-task protocol.
const ALI_MEETING_MODELS = Object.freeze([
  "qwen-audio-3.0-asr-flash-streaming",
  "fun-asr-realtime"
]);
const ALI_MEETING_WS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";

function isSupportedAliMeetingModel(model) {
  // Dated releases use the same run-task protocol. Availability is regional and
  // remains a server decision; never silently substitute a different model.
  return typeof model === "string" && model === model.trim() &&
    /^(?:qwen-audio-3\.0-asr-flash-streaming|fun-asr-realtime)(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
}

function streamError(code) {
  // Never attach server messages, close reasons, URLs, credentials or causes.
  const error = new Error(`Ali meeting stream: ${code}.`);
  error.code = code;
  return error;
}

function resolveAliMeetingUrl(baseUrl = ALI_MEETING_WS_URL) {
  let url;
  try {
    if (typeof baseUrl !== "string" || !baseUrl.trim()) throw new Error();
    url = new URL(baseUrl);
  } catch {
    throw streamError("invalid_url");
  }
  if (!["https:", "wss:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw streamError("insecure_url");
  }
  for (const key of url.searchParams.keys()) {
    if (/key|token|secret|password|authorization|credential|signature/i.test(key)) {
      throw streamError("credentials_in_url");
    }
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (/\/api-ws\/v1\/realtime$/i.test(path)) throw streamError("unsupported_protocol");
  // Rewrite only familiar REST base paths, preserving host, port and query.
  // Explicit proxy/workspace endpoint paths are otherwise left intact.
  if (["", "/api/v1", "/compatible-mode/v1"].includes(path)) {
    url.pathname = "/api-ws/v1/inference";
  }
  url.protocol = "wss:";
  return url.href;
}

function observed(promise) {
  promise.catch(() => {});
  return promise;
}

function deferred() {
  let resolve;
  let reject;
  const promise = observed(new Promise((yes, no) => { resolve = yes; reject = no; }));
  return { promise, resolve, reject };
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
}

/**
 * One connection/task, mono PCM16LE, no audio history or transcript cleanup.
 * Await each appendPcm before reusing its Buffer or submitting the next chunk.
 * Chunks are at most 100ms; pacing and durable recording/retries belong to caller.
 * close/abort cancel; only finish waits for the server's task-finished receipt.
 * Sentence timestamps are milliseconds into this connection's submitted audio.
 */
function createAliMeetingStream({
  apiKey,
  baseUrl,
  model = ALI_MEETING_MODELS[0],
  onSentence,
  onError,
  WebSocketImpl = WebSocket,
  sampleRate = 16000,
  readyTimeoutMs = 15000,
  sendTimeoutMs = 10000,
  finishTimeoutMs = 15000,
  closeTimeoutMs = 1000,
  maxBufferedBytes = 65536,
  backpressurePollMs = 10,
  signal
} = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim() || /[\r\n]/.test(apiKey)) {
    throw streamError("invalid_api_key");
  }
  if (!isSupportedAliMeetingModel(model)) throw streamError("unsupported_model");
  if (![8000, 16000].includes(sampleRate)) throw streamError("invalid_sample_rate");
  const maxChunkBytes = sampleRate / 10 * 2;
  if (![readyTimeoutMs, sendTimeoutMs, finishTimeoutMs, closeTimeoutMs,
    maxBufferedBytes, backpressurePollMs].every(positiveInteger) || maxBufferedBytes < maxChunkBytes) {
    throw streamError("invalid_limits");
  }
  if ((onSentence != null && typeof onSentence !== "function") ||
      (onError != null && typeof onError !== "function") ||
      (signal != null && (typeof signal.addEventListener !== "function" ||
        typeof signal.removeEventListener !== "function"))) {
    throw streamError("invalid_callback_or_signal");
  }
  const url = resolveAliMeetingUrl(baseUrl);
  const taskId = randomBytes(16).toString("hex");
  const readyState = deferred();
  const completed = deferred();
  const pendingSends = new Set();
  let socket;
  let state = "connecting";
  let failure;
  let runSent = false;
  let finishSent = false;
  let accepting = true;
  let activeAppend;
  let finishPromise;
  let shutdown;
  let finishTimer;
  let previousSentence;
  const readyTimer = setTimeout(() => fail("ready_timeout"), readyTimeoutMs);

  function notifyError(error) {
    try { observed(Promise.resolve(onError?.(error))); } catch { /* Observer only. */ }
  }

  function detachSignal() {
    signal?.removeEventListener("abort", abort);
  }

  function stopSocket() {
    if (shutdown) return shutdown.promise;
    shutdown = deferred();
    clearTimeout(readyTimer);
    clearTimeout(finishTimer);
    detachSignal();
    for (const cancel of [...pendingSends]) cancel(failure || streamError("closed"));
    if (!socket || socket.readyState === 3) {
      shutdown.resolve();
      return shutdown.promise;
    }
    // Install completion and deadline before close(), which may emit synchronously.
    const timer = setTimeout(() => {
      try { socket.terminate(); } catch { /* Bounded best effort. */ }
      settle();
    }, closeTimeoutMs);
    function settle() {
      clearTimeout(timer);
      socket.removeListener("close", settle);
      socket.removeListener("open", handleOpen);
      socket.removeListener("message", handleMessage);
      shutdown.resolve();
    }
    socket.once("close", settle);
    try {
      if (socket.readyState === 0) socket.terminate();
      else socket.close(1000);
    } catch {
      try { socket.terminate(); } catch { /* Deadline still settles. */ }
    }
    return shutdown.promise;
  }

  function fail(code) {
    if (failure || state === "finished") return;
    failure = streamError(code);
    state = "failed";
    accepting = false;
    readyState.reject(failure);
    completed.reject(failure);
    stopSocket();
    notifyError(failure);
  }

  function send(data, binary, beforeSend = () => {}) {
    return observed(new Promise((resolve, reject) => {
      let settled = false;
      let poll;
      const deadline = setTimeout(() => {
        fail("send_timeout");
        settle(failure || streamError("send_timeout"));
      }, sendTimeoutMs);
      const bytes = binary ? data.length : Buffer.byteLength(data);
      function settle(error) {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearTimeout(poll);
        pendingSends.delete(settle);
        if (error) reject(error);
        else resolve();
      }
      function attempt() {
        if (failure) return settle(failure);
        if (!socket || socket.readyState !== 1) {
          fail("disconnected");
          return settle(failure || streamError("closed"));
        }
        if (socket.bufferedAmount + bytes > maxBufferedBytes) {
          poll = setTimeout(attempt, backpressurePollMs);
          return;
        }
        try {
          beforeSend();
          socket.send(data, { binary }, error => {
            if (settled) return;
            if (error) {
              fail("send_failed");
              settle(failure || streamError("send_failed"));
            } else settle();
          });
        } catch {
          fail("send_failed");
          settle(failure || streamError("send_failed"));
        }
      }
      pendingSends.add(settle);
      attempt();
    }));
  }

  function control(action, payload, beforeSend) {
    return send(JSON.stringify({
      header: { action, task_id: taskId, streaming: "duplex" }, payload
    }), false, beforeSend);
  }

  function handleOpen() {
    if (state !== "connecting" || failure || runSent) return;
    observed(control("run-task", {
      task_group: "audio", task: "asr", function: "recognition", model,
      parameters: { format: "pcm", sample_rate: sampleRate }, input: {}
    }, () => { runSent = true; }));
  }

  function sentenceEvent(sentence) {
    if (sentence?.heartbeat) return;
    if (!sentence || typeof sentence.text !== "string" || typeof sentence.sentence_end !== "boolean") {
      return fail("invalid_sentence");
    }
    const beginMs = sentence.begin_time;
    const endMs = sentence.end_time ?? null;
    const utterance = sentence.utterance_id ?? sentence.sentence_id;
    const hasUtterance = (typeof utterance === "string" && utterance.length > 0) ||
      (typeof utterance === "number" && Number.isSafeInteger(utterance));
    if ((beginMs != null && (!Number.isFinite(beginMs) || beginMs < 0)) ||
        (endMs != null && (!Number.isFinite(endMs) || endMs < 0 || (beginMs != null && endMs < beginMs))) ||
        (beginMs == null && !hasUtterance)) return fail("invalid_sentence");
    let id = `${taskId}:${hasUtterance ? `utterance:${utterance}` : `time:${beginMs}`}`;
    // Keep the same identity when an ID first appears on the final, including
    // retransmitted finals. No comparison or deduplication of text is involved.
    if (previousSentence &&
        ((hasUtterance && utterance === previousSentence.utterance) ||
         (beginMs != null && beginMs === previousSentence.beginMs &&
          (!hasUtterance || previousSentence.utterance == null)))) {
      id = previousSentence.id;
    }
    previousSentence = { id, beginMs, utterance, final: sentence.sentence_end };
    try {
      const result = onSentence?.({ id, text: sentence.text, beginMs: beginMs ?? null,
        endMs, final: sentence.sentence_end });
      observed(Promise.resolve(result).catch(() => fail("sentence_callback_failed")));
    } catch { fail("sentence_callback_failed"); }
  }

  function handleMessage(data, isBinary) {
    if (failure || state === "finished" || isBinary) return;
    let event;
    try {
      // ws emits text as Buffer too; isBinary is the frame-type discriminator.
      const raw = Array.isArray(data) ? Buffer.concat(data) :
        data instanceof ArrayBuffer ? Buffer.from(data) : data;
      event = JSON.parse(String(raw));
    } catch { return fail("invalid_message"); }
    const header = event?.header;
    if (!header || typeof header.event !== "string" || header.task_id !== taskId) {
      return fail("invalid_task_event");
    }
    switch (header.event) {
      case "task-started":
        if (!runSent || state !== "connecting") return fail("unexpected_task_started");
        state = "ready";
        clearTimeout(readyTimer);
        readyState.resolve();
        break;
      case "result-generated":
        if (state !== "ready") return fail("unexpected_result");
        sentenceEvent(event.payload?.output?.sentence);
        break;
      case "task-failed":
        fail("task_failed");
        break;
      case "task-finished":
        if (!finishSent) return fail("unexpected_task_finished");
        state = "finished";
        clearTimeout(finishTimer);
        completed.resolve();
        break;
      default:
        break;
    }
  }

  function appendPcm(chunk) {
    if (failure) return observed(Promise.reject(failure));
    if (!accepting) return observed(Promise.reject(streamError("not_accepting_audio")));
    if (!Buffer.isBuffer(chunk) || chunk.length === 0 || chunk.length % 2 || chunk.length > maxChunkBytes) {
      return observed(Promise.reject(streamError("invalid_pcm_chunk")));
    }
    if (activeAppend) return observed(Promise.reject(streamError("append_in_progress")));
    activeAppend = observed((async () => {
      await readyState.promise;
      if (failure) throw failure;
      await send(chunk, true);
    })().finally(() => { activeAppend = null; }));
    return activeAppend;
  }

  function finish() {
    if (finishPromise) return finishPromise;
    accepting = false;
    if (failure) return observed(Promise.reject(failure));
    // Register the receipt promise and deadline before sending finish-task.
    finishTimer = setTimeout(() => fail("finish_timeout"), finishTimeoutMs);
    finishPromise = observed((async () => {
      await readyState.promise;
      if (activeAppend) await activeAppend;
      if (failure) throw failure;
      const sent = control("finish-task", { input: {} }, () => { finishSent = true; });
      // A final receipt can arrive before the send callback (even synchronously).
      await Promise.race([sent, completed.promise]);
      await completed.promise;
      await stopSocket();
    })());
    return finishPromise;
  }

  function close() {
    fail("closed");
    return stopSocket();
  }

  function abort() {
    fail("aborted");
    return stopSocket();
  }

  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener("abort", abort, { once: true });
    try {
      socket = new WebSocketImpl(url, {
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
        followRedirects: false,
        handshakeTimeout: readyTimeoutMs,
        perMessageDeflate: false,
        maxPayload: 1024 * 1024
      });
      socket.on("open", handleOpen);
      socket.on("message", handleMessage);
      socket.on("error", () => fail("connection_failed"));
      socket.on("close", () => {
        if (state !== "finished" && !failure) fail("disconnected");
      });
    } catch { fail("connection_failed"); }
  }

  return { ready: readyState.promise, appendPcm, finish, close, abort, model, taskId };
}

module.exports = { createAliMeetingStream, resolveAliMeetingUrl, isSupportedAliMeetingModel,
  ALI_MEETING_MODELS, ALI_MEETING_WS_URL };
