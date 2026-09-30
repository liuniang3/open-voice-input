"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { createTransparentPreview } = require("../src/meeting/transparent-preview");

async function unitChecks() {
  const handlers = new Map(), intervals = new Set(), children = [], patches = [], boundsChanges = [];
  let cursor = { x: -1, y: -1 }, mainVisible = true;
  const mainWindow = { isDestroyed: () => false, hide: () => { mainVisible = false; }, showInactive: () => { mainVisible = true; } };
  class Window {
    constructor(options) {
      this.options = options; this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.listeners = {}; this.loads = {}; this.sent = []; this.visible = false;
      this.url = pathToFileURL(path.resolve(__dirname, "../src/renderer/meeting-preview.html")).href;
      this.webContents = { getURL: () => this.url, send: (...data) => this.sent.push(data), once: (name, fn) => { this.loads[name] = fn; }, on() {}, setWindowOpenHandler() {} };
      children.push(this);
    }
    on(name, fn) { this.listeners[name] = fn; }
    getBounds() { return { ...this.bounds }; } setBounds(bounds) { this.bounds = { ...bounds }; }
    setAlwaysOnTop(value) { this.top = value; } isDestroyed() { return Boolean(this.dead); }
    showInactive() { this.visible = true; } hide() { this.visible = false; } destroy() { this.dead = true; this.listeners.closed?.(); }
    loadFile() { return Promise.resolve(); }
  }
  function create(platform = "win32") {
    return createTransparentPreview({ BrowserWindow: Window, ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
      screen: { getCursorScreenPoint: () => cursor }, mainWindow, platform, onPresentation: input => { patches.push(input); }, onBounds: b => boundsChanges.push(b),
      schedule: fn => { intervals.add(fn); return fn; }, cancel: fn => { intervals.delete(fn); } });
  }
  const service = create();
  const state = { sessionId: "a", floating: true, opacity: 0, alwaysOnTop: true, fontSize: 20, previewText: "本次预览文字",
    bounds: { x: 50, y: 60, width: 360, height: 180 } };
  service.update(state);
  const win = children[0], event = { sender: win.webContents, senderFrame: { url: win.url } };
  assert.equal(mainVisible, true, "main window remains visible until the isolated preview is ready");
  assert.equal(win.options.transparent, true); assert.equal(win.options.webPreferences.sandbox, true);
  win.loads["did-finish-load"]();
  assert.equal(mainVisible, false); assert.equal(win.visible, true); assert.equal(win.top, true);
  mainVisible = true; assert.equal(service.reveal(), true); assert.equal(mainVisible, false, "tray recall cannot leave the opaque main window underneath the transparent view");
  const invoke = (name, payload, source = event) => handlers.get(`meeting:preview:${name}`)(source, payload);
  assert.equal((await invoke("ready")).value.text, "本次预览文字");
  assert.equal((await invoke("ready", null, { sender: {}, senderFrame: { url: win.url } })).ok, false);
  assert.equal((await invoke("presentation", { opacity: -1 })).ok, false);
  assert.equal((await invoke("presentation", { opacity: 0, apiKey: "not-forwarded" })).ok, true);
  assert.deepEqual(patches.at(-1), { opacity: 0 });
  cursor = { x: 100, y: 100 }; for (const poll of intervals) poll();
  assert.equal(win.sent.at(-1)[1].hovered, true);
  cursor = { x: 500, y: 500 }; for (const poll of intervals) poll();
  assert.equal(win.sent.at(-1)[1].hovered, false);
  service.update({ previewText: "", rawText: "历史段落。\n刚确认的句子。" });
  assert.equal((await invoke("ready")).value.text, "刚确认的句子。");
  await invoke("resize", { edge: "se", phase: "start" });
  cursor = { x: 700, y: 600 }; await invoke("resize", { edge: "se", phase: "move" });
  assert.deepEqual(boundsChanges.at(-1), { x: 50, y: 60, width: 560, height: 280 });
  await invoke("restore"); assert.deepEqual(patches.at(-1), { restoreNormal: true });
  service.update({ opacity: .4 }); assert.equal(mainVisible, true); assert.equal(win.visible, false); assert.equal(intervals.size, 0);
  assert.equal(service.reveal(), false);
  service.update(state); service.suspend(); assert.equal(win.visible, false); service.resume(); assert.equal(win.visible, true);
  service.update({ sessionId: "b", previewText: "", rawText: "" }); assert.equal((await invoke("ready")).value.text, "");
  service.dispose(); assert.equal(handlers.size, 0); assert.equal(win.dead, true);
  const mac = create("darwin"); mac.update(state); assert.equal(children.length, 1, "macOS uses its existing transparent native window"); mac.dispose();
  console.log("Transparent preview isolation, hover recovery, resize, session boundaries and macOS gate tests passed.");
}

