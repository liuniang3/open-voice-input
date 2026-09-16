"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const {
  ensureConnectionProfiles,
  migrateConnectionProfiles
} = require("../src/settings/connection-profiles");
const { validateHotkey, normalizeAccelerator } = require("../src/hotkeys/validate-hotkey");

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
    validateHotkey("Control+Alt+M", { platform: "win32", otherHotkeys: ["CommandOrControl+Alt+M"] }).code,
    "app_conflict"
  );
  assert.equal(validateHotkey("Alt+F4", { platform: "win32" }).code, "reserved");
  assert.equal(validateHotkey("Shift+Ctrl+Esc", { platform: "win32" }).code, "reserved");
  assert.equal(validateHotkey("M").code, "invalid_format");
  assert.deepEqual(validateHotkey("Ctrl+Alt+V", { platform: "win32" }), {
    ok: true,
    code: "ok",
    accelerator: "CommandOrControl+Alt+V",
    message: "快捷键可用"
  });
});

test("mac shortcuts distinguish Control from Command and reject platform reservations", () => {
  assert.equal(normalizeAccelerator("CmdOrCtrl+Alt+M", "darwin"), "Command+Alt+M");
  assert.equal(normalizeAccelerator("Ctrl+Alt+M", "darwin"), "Control+Alt+M");
  assert.equal(validateHotkey("Cmd+Q", { platform: "darwin" }).code, "reserved");
  assert.equal(validateHotkey("Command+Option+Esc", { platform: "darwin" }).code, "reserved");
  assert.equal(validateHotkey("Cmd+Alt+M", { platform: "darwin", otherHotkeys: ["CommandOrControl+Alt+M"] }).code, "app_conflict");
  assert.equal(validateHotkey("Ctrl+Alt+M", { platform: "darwin", otherHotkeys: ["Command+Alt+M"] }).ok, true);
  assert.equal(validateHotkey("Ctrl+M+V").code, "invalid_format");
});

