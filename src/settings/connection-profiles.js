"use strict";

const MIMO_ASR_MODEL = "mimo-v2.5-asr";
const QWEN_ASR_MODEL = "qwen3-asr-flash";
const FUN_ASR_MODEL = "fun-asr";
const QWEN_ASR_REALTIME_MODEL = "qwen3-asr-flash-realtime";
const FUN_ASR_REALTIME_MODEL = "fun-asr-realtime";
const QWEN_ASR_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const FUN_ASR_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
const MIMO_BASE_URL = "https://api.xiaomimimo.com/v1";
const MEETING_FILE_ASR_MODEL = MIMO_ASR_MODEL;

const ASR_PRESETS = new Set([MIMO_ASR_MODEL, QWEN_ASR_MODEL, FUN_ASR_MODEL]);
const CLEANER_PRESETS = new Set(["gpt-5.4-mini", "grok-4.5", "mimo-v2.5", "mimo-v2.5-pro"]);
const MEETING_QWEN_PRESETS = new Set(["qwen3-asr-flash", "qwen3-asr-flash-filetrans"]);
const MEETING_FUN_PRESETS = new Set(["fun-asr", "fun-asr-mtl"]);
const MEETING_FILE_ASR_PRESETS = new Set([
  MIMO_ASR_MODEL,
  "qwen3-asr-flash",
  "qwen3-asr-flash-filetrans",
  FUN_ASR_MODEL
]);
const MEETING_ANALYSIS_PRESETS = new Set([
  "gpt-5.4-mini",
  "gpt-5.5",
  "grok-4.5",
  "glm-5.2",
  "mimo-v2.5",
  "mimo-v2.5-pro"
]);

function trimStr(value) {
  return String(value || "").trim();
}

function cloneProfile(profile) {
  return profile && typeof profile === "object" ? { ...profile } : {};
}

function defaultAsrProfile(model) {
  const id = trimStr(model) || MIMO_ASR_MODEL;
  if (id === QWEN_ASR_MODEL || /qwen/i.test(id)) {
    return {
      provider: "qwen3-asr",
      mode: "realtime",
      realtimeModel: QWEN_ASR_REALTIME_MODEL,
      baseUrl: QWEN_ASR_BASE_URL,
      apiKey: "",
      language: "",
      enableItn: true
    };
  }
  if (id === FUN_ASR_MODEL || /fun-asr/i.test(id)) {
    return {
      provider: "fun-asr",
      mode: "realtime",
      realtimeModel: FUN_ASR_REALTIME_MODEL,
      baseUrl: FUN_ASR_BASE_URL,
      apiKey: "",
      language: "",
      enableItn: true
    };
  }
  return {
    provider: "mimo",
    mode: "realtime",
    realtimeModel: "",
    baseUrl: MIMO_BASE_URL,
    apiKey: "",
    language: "",
    enableItn: false
  };
}

function defaultCleanerProfile(model) {
  const id = trimStr(model) || "mimo-v2.5";
  if (id === "mimo-v2.5" || id === "mimo-v2.5-pro") {
    return { provider: "mimo", baseUrl: MIMO_BASE_URL, apiKey: "" };
  }
  return { provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "" };
}

function defaultMeetingQwenProfile(model) {
  return {
    provider: "qwen3-asr",
    baseUrl: QWEN_ASR_BASE_URL,
    apiKey: "",
    model: trimStr(model) || "qwen3-asr-flash"
  };
}

function defaultMeetingFileAsrProfile(model) {
  const id = trimStr(model) || MEETING_FILE_ASR_MODEL;
  if (/^qwen/i.test(id)) {
    return {
      provider: "qwen3-asr",
      baseUrl: QWEN_ASR_BASE_URL,
      apiKey: "",
      model: id
    };
  }
  if (/fun-asr/i.test(id)) {
    return {
      provider: "fun-asr",
      baseUrl: FUN_ASR_BASE_URL,
      apiKey: "",
      model: id
    };
  }
  return {
    provider: "mimo",
    baseUrl: MIMO_BASE_URL,
    apiKey: "",
    model: id
  };
}

function defaultMeetingFunProfile(model) {
  return {
    provider: "fun-asr",
    baseUrl: FUN_ASR_BASE_URL,
    apiKey: "",
    model: trimStr(model) || FUN_ASR_MODEL
  };
}

