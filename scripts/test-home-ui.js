"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHomeUi, shortcutKeys } = require("../src/renderer/home-ui");
const { createVoiceHistoryUi } = require("../src/renderer/voice-history-ui");
const { validateUrl } = require("../src/renderer/onboarding-ui");
const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));

function element() {
  return { textContent: "", value: "", hidden: false, dataset: {}, children: [], firstChild: {}, disabled: false, listeners: {},
    classList: { toggle() {} },
    setAttribute() {}, addEventListener(name, callback) { this.listeners[name] = callback; }, replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); } };
}

async function run() {
  assert.deepEqual(shortcutKeys("CommandOrControl+Alt+M", "win32"), ["Ctrl", "Alt", "M"]);
  assert.deepEqual(shortcutKeys("CommandOrControl+Alt+M", "darwin"), ["\u2318", "\u2325", "M"]);
  assert.equal(validateUrl("https://example.invalid/v1/"), "https://example.invalid/v1");
  for (const url of ["http://example.invalid", "https://user:secret@example.invalid", "https://example.invalid?key=secret"]) {
    assert.throws(() => validateUrl(url));
  }
  assert.match(main, /recordVoiceUsage\(text, metadata\)/);
  assert.match(main, /snapshot.transcriptionMode = "fast"/);
  assert.match(main, /captureOwner = "setup"/);
  assert.match(main, /else showWindowOnly\(\)/);
  assert.match(html, /homeHotkeyEdit/);
  assert.doesNotMatch(html.slice(html.indexOf('id="homePanel"'), html.indexOf('id="onboardingPanel"')), /id="recordBtn"/);

  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], element()]));
  const pending = [];
  const historyNavigation = [];
  let historyRows = [];
  let historyFailed = false;
  let historyUpdated;
  const ui = createHomeUi({ document: { getElementById: id => nodes.get(id), createElement: element },
    setInterval: () => 1, clearInterval() {}, setSettingsTab: (...args) => historyNavigation.push(args), mimoInput: {
      getHomeOverview: () => new Promise(resolve => pending.push(resolve)),
      listVoiceHistory: async payload => {
        assert.deepEqual(payload, { limit: 6 });
        if (historyFailed) throw new Error("fixture history unavailable");
        return { ok: true, entries: historyRows, total: historyRows.length };
      },
      openSettings: async () => historyNavigation.push("settings"),
      onVoiceHistoryUpdated: callback => { historyUpdated = callback; }
    } });
  const initial = ui.open(); await tick();
  ui.close(); const reopened = ui.open(); await tick();
  assert.equal(pending.length, 2, "reopening must not reuse a stale homepage request");
  const dto = { ok: true, usage: { today: { count: 2 }, week: { count: 2 } }, recent: [] };
  pending[0]({ ...dto, usage: { today: { count: 999 } } }); await initial;
  assert.notEqual(nodes.get("homeTodayCount").textContent, "999");
  pending[1](dto); await reopened;
  assert.equal(nodes.get("homeTodayCount").textContent, "2");
  assert.equal(nodes.get("homeRecentEmpty").hidden, false);
  assert.equal(nodes.get("homeVoiceRecentEmpty").hidden, false);
  historyRows = [{ requestId: "00000000-0000-4000-a000-000000000001", preview: "<script>fixture text</script>",
    createdAt: "2026-10-07T02:00:00Z", transcriptionMode: "stable", cleanupApplied: true }];
  const recentDto = { ...dto, recent: [{ id: "fixture-file", kind: "file", title: "文件记录", date: "2026-10-07T01:00:00Z" }] };
  const updated = ui.refresh(); await tick(); pending[2](recentDto); await updated;
  assert.equal(nodes.get("homeRecentList").children.length, 1);
  assert.equal(nodes.get("homeVoiceRecentList").children.length, 1);
  assert.equal(nodes.get("homeVoiceRecentList").children[0].children[1].textContent, historyRows[0].preview, "previews are inert text");
  await nodes.get("homeVoiceRecentList").children[0].listeners.click();
  assert.deepEqual(historyNavigation, ["settings", ["history", { requestId: historyRows[0].requestId }]]);
  await nodes.get("homeVoiceHistoryOpen").listeners.click();
  assert.deepEqual(historyNavigation.at(-1), ["history", { requestId: undefined }]);
  historyFailed = true;
  const failedHistory = ui.refresh(); await tick(); pending[3](recentDto); await failedHistory;
  assert.equal(nodes.get("homeRecentList").children.length, 1, "voice-history failure does not hide file/meeting records");
  assert.equal(nodes.get("homeVoiceRecentList").children.length, 0);
  assert.match(nodes.get("homeVoiceRecentEmpty").textContent, /暂时无法读取/);
  historyFailed = false;
  historyUpdated(); await tick(); pending[4](recentDto); await ui.refresh();
  assert.equal(nodes.get("homeVoiceRecentList").children.length, 1, "history event refreshes the home preview");
  const inFlight = ui.refresh(); await tick();
  historyUpdated(); historyUpdated();
  pending[5](recentDto); await inFlight; await tick();
  assert.equal(pending.length, 7, "history events during a refresh queue exactly one follow-up fetch");
  pending[6](recentDto); await ui.refresh();
  ui.close();
  historyUpdated(); await tick(); assert.equal(pending.length, 7, "hidden home never fetches history updates");
  const selectedReads = [];
  const historyUi = createVoiceHistoryUi({ document: { getElementById: id => nodes.get(id), createElement: element }, api: {
    listVoiceHistory: async payload => { assert.equal(payload.query, ""); return { ok: true, entries: historyRows, total: 50 }; },
    getVoiceHistory: async ({ requestId }) => {
      selectedReads.push(requestId);
      return { ok: true, entry: { requestId, createdAt: "2026-10-06T01:00:00Z", rawText: "目标记录原文", text: "目标记录结果", cleanupApplied: true } };
    }
  } });
  nodes.get("voiceHistorySearch").value = "上次搜索";
  const targetId = "00000000-0000-4000-a000-000000000099";
  await historyUi.open({}, { requestId: targetId });
  assert.deepEqual(selectedReads, [targetId], "deep link must select the requested record, even outside the first history page");
  assert.equal(nodes.get("voiceHistorySearch").value, "");
  assert.equal(nodes.get("voiceHistoryRaw").textContent, "目标记录原文");
  historyUi.close();
  console.log("Homepage entry, grouped records, history navigation, error isolation, shortcut, URL privacy and stale request tests passed.");
}

