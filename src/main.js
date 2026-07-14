const { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeImage, session, Tray } = require("electron");
const { execFile, execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createVoicePipeline } = require("./providers/voice-pipeline");
const { createQwenRealtimeSession } = require("./providers/asr/qwen-realtime-session");
const { createFunAsrRealtimeSession } = require("./providers/asr/fun-asr-realtime-session");

const RESOURCE_ROOT = app.isPackaged ? process.resourcesPath : path.join(__dirname, "..");
const APP_ICON_PATH = path.join(RESOURCE_ROOT, "assets", "mimo-icon.ico");
const TRAY_ICON_PATH = path.join(RESOURCE_ROOT, "assets", "mimo-tray.png");
const HOTKEY_HELPER_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "win-hotkey-helper.ps1")
  : path.join(__dirname, "win-hotkey-helper.ps1");
const APP_DISPLAY_NAME = "Open Voice Input";
const STABLE_USER_DATA_DIR = "open-voice-input";
const FALLBACK_TRAY_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const WINDOW_SIZES = {
  recording: { width: 320, height: 132 },
  recordingMax: { width: 520, height: 420 },
  compact: { width: 220, height: 74 },
  result: { width: 500, height: 420 },
  settings: { width: 840, height: 700 }
};

const DEFAULT_SETTINGS = {
  hotkey: "CommandOrControl+Alt+M",
  model: "mimo-v2.5",
  apiKey: "",
  baseUrl: "",
  asrProvider: "mimo",
  asrMode: "batch",
  asrModel: "mimo-v2.5-asr",
  asrRealtimeModel: "qwen3-asr-flash-realtime",
  asrApiKey: "",
  asrBaseUrl: "",
  asrLanguage: "",
  asrEnableItn: false,
  cleanerProvider: "mimo",
  cleanerModel: "mimo-v2.5",
  cleanerApiKey: "",
  cleanerBaseUrl: "",
  microphoneDeviceId: "",
  transcriptionMode: "stable",
  directSubmit: false,
  restoreClipboard: false,
  requestTimeoutMs: 60000
};

app.setPath("userData", path.join(app.getPath("appData"), STABLE_USER_DATA_DIR));

let mainWindow;
let settingsWindow;
let tray;
let settings = { ...DEFAULT_SETTINGS };
let registeredHotkeys = [];
let failedHotkeys = [];
let hotkeyHelperProcess = null;
let windowMode = "compact";
let targetWindowHandle = "";
let recordingKeyFallbacksActive = false;
let voicePipeline;
let realtimeSession;
const singleInstanceLock = app.requestSingleInstanceLock();

function logEvent(message, detail = "") {
  try {
    const line = `[${new Date().toISOString()}] ${message}${detail ? ` ${detail}` : ""}\n`;
    fs.mkdir(app.getPath("userData"), { recursive: true })
      .then(() => fs.appendFile(path.join(app.getPath("userData"), "open-voice-input.log"), line, "utf8"))
      .catch(() => {});
  } catch {
    // Logging must never affect the voice input flow.
  }
}

if (!singleInstanceLock) {
  logEvent("single-instance: quit duplicate");
  app.quit();
} else {
  app.on("second-instance", () => {
    logEvent("single-instance: show existing");
    showWindowOnly();
  });
}

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

