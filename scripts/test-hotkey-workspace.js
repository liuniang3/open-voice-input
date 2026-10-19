"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const shortcut = "CommandOrControl+Alt+Shift+F9";
const send = action => new Promise((resolve, reject) => execFile("powershell.exe", ["-NoProfile", "-File",
  path.join(__dirname, "fixtures/send-workspace-hotkey.ps1"), "-Action", action],
  { windowsHide: true, timeout: 8000, maxBuffer: 4096 }, error => error ? reject(Error("native hotkey sender failed")) : resolve()));
async function verifyNative() {
  if (process.platform !== "win32") return;
  const { _electron } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|MIMO|QWEN|DASHSCOPE|FUN_ASR|CLEANER|OSS|OVI_|ELECTRON_RUN_AS_NODE/i.test(key)));
  const application = await _electron.launch({ executablePath: require("electron"),
    args: [path.join(__dirname, "test-dictation-preview.js"), "--electron-app-fixture",
      fs.mkdtempSync(path.join(os.tmpdir(), "ovi-workspace-hotkey-"))], env });
  try {
    const page = await application.firstWindow();
    await page.waitForFunction(() => document.getElementById("homeTodayCount").textContent === "0");
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const audio = new AudioContext({ sampleRate: 16000 }), destination = audio.createMediaStreamDestination();
        const tone = audio.createOscillator(), gain = audio.createGain(); gain.gain.value = 0.01;
        tone.connect(gain); gain.connect(destination); tone.start(); await audio.resume();
        window.generatedMicrophones ||= []; window.generatedMicrophones.push({ audio, tone });
        return destination.stream;
      };
    });
    await application.evaluate(async ({ ipcMain }) => {
      globalThis.workspaceStarts = 0;
      const main = fixtureApp.main(), send = main.webContents.send.bind(main.webContents);
      main.webContents.send = (channel, ...args) => { if (channel === "hotkey-record") workspaceStarts++; return send(channel, ...args); };
      for (const name of ["voice:segment:transcribe", "voice:clean-text", "input:inject"]) ipcMain.removeHandler(name);
      ipcMain.handle("voice:segment:transcribe", () => "Synthetic transcription.");
      ipcMain.handle("voice:clean-text", (_event, value) => value.rawText);
      ipcMain.handle("input:inject", () => { throw Error("native workspace tests must cancel instead of entering text"); });
      await fixtureApp.settingsSave({ hotkey: "CommandOrControl+Alt+Shift+F9", transcriptionMode: "fast", asrMode: "batch",
        asrProvider: "mimo", asrProfiles: { "mimo-v2.5-asr": { provider: "mimo", mode: "batch" } } });
    });
    const registered = () => page.waitForFunction(shortcut => window.mimoInput.getStatus().then(value => value.registeredHotkeys.includes(shortcut)), shortcut);
    await registered();
    for (const mode of ["home", "settings"]) {
      for (const state of ["visible", "minimized", "tray", "editor-minimized", "editor-blurred", "editor-hidden"]) {
        if (mode === "home" && state.startsWith("editor")) continue;
        await application.evaluate((_electron, mode) => mode === "home" ? fixtureApp.showHome() : fixtureApp.showSettings("asr"), mode);
        await page.waitForFunction(mode => currentWindowMode === mode, mode);
        if (state.startsWith("editor")) {
          await page.locator("#hotkeyInput").click();
          await page.waitForFunction(() => activeHotkeyCapture?.ready === true);
          assert.equal(await application.evaluate(() => fixtureApp.state().shortcutCaptureSuspended), true);
          assert.equal((await page.evaluate(() => window.mimoInput.getStatus())).registeredHotkeys.length, 0);
        }
        if (state.endsWith("blurred")) {
          await application.evaluate(async ({ BrowserWindow }) => {
            globalThis.workspaceExternal = new BrowserWindow({ width: 500, height: 250, show: false });
            await workspaceExternal.loadURL("data:text/html,<textarea autofocus></textarea>");
            workspaceExternal.show(); workspaceExternal.focus();
            await fixtureApp.focusSyntheticTarget(workspaceExternal.getNativeWindowHandle().readBigUInt64LE().toString());
          });
          await page.waitForFunction(() => activeHotkeyCapture === null);
        } else if (state.endsWith("minimized")) {
          await application.evaluate(() => fixtureApp.main().minimize());
          await application.evaluate(() => { if (!fixtureApp.main().isMinimized()) throw Error("test window did not minimize"); });
        } else if (state === "tray" || state.endsWith("hidden")) {
          await application.evaluate(() => fixtureApp.main().close());
          await page.waitForFunction(() => window.mimoInput.getStatus().then(value => value.windowMode === currentWindowMode));
          await application.evaluate(async () => {
            const limit = Date.now() + 2000;
            while (fixtureApp.main().isVisible() && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 20));
            if (fixtureApp.main().isVisible()) throw Error("test window did not hide");
          });
        }
        await registered();
        assert.equal(await application.evaluate(() => fixtureApp.state().shortcutCaptureSuspended), false);
        const starts = await application.evaluate(() => workspaceStarts);
        await send("invoke");
        try { await page.waitForFunction(() => isRecording && recordingSampleCount > 0, undefined, { timeout: 8000 }); }
        catch (error) {
          console.error(await application.evaluate(() => ({ state: fixtureApp.state(), starts: workspaceStarts,
            minimized: fixtureApp.main().isMinimized(), visible: fixtureApp.main().isVisible() })));
          console.error(await page.evaluate(() => ({ mode: currentWindowMode, recording: isRecording, starting: isStartingRecording,
            capture: activeHotkeyCapture && { kind: activeHotkeyCapture.kind, ready: activeHotkeyCapture.ready },
            active: document.activeElement?.id })));
          throw error;
        }
        const popup = application.windows().find(win => win.url().endsWith("dictation-preview.html"));
        assert.ok(popup);
        assert.equal(await application.evaluate(() => fixtureApp.preview().isVisible()), true);
        assert.equal(await application.evaluate(() => workspaceStarts), starts + 1, "one shortcut press starts one recording");
        await send("cancel");
        await page.waitForFunction(() => !isRecording && !isStartingRecording && currentWindowMode === "compact");
        await page.waitForFunction(() => window.mimoInput.getStatus().then(value => value.windowMode === "compact"));
        await application.evaluate(() => { if (globalThis.workspaceExternal) { workspaceExternal.destroy(); globalThis.workspaceExternal = null; } });
        console.log("PASS real registered Windows hotkey: " + mode + " / " + state + ", visible popup, PCM capture and Escape cancellation");
      }
    }
    await page.evaluate(async () => {
      for (const microphone of window.generatedMicrophones || []) { microphone.tone.stop(); await microphone.audio.close(); }
    });
  } finally { await application.close(); }
}
if (require.main === module) (async () => {
  if (process.argv.includes("--electron")) await verifyNative();
  else console.log("Native workspace hotkey regression available with --electron; shared routing checks run in test-settings-shortcuts.js");
})().catch(error => { console.error(error); process.exitCode = 1; });