function defaultMeetingAnalysisProfile(model) {
  const id = trimStr(model) || "gpt-5.4-mini";
  const isMimo = id === "mimo-v2.5" || id === "mimo-v2.5-pro";
  return {
    provider: isMimo ? "mimo" : "openai-compatible",
    baseUrl: isMimo ? MIMO_BASE_URL : "https://api.openai.com/v1",
    apiKey: "",
    model: id,
    contextWindow: 128000,
    maxOutput: 8192,
    reasoning: "",
    timeoutMs: 120000
  };
}

function ensureProfilesMap(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

function profileHasCredentials(profile) {
  return Boolean(trimStr(profile?.apiKey) || trimStr(profile?.baseUrl));
}

function migrateConnectionProfiles(raw) {
  const next = { ...(raw && typeof raw === "object" ? raw : {}) };
  const migrated = [];

  next.asrProfiles = ensureProfilesMap(next.asrProfiles);
  next.cleanerProfiles = ensureProfilesMap(next.cleanerProfiles);
  next.meetingQwenProfiles = ensureProfilesMap(next.meetingQwenProfiles);
  next.meetingFileAsrProfiles = ensureProfilesMap(next.meetingFileAsrProfiles);
  next.meetingFunAsrProfiles = ensureProfilesMap(next.meetingFunAsrProfiles);
  next.meetingAnalysisProfiles = ensureProfilesMap(next.meetingAnalysisProfiles);

  const asrModel = trimStr(next.asrModel) || MIMO_ASR_MODEL;
  next.asrModel = asrModel;
  if (!next.asrProfiles[asrModel]) {
    const base = defaultAsrProfile(asrModel);
    next.asrProfiles[asrModel] = {
      ...base,
      provider: trimStr(next.asrProvider) || base.provider,
      mode: trimStr(next.asrMode) || base.mode,
      realtimeModel: trimStr(next.asrRealtimeModel) || base.realtimeModel,
      baseUrl: trimStr(next.asrBaseUrl) || base.baseUrl,
      apiKey: trimStr(next.asrApiKey) || "",
      language: trimStr(next.asrLanguage) || "",
      enableItn: Boolean(next.asrEnableItn ?? base.enableItn)
    };
    migrated.push("asr:" + asrModel);
  } else if (!profileHasCredentials(next.asrProfiles[asrModel])) {
    const profile = cloneProfile(next.asrProfiles[asrModel]);
    if (trimStr(next.asrApiKey)) profile.apiKey = trimStr(next.asrApiKey);
    if (trimStr(next.asrBaseUrl)) profile.baseUrl = trimStr(next.asrBaseUrl);
    next.asrProfiles[asrModel] = profile;
  }

  if (!trimStr(next.asrProfiles[asrModel].apiKey) && trimStr(next.apiKey)) {
    next.asrProfiles[asrModel] = {
      ...next.asrProfiles[asrModel],
      apiKey: trimStr(next.apiKey)
    };
    if (!trimStr(next.asrProfiles[asrModel].baseUrl) && trimStr(next.baseUrl)) {
      next.asrProfiles[asrModel].baseUrl = trimStr(next.baseUrl);
    }
    migrated.push("asr:from-global");
  }

  const cleanerModel = trimStr(next.cleanerModel) || trimStr(next.model) || "mimo-v2.5";
  next.cleanerModel = cleanerModel;
  if (!next.cleanerProfiles[cleanerModel]) {
    const base = defaultCleanerProfile(cleanerModel);
    next.cleanerProfiles[cleanerModel] = {
      ...base,
      provider: trimStr(next.cleanerProvider) || base.provider,
      baseUrl: trimStr(next.cleanerBaseUrl) || base.baseUrl,
      apiKey: trimStr(next.cleanerApiKey) || ""
    };
    migrated.push("cleaner:" + cleanerModel);
  } else {
    const profile = cloneProfile(next.cleanerProfiles[cleanerModel]);
    if (!trimStr(profile.apiKey) && trimStr(next.cleanerApiKey)) profile.apiKey = trimStr(next.cleanerApiKey);
    if (!trimStr(profile.baseUrl) && trimStr(next.cleanerBaseUrl)) profile.baseUrl = trimStr(next.cleanerBaseUrl);
    next.cleanerProfiles[cleanerModel] = profile;
  }

  if (!trimStr(next.cleanerProfiles[cleanerModel].apiKey) && trimStr(next.apiKey)) {
    next.cleanerProfiles[cleanerModel] = {
      ...next.cleanerProfiles[cleanerModel],
      apiKey: trimStr(next.apiKey)
    };
    if (!trimStr(next.cleanerProfiles[cleanerModel].baseUrl) && trimStr(next.baseUrl)) {
      next.cleanerProfiles[cleanerModel].baseUrl = trimStr(next.baseUrl);
    }
    migrated.push("cleaner:from-global");
  }

  const meetingQwenModel = trimStr(next.meetingQwenModel) || "qwen3-asr-flash";
  next.meetingQwenModel = meetingQwenModel;
  if (!next.meetingQwenProfiles[meetingQwenModel]) {
    const base = defaultMeetingQwenProfile(meetingQwenModel);
    next.meetingQwenProfiles[meetingQwenModel] = {
      ...base,
      baseUrl: trimStr(next.meetingQwenBaseUrl) || base.baseUrl,
      apiKey: trimStr(next.meetingQwenApiKey) || "",
      model: meetingQwenModel
    };
    migrated.push("meetingQwen:" + meetingQwenModel);
  } else {
    const profile = cloneProfile(next.meetingQwenProfiles[meetingQwenModel]);
    if (!trimStr(profile.apiKey) && trimStr(next.meetingQwenApiKey)) profile.apiKey = trimStr(next.meetingQwenApiKey);
    if (!trimStr(profile.baseUrl) && trimStr(next.meetingQwenBaseUrl)) profile.baseUrl = trimStr(next.meetingQwenBaseUrl);
    next.meetingQwenProfiles[meetingQwenModel] = profile;
  }

  const meetingFileAsrModel = trimStr(next.meetingFileAsrModel) || MEETING_FILE_ASR_MODEL;
  next.meetingFileAsrModel = meetingFileAsrModel;
  if (!next.meetingFileAsrProfiles[meetingFileAsrModel]) {
    const base = defaultMeetingFileAsrProfile(meetingFileAsrModel);
    next.meetingFileAsrProfiles[meetingFileAsrModel] = {
      ...base,
      provider: trimStr(next.meetingFileAsrProvider) || base.provider,
      baseUrl: trimStr(next.meetingFileAsrBaseUrl) || base.baseUrl,
      apiKey: trimStr(next.meetingFileAsrApiKey) || "",
      model: meetingFileAsrModel
    };
    migrated.push("meetingFileAsr:" + meetingFileAsrModel);
  } else {
    const profile = cloneProfile(next.meetingFileAsrProfiles[meetingFileAsrModel]);
    if (!trimStr(profile.provider) && trimStr(next.meetingFileAsrProvider)) profile.provider = trimStr(next.meetingFileAsrProvider);
    if (!trimStr(profile.apiKey) && trimStr(next.meetingFileAsrApiKey)) profile.apiKey = trimStr(next.meetingFileAsrApiKey);
    if (!trimStr(profile.baseUrl) && trimStr(next.meetingFileAsrBaseUrl)) profile.baseUrl = trimStr(next.meetingFileAsrBaseUrl);
    profile.model = meetingFileAsrModel;
    next.meetingFileAsrProfiles[meetingFileAsrModel] = profile;
  }

  const meetingFunModel = trimStr(next.meetingFunAsrModel) || FUN_ASR_MODEL;
  next.meetingFunAsrModel = meetingFunModel;
  if (!next.meetingFunAsrProfiles[meetingFunModel]) {
    const base = defaultMeetingFunProfile(meetingFunModel);
    next.meetingFunAsrProfiles[meetingFunModel] = {
      ...base,
      baseUrl: trimStr(next.meetingFunAsrBaseUrl) || base.baseUrl,
      apiKey: trimStr(next.meetingFunAsrApiKey) || "",
      model: meetingFunModel
    };
    migrated.push("meetingFun:" + meetingFunModel);
  } else {
    const profile = cloneProfile(next.meetingFunAsrProfiles[meetingFunModel]);
    if (!trimStr(profile.apiKey) && trimStr(next.meetingFunAsrApiKey)) profile.apiKey = trimStr(next.meetingFunAsrApiKey);
    if (!trimStr(profile.baseUrl) && trimStr(next.meetingFunAsrBaseUrl)) profile.baseUrl = trimStr(next.meetingFunAsrBaseUrl);
    next.meetingFunAsrProfiles[meetingFunModel] = profile;
  }

  const analysisModel = trimStr(next.meetingAnalysisModel) || "gpt-5.4-mini";
  next.meetingAnalysisModel = analysisModel;
  if (!next.meetingAnalysisProfiles[analysisModel]) {
    const base = defaultMeetingAnalysisProfile(analysisModel);
    next.meetingAnalysisProfiles[analysisModel] = {
      ...base,
      baseUrl: trimStr(next.meetingAnalysisBaseUrl) || base.baseUrl,
      apiKey: trimStr(next.meetingAnalysisApiKey) || "",
      model: analysisModel,
      contextWindow: Number(next.meetingAnalysisContextWindow) || base.contextWindow,
      maxOutput: Number(next.meetingAnalysisMaxOutput) || base.maxOutput,
      reasoning: trimStr(next.meetingAnalysisReasoning) || "",
      timeoutMs: Number(next.meetingAnalysisTimeoutMs) || base.timeoutMs
    };
    migrated.push("meetingAnalysis:" + analysisModel);
  } else {
    const profile = cloneProfile(next.meetingAnalysisProfiles[analysisModel]);
    if (!trimStr(profile.apiKey) && trimStr(next.meetingAnalysisApiKey)) profile.apiKey = trimStr(next.meetingAnalysisApiKey);
    if (!trimStr(profile.baseUrl) && trimStr(next.meetingAnalysisBaseUrl)) profile.baseUrl = trimStr(next.meetingAnalysisBaseUrl);
    if (!Number(profile.contextWindow) && Number(next.meetingAnalysisContextWindow)) profile.contextWindow = Number(next.meetingAnalysisContextWindow);
    if (!Number(profile.maxOutput) && Number(next.meetingAnalysisMaxOutput)) profile.maxOutput = Number(next.meetingAnalysisMaxOutput);
    if (!trimStr(profile.reasoning) && trimStr(next.meetingAnalysisReasoning)) profile.reasoning = trimStr(next.meetingAnalysisReasoning);
    if (!Number(profile.timeoutMs) && Number(next.meetingAnalysisTimeoutMs)) profile.timeoutMs = Number(next.meetingAnalysisTimeoutMs);
    next.meetingAnalysisProfiles[analysisModel] = profile;
  }

  applyActiveProfilesToTopLevel(next);

  if (trimStr(next.apiKey) || trimStr(next.baseUrl)) {
    next.apiKey = "";
    next.baseUrl = "";
    next._legacyGlobalCredentialsMigrated = true;
    migrated.push("clear-global");
  }

  next._connectionProfilesMigrated = true;
  next._connectionProfilesMigratedAt = new Date().toISOString();
  next._connectionProfilesMigrationNotes = migrated;
  return next;
}

function applyActiveProfilesToTopLevel(settings) {
  const next = settings;
  const asrModel = trimStr(next.asrModel) || MIMO_ASR_MODEL;
  const asr = next.asrProfiles?.[asrModel] || defaultAsrProfile(asrModel);
  next.asrProvider = trimStr(asr.provider) || next.asrProvider || "mimo";
  next.asrMode = trimStr(asr.mode) || next.asrMode || "batch";
  next.asrRealtimeModel = trimStr(asr.realtimeModel) || next.asrRealtimeModel || "";
  next.asrBaseUrl = trimStr(asr.baseUrl) || "";
  next.asrApiKey = trimStr(asr.apiKey) || "";
  next.asrLanguage = trimStr(asr.language) || "";
  next.asrEnableItn = Boolean(asr.enableItn);

  const cleanerModel = trimStr(next.cleanerModel) || "mimo-v2.5";
  const cleaner = next.cleanerProfiles?.[cleanerModel] || defaultCleanerProfile(cleanerModel);
  next.cleanerProvider = trimStr(cleaner.provider) || next.cleanerProvider || "mimo";
  next.cleanerBaseUrl = trimStr(cleaner.baseUrl) || "";
  next.cleanerApiKey = trimStr(cleaner.apiKey) || "";

  const mqModel = trimStr(next.meetingQwenModel) || "qwen3-asr-flash";
  const mq = next.meetingQwenProfiles?.[mqModel] || defaultMeetingQwenProfile(mqModel);
  next.meetingQwenBaseUrl = trimStr(mq.baseUrl) || "";
  next.meetingQwenApiKey = trimStr(mq.apiKey) || "";

  const mfaModel = trimStr(next.meetingFileAsrModel) || MEETING_FILE_ASR_MODEL;
  const mfa = next.meetingFileAsrProfiles?.[mfaModel] || defaultMeetingFileAsrProfile(mfaModel);
  next.meetingFileAsrProvider = trimStr(mfa.provider) || "mimo";
  next.meetingFileAsrBaseUrl = trimStr(mfa.baseUrl) || "";
  next.meetingFileAsrApiKey = trimStr(mfa.apiKey) || "";

  const mfModel = trimStr(next.meetingFunAsrModel) || FUN_ASR_MODEL;
  const mf = next.meetingFunAsrProfiles?.[mfModel] || defaultMeetingFunProfile(mfModel);
  next.meetingFunAsrBaseUrl = trimStr(mf.baseUrl) || "";
  next.meetingFunAsrApiKey = trimStr(mf.apiKey) || "";

  const maModel = trimStr(next.meetingAnalysisModel) || "gpt-5.4-mini";
  const ma = next.meetingAnalysisProfiles?.[maModel] || defaultMeetingAnalysisProfile(maModel);
  next.meetingAnalysisBaseUrl = trimStr(ma.baseUrl) || "";
  next.meetingAnalysisApiKey = trimStr(ma.apiKey) || "";
  next.meetingAnalysisContextWindow = Number(ma.contextWindow) || 128000;
  next.meetingAnalysisMaxOutput = Number(ma.maxOutput) || 8192;
  next.meetingAnalysisReasoning = trimStr(ma.reasoning) || "";
  next.meetingAnalysisTimeoutMs = Number(ma.timeoutMs) || 120000;
  return next;
}

function ensureConnectionProfiles(value) {
  const next = { ...(value && typeof value === "object" ? value : {}) };
  if (!next._connectionProfilesMigrated || trimStr(next.apiKey) || trimStr(next.baseUrl)) {
    return migrateConnectionProfiles(next);
  }
  next.asrProfiles = ensureProfilesMap(next.asrProfiles);
  next.cleanerProfiles = ensureProfilesMap(next.cleanerProfiles);
  next.meetingQwenProfiles = ensureProfilesMap(next.meetingQwenProfiles);
  next.meetingFileAsrProfiles = ensureProfilesMap(next.meetingFileAsrProfiles);
  next.meetingFunAsrProfiles = ensureProfilesMap(next.meetingFunAsrProfiles);
  next.meetingAnalysisProfiles = ensureProfilesMap(next.meetingAnalysisProfiles);

  const asrModel = trimStr(next.asrModel) || MIMO_ASR_MODEL;
  next.asrModel = asrModel;
  if (!next.asrProfiles[asrModel]) next.asrProfiles[asrModel] = defaultAsrProfile(asrModel);

  const cleanerModel = trimStr(next.cleanerModel) || "mimo-v2.5";
  next.cleanerModel = cleanerModel;
  if (!next.cleanerProfiles[cleanerModel]) next.cleanerProfiles[cleanerModel] = defaultCleanerProfile(cleanerModel);

  const mq = trimStr(next.meetingQwenModel) || "qwen3-asr-flash";
  next.meetingQwenModel = mq;
  if (!next.meetingQwenProfiles[mq]) next.meetingQwenProfiles[mq] = defaultMeetingQwenProfile(mq);

  const mfa = trimStr(next.meetingFileAsrModel) || MEETING_FILE_ASR_MODEL;
  next.meetingFileAsrModel = mfa;
  if (!next.meetingFileAsrProfiles[mfa]) next.meetingFileAsrProfiles[mfa] = defaultMeetingFileAsrProfile(mfa);

  const mf = trimStr(next.meetingFunAsrModel) || FUN_ASR_MODEL;
  next.meetingFunAsrModel = mf;
  if (!next.meetingFunAsrProfiles[mf]) next.meetingFunAsrProfiles[mf] = defaultMeetingFunProfile(mf);

  const ma = trimStr(next.meetingAnalysisModel) || "gpt-5.4-mini";
  next.meetingAnalysisModel = ma;
  if (!next.meetingAnalysisProfiles[ma]) next.meetingAnalysisProfiles[ma] = defaultMeetingAnalysisProfile(ma);

  return applyActiveProfilesToTopLevel(next);
}

module.exports = {
  MIMO_ASR_MODEL,
  QWEN_ASR_MODEL,
  FUN_ASR_MODEL,
  MEETING_FILE_ASR_MODEL,
  ASR_PRESETS,
  CLEANER_PRESETS,
  MEETING_QWEN_PRESETS,
  MEETING_FILE_ASR_PRESETS,
  MEETING_FUN_PRESETS,
  MEETING_ANALYSIS_PRESETS,
  defaultAsrProfile,
  defaultCleanerProfile,
  defaultMeetingQwenProfile,
  defaultMeetingFileAsrProfile,
  defaultMeetingFunProfile,
  defaultMeetingAnalysisProfile,
  migrateConnectionProfiles,
  ensureConnectionProfiles,
  applyActiveProfilesToTopLevel
};
