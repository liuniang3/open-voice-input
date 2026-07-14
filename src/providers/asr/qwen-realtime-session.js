const WebSocket = require("ws");
const { cleanTranscript } = require("../../transcript-cleaner");
const { parseServerSentEventChunks } = require("../openai-compatible-client");

const QWEN_REALTIME_MODEL = "qwen3-asr-flash-realtime";
const QWEN_REALTIME_WS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";

function normalizeQwenRealtimeModel(model) {
  const value = String(model || "").trim();
  if (!value || value === "mimo-v2.5" || value === "mimo-v2.5-asr" || value === "qwen3-asr-flash") return QWEN_REALTIME_MODEL;
  return value;
}

function createQwenRealtimeSession({
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
  joinTranscript,
  parseRealtimeEvents,
  normalizeQwenRealtimeModel,
  QWEN_REALTIME_MODEL,
  QWEN_REALTIME_WS_URL
};
