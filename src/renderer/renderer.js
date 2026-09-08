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
const meetingBtn = document.getElementById("meetingBtn");
const minimizeBtn = document.getElementById("minimizeBtn");
const maximizeBtn = document.getElementById("maximizeBtn");
const settingsPanel = document.getElementById("settingsPanel");
const meetingPanel = document.getElementById("meetingPanel");
const filePanel = document.getElementById("filePanel");
const meetingUi = window.MeetingUi || {};
const microphoneSelect = document.getElementById("microphoneSelect");
const microphoneHint = document.getElementById("microphoneHint");
const refreshDevicesBtn = document.getElementById("refreshDevicesBtn");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");
const asrProviderSelect = document.getElementById("asrProviderSelect");
const asrModeSelect = document.getElementById("asrModeSelect");
const asrModelPresetSelect = document.getElementById("asrModelPresetSelect");
const asrCustomModelField = document.getElementById("asrCustomModelField");
const asrModelInput = document.getElementById("asrModelInput");
const asrRealtimeModelPresetSelect = document.getElementById("asrRealtimeModelPresetSelect");
const asrCustomRealtimeModelField = document.getElementById("asrCustomRealtimeModelField");
const asrRealtimeModelInput = document.getElementById("asrRealtimeModelInput");
const asrBaseUrlInput = document.getElementById("asrBaseUrlInput");
const asrApiKeyInput = document.getElementById("asrApiKeyInput");
const asrLanguageInput = document.getElementById("asrLanguageInput");
const asrEnableItnInput = document.getElementById("asrEnableItnInput");
const cleanerProviderSelect = document.getElementById("cleanerProviderSelect");
const cleanerModelPresetSelect = document.getElementById("cleanerModelPresetSelect");
const cleanerCustomModelField = document.getElementById("cleanerCustomModelField");
const cleanerModelInput = document.getElementById("cleanerModelInput");
const cleanerBaseUrlInput = document.getElementById("cleanerBaseUrlInput");
const cleanerApiKeyInput = document.getElementById("cleanerApiKeyInput");
const meetingQwenModelPresetSelect = document.getElementById("meetingQwenModelPresetSelect");
const meetingQwenCustomModelField = document.getElementById("meetingQwenCustomModelField");
const meetingQwenModelInput = document.getElementById("meetingQwenModelInput");
const meetingQwenBaseUrlInput = document.getElementById("meetingQwenBaseUrlInput");
const meetingQwenApiKeyInput = document.getElementById("meetingQwenApiKeyInput");
const meetingFileAsrProviderSelect = document.getElementById("meetingFileAsrProviderSelect");
const meetingFileAsrModelPresetSelect = document.getElementById("meetingFileAsrModelPresetSelect");
const meetingFileAsrCustomModelField = document.getElementById("meetingFileAsrCustomModelField");
const meetingFileAsrModelInput = document.getElementById("meetingFileAsrModelInput");
const meetingFileAsrBaseUrlInput = document.getElementById("meetingFileAsrBaseUrlInput");
const meetingFileAsrApiKeyInput = document.getElementById("meetingFileAsrApiKeyInput");
const meetingFunAsrModelPresetSelect = document.getElementById("meetingFunAsrModelPresetSelect");
const meetingFunAsrCustomModelField = document.getElementById("meetingFunAsrCustomModelField");
const meetingFunAsrModelInput = document.getElementById("meetingFunAsrModelInput");
const meetingFunAsrBaseUrlInput = document.getElementById("meetingFunAsrBaseUrlInput");
const meetingFunAsrApiKeyInput = document.getElementById("meetingFunAsrApiKeyInput");
const meetingOssRegionInput = document.getElementById("meetingOssRegionInput");
const meetingOssEndpointInput = document.getElementById("meetingOssEndpointInput");
const meetingOssBucketInput = document.getElementById("meetingOssBucketInput");
const meetingOssPrefixInput = document.getElementById("meetingOssPrefixInput");
const meetingOssAccessKeyIdInput = document.getElementById("meetingOssAccessKeyIdInput");
const meetingOssAccessKeySecretInput = document.getElementById("meetingOssAccessKeySecretInput");
const meetingUploadBitrateSelect = document.getElementById("meetingUploadBitrateSelect");
const meetingSettingsModeBasicBtn = document.getElementById("meetingSettingsModeBasicBtn");
const meetingSettingsModeEnhancedBtn = document.getElementById("meetingSettingsModeEnhancedBtn");
const meetingFunTestBtn = document.getElementById("meetingFunTestBtn");
const meetingOssTestBtn = document.getElementById("meetingOssTestBtn");
const meetingFunTestResult = document.getElementById("meetingFunTestResult");
const meetingOssTestResult = document.getElementById("meetingOssTestResult");
const meetingAnalysisModelPresetSelect = document.getElementById("meetingAnalysisModelPresetSelect");
const meetingAnalysisCustomModelField = document.getElementById("meetingAnalysisCustomModelField");
const meetingAnalysisModelInput = document.getElementById("meetingAnalysisModelInput");
const meetingAnalysisBaseUrlInput = document.getElementById("meetingAnalysisBaseUrlInput");
const meetingAnalysisApiKeyInput = document.getElementById("meetingAnalysisApiKeyInput");
const meetingAnalysisContextInput = document.getElementById("meetingAnalysisContextInput");
const meetingAnalysisMaxOutputInput = document.getElementById("meetingAnalysisMaxOutputInput");
const meetingAnalysisReasoningInput = document.getElementById("meetingAnalysisReasoningInput");
const meetingAnalysisTimeoutInput = document.getElementById("meetingAnalysisTimeoutInput");
const hotkeyInput = document.getElementById("hotkeyInput");
const hotkeyHint = document.getElementById("hotkeyHint");
const hotkeyStatus = document.getElementById("hotkeyStatus");
const meetingHotkeyInput = document.getElementById("meetingHotkeyInput");
const meetingHotkeyHint = document.getElementById("meetingHotkeyHint");
const meetingHotkeyStatus = document.getElementById("meetingHotkeyStatus");
const stableModeBtn = document.getElementById("stableModeBtn");
const fastModeBtn = document.getElementById("fastModeBtn");
const testConnectionBtn = document.getElementById("testConnectionBtn");
const settingsTabButtons = [...document.querySelectorAll("[data-settings-tab]")];
const settingsTabPanels = [...document.querySelectorAll("[data-settings-panel]")];
const secretToggleButtons = [...document.querySelectorAll("[data-secret-toggle]")];
const secretCopyButtons = [...document.querySelectorAll("[data-secret-copy]")];
const audioTools = window.OpenVoiceAudio;

const TRANSCRIPTION_MODES = new Set(["stable", "fast"]);
const ASR_MODES = new Set(["batch", "realtime"]);
const QWEN_ASR_OPENAI_MODEL = "qwen3-asr-flash";
const QWEN_ASR_OPENAI_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const QWEN_ASR_REALTIME_MODEL = "qwen3-asr-flash-realtime";
const MIMO_ASR_MODEL = "mimo-v2.5-asr";
const FUN_ASR_MODEL = "fun-asr";
const FUN_ASR_REST_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
const FUN_ASR_REALTIME_MODEL = "fun-asr-realtime";
const CUSTOM_ASR_MODEL = "__custom__";
const CUSTOM_ASR_REALTIME_MODEL = "__custom_realtime__";
const ASR_MODEL_PRESETS = new Set([MIMO_ASR_MODEL, QWEN_ASR_OPENAI_MODEL, FUN_ASR_MODEL]);
const ASR_REALTIME_MODEL_PRESETS = new Set([
  MIMO_ASR_MODEL,
  QWEN_ASR_REALTIME_MODEL,
  "qwen3-asr-flash-realtime-2026-02-10",
  FUN_ASR_REALTIME_MODEL
]);
const CUSTOM_CLEANER_MODEL = "__custom__";
const CLEANER_MODEL_PRESETS = new Set(["gpt-5.4-mini", "grok-4.5", "mimo-v2.5", "mimo-v2.5-pro"]);
const MIMO_CLEANER_MODELS = new Set(["mimo-v2.5", "mimo-v2.5-pro"]);
const MEETING_QWEN_MODEL_PRESETS = new Set(["qwen3-asr-flash", "qwen3-asr-flash-filetrans"]);
const MEETING_FUN_MODEL_PRESETS = new Set(["fun-asr", "fun-asr-mtl"]);
const MEETING_FILE_ASR_MODEL_PRESETS = new Set([
  "mimo-v2.5-asr",
  "qwen3-asr-flash",
  "qwen3-asr-flash-filetrans",
  "fun-asr"
]);
const MEETING_ANALYSIS_MODEL_PRESETS = new Set([
  "gpt-5.4-mini",
  "gpt-5.5",
  "grok-4.5",
  "glm-5.2",
  "mimo-v2.5-pro"
]);

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
let recordingAudioPolicy = {
  sampleRate: 16000,
  targetSegmentSeconds: 180,
  hardSegmentSeconds: 210,
  prefetchSegments: true
};
let recordingSegmentState = null;
let silenceGainNode;
let isRecording = false;
let isTranscribing = false;
let appSettings = {};
let autoSendAfterTranscript = false;
let currentWindowMode = "compact";
let activeHotkeyCapture = null;
let recordingTranscriptionMode = "stable";
let recordingShortContext = "";
let recordingAsrMode = "batch";
let lastVoiceRequest = null;
let resizeTimer = 0;
let mimoPreviewTimer = 0;
let mimoPreviewInFlight = false;
let mimoPreviewLastSampleCount = 0;
let mimoPreviewRunId = 0;
let activeAsrModelDraft = "";
let activeAsrProviderDraft = "mimo";
let activeCleanerModelDraft = "";
let activeCleanerProviderDraft = "mimo";
let activeMeetingQwenModelDraft = "";
let activeMeetingFileAsrModelDraft = "";
let activeMeetingFunModelDraft = "";
let activeMeetingAnalysisModelDraft = "";
let activeSettingsTab = "general";

