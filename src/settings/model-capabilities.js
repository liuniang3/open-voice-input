"use strict";

const CAPABILITY_PRESET_REVISION = 2;

const GENERIC_MODEL_CAPABILITY = Object.freeze({
  contextWindow: 128000,
  maxOutput: 8192,
  reasoning: "",
  timeoutMs: 180000,
  capabilitySource: "generic"
});

const MODEL_CAPABILITY_PRESETS = Object.freeze([
  {
    pattern: /^(?:opencode-go\/)?(?:deepseek-v4-pro|deepseek-v4-flash|deepseek-v4\.1-flash|deepseek-v4-flash-vision-exp|deepseek-flash)$/i,
    capability: {
      contextWindow: 1000000,
      maxOutput: 384000,
      reasoning: "",
      timeoutMs: 300000,
      capabilitySource: "compatibility"
    }
  },
  {
    pattern: /(?:^|\/)mimo-v2\.5-pro(?:$|[-_:])/i,
    capability: {
      contextWindow: 1000000,
      maxOutput: 128000,
      reasoning: "",
      timeoutMs: 300000,
      capabilitySource: "official"
    }
  },
  {
    pattern: /(?:^|\/)mimo-v2\.5(?:$|[-_:])/i,
    capability: {
      contextWindow: 1000000,
      maxOutput: 128000,
      reasoning: "",
      timeoutMs: 300000,
      capabilitySource: "official"
    }
  },
  {
    pattern: /(?:^|\/)glm-5\.2(?:$|[-_:])/i,
    capability: {
      contextWindow: 1000000,
      maxOutput: 128000,
      reasoning: "",
      timeoutMs: 300000,
      capabilitySource: "official"
    }
  },
  {
    pattern: /(?:^|\/)grok-4\.5(?:$|[-_:])/i,
    capability: {
      contextWindow: 500000,
      maxOutput: 32768,
      reasoning: "high",
      timeoutMs: 300000,
      capabilitySource: "official"
    }
  },
  {
    pattern: /(?:^|\/)gpt-5\.6-(?:terra|luna|sol)(?:$|[-_:])/i,
    capability: {
      contextWindow: 272000,
      maxOutput: 32768,
      reasoning: "high",
      timeoutMs: 300000,
      capabilitySource: "compatibility"
    }
  },
  {
    pattern: /(?:^|\/)gpt-5\.(?:4-mini|5)(?:$|[-_:])/i,
    capability: {
      contextWindow: 230000,
      maxOutput: 32768,
      reasoning: "",
      timeoutMs: 300000,
      capabilitySource: "compatibility"
    }
  }
]);

const REASONING_LEVELS = new Set(["", "none", "minimal", "low", "medium", "high", "xhigh"]);

function trimStr(value) {
  return String(value || "").trim();
}

function boundedInteger(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const integer = Math.floor(parsed);
  return integer >= min && integer <= max ? integer : null;
}

function normalizeReasoning(value) {
  const normalized = trimStr(value).toLowerCase();
  return REASONING_LEVELS.has(normalized) ? normalized : "";
}

function knownModelCapability(modelId) {
  const id = trimStr(modelId);
  const preset = MODEL_CAPABILITY_PRESETS.find(candidate => candidate.pattern.test(id));
  return preset ? { ...preset.capability } : null;
}

function normalizeProviderCapability(value, contextFallback) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const contextWindow = boundedInteger(value.contextWindow, 4096, 10000000);
  const maxOutputUpperBound = contextWindow || contextFallback || 1000000;
  const maxOutput = boundedInteger(value.maxOutput, 256, Math.min(maxOutputUpperBound, 1000000));
  const timeoutMs = boundedInteger(value.timeoutMs, 5000, 900000);
  const reasoning = normalizeReasoning(value.reasoning);
  const normalized = {};
  if (contextWindow) normalized.contextWindow = contextWindow;
  if (maxOutput) normalized.maxOutput = maxOutput;
  if (timeoutMs) normalized.timeoutMs = timeoutMs;
  if (reasoning) normalized.reasoning = reasoning;
  return Object.keys(normalized).length ? normalized : null;
}