async function loadSettings() {
  await migrateLegacyUserData();
  try {
    const raw = await fs.readFile(settingsPath(), "utf8");
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    settings.restoreClipboard = false;
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

async function migrateLegacyUserData() {
  const userDataPath = app.getPath("userData");
  const targetSettingsPath = path.join(userDataPath, "settings.json");
  try {
    await fs.access(targetSettingsPath);
    return;
  } catch {
    // Continue with best-effort migration from older product names.
  }

  const appDataPath = app.getPath("appData");
  const legacyDirs = ["mimo-voice-input", "MiMo Voice Input", "基于小米 MiMo V2.5 的语音输入法"];
  for (const dir of legacyDirs) {
    const legacySettingsPath = path.join(appDataPath, dir, "settings.json");
    try {
      const raw = await fs.readFile(legacySettingsPath, "utf8");
      await fs.mkdir(userDataPath, { recursive: true });
      await fs.writeFile(targetSettingsPath, raw, "utf8");
      logEvent("settings: migrated", legacySettingsPath);
      return;
    } catch {
      // Try the next known legacy location.
    }
  }
}

async function saveSettings(nextSettings) {
  settings = { ...settings, ...nextSettings };
  settings.transcriptionMode = normalizeTranscriptionMode(settings.transcriptionMode);
  settings.asrMode = normalizeAsrMode(settings.asrMode);
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
  await registerHotkey();
  return settings;
}

function normalizeTranscriptionMode(mode) {
  return voicePipeline?.normalizeTranscriptionMode(mode) || (mode === "fast" ? "fast" : "stable");
}

function normalizeAsrMode(mode) {
  return voicePipeline?.normalizeQwenAsrMode?.(mode) || (mode === "realtime" ? "realtime" : "batch");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: WINDOW_SIZES.compact.width,
    height: WINDOW_SIZES.compact.height,
    useContentSize: true,
    show: false,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    icon: APP_ICON_PATH,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("blur", () => {
    mainWindow.webContents.send("window-blur");
  });
}

function createSettingsWindow() {
  settingsWindow = new BrowserWindow({
    width: WINDOW_SIZES.settings.width,
    height: WINDOW_SIZES.settings.height,
    useContentSize: true,
    show: false,
    title: `${APP_DISPLAY_NAME} 设置`,
    frame: true,
    alwaysOnTop: false,
    resizable: true,
    minimizable: true,
    maximizable: true,
    skipTaskbar: false,
    icon: APP_ICON_PATH,
    transparent: false,
    backgroundColor: "#101418",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  settingsWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

function configurePermissions() {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });
}

function showAndStart() {
  if (!mainWindow) return;
  logEvent("hotkey: showAndStart");
  if (settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.isVisible()) {
    settingsWindow.hide();
  }
  targetWindowHandle = getForegroundWindowHandle();
  setWindowMode("recording");
  prepareWindowForDisplay(mainWindow, "recording");
  mainWindow.show();
  enforceWindowGeometry(mainWindow, "recording");
  focusMainWindow();
  registerRecordingKeyFallbacks();
  mainWindow.webContents.send("hotkey-record");
}

function showWindowOnly() {
  if (!mainWindow) return;
  setWindowMode("compact");
  prepareWindowForDisplay(mainWindow, "compact");
  mainWindow.show();
  enforceWindowGeometry(mainWindow, "compact");
  mainWindow.focus();
}

function showSettings() {
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    createSettingsWindow();
  }
  if (!settingsWindow) return;
  targetWindowHandle = "";
  logEvent("settings-window: show");
  prepareWindowForDisplay(settingsWindow, "settings");
  settingsWindow.show();
  enforceWindowGeometry(settingsWindow, "settings");
  focusWindow(settingsWindow, "settings", { topmost: false });
  sendWhenLoaded(settingsWindow, "window-mode", "settings");
  sendWhenLoaded(settingsWindow, "open-settings");
}

function showResultWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  logEvent("result-window: show");
  setWindowMode("result");
  prepareWindowForDisplay(mainWindow, "result");
  mainWindow.show();
  enforceWindowGeometry(mainWindow, "result");
  focusMainWindow();
}

function setWindowMode(mode) {
  windowMode = mode;
  if (!mainWindow) return;
  logEvent("window: mode", mode);
  enforceWindowGeometry(mainWindow, mode);
  mainWindow.webContents.send("window-mode", mode);
}

function enforceWindowGeometry(win, mode = windowMode) {
  if (!win || win.isDestroyed()) return;
  const size = WINDOW_SIZES[mode] || WINDOW_SIZES.compact;
  const isSettings = mode === "settings" || win === settingsWindow;
  win.setMinimumSize(isSettings ? 720 : 1, isSettings ? 560 : 1);
  if (!isSettings || !win.isVisible()) {
    win.setContentSize(size.width, size.height, false);
    win.setBounds({ ...win.getBounds(), width: size.width, height: size.height }, false);
  }
  setWindowAlwaysOnTop(win, !isSettings);
  logEvent("window: geometry", `${mode} ${JSON.stringify(win.getBounds())}`);
}

function resizeRecordingWindow({ width, height } = {}) {
  if (!mainWindow || mainWindow.isDestroyed() || windowMode !== "recording") return;
  const min = WINDOW_SIZES.recording;
  const max = WINDOW_SIZES.recordingMax;
  const nextWidth = clamp(Number(width) || min.width, min.width, max.width);
  const nextHeight = clamp(Number(height) || min.height, min.height, max.height);
  mainWindow.setContentSize(nextWidth, nextHeight, false);
  mainWindow.setBounds({ ...mainWindow.getBounds(), width: nextWidth, height: nextHeight }, false);
  raiseWindowToFront(mainWindow, "recording-resize", { focus: false, native: false });
  logEvent("window: recording resize", `${nextWidth}x${nextHeight}`);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function prepareWindowForDisplay(win = mainWindow, mode = windowMode) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) {
    win.restore();
  }
  enforceWindowGeometry(win, mode);
  win.setFocusable(true);
  setWindowAlwaysOnTop(win, mode !== "settings" && win !== settingsWindow);
  if (!win.isVisible()) win.center();
  win.moveTop();
}

