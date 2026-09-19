"use strict";

const { isSupportedAliMeetingModel } = require("../providers/asr/ali-meeting-stream");
const {
  API_STYLES,
  DEFAULT_CONNECTIONS,
  PROVIDER_FAMILIES,
  apiStyleFrom,
  connectionBaseUrl,
  mergeProviderConnections,
  normalizeApiStyle,
  normalizeProviderBaseUrl,
  normalizeProviderConnection,
  providerFamilyFor
} = require("./provider-connections");

const MIMO_ASR_MODEL = "mimo-v2.5-asr";
const QWEN_ASR_MODEL = "qwen3-asr-flash";
const MEETING_LIVE_MODEL = "qwen-audio-3.0-asr-flash-streaming";
const FUN_ASR_MODEL = "fun-asr";
const QWEN_ASR_REALTIME_MODEL = MEETING_LIVE_MODEL;
const QWEN_ASR_LEGACY_REALTIME_MODEL = "qwen3-asr-flash-realtime";
const FUN_ASR_REALTIME_MODEL = "fun-asr-realtime";
const QWEN_ASR_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const FUN_ASR_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
const MIMO_BASE_URL = "https://api.xiaomimimo.com/v1";
const MEETING_FILE_ASR_MODEL = MIMO_ASR_MODEL;

const ASR_PRESETS = new Set([MIMO_ASR_MODEL, QWEN_ASR_MODEL, FUN_ASR_MODEL]);
const CLEANER_PRESETS = new Set(["gpt-5.4-mini", "grok-4.5", "mimo-v2.5", "mimo-v2.5-pro"]);
const MEETING_QWEN_PRESETS = new Set([MEETING_LIVE_MODEL, FUN_ASR_REALTIME_MODEL]);
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

function normalizeShortQwenRealtimeModel(model) {
  const id = trimStr(model);
  return !id || id === QWEN_ASR_MODEL || id === QWEN_ASR_LEGACY_REALTIME_MODEL
    ? QWEN_ASR_REALTIME_MODEL
    : id;
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
    return { provider: "mimo", baseUrl: MIMO_BASE_URL, apiKey: "", apiStyle: API_STYLES.CHAT_COMPLETIONS };
  }
  return {
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    apiStyle: providerFamilyFor(id) === PROVIDER_FAMILIES.OPENAI
      ? API_STYLES.RESPONSES
      : API_STYLES.CHAT_COMPLETIONS
  };
}

