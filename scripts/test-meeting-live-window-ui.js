"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const { fixture, completed, tick, deferred } = require("./test-meeting-live-ui");
const recording = (patch = {}) => completed({ status: "recording", recording: true, ...patch });
const plain = value => JSON.parse(JSON.stringify(value));

// Execute the current production window functions with either a fake or real BrowserWindow.
function windowController(mainWindow, onUpdate = () => {}, state = recording()) {
  const source = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const context = vm.createContext({ mainWindow, windowMode: "meeting",
    liveWindowFlags: { floating: false, alwaysOnTop: false }, liveWindowRestore: null,
    livePresentation: { fontSize: 14, opacity: .9, normalBounds: null }, liveWindowStore: null,
    liveWindowSaveTimer: null, liveWindowCandidate: null, applyingLiveGeometry: false, setTimeout, clearTimeout, screen: null,
    liveTransparentPreview: null,
    os: require("node:os"),
    ...require("../src/settings/meeting-window"), logEvent() {},
    getRealtimeMeeting: () => ({ status: () => state }),
    publishLiveUpdate: dto => { context.syncLivePreview(dto); onUpdate({ ...dto, window: plain(context.liveWindowSnapshot()) }); },
    setWindowAlwaysOnTop: (win, value) => win.setAlwaysOnTop(value),
    liveError: code => Object.assign(new Error(code), { code }),
    pickMeetingFields: (object, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(object, key)).map(key => [key, object[key]]))
  });
  vm.runInContext(source.slice(source.indexOf("function restoreLiveWindow("), source.indexOf("function enforceWindowGeometry(")), context);
  return { invoke: payload => ({ ok: true, ...context.setLiveWindow(payload) }), context, state };
}

function fakeWindow() {
  const geometry = { bounds: { x: 100, y: 90, width: 1130, height: 760 }, minimumSize: [960, 640],
    resizable: true, top: false, maximized: true };
  return { geometry, isDestroyed: () => false, webContents: { send() {} },
    getBounds: () => ({ ...geometry.bounds }), getNormalBounds: () => ({ ...geometry.bounds }),
    getMinimumSize: () => [...geometry.minimumSize], isResizable: () => geometry.resizable,
    isAlwaysOnTop: () => geometry.top, isMaximized: () => geometry.maximized,
    setBounds: value => { geometry.bounds = { ...value }; },
    setMinimumSize: (...value) => { geometry.minimumSize = value; },
    setResizable: value => { geometry.resizable = value; }, setAlwaysOnTop: value => { geometry.top = value; },
    setBackgroundColor() {},
    maximize: () => { geometry.maximized = true; }, unmaximize: () => { geometry.maximized = false; }
  };
}

