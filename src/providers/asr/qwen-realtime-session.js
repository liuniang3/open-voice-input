const WebSocket = require("ws");
const { cleanTranscript } = require("../../transcript-cleaner");
const { parseServerSentEventChunks } = require("../openai-compatible-client");
const { createAliMeetingStream } = require("./ali-meeting-stream");

const QWEN_REALTIME_MODEL = "qwen-audio-3.0-asr-flash-streaming";
const QWEN_LEGACY_REALTIME_MODEL = "qwen3-asr-flash-realtime";
const QWEN_REALTIME_WS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
const STREAMING_PCM_CHUNK_BYTES = 3200;
const MAX_STREAMING_QUEUE_BYTES = 2 * 1024 * 1024;

function normalizeQwenRealtimeModel(model) {
  const value = String(model || "").trim();
  if (!value || value === "mimo-v2.5" || value === "mimo-v2.5-asr" || value === "qwen3-asr-flash"
    || value === QWEN_LEGACY_REALTIME_MODEL) return QWEN_REALTIME_MODEL;
  return value;
}

function isQwenAudioStreamingModel(model) {
  return typeof model === "string"
    && /^qwen-audio-3\.0-asr-flash-streaming(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
}

function createQwenRealtimeSession(options = {}) {
  const model = normalizeQwenRealtimeModel(options.model);
  if (isQwenAudioStreamingModel(model)) {
    return createQwenAudioStreamingSession({ ...options, model });
  }
  return createQwenLegacyRealtimeSession({ ...options, model });
}

function createQwenAudioStreamingSession({
  apiKey,
  baseUrl,
  model = QWEN_REALTIME_MODEL,
  onPartial,
  onFinal,
  onLog,
  streamFactory = createAliMeetingStream,
  maxQueuedBytes = MAX_STREAMING_QUEUE_BYTES
}) {
  const resolvedApiKey = String(apiKey || "").trim();
  if (!resolvedApiKey) throw new Error("Qwen ASR API Key 未配置。");
  if (!isQwenAudioStreamingModel(model)) throw realtimeError("unsupported_model");
  if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes < STREAMING_PCM_CHUNK_BYTES) {
    throw realtimeError("invalid_queue_limit");
  }

  const sentences = new Map();
  let sequence = 0;
  let accepting = true;
  let queuedBytes = 0;
  let appendFailure = null;
  let appendTail = Promise.resolve();
  let finishPromise = null;

  const stream = streamFactory({
    apiKey: resolvedApiKey,
    baseUrl,
    model,
    onSentence: updateSentence,
    onError: (error) => {
      appendFailure ||= error;
      onLog?.("qwen-audio-streaming: error", String(error?.code || "stream_failed"));
    }
  });

  function updateSentence(sentence) {
    const text = String(sentence?.text || "").trim();
    if (!text) return;
    const id = String(sentence.id || `sentence:${sequence}`);
    const existing = sentences.get(id);
    sentences.set(id, {
      id,
      text,
      final: Boolean(sentence.final),
      order: existing?.order ?? sequence++
    });
    const transcript = currentDisplayText();
    if (sentence.final) onFinal?.(transcript);
    else onPartial?.(transcript);
  }

  function currentDisplayText() {
    return [...sentences.values()]
      .sort((left, right) => left.order - right.order)
      .reduce((text, sentence) => appendStreamingSentence(text, sentence.text), "");
  }

  function appendPcm16Base64(base64Audio) {
    if (!accepting) return Promise.reject(realtimeError("not_accepting_audio"));
    let pcm;
    try {
      const encoded = String(base64Audio || "");
      if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error();
      pcm = Buffer.from(encoded, "base64");
    } catch {
      return Promise.reject(realtimeError("invalid_pcm_chunk"));
    }
    if (!pcm.length || pcm.length % 2) return Promise.reject(realtimeError("invalid_pcm_chunk"));
    if (queuedBytes + pcm.length > maxQueuedBytes) {
      appendFailure ||= realtimeError("audio_queue_overflow");
      return Promise.reject(appendFailure);
    }

    queuedBytes += pcm.length;
    const operation = appendTail.then(async () => {
      if (appendFailure) throw appendFailure;
      await stream.ready;
      for (let offset = 0; offset < pcm.length; offset += STREAMING_PCM_CHUNK_BYTES) {
        await stream.appendPcm(pcm.subarray(offset, Math.min(pcm.length, offset + STREAMING_PCM_CHUNK_BYTES)));
      }
    }).catch((error) => {
      appendFailure ||= error;
      throw error;
    }).finally(() => {
      queuedBytes -= pcm.length;
    });
    appendTail = operation.catch(() => {});
    return operation;
  }

  function finish() {
    if (finishPromise) return finishPromise;
    accepting = false;
    finishPromise = (async () => {
      await appendTail;
      if (appendFailure) throw appendFailure;
      await stream.finish();
      const transcript = currentDisplayText();
      if (transcript) onFinal?.(transcript);
      return transcript;
    })();
    return finishPromise;
  }

  function close() {
    accepting = false;
    return stream.close();
  }

  return {
    appendPcm16Base64,
    close,
    finish,
    ready: stream.ready,
    getText: currentDisplayText,
    model
  };
}