function hideWindow(win = mainWindow) {
  if (!win || win.isDestroyed()) return;
  if (win === mainWindow) {
    setWindowMode("compact");
    unregisterRecordingKeyFallbacks();
  }
  win.hide();
}

function sendWhenLoaded(win, channel, ...args) {
  if (!win || win.isDestroyed()) return;
  if (!win.webContents.isLoading()) {
    win.webContents.send(channel, ...args);
    return;
  }
  win.webContents.once("did-finish-load", () => {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args);
    }
  });
}

function hotkeyCandidates() {
  const configuredHotkey = settings.hotkey?.trim() || DEFAULT_SETTINGS.hotkey;
  return [configuredHotkey];
}

function focusMainWindow() {
  if (!mainWindow) return;
  focusWindow(mainWindow, "main");
}

function focusWindow(win, label, { topmost = true } = {}) {
  if (!win || win.isDestroyed()) return;
  logEvent("window: focus requested", label);
  win.show();
  raiseWindowToFront(win, label, { focus: true, native: topmost, topmost });
  for (const delay of [80, 180, 360, 720]) {
    setTimeout(() => {
      if (!win || win.isDestroyed() || !win.isVisible()) return;
      raiseWindowToFront(win, label, { focus: true, native: topmost && delay >= 180, topmost });
      logEvent("window: focus retry", `${label} delay=${delay} focused=${win.isFocused()} visible=${win.isVisible()}`);
    }, delay);
  }
}

function raiseWindowToFront(win, label, { focus = false, native = false, topmost = true } = {}) {
  if (!win || win.isDestroyed()) return;
  try {
    setWindowAlwaysOnTop(win, Boolean(topmost));
    win.moveTop();
    if (focus) win.focus();
    if (native && topmost) bumpNativeTopmost(win, label);
  } catch (error) {
    logEvent("window: raise failed", `${label} ${error?.message || String(error)}`);
  }
}

function setWindowAlwaysOnTop(win, enabled) {
  if (enabled) {
    win.setAlwaysOnTop(true, "screen-saver");
  } else {
    win.setAlwaysOnTop(false);
  }
}

