"use strict";

const assert = require("node:assert/strict");
const { dictationSelection, workspaceSelection, savedFollowPreferences, workspaceReadiness } = require("../src/asr-defaults");
const { ensureConnectionProfiles } = require("../src/settings/connection-profiles");
const { resolveMeetingFileAsrCredentials } = require("../src/meeting/processing/file-asr-credentials");

const qwen = { asrModel: "qwen3-asr-flash", asrProvider: "qwen3-asr",
  asrRealtimeModel: "qwen-audio-3.0-asr-flash-streaming-2026-09-18" };
const mimo = { asrModel: "mimo-v2.5-asr", asrProvider: "mimo", asrRealtimeModel: "mimo-v2.5-asr" };
for (const settings of [qwen, mimo]) {
  assert.equal(workspaceSelection(settings, "file").modelId, settings.asrModel);
  assert.equal(workspaceSelection(settings, "live").modelId, settings.asrRealtimeModel);
  assert.equal(workspaceSelection(settings, "file").followsDictation, true);
}
assert.equal(dictationSelection({ ...qwen, asrModel: qwen.asrRealtimeModel }, "file").modelId, "qwen3-asr-flash");
assert.equal(dictationSelection({ ...qwen, asrModel: "qwen3-asr-flash-realtime-2026-02-10", asrRealtimeModel: "" }, "live").modelId,
  "qwen-audio-3.0-asr-flash-streaming");
assert.equal(dictationSelection({ asrModel: "fun-asr", asrProvider: "fun-asr" }, "live").modelId, "fun-asr-realtime");
assert.equal(dictationSelection({ ...qwen, asrModel: "qwen3-asr-flash-custom" }, "file").modelId, "qwen3-asr-flash-custom");

const independent = { ...qwen, meetingRealtimeModel: mimo.asrModel, meetingFileAsrModel: mimo.asrModel,
  meetingFileAsrProvider: "mimo", meetingRealtimeFollowDictation: false, meetingFileAsrFollowDictation: false };
assert.equal(workspaceSelection(independent, "live").modelId, mimo.asrModel);
assert.equal(workspaceSelection(independent, "file").provider, "mimo");
assert.deepEqual(savedFollowPreferences(independent), { meetingRealtimeFollowDictation: false, meetingFileAsrFollowDictation: false });
assert.deepEqual(savedFollowPreferences({}), { meetingRealtimeFollowDictation: true, meetingFileAsrFollowDictation: true });
assert.deepEqual(savedFollowPreferences({ meetingRealtimeModel: mimo.asrModel, meetingFileAsrModel: mimo.asrModel }),
  { meetingRealtimeFollowDictation: false, meetingFileAsrFollowDictation: false });

const connections = { aliyun: { baseUrl: "https://example.invalid/aliyun", apiKey: "test-only-asr-ali" },
  mimo: { baseUrl: "https://example.invalid/mimo/v1", apiKey: "test-only-asr-mimo" } };
let settings = ensureConnectionProfiles({ ...qwen, asrConnections: connections,
  meetingRealtimeFollowDictation: true, meetingFileAsrFollowDictation: true,
  providerConnections: { mimo: { apiKey: "test-only-language-key" } } });
assert.equal(settings.meetingRealtimeModel, qwen.asrRealtimeModel);
assert.equal(settings.meetingFileAsrModel, qwen.asrModel);
let file = resolveMeetingFileAsrCredentials({ settings, env: {} });
assert.equal(file.provider, "qwen3-asr"); assert.equal(file.apiKey, "test-only-asr-ali");
assert.match(file.baseUrl, /^https:\/\/example\.invalid\/aliyun/);

settings = ensureConnectionProfiles({ ...settings, ...mimo });
assert.equal(settings.meetingRealtimeModel, mimo.asrModel);
assert.equal(settings.meetingFileAsrModel, mimo.asrModel);
file = resolveMeetingFileAsrCredentials({ settings, env: {} });
assert.equal(file.provider, "mimo"); assert.equal(file.apiKey, "test-only-asr-mimo");
assert.equal(file.baseUrl, "https://example.invalid/mimo/v1");
settings = ensureConnectionProfiles({ ...settings, ...qwen, ...independent });
assert.equal(settings.meetingFileAsrModel, mimo.asrModel);
assert.equal(settings.meetingRealtimeModel, mimo.asrModel);
assert.equal(resolveMeetingFileAsrCredentials({ settings, env: {} }).apiKey, "test-only-asr-mimo");

const empty = ensureConnectionProfiles({ ...qwen, asrConnections: {}, providerConnections: { aliyun: { apiKey: "test-only-language-key" } } });
assert.throws(() => resolveMeetingFileAsrCredentials({ settings: empty, env: {} }), { code: "meeting_file_asr_credentials_missing" });
const legacy = ensureConnectionProfiles({ ...qwen, _connectionProfilesMigrated: true,
  asrProfiles: { [qwen.asrModel]: { provider: "qwen3-asr", apiKey: "test-only-legacy-ali" } },
  meetingFileAsrProfiles: { [mimo.asrModel]: { apiKey: "test-only-legacy-mimo" } } });
assert.equal(legacy.asrConnections.aliyun.apiKey, "test-only-legacy-ali");
assert.equal(legacy.meetingFileAsrProfiles[mimo.asrModel].apiKey, "test-only-legacy-mimo");
assert.equal(legacy.asrConnections.mimo.apiKey, "test-only-legacy-mimo");
console.log("PASS shared ASR defaults, transport companions, live switching, explicit selection, migration and credential isolation");

for (const purpose of ["file", "live"]) {
  assert.equal(workspaceReadiness({ ...qwen, asrConnections: connections }, purpose).ready, true);
  assert.equal(workspaceReadiness({ ...mimo, asrConnections: connections }, purpose).ready, true);
  const cleared = { ...qwen, asrConnections: {}, providerConnections: { aliyun: connections.aliyun },
    asrProfiles: { [qwen.asrModel]: connections.aliyun } };
  assert.equal(workspaceReadiness(cleared, purpose).ready, false, "cleared ASR credentials cannot borrow another scope or stale profile");
  for (const baseUrl of ["not-a-url", "http://example.invalid"]) {
    assert.equal(workspaceReadiness({ ...qwen, asrConnections: { aliyun: { ...connections.aliyun, baseUrl } } }, purpose).ready, false);
  }
  const status = workspaceReadiness({ ...qwen, asrConnections: connections }, purpose);
  assert.deepEqual(Object.keys(status).sort(), ["message", "ready"]);
  assert.doesNotMatch(JSON.stringify(status), /test-only|example\.invalid/);
}
assert.equal(workspaceReadiness({ ...qwen, meetingRealtimeModel: "gpt-test", meetingRealtimeFollowDictation: false,
  asrConnections: connections }, "live").ready, false);
assert.equal(workspaceReadiness({ ...qwen, meetingFileAsrModel: "mimo-v2.5-asr", meetingFileAsrProvider: "qwen3-asr",
  meetingFileAsrFollowDictation: false, asrConnections: connections }, "file").ready, false);
assert.equal(workspaceReadiness({ ...qwen, asrConnections: { aliyun: { ...connections.aliyun,
  baseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/inference" } } }, "live").ready, true);
console.log("PASS local workspace readiness, valid custom endpoints, invalid models, empty credentials and safe status metadata");
