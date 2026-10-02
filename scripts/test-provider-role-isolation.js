"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { ensureConnectionProfiles } = require("../src/settings/connection-profiles");
const { ensureTextSuppliers } = require("../src/settings/text-suppliers");
const { mergeAsrConnections, resolveProviderConnection } = require("../src/settings/provider-connections");
const { resolveTextLlmProfile } = require("../src/providers/text-supplier-llm");
const { profileFor, previewProfileFor, meetingTextProfile } = require("../src/meeting/realtime/providers");
const { resolveMeetingFileAsrCredentials } = require("../src/meeting/processing/file-asr-credentials");
const { testProviderConnection } = require("../src/providers/provider-connection-test");
const { createVoicePipeline } = require("../src/providers/voice-pipeline");
const ui = require("../src/renderer/text-supplier-ui");
const normalize = value => ensureTextSuppliers(ensureConnectionProfiles(value));

function isolatedSettings() {
  return normalize({
    asrConnections: {
      mimo: { baseUrl: "https://asr.example/v1", apiKey: "fixture-asr" },
      aliyun: { baseUrl: "https://ali-asr.example", apiKey: "fixture-ali" }
    },
    providerConnections: { mimo: { baseUrl: "https://stale.example/v1", apiKey: "fixture-stale" } },
    textSuppliers: [{ id: "mimo-text", name: "MiMo 文本", baseUrl: "https://text.example/v1",
      apiKey: "fixture-text", authStyle: "api-key", apiStyle: "chat-completions" }],
    textModelSelections: {
      cleanup: { supplierId: "mimo-text", modelId: "mimo-v2.5" },
      summary: { supplierId: "mimo-text", modelId: "mimo-v2.5-pro" }
    },
    asrModel: "mimo-v2.5-asr", asrProvider: "mimo", meetingFileAsrModel: "mimo-v2.5-asr",
    _languageSuppliersMigrated: true
  });
}

