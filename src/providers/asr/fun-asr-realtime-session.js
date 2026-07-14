const crypto = require("node:crypto");
const WebSocket = require("ws");
const { cleanTranscript } = require("../../transcript-cleaner");
const { parseServerSentEventChunks } = require("../openai-compatible-client");

const FUN_ASR_REALTIME_MODEL = "fun-asr-realtime";
const FUN_ASR_REALTIME_WS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";

function normalizeFunAsrRealtimeModel(model) {
  const value = String(model || "").trim();
  if (!value || value === "mimo-v2.5" || value === "mimo-v2.5-asr" || value === "qwen3-asr-flash" || value === "fun-asr") {
    return FUN_ASR_REALTIME_MODEL;
  }
  return value;
}

function createFunAsrRealtimeSession({
  apiKey,
  model,
  language = "",
  semanticPunctuation = false,
  onPartial,
  onFinal,
  onLog
}) {
  const resolvedApiKey = String(apiKey || "").trim();
  if (!resolvedApiKey) {
    throw new Error("Fun-ASR API Key 未配置。");
  }

  const resolvedModel = normalizeFunAsrRealtimeModel(model);
  const taskId = makeTaskId();
  let socket;
  let started = false;
  let closed = false;
  let committedText = "";
  let livePartialText = "";
  let pendingChunks = [];
  let readyResolver = null;
  let readyRejecter = null;
  let finalResolver = null;
  let finalRejecter = null;

  const ready = new Promise((resolve, reject) => {
    readyResolver = resolve;
    readyRejecter = reject;
    socket = new WebSocket(FUN_ASR_REALTIME_WS_URL, {
      headers: {
        Authorization: `Bearer ${resolvedApiKey}`,
        "user-agent": "open-voice-input/0.1"
      }
    });

    socket.on("open", () => {
      onLog?.("fun-asr-realtime: open", resolvedModel);
      sendJson({
        header: {
          action: "run-task",
          task_id: taskId,
          streaming: "duplex"
        },
        payload: {
          task_group: "audio",
          task: "asr",
          function: "recognition",
          model: resolvedModel,
          parameters: compactObject({
            format: "pcm",
            sample_rate: 16000,
            semantic_punctuation_enabled: Boolean(semanticPunctuation),
            language_hints: language ? [language] : undefined
          }),
          input: {}
        }
      });
    });

    socket.on("message", (data) => {
      if (Buffer.isBuffer(data)) return;
      handleMessage(String(data));
    });

    socket.on("error", (error) => {
      onLog?.("fun-asr-realtime: error", error.message || String(error));
      rejectIfPending(error);
    });

    socket.on("close", (code, reason) => {
      closed = true;
      onLog?.("fun-asr-realtime: close", `${code} ${String(reason || "")}`);
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
    if (!started || !socket || socket.readyState !== WebSocket.OPEN) {
      pendingChunks.push(base64Audio);
      return;
    }
    socket.send(Buffer.from(base64Audio, "base64"), { binary: true });
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
    const eventName = event.header?.event || "";
    if (eventName === "task-started") {
      started = true;
      onLog?.("fun-asr-realtime: task started", taskId);
      flushPendingChunks();
      readyResolver?.();
      readyResolver = null;
      readyRejecter = null;
      return;
    }

    if (eventName === "task-failed") {
      const message = event.header?.error_message || event.header?.error_code || raw;
      const error = new Error(`Fun-ASR 实时转写失败：${message}`);
      onLog?.("fun-asr-realtime: task failed", message);
      rejectIfPending(error);
      close();
      return;
    }

    if (eventName === "task-finished") {
      if (livePartialText) {
        commitFinalText(livePartialText);
      }
      finalResolver?.();
      finalResolver = null;
      finalRejecter = null;
      return;
    }

    if (eventName !== "result-generated") {
      onLog?.("fun-asr-realtime: event", eventName || raw.slice(0, 120));
      return;
    }

    const sentence = event.payload?.output?.sentence;
    if (!sentence || sentence.heartbeat) return;

    const text = cleanTranscript(sentence.text || "");
    if (!text) return;

    if (sentence.sentence_end) {
      commitFinalText(text);
      onFinal?.(currentDisplayText());
    } else if (text !== livePartialText) {
      livePartialText = text;
      onPartial?.(currentDisplayText());
    }
  }

  async function finish() {
    await ready;
    sendJson({
      header: {
        action: "finish-task",
        task_id: taskId,
        streaming: "duplex"
      },
      payload: {
        input: {}
      }
    });
    await waitForFinalOrTimeout(8000);
    close();
    return currentDisplayText();
  }

  function waitForFinalOrTimeout(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        finalResolver = null;
        finalRejecter = null;
        resolve();
      }, timeoutMs);
      finalResolver = () => {
        clearTimeout(timer);
        resolve();
      };
      finalRejecter = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
  }

  function rejectIfPending(error) {
    readyRejecter?.(error);
    readyResolver = null;
    readyRejecter = null;
    finalRejecter?.(error);
    finalResolver = null;
    finalRejecter = null;
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
  return `${a}${needsSpace(a, b) ? " " : ""}${b}`;
}

function needsSpace(left, right) {
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
}

function compactObject(value) {
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined && item !== "") result[key] = item;
  }
  return result;
}

function makeTaskId() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `task_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

module.exports = {
  createFunAsrRealtimeSession,
  joinTranscript,
  parseRealtimeEvents,
  normalizeFunAsrRealtimeModel,
  FUN_ASR_REALTIME_MODEL,
  FUN_ASR_REALTIME_WS_URL
};