function createQwenLegacyRealtimeSession({
  apiKey,
  model,
  language = "",
  enableItn = false,
  onPartial,
  onFinal,
  onLog
}) {
  const resolvedApiKey = String(apiKey || "").trim();
  if (!resolvedApiKey) {
    throw new Error("Qwen ASR API Key 未配置。");
  }

  const resolvedModel = normalizeQwenRealtimeModel(model);
  const url = `${QWEN_REALTIME_WS_URL}?model=${encodeURIComponent(resolvedModel)}`;
  let socket;
  let opened = false;
  let configured = false;
  let closed = false;
  let committedText = "";
  let livePartialText = "";
  let pendingChunks = [];
  let finalResolver = null;
  let readyResolver = null;

  const ready = new Promise((resolve, reject) => {
    readyResolver = resolve;
    socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${resolvedApiKey}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });

    socket.on("open", () => {
      opened = true;
      onLog?.("qwen-realtime: open", resolvedModel);
      sendJson({
        event_id: makeEventId(),
        type: "session.update",
        session: compactObject({
          modalities: ["text"],
          input_audio_format: "pcm",
          sample_rate: 16000,
          input_audio_transcription: compactObject({
            language,
            corpus: undefined
          }),
          turn_detection: {
            type: "server_vad",
            threshold: 0.0,
            silence_duration_ms: 1200
          }
        })
      });
    });

    socket.on("message", (data) => {
      handleMessage(String(data));
    });

    socket.on("error", (error) => {
      onLog?.("qwen-realtime: error", error.message || String(error));
      if (!configured) reject(error);
    });

    socket.on("close", (code, reason) => {
      closed = true;
      onLog?.("qwen-realtime: close", `${code} ${String(reason || "")}`);
    });
  });

  function sendJson(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }

  function flushPendingChunks() {
    if (!pendingChunks.length) return;
    const chunks = pendingChunks;
    pendingChunks = [];
    for (const chunk of chunks) {
      appendPcm16Base64(chunk);
    }
  }

  function appendPcm16Base64(base64Audio) {
    if (!base64Audio) return;
    if (!configured || !socket || socket.readyState !== WebSocket.OPEN) {
      pendingChunks.push(base64Audio);
      return;
    }
    sendJson({
      event_id: makeEventId(),
      type: "input_audio_buffer.append",
      audio: base64Audio
    });
  }

  function handleMessage(raw) {
    const events = parseRealtimeEvents(raw);
    if (!events.length) {
      return;
    }

    for (const event of events) {
      handleEvent(event, raw);
    }
  }

  function handleEvent(event, raw) {
    if (event.type === "error") {
      const message = event.error?.message || event.message || raw;
      onLog?.("qwen-realtime: server error", message);
      return;
    }

    if (event.type === "session.updated") {
      configured = true;
      onLog?.("qwen-realtime: session updated");
      flushPendingChunks();
      readyResolver?.();
      readyResolver = null;
      return;
    }

    if (event.type === "session.created" || event.type === "input_audio_buffer.speech_started" || event.type === "input_audio_buffer.speech_stopped" || event.type === "input_audio_buffer.committed" || event.type === "session.finished") {
      onLog?.("qwen-realtime: event", event.type);
      if (event.type === "session.finished") finalResolver?.();
    }

    const text = extractTranscriptText(event);
    if (!text) return;

    const cleaned = cleanTranscript(text);
    if (!cleaned) return;

    if (isFinalEvent(event)) {
      commitFinalText(cleaned);
      onFinal?.(currentDisplayText());
    } else if (cleaned !== livePartialText) {
      livePartialText = cleaned;
      onPartial?.(currentDisplayText());
    }
  }

  async function finish() {
    await ready;
    sendJson({ event_id: makeEventId(), type: "session.finish" });
    await waitForFinalOrTimeout(5000);
    close();
    return currentDisplayText();
  }

  function waitForFinalOrTimeout(timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      finalResolver = () => {
        clearTimeout(timer);
        finalResolver = null;
        resolve();
      };
    });
  }

  function close() {
    if (closed || !socket) return;
    try {
      socket.close();
    } catch {
      // Best effort.
    }
  }

  return {
    appendPcm16Base64,
    close,
    finish,
    ready,
    getText: currentDisplayText,
    model: resolvedModel
  };

  function commitFinalText(text) {
    if (!text) return;
    if (committedText.endsWith(text)) {
      livePartialText = "";
      return;
    }
    if (livePartialText && text.startsWith(livePartialText) && !committedText.includes(text)) {
      committedText = joinTranscript(committedText, text);
    } else if (!committedText.includes(text)) {
      committedText = joinTranscript(committedText, text);
    }
    livePartialText = "";
  }

  function currentDisplayText() {
    return joinTranscript(committedText, livePartialText);
  }

  function makeEventId() {
    return `event_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

function realtimeError(code) {
  const error = new Error(`Qwen realtime: ${code}.`);
  error.code = code;
  return error;
}

function appendStreamingSentence(left, right) {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (!a) return b;
  if (!b) return a;
  if (shouldUseSoftChineseJoin(a, b)) return `${stripTerminalPunctuation(a)}，${b}`;
  const space = /[A-Za-z0-9][.!?]?$/.test(a) && /^[A-Za-z0-9]/.test(b) ? " " : "";
  return `${a}${space}${b}`;
}

function parseRealtimeEvents(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  try {
    return [JSON.parse(text)];
  } catch {
    try {
      return parseServerSentEventChunks(text);
    } catch {
      return [];
    }
  }
}

function joinTranscript(left, right) {
  const a = cleanTranscript(left);
  const b = cleanTranscript(right);
  if (!a) return b;
  if (!b) return a;
  if (a.endsWith(b)) return a;
  if (b.startsWith(a)) return b;
  if (shouldUseSoftChineseJoin(a, b)) {
    return `${stripTerminalPunctuation(a)}，${b}`;
  }
  return `${a}${needsSpace(a, b) ? " " : ""}${b}`;
}

function needsSpace(left, right) {
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
}

function shouldUseSoftChineseJoin(left, right) {
  return /[\u4e00-\u9fff][。！？]$/.test(left)
    && /^[\u4e00-\u9fff]/.test(right)
    && !/^(然后|但是|不过|所以|因为|如果|比如|另外|还有|接下来|最后)/.test(right);
}

function stripTerminalPunctuation(value) {
  return String(value || "").replace(/[。！？]+$/u, "");
}

function compactObject(value) {
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined && item !== "") result[key] = item;
  }
  return result;
}

function extractTranscriptText(event) {
  return String(
    event.transcript ||
    event.text ||
    event.delta ||
    event.output?.text ||
    event.output?.transcript ||
    event.output?.delta ||
    event.item?.transcript ||
    event.item?.text ||
    event.item?.delta ||
    event.item?.content?.[0]?.transcript ||
    event.item?.content?.[0]?.text ||
    event.item?.content?.[0]?.delta ||
    event.response?.output?.[0]?.content?.[0]?.transcript ||
    event.response?.output?.[0]?.content?.[0]?.text ||
    event.response?.output_text ||
    ""
  ).trim();
}

function isFinalEvent(event) {
  return /completed|committed|done|final/i.test(String(event.type || ""));
}

module.exports = {
  createQwenRealtimeSession,
  createQwenAudioStreamingSession,
  appendStreamingSentence,
  isQwenAudioStreamingModel,
  joinTranscript,
  parseRealtimeEvents,
  normalizeQwenRealtimeModel,
  QWEN_REALTIME_MODEL,
  QWEN_LEGACY_REALTIME_MODEL,
  QWEN_REALTIME_WS_URL
};