async function unitChecks() {
  const f = fixture();
  await f.ui.open();
  const win = fakeWindow();
  const saved = plain(win.geometry);
  const native = windowController(win, value => f.push(value));
  f.handlers.meetingLiveWindow = native.invoke;
  f.push(native.state);
  await f.click("liveFloat");
  assert.deepEqual(f.last("meetingLiveWindow").args[0], { floating: true });
  assert.equal(win.geometry.top, true, "MAIN's default pin is not overridden");
  assert.equal(f.$("liveAlwaysOnTop").attributes["aria-pressed"], "true");
  assert.equal(win.geometry.bounds.width, 640);
  assert.equal(win.geometry.maximized, false);
  f.$("liveAlwaysOnTop").click();
  await tick();
  assert.deepEqual(f.last("meetingLiveWindow").args[0], { alwaysOnTop: false });
  win.geometry.bounds = { x: 200, y: 100, width: 720, height: 590 };
  native.context.rememberLiveGeometry(true);
  win.geometry.bounds = { x: 200, y: 100, width: 450, height: 280 };
  native.context.observeLiveGeometry();
  assert.equal(native.context.livePresentation.normalBounds.width, 720, "drag intermediates do not replace settled bounds");
  assert.equal(native.context.liveWindowCandidate.width, 450);
  win.geometry.bounds = { x: 200, y: 100, width: 300, height: 150 };
  native.context.observeLiveGeometry();
  assert.equal(native.context.liveWindowCandidate, null, "crossing the tiny threshold discards drag intermediates");
  f.push({ ...native.state, window: plain(native.context.liveWindowSnapshot()) });
  assert.equal(f.$("meetingPanel").classList.contains("live-minimal"), true);
  assert.equal(win.geometry.top, false, "shrinking must retain explicit unpin");
  await f.click("liveRestoreNormal");
  assert.equal(win.geometry.bounds.width, 720);
  assert.equal(f.$("meetingPanel").classList.contains("live-minimal"), false);
  f.$("liveAlwaysOnTop").click();
  await tick();
  await f.click("liveDetail");
  assert.deepEqual(win.geometry, saved, "return detailed restores pin, bounds and maximization");
  assert.equal(native.context.liveWindowRestore, null);
  assert.equal(f.$("liveAlwaysOnTop").attributes["aria-pressed"], "false");
  assert.equal(f.count("meetingLiveStart"), 0);
  assert.equal(f.count("meetingLiveStop"), 0);
  console.log("ok - UI actions use production window defaults and restore saved maximization");

  f.push(completed({ recoverableSessions: [{ sessionId: "old", title: "历史例会", status: "completed" }] }));
  await f.click("liveHistoryToggle");
  assert.equal(f.$("liveHistoryBrowser").hidden, false);
  f.push(recording());
  assert.equal(f.$("liveHistoryBrowser").hidden, true);
  const opening = deferred();
  f.handlers.meetingLiveWindow = () => opening.promise;
  await f.click("liveFloat");
  f.$("liveMeetingPanel").scrollTop = 500;
  opening.resolve({ ok: true, floating: true, minimal: false, alwaysOnTop: true });
  await tick();
  assert.equal(f.$("liveMeetingPanel").hidden, false);
  assert.equal(f.$("liveHistoryBrowser").hidden, true);
  assert.equal(f.$("liveMeetingPanel").scrollTop, 0);
  console.log("ok - recording and floating mode close the history browser");

  f.push(recording({ markdownPath: "C:/mock/raw.md" }));
  const stop = deferred();
  f.handlers.meetingLiveStop = () => stop.promise;
  await f.click("liveStop");
  await f.click("liveOpenMarkdown");
  stop.resolve({ ok: true, ...completed() });
  await tick();
  assert.equal(f.$("liveStatus").title, "已完成");
  f.push(recording({ status: "stopping", paused: true, recording: false, error: { code: "live_stop_failed" } }));
  assert.equal(f.$("liveStop").disabled, false);
  console.log("ok - opening output cannot discard stop completion; paused stop failures remain retryable");
  f.ui.close();
}

function installPreload() {
  const { ipcRenderer } = require("electron");
  const hooks = new Map();
  ipcRenderer.on("test-live-update", (_event, value) => hooks.get("onMeetingLiveUpdate")?.(value));
  ipcRenderer.on("meeting:live:window-changed", (_event, value) => hooks.get("onMeetingLiveWindowChanged")?.(value));
  window.mimoInput = new Proxy({}, { get(_target, name) {
    if (String(name).startsWith("on")) return callback => {
      hooks.set(name, callback); return () => hooks.delete(name);
    };
    return payload => ipcRenderer.invoke("test-live-call", name, payload);
  } });
}