async function verifyHomeBrowser(page, directory) {
  const { prepareBrowser } = require("./test-meeting-live-ui");
  const errors = await prepareBrowser(page);
  await page.waitForFunction(() => document.getElementById("homeTodayCount").textContent === "18");
  assert.equal(await page.locator("#homePanel").isVisible(), true);
  assert.equal(await page.locator("#settingsPanel").isVisible(), false);
  assert.equal(await page.locator("#onboardingPanel").isVisible(), false);
  assert.equal(await page.locator("#homeRecentList button").count(), 2);
  await page.waitForFunction(() => document.querySelectorAll("#homeVoiceRecentList button").length === 2);
  assert.equal(await page.locator("#homeTranscriptionTitle").innerText(), "会议 / 文件转录");
  assert.equal(await page.locator("#homeVoiceTitle").innerText(), "语音输入法记录");
  assert.deepEqual(await page.locator("#homeHotkeyKeys kbd").allTextContents(), ["Ctrl", "Alt", "M"]);
  const screenshots = [];
  async function checkLayout(prefix, sizes) {
    for (const size of sizes) {
      await page.setViewportSize(size);
      const layout = await page.evaluate(() => {
        const controls = [...document.querySelectorAll("button, input, select")].filter(el => el.getClientRects().length);
        const bounds = controls.map(el => {
          const raw = el.getBoundingClientRect();
          const rect = { left: raw.left, top: raw.top, right: raw.right, bottom: raw.bottom };
          for (let parent = el.parentElement; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent); const clip = parent.getBoundingClientRect();
            if (style.overflowY !== "visible") { rect.top = Math.max(rect.top, clip.top); rect.bottom = Math.min(rect.bottom, clip.bottom); }
            if (style.overflowX !== "visible") { rect.left = Math.max(rect.left, clip.left); rect.right = Math.min(rect.right, clip.right); }
          }
          return { id: el.id, rect };
        }).filter(({ rect }) => rect.right > rect.left && rect.bottom > rect.top);
        const overlaps = [];
        for (let i = 0; i < bounds.length; i++) for (let j = i + 1; j < bounds.length; j++) {
          const a = bounds[i].rect; const b = bounds[j].rect;
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) {
            overlaps.push([bounds[i].id, bounds[j].id]);
          }
        }
        return { width: document.documentElement.scrollWidth, viewport: innerWidth, overlaps,
          overflow: bounds.filter(({ rect }) => rect.left < -1 || rect.right > innerWidth + 1).map(({ id }) => id),
          missingImages: [...document.images].filter(img => img.getClientRects().length && (!img.complete || !img.naturalWidth)).map(img => img.src) };
      });
      assert(layout.width <= layout.viewport + 1, `${prefix} page overflow at ${size.width}`);
      assert.deepEqual(layout.overflow, [], `${prefix} controls overflow at ${size.width}`);
      assert.deepEqual(layout.overlaps, [], `${prefix} controls overlap at ${size.width}`);
      assert.deepEqual(layout.missingImages, [], "all visible brand assets must load");
      if (directory) {
        const file = path.join(directory, `${prefix}-${size.width}x${size.height}.png`);
        await page.screenshot({ path: file }); screenshots.push(file);
      }
    }
  }
  const sizes = [{ width: 960, height: 760 }, { width: 640, height: 520 }, { width: 390, height: 844 }];
  await checkLayout("home", sizes);
  await page.evaluate(async () => { window.mockHome.platform = "darwin"; await window.HomeUi.refresh(); });
  assert.deepEqual(await page.locator("#homeHotkeyKeys kbd").allTextContents(), ["\u2318", "\u2325", "M"]);
  await page.locator("#homeVoiceHistoryOpen").click();
  await page.waitForFunction(() => document.getElementById("settingsHistoryPanel").hidden === false);
  await page.locator("#voiceHistorySearch").fill("找不到的记录");
  await page.waitForFunction(() => document.getElementById("voiceHistoryStatus").textContent.includes("没有匹配"));
  await page.locator("#homeBtn").click();
  await page.waitForFunction(() => document.body.classList.contains("home-mode"));
  await page.locator("#homeVoiceRecentList button").nth(1).click();
  await page.waitForFunction(() => document.getElementById("voiceHistoryRaw").textContent === "这是较早的一条语音输入测试记录。");
  assert.equal(await page.locator("#voiceHistorySearch").inputValue(), "", "home deep links clear stale searches");
  assert.equal(await page.locator(".voice-history-row.is-active span").innerText(), "这是较早的一条语音输入测试记录。");
  await page.locator("#voiceHistoryCopyRaw").click();
  await page.waitForFunction(() => window.mockCalls.some(call => call.name === "copyText" && call.payload === "这是较早的一条语音输入测试记录。"));
  await page.locator("#homeBtn").click();
  await page.waitForFunction(() => document.body.classList.contains("home-mode"));
  await page.evaluate(async () => {
    window.mockApiOverrides = { listVoiceHistory: async () => { throw new Error("fixture unreadable"); } };
    await window.HomeUi.refresh();
  });
  assert.equal(await page.locator("#homeRecentList button").count(), 2);
  assert.match(await page.locator("#homeVoiceRecentEmpty").innerText(), /暂时无法读取/);
  await page.evaluate(async () => { delete window.mockApiOverrides.listVoiceHistory; await window.HomeUi.refresh(); });
  assert.equal(await page.locator("#homeVoiceRecentList button").count(), 2);
  await page.locator("#homeHotkeyEdit").click();
  await page.waitForFunction(() => document.body.classList.contains("settings-open"));
  assert.equal(await page.locator("#hotkeyInput").evaluate(el => document.activeElement === el), true);
  await page.locator("#homeBtn").click();
  await page.waitForFunction(() => document.body.classList.contains("home-mode"));
  await page.locator("#homeMeetingOpen").click();
  await page.waitForFunction(() => document.body.classList.contains("meeting-mode"));
  await page.locator("#homeBtn").click();
  await page.waitForFunction(() => document.body.classList.contains("home-mode"));
  await page.locator("#homeFileOpen").click();
  await page.waitForFunction(() => document.body.classList.contains("file-mode"));
  await page.locator("#homeBtn").click();
  await page.waitForFunction(() => document.body.classList.contains("home-mode"));

  await page.evaluate(async () => {
    window.mockHome.onboarding = { status: "pending" };
    await window.HomeUi.refresh();
  });
  await page.waitForFunction(() => window.OnboardingUi.isOpen());
  await checkLayout("guide-asr", sizes);
  await page.setViewportSize({ width: 960, height: 760 });
  assert.deepEqual(await page.locator("#guideAsrProvider option").evaluateAll(options => options.map(item => item.value)), ["mimo", "qwen3-asr"]);
  await page.locator("#guideAsrProvider").selectOption("qwen3-asr");
  assert.equal(await page.locator("#guideAsrConsoleLabel").innerText(), "Qwen API 控制台");
  await page.locator("#guideAsrConsole").click();
  await page.waitForFunction(() => window.mockCalls.some(call => call.name === "openAsrConsole" && call.payload === "qwen3-asr"));
  await page.locator("#guideAsrProvider").selectOption("mimo");
  assert.equal(await page.locator("#guideAsrConsoleLabel").innerText(), "MiMo API 控制台");
  await page.locator("#guideAsrConsole").click();
  await page.waitForFunction(() => window.mockCalls.some(call => call.name === "openAsrConsole" && call.payload === "mimo"));
  await page.locator("#guideAsrUrl").fill("https://example.invalid/v1");
  await page.locator("#guideAsrKey").fill("test-only-guide-asr");
  await page.locator("#guideAsrTest").click();
  await page.waitForFunction(() => /120ms/.test(document.getElementById("guideAsrTestStatus").textContent));
  await page.locator("#guideNext").click();
  await page.waitForFunction(() => document.getElementById("onboardingProgress").textContent === "2 / 3");
  await page.locator("#guideCleanupEnabled").check();
  await page.locator("#guideCleanerName").fill("Test supplier");
  await page.locator("#guideCleanerUrl").fill("https://example.invalid/v1");
  await page.locator("#guideCleanerKey").fill("test-only-guide-cleaner");
  await page.locator("#guideCleanerStyle").selectOption("responses");
  await page.locator("#guideCleanerFetch").click();
  await page.waitForFunction(() => document.getElementById("guideCleanerModel").value === "custom-text-model");
  await checkLayout("guide-cleaner", sizes);
  await page.setViewportSize({ width: 960, height: 760 });
  await page.locator("#guideNext").click();
  await page.waitForFunction(() => document.getElementById("onboardingProgress").textContent === "3 / 3");
  await page.locator("#guideHotkey").focus();
  await page.waitForFunction(() => window.mockCalls.some(call => call.name === "startHotkeyCapture"));
  await page.locator("#guideHotkey").press("Control+Alt+V");
  await page.waitForFunction(() => document.getElementById("guideHotkey").value === "CommandOrControl+Alt+V");
  await checkLayout("guide-device", sizes);
  await page.setViewportSize({ width: 960, height: 760 });
  await page.locator("#guideMicrophoneTest").click();
  await page.waitForFunction(() => /\u65e0\u6cd5\u8bbf\u95ee/.test(document.getElementById("guideMicrophoneStatus").textContent));
  assert.equal(await page.evaluate(() => window.mockCalls.filter(call => call.name === "onboardingMicrophoneProbe" && call.payload === false).length), 1);
  await page.locator("#guideNext").click();
  await page.waitForFunction(() => document.getElementById("onboardingPanel").hidden);
  assert.equal(await page.locator("#homePanel").isVisible(), true);
  const saved = await page.evaluate(() => {
    const settings = window.mockSettings(); const pair = settings.textModelSelections.cleanup;
    return { provider: settings.asrProvider, asr: settings.asrModel, mode: settings.transcriptionMode,
      cleaner: pair.modelId, style: settings.textSuppliers.find(item => item.id === pair.supplierId).apiStyle,
      hotkey: settings.hotkey, keyFieldsCleared: !document.getElementById("guideAsrKey").value && !document.getElementById("guideCleanerKey").value };
  });
  assert.deepEqual(saved, { provider: "mimo", asr: "mimo-v2.5-asr", mode: "stable", cleaner: "custom-text-model", style: "responses",
    hotkey: "CommandOrControl+Alt+V", keyFieldsCleared: true });

  await page.locator("#homeGuideOpen").click();
  await page.waitForFunction(() => window.OnboardingUi.isOpen());
  await page.locator("#guideSkip").click();
  await page.waitForFunction(() => document.getElementById("onboardingPanel").hidden);
  assert.equal(await page.evaluate(() => window.mockHome.onboarding.status), "skipped");
  // Closing while getUserMedia is unresolved must keep ownership until late
  // tracks are stopped, and a reopened guide must wait for that cleanup.
  await page.evaluate(async () => {
    window.probeEvents = [];
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { window.resolveProbe = () => resolve({
      getTracks: () => [{ stop: () => window.probeEvents.push("track-stopped") }]
    }); });
    await window.OnboardingUi.open();
    document.getElementById("guideMicrophoneTest").click();
  });
  await page.waitForFunction(() => typeof window.resolveProbe === "function");
  const releases = await page.evaluate(() => window.mockCalls.filter(call => call.name === "onboardingMicrophoneProbe" && call.payload === false).length);
  await page.evaluate(() => { window.OnboardingUi.close(); void window.OnboardingUi.open(); });
  assert.equal(await page.evaluate(() => window.mockCalls.filter(call => call.name === "onboardingMicrophoneProbe" && call.payload === false).length), releases);
  await page.evaluate(() => window.resolveProbe());
  await page.waitForFunction(() => document.getElementById("onboardingPanel").hidden === false);
  assert.deepEqual(await page.evaluate(() => window.probeEvents), ["track-stopped"]);
  assert.equal(await page.evaluate(() => window.mockCalls.filter(call => call.name === "onboardingMicrophoneProbe" && call.payload === false).length), releases + 1);
  await page.locator("#guideSkip").click();
  await page.waitForFunction(() => document.getElementById("onboardingPanel").hidden);
  assert.deepEqual(errors, [], "browser exceptions");
  return { result: "Homepage, navigation and complete onboarding browser flow passed", screenshots };
}

