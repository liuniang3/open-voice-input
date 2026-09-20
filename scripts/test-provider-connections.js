"use strict";

const assert = require("node:assert/strict");
const {
  ensureConnectionProfiles,
  migrateConnectionProfiles
} = require("../src/settings/connection-profiles");
const { resolveMeetingAnalysisCredentials } = require("../src/meeting/analysis/credentials");
const { resolveMeetingQwenCredentials } = require("../src/meeting/processing/meeting-credentials");
const { resolveMeetingFileAsrCredentials } = require("../src/meeting/processing/file-asr-credentials");
const { resolveMeetingFunAsrCredentials } = require("../src/meeting/processing/fun-asr-credentials");
const { previewProfileFor, profileFor } = require("../src/meeting/realtime/providers");

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("migration prefers a credential-bearing custom GPT endpoint over an official stale profile", () => {
  const settings = migrateConnectionProfiles({
    cleanerModel: "gpt-5.4-mini",
    cleanerProfiles: {
      "gpt-5.4-mini": {
        apiKey: "fixture-openai",
        baseUrl: "https://gateway.example/v1",
        wire_api: "responses"
      }
    },
    meetingAnalysisModel: "gpt-5.5",
    meetingAnalysisProfiles: {
      "gpt-5.5": { apiKey: "fixture-openai", baseUrl: "https://api.openai.com/v1" }
    }
  });
  assert.deepEqual(settings.providerConnections.openai, {
    apiKey: "fixture-openai",
    baseUrl: "https://gateway.example/v1",
    apiStyle: "responses"
  });
  assert.equal(settings.meetingAnalysisProfiles["gpt-5.5"].baseUrl, "https://gateway.example/v1");
});

test("legacy GPT gateway without a protocol migrates to the OpenAI Responses default", () => {
  const settings = migrateConnectionProfiles({
    meetingAnalysisModel: "gpt-5.5",
    meetingAnalysisProfiles: {
      "gpt-5.5": { apiKey: "fixture-openai", baseUrl: "https://gateway.example/v1" }
    }
  });
  assert.equal(settings.providerConnections.openai.baseUrl, "https://gateway.example/v1");
  assert.equal(settings.providerConnections.openai.apiStyle, "responses");
});

test("an existing shared key is not replaced during first migration", () => {
  const settings = migrateConnectionProfiles({
    providerConnections: {
      openai: { apiKey: "fixture-canonical", baseUrl: "https://canonical.example/v1", apiStyle: "chat-completions" }
    },
    meetingAnalysisModel: "gpt-5.5",
    meetingAnalysisProfiles: {
      "gpt-5.5": { apiKey: "fixture-legacy", baseUrl: "https://legacy.example/v1", apiStyle: "responses" }
    }
  });
  assert.equal(settings.providerConnections.openai.apiKey, "fixture-canonical");
  assert.equal(settings.providerConnections.openai.baseUrl, "https://canonical.example/v1");
  assert.equal(settings.providerConnections.openai.apiStyle, "chat-completions");
});

test("Ali shared root resolves compatible, REST, and streaming operation paths", () => {
  const settings = ensureConnectionProfiles({
    _connectionProfilesMigrated: true,
    _providerConnectionsMigrated: true,
    providerConnections: {
      aliyun: { apiKey: "fixture-ali", baseUrl: "https://dashscope.aliyuncs.com" }
    },
    meetingQwenModel: "qwen3-asr-flash",
    meetingFileAsrModel: "qwen3-asr-flash-filetrans",
    meetingFileAsrProvider: "qwen3-asr",
    meetingFunAsrModel: "fun-asr",
    meetingRealtimeModel: "fun-asr-realtime"
  });
  assert.equal(resolveMeetingQwenCredentials({ env: {}, settings }).baseUrl,
    "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(resolveMeetingFileAsrCredentials({ env: {}, settings }).baseUrl,
    "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(resolveMeetingFunAsrCredentials({ env: {}, settings }).baseUrl,
    "https://dashscope.aliyuncs.com/api/v1");
  assert.equal(previewProfileFor(settings, "fun-asr-realtime").baseUrl,
    "https://dashscope.aliyuncs.com/api-ws/v1/inference");
});

test("GPT analysis receives Responses style while an unrelated compatible model stays per-model", () => {
  const settings = ensureConnectionProfiles({
    _connectionProfilesMigrated: true,
    _providerConnectionsMigrated: true,
    providerConnections: {
      openai: { apiKey: "fixture-openai", baseUrl: "https://gateway.example/v1", apiStyle: "responses" }
    },
    meetingAnalysisModel: "gpt-5.5",
    meetingAnalysisProfiles: {
      "gpt-5.5": {},
      "grok-4.5": { apiKey: "fixture-other", baseUrl: "https://other.example/v1", apiStyle: "chat-completions" }
    }
  });
  const analysis = resolveMeetingAnalysisCredentials({ env: {}, settings });
  assert.equal(analysis.baseUrl, "https://gateway.example/v1");
  assert.equal(analysis.apiStyle, "responses");
  const other = profileFor(settings, "grok-4.5", true, {});
  assert.equal(other.apiKey, "fixture-other");
  assert.equal(other.baseUrl, "https://other.example/v1");
  assert.equal(other.apiStyle, "chat-completions");
});

test("OpenCode Go credentials remain isolated for cleanup and meeting analysis", () => {
  const settings = ensureConnectionProfiles({
    _connectionProfilesMigrated: true,
    _providerConnectionsMigrated: true,
    providerConnections: {
      mimo: { apiKey: "fixture-mimo", baseUrl: "https://api.xiaomimimo.com/v1" },
      openai: { apiKey: "fixture-openai", baseUrl: "https://api.openai.com/v1", apiStyle: "responses" },
      "opencode-go": {
        apiKey: "fixture-go",
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiStyle: "chat-completions"
      }
    },
    cleanerModel: "mimo-v2.5",
    cleanerProfiles: {
      "mimo-v2.5": { provider: "opencode-go", providerFamily: "opencode-go" }
    },
    meetingAnalysisModel: "glm-5.2",
    meetingAnalysisProfiles: {
      "glm-5.2": { provider: "opencode-go", providerFamily: "opencode-go" }
    }
  });
  assert.equal(settings.cleanerProvider, "opencode-go");
  assert.equal(settings.cleanerApiKey, "fixture-go");
  assert.equal(settings.cleanerProfiles["mimo-v2.5"].apiKey, "fixture-go");
  const analysis = resolveMeetingAnalysisCredentials({ env: {}, settings });
  assert.equal(analysis.providerFamily, "opencode-go");
  assert.equal(analysis.apiKey, "fixture-go");
  assert.equal(analysis.baseUrl, "https://opencode.ai/zen/go/v1");
  assert.equal(analysis.apiStyle, "chat-completions");
  const liveSummary = profileFor(settings, "glm-5.2", true, {});
  assert.equal(liveSummary.provider, "opencode-go");
  assert.equal(liveSummary.apiKey, "fixture-go");
  assert.equal(liveSummary.baseUrl, "https://opencode.ai/zen/go/v1");
});

console.log("provider connection tests passed");
