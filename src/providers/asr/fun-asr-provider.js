const { createFunAsrRealtimeSession } = require("./fun-asr-realtime-session");

const FUN_ASR_MODEL = "fun-asr";
const FUN_ASR_REST_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
const SAMPLE_AUDIO_URL = "https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/paraformer/hello_world_female2.wav";

const DEFAULT_MEETING_POLL_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const MAX_TRANSIENT_RETRIES = 5;

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
  meetingPollTimeoutMs = DEFAULT_MEETING_POLL_TIMEOUT_MS,
  cleanTranscript,
  getOptions = () => ({}),
  onLog,
  fetchImpl = null,
  /** test-only: fixed backoff ms (disables jitter) */
  backoffMsImpl = null
}) {
  const fetchFn = fetchImpl || globalThis.fetch.bind(globalThis);
  const resolveBackoff = typeof backoffMsImpl === "function" ? backoffMsImpl : backoffMs;

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

  function resolveMeetingPollTimeoutMs(override) {
    const timeoutMs = Number(override != null ? override : resolveMaybeFunction(meetingPollTimeoutMs));
    return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_MEETING_POLL_TIMEOUT_MS;
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
    const taskId = await submitBatchTask(audioUrl, { diarizationEnabled: false });
    const result = await pollBatchTask(taskId, { timeoutMs: resolveRequestTimeoutMs() });
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

  /**
   * Meeting structured path. Does not change short-voice callers.
   * `text` is raw joined sentence text (authoritative). Optional `cleanedText`
   * is separate and never replaces `text`.
   */
  async function transcribeMeetingStructured({
    audioUrl,
    existingTaskId = null,
    diarizationEnabled = false,
    mono = true,
    channels = null,
    pollTimeoutMs,
    signal = null,
    language = null,
    onTaskId = null
  } = {}) {
    const wantDiarization = Boolean(diarizationEnabled);
    if (wantDiarization) {
      const channelCount = channels != null ? Number(channels) : mono === false ? 2 : 1;
      if (mono === false || (Number.isFinite(channelCount) && channelCount !== 1)) {
        const error = new Error(
          "Fun-ASR diarization_enabled requires mono (1-channel) input. Export archive mono WAV before request."
        );
        error.code = "diarization_requires_mono";
        throw error;
      }
    }

    let taskId = String(existingTaskId || "").trim();
    if (!taskId) {
      const url = String(audioUrl || "").trim();
      if (!/^https:\/\//i.test(url)) {
        const error = new Error(
          "Fun-ASR meeting structured transcription requires a public https:// audio URL (use MeetingAudioPublisher)."
        );
        error.code = "meeting_audio_url_required";
        throw error;
      }
      taskId = await submitBatchTask(url, {
        diarizationEnabled: wantDiarization,
        language,
        signal
      });
      if (typeof onTaskId === "function") {
        await onTaskId(taskId);
      }
    }

    const result = await pollBatchTask(taskId, {
      timeoutMs: resolveMeetingPollTimeoutMs(pollTimeoutMs),
      signal,
      intervalMs: DEFAULT_POLL_INTERVAL_MS
    });
    const structured = await readBatchTranscriptionStructured(result, { signal });
    const text = structured.sentences.map((s) => s.text).filter(Boolean).join("");
    const cleanedText = cleanTranscript ? cleanTranscript(text) : text;
    return {
      provider: "fun-asr",
      transport: "batch-url-meeting",
      model: resolveModel(),
      taskId,
      diarizationEnabled: wantDiarization,
      text,
      cleanedText,
      sentences: structured.sentences,
      raw: result,
      transcriptionBody: structured.body
    };
  }

  async function submitBatchTask(audioUrl, { diarizationEnabled = false, language = null, signal = null } = {}) {
    const response = await requestJson(
      `${resolveBaseUrl()}/services/audio/asr/transcription`,
      {
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
          parameters: buildBatchParameters({ diarizationEnabled, language })
        })
      },
      { signal, timeoutMs: resolveRequestTimeoutMs() }
    );
    const taskId = response.output?.task_id;
    if (!taskId) {
      throw new Error(`Fun-ASR 批处理未返回 task_id：${JSON.stringify(response).slice(0, 300)}`);
    }
    return taskId;
  }

  /**
   * Official DashScope task query: GET /api/v1/tasks/{task_id}
   * Retry ownership: poll loop only (requestJson does not nested-retry).
   */
  async function pollBatchTask(taskId, { timeoutMs, signal = null, intervalMs = 300 } = {}) {
    const deadline = Date.now() + (Number(timeoutMs) > 0 ? Number(timeoutMs) : resolveRequestTimeoutMs());
    let transientFailures = 0;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      try {
        const response = await requestJson(
          `${resolveBaseUrl()}/tasks/${encodeURIComponent(taskId)}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${resolveApiKey()}`,
              "Content-Type": "application/json"
            }
          },
          { signal, timeoutMs: resolveRequestTimeoutMs(), retryTransient: false }
        );
        transientFailures = 0;
        const status = response.output?.task_status;
        if (status === "SUCCEEDED") return response;
        if (status && status !== "PENDING" && status !== "RUNNING") {
          throw new Error(`Fun-ASR 批处理失败：${status} ${JSON.stringify(response.output || response).slice(0, 300)}`);
        }
      } catch (error) {
        if (error && error.code === "aborted") throw error;
        if (!isTransientError(error) || transientFailures >= MAX_TRANSIENT_RETRIES) throw error;
        transientFailures += 1;
        await sleep(resolveBackoff(transientFailures), signal);
        continue;
      }
      await sleep(intervalMs, signal);
    }
    const err = new Error("Fun-ASR 批处理等待超时。");
    err.code = "poll_timeout";
    throw err;
  }

  async function readBatchTranscriptionText(taskResponse) {
    const structured = await readBatchTranscriptionStructured(taskResponse);
    return structured.sentences.map((s) => s.text).filter(Boolean).join("") ||
      extractBatchTranscriptText(structured.body);
  }

  async function readBatchTranscriptionStructured(taskResponse, { signal = null } = {}) {
    const results = taskResponse.output?.results || [];
    const firstSuccess = results.find((result) => result.subtask_status === "SUCCEEDED" && result.transcription_url);
    if (!firstSuccess) {
      throw new Error(`Fun-ASR 批处理没有可用结果：${JSON.stringify(results).slice(0, 300)}`);
    }
    const body = await downloadJsonWithRetry(firstSuccess.transcription_url, { signal });
    const sentences = parseStructuredSentences(body);
    return { body, sentences, transcriptionUrl: firstSuccess.transcription_url };
  }

  /**
   * Download transcription_url JSON. No provider Authorization header.
   * Per-attempt timeout via requestTimeoutMs. Retry ownership stays here (bounded).
   * caller abort => aborted (no retry); internal timer => request_timeout (transient).
   */
  async function downloadJsonWithRetry(url, { signal = null, timeoutMs = null } = {}) {
    const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : resolveRequestTimeoutMs();
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt += 1) {
      throwIfAborted(signal);
      const controller = new AbortController();
      let timedOut = false;
      const onAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) {
          const err = new Error("aborted");
          err.code = "aborted";
          throw err;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, limit);
      try {
        // Intentionally no Authorization — transcription_url is a pre-signed/public result URL.
        const response = await fetchFn(url, { signal: controller.signal });
        const bodyText = await response.text();
        if (!response.ok) {
          const err = new Error(`Fun-ASR 结果下载失败 ${response.status}: ${bodyText.slice(0, 300)}`);
          err.status = response.status;
          if ((response.status >= 500 || response.status === 429) && attempt < MAX_TRANSIENT_RETRIES) {
            lastError = err;
            await sleep(resolveBackoff(attempt + 1), signal);
            continue;
          }
          throw err;
        }
        return JSON.parse(bodyText);
      } catch (error) {
        if (signal && signal.aborted && !timedOut) {
          const err = new Error("aborted");
          err.code = "aborted";
          throw err;
        }
        if (error && (error.name === "AbortError" || error.code === "ABORT_ERR")) {
          if (timedOut) {
            const err = new Error("Fun-ASR 结果下载超时。");
            err.code = "request_timeout";
            lastError = err;
            if (attempt < MAX_TRANSIENT_RETRIES) {
              await sleep(resolveBackoff(attempt + 1), signal);
              continue;
            }
            throw err;
          }
          const err = new Error("aborted");
          err.code = "aborted";
          throw err;
        }
        if (error && error.code === "aborted") throw error;
        lastError = error;
        if (!isTransientError(error) || attempt >= MAX_TRANSIENT_RETRIES) throw error;
        await sleep(resolveBackoff(attempt + 1), signal);
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    }
    throw lastError || new Error("Fun-ASR 结果下载失败");
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

  function buildBatchParameters(overrides = {}) {
    const options = getOptions();
    const parameters = {
      channel_id: [0]
    };
    const language = overrides.language != null ? overrides.language : options.language;
    if (language) {
      parameters.language_hints = [language];
    }
    if (typeof options.enableItn === "boolean") {
      parameters.enable_inverse_text_normalization = options.enableItn;
    }
    if (overrides.diarizationEnabled === true) {
      parameters.diarization_enabled = true;
    }
    return parameters;
  }

  /**
   * Single-shot HTTP JSON request (no nested retry loop).
   * - Caller AbortSignal → code=aborted (not retryable)
   * - Internal timer → code=request_timeout (transient/retryable by outer owner)
   * retryTransient is accepted for API compat but must stay false from pollBatchTask.
   */
  async function requestJson(url, init, { signal = null, timeoutMs = null, retryTransient = false } = {}) {
    if (!resolveApiKey()) {
      throw new Error("Fun-ASR API Key 未配置。");
    }
    const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : resolveRequestTimeoutMs();
    const maxAttempts = retryTransient ? MAX_TRANSIENT_RETRIES + 1 : 1;
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      throwIfAborted(signal);
      const controller = new AbortController();
      let timedOut = false;
      const onAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) {
          const err = new Error("aborted");
          err.code = "aborted";
          throw err;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, limit);
      try {
        const response = await fetchFn(url, {
          ...init,
          signal: controller.signal
        });
        const bodyText = await response.text();
        if (!response.ok) {
          const err = new Error(`Fun-ASR API ${response.status}: ${bodyText.slice(0, 500)}`);
          err.status = response.status;
          if (retryTransient && isTransientError(err) && attempt + 1 < maxAttempts) {
            lastError = err;
            await sleep(resolveBackoff(attempt + 1), signal);
            continue;
          }
          throw err;
        }
        return JSON.parse(bodyText);
      } catch (error) {
        if (signal && signal.aborted && !timedOut) {
          const err = new Error("aborted");
          err.code = "aborted";
          throw err;
        }
        if (error && (error.name === "AbortError" || error.code === "ABORT_ERR")) {
          if (timedOut) {
            const err = new Error("Fun-ASR 请求超时。");
            err.code = "request_timeout";
            if (retryTransient && attempt + 1 < maxAttempts) {
              lastError = err;
              await sleep(resolveBackoff(attempt + 1), signal);
              continue;
            }
            throw err;
          }
          const err = new Error("aborted");
          err.code = "aborted";
          throw err;
        }
        if (error && error.code === "aborted") throw error;
        lastError = error;
        if (retryTransient && isTransientError(error) && attempt + 1 < maxAttempts) {
          await sleep(resolveBackoff(attempt + 1), signal);
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    }
    throw lastError || new Error("Fun-ASR 请求失败");
  }

  return {
    id: "fun-asr",
    kind: "dedicated-asr",
    resolveBaseUrl,
    resolveModel,
    resolveApiKey,
    testConnection,
    transcribeFast,
    transcribeRaw,
    transcribeMeetingStructured,
    _buildBatchParameters: buildBatchParameters,
    _parseStructuredSentences: parseStructuredSentences,
    _requestJson: requestJson,
    _pollBatchTask: pollBatchTask,
    _downloadJsonWithRetry: downloadJsonWithRetry,
    _isTransientError: isTransientError
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

function parseStructuredSentences(body) {
  const out = [];
  const transcripts = body?.transcripts || [];
  for (const transcript of transcripts) {
    const channelId =
      transcript.channel_id ?? transcript.channelId ?? body?.channel_id ?? null;
    const sentences = Array.isArray(transcript.sentences) ? transcript.sentences : [];
    if (sentences.length) {
      for (const sentence of sentences) {
        const text = String(sentence.text || "").trim();
        if (!text) continue;
        out.push({
          text,
          beginMs: pickTimeMs(sentence, ["begin_time", "beginMs", "start_time", "startMs", "begin"]),
          endMs: pickTimeMs(sentence, ["end_time", "endMs", "stop_time", "stopMs", "end"]),
          speakerId: pickSpeakerId(sentence),
          confidence: pickConfidence(sentence),
          channelId: sentence.channel_id ?? sentence.channelId ?? channelId
        });
      }
    } else if (transcript.text) {
      out.push({
        text: String(transcript.text),
        beginMs: pickTimeMs(transcript, ["begin_time", "beginMs"]),
        endMs: pickTimeMs(transcript, ["end_time", "endMs"]),
        speakerId: pickSpeakerId(transcript),
        confidence: pickConfidence(transcript),
        channelId
      });
    }
  }
  return out;
}

function pickTimeMs(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] != null && obj[key] !== "") {
      const n = Number(obj[key]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function pickSpeakerId(obj) {
  if (!obj || typeof obj !== "object") return null;
  const raw = obj.speaker_id ?? obj.speakerId ?? obj.spk ?? obj.speaker ?? null;
  if (raw == null || raw === "") return null;
  return raw;
}

function pickConfidence(obj) {
  if (!obj || typeof obj !== "object") return null;
  const raw = obj.confidence ?? obj.sentence_confidence ?? obj.sentiment_confidence ?? null;
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function isTransientError(error) {
  if (!error) return false;
  if (error.code === "request_timeout") return true;
  if (error.code === "aborted") return false;
  if (error.status === 429 || (error.status >= 500 && error.status <= 599)) return true;
  const msg = String(error.message || error.code || "");
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|fetch failed|socket|请求超时/i.test(msg);
}

function backoffMs(attempt) {
  const base = Math.min(8000, 200 * 2 ** Math.max(0, attempt - 1));
  return base + Math.floor(Math.random() * 50);
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    const err = new Error("aborted");
    err.code = "aborted";
    throw err;
  }
}

function sleep(ms, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      const err = new Error("aborted");
      err.code = "aborted";
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      const err = new Error("aborted");
      err.code = "aborted";
      reject(err);
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

module.exports = {
  createFunAsrProvider,
  normalizeFunAsrModel,
  parseStructuredSentences,
  isTransientError,
  FUN_ASR_MODEL,
  FUN_ASR_REST_BASE_URL,
  DEFAULT_MEETING_POLL_TIMEOUT_MS
};