function createSettingsSnapshot() {
  return {
    model: appSettings.model,
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
  if (
    !value
    || value === "mimo-v2.5"
    || value === MIMO_ASR_MODEL
    || value === QWEN_ASR_OPENAI_MODEL
    || value === FUN_ASR_REALTIME_MODEL
  ) {
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
  if (
    !value
    || value === "mimo-v2.5"
    || value === MIMO_ASR_MODEL
    || value === QWEN_ASR_OPENAI_MODEL
    || value === QWEN_ASR_REALTIME_MODEL
    || value === "qwen3-asr-flash-realtime-2026-02-10"
    || value === FUN_ASR_MODEL
  ) {
    return FUN_ASR_REALTIME_MODEL;
  }
  return value;
}

function normalizeProviderSettingsDraft() {
  syncAsrRealtimeModelOptions(asrProviderSelect.value);
  let realtimeModel = selectedAsrRealtimeModel();
  if (asrProviderSelect.value === "qwen3-asr") {
    asrModelInput.value = normalizeQwenAsrModel(asrModelInput.value);
    realtimeModel = normalizeQwenRealtimeModel(realtimeModel);
    if (!asrBaseUrlInput.value.trim()) {
      asrBaseUrlInput.value = QWEN_ASR_OPENAI_BASE_URL;
    }
  } else if (asrProviderSelect.value === "fun-asr") {
    asrModelInput.value = normalizeFunAsrModel(asrModelInput.value);
    realtimeModel = normalizeFunAsrRealtimeModel(realtimeModel);
    if (!asrBaseUrlInput.value.trim() || asrBaseUrlInput.value.trim() === QWEN_ASR_OPENAI_BASE_URL) {
      asrBaseUrlInput.value = FUN_ASR_REST_BASE_URL;
    }
  } else if (asrProviderSelect.value === "mimo") {
    asrModelInput.value = normalizeMimoAsrModel(asrModelInput.value);
    realtimeModel = normalizeMimoAsrModel(realtimeModel);
  }
  fillAsrRealtimeModel(realtimeModel);
}

function fillAsrModel(model) {
  const value = String(model || "").trim() || MIMO_ASR_MODEL;
  asrModelInput.value = value;
  syncSavedModelOptions(asrModelPresetSelect, appSettings.asrProfiles, ASR_MODEL_PRESETS);
  asrModelPresetSelect.value = ASR_MODEL_PRESETS.has(value) || appSettings.asrProfiles?.[value]
    ? value
    : CUSTOM_ASR_MODEL;
  activeAsrModelDraft = value;
  renderCustomAsrModelField();
}

function selectedAsrModel() {
  return asrModelPresetSelect.value === CUSTOM_ASR_MODEL
    ? asrModelInput.value.trim()
    : asrModelPresetSelect.value;
}

function renderCustomAsrModelField() {
  asrCustomModelField.hidden = asrModelPresetSelect.value !== CUSTOM_ASR_MODEL;
}

function fillAsrRealtimeModel(model) {
  const value = String(model || "").trim() || defaultRealtimeModelForProvider(asrProviderSelect.value);
  asrRealtimeModelInput.value = value;
  asrRealtimeModelPresetSelect.value = ASR_REALTIME_MODEL_PRESETS.has(value)
    ? value
    : CUSTOM_ASR_REALTIME_MODEL;
  renderCustomAsrRealtimeModelField();
}

function selectedAsrRealtimeModel() {
  return asrRealtimeModelPresetSelect.value === CUSTOM_ASR_REALTIME_MODEL
    ? asrRealtimeModelInput.value.trim()
    : asrRealtimeModelPresetSelect.value;
}

function renderCustomAsrRealtimeModelField() {
  asrCustomRealtimeModelField.hidden = asrRealtimeModelPresetSelect.value !== CUSTOM_ASR_REALTIME_MODEL;
}

function syncAsrRealtimeModelOptions(provider) {
  for (const option of asrRealtimeModelPresetSelect.options) {
    const optionProvider = option.dataset.asrProvider;
    const compatible = !optionProvider || optionProvider === provider;
    option.hidden = !compatible;
    option.disabled = !compatible;
  }
}

function defaultRealtimeModelForProvider(provider) {
  if (provider === "qwen3-asr") return QWEN_ASR_REALTIME_MODEL;
  if (provider === "fun-asr") return FUN_ASR_REALTIME_MODEL;
  return MIMO_ASR_MODEL;
}

function handleAsrRealtimeModelPresetChange() {
  if (asrRealtimeModelPresetSelect.value === CUSTOM_ASR_REALTIME_MODEL) {
    asrRealtimeModelInput.value = "";
    renderCustomAsrRealtimeModelField();
    asrRealtimeModelInput.focus();
    return;
  }
  asrRealtimeModelInput.value = asrRealtimeModelPresetSelect.value;
  renderCustomAsrRealtimeModelField();
}

function syncSavedModelOptions(select, profiles, presetModels) {
  for (const option of [...select.querySelectorAll("option[data-saved-model]")]) {
    option.remove();
  }
  const customOption = [...select.options].find((option) => option.value === CUSTOM_ASR_MODEL || option.value === CUSTOM_CLEANER_MODEL);
  const savedModels = Object.keys(profiles || {})
    .map((model) => model.trim())
    .filter((model) => model && !presetModels.has(model))
    .sort((left, right) => left.localeCompare(right));
  for (const model of savedModels) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = `${model}（已保存）`;
    option.dataset.savedModel = "true";
    select.insertBefore(option, customOption || null);
  }
}

function defaultAsrProfile(model) {
  if (model === QWEN_ASR_OPENAI_MODEL) {
    return {
      provider: "qwen3-asr",
      mode: "realtime",
      realtimeModel: QWEN_ASR_REALTIME_MODEL,
      baseUrl: QWEN_ASR_OPENAI_BASE_URL,
      apiKey: "",
      language: "",
      enableItn: true
    };
  }
  if (model === FUN_ASR_MODEL) {
    return {
      provider: "fun-asr",
      mode: "realtime",
      realtimeModel: FUN_ASR_REALTIME_MODEL,
      baseUrl: FUN_ASR_REST_BASE_URL,
      apiKey: "",
      language: "",
      enableItn: true
    };
  }
  return {
    provider: "mimo",
    mode: "realtime",
    realtimeModel: MIMO_ASR_MODEL,
    baseUrl: "",
    apiKey: "",
    language: "",
    enableItn: false
  };
}

function cacheAsrProfileDraft(model, { provider = asrProviderSelect.value } = {}) {
  const value = String(model || "").trim();
  if (!value) return;
  appSettings.asrProfiles = {
    ...(appSettings.asrProfiles || {}),
    [value]: {
      provider,
      mode: normalizeAsrMode(asrModeSelect.value),
      realtimeModel: selectedAsrRealtimeModel(),
      baseUrl: asrBaseUrlInput.value.trim(),
      apiKey: asrApiKeyInput.value.trim(),
      language: asrLanguageInput.value.trim(),
      enableItn: asrEnableItnInput.checked
    }
  };
}

function loadAsrProfileDraft(model) {
  const profile = appSettings.asrProfiles?.[model] || defaultAsrProfile(model);
  fillAsrModel(model);
  asrProviderSelect.value = profile.provider;
  syncAsrRealtimeModelOptions(profile.provider);
  asrModeSelect.value = normalizeAsrMode(profile.mode);
  fillAsrRealtimeModel(profile.realtimeModel || defaultRealtimeModelForProvider(profile.provider));
  asrBaseUrlInput.value = profile.baseUrl || "";
  asrApiKeyInput.value = profile.apiKey || "";
  asrLanguageInput.value = profile.language || "";
  asrEnableItnInput.checked = Boolean(profile.enableItn);
  normalizeProviderSettingsDraft();
  activeAsrProviderDraft = asrProviderSelect.value;
}

function handleAsrModelPresetChange() {
  cacheAsrProfileDraft(activeAsrModelDraft);
  const model = asrModelPresetSelect.value;
  if (model === CUSTOM_ASR_MODEL) {
    asrModelInput.value = "";
    activeAsrModelDraft = "";
    renderCustomAsrModelField();
    asrModelInput.focus();
    return;
  }
  loadAsrProfileDraft(model);
}

function handleAsrProviderChange() {
  if (asrModelPresetSelect.value === CUSTOM_ASR_MODEL) {
    normalizeProviderSettingsDraft();
    return;
  }
  const modelByProvider = {
    mimo: MIMO_ASR_MODEL,
    "qwen3-asr": QWEN_ASR_OPENAI_MODEL,
    "fun-asr": FUN_ASR_MODEL
  };
  const nextModel = modelByProvider[asrProviderSelect.value] || MIMO_ASR_MODEL;
  if (nextModel !== activeAsrModelDraft) {
    cacheAsrProfileDraft(activeAsrModelDraft, { provider: activeAsrProviderDraft });
    loadAsrProfileDraft(nextModel);
  } else {
    normalizeProviderSettingsDraft();
    activeAsrProviderDraft = asrProviderSelect.value;
  }
}

function fillCleanerModel(model) {
  const value = String(model || "").trim() || "mimo-v2.5";
  syncSavedModelOptions(cleanerModelPresetSelect, appSettings.cleanerProfiles, CLEANER_MODEL_PRESETS);
  if (CLEANER_MODEL_PRESETS.has(value) || appSettings.cleanerProfiles?.[value]) {
    cleanerModelPresetSelect.value = value;
    cleanerModelInput.value = "";
  } else {
    cleanerModelPresetSelect.value = CUSTOM_CLEANER_MODEL;
    cleanerModelInput.value = value;
  }
  activeCleanerModelDraft = value;
  renderCustomCleanerModelField();
}

function selectedCleanerModel() {
  return cleanerModelPresetSelect.value === CUSTOM_CLEANER_MODEL
    ? cleanerModelInput.value.trim()
    : cleanerModelPresetSelect.value;
}

function renderCustomCleanerModelField() {
  cleanerCustomModelField.hidden = cleanerModelPresetSelect.value !== CUSTOM_CLEANER_MODEL;
}

function handleCleanerModelPresetChange() {
  cacheCleanerProfileDraft(activeCleanerModelDraft);
  renderCustomCleanerModelField();
  const model = cleanerModelPresetSelect.value;
  if (model === CUSTOM_CLEANER_MODEL) {
    activeCleanerModelDraft = cleanerModelInput.value.trim();
    cleanerModelInput.focus();
    return;
  }
  loadCleanerProfileDraft(model);
}

function cacheCleanerProfileDraft(model, { provider = cleanerProviderSelect.value } = {}) {
  const value = String(model || "").trim();
  if (!value) return;
  appSettings.cleanerProfiles = {
    ...(appSettings.cleanerProfiles || {}),
    [value]: {
      provider,
      baseUrl: cleanerBaseUrlInput.value.trim(),
      apiKey: cleanerApiKeyInput.value.trim()
    }
  };
}

function loadCleanerProfileDraft(model) {
  const profile = appSettings.cleanerProfiles?.[model];
  fillCleanerModel(model);
  cleanerProviderSelect.value = profile?.provider
    || (MIMO_CLEANER_MODELS.has(model) ? "mimo" : "openai-compatible");
  cleanerBaseUrlInput.value = profile?.baseUrl || "";
  cleanerApiKeyInput.value = profile?.apiKey || "";
  activeCleanerModelDraft = model;
  activeCleanerProviderDraft = cleanerProviderSelect.value;
}

function handleCleanerProviderChange() {
  if (cleanerModelPresetSelect.value === CUSTOM_CLEANER_MODEL) return;
  const usesMimoModel = MIMO_CLEANER_MODELS.has(cleanerModelPresetSelect.value);
  if (cleanerProviderSelect.value === "mimo" && !usesMimoModel) {
    cacheCleanerProfileDraft(activeCleanerModelDraft, { provider: activeCleanerProviderDraft });
    loadCleanerProfileDraft("mimo-v2.5");
  } else if (cleanerProviderSelect.value === "openai-compatible" && usesMimoModel) {
    cacheCleanerProfileDraft(activeCleanerModelDraft, { provider: activeCleanerProviderDraft });
    loadCleanerProfileDraft("gpt-5.4-mini");
  } else {
    activeCleanerProviderDraft = cleanerProviderSelect.value;
  }
}

function fillProfileModelSelector({ select, input, customField, model, profiles, presets, fallback }) {
  const value = String(model || "").trim() || fallback;
  syncSavedModelOptions(select, profiles, presets);
  input.value = value;
  select.value = presets.has(value) || profiles?.[value] ? value : CUSTOM_ASR_MODEL;
  customField.hidden = select.value !== CUSTOM_ASR_MODEL;
  return value;
}

function selectedProfileModel(select, input) {
  return select.value === CUSTOM_ASR_MODEL ? input.value.trim() : select.value;
}

function cacheMeetingQwenProfileDraft(model) {
  const value = String(model || "").trim();
  if (!value) return;
  appSettings.meetingQwenProfiles = {
    ...(appSettings.meetingQwenProfiles || {}),
    [value]: {
      provider: "qwen3-asr",
      model: value,
      baseUrl: meetingQwenBaseUrlInput.value.trim(),
      apiKey: meetingQwenApiKeyInput.value.trim()
    }
  };
}

function loadMeetingQwenProfileDraft(model) {
  const value = fillProfileModelSelector({
    select: meetingQwenModelPresetSelect,
    input: meetingQwenModelInput,
    customField: meetingQwenCustomModelField,
    model,
    profiles: appSettings.meetingQwenProfiles,
    presets: MEETING_QWEN_MODEL_PRESETS,
    fallback: "qwen3-asr-flash"
  });
  const profile = appSettings.meetingQwenProfiles?.[value] || {};
  meetingQwenBaseUrlInput.value = profile.baseUrl || QWEN_ASR_OPENAI_BASE_URL;
  meetingQwenApiKeyInput.value = profile.apiKey || "";
  activeMeetingQwenModelDraft = value;
}

function defaultMeetingFileAsrProvider(model) {
  const value = String(model || "").toLowerCase();
  if (value.includes("qwen")) return "qwen3-asr";
  if (value.includes("fun-asr")) return "fun-asr";
  return "mimo";
}

function defaultMeetingFileAsrBaseUrl(provider) {
  if (provider === "qwen3-asr") return QWEN_ASR_OPENAI_BASE_URL;
  if (provider === "fun-asr") return FUN_ASR_REST_BASE_URL;
  return "https://api.xiaomimimo.com/v1";
}

function cacheMeetingFileAsrProfileDraft(model) {
  const value = String(model || "").trim();
  if (!value || !meetingFileAsrProviderSelect) return;
  appSettings.meetingFileAsrProfiles = {
    ...(appSettings.meetingFileAsrProfiles || {}),
    [value]: {
      provider: meetingFileAsrProviderSelect.value || defaultMeetingFileAsrProvider(value),
      model: value,
      baseUrl: meetingFileAsrBaseUrlInput?.value.trim() || "",
      apiKey: meetingFileAsrApiKeyInput?.value.trim() || ""
    }
  };
}

function loadMeetingFileAsrProfileDraft(model) {
  const value = fillProfileModelSelector({
    select: meetingFileAsrModelPresetSelect,
    input: meetingFileAsrModelInput,
    customField: meetingFileAsrCustomModelField,
    model,
    profiles: appSettings.meetingFileAsrProfiles,
    presets: MEETING_FILE_ASR_MODEL_PRESETS,
    fallback: "mimo-v2.5-asr"
  });
  const profile = appSettings.meetingFileAsrProfiles?.[value] || {};
  const provider = profile.provider || defaultMeetingFileAsrProvider(value);
  if (meetingFileAsrProviderSelect) meetingFileAsrProviderSelect.value = provider;
  if (meetingFileAsrBaseUrlInput) {
    meetingFileAsrBaseUrlInput.value =
      profile.baseUrl || defaultMeetingFileAsrBaseUrl(provider);
  }
  if (meetingFileAsrApiKeyInput) meetingFileAsrApiKeyInput.value = profile.apiKey || "";
  activeMeetingFileAsrModelDraft = value;
}

function cacheMeetingFunProfileDraft(model) {
  const value = String(model || "").trim();
  if (!value) return;
  appSettings.meetingFunAsrProfiles = {
    ...(appSettings.meetingFunAsrProfiles || {}),
    [value]: {
      provider: "fun-asr",
      model: value,
      baseUrl: meetingFunAsrBaseUrlInput.value.trim(),
      apiKey: meetingFunAsrApiKeyInput.value.trim()
    }
  };
}

function loadMeetingFunProfileDraft(model) {
  const value = fillProfileModelSelector({
    select: meetingFunAsrModelPresetSelect,
    input: meetingFunAsrModelInput,
    customField: meetingFunAsrCustomModelField,
    model,
    profiles: appSettings.meetingFunAsrProfiles,
    presets: MEETING_FUN_MODEL_PRESETS,
    fallback: FUN_ASR_MODEL
  });
  const profile = appSettings.meetingFunAsrProfiles?.[value] || {};
  meetingFunAsrBaseUrlInput.value = profile.baseUrl || FUN_ASR_REST_BASE_URL;
  meetingFunAsrApiKeyInput.value = profile.apiKey || "";
  activeMeetingFunModelDraft = value;
}

function defaultMeetingAnalysisBaseUrl(model) {
  return /^mimo-/i.test(model) ? "https://api.xiaomimimo.com/v1" : "https://api.openai.com/v1";
}

function cacheMeetingAnalysisProfileDraft(model) {
  const value = String(model || "").trim();
  if (!value) return;
  appSettings.meetingAnalysisProfiles = {
    ...(appSettings.meetingAnalysisProfiles || {}),
    [value]: {
      provider: /^mimo-/i.test(value) ? "mimo" : "openai-compatible",
      model: value,
      baseUrl: meetingAnalysisBaseUrlInput.value.trim(),
      apiKey: meetingAnalysisApiKeyInput.value.trim(),
      contextWindow: Number(meetingAnalysisContextInput.value) || 128000,
      maxOutput: Number(meetingAnalysisMaxOutputInput.value) || 8192,
      reasoning: meetingAnalysisReasoningInput.value.trim(),
      timeoutMs: Number(meetingAnalysisTimeoutInput.value) || 120000
    }
  };
}

function loadMeetingAnalysisProfileDraft(model) {
  const value = fillProfileModelSelector({
    select: meetingAnalysisModelPresetSelect,
    input: meetingAnalysisModelInput,
    customField: meetingAnalysisCustomModelField,
    model,
    profiles: appSettings.meetingAnalysisProfiles,
    presets: MEETING_ANALYSIS_MODEL_PRESETS,
    fallback: "gpt-5.4-mini"
  });
  const profile = appSettings.meetingAnalysisProfiles?.[value] || {};
  meetingAnalysisBaseUrlInput.value = profile.baseUrl || defaultMeetingAnalysisBaseUrl(value);
  meetingAnalysisApiKeyInput.value = profile.apiKey || "";
  meetingAnalysisContextInput.value = profile.contextWindow || 128000;
  meetingAnalysisMaxOutputInput.value = profile.maxOutput || 8192;
  meetingAnalysisReasoningInput.value = profile.reasoning || "";
  meetingAnalysisTimeoutInput.value = profile.timeoutMs || 120000;
  activeMeetingAnalysisModelDraft = value;
}

function handleMeetingProfileModelChange(kind) {
  const configs = {
    qwen: {
      select: meetingQwenModelPresetSelect,
      input: meetingQwenModelInput,
      customField: meetingQwenCustomModelField,
      active: () => activeMeetingQwenModelDraft,
      setActive: (value) => { activeMeetingQwenModelDraft = value; },
      cache: cacheMeetingQwenProfileDraft,
      load: loadMeetingQwenProfileDraft
    },
    "file-asr": {
      select: meetingFileAsrModelPresetSelect,
      input: meetingFileAsrModelInput,
      customField: meetingFileAsrCustomModelField,
      active: () => activeMeetingFileAsrModelDraft,
      setActive: (value) => { activeMeetingFileAsrModelDraft = value; },
      cache: cacheMeetingFileAsrProfileDraft,
      load: loadMeetingFileAsrProfileDraft
    },
    fun: {
      select: meetingFunAsrModelPresetSelect,
      input: meetingFunAsrModelInput,
      customField: meetingFunAsrCustomModelField,
      active: () => activeMeetingFunModelDraft,
      setActive: (value) => { activeMeetingFunModelDraft = value; },
      cache: cacheMeetingFunProfileDraft,
      load: loadMeetingFunProfileDraft
    },
    analysis: {
      select: meetingAnalysisModelPresetSelect,
      input: meetingAnalysisModelInput,
      customField: meetingAnalysisCustomModelField,
      active: () => activeMeetingAnalysisModelDraft,
      setActive: (value) => { activeMeetingAnalysisModelDraft = value; },
      cache: cacheMeetingAnalysisProfileDraft,
      load: loadMeetingAnalysisProfileDraft
    }
  };
  const config = configs[kind];
  config.cache(config.active());
  if (config.select.value === CUSTOM_ASR_MODEL) {
    config.input.value = "";
    config.customField.hidden = false;
    config.setActive("");
    config.input.focus();
  } else {
    config.load(config.select.value);
  }
}

function setSettingsTab(tabName) {
  const available = new Set(settingsTabButtons.map((button) => button.dataset.settingsTab));
  activeSettingsTab = available.has(tabName) ? tabName : "general";
  for (const button of settingsTabButtons) {
    const active = button.dataset.settingsTab === activeSettingsTab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  }
  for (const panel of settingsTabPanels) {
    const active = panel.dataset.settingsPanel === activeSettingsTab;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  }
}

function toggleSecretVisibility(button) {
  const input = document.getElementById(button.dataset.secretToggle);
  if (!input) return;
  const visible = input.type === "text";
  input.type = visible ? "password" : "text";
  button.textContent = visible ? "显示" : "隐藏";
  button.setAttribute("aria-pressed", String(!visible));
}

async function copySecretValue(button) {
  const input = document.getElementById(button.dataset.secretCopy);
  const value = input?.value || "";
  if (!value) {
    setStatus("warning", "没有可复制的 Key", "当前模型尚未填写独立 API Key。");
    return;
  }
  await window.mimoInput.copyText(value);
  const original = button.textContent;
  button.textContent = "已复制";
  setStatus("ready", "API Key 已复制", "已写入剪贴板。");
  window.setTimeout(() => {
    button.textContent = original;
  }, 1200);
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
  if (isRecording || isTranscribing) return;
  logRenderer("recording: start requested", `autoSend=${autoSend}`);
  let status;
  try {
    status = await refreshStatus();
  } catch (error) {
    logRenderer("settings: refresh before recording failed", error.message || String(error));
  }
  autoSendAfterTranscript = autoSend;
  recordingTranscriptionMode = normalizeTranscriptionMode(appSettings.transcriptionMode);
  recordingAsrMode = normalizeAsrMode(appSettings.asrMode);
  recordingShortContext = buildShortContext();
  recordingAudioPolicy = status?.audioPolicy || recordingAudioPolicy;
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
  recordingSegmentState = createRecordingSegmentState(
    createFinalTranscriptionSnapshot(),
    recordingAudioPolicy
  );
  isRecording = true;

  try {
    mediaStream = await openMicrophoneStream();
  } catch (error) {
    isRecording = false;
    recordingSegmentState = null;
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

  try {
    audioContext = new AudioContext({ sampleRate: recordingAudioPolicy.sampleRate || 16000 });
  } catch {
    audioContext = new AudioContext();
  }
  recordingSampleRate = audioContext.sampleRate;
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  processorNode = audioContext.createScriptProcessor(2048, 1, 1);
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
    if (recordingSegmentState) recordingSegmentState.bufferedSamples += input.length;
    if (usesSocketRealtimePreview()) {
      window.mimoInput.appendRealtimeAudio(audioTools.float32ToPcm16Base64(input, recordingSampleRate, 16000)).catch(() => {});
    }
    const blockRms = updateAudioStats(input);
    maybePrefetchRecordingSegment(blockRms);
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
  isTranscribing = true;
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
    if (recordingSegmentState) recordingSegmentState.cancelled = true;
    await cleanupRealtimePreview();
    setStatus("warning", "录音太短", "请至少录制半秒以上。");
    setButtons("ready");
    recordingChunks = [];
    recordingSegmentState = null;
    isTranscribing = false;
    return;
  }
  if (recordingPeak < 0.012 || rms < 0.003) {
    logRenderer("recording: no input", `peak=${recordingPeak} rms=${rms}`);
    if (recordingSegmentState) recordingSegmentState.cancelled = true;
    await cleanupRealtimePreview();
    setStatus("warning", "没有检测到声音", "未检测到清晰的麦克风输入。");
    setButtons("ready");
    recordingChunks = [];
    recordingSegmentState = null;
    isTranscribing = false;
    return;
  }

  const segmentState = recordingSegmentState || createRecordingSegmentState(
    createFinalTranscriptionSnapshot(),
    recordingAudioPolicy
  );
  const socketRealtime = recordingAsrMode === "realtime"
    && (appSettings.asrProvider === "qwen3-asr" || appSettings.asrProvider === "fun-asr");

  try {
    let realtimeText = "";
    if (recordingAsrMode === "realtime") {
      setStatus(
        "transcribing",
        "正在生成最终文本",
        socketRealtime ? "正在汇总实时转写结果。" : "正在完成剩余音频分段。"
      );
      realtimeText = await cleanupRealtimePreview({
        finish: socketRealtime,
        shortContext: recordingShortContext,
        transcriptionMode
      });
    }

    queueBufferedRecordingAudio(segmentState, { transcribe: !socketRealtime });
    const transcriptionRequest = {
      audioSegments: segmentState.payloads,
      shortContext: recordingShortContext,
      transcriptionMode,
      settingsSnapshot: segmentState.settingsSnapshot,
      autoSendAfterTranscript
    };
    lastVoiceRequest = transcriptionRequest;

    if (socketRealtime && realtimeText) {
      await completeRawTranscript(realtimeText, transcriptionRequest);
    } else if (!socketRealtime) {
      const rawText = await collectCachedSegmentTranscripts(segmentState);
      await completeRawTranscript(rawText, transcriptionRequest);
    } else {
      await runVoiceRequest(transcriptionRequest, {
        bytes: totalAudioBytes(segmentState.payloads),
        retry: false,
        allowActive: true
      });
    }
  } catch (error) {
    logRenderer("segmented transcription failed", error.message || String(error));
    setStatus("error", "请求失败", error.message || String(error));
  } finally {
    recordingChunks = [];
    recordingSegmentState = null;
    recordingShortContext = "";
    isTranscribing = false;
    setButtons("ready");
  }
}

function createRecordingSegmentState(settingsSnapshot, policy) {
  return {
    settingsSnapshot,
    policy: { ...policy },
    bufferedSamples: 0,
    payloads: [],
    results: [],
    errors: [],
    tasks: [],
    queue: Promise.resolve(),
    cancelled: false
  };
}

function maybePrefetchRecordingSegment(blockRms) {
  const state = recordingSegmentState;
  if (!state?.policy?.prefetchSegments || usesSocketRealtimePreview()) return;
  const bufferedSeconds = state.bufferedSamples / recordingSampleRate;
  const targetSeconds = state.policy.targetSegmentSeconds || 180;
  const hardSeconds = state.policy.hardSegmentSeconds || 210;
  if (bufferedSeconds < targetSeconds) return;
  if (bufferedSeconds < hardSeconds && blockRms > 0.008) return;
  queueBufferedRecordingAudio(state, { transcribe: true });
}

function queueBufferedRecordingAudio(state, { transcribe }) {
  if (!recordingChunks.length) return;
  const chunks = recordingChunks;
  recordingChunks = [];
  state.bufferedSamples = 0;
  const payloads = audioTools.buildAudioPayloads(chunks, recordingSampleRate, {
    maxSegmentSeconds: state.policy.hardSegmentSeconds || 210,
    targetSampleRate: state.policy.sampleRate || 16000
  });

  for (const payload of payloads) {
    const compactPayload = compactAudioPayload(payload, state.settingsSnapshot.asrProvider);
    const index = state.payloads.length;
    state.payloads.push(compactPayload);
    if (transcribe) enqueueSegmentTranscription(state, compactPayload, index);
  }
}

function compactAudioPayload(payload, provider) {
  const metadata = {
    byteLength: payload.byteLength,
    durationSeconds: payload.durationSeconds,
    sampleRate: payload.sampleRate
  };
  if (provider === "fun-asr") {
    return { ...metadata, pcm16Base64: payload.pcm16Base64 };
  }
  return { ...metadata, audioDataUrl: payload.audioDataUrl };
}

function enqueueSegmentTranscription(state, payload, index) {
  const task = state.queue.then(async () => {
    if (state.cancelled) return;
    logRenderer(
      "asr segment: start",
      `${index + 1} duration=${payload.durationSeconds.toFixed(1)}s bytes=${payload.byteLength}`
    );
    const text = await window.mimoInput.transcribeSegment({
      ...payload,
      shortContext: "",
      settingsSnapshot: state.settingsSnapshot
    });
    state.results[index] = text || "";
    state.errors[index] = null;
    logRenderer("asr segment: cached", `${index + 1} chars=${String(text || "").length}`);
    if (isRecording && state === recordingSegmentState) {
      setStatus("recording", "正在录音", `已缓存 ${index + 1} 段，继续说话。`);
    }
  });
  const settled = task.catch((error) => {
    state.errors[index] = error;
    logRenderer("asr segment: failed", `${index + 1} ${error.message || String(error)}`);
  });
  state.tasks[index] = settled;
  state.queue = settled.then(() => undefined);
}

async function collectCachedSegmentTranscripts(state) {
  await state.queue;
  for (let index = 0; index < state.payloads.length; index += 1) {
    if (!state.errors[index]) continue;
    setStatus("transcribing", "正在补全转写", `正在重试第 ${index + 1}/${state.payloads.length} 段。`);
    state.results[index] = await window.mimoInput.transcribeSegment({
      ...state.payloads[index],
      shortContext: "",
      settingsSnapshot: state.settingsSnapshot
    });
    state.errors[index] = null;
  }
  return audioTools.joinTranscriptSegments(state.results);
}

async function completeRawTranscript(rawText, request) {
  isTranscribing = true;
  let transcript = String(rawText || "").trim();
  if (transcript && normalizeTranscriptionMode(request.transcriptionMode) === "stable") {
    setStatus("transcribing", "正在清理文本", "正在整理完整转写结果。");
    transcript = await window.mimoInput.cleanText({
      rawText: transcript,
      shortContext: request.shortContext,
      settingsSnapshot: request.settingsSnapshot
    });
  }
  await handleTranscriptResult(transcript, {
    retry: false,
    autoSendAfterTranscript: request.autoSendAfterTranscript,
    copyAfterTranscript: request.copyAfterTranscript
  });
}

function totalAudioBytes(payloads) {
  return payloads.reduce((sum, payload) => sum + (Number(payload.byteLength) || 0), 0);
}

async function runVoiceRequest(request, { bytes = 0, retry = false, allowActive = false } = {}) {
  if (!request?.audioDataUrl && !request?.audioSegments?.length) {
    setStatus("warning", "没有可重试内容", "请先录制一段语音。");
    setButtons("ready");
    return;
  }
  if (isRecording || (isTranscribing && !allowActive)) {
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
      audioSegments: request.audioSegments,
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
    const previewPayload = audioTools.buildAudioPayload(chunks, sampleRate, recordingAudioPolicy.sampleRate || 16000);
    const previewSnapshot = {
      ...createSettingsSnapshot(),
      asrMode: "batch",
      transcriptionMode: "fast"
    };
    const transcript = await window.mimoInput.transcribe({
      audioDataUrl: previewPayload.audioDataUrl,
      shortContext: "",
      transcriptionMode: "fast",
      settingsSnapshot: previewSnapshot
    });
    if (runId !== mimoPreviewRunId || !isRecording || !usesMimoPollingPreview()) return;
    if (transcript) {
      const cachedText = audioTools.joinTranscriptSegments(recordingSegmentState?.results || []);
      const visibleText = audioTools.joinTranscriptSegments([cachedText, transcript]);
      resultText.value = visibleText;
      setStatus("recording", "MiMo 实时预览", visibleText);
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
  if (recordingSegmentState) recordingSegmentState.cancelled = true;
  await cleanupRealtimePreview();
  recordingChunks = [];
  recordingSegmentState = null;
  levelMeter.hidden = true;
  setLevel(0);
  setButtons("ready");
  setStatus("ready", "已取消", "");
  await window.mimoInput.hide();
}

async function openMicrophoneStream() {
  const baseAudio = {
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 16000 },
    sampleSize: { ideal: 16 },
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
  return blockRms;
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

function beginHotkeyCapture(kind, input, hint, statusElement) {
  activeHotkeyCapture = {
    kind,
    input,
    hint,
    statusElement,
    originalValue: input.value,
    ready: false
  };
  input.classList.add("is-capturing");
  hint.hidden = false;
  statusElement.textContent = "正在准备快捷键捕获…";
  window.mimoInput.startHotkeyCapture().then(() => {
    if (activeHotkeyCapture?.input !== input) return;
    activeHotkeyCapture.ready = true;
    statusElement.textContent = "正在监听键盘组合…";
  }).catch((error) => {
    statusElement.textContent = `无法暂停旧快捷键：${error.message || String(error)}`;
  });
}

function endHotkeyCapture({ restore = false, resume = true } = {}) {
  const capture = activeHotkeyCapture;
  if (!capture) return;
  if (restore) capture.input.value = capture.originalValue;
  capture.input.classList.remove("is-capturing");
  capture.hint.hidden = true;
  activeHotkeyCapture = null;
  if (resume) window.mimoInput.endHotkeyCapture().catch(() => {});
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

function handleHotkeyCaptureKeydown(event, kind) {
  event.preventDefault();
  event.stopPropagation();
  const capture = activeHotkeyCapture;
  if (!capture || capture.kind !== kind) return;
  if (!capture.ready) {
    capture.statusElement.textContent = "旧快捷键仍在释放，请稍后再按一次。";
    return;
  }

  if (event.key === "Escape") {
    endHotkeyCapture({ restore: true });
    capture.statusElement.textContent = "已取消修改。";
    capture.input.blur();
    return;
  }

  if (event.key === "Backspace" || event.key === "Delete") {
    capture.input.value = "";
    capture.statusElement.textContent = "快捷键不能为空，请按新的组合键。";
    return;
  }

  const hotkey = formatHotkey(event);
  if (hotkey) {
    capture.input.value = hotkey;
    const originalValue = capture.originalValue;
    const statusElement = capture.statusElement;
    const input = capture.input;
    endHotkeyCapture({ resume: false });
    input.blur();
    saveHotkeySetting(kind, hotkey, originalValue, statusElement);
  }
}

async function saveHotkeySetting(kind, hotkey, originalValue, statusElement) {
  try {
    statusElement.textContent = "正在检查是否冲突…";
    const check = await window.mimoInput.checkHotkey({ kind, accelerator: hotkey });
    if (!check?.ok) {
      const input = kind === "meeting" ? meetingHotkeyInput : hotkeyInput;
      input.value = originalValue;
      statusElement.textContent = check?.message || "该快捷键不可用。";
      setStatus("warning", "快捷键不可用", statusElement.textContent);
      return;
    }
    const normalized = check.accelerator || hotkey;
    const settingKey = kind === "meeting" ? "meetingHotkey" : "hotkey";
    appSettings = await window.mimoInput.saveSettings({ [settingKey]: normalized });
    if (kind === "meeting") meetingHotkeyInput.value = normalized;
    else hotkeyInput.value = normalized;
    await window.mimoInput.endHotkeyCapture();
    const status = await refreshStatus();
    if (status.registeredHotkeys?.includes(normalized)) {
      statusElement.textContent = `可用 · ${normalized}`;
      setStatus("ready", "快捷键已保存", `已注册：${normalized}`);
    } else {
      statusElement.textContent = `注册失败 · ${normalized}`;
      setStatus("warning", "快捷键不可用", `无法注册 ${normalized}，请换一个组合。`);
    }
  } catch (error) {
    statusElement.textContent = error.message || String(error);
    setStatus("error", "快捷键保存失败", error.message || String(error));
  } finally {
    await window.mimoInput.endHotkeyCapture().catch(() => {});
  }
}

function fillSettingsForm() {
  loadAsrProfileDraft(appSettings.asrModel || MIMO_ASR_MODEL);
  loadCleanerProfileDraft(appSettings.cleanerModel || appSettings.model || "mimo-v2.5");
  hotkeyInput.value = appSettings.hotkey || "CommandOrControl+Alt+M";
  meetingHotkeyInput.value = appSettings.meetingHotkey || "CommandOrControl+Alt+Shift+M";
  hotkeyStatus.textContent = "";
  meetingHotkeyStatus.textContent = "";
  setTranscriptionMode(normalizeTranscriptionMode(appSettings.transcriptionMode), { silent: true });
  loadMeetingQwenProfileDraft(appSettings.meetingQwenModel || "qwen3-asr-flash");
  loadMeetingFunProfileDraft(appSettings.meetingFunAsrModel || FUN_ASR_MODEL);
  if (meetingOssRegionInput) meetingOssRegionInput.value = appSettings.meetingOssRegion || "";
  if (meetingOssEndpointInput) meetingOssEndpointInput.value = appSettings.meetingOssEndpoint || "";
  if (meetingOssBucketInput) meetingOssBucketInput.value = appSettings.meetingOssBucket || "";
  if (meetingOssPrefixInput) meetingOssPrefixInput.value = appSettings.meetingOssPrefix || "meeting";
  if (meetingOssAccessKeyIdInput) meetingOssAccessKeyIdInput.value = appSettings.meetingOssAccessKeyId || "";
  if (meetingOssAccessKeySecretInput) {
    meetingOssAccessKeySecretInput.value = appSettings.meetingOssAccessKeySecret || "";
  }
  const settingsMode = meetingUi.normalizeProcessMode?.(appSettings.meetingProcessMode) || "basic";
  const settingsBr =
    meetingUi.normalizeBitrateKbps?.(appSettings.meetingUploadBitrateKbps, 48) || 48;
  if (meetingUploadBitrateSelect) meetingUploadBitrateSelect.value = String(settingsBr);
  renderMeetingSettingsMode(settingsMode);
  loadMeetingFileAsrProfileDraft(appSettings.meetingFileAsrModel || MIMO_ASR_MODEL);
  loadMeetingAnalysisProfileDraft(appSettings.meetingAnalysisModel || "gpt-5.4-mini");
  syncWorkbenchProcessModeFromSettings({ silent: true });
}

function renderMeetingSettingsMode(mode) {
  const m = meetingUi.normalizeProcessMode?.(mode) || "basic";
  for (const btn of [meetingSettingsModeBasicBtn, meetingSettingsModeEnhancedBtn]) {
    if (!btn) continue;
    const active = btn.dataset.meetingProcessMode === m;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", String(active));
  }
  const brField = document.getElementById("meetingSettingsBitrateField");
  if (brField) brField.hidden = m !== "enhanced";
}

function renderTranscriptionMode(mode) {
  for (const button of [stableModeBtn, fastModeBtn]) {
    const active = button.dataset.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

async function setTranscriptionMode(mode, { silent = false } = {}) {
  const transcriptionMode = normalizeTranscriptionMode(mode);
  renderTranscriptionMode(transcriptionMode);
  if (silent) {
    appSettings = { ...appSettings, transcriptionMode };
    return;
  }
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
  document.body.classList.toggle("meeting-mode", mode === "meeting");
  document.body.classList.toggle("file-mode", mode === "file");
  document.body.classList.toggle("secondary-window-mode", ["settings", "meeting", "file"].includes(mode));
  if (meetingPanel) meetingPanel.hidden = mode !== "meeting";
  if (filePanel) filePanel.hidden = mode !== "file";
  if (mode === "recording" || mode === "compact" || mode === "result" || mode === "meeting" || mode === "file") {
    settingsPanel.hidden = true;
  }
  if (mode !== "meeting") {
    stopMeetingPolling();
  }
  if (mode !== "file") {
    window.FileTranscriptionUi?.stopPolling?.();
  }
  scheduleRecordingResize();
}

function renderWindowMaximizeButton(maximized) {
  if (!maximizeBtn) return;
  maximizeBtn.textContent = "";
  maximizeBtn.dataset.maximized = String(Boolean(maximized));
  maximizeBtn.title = maximized ? "恢复窗口" : "最大化";
  maximizeBtn.setAttribute("aria-label", maximized ? "恢复窗口" : "最大化");
  maximizeBtn.setAttribute("aria-pressed", String(Boolean(maximized)));
}

window.applyWindowMode = applyWindowMode;

async function showResultWindow() {
  await window.mimoInput.openResultWindow();
  applyWindowMode("result");
  settingsPanel.hidden = true;
}

async function saveAllSettings() {
  normalizeProviderSettingsDraft();
  const asrModel = normalizeAsrModelForSelectedProvider(selectedAsrModel());
  if (!asrModel) throw new Error("请填写 ASR 模型 ID。");
  fillAsrModel(asrModel);
  cacheAsrProfileDraft(asrModel);
  const cleanerModel = selectedCleanerModel();
  if (!cleanerModel) throw new Error("请填写文本清理模型 ID。");
  cacheCleanerProfileDraft(cleanerModel);
  const meetingQwenModel = selectedProfileModel(meetingQwenModelPresetSelect, meetingQwenModelInput);
  const meetingFileAsrModel = selectedProfileModel(meetingFileAsrModelPresetSelect, meetingFileAsrModelInput);
  const meetingFunModel = selectedProfileModel(meetingFunAsrModelPresetSelect, meetingFunAsrModelInput);
  const meetingAnalysisModel = selectedProfileModel(meetingAnalysisModelPresetSelect, meetingAnalysisModelInput);
  if (!meetingQwenModel || !meetingFileAsrModel || !meetingFunModel || !meetingAnalysisModel) {
    throw new Error("请填写所有已选择的自定义模型 ID。");
  }
  cacheMeetingQwenProfileDraft(meetingQwenModel);
  cacheMeetingFileAsrProfileDraft(meetingFileAsrModel);
  cacheMeetingFunProfileDraft(meetingFunModel);
  cacheMeetingAnalysisProfileDraft(meetingAnalysisModel);
  const voiceHotkey = hotkeyInput.value.trim() || "CommandOrControl+Alt+M";
  const longHotkey = meetingHotkeyInput.value.trim() || "CommandOrControl+Alt+Shift+M";
  const [voiceCheck, meetingCheck] = await Promise.all([
    window.mimoInput.checkHotkey({ kind: "short", accelerator: voiceHotkey }),
    window.mimoInput.checkHotkey({ kind: "meeting", accelerator: longHotkey })
  ]);
  if (!voiceCheck?.ok) throw new Error(`短语音快捷键：${voiceCheck?.message || "不可用"}`);
  if (!meetingCheck?.ok) throw new Error(`长内容快捷键：${meetingCheck?.message || "不可用"}`);
  const nextSettings = {
    asrProvider: asrProviderSelect.value,
    asrMode: normalizeAsrMode(asrModeSelect.value),
    asrModel,
    asrRealtimeModel: normalizeRealtimeModelForSelectedProvider(selectedAsrRealtimeModel()),
    asrBaseUrl: asrBaseUrlInput.value.trim(),
    asrApiKey: asrApiKeyInput.value.trim(),
    asrLanguage: asrLanguageInput.value.trim(),
    asrEnableItn: asrEnableItnInput.checked,
    asrProfiles: appSettings.asrProfiles || {},
    cleanerProvider: cleanerProviderSelect.value,
    cleanerModel,
    cleanerBaseUrl: cleanerBaseUrlInput.value.trim(),
    cleanerApiKey: cleanerApiKeyInput.value.trim(),
    cleanerProfiles: appSettings.cleanerProfiles || {},
    hotkey: voiceCheck.accelerator || voiceHotkey,
    meetingHotkey: meetingCheck.accelerator || longHotkey,
    microphoneDeviceId: microphoneSelect.value,
    transcriptionMode: normalizeTranscriptionMode(appSettings.transcriptionMode),
    meetingMicrophoneDeviceId:
      document.getElementById("meetingMicSelect")?.value || appSettings.meetingMicrophoneDeviceId || "",
    meetingSystemDeviceId:
      document.getElementById("meetingSystemSelect")?.value || appSettings.meetingSystemDeviceId || "",
    meetingCaptureMode:
      document.getElementById("meetingCaptureModeSelect")?.value || appSettings.meetingCaptureMode || "dual",
    meetingQwenModel,
    meetingQwenBaseUrl: meetingQwenBaseUrlInput?.value.trim() || "",
    meetingQwenApiKey: meetingQwenApiKeyInput?.value.trim() || "",
    meetingQwenProfiles: appSettings.meetingQwenProfiles || {},
    meetingFileAsrProvider: meetingFileAsrProviderSelect?.value || "mimo",
    meetingFileAsrModel,
    meetingFileAsrBaseUrl: meetingFileAsrBaseUrlInput?.value.trim() || "",
    meetingFileAsrApiKey: meetingFileAsrApiKeyInput?.value.trim() || "",
    meetingFileAsrProfiles: appSettings.meetingFileAsrProfiles || {},
    meetingProcessMode:
      meetingUi.normalizeProcessMode?.(
        document.querySelector(".meeting-settings-mode .mode-button.is-active")?.dataset
          ?.meetingProcessMode ||
          appSettings.meetingProcessMode ||
          meetingState.processMode
      ) || "basic",
    meetingUploadBitrateKbps:
      meetingUi.normalizeBitrateKbps?.(
        meetingUploadBitrateSelect?.value || appSettings.meetingUploadBitrateKbps || 48,
        48
      ) || 48,
    meetingFunAsrModel: meetingFunModel,
    meetingFunAsrBaseUrl: meetingFunAsrBaseUrlInput?.value.trim() || "",
    meetingFunAsrApiKey: meetingFunAsrApiKeyInput?.value.trim() || "",
    meetingFunAsrProfiles: appSettings.meetingFunAsrProfiles || {},
    meetingOssRegion: meetingOssRegionInput?.value.trim() || "",
    meetingOssEndpoint: meetingOssEndpointInput?.value.trim() || "",
    meetingOssBucket: meetingOssBucketInput?.value.trim() || "",
    meetingOssPrefix: meetingOssPrefixInput?.value.trim() || "meeting",
    meetingOssAccessKeyId: meetingOssAccessKeyIdInput?.value.trim() || "",
    meetingOssAccessKeySecret: meetingOssAccessKeySecretInput?.value.trim() || "",
    meetingAnalysisModel,
    meetingAnalysisBaseUrl: meetingAnalysisBaseUrlInput?.value.trim() || "",
    meetingAnalysisApiKey: meetingAnalysisApiKeyInput?.value.trim() || "",
    meetingAnalysisProfiles: appSettings.meetingAnalysisProfiles || {},
    meetingAnalysisContextWindow: Number(meetingAnalysisContextInput?.value) || 128000,
    meetingAnalysisMaxOutput: Number(meetingAnalysisMaxOutputInput?.value) || 8192,
    meetingAnalysisReasoning: meetingAnalysisReasoningInput?.value.trim() || "",
    meetingAnalysisTimeoutMs: Number(meetingAnalysisTimeoutInput?.value) || 120000
  };
  appSettings = await window.mimoInput.saveSettings({
    ...nextSettings
  });
  syncWorkbenchProcessModeFromSettings({ silent: true });
  await refreshStatus();
  setStatus("ready", "设置已保存", "API、URL、快捷键和麦克风设置已更新。");
}

async function runMeetingEnhancedTest(target) {
  const resultEl = target === "oss" ? meetingOssTestResult : meetingFunTestResult;
  const btn = target === "oss" ? meetingOssTestBtn : meetingFunTestBtn;
  if (resultEl) resultEl.textContent = "测试中…";
  if (btn) btn.disabled = true;
  try {
    await saveAllSettings();
    const res = await window.mimoInput.meetingEnhancedTest?.({ target });
    if (!res?.ok) {
      if (resultEl) resultEl.textContent = res?.error?.message || "失败";
      return;
    }
    const ms = res.latencyMs != null ? `${res.latencyMs}ms` : "";
    if (resultEl) resultEl.textContent = ms ? `可用 · ${ms}` : "可用";
  } catch (error) {
    if (resultEl) resultEl.textContent = error.message || String(error);
  } finally {
    if (btn) btn.disabled = false;
  }
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
minimizeBtn?.addEventListener("click", () => window.mimoInput.minimizeWindow?.());
maximizeBtn?.addEventListener("click", async () => {
  const result = await window.mimoInput.toggleMaximizeWindow?.();
  if (result?.ok) renderWindowMaximizeButton(result.maximized);
});
settingsBtn.addEventListener("click", async () => {
  stopMeetingPolling();
  await window.mimoInput.openSettings();
});
refreshDevicesBtn.addEventListener("click", () => refreshMicrophones({ requestPermission: true }));
microphoneSelect.addEventListener("change", saveMicrophoneSelection);
asrModelPresetSelect.addEventListener("change", handleAsrModelPresetChange);
asrRealtimeModelPresetSelect.addEventListener("change", handleAsrRealtimeModelPresetChange);
asrProviderSelect.addEventListener("change", handleAsrProviderChange);
asrModeSelect.addEventListener("change", normalizeProviderSettingsDraft);
asrModelInput.addEventListener("input", () => {
  if (asrModelPresetSelect.value === CUSTOM_ASR_MODEL) {
    activeAsrModelDraft = asrModelInput.value.trim();
  }
});
asrModelInput.addEventListener("blur", normalizeProviderSettingsDraft);
asrRealtimeModelInput.addEventListener("blur", () => {
  if (asrRealtimeModelPresetSelect.value === CUSTOM_ASR_REALTIME_MODEL) {
    normalizeProviderSettingsDraft();
  }
});
cleanerModelPresetSelect.addEventListener("change", handleCleanerModelPresetChange);
cleanerModelInput.addEventListener("input", () => {
  if (cleanerModelPresetSelect.value === CUSTOM_CLEANER_MODEL) {
    activeCleanerModelDraft = cleanerModelInput.value.trim();
  }
});
cleanerProviderSelect.addEventListener("change", handleCleanerProviderChange);
meetingQwenModelPresetSelect.addEventListener("change", () => handleMeetingProfileModelChange("qwen"));
meetingFileAsrModelPresetSelect?.addEventListener("change", () => handleMeetingProfileModelChange("file-asr"));
meetingFunAsrModelPresetSelect.addEventListener("change", () => handleMeetingProfileModelChange("fun"));
meetingAnalysisModelPresetSelect.addEventListener("change", () => handleMeetingProfileModelChange("analysis"));
meetingQwenModelInput.addEventListener("input", () => {
  if (meetingQwenModelPresetSelect.value === CUSTOM_ASR_MODEL) {
    activeMeetingQwenModelDraft = meetingQwenModelInput.value.trim();
  }
});
meetingFileAsrModelInput?.addEventListener("input", () => {
  if (meetingFileAsrModelPresetSelect.value === CUSTOM_ASR_MODEL) {
    activeMeetingFileAsrModelDraft = meetingFileAsrModelInput.value.trim();
  }
});
meetingFileAsrProviderSelect?.addEventListener("change", () => {
  const provider = meetingFileAsrProviderSelect.value;
  if (meetingFileAsrBaseUrlInput && !meetingFileAsrBaseUrlInput.value.trim()) {
    meetingFileAsrBaseUrlInput.value = defaultMeetingFileAsrBaseUrl(provider);
  }
});
meetingFunAsrModelInput.addEventListener("input", () => {
  if (meetingFunAsrModelPresetSelect.value === CUSTOM_ASR_MODEL) {
    activeMeetingFunModelDraft = meetingFunAsrModelInput.value.trim();
  }
});
meetingAnalysisModelInput.addEventListener("input", () => {
  if (meetingAnalysisModelPresetSelect.value === CUSTOM_ASR_MODEL) {
    activeMeetingAnalysisModelDraft = meetingAnalysisModelInput.value.trim();
  }
});
for (const button of settingsTabButtons) {
  button.addEventListener("click", () => setSettingsTab(button.dataset.settingsTab));
}
for (const button of secretToggleButtons) {
  button.addEventListener("click", () => toggleSecretVisibility(button));
}
for (const button of secretCopyButtons) {
  button.addEventListener("click", () => copySecretValue(button));
}
stableModeBtn.addEventListener("click", () => setTranscriptionMode("stable"));
fastModeBtn.addEventListener("click", () => setTranscriptionMode("fast"));
saveSettingsBtn.addEventListener("click", () => {
  saveAllSettings().catch((error) => setStatus("error", "设置保存失败", error.message || String(error)));
});
testConnectionBtn.addEventListener("click", testConnection);
resultText.addEventListener("input", () => setButtons("ready"));
hotkeyInput.addEventListener("focus", () => beginHotkeyCapture("short", hotkeyInput, hotkeyHint, hotkeyStatus));
hotkeyInput.addEventListener("click", () => beginHotkeyCapture("short", hotkeyInput, hotkeyHint, hotkeyStatus));
hotkeyInput.addEventListener("blur", () => endHotkeyCapture());
hotkeyInput.addEventListener("beforeinput", (event) => event.preventDefault());
meetingHotkeyInput.addEventListener("focus", () => beginHotkeyCapture("meeting", meetingHotkeyInput, meetingHotkeyHint, meetingHotkeyStatus));
meetingHotkeyInput.addEventListener("click", () => beginHotkeyCapture("meeting", meetingHotkeyInput, meetingHotkeyHint, meetingHotkeyStatus));
meetingHotkeyInput.addEventListener("blur", () => endHotkeyCapture());
meetingHotkeyInput.addEventListener("beforeinput", (event) => event.preventDefault());

window.addEventListener("keydown", (event) => {
  if (activeHotkeyCapture) {
    handleHotkeyCaptureKeydown(event, activeHotkeyCapture.kind);
  } else if (event.key === "Escape") {
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
}, true);

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
  stopMeetingPolling();
  applyWindowMode("settings");
  settingsPanel.hidden = false;
  if (meetingPanel) meetingPanel.hidden = true;
  setSettingsTab(activeSettingsTab);
  await refreshStatus();
  await refreshMicrophones({ requestPermission: true });
});

window.mimoInput.onOpenMeeting?.(async () => {
  await openMeetingWorkspace({ fromModeEvent: true });
});

window.mimoInput.onWindowMode((mode) => {
  // Meeting entry is driven by open-meeting only; still accept legacy window-mode=meeting.
  if (mode === "meeting") {
    openMeetingWorkspace({ fromModeEvent: true }).catch(() => {});
    return;
  }
  applyWindowMode(mode);
});

/* —— Meeting workbench (Stage 4A) —— */
const meetingChannels = meetingUi.createWorkbenchChannels
  ? meetingUi.createWorkbenchChannels()
  : {
      select: meetingUi.createRequestToken(),
      list: meetingUi.createRequestToken(),
      poll: meetingUi.createRequestToken(),
      process: meetingUi.createRequestToken(),
      analysis: meetingUi.createRequestToken(),
      result: meetingUi.createRequestToken()
    };
const meetingOpenFlight = meetingUi.createSingleFlight
  ? meetingUi.createSingleFlight()
  : { run: (fn) => Promise.resolve().then(fn), pending: false };

const meetingState = {
  sessions: [],
  selectedId: null,
  lifecycle: null,
  process: null,
  analysis: null,
  captureStartedAt: 0,
  pollTimer: null,
  clockTimer: null,
  resultTab: "raw",
  rawDoc: null,
  correctedDoc: null,
  summaryDoc: null,
  speakerMap: null,
  activeSpeakerId: null,
  processMode: "basic",
  bitrateKbps: 48,
  playbackUrl: null,
  virt: null,
  importBusy: false,
  importSessionId: null
};

function meetingAccept(channel, token, sid) {
  if (meetingUi.acceptChannelUpdate) {
    return meetingUi.acceptChannelUpdate(channel, token, meetingState.selectedId, sid);
  }
  return channel?.isCurrent?.(token) && (!sid || sid === meetingState.selectedId);
}

function stopMeetingPolling() {
  if (meetingState.pollTimer) {
    clearInterval(meetingState.pollTimer);
    meetingState.pollTimer = null;
  }
  if (meetingState.clockTimer) {
    clearInterval(meetingState.clockTimer);
    meetingState.clockTimer = null;
  }
}

function applyCaptureStartedFromLifecycle(life) {
  meetingState.captureStartedAt = meetingUi.resolveCaptureStartedAt?.({
    lifecycle: life,
    selectedId: meetingState.selectedId,
    previousStartedAt: meetingState.captureStartedAt
  }) ?? 0;
}

function effectiveMeetingLifecycle() {
  const life = meetingState.lifecycle;
  if (!meetingUi.shouldDriveCaptureUi?.(life, meetingState.selectedId)) {
    return { status: "idle", sessionId: null, startedAtMs: null };
  }
  return life;
}

function meetingEls() {
  return {
    list: document.getElementById("meetingSessionList"),
    search: document.getElementById("meetingSessionSearch"),
    title: document.getElementById("meetingTitleInput"),
    mic: document.getElementById("meetingMicSelect"),
    sys: document.getElementById("meetingSystemSelect"),
    mode: document.getElementById("meetingCaptureModeSelect"),
    elapsed: document.getElementById("meetingElapsed"),
    badge: document.getElementById("meetingCaptureBadge"),
    hint: document.getElementById("meetingConsoleHint"),
    processStatus: document.getElementById("meetingProcessStatus"),
    processProgress: document.getElementById("meetingProcessProgress"),
    analysisStatus: document.getElementById("meetingAnalysisStatus"),
    template: document.getElementById("meetingAnalysisTemplateSelect"),
    resultEmpty: document.getElementById("meetingResultEmpty"),
    resultContent: document.getElementById("meetingResultContent"),
    startBtn: document.getElementById("meetingStartBtn"),
    pauseBtn: document.getElementById("meetingPauseBtn"),
    resumeBtn: document.getElementById("meetingResumeBtn"),
    stopBtn: document.getElementById("meetingStopBtn"),
    processStartBtn: document.getElementById("meetingProcessStartBtn"),
    processRetryBtn: document.getElementById("meetingProcessRetryBtn"),
    processCancelBtn: document.getElementById("meetingProcessCancelBtn"),
    processModeBasicBtn: document.getElementById("meetingProcessModeBasicBtn"),
    processModeEnhancedBtn: document.getElementById("meetingProcessModeEnhancedBtn"),
    bitrateGroup: document.getElementById("meetingBitrateGroup"),
    processModeHint: document.getElementById("meetingProcessModeHint"),
    speakerSelect: document.getElementById("meetingSpeakerSelect"),
    speakerName: document.getElementById("meetingSpeakerNameInput"),
    analysisStartBtn: document.getElementById("meetingAnalysisStartBtn"),
    analysisRetryBtn: document.getElementById("meetingAnalysisRetryBtn"),
    analysisCancelBtn: document.getElementById("meetingAnalysisCancelBtn")
  };
}

function setPill(el, kind, text) {
  if (!el) return;
  el.dataset.kind = kind || "idle";
  el.textContent = text || "";
}

function selectedMeetingRow() {
  return meetingState.sessions.find((s) => s.id === meetingState.selectedId) || null;
}

function updateMeetingControls() {
  const el = meetingEls();
  const eff = effectiveMeetingLifecycle();
  const life = eff?.status || "idle";
  const proc = meetingState.process?.stage || "idle";
  const ana = meetingState.analysis?.status || "none";
  const hasSession = Boolean(meetingState.selectedId);
  const row = selectedMeetingRow();
  const source = row?.source || null;
  const sessionStatus = row?.status || null;
  const hasArchive =
    Boolean(row?.hasArchive) ||
    (Array.isArray(row?.archiveTracks) && row.archiveTracks.length > 0) ||
    Boolean(meetingState.playbackUrl);
  // Capture history after app restart: lifecycle may be idle while disk status is stopped.
  const effectiveLifeForProcess =
    source === "import"
      ? life
      : life === "idle" && sessionStatus === "stopped"
        ? "stopped"
        : life;
  const busyCap = meetingUi.isBusyCapture?.(life);
  const hasRaw =
    Boolean(meetingState.rawDoc?.items?.length) ||
    proc === "completed" ||
    Boolean(meetingState.process?.resultReady);
  const flags =
    meetingUi.computeControlFlags?.({
      hasSession,
      lifecycleStatus: effectiveLifeForProcess,
      processStage: proc,
      analysisStatus: ana,
      hasRaw,
      source,
      sessionStatus,
      hasArchive
    }) || {
      canStartCapture: hasSession && meetingUi.canStartCapture?.(life, proc, ana, { source, sessionStatus }),
      canGenerateRaw: meetingUi.canGenerateRaw?.(effectiveLifeForProcess, proc, {
        hasSession,
        source,
        sessionStatus,
        hasArchive
      }),
      canRetryProcess: hasSession && (proc === "failed" || proc === "cancelled"),
      canCancelProcess: proc === "exporting" || proc === "transcribing" || proc === "cancelling",
      canRunAnalysis: meetingUi.canRunAnalysis?.(proc, ana, { hasSession, hasRaw, sessionStatus }),
      canRetryAnalysis: hasSession && (ana === "failed" || ana === "cancelled"),
      canCancelAnalysis: ana === "running" || ana === "cancelling"
    };

  if (el.startBtn) el.startBtn.disabled = !flags.canStartCapture;
  if (el.pauseBtn) el.pauseBtn.disabled = life !== "recording" || source === "import";
  if (el.resumeBtn) el.resumeBtn.disabled = life !== "paused" || source === "import";
  if (el.stopBtn) el.stopBtn.disabled = !busyCap || source === "import";
  if (el.processStartBtn) el.processStartBtn.disabled = !flags.canGenerateRaw;
  if (el.processRetryBtn) el.processRetryBtn.disabled = !flags.canRetryProcess;
  if (el.processCancelBtn) el.processCancelBtn.disabled = !flags.canCancelProcess;
  if (el.analysisStartBtn) el.analysisStartBtn.disabled = !flags.canRunAnalysis;
  if (el.analysisRetryBtn) el.analysisRetryBtn.disabled = !flags.canRetryAnalysis;
  if (el.analysisCancelBtn) el.analysisCancelBtn.disabled = !flags.canCancelAnalysis;
  setImportCancelEnabled(Boolean(meetingState.importSessionId || meetingState.importBusy));

  const modeLocked = meetingUi.isProcessRunningStage?.(proc);
  renderWorkbenchProcessModeControls({ locked: modeLocked });

  const capLabel = meetingUi.captureStatusLabel?.(life) || life;
  let capKind = "idle";
  if (life === "recording") capKind = "recording";
  else if (life === "paused") capKind = "paused";
  else if (life === "faulted") capKind = "faulted";
  else if (life === "stopped") capKind = "ok";
  setPill(el.badge, capKind, capLabel);

  const pLabel = meetingUi.processStageLabel?.(proc, meetingState.process) || proc;
  let pKind = "idle";
  if (proc === "completed") pKind = "ok";
  else if (proc === "failed") pKind = "error";
  else if (meetingUi.isProcessRunningStage?.(proc)) pKind = "processing";
  const cleanupWarn = meetingUi.remoteCleanupWarning?.(meetingState.process?.remoteCleanup);
  if (cleanupWarn && (proc === "failed" || proc === "cancelled" || proc === "completed")) {
    pKind = pKind === "ok" ? "warn" : pKind === "idle" ? "warn" : pKind;
  }
  setPill(el.processStatus, pKind, pLabel);
  if (el.processProgress) {
    el.processProgress.textContent =
      meetingUi.processProgressText?.(meetingState.process) ||
      meetingUi.segmentProgressText?.(
        meetingState.process?.transcription?.segmentCompleted,
        meetingState.process?.transcription?.segmentTotal
      ) ||
      "—";
  }

  const aLabel = meetingUi.analysisStageLabel?.(ana, meetingState.analysis?.stage) || ana;
  let aKind = "idle";
  if (ana === "completed") aKind = "ok";
  else if (ana === "failed") aKind = "error";
  else if (ana === "running" || ana === "cancelling") aKind = "processing";
  setPill(el.analysisStatus, aKind, aLabel);

  if (el.elapsed) {
    const startedAt = meetingState.captureStartedAt;
    if ((life === "recording" || life === "paused") && startedAt) {
      el.elapsed.textContent = meetingUi.formatElapsed?.(Date.now() - startedAt) || "00:00";
    } else if (!busyCap) {
      el.elapsed.textContent = "00:00";
    }
  }
}

function renderMeetingSessionList() {
  const el = meetingEls();
  if (!el.list) return;
  const q = el.search?.value || "";
  const rows = meetingUi.filterSessions?.(meetingState.sessions, q) || meetingState.sessions;
  while (el.list.firstChild) el.list.removeChild(el.list.firstChild);
  if (!rows.length) {
    const p = document.createElement("p");
    p.className = "meeting-empty";
    p.textContent = "暂无会话";
    el.list.appendChild(p);
    return;
  }
  for (const s of rows) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "meeting-session-row";
    btn.setAttribute("role", "option");
    btn.dataset.sessionId = s.id;
    if (s.id === meetingState.selectedId) {
      btn.classList.add("is-selected");
      btn.setAttribute("aria-selected", "true");
    } else {
      btn.setAttribute("aria-selected", "false");
    }
    const title = document.createElement("strong");
    title.textContent = s.title || s.id || "未命名会话";
    const meta = document.createElement("span");
    const listMeta = meetingUi.sessionListMetaLine?.(s);
    const proc = s.processing?.stage ? meetingUi.processStageLabel?.(s.processing.stage) : "";
    meta.textContent =
      listMeta ||
      [meetingUi.captureStatusLabel?.(s.status) || s.status, proc, s.updatedAt || s.createdAt || ""]
        .filter(Boolean)
        .join(" · ");
    btn.appendChild(title);
    btn.appendChild(meta);
    btn.addEventListener("click", () => selectMeetingSession(s.id));
    el.list.appendChild(btn);
  }
}

async function refreshMeetingDevices() {
  const el = meetingEls();
  if (!el.mic || !window.mimoInput.meetingQueryDevices) return;
  try {
    const res = await window.mimoInput.meetingQueryDevices();
    if (!res?.ok) throw new Error(res?.error?.message || "设备查询失败");
    const fill = (select, list, preferred) => {
      const cur = preferred || select.value || "";
      while (select.options.length > 1) select.remove(1);
      for (const d of list || []) {
        const opt = document.createElement("option");
        opt.value = d.id;
        opt.textContent = d.name || d.id;
        select.appendChild(opt);
      }
      if (cur && [...select.options].some((o) => o.value === cur)) select.value = cur;
    };
    fill(el.mic, res.capture || res.devices, appSettings.meetingMicrophoneDeviceId);
    fill(el.sys, res.render || [], appSettings.meetingSystemDeviceId);
    if (el.mode && appSettings.meetingCaptureMode) el.mode.value = appSettings.meetingCaptureMode;
  } catch (error) {
    const elh = meetingEls().hint;
    if (elh) elh.textContent = error.message || "设备刷新失败（可能未构建采集助手）";
  }
}

async function refreshMeetingSessions() {
  if (!window.mimoInput.meetingListSessions) return;
  const token = meetingChannels.list.next();
  const res = await window.mimoInput.meetingListSessions({ source: "capture" });
  if (!meetingAccept(meetingChannels.list, token, null)) return;
  if (!res?.ok) throw new Error(res?.error?.message || "列表失败");
  meetingState.sessions = (res.sessions || []).filter((s) => s.source !== "import").map((s) => ({
    ...s,
    title: meetingUi.sanitizeSessionTitle?.(s.title) || s.title || s.id
  }));
  renderMeetingSessionList();
}

async function selectMeetingSession(sessionId) {
  stopMeetingPolling();
  meetingChannels.poll.next();
  meetingChannels.result.next();
  meetingState.selectedId = sessionId;
  meetingState.rawDoc = null;
  meetingState.correctedDoc = null;
  meetingState.summaryDoc = null;
  meetingState.speakerMap = null;
  meetingState.activeSpeakerId = null;
  meetingState.playbackUrl = null;
  meetingState.virt = null;
  meetingState.captureStartedAt = 0;
  meetingState.process = null;
  meetingState.analysis = null;
  const audio = document.getElementById("meetingAudio");
  if (audio) {
    audio.removeAttribute("src");
    audio.load();
  }
  const row = meetingState.sessions.find((s) => s.id === sessionId);
  const elTitle = meetingEls().title;
  if (elTitle) elTitle.value = row?.title && row.title !== row.id ? row.title : row?.title || "";
  renderMeetingSessionList();
  updateMeetingControls();
  const token = meetingChannels.select.next();
  try {
    const [scan, proc, ana, life, sp] = await Promise.all([
      window.mimoInput.meetingScanSession(sessionId),
      window.mimoInput.meetingProcessStatus({ sessionId }),
      window.mimoInput.meetingAnalysisStatus({ sessionId }),
      window.mimoInput.meetingStatus(),
      window.mimoInput.meetingSpeakerMapGet?.({ sessionId })
    ]);
    if (!meetingAccept(meetingChannels.select, token, sessionId)) return;
    if (meetingState.selectedId !== sessionId) return;
    if (scan?.ok && scan.session) {
      const r = meetingState.sessions.find((s) => s.id === sessionId);
      if (r) r.status = scan.session.status;
    }
    meetingState.process = proc?.ok ? proc.processing : null;
    meetingState.analysis = ana?.ok ? ana.analysis : null;
    meetingState.lifecycle = life?.ok ? life.lifecycle : null;
    meetingState.speakerMap = sp?.ok ? sp.speakerMap : null;
    applyCaptureStartedFromLifecycle(meetingState.lifecycle);
    updateMeetingControls();
    await loadMeetingResultTab(meetingState.resultTab, { expectedSessionId: sessionId });
    await ensureMeetingPlayback(sessionId);
    if (meetingState.selectedId === sessionId) ensureMeetingPolling();
  } catch (error) {
    if (meetingState.selectedId !== sessionId) return;
    const hint = meetingEls().hint;
    if (hint) hint.textContent = error.message || String(error);
  }
}

function renderWorkbenchProcessModeControls({ locked = false } = {}) {
  const el = meetingEls();
  const imported = selectedMeetingRow()?.source === "import";
  const mode = meetingUi.normalizeProcessMode?.(meetingState.processMode) || "basic";
  const br = meetingUi.normalizeBitrateKbps?.(meetingState.bitrateKbps, 48) || 48;
  meetingState.processMode = mode;
  meetingState.bitrateKbps = br;
  for (const btn of [el.processModeBasicBtn, el.processModeEnhancedBtn]) {
    if (!btn) continue;
    const active = btn.dataset.meetingProcessMode === mode;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", String(active));
    btn.hidden = imported;
    btn.disabled = Boolean(locked) || imported;
  }
  if (el.bitrateGroup) {
    el.bitrateGroup.hidden = imported || mode !== "enhanced";
    for (const btn of el.bitrateGroup.querySelectorAll("[data-bitrate]")) {
      const val = Number(btn.dataset.bitrate);
      const active = val === br;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
      btn.disabled = Boolean(locked) || mode !== "enhanced";
    }
  }
  if (el.processModeHint) {
    el.processModeHint.textContent =
      imported
        ? "文件转写：使用文件 ASR 配置，本地分段，不上传 OSS"
        : mode === "enhanced"
          ? "说话人分离：系统轨上传 OSS"
          : "基础转写：本地，不上传";
  }
  if (el.processStartBtn) el.processStartBtn.textContent = imported ? "开始文件转写" : "生成原文";
}

function syncWorkbenchProcessModeFromSettings({ silent = false } = {}) {
  const mode =
    meetingUi.normalizeProcessMode?.(appSettings?.meetingProcessMode) || meetingState.processMode || "basic";
  const br =
    meetingUi.normalizeBitrateKbps?.(appSettings?.meetingUploadBitrateKbps, 48) ||
    meetingState.bitrateKbps ||
    48;
  const running = meetingUi.isProcessRunningStage?.(meetingState.process?.stage);
  if (running) {
    renderWorkbenchProcessModeControls({ locked: true });
    return;
  }
  meetingState.processMode = mode;
  meetingState.bitrateKbps = br;
  renderWorkbenchProcessModeControls({ locked: false });
  if (!silent) updateMeetingControls();
}

async function setWorkbenchProcessMode(mode, { persist = true } = {}) {
  const next = meetingUi.normalizeProcessMode?.(mode) || "basic";
  if (meetingUi.isProcessRunningStage?.(meetingState.process?.stage)) return;
  meetingState.processMode = next;
  renderWorkbenchProcessModeControls({ locked: false });
  renderMeetingSettingsMode(next);
  if (persist) {
    try {
      appSettings = await window.mimoInput.saveSettings({ meetingProcessMode: next });
    } catch {
      /* keep local UI */
    }
  }
  updateMeetingControls();
}

async function setWorkbenchBitrate(kbps, { persist = true } = {}) {
  const next = meetingUi.normalizeBitrateKbps?.(kbps, 48) || 48;
  if (meetingUi.isProcessRunningStage?.(meetingState.process?.stage)) return;
  meetingState.bitrateKbps = next;
  if (meetingUploadBitrateSelect) meetingUploadBitrateSelect.value = String(next);
  renderWorkbenchProcessModeControls({ locked: false });
  if (persist) {
    try {
      appSettings = await window.mimoInput.saveSettings({ meetingUploadBitrateKbps: next });
    } catch {
      /* keep local UI */
    }
  }
  updateMeetingControls();
}

function currentProcessPayloadExtras() {
  if (selectedMeetingRow()?.source === "import") {
    return { mode: "file", bitrateKbps: null };
  }
  return {
    mode: meetingUi.normalizeProcessMode?.(meetingState.processMode) || "basic",
    bitrateKbps: meetingUi.normalizeBitrateKbps?.(meetingState.bitrateKbps, 48) || 48
  };
}

function refreshMeetingSpeakerSelect() {
  const select = document.getElementById("meetingSpeakerSelect");
  if (!select) return;
  const speakers =
    meetingUi.extractUniqueSpeakers?.([meetingState.rawDoc, meetingState.correctedDoc]) || [];
  const prev = meetingState.activeSpeakerId || select.value || "";
  while (select.firstChild) select.removeChild(select.firstChild);
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = speakers.length ? "选择…" : "无说话人";
  select.appendChild(ph);
  for (const sp of speakers) {
    const opt = document.createElement("option");
    opt.value = sp.id;
    const display = meetingUi.resolveSpeakerDisplayName?.(sp.id, meetingState.speakerMap) || sp.label;
    opt.textContent = display === sp.id ? sp.label : `${display}（${sp.id}）`;
    select.appendChild(opt);
  }
  if (prev && [...select.options].some((o) => o.value === prev)) {
    select.value = prev;
    meetingState.activeSpeakerId = prev;
  }
}

function applyActiveSpeakerToForm(speakerId) {
  const id = String(speakerId || "").trim();
  meetingState.activeSpeakerId = id || null;
  const select = document.getElementById("meetingSpeakerSelect");
  const nameInput = document.getElementById("meetingSpeakerNameInput");
  if (select && id && [...select.options].some((o) => o.value === id)) {
    select.value = id;
  } else if (select && !id) {
    select.value = "";
  }
  if (nameInput) {
    nameInput.value = id
      ? meetingUi.resolveSpeakerDisplayName?.(id, meetingState.speakerMap) || ""
      : "";
  }
}

function decorateMeetingBlocks(doc) {
  const blocks = meetingUi.formatTranscriptBlocks?.(doc) || [];
  const map = meetingState.speakerMap;
  const items = Array.isArray(doc?.items) ? doc.items : [];
  return blocks.map((b, i) => {
    const item = items[i] || {};
    const id = b.speakerId || item.speakerId || "unknown";
    const display = meetingUi.resolveSpeakerDisplayName?.(id, map) || b.speakerId;
    return {
      ...b,
      speakerId: id,
      speakerDisplayName: display,
      artifactBeginMs: item.artifactBeginMs,
      beginMs: item.beginMs,
      sessionBeginMs: item.sessionBeginMs,
      sourceBeginMs: item.sourceBeginMs
    };
  });
}

function renderMeetingVirtualBlocks(container, blocks) {
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);
  if (!blocks.length) {
    const empty = document.createElement("p");
    empty.className = "meeting-empty";
    empty.textContent = "暂无内容";
    container.appendChild(empty);
    meetingState.virt = null;
    return;
  }
  const pane = document.getElementById("meetingResultPane");
  const vh = Math.max(120, pane?.clientHeight || 360);
  const prevHeights = meetingState.virt?.blocks === blocks ? meetingState.virt.virt?.heights : null;
  const virt = meetingUi.createVirtualWindow?.({
    itemCount: blocks.length,
    viewportHeight: vh,
    estimatedItemHeight: 88,
    overscan: 8,
    heights: prevHeights
  });

  const root = document.createElement("div");
  root.className = "meeting-result-virt";
  const spacer = document.createElement("div");
  spacer.className = "meeting-result-virt-spacer";
  const windowEl = document.createElement("div");
  windowEl.className = "meeting-result-virt-window";
  root.appendChild(spacer);
  root.appendChild(windowEl);
  container.appendChild(root);

  let measureQueued = false;

  function paint() {
    const cur = meetingState.virt;
    if (!cur || cur.blocks !== blocks || cur.virt !== virt || !virt) return;
    const r = virt.range();
    spacer.style.height = `${r.totalHeight}px`;
    windowEl.style.transform = `translateY(${r.offsetY}px)`;
    while (windowEl.firstChild) windowEl.removeChild(windowEl.firstChild);
    for (let i = r.start; i < r.end; i += 1) {
      const b = blocks[i];
      const block = document.createElement("article");
      block.className = "meeting-block";
      block.dataset.index = String(i);
      if (b.speakerId && b.speakerId === meetingState.activeSpeakerId) {
        block.classList.add("is-active-speaker");
      }
      const head = document.createElement("header");
      head.className = "meeting-block-head";
      const sp = document.createElement("strong");
      sp.textContent = b.speakerDisplayName || b.speakerId || "unknown";
      const tm = document.createElement("span");
      tm.textContent = b.timeLabel || "";
      head.appendChild(sp);
      head.appendChild(tm);
      const body = document.createElement("p");
      body.className = "meeting-block-body";
      body.textContent = b.text || "";
      block.appendChild(head);
      block.appendChild(body);
      block.addEventListener("click", () => {
        applyActiveSpeakerToForm(b.speakerId || "");
        const ms = meetingUi.seekMsFromTranscriptItem?.(b);
        seekMeetingAudio(ms);
        const latest = meetingState.virt?.paint;
        if (typeof latest === "function") latest();
      });
      windowEl.appendChild(block);
    }
    if (!measureQueued) {
      measureQueued = true;
      requestAnimationFrame(() => {
        measureQueued = false;
        const cur2 = meetingState.virt;
        if (!cur2 || cur2.blocks !== blocks || cur2.virt !== virt) return;
        const scrollTop = pane?.scrollTop || 0;
        const anchor = virt.indexAtOffset?.(scrollTop) ?? 0;
        const anchorOffset = Math.max(0, scrollTop - (virt.offsetOf?.(anchor) || 0));
        let changed = false;
        for (const node of windowEl.children) {
          const idx = Number(node.dataset.index);
          if (!Number.isFinite(idx)) continue;
          const h = node.getBoundingClientRect().height;
          if (virt.setMeasuredHeight?.(idx, h)) changed = true;
        }
        if (changed) {
          const nextTop = virt.reanchorScroll?.(anchor, anchorOffset) ?? scrollTop;
          if (pane) pane.scrollTop = nextTop;
          paint();
        }
      });
    }
  }

  // Always store current paint so a single scroll listener never closes over a stale paint.
  meetingState.virt = { virt, blocks, paint };

  if (pane && !pane.dataset.virtBound) {
    pane.dataset.virtBound = "1";
    pane.addEventListener("scroll", () => {
      const cur = meetingState.virt;
      if (!cur?.virt) return;
      cur.virt.setScrollTop(pane.scrollTop);
      if (typeof cur.paint === "function") cur.paint();
    });
  }
  virt.setScrollTop(pane?.scrollTop || 0);
  paint();
}

async function ensureMeetingPlayback(sessionId) {
  const audio = document.getElementById("meetingAudio");
  const hint = document.getElementById("meetingPlaybackHint");
  if (!audio || !window.mimoInput.meetingPlaybackToken) return;
  try {
    const row = meetingState.sessions.find((s) => s.id === sessionId);
    const prefer =
      row?.importMeta?.track === "system"
        ? "system"
        : row?.archiveTracks?.includes("system") && !row?.archiveTracks?.includes("microphone")
          ? "system"
          : "auto";
    const res = await window.mimoInput.meetingPlaybackToken({ sessionId, track: prefer });
    if (meetingState.selectedId !== sessionId) return;
    if (!res?.ok || !res.url) {
      if (hint) hint.textContent = "暂无可用 archive 音频";
      return;
    }
    meetingState.playbackUrl = res.url;
    audio.src = res.url;
    if (hint) {
      const tr = res.track || prefer;
      hint.textContent =
        res.durationMs != null
          ? `单轨回放(${tr}) · ${meetingUi.formatElapsed?.(res.durationMs) || ""} · 点击转写块跳转`
          : `单轨回放(${tr}) · 点击转写块跳转`;
    }
  } catch (error) {
    if (hint) hint.textContent = error.message || "回放不可用";
  }
}

function seekMeetingAudio(ms) {
  const audio = document.getElementById("meetingAudio");
  if (!audio || ms == null || !Number.isFinite(Number(ms))) return;
  const sec = Math.max(0, Number(ms) / 1000);
  const apply = () => {
    try {
      audio.currentTime = sec;
      audio.play?.().catch(() => {});
    } catch {
      /* ignore */
    }
  };
  if (audio.readyState >= 1) apply();
  else audio.addEventListener("loadedmetadata", apply, { once: true });
}

async function meetingRenameSession() {
  if (!meetingState.selectedId) return;
  const title = meetingEls().title?.value || "";
  const res = await window.mimoInput.meetingRenameSession({
    sessionId: meetingState.selectedId,
    title
  });
  if (!res?.ok) throw new Error(res?.error?.message || "重命名失败");
  await refreshMeetingSessions();
  const hint = meetingEls().hint;
  if (hint) hint.textContent = "标题已保存";
}

function setImportCancelEnabled(on) {
  const btn = document.getElementById("meetingImportCancelBtn");
  if (btn) btn.disabled = !on;
}

async function refreshMeetingSessionIfSelected(sessionId) {
  await refreshMeetingSessions();
  if (meetingState.selectedId === sessionId) {
    // Refresh status for current selection without forcing navigation away
    const row = meetingState.sessions.find((s) => s.id === sessionId);
    if (row) {
      updateMeetingControls();
      if (row.status === "stopped") {
        await selectMeetingSession(sessionId);
      }
    }
  }
}

async function pollMeetingImport(sessionId) {
  const hint = meetingEls().hint;
  meetingState.importSessionId = sessionId;
  meetingState.importBusy = true;
  setImportCancelEnabled(true);
  updateMeetingControls();
  try {
    // ~6 hours at 400ms interval; cancel remains available via importSessionId
    const maxTicks = Math.ceil((6 * 60 * 60 * 1000) / 400);
    for (let i = 0; i < maxTicks; i += 1) {
      const st = await window.mimoInput.meetingImportStatus?.({ sessionId });
      const status = st?.status || "";
      if (status === "stopped") {
        await refreshMeetingSessionIfSelected(sessionId);
        if (hint) {
          hint.textContent =
            meetingState.selectedId === sessionId
              ? "导入完成（已停止）。请手动「生成原文」；源文件未删除。"
              : `会话导入完成（${sessionId.slice(0, 8)}…）`;
        }
        return;
      }
      if (status === "import_failed") {
        await refreshMeetingSessionIfSelected(sessionId);
        if (hint) hint.textContent = st?.import?.message || "导入失败（半成品已隔离至 quarantine）";
        return;
      }
      if (status === "import_cancelled") {
        await refreshMeetingSessionIfSelected(sessionId);
        if (hint) hint.textContent = "导入已取消（半成品已隔离，未删源文件）";
        return;
      }
      if (status === "import_interrupted") {
        await refreshMeetingSessionIfSelected(sessionId);
        if (hint) hint.textContent = "导入已中断，请重新选择媒体文件";
        return;
      }
      if (hint && i % 2 === 0 && meetingState.selectedId === sessionId) {
        const phase = st?.phase || st?.import?.phase || "running";
        const phaseLabel =
          phase === "copy"
            ? "复制源文件"
            : phase === "extract"
              ? "抽取音轨"
              : phase === "commit"
                ? "提交 archive"
                : phase === "done"
                  ? "完成"
                  : "导入中";
        let prog = "";
        if (st?.progress?.total > 0) {
          const pct = Math.min(100, Math.round((100 * (st.progress.bytes || 0)) / st.progress.total));
          prog = ` ${pct}%`;
        }
        hint.textContent = `${phaseLabel}${prog}…（可取消）`;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (hint) hint.textContent = "导入超时，请查看状态或重新导入";
  } finally {
    if (meetingState.importSessionId === sessionId) {
      meetingState.importSessionId = null;
    }
    meetingState.importBusy = Boolean(meetingState.importSessionId);
    setImportCancelEnabled(Boolean(meetingState.importSessionId));
    updateMeetingControls();
  }
}

function meetingImportRolePayload() {
  const roleSel = document.getElementById("meetingImportRoleSelect")?.value || "personal";
  if (roleSel === "mix") {
    return { track: "system", role: "remote_unknown" };
  }
  return { track: "microphone", role: "self" };
}

async function meetingImportWav() {
  if (meetingState.importBusy || meetingState.importSessionId) return;
  const hint = meetingEls().hint;
  if (hint) hint.textContent = "选择媒体…";
  try {
    const title = meetingEls().title?.value?.trim() || "";
    const rolePayload = meetingImportRolePayload();
    const api = window.mimoInput.meetingImportMedia || window.mimoInput.meetingImportWav;
    const res = await api({ title, ...rolePayload });
    if (res?.cancelled) {
      if (hint) hint.textContent = "已取消选择文件";
      return;
    }
    if (!res?.ok) throw new Error(res?.error?.message || "导入启动失败");
    await refreshMeetingSessions();
    if (res.sessionId) {
      // Select the new import session once; later completion won't force-switch if user left
      await selectMeetingSession(res.sessionId);
      if (res.status === "importing") {
        await pollMeetingImport(res.sessionId);
      }
    }
  } catch (e) {
    if (hint) hint.textContent = e.message || String(e);
    throw e;
  }
}

async function meetingImportCancel() {
  // Always cancel the in-flight import job, even if UI selection moved to another session.
  const sid = meetingState.importSessionId || meetingState.selectedId;
  if (!sid) return;
  const res = await window.mimoInput.meetingImportCancel?.({ sessionId: sid });
  const hint = meetingEls().hint;
  if (hint) hint.textContent = res?.cancelled ? "正在取消导入…" : "当前无导入任务";
}

async function meetingExportCurrent() {
  if (!meetingState.selectedId) return;
  const format = document.getElementById("meetingExportFormatSelect")?.value || "markdown";
  const scope = document.getElementById("meetingExportScopeSelect")?.value || "all";
  const res = await window.mimoInput.meetingExportSave({
    sessionId: meetingState.selectedId,
    format,
    scope
  });
  const hint = meetingEls().hint;
  if (res?.cancelled) {
    if (hint) hint.textContent = "已取消导出";
    return;
  }
  if (res?.skippedSrt) {
    const w = (res.warnings || []).map((x) => x.message || x.code).filter(Boolean).join("；");
    if (hint) {
      hint.textContent = w || "SRT 无可用时间戳，已写入 export-report.json（未伪造时间）。";
    }
    return;
  }
  if (!res?.ok) throw new Error(res?.error?.message || "导出失败");
  const warn = (res.warnings || []).length
    ? `（部分跳过: ${(res.warnings || []).map((x) => x.code).join(",")}）`
    : "";
  if (hint) hint.textContent = `已导出 ${format}/${scope}${warn}`;
}

async function meetingSaveSpeakerName() {
  const select = document.getElementById("meetingSpeakerSelect");
  const speakerId = String(select?.value || meetingState.activeSpeakerId || "").trim();
  if (!meetingState.selectedId || !speakerId) {
    const hint = meetingEls().hint;
    if (hint) hint.textContent = "请先选择说话人";
    return;
  }
  const sid = meetingState.selectedId;
  const name = document.getElementById("meetingSpeakerNameInput")?.value || "";
  const speakers = {
    ...(meetingState.speakerMap?.speakers || {}),
    [speakerId]: { displayName: name }
  };
  const res = await window.mimoInput.meetingSpeakerMapSet({
    sessionId: sid,
    speakers
  });
  // Stale guard: session switch while save in-flight must not apply
  if (
    !meetingUi.shouldApplySpeakerMapSave?.({
      selectedId: meetingState.selectedId,
      saveSessionId: sid
    })
  ) {
    return;
  }
  if (!res?.ok) throw new Error(res?.error?.message || "保存失败");
  meetingState.speakerMap = res.speakerMap;
  meetingState.activeSpeakerId = speakerId;
  refreshMeetingSpeakerSelect();
  applyActiveSpeakerToForm(speakerId);
  await loadMeetingResultTab(meetingState.resultTab, { expectedSessionId: sid });
  const hint = meetingEls().hint;
  if (hint) hint.textContent = "说话人显示名已保存（不改 raw 文本/哈希）";
}

async function loadMeetingResultTab(tab, { expectedSessionId } = {}) {
  const el = meetingEls();
  const wantTab = tab || meetingState.resultTab || "raw";
  meetingState.resultTab = wantTab;
  for (const btn of document.querySelectorAll("[data-meeting-tab]")) {
    const on = btn.dataset.meetingTab === meetingState.resultTab;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  }
  if (!meetingState.selectedId) {
    if (el.resultEmpty) {
      el.resultEmpty.hidden = false;
      el.resultEmpty.textContent = "选择会话并生成结果后显示在这里。";
    }
    if (el.resultContent) el.resultContent.hidden = true;
    return;
  }
  const sid = expectedSessionId || meetingState.selectedId;
  const token = meetingChannels.result.next();
  try {
    if (meetingState.resultTab === "raw") {
      if (!meetingState.rawDoc) {
        const res = await window.mimoInput.meetingTranscriptGet({ sessionId: sid });
        if (!meetingAccept(meetingChannels.result, token, sid)) return;
        if (meetingState.selectedId !== sid || meetingState.resultTab !== "raw") return;
        meetingState.rawDoc = res?.ok ? res.transcript : null;
      } else if (!meetingAccept(meetingChannels.result, token, sid)) {
        return;
      }
      if (meetingState.selectedId !== sid || meetingState.resultTab !== "raw") return;
      const blocks = decorateMeetingBlocks(meetingState.rawDoc);
      refreshMeetingSpeakerSelect();
      if (el.resultEmpty) el.resultEmpty.hidden = blocks.length > 0;
      if (el.resultContent) {
        el.resultContent.hidden = blocks.length === 0;
        renderMeetingVirtualBlocks(el.resultContent, blocks);
      }
    } else if (meetingState.resultTab === "corrected") {
      if (!meetingState.correctedDoc) {
        const res = await window.mimoInput.meetingAnalysisCorrected({ sessionId: sid });
        if (!meetingAccept(meetingChannels.result, token, sid)) return;
        if (meetingState.selectedId !== sid || meetingState.resultTab !== "corrected") return;
        meetingState.correctedDoc = res?.ok ? res.corrected : null;
      } else if (!meetingAccept(meetingChannels.result, token, sid)) {
        return;
      }
      if (meetingState.selectedId !== sid || meetingState.resultTab !== "corrected") return;
      const blocks = decorateMeetingBlocks(meetingState.correctedDoc);
      refreshMeetingSpeakerSelect();
      if (el.resultEmpty) {
        el.resultEmpty.hidden = blocks.length > 0;
        if (!blocks.length) el.resultEmpty.textContent = "尚无校订文本。请先「校订并总结」。";
      }
      if (el.resultContent) {
        el.resultContent.hidden = blocks.length === 0;
        renderMeetingVirtualBlocks(el.resultContent, blocks);
      }
    } else {
      if (!meetingState.summaryDoc) {
        const res = await window.mimoInput.meetingAnalysisSummary({ sessionId: sid });
        if (!meetingAccept(meetingChannels.result, token, sid)) return;
        if (meetingState.selectedId !== sid || meetingState.resultTab !== "summary") return;
        meetingState.summaryDoc = res?.ok ? res.summary : null;
      } else if (!meetingAccept(meetingChannels.result, token, sid)) {
        return;
      }
      if (meetingState.selectedId !== sid || meetingState.resultTab !== "summary") return;
      const sections = meetingUi.flattenSummarySections?.(meetingState.summaryDoc) || [];
      if (el.resultEmpty) {
        el.resultEmpty.hidden = sections.length > 0;
        if (!sections.length) el.resultEmpty.textContent = "尚无结构化总结。";
      }
      if (el.resultContent) {
        el.resultContent.hidden = sections.length === 0;
        meetingUi.appendSummarySections?.(el.resultContent, sections);
      }
    }
  } catch (error) {
    if (meetingState.selectedId !== sid) return;
    if (!meetingAccept(meetingChannels.result, token, sid)) return;
    if (el.resultEmpty) {
      el.resultEmpty.hidden = false;
      el.resultEmpty.textContent = error.message || "加载失败";
    }
    if (el.resultContent) el.resultContent.hidden = true;
  }
}

function ensureMeetingPolling() {
  stopMeetingPolling();
  if (currentWindowMode !== "meeting") return;
  const need = meetingUi.needsMeetingPolling?.({
    lifecycle: meetingState.lifecycle,
    process: meetingState.process,
    analysis: meetingState.analysis,
    selectedId: meetingState.selectedId
  });
  if (!need) return;
  meetingState.pollTimer = setInterval(() => {
    refreshMeetingLive().catch(() => {});
  }, 1200);
  const eff = effectiveMeetingLifecycle();
  if (eff?.status === "recording" || eff?.status === "paused") {
    meetingState.clockTimer = setInterval(() => updateMeetingControls(), 500);
  }
}

async function refreshMeetingLive() {
  if (!meetingState.selectedId || currentWindowMode !== "meeting") return;
  const sid = meetingState.selectedId;
  const token = meetingChannels.poll.next();
  const [proc, ana, life] = await Promise.all([
    window.mimoInput.meetingProcessStatus({ sessionId: sid }),
    window.mimoInput.meetingAnalysisStatus({ sessionId: sid }),
    window.mimoInput.meetingStatus()
  ]);
  if (!meetingAccept(meetingChannels.poll, token, sid)) return;
  if (meetingState.selectedId !== sid) return;

  const merged = meetingUi.mergePollSnapshot?.(
    {
      process: meetingState.process,
      analysis: meetingState.analysis,
      lifecycle: meetingState.lifecycle,
      captureStartedAt: meetingState.captureStartedAt,
      rawDoc: meetingState.rawDoc,
      correctedDoc: meetingState.correctedDoc,
      summaryDoc: meetingState.summaryDoc,
      selectedId: meetingState.selectedId
    },
    {
      process: proc?.ok ? proc.processing : null,
      analysis: ana?.ok ? ana.analysis : null,
      lifecycle: life?.ok ? life.lifecycle : null,
      selectedId: sid
    }
  );

  if (merged) {
    meetingState.process = merged.process;
    meetingState.analysis = merged.analysis;
    meetingState.lifecycle = merged.lifecycle;
    meetingState.captureStartedAt = merged.captureStartedAt;
    meetingState.rawDoc = merged.rawDoc;
    meetingState.correctedDoc = merged.correctedDoc;
    meetingState.summaryDoc = merged.summaryDoc;
  } else {
    if (proc?.ok) meetingState.process = proc.processing;
    if (ana?.ok) meetingState.analysis = ana.analysis;
    if (life?.ok) meetingState.lifecycle = life.lifecycle;
    applyCaptureStartedFromLifecycle(meetingState.lifecycle);
  }

  updateMeetingControls();
  if (merged?.refreshResult) {
    await loadMeetingResultTab(meetingState.resultTab, { expectedSessionId: sid });
  }
  const settledProc = ["completed", "failed", "cancelled", "idle"].includes(meetingState.process?.stage);
  const settledAna = ["completed", "failed", "cancelled", "none"].includes(meetingState.analysis?.status);
  const lifeBusy = meetingUi.isBusyCapture?.(effectiveMeetingLifecycle()?.status);
  if (!lifeBusy && settledProc && settledAna) stopMeetingPolling();
  else ensureMeetingPolling();
}

async function openMeetingWorkspace({ fromModeEvent = false } = {}) {
  return meetingOpenFlight.run(async () => {
    if (!fromModeEvent) {
      await window.mimoInput.openMeetingWorkspace?.();
    }
    applyWindowMode("meeting");
    if (settingsPanel) settingsPanel.hidden = true;
    if (meetingPanel) meetingPanel.hidden = false;
    const hint = meetingEls().hint;
    if (hint) hint.textContent = "停止仅落盘本地；需手动生成原文。";
    try {
      await refreshMeetingDevices();
      await refreshMeetingSessions();
      if (meetingState.selectedId) await selectMeetingSession(meetingState.selectedId);
      else updateMeetingControls();
    } catch (error) {
      if (hint) hint.textContent = error.message || String(error);
    }
  });
}

async function meetingCreateSession() {
  const title = meetingEls().title?.value?.trim() || "";
  const res = await window.mimoInput.meetingCreateSession({ title });
  if (!res?.ok && res?.error) throw new Error(res.error.message || "创建失败");
  const id = res.sessionId || res.id;
  await refreshMeetingSessions();
  if (id) await selectMeetingSession(id);
}

async function meetingStartCapture() {
  if (!meetingState.selectedId) return;
  const sid = meetingState.selectedId;
  const el = meetingEls();
  const payload = {
    sessionId: sid,
    deviceId: el.mic?.value || undefined,
    systemDeviceId: el.sys?.value || undefined,
    captureMode: el.mode?.value || "dual"
  };
  appSettings = await window.mimoInput.saveSettings({
    meetingMicrophoneDeviceId: payload.deviceId || "",
    meetingSystemDeviceId: payload.systemDeviceId || "",
    meetingCaptureMode: payload.captureMode
  });
  if (meetingState.selectedId !== sid) return;
  const res = await window.mimoInput.meetingStart(payload);
  if (meetingState.selectedId !== sid) return;
  if (res?.ok === false) throw new Error(res.error?.message || "开始失败");
  const startedAtMs = Number(res.startedAtMs) || Date.now();
  meetingState.lifecycle = {
    status: "recording",
    sessionId: sid,
    lastError: null,
    startedAtMs
  };
  meetingState.captureStartedAt = startedAtMs;
  updateMeetingControls();
  ensureMeetingPolling();
}

async function meetingPauseCapture() {
  const sid = meetingState.selectedId;
  if (!sid) return;
  const res = await window.mimoInput.meetingPause({ sessionId: sid });
  if (meetingState.selectedId !== sid) return;
  if (res?.ok === false) throw new Error(res.error?.message || "暂停失败");
  if (!meetingUi.shouldDriveCaptureUi?.(meetingState.lifecycle, sid) && res.sessionId && res.sessionId !== sid) {
    return;
  }
  meetingState.lifecycle = {
    ...(meetingState.lifecycle || {}),
    status: "paused",
    sessionId: sid
  };
  applyCaptureStartedFromLifecycle(meetingState.lifecycle);
  updateMeetingControls();
}

async function meetingResumeCapture() {
  const sid = meetingState.selectedId;
  if (!sid) return;
  const res = await window.mimoInput.meetingResume({ sessionId: sid });
  if (meetingState.selectedId !== sid) return;
  if (res?.ok === false) throw new Error(res.error?.message || "继续失败");
  meetingState.lifecycle = {
    ...(meetingState.lifecycle || {}),
    status: "recording",
    sessionId: sid
  };
  applyCaptureStartedFromLifecycle(meetingState.lifecycle);
  updateMeetingControls();
  ensureMeetingPolling();
}

async function meetingStopCapture() {
  const sid = meetingState.selectedId;
  if (!sid) return;
  const res = await window.mimoInput.meetingStop({ sessionId: sid });
  if (meetingState.selectedId !== sid) return;
  if (res?.ok === false) throw new Error(res.error?.message || "停止失败");
  meetingState.lifecycle = {
    status: "stopped",
    sessionId: sid,
    lastError: null,
    startedAtMs: null
  };
  meetingState.captureStartedAt = 0;
  updateMeetingControls();
  await refreshMeetingSessions();
  if (meetingState.selectedId !== sid) return;
  const hint = meetingEls().hint;
  if (hint) hint.textContent = "已停止（仅本地）。可点击「生成原文」。";
  ensureMeetingPolling();
}

async function reconcileMeetingProcessResult(sid, token, res) {
  if (!meetingAccept(meetingChannels.process, token, sid)) return false;
  if (!res?.ok) {
    throw new Error(res?.error?.message || "处理失败");
  }
  meetingState.process = res.processing;
  meetingState.rawDoc = null;
  updateMeetingControls();
  ensureMeetingPolling();
  if (meetingState.resultTab === "raw") {
    await loadMeetingResultTab("raw", { expectedSessionId: sid });
  }
  return true;
}

async function reconcileMeetingAnalysisResult(sid, token, res) {
  if (!meetingAccept(meetingChannels.analysis, token, sid)) return false;
  if (!res?.ok) {
    throw new Error(res?.error?.message || "分析失败");
  }
  meetingState.analysis = res.analysis;
  meetingState.correctedDoc = null;
  meetingState.summaryDoc = null;
  updateMeetingControls();
  ensureMeetingPolling();
  return true;
}

async function fetchMeetingStatusAfterError(sid, channel, token, kind) {
  if (!sid) return;
  let recovered = false;
  try {
    const [proc, ana] = await Promise.all([
      window.mimoInput.meetingProcessStatus({ sessionId: sid }),
      window.mimoInput.meetingAnalysisStatus({ sessionId: sid })
    ]);
    if (!meetingAccept(channel, token, sid)) return;
    if (proc?.ok) {
      meetingState.process = proc.processing;
      recovered = true;
    }
    if (ana?.ok) {
      meetingState.analysis = ana.analysis;
      recovered = true;
    }
    updateMeetingControls();
    ensureMeetingPolling();
  } catch {
    recovered = false;
  }
  if (!recovered && meetingAccept(channel, token, sid)) {
    if (kind === "process") {
      meetingState.process = meetingUi.clearOptimisticProcess?.(meetingState.process) || {
        stage: "failed",
        status: "failed",
        optimistic: false
      };
    } else if (kind === "analysis") {
      meetingState.analysis = meetingUi.clearOptimisticAnalysis?.(meetingState.analysis) || {
        status: "failed",
        optimistic: false
      };
    }
    updateMeetingControls();
    ensureMeetingPolling();
  }
}

async function meetingProcessStart() {
  if (!meetingState.selectedId) return;
  const sid = meetingState.selectedId;
  const token = meetingChannels.process.next();
  const extras = currentProcessPayloadExtras();
  meetingState.process = meetingUi.buildOptimisticProcessRunning?.(meetingState.process) || {
    stage: "exporting",
    status: "running",
    optimistic: true
  };
  meetingState.process = {
    ...meetingState.process,
    processMode: extras.mode,
    mode: extras.mode,
    bitrateKbps: extras.mode === "enhanced" ? extras.bitrateKbps : null
  };
  meetingState.rawDoc = null;
  updateMeetingControls();
  ensureMeetingPolling();
  try {
    const payload =
      meetingUi.buildProcessPayload?.({
        sessionId: sid,
        mode: extras.mode,
        bitrateKbps: extras.bitrateKbps
      }) || { sessionId: sid, mode: extras.mode, bitrateKbps: extras.bitrateKbps };
    const res = await window.mimoInput.meetingProcessStart(payload);
    await reconcileMeetingProcessResult(sid, token, res);
  } catch (error) {
    await fetchMeetingStatusAfterError(sid, meetingChannels.process, token, "process");
    throw error;
  }
}

async function meetingProcessRetry() {
  if (!meetingState.selectedId) return;
  const sid = meetingState.selectedId;
  const token = meetingChannels.process.next();
  const extras = currentProcessPayloadExtras();
  meetingState.process = meetingUi.buildOptimisticProcessRunning?.(meetingState.process) || {
    stage: "exporting",
    status: "running",
    optimistic: true
  };
  meetingState.process = {
    ...meetingState.process,
    processMode: extras.mode,
    mode: extras.mode,
    bitrateKbps: extras.mode === "enhanced" ? extras.bitrateKbps : null
  };
  meetingState.rawDoc = null;
  updateMeetingControls();
  ensureMeetingPolling();
  try {
    const payload =
      meetingUi.buildProcessPayload?.({
        sessionId: sid,
        mode: extras.mode,
        bitrateKbps: extras.bitrateKbps,
        resetAttempts: true
      }) || {
        sessionId: sid,
        mode: extras.mode,
        bitrateKbps: extras.bitrateKbps,
        resetAttempts: true
      };
    const res = await window.mimoInput.meetingProcessRetry(payload);
    await reconcileMeetingProcessResult(sid, token, res);
  } catch (error) {
    await fetchMeetingStatusAfterError(sid, meetingChannels.process, token, "process");
    throw error;
  }
}

async function meetingProcessCancel() {
  const sid = meetingState.selectedId;
  if (!sid) return;
  const token = meetingChannels.process.next();
  const res = await window.mimoInput.meetingProcessCancel({ sessionId: sid });
  if (!meetingAccept(meetingChannels.process, token, sid)) return;
  if (!res?.ok) throw new Error(res?.error?.message || "取消失败");
  meetingState.process = res.processing;
  updateMeetingControls();
  ensureMeetingPolling();
}

async function meetingAnalysisStart() {
  if (!meetingState.selectedId) return;
  const sid = meetingState.selectedId;
  const token = meetingChannels.analysis.next();
  const template = meetingEls().template?.value || "auto";
  meetingState.analysis = meetingUi.buildOptimisticAnalysisRunning?.(meetingState.analysis) || {
    status: "running",
    stage: "fingerprint",
    optimistic: true
  };
  meetingState.correctedDoc = null;
  meetingState.summaryDoc = null;
  updateMeetingControls();
  ensureMeetingPolling();
  try {
    const res = await window.mimoInput.meetingAnalysisStart({
      sessionId: sid,
      template
    });
    await reconcileMeetingAnalysisResult(sid, token, res);
  } catch (error) {
    await fetchMeetingStatusAfterError(sid, meetingChannels.analysis, token, "analysis");
    throw error;
  }
}

async function meetingAnalysisRetry() {
  if (!meetingState.selectedId) return;
  const sid = meetingState.selectedId;
  const token = meetingChannels.analysis.next();
  meetingState.analysis = meetingUi.buildOptimisticAnalysisRunning?.(meetingState.analysis) || {
    status: "running",
    stage: "fingerprint",
    optimistic: true
  };
  meetingState.correctedDoc = null;
  meetingState.summaryDoc = null;
  updateMeetingControls();
  ensureMeetingPolling();
  try {
    const res = await window.mimoInput.meetingAnalysisRetry({
      sessionId: sid,
      resetAttempts: true
    });
    await reconcileMeetingAnalysisResult(sid, token, res);
  } catch (error) {
    await fetchMeetingStatusAfterError(sid, meetingChannels.analysis, token, "analysis");
    throw error;
  }
}

async function meetingAnalysisCancel() {
  const sid = meetingState.selectedId;
  if (!sid) return;
  const token = meetingChannels.analysis.next();
  const res = await window.mimoInput.meetingAnalysisCancel({ sessionId: sid });
  if (!meetingAccept(meetingChannels.analysis, token, sid)) return;
  if (!res?.ok) throw new Error(res?.error?.message || "取消失败");
  meetingState.analysis = res.analysis;
  updateMeetingControls();
  ensureMeetingPolling();
}

function meetingCopyCurrent() {
  let text = "";
  if (meetingState.resultTab === "summary") {
    const sections = meetingUi.flattenSummarySections?.(meetingState.summaryDoc) || [];
    text = sections.map((s) => `${s.title}\n${s.lines.map((l) => `· ${l}`).join("\n")}`).join("\n\n");
  } else {
    const doc = meetingState.resultTab === "corrected" ? meetingState.correctedDoc : meetingState.rawDoc;
    const blocks = meetingUi.formatTranscriptBlocks?.(doc) || [];
    text = blocks.map((b) => `[${b.speakerId}] ${b.timeLabel}\n${b.text}`).join("\n\n");
  }
  if (!text) return;
  window.mimoInput.copyText(text);
}

function bindMeetingUi() {
  if (!meetingPanel) return;
  document.getElementById("meetingNewSessionBtn")?.addEventListener("click", () => {
    meetingCreateSession().catch((e) => {
      const h = meetingEls().hint;
      if (h) h.textContent = e.message || String(e);
    });
  });
  document.getElementById("meetingRefreshSessionsBtn")?.addEventListener("click", () => {
    refreshMeetingSessions().catch(() => {});
  });
  document.getElementById("meetingRefreshDevicesBtn")?.addEventListener("click", () => {
    refreshMeetingDevices().catch(() => {});
  });
  document.getElementById("meetingSessionSearch")?.addEventListener("input", () => renderMeetingSessionList());
  document.getElementById("meetingStartBtn")?.addEventListener("click", () => {
    meetingStartCapture().catch((e) => {
      const h = meetingEls().hint;
      if (h) h.textContent = e.message || String(e);
    });
  });
  document.getElementById("meetingPauseBtn")?.addEventListener("click", () => {
    meetingPauseCapture().catch((e) => {
      const h = meetingEls().hint;
      if (h) h.textContent = e.message || String(e);
    });
  });
  document.getElementById("meetingResumeBtn")?.addEventListener("click", () => {
    meetingResumeCapture().catch((e) => {
      const h = meetingEls().hint;
      if (h) h.textContent = e.message || String(e);
    });
  });
  document.getElementById("meetingStopBtn")?.addEventListener("click", () => {
    meetingStopCapture().catch((e) => {
      const h = meetingEls().hint;
      if (h) h.textContent = e.message || String(e);
    });
  });
  document.getElementById("meetingProcessStartBtn")?.addEventListener("click", () => {
    meetingProcessStart().catch((e) => {
      const h = meetingEls().hint;
      if (h) h.textContent = e.message || String(e);
    });
  });
  document.getElementById("meetingProcessRetryBtn")?.addEventListener("click", () => {
    meetingProcessRetry().catch((e) => {
      const h = meetingEls().hint;
      if (h) h.textContent = e.message || String(e);
    });
  });
  document.getElementById("meetingProcessCancelBtn")?.addEventListener("click", () => {
    meetingProcessCancel().catch((e) => {
      const h = meetingEls().hint;
      if (h) h.textContent = e.message || String(e);
    });
  });
  document.getElementById("meetingAnalysisStartBtn")?.addEventListener("click", () => {
    meetingAnalysisStart().catch((e) => {
      const h = meetingEls().hint;
      if (h) h.textContent = e.message || String(e);
    });
  });
  document.getElementById("meetingAnalysisRetryBtn")?.addEventListener("click", () => {
    meetingAnalysisRetry().catch((e) => {
      const h = meetingEls().hint;
      if (h) h.textContent = e.message || String(e);
    });
  });
  document.getElementById("meetingAnalysisCancelBtn")?.addEventListener("click", () => {
    meetingAnalysisCancel().catch((e) => {
      const h = meetingEls().hint;
      if (h) h.textContent = e.message || String(e);
    });
  });
  document.getElementById("meetingCopyResultBtn")?.addEventListener("click", () => meetingCopyCurrent());
  document.getElementById("meetingRenameBtn")?.addEventListener("click", () => {
    meetingRenameSession().catch((e) => {
      const h = meetingEls().hint;
      if (h) h.textContent = e.message || String(e);
    });
  });
  document.getElementById("meetingImportWavBtn")?.addEventListener("click", () => {
    meetingImportWav().catch((e) => {
      const h = meetingEls().hint;
      if (h) h.textContent = e.message || String(e);
    });
  });
  document.getElementById("meetingImportCancelBtn")?.addEventListener("click", () => {
    meetingImportCancel().catch((e) => {
      const h = meetingEls().hint;
      if (h) h.textContent = e.message || String(e);
    });
  });
  document.getElementById("meetingExportBtn")?.addEventListener("click", () => {
    meetingExportCurrent().catch((e) => {
      const h = meetingEls().hint;
      if (h) h.textContent = e.message || String(e);
    });
  });
  document.getElementById("meetingSpeakerSaveBtn")?.addEventListener("click", () => {
    meetingSaveSpeakerName().catch((e) => {
      const h = meetingEls().hint;
      if (h) h.textContent = e.message || String(e);
    });
  });
  document.getElementById("meetingSpeakerSelect")?.addEventListener("change", (ev) => {
    applyActiveSpeakerToForm(ev.target?.value || "");
    const latest = meetingState.virt?.paint;
    if (typeof latest === "function") latest();
  });
  document.getElementById("meetingProcessModeBasicBtn")?.addEventListener("click", () => {
    setWorkbenchProcessMode("basic").catch(() => {});
  });
  document.getElementById("meetingProcessModeEnhancedBtn")?.addEventListener("click", () => {
    setWorkbenchProcessMode("enhanced").catch(() => {});
  });
  document.getElementById("meetingBitrateGroup")?.addEventListener("click", (ev) => {
    const btn = ev.target?.closest?.("[data-bitrate]");
    if (!btn) return;
    setWorkbenchBitrate(btn.dataset.bitrate).catch(() => {});
  });
  meetingSettingsModeBasicBtn?.addEventListener("click", () => {
    renderMeetingSettingsMode("basic");
    setWorkbenchProcessMode("basic").catch(() => {});
  });
  meetingSettingsModeEnhancedBtn?.addEventListener("click", () => {
    renderMeetingSettingsMode("enhanced");
    setWorkbenchProcessMode("enhanced").catch(() => {});
  });
  meetingUploadBitrateSelect?.addEventListener("change", () => {
    setWorkbenchBitrate(meetingUploadBitrateSelect.value).catch(() => {});
  });
  meetingFunTestBtn?.addEventListener("click", () => {
    runMeetingEnhancedTest("fun").catch(() => {});
  });
  meetingOssTestBtn?.addEventListener("click", () => {
    runMeetingEnhancedTest("oss").catch(() => {});
  });
  for (const btn of document.querySelectorAll("[data-meeting-tab]")) {
    btn.addEventListener("click", () => {
      loadMeetingResultTab(btn.dataset.meetingTab).catch(() => {});
    });
  }
meetingBtn?.addEventListener("click", () => {
    openMeetingWorkspace().catch((e) => setStatus("error", "会议工作台", e.message || String(e)));
  });

window.mimoInput.onWindowMaximized?.((maximized) => renderWindowMaximizeButton(maximized));
window.mimoInput.isWindowMaximized?.().then((result) => renderWindowMaximizeButton(result?.maximized)).catch(() => {});
  syncWorkbenchProcessModeFromSettings({ silent: true });
}

bindMeetingUi();

applyWindowMode("compact");
refreshStatus().then(() => refreshMicrophones());
setButtons("ready");
