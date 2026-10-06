"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { settingsTab, nextSettingsTab } = require("../src/renderer/settings-workspace");
const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");

function unitTests() {
  assert.equal(settingsTab("general"), "asr");
  assert.equal(settingsTab("asr-connections"), "asr");
  assert.equal(settingsTab("connections"), "cleaner");
  assert.equal(settingsTab("unexpected"), "asr");
  assert.equal(nextSettingsTab("asr", "ArrowUp"), "updates");
  assert.equal(nextSettingsTab("updates", "ArrowDown"), "asr");
  assert.equal(nextSettingsTab("history", "Home"), "asr");
  assert.equal(nextSettingsTab("asr", "End"), "updates");
  assert.deepEqual([...html.matchAll(/data-settings-tab="([^"]+)"/g)].map(match => match[1]), ["asr", "cleaner", "history", "updates"]);
  assert.deepEqual([...html.matchAll(/data-settings-panel="([^"]+)"/g)].map(match => match[1]), ["asr", "cleaner", "history", "updates"]);
  const asr = html.slice(html.indexOf('id="settingsAsrPanel"'), html.indexOf('id="settingsCleanerPanel"'));
  const cleaner = html.slice(html.indexOf('id="settingsCleanerPanel"'), html.indexOf('id="legacyMeetingSettings"'));
  for (const id of ["stableModeBtn", "fastModeBtn", "hotkeyInput", "meetingHotkeyInput", "microphoneSelect", "asrProviderSelect", "mimoApiKeyInput", "aliyunApiKeyInput", "asrModelPresetSelect"]) assert.ok(asr.includes(`id="${id}"`), `${id} belongs to recognition settings`);
  for (const id of ["textSupplierAdd", "textSupplierCards", "cleanupSupplierSelect", "cleanupModelSelect", "summarySupplierSelect"]) assert.ok(cleaner.includes(`id="${id}"`), `${id} belongs to expression settings`);
  assert.ok(cleaner.indexOf('id="textSupplierAdd"') < cleaner.indexOf('id="cleanupSupplierSelect"'));
  assert.equal((html.match(/id="asrProviderSelect"/g) || []).length, 1);
  assert.match(html, /aria-orientation="vertical"/);
  console.log("Settings navigation, migration aliases, keyboard navigation and same-page configuration contracts passed.");
}

async function verifyBrowser(page, output) {
  const { prepareBrowser } = require("./test-meeting-live-ui");
  const errors = await prepareBrowser(page);
  const releaseImageRequests = [];
  page.on("request", request => { if (request.url().includes("notes-image.invalid")) releaseImageRequests.push(request.url()); });
  await page.evaluate(async () => {
    const records = [{ requestId: "00000000-0000-4000-a000-000000000001", createdAt: "2026-10-06T06:00:00.000Z", rawText: "呃，请你看看这个窗口。", text: "请你看看这个窗口。", transcriptionMode: "stable", cleanupApplied: true, asrModel: "asr-fixture", cleanerModel: "text-fixture", durationMs: 3200 }];
    window.mockApiOverrides = {
      listVoiceHistory: async ({ query = "" }) => {
        const rows = records.filter(row => (row.rawText + row.text).includes(query));
        return { ok: true, entries: rows.map(row => ({ ...row, preview: row.text })), total: rows.length };
      },
      getVoiceHistory: async ({ requestId }) => ({ ok: true, entry: records.find(row => row.requestId === requestId) }),
      getUpdateStatus: async () => ({ status: "available", currentVersion: "0.4.11", availableVersion: "0.4.12", supported: true, platform: "win32", releaseNotes: "<h2>改进</h2><ul><li>四栏设置</li><li>本机历史</li></ul><img src='https://notes-image.invalid/track.png' onerror='window.releaseExecuted=true'><script>window.releaseExecuted=true</script>" })
    };
    await window.mimoInput.saveSettings({ _languageSuppliersMigrated: true, textSuppliers: [], textModelSelections: { cleanup: null, summary: null },
      asrConnections: { mimo: { baseUrl: "https://api.xiaomimimo.com/v1", apiKey: "" }, aliyun: { baseUrl: "https://dashscope.aliyuncs.com", apiKey: "" } } });
    await window.mockOpenSettings();
  });
  await page.waitForFunction(() => document.body.classList.contains("settings-open"));
  assert.equal(await page.locator('[data-settings-tab]').count(), 4);
  assert.equal(await page.locator("#settingsPanel").locator("#hotkeyInput").isVisible(), true);
  assert.equal(await page.locator("#mimoApiKeyInput").isVisible(), true);
  assert.equal(await page.locator("#aliyunApiKeyInput").isVisible(), false);
  await page.locator("#asrProviderSelect").selectOption("qwen3-asr");
  assert.equal(await page.locator("#mimoApiKeyInput").isVisible(), false);
  assert.equal(await page.locator("#aliyunApiKeyInput").isVisible(), true);
  assert.equal(await page.locator("#asrModelPresetSelect").inputValue(), "qwen3-asr-flash");
  await page.locator("#saveSettingsBtn").click();
  await page.waitForFunction(() => window.mockSettings().asrProvider === "qwen3-asr");
  await page.locator("#fastModeBtn").click();
  await page.locator('[data-settings-tab="cleaner"]').click();
  assert.match(await page.locator("#expressionModeNotice").innerText(), /快速模式/);
  assert.equal(await page.locator("#textSupplierAdd").isVisible(), true);
  assert.equal(await page.locator("#textSupplierEditor").isVisible(), false, "new users shouldn't see disabled supplier details");
  assert.equal(await page.locator("#cleanupModelSelect").isVisible(), true);
  assert.equal(await page.locator('#cleanupSupplierSelect option[value="__legacy__"]').count(), 0, "new users see no legacy supplier route");
  await page.locator('[data-settings-tab="history"]').click();
  await page.waitForFunction(() => document.getElementById("voiceHistoryRaw").textContent.includes("看看"));
  assert.equal(await page.locator("#voiceHistoryResult").innerText(), "请你看看这个窗口。");
  await page.locator("#voiceHistoryCopyRaw").click();
  assert.equal(await page.evaluate(() => window.mockCalls.findLast(call => call.name === "copyText").payload), "呃，请你看看这个窗口。");
  await page.locator("#voiceHistoryEnabled").uncheck();
  await page.waitForFunction(() => window.mockSettings().voiceHistoryEnabled === false);
  await page.locator("#voiceHistorySearch").fill("没有匹配内容");
  await page.waitForFunction(() => document.getElementById("voiceHistoryStatus").textContent.includes("没有匹配"));
  assert.equal(await page.locator("#voiceHistoryDetail").isVisible(), false);
  await page.locator("#voiceHistorySearch").fill("");
  await page.waitForFunction(() => !document.getElementById("voiceHistoryDetail").hidden);
  await page.locator('[data-settings-tab="updates"]').click();
  await page.waitForFunction(() => !document.getElementById("updateReleaseNotesBlock").hidden);
  assert.match(await page.locator("#updateReleaseNotesText").innerText(), /本机历史/);
  assert.doesNotMatch(await page.locator("#updateReleaseNotesText").innerText(), /releaseExecuted|<h2>/);
  assert.equal(await page.evaluate(() => window.releaseExecuted), undefined);
  await page.locator("#updateAutoCheckInput").uncheck();
  await page.waitForFunction(() => window.mockSettings().updateAutoCheck === false);
  await page.locator('[data-settings-tab="updates"]').focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.locator('[data-settings-tab="asr"]').getAttribute("aria-selected"), "true");
  const screenshots = [];
  for (const size of [{ width: 1040, height: 780 }, { width: 840, height: 700 }, { width: 640, height: 520 }, { width: 540, height: 620 }]) {
    await page.setViewportSize(size);
    for (const tab of ["asr", "cleaner", "history", "updates"]) {
      await page.locator(`[data-settings-tab="${tab}"]`).click();
      const overflow = await page.evaluate(() => {
        const regions = ["settingsPanel", "settingsAsrPanel", "settingsCleanerPanel", "settingsHistoryPanel", "settingsUpdatesPanel"];
        return regions.filter(id => { const el = document.getElementById(id); return el.getClientRects().length && el.scrollWidth > el.clientWidth + 1; });
      });
      assert.deepEqual(overflow, [], `${tab} must fit the window at ${size.width}`);
      const filename = path.join(output, `settings-${tab}-${size.width}.png`);
      await page.mouse.move(4, 4);
      await page.waitForTimeout(160);
      await page.screenshot({ path: filename }); screenshots.push(filename);
    }
    const nav = await page.locator('[data-settings-tab]').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().left));
    assert.equal(new Set(nav).size, 1, "tabs always remain a vertical left-hand list");
  }
  assert.deepEqual(errors, [], "settings pages must not raise browser exceptions");
  assert.deepEqual(releaseImageRequests, [], "release notes can't load remote media");
  console.log("Settings browser: provider selection, mode, history, update notes, keyboard and four window sizes passed.");
  return screenshots;
}