function resolveModelCapability(modelId, providerCapability = null) {
  const known = knownModelCapability(modelId);
  const base = known || GENERIC_MODEL_CAPABILITY;
  const source = trimStr(providerCapability?.capabilitySource);
  const external = !source || source === "provider"
    ? normalizeProviderCapability(providerCapability, base.contextWindow)
    : null;
  const resolved = {
    ...GENERIC_MODEL_CAPABILITY,
    ...base,
    ...(external || {})
  };
  if (resolved.maxOutput > resolved.contextWindow) resolved.maxOutput = resolved.contextWindow;
  resolved.capabilitySource = external ? "provider" : base.capabilitySource;
  resolved.capabilityRevision = CAPABILITY_PRESET_REVISION;
  return resolved;
}

function capabilityFieldsMatch(profile, capability) {
  return Number(profile?.contextWindow) === capability.contextWindow
    && Number(profile?.maxOutput) === capability.maxOutput
    && trimStr(profile?.reasoning).toLowerCase() === capability.reasoning
    && Number(profile?.timeoutMs) === capability.timeoutMs;
}

function isLegacyUnifiedCapability(profile) {
  return Number(profile?.contextWindow) === 128000
    && Number(profile?.maxOutput) === 8192
    && !trimStr(profile?.reasoning)
    && Number(profile?.timeoutMs) === 120000;
}

function applyCapabilityToProfile(profile, capability, { managed = true } = {}) {
  return {
    ...(profile && typeof profile === "object" ? profile : {}),
    contextWindow: capability.contextWindow,
    maxOutput: capability.maxOutput,
    reasoning: capability.reasoning,
    timeoutMs: capability.timeoutMs,
    capabilityManaged: Boolean(managed),
    capabilitySource: managed ? capability.capabilitySource : "manual",
    capabilityRevision: CAPABILITY_PRESET_REVISION
  };
}

function shouldManageExistingProfile(profile, capability) {
  if (!profile || typeof profile !== "object") return true;
  if (profile.capabilityManaged === false) return false;
  if (profile.capabilityManaged === true) return true;
  if (isLegacyUnifiedCapability(profile) || capabilityFieldsMatch(profile, capability)) return true;
  const numericFields = ["contextWindow", "maxOutput", "timeoutMs"];
  const hasAnyCapability = numericFields.some(field => Number(profile[field]) > 0) || Boolean(trimStr(profile.reasoning));
  if (!hasAnyCapability) return true;
  const legacyReasoningCompatible = !trimStr(profile.reasoning)
    || trimStr(profile.reasoning).toLowerCase() === capability.reasoning;
  const legacyCompatible = numericFields.every((field) => {
    if (!(Number(profile[field]) > 0)) return true;
    const legacy = { contextWindow: 128000, maxOutput: 8192, timeoutMs: 120000 };
    return Number(profile[field]) === legacy[field];
  }) && legacyReasoningCompatible;
  const presetCompatible = numericFields.every((field) => {
    if (!(Number(profile[field]) > 0)) return true;
    return Number(profile[field]) === capability[field];
  }) && (!trimStr(profile.reasoning) || trimStr(profile.reasoning).toLowerCase() === capability.reasoning);
  return legacyCompatible || presetCompatible;
}

function capabilityForProfile(modelId, profile, providerCapability = null) {
  const capability = resolveModelCapability(modelId, providerCapability);
  if (shouldManageExistingProfile(profile, capability)) {
    return applyCapabilityToProfile(profile, capability, { managed: true });
  }
  return {
    ...profile,
    capabilityManaged: false,
    capabilitySource: "manual",
    capabilityRevision: CAPABILITY_PRESET_REVISION
  };
}

module.exports = {
  CAPABILITY_PRESET_REVISION,
  GENERIC_MODEL_CAPABILITY,
  MODEL_CAPABILITY_PRESETS,
  REASONING_LEVELS,
  applyCapabilityToProfile,
  capabilityFieldsMatch,
  capabilityForProfile,
  isLegacyUnifiedCapability,
  knownModelCapability,
  normalizeProviderCapability,
  resolveModelCapability,
  shouldManageExistingProfile
};