async function electronFixture() {
  const { app, BrowserWindow, ipcMain, screen } = require("electron");
  await app.whenReady();
  // No recording, provider request, persisted settings or personal data in this fixture.
  const win = new BrowserWindow({ width: 1130, height: 760, minWidth: 960, minHeight: 640, show: true,
    frame: false, thickFrame: process.platform === "win32", transparent: process.platform !== "win32",
    backgroundColor: process.platform === "win32" ? "#eef4f1" : "#00000000",
    ...(process.platform === "win32" ? { backgroundMaterial: "acrylic" } : {}),
    webPreferences: { preload: __filename, contextIsolation: false, nodeIntegration: false, sandbox: false } });
  const calls = [];
  const state = recording({ modelId: "qwen-audio-3.0-asr-flash-streaming", title: "产品研发周会", durationMs: 91000,
    rawText: "接口联调已完成。下一步验证恢复与导出。", previewText: "正在讨论下一阶段的交付计划。", previewStatus: "streaming" });
  const push = value => win.webContents.send("test-live-update", value);
  const controller = windowController(win, push, state);
  controller.context.liveTransparentPreview = require("../src/meeting/transparent-preview").createTransparentPreview({
    BrowserWindow, ipcMain, screen: { getCursorScreenPoint: () => globalThis.fixturePreviewCursor || screen.getCursorScreenPoint() },
    mainWindow: win, onPresentation: value => controller.invoke(value),
    onBounds: bounds => { controller.context.applyingLiveGeometry = true; try { win.setBounds(bounds, false); }
      finally { controller.context.applyingLiveGeometry = false; } controller.context.observeLiveGeometry(); }
  });
  win.on("resize", () => { controller.context.observeLiveGeometry(); push({ ...state, window: plain(controller.context.liveWindowSnapshot()) }); });
  win.on("move", () => controller.context.observeLiveGeometry());
  const settings = { meetingRealtimeModel: state.modelId, cleanerModel: "llm-fixture", cleanerProfiles: { "llm-fixture": {} } };
  ipcMain.handle("test-live-call", async (_event, name, payload) => {
    calls.push({ name, payload });
    if (name === "getSettings") return settings;
    if (name === "getStatus") return { settings, hasApiKey: false, registeredHotkeys: [] };
    if (name === "meetingLiveWindow") return controller.invoke(payload);
    if (name === "meetingLivePause" || name === "meetingLiveResume") {
      state.paused = name === "meetingLivePause";
      state.status = state.paused ? "paused" : "recording";
    }
    if (name === "meetingLiveStop") Object.assign(state, { status: "completed", recording: false, paused: false, previewText: "" });
    if (["meetingLiveStatus", "meetingLivePause", "meetingLiveResume", "meetingLiveStop"].includes(name)) {
      const dto = { ok: true, ...state, window: plain(controller.context.liveWindowSnapshot()) };
      if (name !== "meetingLiveStatus") push(dto);
      return dto;
    }
    return { ok: true };
  });
  globalThis.liveWindowReview = { controller, win, calls, push };
  win.on("closed", () => controller.context.liveTransparentPreview?.dispose());
  await win.loadFile(path.join(root, "src/renderer/index.html"));
  app.on("window-all-closed", () => app.quit());
}

