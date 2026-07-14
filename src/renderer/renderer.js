const apiState = document.getElementById("apiState");
const statusPanel = document.getElementById("statusPanel");
const statusTitle = document.getElementById("statusTitle");
const statusDetail = document.getElementById("statusDetail");
const pulse = document.getElementById("pulse");
const levelMeter = document.getElementById("levelMeter");
const levelFill = document.getElementById("levelFill");
const contextInput = document.getElementById("contextInput");
const resultText = document.getElementById("resultText");
const recordBtn = document.getElementById("recordBtn");
const stopBtn = document.getElementById("stopBtn");
const sendBtn = document.getElementById("sendBtn");
const copyBtn = document.getElementById("copyBtn");
const closeBtn = document.getElementById("closeBtn");
const recordingCancelBtn = document.getElementById("recordingCancelBtn");
const settingsBtn = document.getElementById("settingsBtn");
const settingsPanel = document.getElementById("settingsPanel");
const microphoneSelect = document.getElementById("microphoneSelect");
const microphoneHint = document.getElementById("microphoneHint");
const refreshDevicesBtn = document.getElementById("refreshDevicesBtn");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");
const apiKeyInput = document.getElementById("apiKeyInput");
const baseUrlInput = document.getElementById("baseUrlInput");
const asrProviderSelect = document.getElementById("asrProviderSelect");
const asrModeSelect = document.getElementById("asrModeSelect");
const asrModelInput = document.getElementById("asrModelInput");
const asrRealtimeModelInput = document.getElementById("asrRealtimeModelInput");
const asrBaseUrlInput = document.getElementById("asrBaseUrlInput");
const asrApiKeyInput = document.getElementById("asrApiKeyInput");
const asrLanguageInput = document.getElementById("asrLanguageInput");
const asrEnableItnInput = document.getElementById("asrEnableItnInput");
const cleanerProviderSelect = document.getElementById("cleanerProviderSelect");
const cleanerModelInput = document.getElementById("cleanerModelInput");
const cleanerBaseUrlInput = document.getElementById("cleanerBaseUrlInput");
const cleanerApiKeyInput = document.getElementById("cleanerApiKeyInput");
const hotkeyInput = document.getElementById("hotkeyInput");
const hotkeyHint = document.getElementById("hotkeyHint");
const stableModeBtn = document.getElementById("stableModeBtn");
const fastModeBtn = document.getElementById("fastModeBtn");
const clearApiKeyBtn = document.getElementById("clearApiKeyBtn");
const testConnectionBtn = document.getElementById("testConnectionBtn");

const TRANSCRIPTION_MODES = new Set(["stable", "fast"]);
const ASR_MODES = new Set(["batch", "realtime"]);
const QWEN_ASR_OPENAI_MODEL = "qwen3-asr-flash";
const QWEN_ASR_OPENAI_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const QWEN_ASR_REALTIME_MODEL = "qwen3-asr-flash-realtime";
const MIMO_ASR_MODEL = "mimo-v2.5-asr";
const FUN_ASR_MODEL = "fun-asr";
const FUN_ASR_REST_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
const FUN_ASR_REALTIME_MODEL = "fun-asr-realtime";

let audioContext;
let sourceNode;
let processorNode;
let mediaStream;
let recordingChunks = [];
let recordingSampleRate = 48000;
let recordingStartedAt = 0;
let recordingPeak = 0;
let recordingRmsSum = 0;
let recordingSampleCount = 0;
let silenceGainNode;
let isRecording = false;
let isTranscribing = false;
let appSettings = {};
let autoSendAfterTranscript = false;
let currentWindowMode = "compact";
let hotkeyCaptureOriginalValue = "";
let recordingTranscriptionMode = "stable";
let recordingShortContext = "";
let recordingAsrMode = "batch";
let lastVoiceRequest = null;
let resizeTimer = 0;
let mimoPreviewTimer = 0;
let mimoPreviewInFlight = false;
let mimoPreviewLastSampleCount = 0;
let mimoPreviewRunId = 0;

function createSettingsSnapshot() {
  return {
    model: appSettings.model,
    apiKey: appSettings.apiKey,
    baseUrl: appSettings.baseUrl,
    asrProvider: appSettings.asrProvider,
    asrMode: appSettings.asrMode,
    asrModel: appSettings.asrModel,
    asrRealtimeModel: appSettings.asrRealtimeModel,
    asrApiKey: appSettings.asrApiKey,
    asrBaseUrl: appSettings.asrBaseUrl,
    asrLanguage: appSettings.asrLanguage,
    asrEnableItn: appSettings.asrEnableItn,
    cleanerProvider: appSettings.cleanerProvider,
    cleanerModel: appSettings.cleanerModel,
    cleanerApiKey: appSettings.cleanerApiKey,
    cleanerBaseUrl: appSettings.cleanerBaseUrl,
    transcriptionMode: appSettings.transcriptionMode,
    requestTimeoutMs: appSettings.requestTimeoutMs
  };
}

function createFinalTranscriptionSnapshot() {
  const snapshot = createSettingsSnapshot();
  if (normalizeAsrMode(snapshot.asrMode) === "realtime") {
    snapshot.asrMode = "batch";
  }
  return snapshot;
}

function normalizeTranscriptionMode(mode) {
  return TRANSCRIPTION_MODES.has(mode) ? mode : "stable";
}

function normalizeAsrMode(mode) {
  return ASR_MODES.has(mode) ? mode : "batch";
}