async function run() {
  const old = {
    _connectionProfilesMigrated: true, _providerConnectionsMigrated: true,
    providerConnections: {
      mimo: { baseUrl: "https://old-mimo.example/v1", apiKey: "fixture-old-mimo" },
      openai: { baseUrl: "https://old-text.example/v1", apiKey: "fixture-old-openai", apiStyle: "responses" }
    },
    cleanerModel: "mimo-v2.5", cleanerProvider: "mimo", meetingAnalysisModel: "gpt-5.5"
  };
  const before = structuredClone(old);
  const migrated = normalize(old);
  assert.deepEqual(old, before, "migration must not mutate its input");
  assert.equal(migrated.asrConnections.mimo.apiKey, "fixture-old-mimo");
  assert.equal(resolveTextLlmProfile(migrated, { slot: "cleanup" }).apiKey, "fixture-old-mimo");
  assert.equal(resolveTextLlmProfile(migrated, { slot: "summary" }).baseUrl, "https://old-text.example/v1");
  assert.equal(resolveTextLlmProfile(migrated, { slot: "summary" }).apiStyle, "responses");
  assert.deepEqual(normalize(migrated), migrated, "migration is idempotent");
  assert.notEqual(migrated.asrConnections.mimo, migrated.providerConnections.mimo, "migration copies connections, not shared references");

  const textOnly = normalize({ cleanerModel: "mimo-v2.5", cleanerProvider: "mimo",
    cleanerProfiles: { "mimo-v2.5": { provider: "mimo", baseUrl: "https://only-text.example/v1", apiKey: "fixture-only-text" } } });
  assert.equal(textOnly.asrConnections.mimo.apiKey, "", "unified migration must not invent ASR credentials from text-only profiles");
  const asrOnly = normalize({ asrConnections: { mimo: { baseUrl: "https://only-asr.example/v1", apiKey: "fixture-only-asr" } } });
  assert.equal(asrOnly.textSuppliers.length, 0, "ASR setup must not create language suppliers");
  assert.deepEqual(ui.legacyModels(asrOnly, "cleanup"), []);
  assert.equal(ui.selectionFor(asrOnly, "cleanup").supplierId, "");
  assert.throws(() => resolveTextLlmProfile(asrOnly, { slot: "summary" }), { code: "supplier_model_missing" });

  const settings = isolatedSettings();
  const changedAsr = normalize({ ...settings, asrConnections: mergeAsrConnections(settings.asrConnections,
    { mimo: { baseUrl: "https://new-asr.example/v1", apiKey: "fixture-new-asr" } }) });
  assert.equal(resolveMeetingFileAsrCredentials({ settings: changedAsr, env: {} }).baseUrl, "https://new-asr.example/v1");
  assert.equal(profileFor(changedAsr, "mimo-v2.5-asr", false, {}).apiKey, "fixture-new-asr");
  assert.equal(previewProfileFor(changedAsr, "fun-asr-realtime").apiKey, "fixture-ali");
  assert.equal(resolveTextLlmProfile(changedAsr, { slot: "cleanup" }).apiKey, "fixture-text");
  assert.equal(meetingTextProfile(changedAsr).baseUrl, "https://text.example/v1");
  assert.deepEqual(changedAsr.providerConnections, settings.providerConnections, "ASR edits leave legacy text connections untouched");
  const changedText = normalize({ ...changedAsr, textSuppliers: [{ ...changedAsr.textSuppliers[0],
    baseUrl: "https://new-text.example/v1", apiKey: "fixture-new-text" }] });
  assert.equal(resolveTextLlmProfile(changedText, { slot: "cleanup" }).apiKey, "fixture-new-text");
  assert.deepEqual(changedText.asrConnections, changedAsr.asrConnections);
  assert.equal(settings.asrConnections.mimo.apiKey, "fixture-asr", "older recording snapshots stay unchanged");

  const cleared = normalize({ ...changedText, asrConnections: mergeAsrConnections(changedText.asrConnections,
    { mimo: { apiKey: "" } }) });
  assert.equal(resolveProviderConnection(cleared, { provider: "mimo", scope: "asr",
    fallback: { apiKey: "fixture-stale", baseUrl: "https://stale.example/v1" } }).apiKey, "");
  assert.throws(() => resolveMeetingFileAsrCredentials({ settings: cleared, env: {} }), { code: "meeting_file_asr_credentials_missing" });
  assert.equal(resolveTextLlmProfile(cleared, { slot: "cleanup" }).apiKey, "fixture-new-text");
  const deleted = normalize({ ...settings, textSuppliers: [], textModelSelections: { cleanup: null, summary: null } });
  assert.equal(deleted.textSuppliers.length, 0, "removed legacy language entries must not reappear");
  assert.throws(() => resolveTextLlmProfile(deleted, { slot: "summary" }), { code: "supplier_model_missing" });
  const pipeline = createVoicePipeline({ getSettings: () => deleted });
  assert.equal(await pipeline.cleanText({ rawText: "测试文本。" }), "测试文本。", "missing language supplier safely preserves raw text");
  const fastPipeline = createVoicePipeline({ getSettings: () => ({ ...deleted, transcriptionMode: "fast" }) });
  assert.equal((await fastPipeline.testConnection())[1].ok, true, "fast/ASR setup tests never require a language supplier");

  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: "测试" }, finish_reason: "stop" }] }), { status: 200 });
  };
  await testProviderConnection({ settings, provider: "mimo", scope: "asr", fetchImpl });
  await testProviderConnection({ settings, supplierId: "mimo-text", modelId: "mimo-v2.5", fetchImpl });
  await testProviderConnection({ settings: { ...settings, asrConnections: {
    ...settings.asrConnections, aliyun: { ...settings.asrConnections.aliyun, apiStyle: "responses" }
  } }, provider: "aliyun", scope: "asr", fetchImpl });
  assert.equal(requests[0].url, "https://asr.example/v1/chat/completions");
  assert.equal(requests[0].options.headers["api-key"], "fixture-asr");
  assert.equal(requests[0].body.model, "mimo-v2.5-asr");
  assert.equal(requests[0].body.messages[0].content[0].type, "input_audio", "ASR tests must test audio, not a language prompt");
  assert.equal(requests[1].url, "https://text.example/v1/chat/completions");
  assert.equal(requests[1].options.headers["api-key"], "fixture-text");
  assert.equal(requests[2].url, "https://ali-asr.example/compatible-mode/v1/chat/completions");
  assert.equal(requests[2].options.headers.Authorization, "Bearer fixture-ali");
  assert.equal(requests[2].body.messages[0].content[0].type, "input_audio");
  await assert.rejects(() => testProviderConnection({ settings, provider: "openai", scope: "asr", fetchImpl }), { code: "provider_not_supported" });
  assert.equal(requests.length, 3, "unsupported ASR providers fail before any request");
  console.log("Provider role migration, routing, credential isolation, clearing and audio-test regressions passed.");
}

