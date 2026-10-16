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
    showInactive() { this.visible = true; }
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

  const originalLoad = Window.prototype.loadFile;
  for (const outcome of ["cancel", "load-failure"]) {
    let finishLoad, rejectLoad;
    Window.prototype.loadFile = () => new Promise((resolve, reject) => { finishLoad = resolve; rejectLoad = reject; });
    const cold = createDictationPreview({ ...options, platform: "win32" });
    cold.setReducedMotion(false);
    const shown = cold.show({ reposition: true });
    const warming = windows.at(-1);
    assert.equal(warming.opacity, 0);
    assert.equal(cold.isVisible(), false, "first-paint initialization cannot be focused as a usable popup");
    if (outcome === "cancel") {
      let hiddenCallback = false;
      const hidden = cold.hide(() => { hiddenCallback = true; });
      finishLoad();
      assert.equal(await shown, false);
      assert.equal(await hidden, true);
      assert.equal(hiddenCallback, true, "late page load must not cancel the close callback");
    } else {
      rejectLoad(new Error("fixture page unavailable"));
      assert.equal(await shown, false);
    }
    assert.equal(warming.visible, false, "cancelled or failed cold load leaves no native overlay");
    cold.dispose();
  }
  Window.prototype.loadFile = originalLoad;

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
    dictationPreview: { isActive: () => true, isVisible: () => false,
      hide(callback) { completeHide = callback; return Promise.resolve(true); } },
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
    await page.evaluate(() => window.mimoInput.setReducedMotion(false));
    await application.evaluate(() => {
      globalThis.fixtureColdPreparation = [];
      globalThis.fixtureHiddenMainRaises = [];
      const main = globalThis.fixtureApp.main(), moveTop = main.moveTop.bind(main);
      main.moveTop = () => {
        if (!main.isVisible()) globalThis.fixtureHiddenMainRaises.push(globalThis.fixtureApp.state().windowMode);
        return moveTop();
      };
      const preview = globalThis.fixtureApp.preview(), originalShow = preview.show.bind(preview);
      preview.show = (...args) => {
        const cold = !preview.getWindow();
        const result = originalShow(...args);
        if (cold) {
          const popup = preview.getWindow(), execute = popup.webContents.executeJavaScript.bind(popup.webContents);
          popup.webContents.executeJavaScript = (...parameters) => {
            const pending = execute(...parameters);
            if (!parameters[0].includes("dictationMotion?.prepare(")) return pending;
            return pending.then(async ready => {
              const width = await execute('document.querySelector(".shell").getBoundingClientRect().width');
              globalThis.fixtureColdPreparation.push({ ready, width });
              return ready;
            });
          };
        }
        return result;
      };
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
    const coldFrames = await application.evaluate(() => globalThis.fixtureColdPreparation);
    assert.equal(coldFrames.length, 1);
    assert.equal(coldFrames[0].ready, true, "first invocation prepares the bubble instead of timing out before its first native paint");
    assert.ok(coldFrames[0].width <= 13, "first invocation is prepared as a small bubble");
    assert.deepEqual(await application.evaluate(() => globalThis.fixtureHiddenMainRaises), [],
      "preparing the cold popup never raises the hidden main window with its stale Home pixels");
    assert.deepEqual(await popup.locator(".status-panel").evaluate(node => ({
      opacity: getComputedStyle(node).opacity, animation: getComputedStyle(node).animationName
    })), { opacity: "1", animation: "none" }, "completed bubble never restarts the status fade");
    console.log("PASS cold native bubble preparation and stable text opacity after expansion");
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
    await page.evaluate(() => window.mimoInput.setReducedMotion(false));
    await application.evaluate(() => {
      globalThis.fixtureFirstFrames = [];
      globalThis.fixtureMainExposures = [];
      const popup = globalThis.fixtureApp.preview().getWindow(), main = globalThis.fixtureApp.main();
      let prepared = false;
      const execute = popup.webContents.executeJavaScript.bind(popup.webContents);
      popup.webContents.executeJavaScript = (...args) => {
        const result = execute(...args);
        if (!args[0].includes("dictationMotion?.prepare(")) return result;
        prepared = false;
        return result.then(value => { prepared = value === true; return value; });
      };
      const show = popup.show.bind(popup);
      popup.show = () => {
        if (!popup.isVisible()) globalThis.fixtureFirstFrames.push({ prepared, opacity: popup.getOpacity() });
        show();
      };
      main.on("resize", () => {
        if (main.isVisible() && globalThis.fixtureApp.state().windowMode === "recording")
          globalThis.fixtureMainExposures.push(main.getBounds());
      });
      main.on("show", () => {
        if (globalThis.fixtureApp.state().windowMode === "recording" && main.getOpacity() > 0)
          globalThis.fixtureMainExposures.push(main.getBounds());
      });
    });
    await popup.evaluate(() => {
      window.bubbleObservations = [];
      window.preparedBubbleFrames = [];
      window.originalPrepare = window.dictationMotion.prepare;
      window.dictationMotion.prepare = async value => {
        await new Promise(resolve => setTimeout(resolve, 100));
        const ready = await window.originalPrepare(value);
        const shell = document.querySelector(".shell"), rect = shell.getBoundingClientRect();
        window.preparedBubbleFrames.push({ width: rect.width, height: rect.height,
          states: shell.getAnimations().map(a => a.playState), ready });
        return ready;
      };
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (frames, options) {
        if (this.classList.contains("shell")) {
          window.bubbleObservations.push({ frames, options, width: innerWidth, height: innerHeight });
        }
        return animate.call(this, frames, options);
      };
    });
    const anchor = await application.evaluate(async ({ BrowserWindow, screen }) => {
      const area = screen.getPrimaryDisplay().workArea;
      const target = new BrowserWindow({ x: area.x + 80, y: area.y + 70, width: 720, height: 460,
        frame: false, show: false, backgroundColor: "#ffffff", webPreferences: { sandbox: true } });
      globalThis.fixtureExternalInput = target;
      const editor = '<div role="group">'.repeat(40) +
        '<div id="input" contenteditable="true" role="textbox" aria-label="Synthetic editor" style="width:400px;min-height:140px"><p>Synthetic input only</p></div>' + '</div>'.repeat(40);
      await target.loadURL("data:text/html," + encodeURIComponent(`<html lang="en"><body style="margin:0"><div style="position:absolute;left:120px;top:160px">${editor}</div><script>document.getElementById("input").focus()</script></body></html>`));
      target.show(); target.focus();
      const handle = target.getNativeWindowHandle().readBigUInt64LE().toString();
      await globalThis.fixtureApp.focusSyntheticTarget(handle);
      const context = await globalThis.fixtureApp.inputContext();
      if (!["caret", "input"].includes(context?.source)) throw new Error("synthetic_editor_not_located");
      const expected = globalThis.fixtureApp.placement(context, { width: 340, height: 116 }, screen);
      globalThis.fixtureApp.showAndStart();
      return { expected, handle };
    });
    await page.waitForFunction(() => isRecording);
    await popup.waitForFunction(() => window.bubbleObservations.length > 0 && !document.body.classList.contains("dictation-entering"));
    const bubble = await popup.evaluate(() => window.bubbleObservations.at(-1));
    assert.deepEqual([bubble.width, bubble.height], [340, 116]);
    assert.equal(bubble.frames[0].transform, "scale(0.035, 0.14)");
    assert.equal(bubble.options.duration, 240);
    const positioned = await application.evaluate(() => ({
      popup: globalThis.fixtureApp.preview().getWindow().getBounds(),
      target: globalThis.fixtureApp.state().targetWindowHandle
    }));
    assert.deepEqual(positioned.popup, anchor.expected, "actual recording popup must retain the native editor anchor after renderer startup/focus");
    assert.equal(positioned.target, anchor.handle, "positioning preserves the external paste target");
    console.log("PASS actual recording popup expands from a deep external rich editor, settles at its anchor with fixed geometry and preserves the paste target");
    await popup.keyboard.press("Escape");
    await page.waitForFunction(() => !isRecording && currentWindowMode === "compact");
    await popup.evaluate(() => {
      window.cancelledDuringBubble = false;
      window.dictationPreview.onDictationEntrance(value => {
        if (!value) return;
        setTimeout(() => {
          window.cancelledDuringBubble = document.body.classList.contains("dictation-entering");
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        }, 60);
      });
    });
    await application.evaluate(async () => {
      await globalThis.fixtureApp.focusSyntheticTarget(globalThis.fixtureExternalInput.getNativeWindowHandle().readBigUInt64LE().toString());
      globalThis.fixtureApp.showAndStart();
    });
    await popup.waitForFunction(() => window.cancelledDuringBubble);
    await page.waitForFunction(() => !isRecording && !isStartingRecording && currentWindowMode === "compact");
    assert.equal(await application.evaluate(() => globalThis.fixtureApp.preview().isVisible()), false);
    console.log("PASS Escape during bubble entrance cancels the actual recording without waiting for animation completion");
    await popup.evaluate(() => {
      window.dictationMotion.prepare = window.originalPrepare;
      window.dictationPreview.onDictationEntrance(value => { if (value?.phase === "play") window.dictationPreview.command("cancel"); });
    });
    await application.evaluate(() => globalThis.fixtureApp.showHome());
    await page.waitForFunction(() => document.body.classList.contains("home-mode"));
    await application.evaluate(() => globalThis.fixtureApp.showAndStart());
    await page.waitForFunction(() => !isRecording && !isStartingRecording && currentWindowMode === "compact");
    await application.evaluate(() => { globalThis.fixtureApp.showHome(); globalThis.fixtureApp.main().minimize(); });
    await page.waitForFunction(() => document.body.classList.contains("home-mode"));
    await application.evaluate(() => globalThis.fixtureApp.showAndStart());
    await page.waitForFunction(() => !isRecording && !isStartingRecording && currentWindowMode === "compact");
    const reveals = await application.evaluate(async () => ({
      frames: globalThis.fixtureFirstFrames, exposures: globalThis.fixtureMainExposures
    }));
    assert.ok(reveals.frames.length >= 4);
    for (const frame of reveals.frames) {
      assert.equal(frame.prepared, true, "native show must wait for the renderer's first-frame acknowledgement");
      assert.equal(frame.opacity, 0, "the native surface starts invisible before playing the prepared bubble");
    }
    const preparedFrames = await popup.evaluate(() => window.preparedBubbleFrames);
    assert.equal(preparedFrames.length, 2);
    for (const frame of preparedFrames) {
      assert.equal(frame.ready, true);
      assert.ok(frame.width <= 13 && frame.height <= 17, "native reveal starts at the tiny bubble, never the old full popup");
      assert.deepEqual(frame.states, ["paused"], "native show waits for the painted, paused first frame even when the renderer is delayed");
    }
    assert.deepEqual(reveals.exposures, [], "Home never exposes the old compact main surface while preparing the display");
    console.log("PASS actual native first reveal is a paused tiny bubble under renderer delay, repeated starts and visible Home transitions");
    await application.evaluate(() => { globalThis.fixtureExternalInput.destroy(); });
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
  mod._compile(fs.readFileSync(filename, "utf8") + `
globalThis.fixtureApp = { showAndStart, focusMainWindow, showHome, settingsSave: saveSettings,
  inputContext: getDictationInputContext, placement: dictationBounds,
  focusSyntheticTarget: handle => new Promise((resolve, reject) => execFile("powershell.exe", ["-NoProfile", "-File",
    path.join(__dirname, "../scripts/fixtures/dictation-input-field.ps1"), "-ForegroundHandle", handle],
    { windowsHide: true, timeout: 3000, maxBuffer: 8192 }, error => error ? reject(error) : resolve())),
  main: () => mainWindow, preview: () => dictationPreview,
  state: () => ({ windowMode, shortStartPending, captureOwner, shortcutCaptureSuspended, targetWindowHandle }) };`, filename);
} else if (require.main === module) (async () => {
  await unitTests();
  if (process.argv.includes("--electron")) await verifyNative();
})().catch(error => { console.error(error); process.exitCode = 1; });