function usesSocketRealtimePreview() {
  return recordingAsrMode === "realtime" && (appSettings.asrProvider === "qwen3-asr" || appSettings.asrProvider === "fun-asr");
}

function usesMimoPollingPreview() {
  return recordingAsrMode === "realtime" && appSettings.asrProvider === "mimo";
}

function normalizeQwenAsrModel(model) {
  const value = String(model || "").trim();
  if (!value || value === "mimo-v2.5" || value === MIMO_ASR_MODEL) return QWEN_ASR_OPENAI_MODEL;
  if (value.includes("realtime") || value.includes("filetrans")) return QWEN_ASR_OPENAI_MODEL;
  return value;
}

function normalizeQwenRealtimeModel(model) {
  const value = String(model || "").trim();
  if (!value || value === "mimo-v2.5" || value === MIMO_ASR_MODEL || value === QWEN_ASR_OPENAI_MODEL) {
    return QWEN_ASR_REALTIME_MODEL;
  }
  return value;
}

function normalizeFunAsrModel(model) {
  const value = String(model || "").trim();
  if (!value || value === "mimo-v2.5" || value === MIMO_ASR_MODEL || value === QWEN_ASR_OPENAI_MODEL || value.includes("realtime")) {
    return FUN_ASR_MODEL;
  }
  return value;
}

function normalizeMimoAsrModel(model) {
  const value = String(model || "").trim();
  if (!value || value === "mimo-v2.5" || value === QWEN_ASR_OPENAI_MODEL || value === FUN_ASR_MODEL || value.includes("realtime")) {
    return MIMO_ASR_MODEL;
  }
  return value;
}

function normalizeFunAsrRealtimeModel(model) {
  const value = String(model || "").trim();
  if (!value || value === "mimo-v2.5" || value === MIMO_ASR_MODEL || value === QWEN_ASR_OPENAI_MODEL || value === FUN_ASR_MODEL) {
    return FUN_ASR_REALTIME_MODEL;
  }
  return value;
}

function normalizeProviderSettingsDraft() {
  if (!apiKeyInput.value.trim().startsWith("tp-") && /token-plan/i.test(baseUrlInput.value.trim())) {
    baseUrlInput.value = "https://api.xiaomimimo.com/v1";
  }
  if (asrProviderSelect.value === "qwen3-asr") {
    asrModelInput.value = normalizeQwenAsrModel(asrModelInput.value);
    asrRealtimeModelInput.value = normalizeQwenRealtimeModel(asrRealtimeModelInput.value);
    if (!asrBaseUrlInput.value.trim()) {
      asrBaseUrlInput.value = QWEN_ASR_OPENAI_BASE_URL;
    }
  } else if (asrProviderSelect.value === "fun-asr") {
    asrModelInput.value = normalizeFunAsrModel(asrModelInput.value);
    asrRealtimeModelInput.value = normalizeFunAsrRealtimeModel(asrRealtimeModelInput.value);
    if (!asrBaseUrlInput.value.trim() || asrBaseUrlInput.value.trim() === QWEN_ASR_OPENAI_BASE_URL) {
      asrBaseUrlInput.value = FUN_ASR_REST_BASE_URL;
    }
  } else if (asrProviderSelect.value === "mimo") {
    asrModelInput.value = normalizeMimoAsrModel(asrModelInput.value);
  }
}

function normalizeAsrModelForSelectedProvider(value) {
  if (asrProviderSelect.value === "qwen3-asr") {
    return normalizeQwenAsrModel(value);
  }
  if (asrProviderSelect.value === "fun-asr") {
    return normalizeFunAsrModel(value);
  }
  return normalizeMimoAsrModel(value);
}

function normalizeRealtimeModelForSelectedProvider(value) {
  if (asrProviderSelect.value === "qwen3-asr") {
    return normalizeQwenRealtimeModel(value);
  }
  if (asrProviderSelect.value === "fun-asr") {
    return normalizeFunAsrRealtimeModel(value);
  }
  return String(value || "").trim();
}

function logRenderer(message, detail = "") {
  window.mimoInput?.log?.(message, detail).catch(() => {});
}

function setStatus(kind, title, detail) {
  statusPanel.dataset.kind = kind;
  pulse.dataset.kind = kind;
  statusTitle.textContent = title;
  statusDetail.textContent = detail;
  scheduleRecordingResize();
}

function setLevel(value) {
  const normalized = Math.max(0, Math.min(1, value));
  levelFill.style.width = `${Math.round(normalized * 100)}%`;
}

function setButtons(state) {
  const hasResult = Boolean(resultText.value.trim());
  recordBtn.disabled = state === "recording" || state === "transcribing";
  stopBtn.disabled = state !== "recording";
  copyBtn.disabled = !hasResult || state === "recording" || state === "transcribing";
  sendBtn.disabled = !hasResult || state === "recording" || state === "transcribing";
}

function scheduleRecordingResize() {
  if (currentWindowMode !== "recording") return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resizeRecordingWindowToContent, 30);
}

function resizeRecordingWindowToContent() {
  if (currentWindowMode !== "recording") return;
  const textLength = statusDetail.textContent.length;
  const contentWidth = textLength > 48 ? 520 : textLength > 22 ? 420 : 320;
  const chromeHeight = document.getElementById("recordingChrome")?.offsetHeight || 0;
  const contentHeight = Math.min(420, Math.max(132, Math.ceil(statusPanel.scrollHeight + chromeHeight + 36)));
  window.mimoInput.resizeRecordingWindow?.({
    width: contentWidth,
    height: contentHeight
  }).catch(() => {});
  if (statusDetail.scrollHeight > statusDetail.clientHeight) {
    statusDetail.scrollTop = statusDetail.scrollHeight;
  }
}

