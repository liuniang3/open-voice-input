"use strict";

const assert = require("node:assert/strict");
const {
  GENERIC_MODEL_CAPABILITY,
  capabilityForProfile,
  normalizeProviderCapability,
  resolveModelCapability
} = require("../src/settings/model-capabilities");
const {
  defaultMeetingAnalysisProfile,
  migrateConnectionProfiles,
  ensureConnectionProfiles
} = require("../src/settings/connection-profiles");

assert.deepEqual(
  resolveModelCapability("mimo-v2.5-pro"),
  {
    contextWindow: 1000000,
    maxOutput: 128000,
    reasoning: "",
    timeoutMs: 300000,
    capabilitySource: "official",
    capabilityRevision: 2
  }
);
assert.equal(resolveModelCapability("vendor/glm-5.2").contextWindow, 1000000);
assert.equal(resolveModelCapability("grok-4.5").reasoning, "high");
assert.equal(resolveModelCapability("gpt-5.6-terra").contextWindow, 272000);
assert.equal(resolveModelCapability("gpt-5.4-mini").contextWindow, 230000);
for (const model of [
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "deepseek-v4.1-flash",
  "deepseek-v4-flash-vision-exp",
  "deepseek-flash",
  "opencode-go/deepseek-v4-pro"
]) {
  const capability = resolveModelCapability(model);
  assert.equal(capability.contextWindow, 1000000, model);
  assert.equal(capability.maxOutput, 384000, model);
  assert.equal(capability.capabilitySource, "compatibility", model);
}
assert.deepEqual(
  resolveModelCapability("new-model-without-preset"),
  { ...GENERIC_MODEL_CAPABILITY, capabilityRevision: 2 }
);

const providerCapability = resolveModelCapability("new-provider-model", {
  contextWindow: 256000,
  maxOutput: 24000,
  reasoning: "medium"
});
assert.equal(providerCapability.contextWindow, 256000);
assert.equal(providerCapability.maxOutput, 24000);
assert.equal(providerCapability.reasoning, "medium");
assert.equal(providerCapability.capabilitySource, "provider");
assert.equal(normalizeProviderCapability({ contextWindow: 100, maxOutput: 99999999 }, 128000), null);

const legacy = capabilityForProfile("grok-4.5", {
  contextWindow: 128000,
  maxOutput: 8192,
  reasoning: "",
  timeoutMs: 120000
});
assert.equal(legacy.contextWindow, 500000);
assert.equal(legacy.maxOutput, 32768);
assert.equal(legacy.capabilityManaged, true);

const legacyTerra = capabilityForProfile("gpt-5.6-terra", {
  contextWindow: 128000,
  maxOutput: 8192,
  reasoning: "high",
  timeoutMs: 120000
});
assert.equal(legacyTerra.contextWindow, 272000);
assert.equal(legacyTerra.maxOutput, 32768);
assert.equal(legacyTerra.capabilityManaged, true);

const manual = capabilityForProfile("grok-4.5", {
  contextWindow: 320000,
  maxOutput: 12000,
  reasoning: "medium",
  timeoutMs: 210000
});
assert.equal(manual.contextWindow, 320000);
assert.equal(manual.maxOutput, 12000);
assert.equal(manual.capabilityManaged, false);
assert.equal(manual.capabilitySource, "manual");

const partialManual = capabilityForProfile("grok-4.5", { contextWindow: 360000 });
assert.equal(partialManual.contextWindow, 360000);
assert.equal(partialManual.capabilityManaged, false);

const fresh = migrateConnectionProfiles({
  meetingAnalysisModel: "gpt-5.4-mini",
  meetingAnalysisContextWindow: 128000,
  meetingAnalysisMaxOutput: 8192,
  meetingAnalysisReasoning: "",
  meetingAnalysisTimeoutMs: 120000
});
assert.equal(fresh.meetingAnalysisContextWindow, 230000);
assert.equal(fresh.meetingAnalysisMaxOutput, 32768);
assert.equal(fresh.meetingAnalysisTimeoutMs, 300000);
assert.equal(fresh.meetingAnalysisProfiles["gpt-5.4-mini"].capabilityManaged, true);
assert.equal(fresh.meetingAnalysisProfiles["mimo-v2.5-pro"].contextWindow, 1000000);