async function verifyBrowser(page, output) {
  const { prepareBrowser } = require("./test-meeting-live-ui");
  const errors = await prepareBrowser(page);
  const fixture = isolatedSettings();
  await page.evaluate(async value => { await window.mimoInput.saveSettings(value); window.mockOpenSettings(); }, fixture);
  await page.locator('[data-settings-tab="asr-connections"]').click();
  assert.equal(await page.locator("#mimoBaseUrlInput").inputValue(), "https://asr.example/v1");
  assert.equal(await page.locator("#mimoApiKeyInput").inputValue(), "fixture-asr");
  assert.equal(await page.locator("#textSupplierCards").isVisible(), false);
  await page.locator("#mimoBaseUrlInput").fill("https://edited-asr.example/v1");
  await page.locator("#saveSettingsBtn").click();
  await page.waitForFunction(() => window.mockSettings().asrConnections.mimo.baseUrl === "https://edited-asr.example/v1");
  const state = await page.evaluate(() => ({ text: window.mockSettings().textSuppliers[0].baseUrl,
    legacy: window.mockSettings().providerConnections.mimo.baseUrl }));
  assert.deepEqual(state, { text: "https://text.example/v1", legacy: "https://stale.example/v1" });
  await page.locator('[data-settings-tab="connections"]').click();
  assert.equal(await page.locator("#mimoBaseUrlInput").isVisible(), false);
  assert.equal(await page.locator("#textSupplierCards").isVisible(), true);
  await page.locator('[data-settings-tab="cleaner"]').click();
  assert.equal(await page.locator('#cleanupSupplierSelect option[value="__legacy__"]').count(), 0);
  assert.equal(await page.locator("#cleanupSupplierSelect").inputValue(), "mimo-text");
  for (const size of [{ width: 1180, height: 800 }, { width: 640, height: 520 }]) {
    await page.setViewportSize(size);
    for (const tab of ["asr-connections", "connections"]) {
      await page.locator(`[data-settings-tab="${tab}"]`).click();
      const overflow = await page.locator("#settingsPanel").evaluate(el => el.scrollWidth > el.clientWidth + 1);
      assert.equal(overflow, false, `${tab} overflow at ${size.width}`);
      await page.screenshot({ path: path.join(output, `${tab}-${size.width}.png`) });
    }
  }
  assert.deepEqual(errors, [], "shared UI exceptions");
  console.log("Separate supplier tabs, saved ASR edits, independent language selection and responsive layouts passed.");
}

module.exports = { verifyBrowser };
if (require.main === module) run().then(async () => {
  if (!process.argv.includes("--browser")) return;
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const output = path.resolve(__dirname, "../output/playwright/provider-roles");
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true });
  try { await verifyBrowser(await browser.newPage(), output); }
  finally { await browser.close(); }
}).catch(error => { console.error(error); process.exitCode = 1; });