async function refreshStatus() {
  const status = await window.mimoInput.getStatus();
  appSettings = status.settings || {};
  const hotkeys = status.registeredHotkeys?.length ? status.registeredHotkeys.join(" / ") : "没有可用的全局快捷键";
  apiState.textContent = status.hasApiKey
    ? `API Key 已配置 · ${status.keyKind} · ${status.baseUrl}`
    : "未配置 API Key";
  apiState.dataset.ok = String(status.hasApiKey);
  if (!isRecording) {
    const chosenHotkey = appSettings.hotkey || "CommandOrControl+Alt+M";
    const chosenRegistered = status.registeredHotkeys?.includes(chosenHotkey);
    const detail = chosenRegistered
      ? `全局快捷键：${chosenHotkey}`
      : `无法注册：${chosenHotkey}。当前可用：${hotkeys}`;
    setStatus(chosenRegistered ? "ready" : "warning", chosenRegistered ? "就绪" : "快捷键不可用", detail);
  }
  fillSettingsForm(status);
  return status;
}

async function startRecording({ autoSend = true } = {}) {
  if (isRecording) return;
  logRenderer("recording: start requested", `autoSend=${autoSend}`);
  try {
    await refreshStatus();
  } catch (error) {
    logRenderer("settings: refresh before recording failed", error.message || String(error));
  }
  autoSendAfterTranscript = autoSend;
  recordingTranscriptionMode = normalizeTranscriptionMode(appSettings.transcriptionMode);
  recordingAsrMode = normalizeAsrMode(appSettings.asrMode);
  recordingShortContext = buildShortContext();
  resultText.value = "";
  setButtons("recording");
  setStatus("recording", "正在录音", "");
  levelMeter.hidden = false;
  setLevel(0);
  recordingPeak = 0;
  recordingRmsSum = 0;
  recordingSampleCount = 0;
  recordingStartedAt = performance.now();
  recordingChunks = [];
  isRecording = true;

  try {
    mediaStream = await openMicrophoneStream();
  } catch (error) {
    isRecording = false;
    logRenderer("recording: microphone failed", error.message || String(error));
    levelMeter.hidden = true;
    setButtons("ready");
    throw error;
  }

  if (usesSocketRealtimePreview()) {
    try {
      const result = await window.mimoInput.startRealtimeAsr();
      if (result?.enabled) {
        setStatus("recording", "正在录音", "实时转写已连接，开始说话。");
        resultText.value = "实时转写已连接，开始说话即可显示结果。";
      }
    } catch (error) {
      logRenderer("qwen realtime: start failed", error.message || String(error));
      setStatus("warning", "实时连接失败", "已继续录音，停止后将使用非实时转写。");
      recordingAsrMode = "batch";
    }
  } else if (usesMimoPollingPreview()) {
    setStatus("recording", "正在录音", "MiMo 实时预览会每几秒刷新一次；最终文本仍以完整录音为准。");
    resultText.value = "MiMo 实时预览准备中，开始说话后会自动刷新。";
  }

  audioContext = new AudioContext();
  recordingSampleRate = audioContext.sampleRate;
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  processorNode = audioContext.createScriptProcessor(4096, 1, 1);
  silenceGainNode = audioContext.createGain();
  silenceGainNode.gain.value = 0;

  const track = mediaStream.getAudioTracks()[0];
  const actualLabel = track?.label || "未知麦克风";
  const actualDeviceId = track?.getSettings?.().deviceId || "";
  logRenderer("recording: microphone opened", actualLabel);
  microphoneHint.textContent = `实际输入：${actualLabel}`;
  if (recordingAsrMode !== "realtime") {
    setStatus("recording", "正在录音", actualLabel);
  }

  processorNode.onaudioprocess = (event) => {
    if (!isRecording) return;
    const input = event.inputBuffer.getChannelData(0);
    recordingChunks.push(new Float32Array(input));
    if (usesSocketRealtimePreview()) {
      window.mimoInput.appendRealtimeAudio(float32ToPcm16Base64(input, recordingSampleRate, 16000)).catch(() => {});
    }
    updateAudioStats(input);
  };

  sourceNode.connect(processorNode);
  processorNode.connect(silenceGainNode);
  silenceGainNode.connect(audioContext.destination);

  if (appSettings.microphoneDeviceId && actualDeviceId && appSettings.microphoneDeviceId !== actualDeviceId) {
    if (recordingAsrMode !== "realtime") {
      setStatus("recording", "正在录音", `已切换到备用输入：${actualLabel}`);
    }
  }
  if (usesMimoPollingPreview()) {
    startMimoPreviewLoop();
  }
}

