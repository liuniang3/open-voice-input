const { createFunAsrRealtimeSession } = require("./fun-asr-realtime-session");

const FUN_ASR_MODEL = "fun-asr";
const FUN_ASR_REST_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
const SAMPLE_AUDIO_URL = "https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/paraformer/hello_world_female2.wav";

function normalizeFunAsrModel(model) {
  const value = String(model || "").trim();
  if (!value || value === "mimo-v2.5" || value === "mimo-v2.5-asr" || value === "qwen3-asr-flash" || value.includes("realtime")) {
    return FUN_ASR_MODEL;
  }
  return value;
}

function createFunAsrProvider({
  apiKey,
  baseUrl,
  model,
  realtimeModel,
  requestTimeoutMs = 60000,
  cleanTranscript,
  getOptions = () => ({}),
  onLog
}) {
  function resolveApiKey() {
    return resolveMaybeFunction(apiKey) || "";
  }

  function resolveBaseUrl() {
    return normalizeFunAsrRestBaseUrl(resolveMaybeFunction(baseUrl));
  }

  function resolveModel() {
    return normalizeFunAsrModel(resolveMaybeFunction(model));
  }

  function resolveRealtimeModel() {
    return resolveMaybeFunction(realtimeModel) || "fun-asr-realtime";
  }

  function resolveRequestTimeoutMs() {
    const timeoutMs = Number(resolveMaybeFunction(requestTimeoutMs));
    return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60000;
  }

  async function transcribeRaw({ audioDataUrl, pcm16Base64 }) {
    const result = await transcribeAudio({ audioDataUrl, pcm16Base64 });
    return {
      provider: "fun-asr",
      text: cleanTranscript(result.text),
      raw: result
    };
  }

  async function transcribeFast(payload) {
    return transcribeRaw(payload);
  }

  async function transcribeAudio({ audioDataUrl, pcm16Base64 }) {
    const value = String(audioDataUrl || "").trim();
    if (/^https?:\/\//i.test(value)) {
      return transcribeRemoteFileUrl(value);
    }
    return transcribeLocalPcmViaRealtime({ pcm16Base64, audioDataUrl: value });
  }

  async function transcribeLocalPcmViaRealtime({ pcm16Base64, audioDataUrl }) {
    const base64Audio = pcm16Base64 || extractPcm16FromDataUrl(audioDataUrl);
    if (!base64Audio) {
      throw new Error("Fun-ASR 本地录音需要 16kHz PCM 音频，当前录音数据不可用。");
    }

    const options = getOptions();
    const session = createFunAsrRealtimeSession({
      apiKey: resolveApiKey(),
      model: resolveRealtimeModel(),
      language: options.language || "",
      semanticPunctuation: Boolean(options.enableSemanticPunctuation),
      onLog
    });
    await session.ready;
    for (const chunk of splitBase64Pcm(base64Audio, 3200)) {
      session.appendPcm16Base64(chunk);
    }
    const text = await session.finish();
    return {
      provider: "fun-asr",
      transport: "realtime-local",
      model: session.model,
      text
    };
  }

  async function transcribeRemoteFileUrl(audioUrl) {
    const taskId = await submitBatchTask(audioUrl);
    const result = await pollBatchTask(taskId);
    const text = await readBatchTranscriptionText(result);
    return {
      provider: "fun-asr",
      transport: "batch-url",
      model: resolveModel(),
      taskId,
      text,
      raw: result
    };
  }

  async function submitBatchTask(audioUrl) {
    const response = await requestJson(`${resolveBaseUrl()}/services/audio/asr/transcription`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resolveApiKey()}`,
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable"
      },
      body: JSON.stringify({
        model: resolveModel(),
        input: {
          file_urls: [audioUrl]
        },
        parameters: buildBatchParameters()
      })
    });
    const taskId = response.output?.task_id;
    if (!taskId) {
      throw new Error(`Fun-ASR 批处理未返回 task_id：${JSON.stringify(response).slice(0, 300)}`);
    }
    return taskId;
  }

  async function pollBatchTask(taskId) {
    const deadline = Date.now() + resolveRequestTimeoutMs();
    while (Date.now() < deadline) {
      const response = await requestJson(`${resolveBaseUrl()}/tasks/${encodeURIComponent(taskId)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resolveApiKey()}`,
          "Content-Type": "application/json",
          "X-DashScope-Async": "enable"
        }
      });
      const status = response.output?.task_status;
      if (status === "SUCCEEDED") return response;
      if (status && status !== "PENDING" && status !== "RUNNING") {
        throw new Error(`Fun-ASR 批处理失败：${status} ${JSON.stringify(response.output || response).slice(0, 300)}`);
      }
      await sleep(300);
    }
    throw new Error("Fun-ASR 批处理等待超时。");
  }

  async function readBatchTranscriptionText(taskResponse) {
    const results = taskResponse.output?.results || [];
    const firstSuccess = results.find((result) => result.subtask_status === "SUCCEEDED" && result.transcription_url);
    if (!firstSuccess) {
      throw new Error(`Fun-ASR 批处理没有可用结果：${JSON.stringify(results).slice(0, 300)}`);
    }
    const response = await fetch(firstSuccess.transcription_url);
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`Fun-ASR 结果下载失败 ${response.status}: ${bodyText.slice(0, 300)}`);
    }
    const body = JSON.parse(bodyText);
    return extractBatchTranscriptText(body);
  }

  async function testConnection() {
    const response = await requestJson(`${resolveBaseUrl()}/services/audio/asr/transcription`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resolveApiKey()}`,
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable"
      },
      body: JSON.stringify({
        model: resolveModel(),
        input: {
          file_urls: [SAMPLE_AUDIO_URL]
        },
        parameters: buildBatchParameters()
      })
    });
    if (!response.output?.task_id) {
      throw new Error(`Fun-ASR 连接测试未返回 task_id：${JSON.stringify(response).slice(0, 300)}`);
    }
  }

  function buildBatchParameters() {
    const options = getOptions();
    const parameters = {
      channel_id: [0]
    };
    if (options.language) {
      parameters.language_hints = [options.language];
    }
    if (typeof options.enableItn === "boolean") {
      parameters.enable_inverse_text_normalization = options.enableItn;
    }
    return parameters;
  }

  async function requestJson(url, init) {
    if (!resolveApiKey()) {
      throw new Error("Fun-ASR API Key 未配置。");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), resolveRequestTimeoutMs());
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal
      });
      const bodyText = await response.text();
      if (!response.ok) {
        throw new Error(`Fun-ASR API ${response.status}: ${bodyText.slice(0, 500)}`);
      }
      return JSON.parse(bodyText);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    id: "fun-asr",
    kind: "dedicated-asr",
    resolveBaseUrl,
    resolveModel,
    resolveApiKey,
    testConnection,
    transcribeFast,
    transcribeRaw
  };
}

