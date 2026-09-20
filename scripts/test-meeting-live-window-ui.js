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
    liveWindowFlags: { floating: false, compact: false, alwaysOnTop: false }, liveWindowRestore: null,
    getRealtimeMeeting: () => ({ status: () => state }),
    publishLiveUpdate: dto => onUpdate({ ...dto, window: plain(context.liveWindowFlags) }),
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
  return { geometry, isDestroyed: () => false,
    getBounds: () => ({ ...geometry.bounds }), getNormalBounds: () => ({ ...geometry.bounds }),
    getMinimumSize: () => [...geometry.minimumSize], isResizable: () => geometry.resizable,
    isAlwaysOnTop: () => geometry.top, isMaximized: () => geometry.maximized,
    setBounds: value => { geometry.bounds = { ...value }; },
    setMinimumSize: (...value) => { geometry.minimumSize = value; },
    setResizable: value => { geometry.resizable = value; }, setAlwaysOnTop: value => { geometry.top = value; },
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
  assert.deepEqual(f.last("meetingLiveWindow").args[0], { floating: true, compact: false });
  assert.equal(win.geometry.top, true, "MAIN's default pin is not overridden");
  assert.equal(f.$("liveAlwaysOnTop").checked, true);
  assert.equal(win.geometry.bounds.width, 640);
  assert.equal(win.geometry.maximized, false);
  f.$("liveAlwaysOnTop").checked = false;
  f.$("liveAlwaysOnTop").dispatch("change");
  await tick();
  assert.deepEqual(f.last("meetingLiveWindow").args[0], { alwaysOnTop: false });
  await f.click("liveCompact");
  assert.equal(win.geometry.top, false, "compact must retain explicit unpin");
  assert.equal(win.geometry.bounds.width, 420);
  assert.equal(f.$("meetingPanel").classList.contains("live-compact"), true);
  f.$("liveAlwaysOnTop").checked = true;
  f.$("liveAlwaysOnTop").dispatch("change");
  await tick();
  await f.click("liveDetail");
  assert.deepEqual(win.geometry, saved, "return detailed restores pin, bounds and maximization");
  assert.equal(native.context.liveWindowRestore, null);
  assert.equal(f.$("liveAlwaysOnTop").checked, false);
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
  opening.resolve({ ok: true, floating: true, compact: false, alwaysOnTop: true });
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
  assert.equal(f.$("liveStatus").textContent, "已完成");
  f.push(recording({ status: "stopping", paused: true, recording: false, error: { code: "live_stop_failed" } }));
  assert.equal(f.$("liveStop").disabled, false);
  console.log("ok - opening output cannot discard stop completion; paused stop failures remain retryable");
  f.ui.close();
}

function installPreload() {
  const { ipcRenderer } = require("electron");
  const hooks = new Map();
  ipcRenderer.on("test-live-update", (_event, value) => hooks.get("onMeetingLiveUpdate")?.(value));
  window.mimoInput = new Proxy({}, { get(_target, name) {
    if (String(name).startsWith("on")) return callback => {
      hooks.set(name, callback); return () => hooks.delete(name);
    };
    return payload => ipcRenderer.invoke("test-live-call", name, payload);
  } });
}