async function stopRecording() {
  if (!isRecording) return;
  logRenderer("recording: stop requested");
  isRecording = false;
  await window.mimoInput.clearRecordingKeys();
  setButtons("transcribing");
  const transcriptionMode = normalizeTranscriptionMode(recordingTranscriptionMode);
  const modeDetail = transcriptionMode === "fast"
    ? "快速模式：仅执行语音识别。"
    : "稳定模式：先转写，再进行文本清理。";
  setStatus("transcribing", "正在转写", modeDetail);

  processorNode?.disconnect();
  silenceGainNode?.disconnect();
  sourceNode?.disconnect();
  mediaStream?.getTracks().forEach((track) => track.stop());
  await audioContext?.close();
  levelMeter.hidden = true;

  const durationMs = performance.now() - recordingStartedAt;
  const rms = recordingSampleCount ? Math.sqrt(recordingRmsSum / recordingSampleCount) : 0;
  if (durationMs < 500 || recordingSampleCount < recordingSampleRate * 0.45) {
    logRenderer("recording: too short", `duration=${durationMs} samples=${recordingSampleCount}`);
    await cleanupRealtimePreview();
    setStatus("warning", "录音太短", "请至少录制半秒以上。");
    setButtons("ready");
    return;
  }
  if (recordingPeak < 0.012 || rms < 0.003) {
    logRenderer("recording: no input", `peak=${recordingPeak} rms=${rms}`);
    await cleanupRealtimePreview();
    setStatus("warning", "没有检测到声音", "未检测到清晰的麦克风输入。");
    setButtons("ready");
    return;
  }

  const wavBytes = encodeWav(recordingChunks, recordingSampleRate);
  const pcm16Base64 = float32ToPcm16Base64(flattenFloat32(recordingChunks), recordingSampleRate, 16000);
  const audioDataUrl = `data:audio/wav;base64,${arrayBufferToBase64(wavBytes.buffer)}`;
  const settingsSnapshot = createFinalTranscriptionSnapshot();
  const transcriptionRequest = {
    audioDataUrl,
    pcm16Base64,
    shortContext: recordingShortContext,
    transcriptionMode,
    settingsSnapshot,
    autoSendAfterTranscript
  };
  lastVoiceRequest = transcriptionRequest;

  if (recordingAsrMode === "realtime") {
    setButtons("transcribing");
    setStatus("transcribing", "正在生成最终文本", "实时内容只作为预览，正在用完整录音重新转写。");
    await cleanupRealtimePreview({ finish: true, shortContext: recordingShortContext, transcriptionMode });
    await runVoiceRequest(transcriptionRequest, {
      bytes: wavBytes.byteLength,
      retry: false
    });
    recordingChunks = [];
    recordingShortContext = "";
    return;
  }

  await runVoiceRequest(transcriptionRequest, {
    bytes: wavBytes.byteLength,
    retry: false
  });
  recordingChunks = [];
  recordingShortContext = "";
}

async function runVoiceRequest(request, { bytes = 0, retry = false } = {}) {
  if (!request?.audioDataUrl) {
    setStatus("warning", "没有可重试内容", "请先录制一段语音。");
    setButtons("ready");
    return;
  }
  if (isRecording || isTranscribing) {
    setStatus("warning", "正在处理", "请先完成当前录音或转写。");
    return;
  }

  isTranscribing = true;
  setButtons("transcribing");
  const transcriptionMode = normalizeTranscriptionMode(request.transcriptionMode);
  const modeDetail = transcriptionMode === "fast"
    ? "快速模式：仅执行语音识别。"
    : "稳定模式：先转写，再进行文本清理。";
  setStatus("transcribing", retry ? "正在重试" : "正在转写", modeDetail);

  try {
    logRenderer(retry ? "mimo: retry start" : "mimo: transcribe start", bytes ? `bytes=${bytes}` : "");
    const transcript = await window.mimoInput.transcribe({
      audioDataUrl: request.audioDataUrl,
      pcm16Base64: request.pcm16Base64,
      shortContext: request.shortContext,
      transcriptionMode,
      settingsSnapshot: request.settingsSnapshot
    });
    logRenderer(retry ? "mimo: retry done" : "mimo: transcribe done", `chars=${transcript.length}`);
    await handleTranscriptResult(transcript, {
      retry,
      autoSendAfterTranscript: request.autoSendAfterTranscript,
      copyAfterTranscript: request.copyAfterTranscript
    });
  } catch (error) {
    logRenderer(retry ? "mimo: retry failed" : "mimo: transcribe failed", error.message || String(error));
    setStatus("error", retry ? "重试失败" : "请求失败", error.message || String(error));
  } finally {
    isTranscribing = false;
    setButtons("ready");
  }
}

async function handleTranscriptResult(transcript, { retry = false, autoSendAfterTranscript = false, copyAfterTranscript = false } = {}) {
  resultText.value = transcript || "";
  setButtons("ready");
  if (transcript) {
    if (retry) {
      await showResultWindow();
    }
    if (autoSendAfterTranscript) {
      setStatus("transcribing", "正在写入", "正在粘贴到上一个焦点应用。");
      await sendResult({ hideAfterSend: true });
      return;
    }
    if (copyAfterTranscript) {
      await copyResult({ silent: true });
      setStatus("ready", retry ? "重试完成，已复制" : "已复制", "结果已写入剪贴板，也可以在窗口中查看或发送。");
    } else {
      setStatus("ready", retry ? "重试完成" : "可以发送", "确认文本后按 Ctrl+Enter 发送，或点击复制。");
    }
  } else {
    setStatus("warning", "没有识别到语音", "请靠近麦克风再试一次。");
  }
}

async function retryLastVoiceRequest() {
  if (!lastVoiceRequest) {
    setStatus("warning", "没有可重试内容", "请先录制一段语音。");
    setButtons("ready");
    return;
  }
  await runVoiceRequest(
    {
      ...lastVoiceRequest,
      autoSendAfterTranscript: false,
      copyAfterTranscript: true
    },
    { retry: true }
  );
}

