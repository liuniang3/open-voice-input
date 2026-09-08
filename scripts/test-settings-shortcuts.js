"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  ensureConnectionProfiles,
  migrateConnectionProfiles
} = require("../src/settings/connection-profiles");
const { validateHotkey } = require("../src/hotkeys/validate-hotkey");

const root = path.join(__dirname, "..");

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("legacy global credentials migrate once into active ASR and cleaner profiles", () => {
  const migrated = migrateConnectionProfiles({
    apiKey: "legacy-key",
    baseUrl: "https://legacy.example/v1",
    asrModel: "mimo-v2.5-asr",
    cleanerModel: "mimo-v2.5"
  });
  assert.equal(migrated.apiKey, "");
  assert.equal(migrated.baseUrl, "");
  assert.equal(migrated.asrProfiles["mimo-v2.5-asr"].apiKey, "legacy-key");
  assert.equal(migrated.cleanerProfiles["mimo-v2.5"].apiKey, "legacy-key");
  assert.equal(migrated._legacyGlobalCredentialsMigrated, true);
});

test("ASR and cleaner model profiles remain isolated when active models change", () => {
  const settings = ensureConnectionProfiles({
    _connectionProfilesMigrated: true,
    asrModel: "custom-asr-b",
    asrProfiles: {
      "custom-asr-a": { provider: "mimo", apiKey: "key-a", baseUrl: "https://a.example/v1" },
      "custom-asr-b": { provider: "qwen3-asr", apiKey: "key-b", baseUrl: "https://b.example/v1" }
    },
    cleanerModel: "cleaner-b",
    cleanerProfiles: {
      "cleaner-a": { provider: "mimo", apiKey: "clean-a", baseUrl: "https://clean-a.example/v1" },
      "cleaner-b": { provider: "openai-compatible", apiKey: "clean-b", baseUrl: "https://clean-b.example/v1" }
    }
  });
  assert.equal(settings.asrApiKey, "key-b");
  assert.equal(settings.asrBaseUrl, "https://b.example/v1");
  assert.equal(settings.cleanerApiKey, "clean-b");
  assert.equal(settings.cleanerBaseUrl, "https://clean-b.example/v1");
  assert.equal(settings.asrProfiles["custom-asr-a"].apiKey, "key-a");
  assert.equal(settings.cleanerProfiles["cleaner-a"].apiKey, "clean-a");
});

test("meeting transcription and analysis profiles restore only the selected model", () => {
  const settings = ensureConnectionProfiles({
    _connectionProfilesMigrated: true,
    meetingQwenModel: "qwen-custom",
    meetingQwenProfiles: {
      "qwen3-asr-flash": { apiKey: "qwen-a", baseUrl: "https://qwen-a.example/v1" },
      "qwen-custom": { apiKey: "qwen-b", baseUrl: "https://qwen-b.example/v1" }
    },
    meetingFunAsrModel: "fun-asr-mtl",
    meetingFunAsrProfiles: {
      "fun-asr": { apiKey: "fun-a", baseUrl: "https://fun-a.example/v1" },
      "fun-asr-mtl": { apiKey: "fun-b", baseUrl: "https://fun-b.example/v1" }
    },
    meetingAnalysisModel: "grok-4.5",
    meetingAnalysisProfiles: {
      "gpt-5.4-mini": { apiKey: "analysis-a", baseUrl: "https://analysis-a.example/v1" },
      "grok-4.5": {
        apiKey: "analysis-b",
        baseUrl: "https://analysis-b.example/v1",
        contextWindow: 500000,
        maxOutput: 12000,
        timeoutMs: 180000
      }
    }
  });
  assert.equal(settings.meetingQwenApiKey, "qwen-b");
  assert.equal(settings.meetingFunAsrApiKey, "fun-b");
  assert.equal(settings.meetingAnalysisApiKey, "analysis-b");
  assert.equal(settings.meetingAnalysisContextWindow, 500000);
  assert.equal(settings.meetingAnalysisProfiles["gpt-5.4-mini"].apiKey, "analysis-a");
});

test("shortcut validation rejects app conflicts, reserved keys and malformed values", () => {
  assert.equal(
    validateHotkey("Control+Alt+M", { otherHotkeys: ["CommandOrControl+Alt+M"] }).code,
    "app_conflict"
  );
  assert.equal(validateHotkey("Alt+F4").code, "reserved");
  assert.equal(validateHotkey("Shift+Ctrl+Esc").code, "reserved");
  assert.equal(validateHotkey("M").code, "invalid_format");
  assert.deepEqual(validateHotkey("Ctrl+Alt+V"), {
    ok: true,
    code: "ok",
    accelerator: "CommandOrControl+Alt+V",
    message: "快捷键可用"
  });
});

test("settings UI has per-model controls and no general credentials tab", () => {
  const html = fs.readFileSync(path.join(root, "src", "renderer", "index.html"), "utf8");
  assert.doesNotMatch(html, /data-settings-tab="credentials"/);
  assert.doesNotMatch(html, /id="apiKeyInput"|id="baseUrlInput"/);
  assert.match(html, /id="meetingHotkeyInput"/);
  assert.match(html, /id="meetingBtn"[\s\S]*会议工作台/);
  assert.match(html, /id="asrRealtimeModelPresetSelect"/);
  assert.match(html, /value="mimo-v2\.5-asr"/);
  assert.match(html, /value="qwen3-asr-flash-realtime"/);
  assert.match(html, /value="qwen3-asr-flash-realtime-2026-02-10"/);
  assert.match(html, /value="fun-asr-realtime"/);
  assert.match(html, /id="asrCustomRealtimeModelField"[^>]*hidden/);
  assert.match(html, /id="meetingQwenModelPresetSelect"/);
  assert.match(html, /id="meetingFunAsrModelPresetSelect"/);
  assert.match(html, /id="meetingAnalysisModelPresetSelect"/);
});

console.log("settings/shortcut tests passed");