function resolveMaybeFunction(value) {
  return typeof value === "function" ? value() : value;
}

function normalizeFunAsrRestBaseUrl(url) {
  const normalized = String(url || FUN_ASR_REST_BASE_URL).replace(/\/+$/, "");
  try {
    const parsed = new URL(normalized);
    if (!parsed.pathname || parsed.pathname === "/") {
      return `${normalized}/api/v1`;
    }
  } catch {
    return normalized;
  }
  return normalized;
}

function extractPcm16FromDataUrl(dataUrl) {
  const value = String(dataUrl || "");
  const match = value.match(/^data:audio\/wav;base64,(.+)$/i);
  if (!match) return "";
  const buffer = Buffer.from(match[1], "base64");
  const pcm = extractPcm16FromWav(buffer);
  return pcm ? pcm.toString("base64") : "";
}

function extractPcm16FromWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let offset = 12;
  let sampleRate = 0;
  let dataStart = -1;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === "fmt " && chunkSize >= 16) {
      sampleRate = buffer.readUInt32LE(chunkStart + 4);
    } else if (chunkId === "data") {
      dataStart = chunkStart;
      dataSize = chunkSize;
      break;
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }
  if (sampleRate && sampleRate !== 16000) return null;
  if (dataStart < 0 || dataSize <= 0) return null;
  return buffer.subarray(dataStart, Math.min(buffer.length, dataStart + dataSize));
}

function splitBase64Pcm(base64Audio, bytesPerChunk) {
  const buffer = Buffer.from(base64Audio, "base64");
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += bytesPerChunk) {
    chunks.push(buffer.subarray(offset, offset + bytesPerChunk).toString("base64"));
  }
  return chunks;
}

function extractBatchTranscriptText(body) {
  const transcripts = body.transcripts || [];
  const texts = [];
  for (const transcript of transcripts) {
    if (transcript.text) {
      texts.push(transcript.text);
    } else if (Array.isArray(transcript.sentences)) {
      texts.push(transcript.sentences.map((sentence) => sentence.text || "").filter(Boolean).join(""));
    }
  }
  return texts.join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  createFunAsrProvider,
  normalizeFunAsrModel,
  FUN_ASR_MODEL,
  FUN_ASR_REST_BASE_URL
};