function startMimoPreviewLoop() {
  stopMimoPreviewLoop();
  mimoPreviewRunId += 1;
  mimoPreviewLastSampleCount = 0;
  const runId = mimoPreviewRunId;
  mimoPreviewTimer = window.setInterval(() => {
    runMimoPreviewTick(runId).catch((error) => {
      logRenderer("mimo realtime preview: tick failed", error.message || String(error));
    });
  }, 2600);
  window.setTimeout(() => {
    runMimoPreviewTick(runId).catch((error) => {
      logRenderer("mimo realtime preview: first tick failed", error.message || String(error));
    });
  }, 1400);
}

function stopMimoPreviewLoop() {
  if (mimoPreviewTimer) {
    window.clearInterval(mimoPreviewTimer);
    mimoPreviewTimer = 0;
  }
  mimoPreviewRunId += 1;
  mimoPreviewInFlight = false;
  mimoPreviewLastSampleCount = 0;
}

async function runMimoPreviewTick(runId) {
  if (!isRecording || !usesMimoPollingPreview() || mimoPreviewInFlight || runId !== mimoPreviewRunId) return;
  if (recordingSampleCount < recordingSampleRate * 1.2) return;
  if (recordingSampleCount - mimoPreviewLastSampleCount < recordingSampleRate * 1.0) return;

  const chunks = recordingChunks.slice();
  const sampleRate = recordingSampleRate;
  const sampleCount = recordingSampleCount;
  if (!chunks.length) return;

  mimoPreviewInFlight = true;
  mimoPreviewLastSampleCount = sampleCount;
  try {
    const wavBytes = encodeWav(chunks, sampleRate);
    const audioDataUrl = `data:audio/wav;base64,${arrayBufferToBase64(wavBytes.buffer)}`;
    const previewSnapshot = {
      ...createSettingsSnapshot(),
      asrMode: "batch",
      transcriptionMode: "fast"
    };
    const transcript = await window.mimoInput.transcribe({
      audioDataUrl,
      shortContext: "",
      transcriptionMode: "fast",
      settingsSnapshot: previewSnapshot
    });
    if (runId !== mimoPreviewRunId || !isRecording || !usesMimoPollingPreview()) return;
    if (transcript) {
      resultText.value = transcript;
      setStatus("recording", "MiMo 实时预览", transcript);
      scheduleRecordingResize();
    }
  } finally {
    if (runId === mimoPreviewRunId) {
      mimoPreviewInFlight = false;
    }
  }
}

async function cleanupRealtimePreview({ finish = false, shortContext = "", transcriptionMode = recordingTranscriptionMode } = {}) {
  if (recordingAsrMode !== "realtime") return "";
  if (appSettings.asrProvider === "mimo") {
    const previewText = resultText.value.trim();
    stopMimoPreviewLoop();
    logRenderer("mimo realtime preview: stopped", `chars=${previewText.length}`);
    return previewText;
  }
  try {
    if (finish) {
      const previewText = await window.mimoInput.finishRealtimeAsr({
        clean: false,
        shortContext,
        transcriptionMode
      });
      logRenderer("realtime preview: finished", `chars=${String(previewText || "").length}`);
      return previewText || "";
    }
    await window.mimoInput.cancelRealtimeAsr?.();
    logRenderer("realtime preview: cancelled");
  } catch (error) {
    logRenderer("realtime preview: cleanup failed", error.message || String(error));
    if (finish) {
      setStatus("warning", "实时预览结束失败", "已继续使用完整录音生成最终文本。");
    }
  }
  return "";
}

async function cancelRecording() {
  await window.mimoInput.clearRecordingKeys();
  if (!isRecording) {
    await window.mimoInput.hide();
    return;
  }
  isRecording = false;
  try {
    processorNode?.disconnect();
    silenceGainNode?.disconnect();
    sourceNode?.disconnect();
    mediaStream?.getTracks().forEach((track) => track.stop());
    await audioContext?.close();
  } catch {
    // Best-effort cleanup for an interrupted recording.
  }
  await cleanupRealtimePreview();
  recordingChunks = [];
  levelMeter.hidden = true;
  setLevel(0);
  setButtons("ready");
  setStatus("ready", "已取消", "");
  await window.mimoInput.hide();
}

async function openMicrophoneStream() {
  const baseAudio = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  };

  if (!appSettings.microphoneDeviceId) {
    return navigator.mediaDevices.getUserMedia({ audio: baseAudio });
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        ...baseAudio,
        deviceId: { exact: appSettings.microphoneDeviceId }
      }
    });
  } catch (error) {
    const fallbackStream = await navigator.mediaDevices.getUserMedia({ audio: baseAudio });
    appSettings = await window.mimoInput.saveSettings({
      microphoneDeviceId: "",
      microphoneLabel: "",
      microphoneGroupId: ""
    });
    microphoneSelect.value = "";
    microphoneHint.textContent = "已保存的麦克风不可用，正在使用系统默认麦克风。";
    return fallbackStream;
  }
}

function updateAudioStats(input) {
  let sum = 0;
  let peak = recordingPeak;
  for (let i = 0; i < input.length; i += 1) {
    const sample = input[i];
    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
    sum += sample * sample;
  }
  recordingPeak = peak;
  recordingRmsSum += sum;
  recordingSampleCount += input.length;
  const blockRms = Math.sqrt(sum / input.length);
  setLevel(Math.min(1, blockRms * 18));
}

function buildShortContext() {
  const parts = [];
  if (contextInput.value.trim()) parts.push(contextInput.value.trim());
  return parts.join("\n");
}