function bumpNativeTopmost(win, label) {
  if (os.platform() !== "win32" || !win || win.isDestroyed()) return;
  const handle = nativeWindowHandleDecimal(win);
  if (!handle || handle === "0") return;
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class OpenVoiceInputWin32Topmost {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, UInt32 uFlags);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
}
"@
$hwnd = [IntPtr]::new([Int64]'${handle}')
$HWND_TOPMOST = [IntPtr]::new(-1)
$SWP_NOSIZE = 0x0001
$SWP_NOMOVE = 0x0002
$SWP_NOACTIVATE = 0x0010
$SWP_SHOWWINDOW = 0x0040
[OpenVoiceInputWin32Topmost]::ShowWindow($hwnd, 9) | Out-Null
[OpenVoiceInputWin32Topmost]::SetWindowPos($hwnd, $HWND_TOPMOST, 0, 0, 0, 0, $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE -bor $SWP_SHOWWINDOW) | Out-Null
[OpenVoiceInputWin32Topmost]::BringWindowToTop($hwnd) | Out-Null
`;
  execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    timeout: 2500,
    windowsHide: true
  }, (error) => {
    if (error) {
      logEvent("window: native topmost failed", `${label} ${error.message || String(error)}`);
    }
  });
}

function nativeWindowHandleDecimal(win) {
  try {
    const handle = win.getNativeWindowHandle();
    if (!handle || handle.length < 4) return "";
    if (handle.length >= 8) return handle.readBigUInt64LE(0).toString();
    return String(handle.readUInt32LE(0));
  } catch (error) {
    logEvent("window: native handle failed", error?.message || String(error));
    return "";
  }
}

function registerRecordingKeyFallbacks() {
  if (recordingKeyFallbacksActive) return;
  const bindings = [
    ["Enter", "stop"],
    ["Esc", "cancel"],
    ["Escape", "cancel"],
    ["Backspace", "cancel"],
    ["Delete", "cancel"]
  ];
  let registeredCount = 0;
  for (const [accelerator, command] of bindings) {
    try {
      const ok = globalShortcut.register(accelerator, () => {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && windowMode === "recording") {
          logEvent("recording-key-fallback", `${accelerator}:${command}`);
          mainWindow.webContents.send("recording-command", command);
        }
      });
      if (ok) registeredCount += 1;
    } catch (error) {
      logEvent("recording-key-fallback: failed", `${accelerator} ${error?.message || String(error)}`);
    }
  }
  recordingKeyFallbacksActive = registeredCount > 0;
  logEvent("recording-key-fallback: registered", String(registeredCount));
}

function unregisterRecordingKeyFallbacks() {
  if (!recordingKeyFallbacksActive) return;
  for (const accelerator of ["Enter", "Esc", "Escape", "Backspace", "Delete"]) {
    globalShortcut.unregister(accelerator);
  }
  recordingKeyFallbacksActive = false;
  logEvent("recording-key-fallback: unregistered");
}

function stopWindowsHotkeyHelper() {
  if (!hotkeyHelperProcess) return;
  const child = hotkeyHelperProcess;
  hotkeyHelperProcess = null;
  child.removeAllListeners();
  child.stdout?.removeAllListeners();
  child.stderr?.removeAllListeners();
  child.kill();
}

async function registerHotkey() {
  logEvent("hotkey: register start", JSON.stringify(hotkeyCandidates()));
  globalShortcut.unregisterAll();
  stopWindowsHotkeyHelper();
  registeredHotkeys = [];
  failedHotkeys = [];

  const candidates = hotkeyCandidates();
  if (os.platform() === "win32") {
    await startWindowsHotkeyHelper(candidates);
    logEvent("hotkey: register done", `registered=${registeredHotkeys.join(",")} failed=${failedHotkeys.join(",")}`);
    return;
  }

  for (const hotkey of candidates) {
    try {
      const ok = globalShortcut.register(hotkey, showAndStart);
      if (ok) {
        registeredHotkeys.push(hotkey);
      } else {
        failedHotkeys.push(hotkey);
        console.warn(`Failed to register hotkey: ${hotkey}`);
      }
    } catch (error) {
      failedHotkeys.push(hotkey);
      console.warn(`Invalid hotkey: ${hotkey}`, error);
    }
  }
}

function parseWindowsHotkey(accelerator) {
  const parts = String(accelerator || "").split("+").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return null;

  let modifiers = 0x4000; // MOD_NOREPEAT
  let key = "";
  for (const part of parts) {
    const normalized = part.toLowerCase();
    if (normalized === "commandorcontrol" || normalized === "cmdorctrl" || normalized === "control" || normalized === "ctrl") {
      modifiers |= 0x0002; // MOD_CONTROL
    } else if (normalized === "alt" || normalized === "option") {
      modifiers |= 0x0001; // MOD_ALT
    } else if (normalized === "shift") {
      modifiers |= 0x0004; // MOD_SHIFT
    } else if (normalized === "super" || normalized === "meta" || normalized === "win" || normalized === "windows" || normalized === "command" || normalized === "cmd") {
      modifiers |= 0x0008; // MOD_WIN
    } else {
      key = part;
    }
  }

  const keyCode = windowsVirtualKeyCode(key);
  if (!keyCode) return null;
  return { label: accelerator, modifiers, keyCode };
}

function windowsVirtualKeyCode(key) {
  if (!key) return 0;
  const upper = key.toUpperCase();
  if (/^[A-Z]$/.test(upper)) return upper.charCodeAt(0);
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0);
  const functionKey = upper.match(/^F([1-9]|1\d|2[0-4])$/);
  if (functionKey) return 0x70 + Number(functionKey[1]) - 1;
  const numpadKey = key.toLowerCase().match(/^num([0-9])$/);
  if (numpadKey) return 0x60 + Number(numpadKey[1]);

  const keyMap = {
    Space: 0x20,
    Tab: 0x09,
    Enter: 0x0d,
    Esc: 0x1b,
    Escape: 0x1b,
    Backspace: 0x08,
    Delete: 0x2e,
    Insert: 0x2d,
    Home: 0x24,
    End: 0x23,
    PageUp: 0x21,
    PageDown: 0x22,
    Up: 0x26,
    Down: 0x28,
    Left: 0x25,
    Right: 0x27,
    Plus: 0xbb,
    "+": 0xbb,
    "=": 0xbb,
    "-": 0xbd,
    ",": 0xbc,
    ".": 0xbe,
    "/": 0xbf,
    "\\": 0xdc,
    ";": 0xba,
    "'": 0xde,
    "[": 0xdb,
    "]": 0xdd,
    "`": 0xc0
  };
  return keyMap[key] || 0;
}