const fetched = ensureConnectionProfiles({
  ...fresh,
  meetingAnalysisModel: "provider-new-model",
  meetingAnalysisProfiles: {
    ...fresh.meetingAnalysisProfiles,
    "provider-new-model": defaultMeetingAnalysisProfile("provider-new-model")
  },
  openaiModelCatalog: ["provider-new-model"],
  openaiModelCapabilities: {
    "provider-new-model": {
      contextWindow: 384000,
      maxOutput: 48000,
      reasoning: "low",
      timeoutMs: 240000
    }
  }
});
assert.equal(fetched.meetingAnalysisContextWindow, 384000);
assert.equal(fetched.meetingAnalysisMaxOutput, 48000);
assert.equal(fetched.meetingAnalysisReasoning, "low");
assert.equal(fetched.meetingAnalysisProfiles["provider-new-model"].capabilitySource, "provider");

const cachedCatalog = ensureConnectionProfiles({
  ...fresh,
  openaiModelCatalog: ["gpt-5.6-terra", "new-catalog-model"],
  openaiModelCapabilities: {}
});
assert.equal(cachedCatalog.openaiModelCapabilities["gpt-5.6-terra"].contextWindow, 272000);
assert.equal(cachedCatalog.openaiModelCapabilities["gpt-5.6-terra"].capabilitySource, "compatibility");
assert.equal(cachedCatalog.openaiModelCapabilities["new-catalog-model"].contextWindow, 128000);
assert.equal(cachedCatalog.openaiModelCapabilities["new-catalog-model"].capabilitySource, "generic");

const openCodeGoCatalog = ensureConnectionProfiles({
  ...fresh,
  meetingAnalysisModel: "deepseek-v4-pro",
  meetingAnalysisProfiles: {
    ...fresh.meetingAnalysisProfiles,
    "deepseek-v4-pro": {
      ...defaultMeetingAnalysisProfile("opencode-go/deepseek-v4-pro"),
      provider: "opencode-go",
      providerFamily: "opencode-go",
      model: "deepseek-v4-pro"
    }
  },
  openCodeGoModelCatalog: ["deepseek-v4-pro", "deepseek-v4.1-flash"],
  openCodeGoModelCapabilities: {}
});
assert.equal(openCodeGoCatalog.openCodeGoModelCapabilities["deepseek-v4-pro"].contextWindow, 1000000);
assert.equal(openCodeGoCatalog.openCodeGoModelCapabilities["deepseek-v4-pro"].maxOutput, 384000);
assert.equal(openCodeGoCatalog.openCodeGoModelCapabilities["deepseek-v4.1-flash"].maxOutput, 384000);
assert.equal(openCodeGoCatalog.meetingAnalysisContextWindow, 1000000);
assert.equal(openCodeGoCatalog.meetingAnalysisMaxOutput, 384000);

const protectedOpenCodeGoManual = ensureConnectionProfiles({
  ...openCodeGoCatalog,
  meetingAnalysisProfiles: {
    ...openCodeGoCatalog.meetingAnalysisProfiles,
    "deepseek-v4-pro": {
      ...openCodeGoCatalog.meetingAnalysisProfiles["deepseek-v4-pro"],
      contextWindow: 256000,
      maxOutput: 24000,
      capabilityManaged: false
    }
  }
});
assert.equal(protectedOpenCodeGoManual.meetingAnalysisContextWindow, 256000);
assert.equal(protectedOpenCodeGoManual.meetingAnalysisMaxOutput, 24000);
assert.equal(protectedOpenCodeGoManual.meetingAnalysisProfiles["deepseek-v4-pro"].capabilitySource, "manual");

const protectedManual = ensureConnectionProfiles({
  ...fetched,
  meetingAnalysisProfiles: {
    ...fetched.meetingAnalysisProfiles,
    "provider-new-model": {
      ...fetched.meetingAnalysisProfiles["provider-new-model"],
      contextWindow: 192000,
      maxOutput: 16000,
      reasoning: "",
      timeoutMs: 190000,
      capabilityManaged: false
    }
  },
  openaiModelCapabilities: {
    "provider-new-model": {
      contextWindow: 512000,
      maxOutput: 64000,
      reasoning: "high",
      timeoutMs: 300000
    }
  }
});
assert.equal(protectedManual.meetingAnalysisContextWindow, 192000);
assert.equal(protectedManual.meetingAnalysisMaxOutput, 16000);
assert.equal(protectedManual.meetingAnalysisProfiles["provider-new-model"].capabilitySource, "manual");

console.log("model capability preset tests passed");