async function electronFixture() {
  const { app, BrowserWindow, ipcMain } = require("electron");
  await app.whenReady();
  // No recording, provider request, persisted settings or personal data in this fixture.
  const win = new BrowserWindow({ width: 1130, height: 760, minWidth: 960, minHeight: 640, show: true,
    frame: false, transparent: true, webPreferences: { preload: __filename, contextIsolation: false, nodeIntegration: false, sandbox: false } });
  const calls = [];
  const state = recording({ modelId: "qwen-audio-3.0-asr-flash-streaming", title: "产品研发周会", durationMs: 91000,
    rawText: "接口联调已完成。下一步验证恢复与导出。", previewText: "正在讨论下一阶段的交付计划。", previewStatus: "streaming" });
  const push = value => win.webContents.send("test-live-update", value);
  const controller = windowController(win, push, state);
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
      const dto = { ok: true, ...state, window: plain(controller.context.liveWindowFlags) };
      if (name !== "meetingLiveStatus") push(dto);
      return dto;
    }
    return { ok: true };
  });
  globalThis.liveWindowReview = { controller, win, calls, push };
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
    await page.waitForFunction(() => document.querySelector("#liveAlwaysOnTop").checked && innerWidth === 640);
    assert.equal(await application.evaluate(() => globalThis.liveWindowReview.win.isAlwaysOnTop()), true);
    await page.screenshot({ path: path.join(directory, "floating-native.png") });
    await page.locator("#liveAlwaysOnTop").uncheck();
    await page.waitForFunction(() => !document.querySelector("#liveAlwaysOnTop").checked);
    await page.locator("#liveCompact").click();
    await page.waitForFunction(() => innerWidth === 420);
    assert.equal(await application.evaluate(() => globalThis.liveWindowReview.win.isAlwaysOnTop()), false);
    await page.locator("#livePause").click();
    await page.waitForFunction(() => document.querySelector("#livePause").textContent === "继续录制");
    await application.evaluate(() => {
      const { controller, push } = globalThis.liveWindowReview;
      Object.assign(controller.state, { title: "很长的会议标题".repeat(25), previewText: "" });
      push({ ...controller.state, window: plainFlags(controller.context.liveWindowFlags) });
      function plainFlags(flags) { return { floating: flags.floating, compact: flags.compact, alwaysOnTop: flags.alwaysOnTop }; }
    });
    const compactHeight = await page.locator("#liveRaw").evaluate(element => element.clientHeight);
    await application.evaluate(() => globalThis.liveWindowReview.win.setSize(620, 560));
    await page.waitForFunction(() => innerWidth === 620 && innerHeight === 560);
    const expandedCompactHeight = await page.locator("#liveRaw").evaluate(element => element.clientHeight);
    assert(expandedCompactHeight > compactHeight + 100,
      `compact transcript grows with native window (${compactHeight} -> ${expandedCompactHeight})`);
    await page.screenshot({ path: path.join(directory, "compact-native-expanded.png") });
    await application.evaluate(() => globalThis.liveWindowReview.win.setSize(360, 240));
    await page.waitForFunction(() => innerWidth === 360);
    for (const id of ["liveAlwaysOnTop", "liveCompact", "liveDetail", "livePause", "liveStop"]) {
      const rect = await page.locator(`#${id}`).boundingBox();
      assert(rect && rect.y >= 0 && rect.y + rect.height <= 240 && rect.x + rect.width <= 360, `${id} remains in the smallest window`);
    }
    assert.equal(await page.locator("#liveRaw").isVisible(), true);
    await page.screenshot({ path: path.join(directory, "compact-native-360.png") });
    await page.locator("#livePause").click();
    await page.waitForFunction(() => document.querySelector("#livePause").textContent === "暂停");
    await page.locator("#liveAlwaysOnTop").check();
    await page.waitForFunction(() => document.querySelector("#liveAlwaysOnTop").checked);
    await page.locator("#liveDetail").click();
    await page.waitForFunction(() => !document.querySelector("#meetingPanel").classList.contains("live-floating") && innerWidth > 1130);
    const restored = await application.evaluate(() => ({ bounds: globalThis.liveWindowReview.win.getNormalBounds(), maximized: globalThis.liveWindowReview.win.isMaximized(), pin: globalThis.liveWindowReview.win.isAlwaysOnTop() }));
    assert.deepEqual(restored.bounds, saved.bounds);
    assert.equal(restored.maximized, saved.maximized);
    assert.equal(restored.pin, false);
    await page.screenshot({ path: path.join(directory, "detailed-restored-native.png") });
    await page.locator("#liveFloat").click();
    await page.waitForFunction(() => innerWidth === 640);
    await page.locator("#liveStop").click();
    await page.waitForFunction(() => document.querySelector("#liveStatus").textContent === "已完成");
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
