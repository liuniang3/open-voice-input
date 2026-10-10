"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { EventEmitter } = require("node:events");
const { pathToFileURL } = require("node:url");
const { createDictationPreview } = require("../src/dictation-preview");
const root = path.resolve(__dirname, "..");

async function unitTests() {
  const ipcMain = new EventEmitter(), handlers = new Map(), commands = [], windows = [];
  ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
  ipcMain.removeHandler = channel => handlers.delete(channel);
  const trusted = {}, event = { sender: trusted };
  const mainWindow = { hidden: false, isDestroyed: () => false, hide() { this.hidden = true; },
    show() { this.hidden = false; }, focus() {}, getBounds: () => ({ x: 80, y: 90, width: 340, height: 116 }) };
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.visible = false; this.destroyed = false; this.sent = []; windows.push(this);
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.getURL = () => pathToFileURL(path.join(root, "src/renderer/dictation-preview.html")).href;
      this.webContents.send = (...args) => this.sent.push(args);
    }
    loadFile() { return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    setOpacity(value) { this.opacity = value; }
    setBounds(value) { this.bounds = value; }
    destroy() { this.destroyed = true; }
  }
  const options = { BrowserWindow: Window, ipcMain, mainWindow, authorized: e => e.sender === trusted,
    onCommand: value => commands.push(value) };
  assert.equal(createDictationPreview({ ...options, platform: "darwin" }), null);
  const preview = createDictationPreview({ ...options, platform: "win32" });
  assert.equal(windows.length, 0, "normal startup does not create a hidden recording renderer");
  assert.equal(await preview.show(), true);
  const win = windows[0];
  assert.equal(mainWindow.hidden && preview.isVisible(), true);
  win.bounds = { x: 500, y: 450, width: 340, height: 116 };
  await preview.show();
  assert.equal(win.bounds.x, 500, "repeated invocation retains a manually moved visible popup");
  await preview.show({ reposition: true });
  assert.deepEqual(win.bounds, mainWindow.getBounds(), "a fresh capture reanchors even during the previous fade-out");
  assert.equal(win.options.transparent, true); assert.equal(win.options.thickFrame, false);
  assert.equal(win.options.hasShadow, false); assert.equal(win.options.backgroundMaterial, "none");
  assert.equal(win.options.roundedCorners, false, "only the 18px per-pixel CSS radius owns the corners");
  assert.equal(win.options.webPreferences.sandbox, true);
  const text = "完整转写内容。".repeat(2000) + "保留最后一句。";
  const state = { kind: "recording", title: "", detail: text, preview: true };
  ipcMain.emit("dictation:preview:update", event, state);
  assert.equal(win.sent.at(-1)[1].detail, text, "the display channel never truncates the authoritative transcript");
  const count = win.sent.length;
  ipcMain.emit("dictation:preview:update", { sender: {} }, state);
  ipcMain.emit("dictation:preview:update", event, { ...state, kind: "invalid" });
  assert.equal(win.sent.length, count);
  ipcMain.emit("dictation:preview:bands", event, Array(36).fill(0.5));
  assert.equal(win.sent.at(-1)[0], "dictation:preview:spectrum");
  const bandCount = win.sent.length;
  for (const bands of [[], Array(36).fill(NaN), Array(36).fill(1.1)]) ipcMain.emit("dictation:preview:bands", event, bands);
  assert.equal(win.sent.length, bandCount);
  ipcMain.emit("dictation:preview:update", event, { kind: "transcribing", title: "正在整理", detail: "", preview: false });
  const processingCount = win.sent.length;
  ipcMain.emit("dictation:preview:bands", event, Array(36).fill(0.5));
  assert.equal(win.sent.length, processingCount, "late spectrum messages cannot restart bars during cleanup");
  ipcMain.emit("dictation:preview:update", event, state);
  const popupEvent = { sender: win.webContents, senderFrame: { url: win.webContents.getURL() } };
  ipcMain.emit("dictation:preview:command", popupEvent, "stop");
  ipcMain.emit("dictation:preview:command", popupEvent, "cancel");
  ipcMain.emit("dictation:preview:command", event, "cancel");
  ipcMain.emit("dictation:preview:command", popupEvent, "settings:get");
  assert.deepEqual(commands, ["stop", "cancel"], "the display cannot access keys, providers or arbitrary IPC");
  await preview.hide();
  ipcMain.emit("dictation:preview:command", popupEvent, "stop");
  assert.deepEqual(commands, ["stop", "cancel"]);
  assert.equal(await preview.show(), true);
  assert.equal(win.sent.at(-1)[1].detail, "", "a new invocation cannot display the previous transcript");
  win.webContents.emit("render-process-gone");
  assert.equal(mainWindow.hidden, false, "a failed display returns to the existing capture renderer");
  preview.dispose();
  assert.equal(win.destroyed, true); assert.equal(ipcMain.eventNames().length, 0); assert.equal(handlers.size, 0);
  assert.equal(await preview.show(), false);

  const previewSource = fs.readFileSync(path.join(root, "src/dictation-preview.js"), "utf8");
  assert.doesNotMatch(previewSource, /applyWindowsDictationGlass|SetWindowCompositionAttribute|setShape|setOpacity\(0\.[0-9]+\)/,
    "the display must not reintroduce native rectangular blur or fade the entire window to simulate glass");
  const main = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  assert.match(main, /backgroundThrottling: false/);
  assert.match(main, /visualEffectState: "active"/);
  assert.match(main, /mainWindow\.isVisible\(\) \|\| dictationPreview\?\.isVisible\(\)/);
  const vm = require("node:vm"), hides = [];
  let completeHide;
  const context = { mainWindow: { isDestroyed: () => false, hide: () => hides.push(true) },
    windowFocusRevision: 0, windowMode: "recording", unregisterRecordingKeyFallbacks() {},
    dictationPreview: { isVisible: () => true, hide(callback) { completeHide = callback; return Promise.resolve(true); } },
    setWindowMode(value) { context.windowMode = value; } };
  vm.runInNewContext(main.slice(main.indexOf("function hideWindow("), main.indexOf("function sendWhenLoaded(")), context);
  await context.hideWindow();
  context.windowMode = "settings"; context.windowFocusRevision++; completeHide();
  assert.equal(context.windowMode, "settings"); assert.equal(hides.length, 0,
    "a late display fade cannot close a newly opened workspace");
  console.log("PASS Windows per-pixel transparent display, no native rectangular material, untrusted IPC rejection, complete text, key forwarding, crash fallback, credential isolation and macOS native-material contract");
}