async function copyResult({ silent = false } = {}) {
  const text = resultText.value.trim();
  if (!text) return;
  try {
    await window.mimoInput.copyText(text);
    if (!silent) {
      setStatus("ready", "已复制", "结果已写入剪贴板。");
    }
  } catch (error) {
    setStatus("error", "复制失败", error.message || String(error));
  } finally {
    setButtons("ready");
  }
}

async function sendResult({ hideAfterSend = false } = {}) {
  const text = resultText.value.trim();
  if (!text) return;
  setStatus("transcribing", "正在写入", "正在粘贴到上一个焦点应用。");
  try {
    await window.mimoInput.injectText(text);
    setStatus("ready", "已发送", "按快捷键开始下一次录音。");
    if (hideAfterSend) {
      await window.mimoInput.hide();
    }
  } catch (error) {
    setStatus("error", "写入失败", error.message || String(error));
  } finally {
    setButtons("ready");
  }
}

async function refreshMicrophones({ requestPermission = false } = {}) {
  try {
    if (requestPermission) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const microphones = devices.filter((device) => device.kind === "audioinput");
    microphoneSelect.innerHTML = "";
    microphoneSelect.append(new Option("系统默认麦克风", ""));

    microphones.forEach((device, index) => {
      const label = device.label || `麦克风 ${index + 1}`;
      microphoneSelect.append(new Option(label, device.deviceId));
    });

    if (appSettings.microphoneDeviceId && microphones.some((device) => device.deviceId === appSettings.microphoneDeviceId)) {
      microphoneSelect.value = appSettings.microphoneDeviceId;
    } else {
      if (appSettings.microphoneDeviceId) {
        appSettings = await window.mimoInput.saveSettings({
          microphoneDeviceId: "",
          microphoneLabel: "",
          microphoneGroupId: ""
        });
        microphoneHint.textContent = "找不到已保存的麦克风，正在使用系统默认麦克风。";
      }
      microphoneSelect.value = "";
    }
  } catch (error) {
    setStatus("error", "麦克风列表读取失败", error.message || String(error));
  }
}

async function saveMicrophoneSelection() {
  const selected = [...microphoneSelect.options].find((option) => option.value === microphoneSelect.value);
  appSettings = await window.mimoInput.saveSettings({
    microphoneDeviceId: microphoneSelect.value,
    microphoneLabel: selected?.textContent || "",
    microphoneGroupId: ""
  });
  setStatus("ready", "设置已保存", microphoneSelect.value ? "麦克风选择已更新。" : "正在使用系统默认麦克风。");
  microphoneHint.textContent = microphoneSelect.value ? `已选择：${selected?.textContent || "麦克风"}` : "正在使用系统默认麦克风。";
}

function beginHotkeyCapture() {
  hotkeyCaptureOriginalValue = hotkeyInput.value;
  hotkeyInput.readOnly = true;
  hotkeyInput.classList.add("is-capturing");
  hotkeyHint.hidden = false;
}

function endHotkeyCapture({ restore = false } = {}) {
  if (restore) {
    hotkeyInput.value = hotkeyCaptureOriginalValue;
  }
  hotkeyInput.readOnly = false;
  hotkeyInput.classList.remove("is-capturing");
  hotkeyHint.hidden = true;
}

function formatHotkey(event) {
  const baseKey = normalizeHotkeyKey(event);
  if (!baseKey) return "";

  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push("CommandOrControl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");

  return [...parts, baseKey].join("+");
}

function normalizeHotkeyKey(event) {
  const key = event.key;
  const code = event.code;
  const modifierKeys = new Set(["Alt", "AltGraph", "Control", "Meta", "OS", "Shift"]);
  if (!key || modifierKeys.has(key)) return "";

  if (/^F([1-9]|1\d|2[0-4])$/.test(key)) return key;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;

  const keyMap = {
    " ": "Space",
    Spacebar: "Space",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Escape: "Esc",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Home: "Home",
    End: "End",
    Insert: "Insert",
    Tab: "Tab",
    Enter: "Enter",
    "+": "Plus",
    "-": "-",
    "=": "=",
    ",": ",",
    ".": ".",
    "/": "/",
    "\\": "\\",
    ";": ";",
    "'": "'",
    "[": "[",
    "]": "]",
    "`": "`"
  };

  return keyMap[key] || "";
}

function handleHotkeyCaptureKeydown(event) {
  event.preventDefault();
  event.stopPropagation();

  if (event.key === "Escape") {
    endHotkeyCapture({ restore: true });
    hotkeyInput.blur();
    return;
  }

  if (event.key === "Backspace" || event.key === "Delete") {
    hotkeyInput.value = "";
    return;
  }

  const hotkey = formatHotkey(event);
  if (hotkey) {
    hotkeyInput.value = hotkey;
    endHotkeyCapture();
    hotkeyInput.blur();
    saveHotkeySetting(hotkey);
  }
}

async function saveHotkeySetting(hotkey) {
  try {
    appSettings = await window.mimoInput.saveSettings({ hotkey });
    const status = await refreshStatus();
    if (status.registeredHotkeys?.includes(hotkey)) {
      setStatus("ready", "快捷键已保存", `已注册：${hotkey}`);
    } else {
      setStatus("warning", "快捷键不可用", `无法注册 ${hotkey}，请换一个组合。`);
    }
  } catch (error) {
    setStatus("error", "快捷键保存失败", error.message || String(error));
  }
}