function startWindowsHotkeyHelper(candidates) {
  const specs = [];
  for (const candidate of candidates) {
    const spec = parseWindowsHotkey(candidate);
    if (spec) {
      specs.push(spec);
    } else {
      failedHotkeys.push(candidate);
      console.warn(`Invalid Windows hotkey: ${candidate}`);
    }
  }
  if (!specs.length) return Promise.resolve();

  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    HOTKEY_HELPER_PATH,
    "-ConfigJson",
    JSON.stringify({ hotkeys: specs })
  ], {
    windowsHide: true
  });

  hotkeyHelperProcess = child;
  let buffer = "";
  let settled = false;
  const expectedLabels = new Set(specs.map((spec) => spec.label));
  const seenLabels = new Set();

  return new Promise((resolve) => {
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(settle, 900);

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        handleWindowsHotkeyHelperLine(line, expectedLabels, seenLabels);
        if (seenLabels.size >= expectedLabels.size) {
          settle();
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) console.warn(`Hotkey helper: ${text}`);
    });

    child.on("exit", (code) => {
      if (hotkeyHelperProcess === child) {
        hotkeyHelperProcess = null;
      }
      if (code !== 0 && registeredHotkeys.length === 0) {
        for (const spec of specs) {
          if (!failedHotkeys.includes(spec.label)) failedHotkeys.push(spec.label);
        }
      }
      settle();
    });
  });
}

function handleWindowsHotkeyHelperLine(line, expectedLabels, seenLabels) {
  logEvent("hotkey-helper: line", line);
  const [eventName, label, detail] = String(line || "").split("\t");
  if (!eventName || !label) return;

  if (eventName === "REGISTERED") {
    if (!registeredHotkeys.includes(label)) registeredHotkeys.push(label);
    seenLabels.add(label);
  } else if (eventName === "FAILED") {
    if (!failedHotkeys.includes(label)) failedHotkeys.push(label);
    seenLabels.add(label);
    console.warn(`Failed to register Windows hotkey: ${label}${detail ? ` (${detail})` : ""}`);
  } else if (eventName === "HOTKEY" && expectedLabels.has(label)) {
    showAndStart();
  }
}