function defaultMeetingQwenProfile(model) {
  return {
    provider: /fun-asr/i.test(model) ? "fun-asr" : "qwen3-asr",
    baseUrl: QWEN_ASR_BASE_URL,
    apiKey: "",
    model: trimStr(model) || MEETING_LIVE_MODEL
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
    apiStyle: isMimo ? API_STYLES.CHAT_COMPLETIONS : (
      providerFamilyFor(id) === PROVIDER_FAMILIES.OPENAI ? API_STYLES.RESPONSES : API_STYLES.CHAT_COMPLETIONS
    ),
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

const PROFILE_GROUPS = Object.freeze([
  { map: "asrProfiles", active: "asrModel", provider: "asrProvider", operation: asrOperation },
  { map: "cleanerProfiles", active: "cleanerModel", provider: "cleanerProvider", operation: compatibleOperation },
  { map: "meetingQwenProfiles", active: "meetingQwenModel", provider: null, operation: meetingQwenOperation },
  { map: "meetingRealtimeProfiles", active: "meetingRealtimeModel", provider: null, operation: streamingOperation },
  { map: "meetingFileAsrProfiles", active: "meetingFileAsrModel", provider: "meetingFileAsrProvider", operation: asrOperation },
  { map: "meetingFunAsrProfiles", active: "meetingFunAsrModel", provider: null, operation: restOperation },
  { map: "meetingAnalysisProfiles", active: "meetingAnalysisModel", provider: null, operation: compatibleOperation }
]);

function asrOperation(modelId, family) {
  if (family !== PROVIDER_FAMILIES.ALIYUN) return "default";
  return /fun-asr/i.test(modelId) ? "rest" : "compatible";
}

function compatibleOperation(_modelId, family) {
  return family === PROVIDER_FAMILIES.ALIYUN ? "compatible" : "default";
}

function meetingQwenOperation(modelId, family) {
  if (family !== PROVIDER_FAMILIES.ALIYUN) return "default";
  return isSupportedAliMeetingModel(modelId) ? "streaming" : "compatible";
}

function streamingOperation(_modelId, family) {
  return family === PROVIDER_FAMILIES.ALIYUN ? "streaming" : "default";
}

function restOperation(_modelId, family) {
  return family === PROVIDER_FAMILIES.ALIYUN ? "rest" : "default";
}

function inferredProvider(group, modelId, profile, settings) {
  if (trimStr(profile?.provider)) return trimStr(profile.provider);
  if (group.provider && trimStr(settings[group.provider])) return trimStr(settings[group.provider]);
  if (group.map === "meetingQwenProfiles" || group.map === "meetingRealtimeProfiles") return "aliyun-streaming";
  if (group.map === "meetingFunAsrProfiles") return "fun-asr";
  return "";
}

function profileCandidates(settings, { activeOnly = false } = {}) {
  const candidates = [];
  for (const group of PROFILE_GROUPS) {
    const profiles = settings[group.map] || {};
    const activeModel = trimStr(settings[group.active]);
    for (const [modelId, profileValue] of Object.entries(profiles)) {
      if (activeOnly && modelId !== activeModel) continue;
      const profile = cloneProfile(profileValue);
      const provider = inferredProvider(group, modelId, profile, settings);
      const family = providerFamilyFor(modelId, provider);
      if (!family) continue;
      const rawStyle = profile.apiStyle ?? profile.wireApi ?? profile.wire_api;
      candidates.push({
        family,
        modelId,
        active: modelId === activeModel,
        apiKey: trimStr(profile.apiKey),
        baseUrl: trimStr(profile.baseUrl),
        apiStyle: rawStyle == null ? "" : normalizeApiStyle(rawStyle),
        operation: group.operation(modelId, family)
      });
    }
  }
  return candidates;
}

function candidateScore(candidate) {
  const defaultRoot = normalizeProviderBaseUrl(candidate.family, DEFAULT_CONNECTIONS[candidate.family]?.baseUrl);
  const root = candidate.baseUrl ? normalizeProviderBaseUrl(candidate.family, candidate.baseUrl) : "";
  const customEndpoint = Boolean(root && root !== defaultRoot);
  return (candidate.active ? 100 : 0)
    + (candidate.apiKey ? 80 : 0)
    + (customEndpoint ? 300 : 0)
    + (candidate.apiKey && customEndpoint ? 500 : 0)
    + (candidate.apiStyle === API_STYLES.RESPONSES ? 40 : 0);
}

function bestCandidate(candidates, family) {
  return candidates
    .filter(candidate => candidate.family === family)
    .map((candidate, index) => ({ candidate, index, score: candidateScore(candidate) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.candidate;
}

function connectionFromCandidate(family, candidate) {
  return normalizeProviderConnection(family, {
    apiKey: candidate?.apiKey,
    baseUrl: candidate?.baseUrl,
    apiStyle: candidate?.apiStyle || DEFAULT_CONNECTIONS[family]?.apiStyle
  });
}

function initializeProviderConnections(settings) {
  const supplied = settings.providerConnections && typeof settings.providerConnections === "object"
    ? settings.providerConnections
    : {};
  const candidates = profileCandidates(settings);
  const connections = {};
  for (const family of Object.values(PROVIDER_FAMILIES)) {
    const raw = supplied[family] && typeof supplied[family] === "object" ? supplied[family] : null;
    const seed = bestCandidate(candidates, family);
    if (!raw) {
      connections[family] = connectionFromCandidate(family, seed);
      continue;
    }
    const normalized = normalizeProviderConnection(family, raw);
    const seedConnection = connectionFromCandidate(family, seed);
    const rawRoot = normalizeProviderBaseUrl(family, raw.baseUrl);
    const defaultRoot = normalizeProviderBaseUrl(family, DEFAULT_CONNECTIONS[family]?.baseUrl);
    const seedRoot = normalizeProviderBaseUrl(family, seed?.baseUrl);
    if (seed?.apiKey && seedRoot && seedRoot !== defaultRoot
        && (!trimStr(raw.apiKey) || trimStr(raw.apiKey) === seed.apiKey)
        && (!rawRoot || rawRoot === defaultRoot)) {
      normalized.baseUrl = seedConnection.baseUrl;
    }
    if (!trimStr(raw.apiKey) && seed?.apiKey) normalized.apiKey = seed.apiKey;
    if (raw.apiStyle == null && raw.wireApi == null && raw.wire_api == null && seed?.apiStyle) {
      normalized.apiStyle = seed.apiStyle;
    }
    connections[family] = normalized;
  }
  settings.providerConnections = connections;
  settings._providerConnectionsMigrated = true;
}

function normalizeExistingProviderConnections(settings) {
  const connections = {};
  for (const family of Object.values(PROVIDER_FAMILIES)) {
    connections[family] = normalizeProviderConnection(family, settings.providerConnections?.[family]);
  }
  settings.providerConnections = connections;
}

function mirrorProviderConnectionsToProfiles(settings) {
  for (const group of PROFILE_GROUPS) {
    const profiles = settings[group.map] || {};
    for (const [modelId, profileValue] of Object.entries(profiles)) {
      const profile = cloneProfile(profileValue);
      const provider = inferredProvider(group, modelId, profile, settings);
      const family = providerFamilyFor(modelId, provider);
      const connection = family ? settings.providerConnections?.[family] : null;
      if (!connection) continue;
      profiles[modelId] = {
        ...profile,
        apiKey: connection.apiKey,
        baseUrl: connectionBaseUrl(family, connection, group.operation(modelId, family)),
        apiStyle: connection.apiStyle
      };
    }
    settings[group.map] = profiles;
  }
}

function migrateConnectionProfiles(raw) {
  const next = { ...(raw && typeof raw === "object" ? raw : {}) };
  const migrated = [];

  next.asrProfiles = ensureProfilesMap(next.asrProfiles);
  next.cleanerProfiles = ensureProfilesMap(next.cleanerProfiles);
  next.meetingQwenProfiles = ensureProfilesMap(next.meetingQwenProfiles);
  next.meetingRealtimeProfiles = ensureProfilesMap(next.meetingRealtimeProfiles);
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

  const legacyCleanerModel = trimStr(next.cleanerModel) || trimStr(next.model) || "mimo-v2.5";
  const legacyAsrFamily = providerFamilyFor(asrModel, next.asrProfiles[asrModel]?.provider);
  const legacyCleanerFamily = providerFamilyFor(legacyCleanerModel, next.cleanerProvider);
  if (legacyAsrFamily && legacyAsrFamily === legacyCleanerFamily
      && !trimStr(next.asrProfiles[asrModel].apiKey) && trimStr(next.apiKey)) {
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
      apiKey: trimStr(next.cleanerApiKey) || "",
      apiStyle: normalizeApiStyle(next.cleanerApiStyle || next.cleanerWireApi || base.apiStyle)
    };
    migrated.push("cleaner:" + cleanerModel);
  } else {
    const profile = cloneProfile(next.cleanerProfiles[cleanerModel]);
    if (!trimStr(profile.apiKey) && trimStr(next.cleanerApiKey)) profile.apiKey = trimStr(next.cleanerApiKey);
    if (!trimStr(profile.baseUrl) && trimStr(next.cleanerBaseUrl)) profile.baseUrl = trimStr(next.cleanerBaseUrl);
    if (profile.apiStyle == null && (next.cleanerApiStyle || next.cleanerWireApi)) {
      profile.apiStyle = normalizeApiStyle(next.cleanerApiStyle || next.cleanerWireApi);
    }
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

  // Unlabelled legacy credentials belonged to the old batch model, never streaming.
  const meetingQwenModel = trimStr(next.meetingQwenModel)
    || (trimStr(next.meetingQwenApiKey) ? QWEN_ASR_MODEL : MEETING_LIVE_MODEL);
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
      apiStyle: normalizeApiStyle(
        next.meetingAnalysisApiStyle || next.meetingAnalysisWireApi || next.wire_api || base.apiStyle
      ),
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
    if (profile.apiStyle == null && (next.meetingAnalysisApiStyle || next.meetingAnalysisWireApi || next.wire_api)) {
      profile.apiStyle = normalizeApiStyle(
        next.meetingAnalysisApiStyle || next.meetingAnalysisWireApi || next.wire_api
      );
    }
    if (!Number(profile.contextWindow) && Number(next.meetingAnalysisContextWindow)) profile.contextWindow = Number(next.meetingAnalysisContextWindow);
    if (!Number(profile.maxOutput) && Number(next.meetingAnalysisMaxOutput)) profile.maxOutput = Number(next.meetingAnalysisMaxOutput);
    if (!trimStr(profile.reasoning) && trimStr(next.meetingAnalysisReasoning)) profile.reasoning = trimStr(next.meetingAnalysisReasoning);
    if (!Number(profile.timeoutMs) && Number(next.meetingAnalysisTimeoutMs)) profile.timeoutMs = Number(next.meetingAnalysisTimeoutMs);
    next.meetingAnalysisProfiles[analysisModel] = profile;
  }

  initializeProviderConnections(next);
  mirrorProviderConnectionsToProfiles(next);
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
  // Live meetings select a model independently; never copy an active provider's key.
  const savedMeetingRealtimeModel = typeof next.meetingRealtimeModel === "string" ? next.meetingRealtimeModel : "";
  next.meetingRealtimeModel = savedMeetingRealtimeModel || MEETING_LIVE_MODEL;
  if (!isSupportedAliMeetingModel(next.meetingRealtimeModel)) next.meetingRealtimeModel = MEETING_LIVE_MODEL;
  next.meetingRealtimeDestination = trimStr(next.meetingRealtimeDestination);
  const asrModel = trimStr(next.asrModel) || MIMO_ASR_MODEL;
  const asr = cloneProfile(next.asrProfiles?.[asrModel] || defaultAsrProfile(asrModel));
  next.asrProvider = trimStr(asr.provider) || next.asrProvider || "mimo";
  if (next.asrProvider === "qwen3-asr") {
    asr.realtimeModel = normalizeShortQwenRealtimeModel(asr.realtimeModel || next.asrRealtimeModel);
    next.asrProfiles[asrModel] = asr;
  }
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
  next.cleanerApiStyle = apiStyleFrom(cleaner);

  const mqModel = trimStr(next.meetingQwenModel) || MEETING_LIVE_MODEL;
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
  next.meetingAnalysisApiStyle = apiStyleFrom(ma);
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
  next.meetingRealtimeProfiles = ensureProfilesMap(next.meetingRealtimeProfiles);
  next.meetingFileAsrProfiles = ensureProfilesMap(next.meetingFileAsrProfiles);
  next.meetingFunAsrProfiles = ensureProfilesMap(next.meetingFunAsrProfiles);
  next.meetingAnalysisProfiles = ensureProfilesMap(next.meetingAnalysisProfiles);

  const asrModel = trimStr(next.asrModel) || MIMO_ASR_MODEL;
  next.asrModel = asrModel;
  if (!next.asrProfiles[asrModel]) next.asrProfiles[asrModel] = defaultAsrProfile(asrModel);

  const cleanerModel = trimStr(next.cleanerModel) || "mimo-v2.5";
  next.cleanerModel = cleanerModel;
  if (!next.cleanerProfiles[cleanerModel]) next.cleanerProfiles[cleanerModel] = defaultCleanerProfile(cleanerModel);

  const mq = trimStr(next.meetingQwenModel) || MEETING_LIVE_MODEL;
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

  if (!next._providerConnectionsMigrated) initializeProviderConnections(next);
  else normalizeExistingProviderConnections(next);
  mirrorProviderConnectionsToProfiles(next);
  return applyActiveProfilesToTopLevel(next);
}

module.exports = {
  MIMO_ASR_MODEL,
  QWEN_ASR_MODEL,
  QWEN_ASR_REALTIME_MODEL,
  MEETING_LIVE_MODEL,
  FUN_ASR_MODEL,
  MEETING_FILE_ASR_MODEL,
  ASR_PRESETS,
  CLEANER_PRESETS,
  MEETING_QWEN_PRESETS,
  MEETING_FILE_ASR_PRESETS,
  MEETING_FUN_PRESETS,
  MEETING_ANALYSIS_PRESETS,
  API_STYLES,
  PROVIDER_FAMILIES,
  connectionBaseUrl,
  mergeProviderConnections,
  normalizeApiStyle,
  providerFamilyFor,
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