async function nativeChecks() {
  const { _electron } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const application = await _electron.launch({ executablePath: require("electron"), args: [__filename, "--electron-fixture"] });
  const output = path.join(root, "output/playwright");
  fs.mkdirSync(output, { recursive: true });
  const directory = fs.mkdtempSync(path.join(output, "meeting-window-review-"));
  try {
    const page = await application.firstWindow();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.waitForFunction(() => typeof window.applyWindowMode === "function");
    await page.evaluate(async () => { window.applyWindowMode("meeting"); await window.MeetingLiveUi.open(); });
    await application.evaluate(() => globalThis.liveWindowReview.win.maximize());
    await page.waitForFunction(() => innerWidth > 1130);
    const saved = await application.evaluate(() => ({ bounds: globalThis.liveWindowReview.win.getNormalBounds(), maximized: globalThis.liveWindowReview.win.isMaximized() }));
    await page.locator("#liveFloat").click();
    await page.waitForFunction(() => document.querySelector("#liveAlwaysOnTop").getAttribute("aria-pressed") === "true" && innerWidth === 640);
    assert.equal(await application.evaluate(() => globalThis.liveWindowReview.win.isAlwaysOnTop()), true);
    await page.screenshot({ path: path.join(directory, "floating-native.png") });
    await page.locator("#liveAlwaysOnTop").click();
    await page.waitForFunction(() => document.querySelector("#liveAlwaysOnTop").getAttribute("aria-pressed") === "false");
    await application.evaluate(() => globalThis.liveWindowReview.win.setSize(420, 300));
    await page.waitForFunction(() => innerWidth === 420);
    assert.equal(await application.evaluate(() => globalThis.liveWindowReview.win.isAlwaysOnTop()), false);
    await page.locator("#livePause").click();
    await page.waitForFunction(() => document.querySelector("#livePause").textContent === "继续录制");
    await application.evaluate(() => {
      const { controller, push } = globalThis.liveWindowReview;
      Object.assign(controller.state, { title: "很长的会议标题".repeat(25), previewText: "" });
      push({ ...controller.state, window: controller.context.liveWindowSnapshot() });
    });
    const compactHeight = await page.locator("#liveRaw").evaluate(element => element.clientHeight);
    await application.evaluate(() => globalThis.liveWindowReview.win.setSize(620, 560));
    await page.waitForFunction(() => innerWidth === 620 && innerHeight === 560);
    const expandedCompactHeight = await page.locator("#liveRaw").evaluate(element => element.clientHeight);
    assert(expandedCompactHeight > compactHeight + 100,
      `compact transcript grows with native window (${compactHeight} -> ${expandedCompactHeight})`);
    await page.screenshot({ path: path.join(directory, "compact-native-expanded.png") });
    await application.evaluate(() => globalThis.liveWindowReview.controller.context.rememberLiveGeometry(true));
    await application.evaluate(() => globalThis.liveWindowReview.win.setSize(360, 240));
    await page.waitForFunction(() => innerWidth === 360);
    await page.mouse.move(-10, -10);
    assert.equal(await page.locator("#liveRestoreNormal").isVisible(), false);
    await page.locator("#livePreview").hover();
    assert.equal(await page.locator("#liveRestoreNormal").isVisible(), true);
    assert.equal(await page.locator("#liveRaw").isVisible(), false);
    assert.equal(await page.locator("#livePreview").isVisible(), true);
    assert.equal(await page.locator("#livePause").isVisible(), false);
    await page.screenshot({ path: path.join(directory, "compact-native-360.png") });
    await page.locator("#liveRestoreNormal").click();
    await page.waitForFunction(() => innerWidth === 620 && innerHeight === 560);
    await page.locator("#livePause").click();
    await page.waitForFunction(() => document.querySelector("#livePause").textContent === "暂停");
    await page.locator("#liveAlwaysOnTop").click();
    await page.waitForFunction(() => document.querySelector("#liveAlwaysOnTop").getAttribute("aria-pressed") === "true");
    await page.locator("#liveDetail").click();
    await page.waitForFunction(() => !document.querySelector("#meetingPanel").classList.contains("live-floating") && innerWidth > 1130);
    const restored = await application.evaluate(() => ({ bounds: globalThis.liveWindowReview.win.getNormalBounds(), maximized: globalThis.liveWindowReview.win.isMaximized(), pin: globalThis.liveWindowReview.win.isAlwaysOnTop() }));
    assert.deepEqual(restored.bounds, saved.bounds);
    assert.equal(restored.maximized, saved.maximized);
    assert.equal(restored.pin, false);
    await page.screenshot({ path: path.join(directory, "detailed-restored-native.png") });
    await page.locator("#liveFloat").click();
    await page.waitForFunction(() => innerWidth === 620);
    await page.locator("#liveStop").click();
    await page.waitForFunction(() => document.querySelector("#liveStatus").title === "已完成");
    const calls = await application.evaluate(() => globalThis.liveWindowReview.calls);
    assert.equal(calls.filter(call => call.name === "meetingLiveStart").length, 0);
    assert.equal(calls.filter(call => call.name === "meetingLiveStop").length, 1);
    assert.equal(calls.filter(call => call.name === "meetingLivePause").length, 1);
    assert.equal(calls.filter(call => call.name === "meetingLiveResume").length, 1);
    assert.deepEqual(errors, []);
    console.log(`Native Electron window checks passed; screenshots: ${directory}`);
  } finally { await application.close(); }
}

if (process.type === "renderer") installPreload();
else if (process.versions.electron && process.argv.includes("--electron-fixture")) electronFixture().catch(error => { console.error(error); process.exitCode = 1; });
else if (require.main === module) (async () => {
  await unitChecks();
  if (process.argv.includes("--electron")) await nativeChecks();
})().catch(error => { console.error(error); process.exitCode = 1; });