function fillSettingsForm(status) {
  apiKeyInput.value = appSettings.apiKey || "";
  apiKeyInput.placeholder = status.hasEnvApiKey
    ? "正在使用 MIMO_API_KEY 环境变量"
    : "粘贴 MiMo API Key 或 token plan Key";
  baseUrlInput.value = appSettings.baseUrl || "";
  asrProviderSelect.value = appSettings.asrProvider || "mimo";
  asrModeSelect.value = normalizeAsrMode(appSettings.asrMode);
  if (asrProviderSelect.value === "qwen3-asr") {
    asrModelInput.value = normalizeQwenAsrModel(appSettings.asrModel);
    asrRealtimeModelInput.value = normalizeQwenRealtimeModel(appSettings.asrRealtimeModel || appSettings.asrModel);
    asrBaseUrlInput.value = appSettings.asrBaseUrl || QWEN_ASR_OPENAI_BASE_URL;
  } else if (asrProviderSelect.value === "fun-asr") {
    asrModelInput.value = normalizeFunAsrModel(appSettings.asrModel);
    asrRealtimeModelInput.value = normalizeFunAsrRealtimeModel(appSettings.asrRealtimeModel || appSettings.asrModel);
    asrBaseUrlInput.value = appSettings.asrBaseUrl || FUN_ASR_REST_BASE_URL;
  } else {
    asrModelInput.value = normalizeMimoAsrModel(appSettings.asrModel || appSettings.model);
    asrRealtimeModelInput.value = appSettings.asrRealtimeModel || QWEN_ASR_REALTIME_MODEL;
    asrBaseUrlInput.value = appSettings.asrBaseUrl || "";
  }
  asrApiKeyInput.value = appSettings.asrApiKey || "";
  asrLanguageInput.value = appSettings.asrLanguage || "";
  asrEnableItnInput.checked = Boolean(appSettings.asrEnableItn);
  cleanerProviderSelect.value = appSettings.cleanerProvider || "mimo";
  cleanerModelInput.value = appSettings.cleanerModel || appSettings.model || "mimo-v2.5";
  cleanerBaseUrlInput.value = appSettings.cleanerBaseUrl || "";
  cleanerApiKeyInput.value = appSettings.cleanerApiKey || "";
  hotkeyInput.value = appSettings.hotkey || "CommandOrControl+Alt+M";
  renderTranscriptionMode(normalizeTranscriptionMode(appSettings.transcriptionMode));
}