function createTray() {
  let image = nativeImage.createFromPath(TRAY_ICON_PATH);
  if (image.isEmpty()) {
    image = nativeImage.createFromPath(APP_ICON_PATH);
  }
  if (image.isEmpty()) {
    image = nativeImage.createFromDataURL(FALLBACK_TRAY_ICON_DATA_URL);
  }
  tray = new Tray(image);
  tray.setToolTip(APP_DISPLAY_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示", click: showWindowOnly },
    { label: "设置", click: showSettings },
    { label: "开始录音", click: showAndStart },
    { label: "重试上一次转写", click: retryLastVoiceRequest },
    { label: "隐藏", click: () => hideWindow() },
    { type: "separator" },
    { label: "退出", click: () => app.quit() }
  ]));
  tray.on("click", showWindowOnly);
  logEvent("tray: created");
}

function retryLastVoiceRequest() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  logEvent("tray: retry last request");
  mainWindow.webContents.send("retry-last-voice-request");
  showWindowOnly();
}

function resolveApiKey() {
  return voicePipeline?.resolveApiKey() || settings.apiKey || process.env.MIMO_API_KEY || "";
}

function resolveBaseUrl(apiKey) {
  return voicePipeline?.resolveBaseUrl(apiKey) || "https://api.xiaomimimo.com/v1";
}

function qwenRealtimeSettings() {
  return {
    apiKey: settings.asrApiKey || process.env.QWEN_ASR_API_KEY || process.env.DASHSCOPE_API_KEY || settings.apiKey || process.env.MIMO_API_KEY || "",
    model: settings.asrRealtimeModel || settings.asrModel || "qwen3-asr-flash-realtime",
    language: settings.asrLanguage || "",
    enableItn: Boolean(settings.asrEnableItn)
  };
}

function funRealtimeSettings() {
  return {
    apiKey: settings.asrApiKey || process.env.FUN_ASR_API_KEY || process.env.DASHSCOPE_API_KEY || settings.apiKey || process.env.MIMO_API_KEY || "",
    model: settings.asrRealtimeModel || settings.asrModel || "fun-asr-realtime",
    language: settings.asrLanguage || "",
    semanticPunctuation: normalizeTranscriptionMode(settings.transcriptionMode) === "stable"
  };
}

async function startRealtimeAsr(event) {
  stopRealtimeAsr();
  if (normalizeAsrMode(settings.asrMode) !== "realtime") {
    return { enabled: false };
  }

  if (settings.asrProvider === "qwen3-asr") {
    realtimeSession = createQwenRealtimeSession({
      ...qwenRealtimeSettings(),
      onPartial: (text) => event.sender.send("voice:partial-transcript", text),
      onFinal: (text) => event.sender.send("voice:partial-transcript", text),
      onLog: logEvent
    });
  } else if (settings.asrProvider === "fun-asr") {
    realtimeSession = createFunAsrRealtimeSession({
      ...funRealtimeSettings(),
      onPartial: (text) => event.sender.send("voice:partial-transcript", text),
      onFinal: (text) => event.sender.send("voice:partial-transcript", text),
      onLog: logEvent
    });
  } else {
    return { enabled: false };
  }
  try {
    await realtimeSession.ready;
    return { enabled: true, model: realtimeSession.model };
  } catch (error) {
    stopRealtimeAsr();
    throw error;
  }
}

function appendRealtimeAudio(base64Audio) {
  realtimeSession?.appendPcm16Base64(base64Audio);
}

async function finishRealtimeAsr({ clean = true, shortContext = "", transcriptionMode } = {}) {
  if (!realtimeSession) return "";
  const session = realtimeSession;
  realtimeSession = null;
  const rawText = await session.finish();
  logEvent("realtime-asr: preview final text", `chars=${rawText.length}`);
  if (clean && normalizeTranscriptionMode(transcriptionMode || settings.transcriptionMode) === "stable") {
    return voicePipeline.cleanText({ rawText, shortContext });
  }
  return rawText;
}

function stopRealtimeAsr() {
  realtimeSession?.close();
  realtimeSession = null;
}