async function verifyNativeApp() {
  const { _electron } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const sandbox = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ovi-home-native-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|MIMO|QWEN|DASHSCOPE|FUN_ASR|CLEANER|OSS|OVI_/i.test(key)));
  const application = await _electron.launch({ executablePath: require("electron"),
    args: [__filename, "--electron-app-fixture", sandbox], env });
  try {
    const page = await application.firstWindow();
    await page.waitForFunction(() => document.getElementById("onboardingPanel").hidden === false);
    const state = await application.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return { path: app.getPath("userData"), resizable: window.isResizable(), minimum: window.getMinimumSize(), topmost: window.isAlwaysOnTop() };
    });
    assert.equal(state.path.startsWith(sandbox), true, "the real app must use isolated test configuration");
    assert.equal(state.resizable, true); assert.equal(state.topmost, false); assert.deepEqual(state.minimum, [640, 520]);
    await page.locator("#guideSkip").click();
    await page.waitForFunction(() => document.getElementById("homePanel").hidden === false && document.getElementById("homeTodayCount").textContent === "0");
    assert.equal(await page.locator("#homeSetupNotice").isVisible(), true);
    await page.locator("#settingsBtn").click();
    await page.waitForFunction(() => document.body.classList.contains("settings-open"));
    await page.locator("#homeBtn").click();
    await page.waitForFunction(() => document.body.classList.contains("home-mode"));
    await page.evaluate(async () => {
      await window.mimoInput.recordVoiceHistory({ requestId: "00000000-0000-4000-a000-000000000003",
        rawText: "呃，这是隔离主页测试记录。", text: "这是隔离主页测试记录。", transcriptionMode: "stable", cleanupApplied: true });
    });
    await page.waitForFunction(() => document.querySelectorAll("#homeVoiceRecentList button").length === 1);
    assert.equal(await page.locator("#homeRecentEmpty").isVisible(), true);
    await page.locator("#homeVoiceRecentList button").click();
    await page.waitForFunction(() => document.getElementById("settingsHistoryPanel").hidden === false
      && document.getElementById("voiceHistoryRaw").textContent === "呃，这是隔离主页测试记录。");
    assert.equal(await page.locator("#voiceHistoryResult").innerText(), "这是隔离主页测试记录。");
    console.log("Native Electron homepage, first-run onboarding and IPC navigation passed with isolated configuration and no API calls.");
  } finally { await application.close(); }
}

module.exports = { verifyHomeBrowser, verifyNativeApp };
if (process.versions.electron && process.argv.includes("--electron-app-fixture")) {
  const { app } = require("electron");
  const sandbox = process.argv[process.argv.indexOf("--electron-app-fixture") + 1];
  const { shell } = require("electron");
  globalThis.oviTestConsoleUrls = [];
  shell.openExternal = async url => { globalThis.oviTestConsoleUrls.push(url); };
  fs.mkdirSync(path.join(sandbox, "documents"), { recursive: true });
  app.setPath("appData", sandbox); app.setPath("documents", path.join(sandbox, "documents"));
  require("../src/main.js");
} else if (require.main === module) (async () => {
  await run();
  if (process.argv.includes("--electron")) { await verifyNativeApp(); return; }
  if (!process.argv.includes("--browser")) return;
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const directory = path.join(root, "output/playwright/homepage-2026-09-30"); fs.mkdirSync(directory, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try { console.log(JSON.stringify(await verifyHomeBrowser(await browser.newPage(), directory), null, 2)); }
  finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