async function verifyNative() {
  if (process.platform !== "win32") return;
  const { _electron } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|MIMO|QWEN|DASHSCOPE|FUN_ASR|CLEANER|OSS|OVI_/i.test(key)));
  const application = await _electron.launch({ executablePath: require("electron"),
    args: [__filename, "--electron-app-fixture", fs.mkdtempSync(path.join(os.tmpdir(), "ovi-dictation-glass-"))], env });
  try {
    const page = await application.firstWindow();
    await page.waitForFunction(() => document.getElementById("homeTodayCount").textContent === "0");
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const audio = new AudioContext({ sampleRate: 16000 }), destination = audio.createMediaStreamDestination();
        const tone = audio.createOscillator(), gain = audio.createGain(); gain.gain.value = 0.12; tone.frequency.value = 820;
        tone.connect(gain); gain.connect(destination); tone.start();
        window.testMicrophone = { audio, tone, gain, stream: destination.stream }; await audio.resume(); return destination.stream;
      };
    });
    await application.evaluate(async ({ ipcMain }) => {
      globalThis.fixtureInjected = [];
      globalThis.fixtureHotkeyEvents = [];
      globalThis.fixtureApp.main().webContents.on("before-input-event", (_event, input) => {
        globalThis.fixtureHotkeyEvents.push({ type: input.type, key: input.key, code: input.code,
          control: input.control, alt: input.alt, meta: input.meta, isAutoRepeat: input.isAutoRepeat });
      });
      for (const name of ["voice:segment:transcribe", "voice:clean-text", "input:inject"]) ipcMain.removeHandler(name);
      ipcMain.handle("voice:segment:transcribe", () => "这是完整保留的测试转写文本。".repeat(40) + "最后一句也必须保留。");
      ipcMain.handle("voice:clean-text", (_e, value) => value.rawText);
      ipcMain.handle("input:inject", (_e, value) => { globalThis.fixtureInjected.push(value); return { ok: true }; });
      await globalThis.fixtureApp.settingsSave({ transcriptionMode: "stable", asrMode: "batch",
        asrProfiles: { "mimo-v2.5-asr": { provider: "mimo", mode: "batch" } } });
      globalThis.fixtureApp.showHome();
    });
    await application.evaluate(() => {
      const wc = globalThis.fixtureApp.main().webContents;
      wc.sendInputEvent({ type: "keyDown", keyCode: "M", modifiers: ["control", "alt"] });
      wc.sendInputEvent({ type: "keyUp", keyCode: "M", modifiers: ["control", "alt"] });
    });
    try { await page.waitForFunction(() => isRecording && recordingSampleCount >= 12000, undefined, { timeout: 8000 }); }
    catch {
      throw new Error("Focused dictation did not start: " + JSON.stringify(await application.evaluate(() => ({
        state: globalThis.fixtureApp.state(), inputs: globalThis.fixtureHotkeyEvents
      }))));
    }
    const popup = application.windows().find(w => w.url().endsWith("dictation-preview.html"));
    assert.ok(popup, "the actual application uses the isolated transparent display");
    await popup.waitForFunction(() => document.getElementById("recordingSpectrum").hidden === false);
    await popup.evaluate(() => {
      window.receivedSpectrum = [];
      window.dictationPreview.onSpectrum(values => {
        window.receivedSpectrum.push({ peak: Math.max(...values), band: values.indexOf(Math.max(...values)) });
        if (window.receivedSpectrum.length > 100) window.receivedSpectrum.shift();
      });
    });
    await popup.waitForFunction(() => window.receivedSpectrum.length >= 6 && window.receivedSpectrum.at(-1).peak > 0.1);
    const initialBand = await popup.evaluate(() => window.receivedSpectrum.at(-1).band);
    await page.evaluate(() => {
      window.originalAnimationFrame = window.requestAnimationFrame;
      window.requestAnimationFrame = () => 0;
      window.testMicrophone.tone.frequency.value = 3200;
    });
    await popup.waitForFunction(initial => window.receivedSpectrum.at(-1).band > initial + 3, initialBand, { timeout: 4000 });
    await page.evaluate(() => { window.testMicrophone.gain.gain.value = 0; });
    await popup.waitForFunction(() => window.receivedSpectrum.at(-1).peak < 0.02, undefined, { timeout: 4000 });
    await page.evaluate(() => { window.testMicrophone.gain.gain.value = 0.12; window.testMicrophone.tone.frequency.value = 820; });
    await popup.waitForFunction(initial => window.receivedSpectrum.at(-1).peak > 0.1
      && Math.abs(window.receivedSpectrum.at(-1).band - initial) <= 1, initialBand, { timeout: 4000 });
    await page.evaluate(() => { window.requestAnimationFrame = window.originalAnimationFrame; });
    console.log("PASS hidden-recorder spectrum keeps changing frequency, settling to silence and recovering without animation frames");
    const longPreview = "完整保留的预览文字。".repeat(200) + "预览最后一句。";
    await page.evaluate(value => setRecordingPreview(value), longPreview);
    await popup.waitForFunction(value => document.getElementById("statusDetail").textContent === value, longPreview);
    await popup.waitForFunction(() => document.getElementById("statusDetail").scrollTop > 0);
    assert.deepEqual(await popup.evaluate(() => {
      const node = document.getElementById("statusDetail"), style = getComputedStyle(node);
      return { width: innerWidth, height: innerHeight, shadow: style.textShadow,
        border: getComputedStyle(document.querySelector(".shell")).borderTopWidth,
        fullLines: node.clientHeight % parseFloat(style.lineHeight) === 0 };
    }), { width: 340, height: 116, shadow: "none", border: "0px", fullLines: true });
    await popup.locator("#statusDetail").evaluate(node => { node.scrollTop = 0; });
    await popup.waitForFunction(() => !followTail);
    await page.evaluate(value => setRecordingPreview(value), longPreview + "新增预览。");
    await popup.waitForFunction(value => document.getElementById("statusDetail").textContent === value, longPreview + "新增预览。");
    assert.equal(await popup.locator("#statusDetail").evaluate(node => node.scrollTop), 0,
      "the native mirrored display respects manual reading without truncating text");
    await page.evaluate(() => setRecordingPreview("第一行上方不应出现白色文字阴影。"));
    await popup.waitForFunction(() => document.getElementById("statusDetail").textContent === "第一行上方不应出现白色文字阴影。");
    assert.equal(await application.evaluate(() => globalThis.fixtureApp.main().isVisible()), false);
    await application.evaluate(() => { globalThis.fixtureDictationWindow = globalThis.fixtureApp.preview().getWindow(); });
    await require("./test-dictation-window").verifyDesktopGlass(application, popup);
    await application.evaluate(() => globalThis.fixtureApp.focusMainWindow());
    await popup.keyboard.press("Enter");
    await page.waitForFunction(() => !isRecording && !isTranscribing);
    const finished = await page.evaluate(() => ({ text: resultText.value, closed: audioContext.state === "closed",
      stopped: window.testMicrophone.stream.getTracks().every(t => t.readyState === "ended") }));
    assert.equal(finished.closed && finished.stopped, true);
    assert.equal(finished.text.endsWith("最后一句也必须保留。"), true);
    assert.deepEqual(await application.evaluate(() => globalThis.fixtureInjected), [finished.text]);
    assert.equal(await application.evaluate(() => globalThis.fixtureApp.preview().isVisible()), false);
    await application.evaluate(() => globalThis.fixtureApp.showAndStart());
    await page.waitForFunction(() => isRecording);
    await popup.keyboard.press("Escape");
    await page.waitForFunction(() => !isRecording && currentWindowMode === "compact");
    assert.equal(await application.evaluate(() => globalThis.fixtureInjected.length), 1, "Escape never pastes");
    await application.evaluate(() => globalThis.fixtureApp.showHome());
    await page.waitForFunction(() => document.body.classList.contains("home-mode"));
    const restored = await application.evaluate(() => ({ visible: globalThis.fixtureApp.main().isVisible(),
      resizable: globalThis.fixtureApp.main().isResizable(), preview: globalThis.fixtureApp.preview().isVisible() }));
    assert.deepEqual(restored, { visible: true, resizable: true, preview: false });
    await page.evaluate(async () => { window.testMicrophone.tone.stop(); await window.testMicrophone.audio.close(); });
    console.log("PASS actual Windows app: transparent rounded focused/inactive/reopened display, background synthetic PCM capture and spectrum, Stable Enter complete paste, Escape cancellation and normal resizable workspace restoration; no microphone/API/credentials");
  } finally { await application.close(); }
}

if (process.versions.electron && process.argv.includes("--electron-app-fixture")) {
  const { app } = require("electron"), Module = require("node:module");
  const sandbox = process.argv[process.argv.indexOf("--electron-app-fixture") + 1];
  fs.mkdirSync(path.join(sandbox, "documents"), { recursive: true });
  app.setPath("appData", sandbox); app.setPath("documents", path.join(sandbox, "documents"));
  const filename = path.join(root, "src/main.js"), mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(fs.readFileSync(filename, "utf8") + "\nglobalThis.fixtureApp = { showAndStart, focusMainWindow, showHome, settingsSave: saveSettings, main: () => mainWindow, preview: () => dictationPreview, state: () => ({ windowMode, shortStartPending, captureOwner, shortcutCaptureSuspended }) };", filename);
} else if (require.main === module) (async () => {
  await unitTests();
  if (process.argv.includes("--electron")) await verifyNative();
})().catch(error => { console.error(error); process.exitCode = 1; });