async function nativeChecks() {
  const { _electron } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const app = await _electron.launch({ executablePath: require("electron"), args: [path.join(__dirname, "test-meeting-live-window-ui.js"), "--electron-fixture"] });
  const directory = path.resolve(__dirname, "../output/playwright/meeting-transparent-preview"); fs.mkdirSync(directory, { recursive: true });
  try {
    const main = await app.firstWindow(); await main.waitForFunction(() => window.MeetingLiveUi && window.applyWindowMode);
    await main.evaluate(async () => { window.applyWindowMode("meeting"); await window.MeetingLiveUi.open(); });
    await app.evaluate(async ({ BrowserWindow }) => {
      const backdrop = new BrowserWindow({ x: 150, y: 150, width: 360, height: 180, frame: false, show: true, backgroundColor: "#12ab67", webPreferences: { sandbox: true } });
      await backdrop.loadURL('data:text/html,<html style="background:%2312ab67"><body></body></html>');
      backdrop.setAlwaysOnTop(true); backdrop.moveTop();
      globalThis.fixtureBackdrop = backdrop; globalThis.fixturePreviewCursor = { x: -10000, y: -10000 };
      const { controller, win } = globalThis.liveWindowReview;
      controller.invoke({ floating: true, opacity: 0 });
      win.setBounds({ x: 150, y: 150, width: 360, height: 180 });
    });
    const preview = await app.waitForEvent("window", { predicate: page => page.url().endsWith("meeting-preview.html"), timeout: 10000 });
    await preview.waitForFunction(() => document.getElementById("previewText").textContent.length > 0);
    await preview.mouse.move(-10, -10);
    assert.equal(await preview.locator("#previewRestore").isVisible(), false);
    assert.equal(await preview.locator("#previewOpacity").isVisible(), false);
    assert.equal(await app.evaluate(() => globalThis.liveWindowReview.win.isVisible()), false);
    // Crop only the synthetic green backdrop; no other desktop content is saved.
    const capture = await app.evaluate(async ({ desktopCapturer, screen }) => {
      const bounds = { x: 150, y: 150, width: 360, height: 180 }, display = screen.getDisplayMatching(bounds);
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: Math.round(display.bounds.width * display.scaleFactor), height: Math.round(display.bounds.height * display.scaleFactor) } });
      const source = sources.find(s => s.display_id === String(display.id)) || sources[0];
      const size = source.thumbnail.getSize(), sx = size.width / display.bounds.width, sy = size.height / display.bounds.height;
      const crop = source.thumbnail.crop({ x: Math.round((bounds.x - display.bounds.x) * sx), y: Math.round((bounds.y - display.bounds.y) * sy), width: Math.round(bounds.width * sx), height: Math.round(bounds.height * sy) });
      const bytes = crop.toBitmap(), offset = (Math.round(145 * sy) * crop.getSize().width + Math.round(280 * sx)) * 4;
      return { pixel: [...bytes.subarray(offset, offset + 4)], png: crop.toPNG().toString("base64") };
    });
    fs.writeFileSync(path.join(directory, "native-idle-zero-background.png"), Buffer.from(capture.png, "base64"));
    assert.deepEqual(capture.pixel, [103, 171, 18, 255], "zero opacity must reveal the exact backdrop pixel, not acrylic or a solid surface");
    await app.evaluate(() => { globalThis.fixturePreviewCursor = { x: 250, y: 240 }; });
    await preview.waitForFunction(() => document.getElementById("previewSurface").classList.contains("is-hovered"));
    assert.equal(await preview.locator("#previewRestore").isVisible(), true);
    assert.equal(await preview.locator("#previewFont").isVisible(), true);
    await preview.locator("#previewFont").fill("22");
    await preview.waitForFunction(() => getComputedStyle(document.getElementById("previewText")).fontSize === "22px");
    await preview.screenshot({ path: path.join(directory, "native-hover-default-background.png") });
    await app.evaluate(() => { globalThis.fixturePreviewCursor = { x: -10000, y: -10000 }; });
    await preview.waitForFunction(() => !document.getElementById("previewSurface").classList.contains("is-hovered"));
    await preview.mouse.move(-10, -10);
    assert.equal(await preview.locator("#previewRestore").isVisible(), false);
    assert.equal(await app.evaluate(() => globalThis.liveWindowReview.controller.context.livePresentation.opacity), 0);
    await app.evaluate(() => { globalThis.fixturePreviewCursor = { x: 250, y: 240 }; });
    await preview.waitForFunction(() => document.getElementById("previewSurface").classList.contains("is-hovered"));
    await preview.locator("#previewRestore").click();
    await main.waitForFunction(() => !document.getElementById("meetingPanel").classList.contains("live-minimal"));
    assert.equal(await app.evaluate(() => globalThis.liveWindowReview.win.isVisible()), true);
    assert.equal(await main.locator("#liveFontSize").inputValue(), "22");
    console.log(`Native transparent compositing, hover controls and restore passed; screenshots: ${directory}`);
  } finally { await app.close(); }
}

if (require.main === module) (async () => { await unitChecks(); if (process.argv.includes("--electron")) await nativeChecks(); })()
  .catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { unitChecks, nativeChecks };