function renderTranscriptionMode(mode) {
  for (const button of [stableModeBtn, fastModeBtn]) {
    const active = button.dataset.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

async function setTranscriptionMode(mode) {
  const transcriptionMode = normalizeTranscriptionMode(mode);
  renderTranscriptionMode(transcriptionMode);
  appSettings = await window.mimoInput.saveSettings({ transcriptionMode });
  renderTranscriptionMode(normalizeTranscriptionMode(appSettings.transcriptionMode));
  setStatus(
    "ready",
    "设置已保存",
    transcriptionMode === "fast" ? "快速模式只执行语音识别。" : "稳定模式会执行相互隔离的两步处理。"
  );
}

function applyWindowMode(mode) {
  currentWindowMode = mode;
  document.body.classList.toggle("recording-mode", mode === "recording" || mode === "compact");
  document.body.classList.toggle("recording-active", mode === "recording");
  document.body.classList.toggle("settings-open", mode === "settings");
  document.body.classList.toggle("result-open", mode === "result");
  if (mode === "recording" || mode === "compact" || mode === "result") {
    settingsPanel.hidden = true;
  }
  scheduleRecordingResize();
}

async function showResultWindow() {
  await window.mimoInput.openResultWindow();
  applyWindowMode("result");
  settingsPanel.hidden = true;
}

async function saveAllSettings({ clearKeys = false } = {}) {
  normalizeProviderSettingsDraft();
  const nextSettings = {
    apiKey: apiKeyInput.value.trim(),
    baseUrl: baseUrlInput.value.trim(),
    asrProvider: asrProviderSelect.value,
    asrMode: normalizeAsrMode(asrModeSelect.value),
    asrModel: normalizeAsrModelForSelectedProvider(asrModelInput.value),
    asrRealtimeModel: normalizeRealtimeModelForSelectedProvider(asrRealtimeModelInput.value),
    asrBaseUrl: asrBaseUrlInput.value.trim(),
    asrApiKey: asrApiKeyInput.value.trim(),
    asrLanguage: asrLanguageInput.value.trim(),
    asrEnableItn: asrEnableItnInput.checked,
    cleanerProvider: cleanerProviderSelect.value,
    cleanerModel: cleanerModelInput.value.trim(),
    cleanerBaseUrl: cleanerBaseUrlInput.value.trim(),
    cleanerApiKey: cleanerApiKeyInput.value.trim(),
    hotkey: hotkeyInput.value.trim() || "CommandOrControl+Alt+M",
    microphoneDeviceId: microphoneSelect.value,
    transcriptionMode: normalizeTranscriptionMode(appSettings.transcriptionMode)
  };
  if (!clearKeys) {
    const inputBySetting = {
      apiKey: apiKeyInput,
      baseUrl: baseUrlInput,
      asrApiKey: asrApiKeyInput,
      asrBaseUrl: asrBaseUrlInput,
      cleanerApiKey: cleanerApiKeyInput,
      cleanerBaseUrl: cleanerBaseUrlInput
    };
    for (const [key, input] of Object.entries(inputBySetting)) {
      if (!nextSettings[key] && appSettings[key] && document.activeElement !== input) {
        nextSettings[key] = appSettings[key];
      }
    }
  }
  appSettings = await window.mimoInput.saveSettings({
    ...nextSettings
  });
  await refreshStatus();
  setStatus("ready", "设置已保存", "API、URL、快捷键和麦克风设置已更新。");
}

async function testConnection() {
  normalizeProviderSettingsDraft();
  setStatus("transcribing", "正在测试", "正在检查当前 API 配置。");
  testConnectionBtn.disabled = true;
  try {
    await saveAllSettings();
    const checks = await window.mimoInput.testConnection();
    const detail = checks.map((check) => `${check.name}：${check.detail}`).join("；");
    setStatus("ready", "连接可用", detail);
  } catch (error) {
    setStatus("error", "连接测试失败", error.message || String(error));
  } finally {
    testConnectionBtn.disabled = false;
    setButtons("ready");
  }
}

function encodeWav(chunks, sampleRate) {
  const samples = flattenFloat32(chunks);
  const dataLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

function flattenFloat32(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function writeString(view, offset, value) {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function float32ToPcm16Base64(input, sourceSampleRate, targetSampleRate = sourceSampleRate) {
  const samples = resampleFloat32(input, sourceSampleRate, targetSampleRate);
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return arrayBufferToBase64(bytes.buffer);
}

function resampleFloat32(input, sourceSampleRate, targetSampleRate) {
  if (!sourceSampleRate || !targetSampleRate || sourceSampleRate === targetSampleRate) {
    return input;
  }
  const ratio = sourceSampleRate / targetSampleRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const sourceIndex = i * ratio;
    const index = Math.floor(sourceIndex);
    const nextIndex = Math.min(index + 1, input.length - 1);
    const weight = sourceIndex - index;
    output[i] = input[index] * (1 - weight) + input[nextIndex] * weight;
  }
  return output;
}

recordBtn.addEventListener("click", () => startRecording({ autoSend: false }).catch((error) => {
  setStatus("error", "麦克风打开失败", error.message || String(error));
  setButtons("ready");
  levelMeter.hidden = true;
}));
stopBtn.addEventListener("click", stopRecording);
recordingCancelBtn.addEventListener("click", cancelRecording);
copyBtn.addEventListener("click", () => copyResult());
sendBtn.addEventListener("click", sendResult);
closeBtn.addEventListener("click", () => window.mimoInput.hide());
settingsBtn.addEventListener("click", async () => {
  await window.mimoInput.openSettings();
});
refreshDevicesBtn.addEventListener("click", () => refreshMicrophones({ requestPermission: true }));
microphoneSelect.addEventListener("change", saveMicrophoneSelection);
asrProviderSelect.addEventListener("change", normalizeProviderSettingsDraft);
asrModeSelect.addEventListener("change", normalizeProviderSettingsDraft);
asrModelInput.addEventListener("blur", normalizeProviderSettingsDraft);
asrRealtimeModelInput.addEventListener("blur", normalizeProviderSettingsDraft);
stableModeBtn.addEventListener("click", () => setTranscriptionMode("stable"));
fastModeBtn.addEventListener("click", () => setTranscriptionMode("fast"));
saveSettingsBtn.addEventListener("click", saveAllSettings);
testConnectionBtn.addEventListener("click", testConnection);
clearApiKeyBtn.addEventListener("click", async () => {
  apiKeyInput.value = "";
  await saveAllSettings({ clearKeys: true });
});
resultText.addEventListener("input", () => setButtons("ready"));
hotkeyInput.addEventListener("focus", beginHotkeyCapture);
hotkeyInput.addEventListener("click", beginHotkeyCapture);
hotkeyInput.addEventListener("blur", () => endHotkeyCapture());
hotkeyInput.addEventListener("keydown", handleHotkeyCaptureKeydown);
hotkeyInput.addEventListener("beforeinput", (event) => event.preventDefault());

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    cancelRecording();
  } else if ((event.key === "Backspace" || event.key === "Delete") && isRecording) {
    event.preventDefault();
    cancelRecording();
  } else if (event.key === "Enter" && isRecording) {
    event.preventDefault();
    stopRecording();
  } else if (event.key === "Enter" && event.ctrlKey) {
    event.preventDefault();
    autoSendAfterTranscript = false;
    sendResult();
  }
});

window.mimoInput.onHotkeyRecord(() => {
  logRenderer("event: hotkey-record");
  applyWindowMode("recording");
  startRecording({ autoSend: true }).catch((error) => {
    setStatus("error", "麦克风打开失败", error.message || String(error));
    setButtons("ready");
  });
});

window.mimoInput.onRecordingCommand((command) => {
  logRenderer("event: recording-command", command);
  if (command === "stop") {
    stopRecording();
  } else if (command === "cancel") {
    cancelRecording();
  }
});

window.mimoInput.onRetryLastVoiceRequest(() => {
  logRenderer("event: retry-last-voice-request");
  retryLastVoiceRequest();
});

window.mimoInput.onPartialTranscript((text) => {
  if (!isRecording && !isTranscribing) return;
  resultText.value = text || "";
  if (text) {
    setStatus("recording", "实时结果", text);
  }
  scheduleRecordingResize();
  setButtons(isRecording ? "recording" : "transcribing");
});

window.mimoInput.onOpenSettings(async () => {
  applyWindowMode("settings");
  settingsPanel.hidden = false;
  await refreshStatus();
  await refreshMicrophones({ requestPermission: true });
});

window.mimoInput.onWindowMode((mode) => {
  applyWindowMode(mode);
});

applyWindowMode("compact");
refreshStatus().then(() => refreshMicrophones());
setButtons("ready");