module.exports = { verifyBrowser };
async function verifyNativeSettings() {
  const { _electron } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const sandbox = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ovi-settings-native-"));
  const requestId = require("node:crypto").randomUUID();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|MIMO|QWEN|DASHSCOPE|FUN_ASR|CLEANER|OSS|OVI_/i.test(key)));
  const launch = () => _electron.launch({ executablePath: require("electron"),
    args: [path.join(__dirname, "test-home-ui.js"), "--electron-app-fixture", sandbox], env });
  let application = await launch();
  try {
    let page = await application.firstWindow();
    await page.waitForFunction(() => !document.getElementById("onboardingPanel").hidden);
    await page.locator("#guideSkip").click();
    await page.locator("#settingsBtn").click();
    await page.waitForFunction(() => document.body.classList.contains("settings-open"));
    assert.equal(await page.locator('[data-settings-tab]').count(), 4);
    assert.equal(await page.locator("#settingsAsrPanel").isVisible(), true);
    assert.equal(await page.locator("#mimoApiKeyInput").inputValue(), "", "native fixture must not inherit real keys");
    await page.evaluate(async id => {
      await window.completeRawTranscript("这是隔离测试中的语音原文。", { transcriptionMode: "fast", history: { requestId: id, durationMs: 2200 },
        settingsSnapshot: { asrModel: "asr-fixture" } });
    }, requestId);
    await page.locator('[data-settings-tab="history"]').click();
    await page.waitForFunction(() => document.getElementById("voiceHistoryRaw").textContent.includes("隔离测试"));
    assert.equal(await page.locator("#voiceHistoryList button").count(), 1);
    const overview = await page.evaluate(() => window.mimoInput.getHomeOverview());
    assert.equal(overview.usage.today.count, 0, "history saving itself is not a pasted dictation");
    await page.locator("#voiceHistoryEnabled").uncheck();
    await page.waitForFunction(() => !document.getElementById("voiceHistoryEnabled").disabled);
    const disabled = await page.evaluate(async () => {
      await window.mimoInput.recordVoiceHistory({ requestId: crypto.randomUUID(), rawText: "disabled test", text: "disabled test", transcriptionMode: "fast" });
      return window.mimoInput.listVoiceHistory({});
    });
    assert.equal(disabled.total, 1, "disabled history doesn't store new text");
    const userData = await application.evaluate(({ app }) => app.getPath("userData"));
    assert.ok(userData.startsWith(sandbox));
    const persisted = JSON.parse(fs.readFileSync(path.join(userData, "voice-history", `${requestId}.json`), "utf8"));
    assert.equal(persisted.rawText, "这是隔离测试中的语音原文。");
    assert.equal(persisted.asrModel, "asr-fixture");
    assert.equal("settingsSnapshot" in persisted, false);
    await application.close(); application = await launch();
    page = await application.firstWindow();
    await page.waitForFunction(() => !document.getElementById("homePanel").hidden);
    const restored = await page.evaluate(async id => ({ entry: await window.mimoInput.getVoiceHistory({ requestId: id }),
      enabled: (await window.mimoInput.getSettings()).voiceHistoryEnabled }), requestId);
    assert.equal(restored.entry.entry.rawText, persisted.rawText);
    assert.equal(restored.enabled, false);
    console.log("Native Windows settings: real IPC, completed dictation history, privacy toggle and restart persistence passed with isolated user data and no API calls.");
  } finally { await application.close(); }
}
if (require.main === module) (async () => {
  unitTests();
  if (process.argv.includes("--electron")) { await verifyNativeSettings(); return; }
  if (!process.argv.includes("--browser")) return;
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const output = path.join(root, "output/playwright/settings-workspace"); fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try { await verifyBrowser(await browser.newPage(), output); }
  finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