function sendPasteKeystroke() {
  const escapedHandle = String(targetWindowHandle || "").replace(/'/g, "''");
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
$handle = '${escapedHandle}'
if ($handle) {
  [Win32]::SetForegroundWindow([IntPtr]::new([Int64]$handle)) | Out-Null
  Start-Sleep -Milliseconds 180
}
[System.Windows.Forms.SendKeys]::SendWait('^v')
`;
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function injectText(text) {
  clipboard.writeText(text);
  hideWindow();
  await new Promise((resolve) => setTimeout(resolve, 260));
  await sendPasteKeystroke();
}

function getForegroundWindowHandle() {
  try {
    const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
[Win32]::GetForegroundWindow().ToInt64()
`;
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 3000
    }).trim();
  } catch {
    return "";
  }
}

ipcMain.handle("settings:get", async () => settings);
ipcMain.handle("settings:save", async (_event, nextSettings) => saveSettings(nextSettings));
ipcMain.handle("window:compact", async (_event, isCompact) => {
  if (isCompact) {
    setWindowMode("compact");
    mainWindow?.center();
  } else {
    showSettings();
  }
});
ipcMain.handle("window:settings", async () => showSettings());
ipcMain.handle("window:result", async () => showResultWindow());
ipcMain.handle("window:recording-resize", async (_event, size) => resizeRecordingWindow(size));
ipcMain.handle("app:status", async () => ({
  hasApiKey: Boolean(resolveApiKey()),
  hasSavedApiKey: Boolean(settings.apiKey),
  hasEnvApiKey: Boolean(process.env.MIMO_API_KEY),
  baseUrl: resolveBaseUrl(resolveApiKey()),
  keyKind: resolveApiKey()?.startsWith("tp-") ? "token-plan" : "regular",
  registeredHotkeys,
  failedHotkeys,
  platform: os.platform(),
  settings
}));
ipcMain.handle("window:hide", async (event) => hideWindow(BrowserWindow.fromWebContents(event.sender) || mainWindow));
ipcMain.handle("app:log", async (_event, message, detail) => logEvent(`renderer: ${message}`, detail || ""));
ipcMain.handle("voice:transcribe", async (_event, payload) => voicePipeline.transcribe(payload));
ipcMain.handle("mimo:transcribe", async (_event, payload) => voicePipeline.transcribe(payload));
ipcMain.handle("voice:realtime:start", async (event) => startRealtimeAsr(event));
ipcMain.handle("voice:realtime:append", async (_event, base64Audio) => appendRealtimeAudio(base64Audio));
ipcMain.handle("voice:realtime:finish", async (_event, payload) => finishRealtimeAsr(payload));
ipcMain.handle("voice:realtime:cancel", async () => stopRealtimeAsr());
ipcMain.handle("connection:test", async () => voicePipeline.testConnection());
ipcMain.handle("input:inject", async (_event, text) => injectText(text));
ipcMain.handle("clipboard:write-text", async (_event, text) => clipboard.writeText(String(text || "")));
ipcMain.handle("recording:keys:clear", async () => unregisterRecordingKeyFallbacks());

app.whenReady().then(async () => {
  logEvent("app: ready");
  await loadSettings();
  voicePipeline = createVoicePipeline({ getSettings: () => settings, logEvent });
  logEvent("settings: loaded", JSON.stringify({ hotkey: settings.hotkey, microphoneDeviceId: settings.microphoneDeviceId, transcriptionMode: settings.transcriptionMode }));
  configurePermissions();
  createWindow();
  createTray();
  await registerHotkey();
  setWindowMode("compact");
  if (resolveApiKey()) {
    mainWindow.hide();
  } else {
    showSettings();
  }
  logEvent("app: initialized");
});

app.on("will-quit", () => {
  logEvent("app: will-quit");
  unregisterRecordingKeyFallbacks();
  stopWindowsHotkeyHelper();
  globalShortcut.unregisterAll();
});

app.on("render-process-gone", (_event, webContents, details) => {
  logEvent("app: render-process-gone", JSON.stringify(details));
});

app.on("child-process-gone", (_event, details) => {
  logEvent("app: child-process-gone", JSON.stringify(details));
});

process.on("uncaughtException", (error) => {
  logEvent("process: uncaughtException", error?.stack || error?.message || String(error));
});

process.on("unhandledRejection", (reason) => {
  logEvent("process: unhandledRejection", reason?.stack || reason?.message || String(reason));
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});