test("live meeting defaults and destinations do not borrow active provider credentials", () => {
  const saved = { _connectionProfilesMigrated: true, asrModel: "qwen3-asr-flash",
    asrProfiles: { "qwen3-asr-flash": { apiKey: "test-only-qwen", provider: "qwen3-asr" } } };
  const next = ensureConnectionProfiles(saved);
  assert.equal(next.meetingRealtimeModel, "mimo-v2.5-asr");
  assert.equal(next.meetingRealtimeDestination, "");
  assert.equal(next.meetingFileAsrProfiles["mimo-v2.5-asr"].apiKey, "");
  const restored = ensureConnectionProfiles({ ...next, meetingRealtimeModel: "custom-model", meetingRealtimeDestination: "/chosen/session.md" });
  assert.equal(restored.meetingRealtimeModel, "custom-model");
  assert.equal(restored.meetingRealtimeDestination, "/chosen/session.md");
  assert.equal(saved.meetingRealtimeModel, undefined);
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function mainHarness(platform = "darwin") {
  const handlers = new Map();
  const appEvents = new Map();
  const events = [];
  const source = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
  const localUrl = pathToFileURL(path.join(root, "src", "renderer", "index.html")).href;
  const state = { status: "idle", recording: false, audioPaths: [] };
  const controls = { permissions: { microphone: "granted", screen: "granted", accessibility: "granted" },
    picker: { canceled: true }, state, startGate: null, stopGate: null, shutdownGate: null,
    stopError: null, startCount: 0, writes: [], opened: [], sent: [], macLoaded: 0 };
  const live = {
    status: () => state,
    start: async (input) => {
      controls.startCount += 1;
      controls.startInput = input;
      await controls.startGate?.promise;
      Object.assign(state, { sessionId: "live-1", status: "recording", recording: true,
        markdownPath: path.join(root, "output", "mock-live.md"), audioPaths: [path.join(root, "output", "mock-live.wav")] });
      return state;
    },
    stop: async () => {
      events.push("live-stop");
      await controls.stopGate?.promise;
      if (controls.stopError) throw controls.stopError;
      Object.assign(state, { recording: false, status: "stopping" });
      return state;
    },
    recover: async (input) => { events.push("recover"); controls.recoveryInput = input; return state; },
    retry: async (input) => { controls.retryInput = input; return state; },
    cleanup: async (input) => { controls.cleanupInput = input; return state; },
    shutdown: async () => { events.push("live-shutdown"); await controls.shutdownGate?.promise; events.push("live-written"); }
  };
  const capture = { store: {}, getLifecycle: () => ({ status: "idle" }),
    createAndPrepareSession: async () => ({ sessionId: "legacy-1" }),
    startMicrophone: async () => ({ ok: true }), startDual: async () => ({ ok: true }),
    pause: async () => ({ ok: true }), resume: async () => ({ ok: true }), stop: async () => ({ ok: true }),
    shutdown: async () => { events.push("capture-shutdown"); } };
  const webContents = { getURL: () => localUrl, isLoading: () => false,
    send: (...args) => controls.sent.push(args), once: () => {} };
  const win = new Proxy({ webContents, isDestroyed: () => false, isMinimized: () => false,
    isMaximized: () => false, isVisible: () => true, getBounds: () => ({ width: 500, height: 500 }) }, {
    get: (target, key) => key in target ? target[key] : () => {}
  });
  const app = { isPackaged: false, setPath: () => {}, getPath: (key) => path.join(root, "mock", key),
    requestSingleInstanceLock: () => true, whenReady: () => ({ then: (fn) => { controls.ready = fn; } }),
    on: (event, fn) => appEvents.set(event, fn), exit: () => events.push("exit") };
  const electron = { app, BrowserWindow: function () { return win; },
    clipboard: { writeText: () => {} }, dialog: { showSaveDialog: async () => controls.picker,
      showMessageBox: async () => ({ response: 1 }) },
    globalShortcut: { register: () => true, unregister: () => {}, unregisterAll: () => {} },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    Menu: { buildFromTemplate: (items) => items, setApplicationMenu: () => {} },
    protocol: { registerSchemesAsPrivileged: () => {} },
    session: { defaultSession: { setPermissionRequestHandler: (fn) => { controls.permissionRequest = fn; },
      setPermissionCheckHandler: (fn) => { controls.permissionCheck = fn; } } },
    shell: { openPath: async (file) => { controls.opened.push(file); return ""; } } };
  const mac = { requestMicrophoneAccess: async () => controls.permissions.microphone === "granted",
    requestScreenAccess: async () => { controls.screenRequested = true; controls.permissions.screen = "granted"; return true; },
    getPermissionStatus: () => controls.permissions, openPermissionSettings: async () => {},
    getForegroundApp: () => "123", pasteToApp: async (pid) => { controls.pasted = pid; } };
  const stubs = {
    electron, "node:os": { platform: () => platform },
    "node:child_process": new Proxy({}, { get: () => () => { throw new Error("native processes forbidden in test"); } }),
    "node:fs/promises": { mkdir: async () => {}, writeFile: async (...args) => controls.writes.push(args),
      realpath: async (file) => controls.canonical || file, lstat: async () => ({ isFile: () => true }) },
    "./runtime-log": { createRuntimeLogWriter: () => ({ enqueue: () => {}, close: async () => {} }) },
    "./settings/connection-profiles": { ensureConnectionProfiles },
    "./hotkeys/validate-hotkey": { validateHotkey, normalizeAccelerator },
    "./meeting": { createMeetingCaptureService: () => capture,
      createMeetingSessionAnalyzer: () => { throw new Error("live must not construct legacy analyzer"); },
      sanitizeIpcError: (error) => ({ ok: false, error: { code: error.code || "error", message: "safe" } }),
      mediaToken: { SCHEME: "meeting-media" } },
    "./meeting/realtime": { createRealtimeMeetingService: (options) => { controls.options = options; return live; } },
    "./platform/macos": mac
  };
  const context = vm.createContext({ require: (id) => {
    if (id === "./platform/macos") controls.macLoaded += 1;
    if (Object.hasOwn(stubs, id)) return stubs[id];
    if (id.startsWith("node:")) return require(id);
    return {};
  }, __dirname: path.join(root, "src"), process: { platform, resourcesPath: root, env: {}, argv: [], on: () => {} },
  Buffer, URL, structuredClone, console, setTimeout: () => 0, clearTimeout: () => {}, testWindow: win });
  vm.runInContext(source, context);
  vm.runInContext("mainWindow = testWindow; configurePermissions();", context);
  const event = { sender: webContents, senderFrame: { url: localUrl } };
  return { controls, events, appEvents, context, webContents,
    run: (code) => vm.runInContext(code, context),
    invoke: (name, payload, sender = event) => handlers.get(name)(sender, payload) };
}

async function integrationTests() {
  const h = mainHarness();
  const { controls: c } = h;
  await h.invoke("meeting:live:recover", { sessionId: "previous" });
  assert.equal(c.recoveryInput.sessionId, "previous");
  assert.equal(c.startCount, 0);
  c.startGate = deferred();
  const start = h.invoke("meeting:live:start");
  const duplicate = h.invoke("meeting:live:start");
  await Promise.resolve();
  assert.equal((await h.invoke("meeting:capture:start", { sessionId: "legacy-1" })).ok, false);
  await assert.rejects(h.invoke("voice:realtime:start"), /capture_busy/);
  const stop = h.invoke("meeting:live:stop");
  c.startGate.resolve();
  assert.equal((await start).recording, true);
  assert.equal((await duplicate).ok, true);
  assert.equal(c.startCount, 1);
  assert.equal(c.startInput.modelId, "mimo-v2.5-asr");
  assert.equal((await stop).status, "stopping");
  assert.equal(c.options.analyzer, undefined);
  assert.equal(c.options.defaultDirectory, path.join(root, "mock", "documents", "Open Voice Input", "Meetings"));
  const snapshot = c.options.getSettings();
  snapshot.meetingRealtimeModel = "mutated";
  assert.equal(c.options.getSettings().meetingRealtimeModel, "mimo-v2.5-asr");
  assert.equal(c.writes.length, 0);
  const selected = h.run("settings.meetingAnalysisModel");
  assert.equal((await h.invoke("meeting:live:cleanup", { modelId: "independent", apiKey: "ignore" })).ok, true);
  assert.equal(c.cleanupInput.modelId, "independent");
  assert.equal(c.cleanupInput.apiKey, undefined);
  assert.equal(h.run("settings.meetingAnalysisModel"), selected);
  assert.equal((await h.invoke("meeting:live:choose-destination")).cancelled, true);
  assert.equal(c.writes.length, 0);
  c.picker = { canceled: false, filePath: path.join(root, "output", "chosen") };
  const chosen = await h.invoke("meeting:live:choose-destination");
  assert.equal(chosen.destinationPath, `${c.picker.filePath}.md`);
  assert.equal(c.writes.length, 1);
  assert.equal((await h.invoke("meeting:live:open-path", c.state.markdownPath)).ok, true);
  assert.equal((await h.invoke("meeting:live:open-path", path.join(root, "settings.json"))).error.code, "path_not_allowed");
  c.canonical = path.join(root, "private.md");
  assert.equal((await h.invoke("meeting:live:open-path", c.state.markdownPath)).ok, false);
  assert.equal(c.opened.length, 1);
  const evil = { sender: { getURL: () => "https://invalid.example" }, senderFrame: { url: "https://invalid.example" } };
  assert.equal((await h.invoke("meeting:live:start", {}, evil)).error.code, "untrusted_sender");
  c.state.error = { code: "unknown", message: "test-secret-provider-response" };
  c.state.apiKey = "test-secret";
  const dto = await h.invoke("meeting:live:status");
  assert.doesNotMatch(JSON.stringify(dto), /test-secret/);
  assert.equal(c.permissionCheck(h.webContents, "media", "file://", { mediaType: "video" }), false);
  assert.equal(c.permissionCheck(evil.sender, "media", "https://invalid.example", {}), false);
  console.log("ok - live IPC, duplicate start/stop race, cleanup isolation, recovery and protected outputs");

  const short = mainHarness();
  short.run("showAndStart()");
  await new Promise(setImmediate);
  assert.equal((await short.invoke("meeting:live:start")).error.code, "capture_busy");
  await short.invoke("recording:keys:clear");
  assert.equal((await short.invoke("meeting:live:start")).ok, true);
  let mediaAllowed = true;
  short.controls.permissionRequest(short.webContents, "media", (ok) => { mediaAllowed = ok; }, {});
  assert.equal(mediaAllowed, false);
  const legacy = mainHarness();
  assert.equal((await legacy.invoke("meeting:capture:start", { sessionId: "legacy-1" })).ok, true);
  assert.equal((await legacy.invoke("meeting:live:start")).error.code, "capture_busy");
  await legacy.invoke("meeting:capture:stop", { sessionId: "legacy-1" });
  assert.equal((await legacy.invoke("meeting:live:start")).ok, true);
  console.log("ok - short, legacy and live capture are mutually exclusive");

  const mac = mainHarness();
  mac.controls.permissions.microphone = "denied";
  assert.equal((await mac.invoke("meeting:live:start")).error.code, "microphone_permission");
  assert.equal(mac.controls.startCount, 0);
  mac.controls.permissions.microphone = "granted";
  mac.controls.permissions.screen = "denied";
  assert.equal((await mac.invoke("meeting:live:start")).error.code, "screen_permission");
  assert.equal((await mac.invoke("meeting:live:start", { captureMode: "microphone" })).ok, true);
  mac.run("targetWindowHandle = getForegroundWindowHandle()");
  await mac.run("sendPasteKeystroke()");
  assert.equal(mac.controls.pasted, "123");
  const hotkey = mainHarness();
  hotkey.run("runHotkeyAction('meeting'); runHotkeyAction('meeting')");
  await new Promise(setImmediate);
  assert.equal(hotkey.controls.startCount, 1);
  assert.equal(hotkey.controls.sent.some(([channel]) => channel === "open-meeting"), true);
  hotkey.run("runHotkeyAction('meeting')");
  await new Promise(setImmediate);
  assert.equal(hotkey.controls.startCount, 1);
  Object.assign(hotkey.controls.state, { status: "needs_retry", recording: false });
  hotkey.controls.options.onUpdate(hotkey.controls.state);
  assert.equal((await hotkey.invoke("meeting:live:retry")).ok, true);
  const win = mainHarness("win32");
  await win.invoke("meeting:live:start");
  assert.equal(win.controls.macLoaded, 0);
  console.log("ok - mac permission gating and native utility routing, lazy Windows isolation");
  const firstConsent = mainHarness();
  firstConsent.controls.permissions.screen = "not-determined";
  assert.equal((await firstConsent.invoke("meeting:live:start")).ok, true);
  assert.equal(firstConsent.controls.screenRequested, true);
  console.log("ok - first-run mac screen consent is requested before capture");

  const quit = mainHarness();
  await quit.invoke("meeting:live:start");
  quit.controls.stopGate = deferred();
  quit.controls.shutdownGate = deferred();
  let prevented = 0;
  const quitEvent = { preventDefault: () => { prevented += 1; } };
  quit.appEvents.get("before-quit")(quitEvent);
  quit.appEvents.get("before-quit")(quitEvent);
  await new Promise(setImmediate);
  assert.equal(prevented, 2);
  assert.equal(quit.events.includes("capture-shutdown"), false);
  assert.equal(quit.events.includes("exit"), false);
  quit.controls.stopGate.resolve();
  await new Promise(setImmediate);
  assert.equal(quit.events.includes("live-shutdown"), true);
  assert.equal(quit.events.includes("capture-shutdown"), false);
  quit.controls.shutdownGate.resolve();
  await new Promise(setImmediate);
  assert.deepEqual(quit.events.slice(-4), ["live-shutdown", "live-written", "capture-shutdown", "exit"]);
  const failedQuit = mainHarness();
  await failedQuit.invoke("meeting:live:start");
  failedQuit.controls.stopError = new Error("disk write failed");
  failedQuit.appEvents.get("before-quit")(quitEvent);
  await new Promise(setImmediate);
  assert.equal(failedQuit.events.includes("exit"), false);
  assert.equal(failedQuit.events.includes("capture-shutdown"), false);
  assert.equal(failedQuit.run("meetingQuitCleanupStarted"), false);
  console.log("ok - quit waits for the full live tail and disk writes, failures block exit");

  const listeners = new Map();
  let api;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(root, "src", "preload.js"), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { invoke: (...args) => calls.push(args), on: (name, fn) => listeners.set(name, fn),
        removeListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); } } })
  });
  for (const action of ["Start", "Stop", "Retry", "Cleanup", "Status", "Recover", "ChooseDestination", "OpenPath"]) {
    assert.equal(typeof api[`meetingLive${action}`], "function");
  }
  let received;
  const off = api.onMeetingLiveUpdate((value) => { received = value; });
  listeners.get("meeting:live:update")({ secretEvent: true }, { status: "recording" });
  assert.equal(received.status, "recording");
  off();
  assert.equal(listeners.has("meeting:live:update"), false);
  console.log("ok - preload live bridge exposes unsubscribe without leaking Electron events");
}

integrationTests().then(() => console.log("settings/shortcut/integration tests passed"))
  .catch((error) => { console.error(error); process.exitCode = 1; });
