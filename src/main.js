const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  screen,
  session,
  Tray
} = require("electron");
const { execFile, execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { createRuntimeLogWriter } = require("./runtime-log");
const { createVoicePipeline } = require("./providers/voice-pipeline");
const { createQwenRealtimeSession } = require("./providers/asr/qwen-realtime-session");
const { createFunAsrRealtimeSession } = require("./providers/asr/fun-asr-realtime-session");
const {
  createMeetingCaptureService,
  createMeetingSessionProcessor,
  createMeetingSessionAnalyzer,
  sanitizeIpcError,
  sanitizeDevicesPayload,
  toProcessStatusDto,
  speakerMap: meetingSpeakerMap,
  sessionExport: meetingSessionExport,
  importWav: meetingImportWav,
  mediaToken: meetingMediaToken,
  paths: meetingPaths
} = require("./meeting");
const { createImportJobManager, probeSessionArtifacts } = require("./meeting/import/import-job");
const { buildPlaybackHeaders } = require("./meeting/playback/http-range");
const { resolveMeetingQwenCredentials } = require("./meeting/processing/meeting-credentials");
const { buildHelperReadyErrorResponse } = require("./meeting/processing/session-processor");
const { resolveMeetingAnalysisCredentials } = require("./meeting/analysis/credentials");
const { ensureConnectionProfiles } = require("./settings/connection-profiles");
const { validateHotkey, normalizeAccelerator } = require("./hotkeys/validate-hotkey");

let meetingImportJobs = null;
function getMeetingImportJobs() {
  if (!meetingImportJobs) {
    meetingImportJobs = createImportJobManager({
      getStore: () => getMeetingCapture().store,
      logger: (e) => logEvent("meeting:import", JSON.stringify(e)),
      ffmpegOptions: () => ({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appRoot: path.join(__dirname, "..")
      })
    });
  }
  return meetingImportJobs;
}

async function startMeetingImportFromDialog({
  title,
  reuseId,
  kind = "media",
  track = "microphone",
  role = null,
  dialogTitle = "导入媒体",
  parentWindow = null
} = {}) {
  const win = parentWindow && !parentWindow.isDestroyed()
    ? parentWindow
    : BrowserWindow.getFocusedWindow() || mainWindow;
  const mediaFilters =
    kind === "wav"
      ? [
          { name: "WAV", extensions: ["wav"] },
          { name: "All", extensions: ["*"] }
        ]
      : [
          {
            name: "Media",
            extensions: [
              "wav",
              "mp3",
              "m4a",
              "aac",
              "flac",
              "ogg",
              "opus",
              "wma",
              "mp4",
              "mkv",
              "webm",
              "mov",
              "avi",
              "m4v"
            ]
          },
          { name: "All", extensions: ["*"] }
        ];
  const picked = await dialog.showOpenDialog(win, {
    title: dialogTitle,
    properties: ["openFile"],
    filters: mediaFilters
  });
  if (picked.canceled || !picked.filePaths?.length) return { ok: false, cancelled: true };
  const sourcePath = picked.filePaths[0];
  const service = getMeetingCapture();
  let sessionId = reuseId ? String(reuseId) : null;
  let sessionDir = null;
  let sessionTitle = title || path.basename(sourcePath, path.extname(sourcePath)).slice(0, 200);
  let reimport = false;
  if (sessionId) {
    const current = await service.store.readSession(sessionId);
    if (!current) return { ok: false, error: { code: "session_not_found", message: "session not found" } };
    sessionDir = current.sessionDir;
    sessionTitle = title || current.session.title || sessionTitle;
    reimport = true;
  } else {
    const created = await service.store.createSession({ title: sessionTitle });
    sessionId = created.session.id;
    sessionDir = created.sessionDir;
  }
  const started = await getMeetingImportJobs().startImport({
    sourcePath,
    sessionId,
    sessionDir,
    title: sessionTitle,
    reimport,
    kind: kind === "wav" ? "wav" : "media",
    track: track === "system" ? "system" : "microphone",
    role
  });
  return {
    ok: true,
    cancelled: false,
    sessionId: started.sessionId,
    status: "importing",
    source: "import",
    title: sessionTitle,
    kind: started.kind || kind,
    track: track === "system" ? "system" : "microphone"
  };
}

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
  settings: { width: 840, height: 700 },
  meeting: { width: 1180, height: 760 },
  file: { width: 1180, height: 760 }
};

const DEFAULT_SETTINGS = {
  hotkey: "CommandOrControl+Alt+M",
  meetingHotkey: "CommandOrControl+Alt+Shift+M",
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
  asrProfiles: {},
  cleanerProvider: "mimo",
  cleanerModel: "mimo-v2.5",
  cleanerApiKey: "",
  cleanerBaseUrl: "",
  cleanerProfiles: {},
  microphoneDeviceId: "",
  transcriptionMode: "stable",
  directSubmit: false,
  restoreClipboard: false,
  requestTimeoutMs: 60000,
  // Meeting-scoped (isolated from short-voice ASR/cleaner keys)
  meetingMicrophoneDeviceId: "",
  meetingSystemDeviceId: "",
  meetingCaptureMode: "dual",
  meetingQwenApiKey: "",
  meetingQwenBaseUrl: "",
  meetingQwenModel: "qwen3-asr-flash",
  meetingQwenProfiles: {},
  meetingFileAsrProvider: "mimo",
  meetingFileAsrApiKey: "",
  meetingFileAsrBaseUrl: "",
  meetingFileAsrModel: "mimo-v2.5-asr",
  meetingFileAsrProfiles: {},
  // Stage 4C enhanced diarization (runtime-only secrets; empty defaults)
  meetingProcessMode: "basic",
  meetingUploadBitrateKbps: 48,
  meetingFunAsrApiKey: "",
  meetingFunAsrBaseUrl: "",
  meetingFunAsrModel: "fun-asr",
  meetingFunAsrProfiles: {},
  meetingOssRegion: "",
  meetingOssEndpoint: "",
  meetingOssBucket: "",
  meetingOssAccessKeyId: "",
  meetingOssAccessKeySecret: "",
  meetingOssPrefix: "meeting",
  meetingAnalysisApiKey: "",
  meetingAnalysisBaseUrl: "",
  meetingAnalysisModel: "",
  meetingAnalysisProfiles: {},
  meetingAnalysisContextWindow: 128000,
  meetingAnalysisMaxOutput: 8192,
  meetingAnalysisReasoning: "",
  meetingAnalysisTimeoutMs: 120000
};

app.setPath("userData", path.join(app.getPath("appData"), STABLE_USER_DATA_DIR));

let mainWindow;
let tray;
let settings = { ...DEFAULT_SETTINGS };
let registeredHotkeys = [];
let registeredHotkeyMap = {}; // accelerator -> action
let failedHotkeys = [];
let hotkeyHelperProcess = null;
let shortcutCaptureSuspended = false;
let windowMode = "compact";
let targetWindowHandle = "";
let recordingKeyFallbacksActive = false;
let voicePipeline;
let realtimeSession;
/** Meeting capture is isolated from short-voice recording / realtime ASR state. */
let meetingCapture = null;
/** Stage 2B post-process orchestrator (export + no-bucket ASR). Isolated from voice-pipeline. */
let meetingProcessor = null;
/** Stage 3A analysis orchestrator (correct + summary). Isolated from short-voice cleaner. */
let meetingAnalyzer = null;
let meetingQuitCleanupStarted = false;
const MEETING_QUIT_TIMEOUT_MS = 4000;
const singleInstanceLock = app.requestSingleInstanceLock();

function getMeetingCapture() {
  if (!meetingCapture) {
    meetingCapture = createMeetingCaptureService({
      userDataPath: app.getPath("userData"),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appRoot: app.isPackaged ? process.resourcesPath : path.join(__dirname, ".."),
      logger: (message, detail) => logEvent(message, detail || "")
    });
  }
  return meetingCapture;
}

function getMeetingProcessor() {
  if (!meetingProcessor) {
    const {
      resolveMeetingFunAsrCredentials
    } = require("./meeting/processing/fun-asr-credentials");
    const { resolveMeetingOssCredentials } = require("./meeting/processing/oss-credentials");
    const { resolveMeetingFileAsrCredentials } = require("./meeting/processing/file-asr-credentials");
    meetingProcessor = createMeetingSessionProcessor({
      userDataPath: app.getPath("userData"),
      getCaptureService: getMeetingCapture,
      resolveCredentials: () =>
        resolveMeetingQwenCredentials({
          env: process.env,
          settings
        }),
      resolveFileAsrCredentials: (preferred = {}) =>
        resolveMeetingFileAsrCredentials({
          env: process.env,
          settings: {
            ...settings,
            ...(preferred.modelId ? { meetingFileAsrModel: preferred.modelId } : {}),
            ...(preferred.provider ? { meetingFileAsrProvider: preferred.provider } : {})
          }
        }),
      resolveFunAsrCredentials: () =>
        resolveMeetingFunAsrCredentials({
          env: process.env,
          settings
        }),
      resolveOssCredentials: () =>
        resolveMeetingOssCredentials({
          env: process.env,
          settings
        }),
      ffmpegOptions: () => ({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appRoot: app.isPackaged ? process.resourcesPath : path.join(__dirname, "..")
      }),
      logger: (ev) => logEvent(`meeting-process: ${ev?.event || "event"}`, "")
    });
  }
  return meetingProcessor;
}

function getMeetingAnalyzer() {
  if (!meetingAnalyzer) {
    meetingAnalyzer = createMeetingSessionAnalyzer({
      userDataPath: app.getPath("userData"),
      getCaptureService: getMeetingCapture,
      resolveCredentials: () =>
        resolveMeetingAnalysisCredentials({
          env: process.env,
          settings
        }),
      logger: (ev) => logEvent(`meeting-analysis: ${ev?.event || "event"}`, "")
    });
  }
  return meetingAnalyzer;
}

let runtimeLogWriter = null;
function getRuntimeLogWriter() {
  if (runtimeLogWriter) return runtimeLogWriter;
  try {
    const logFilePath = path.join(app.getPath("userData"), "open-voice-input.log");
    runtimeLogWriter = createRuntimeLogWriter({
      logFilePath,
      maxFileBytes: 5 * 1024 * 1024,
      maxFiles: 3,
      maxDetailChars: 2000,
      maxLineChars: 4000,
      fsImpl: fs
    });
  } catch {
    runtimeLogWriter = {
      enqueue() {},
      flush() {
        return Promise.resolve();
      },
      close() {
        return Promise.resolve();
      }
    };
  }
  return runtimeLogWriter;
}

function logEvent(message, detail = "") {
  try {
    // Serial async queue; never blocks voice/meeting hot paths; failures swallowed.
    getRuntimeLogWriter().enqueue(message, detail);
  } catch {
    // Logging must never affect the voice input flow.
  }
}

if (!singleInstanceLock) {
  logEvent("single-instance: quit duplicate");
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    if (commandLine.includes("--settings")) {
      logEvent("single-instance: show settings");
      showSettings();
      return;
    }
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
    settings = ensureConnectionProfiles({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
    settings.restoreClipboard = false;
  } catch {
    settings = ensureConnectionProfiles({ ...DEFAULT_SETTINGS });
  }
}

/* ensureConnectionProfiles imported from ./settings/connection-profiles */

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
  const next = ensureConnectionProfiles({ ...settings, ...nextSettings });
  const shortCheck = validateHotkey(next.hotkey, { otherHotkeys: [next.meetingHotkey] });
  if (!shortCheck.ok) throw new Error(`短语音快捷键：${shortCheck.message}`);
  const meetingCheck = validateHotkey(next.meetingHotkey, { otherHotkeys: [next.hotkey] });
  if (!meetingCheck.ok) throw new Error(`长内容快捷键：${meetingCheck.message}`);
  next.hotkey = shortCheck.accelerator;
  next.meetingHotkey = meetingCheck.accelerator;
  settings = next;
  settings.transcriptionMode = normalizeTranscriptionMode(settings.transcriptionMode);
  settings.asrMode = normalizeAsrMode(settings.asrMode);
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
  if (!shortcutCaptureSuspended) await registerHotkey();
  return settings;
}

async function checkHotkeyAvailability(payload = {}) {
  const kind = payload.kind === "meeting" ? "meeting" : "short";
  const field = kind === "meeting" ? "meetingHotkey" : "hotkey";
  const otherField = kind === "meeting" ? "hotkey" : "meetingHotkey";
  const staticCheck = validateHotkey(payload.accelerator, {
    otherHotkeys: [settings[otherField]]
  });
  if (!staticCheck.ok) return staticCheck;

  const current = normalizeAccelerator(settings[field]);
  if (staticCheck.accelerator === current && registeredHotkeys.includes(current)) return staticCheck;

  let registered = false;
  try {
    registered = globalShortcut.register(staticCheck.accelerator, () => {});
  } catch {
    registered = false;
  } finally {
    if (registered) globalShortcut.unregister(staticCheck.accelerator);
  }
  return validateHotkey(staticCheck.accelerator, {
    otherHotkeys: [settings[otherField]],
    registrationFailed: !registered
  });
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
  installNativeResizeHitTest(mainWindow);
  mainWindow.on("maximize", () => mainWindow.webContents.send("window-maximized", true));
  mainWindow.on("unmaximize", () => mainWindow.webContents.send("window-maximized", false));
  mainWindow.on("blur", () => {
    mainWindow.webContents.send("window-blur");
  });
}

function installNativeResizeHitTest(win) {
  if (os.platform() !== "win32" || !win || typeof win.hookWindowMessage !== "function") return;
  const WM_NCHITTEST = 0x0084;
  const HIT = {
    left: 10,
    right: 11,
    top: 12,
    topLeft: 13,
    topRight: 14,
    bottom: 15,
    bottomLeft: 16,
    bottomRight: 17
  };
  win.hookWindowMessage(WM_NCHITTEST, () => {
    if (win.isDestroyed() || win.isMaximized() || !win.isResizable()) return;
    if (!["settings", "meeting", "file"].includes(windowMode)) return;
    const bounds = win.getBounds();
    const point = screen.getCursorScreenPoint();
    const margin = 8;
    const left = point.x >= bounds.x && point.x <= bounds.x + margin;
    const right = point.x >= bounds.x + bounds.width - margin && point.x <= bounds.x + bounds.width;
    const top = point.y >= bounds.y && point.y <= bounds.y + margin;
    const bottom = point.y >= bounds.y + bounds.height - margin && point.y <= bounds.y + bounds.height;
    let result = 0;
    if (top && left) result = HIT.topLeft;
    else if (top && right) result = HIT.topRight;
    else if (bottom && left) result = HIT.bottomLeft;
    else if (bottom && right) result = HIT.bottomRight;
    else if (left) result = HIT.left;
    else if (right) result = HIT.right;
    else if (top) result = HIT.top;
    else if (bottom) result = HIT.bottom;
    if (result) win.setWindowMessageResult(result);
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
  if (!mainWindow || mainWindow.isDestroyed()) return;
  targetWindowHandle = "";
  logEvent("settings: show in main window");
  setWindowMode("settings");
  prepareWindowForDisplay(mainWindow, "settings");
  mainWindow.show();
  enforceWindowGeometry(mainWindow, "settings");
  focusWindow(mainWindow, "settings", { topmost: false });
  sendWhenLoaded(mainWindow, "open-settings");
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

function showMeetingWorkspace() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  targetWindowHandle = "";
  logEvent("meeting: show workspace");
  // Prefer a single open-meeting event; window-mode is still emitted for
  // non-meeting transitions via setWindowMode, but meeting entry uses open-meeting only.
  windowMode = "meeting";
  prepareWindowForDisplay(mainWindow, "meeting");
  mainWindow.show();
  enforceWindowGeometry(mainWindow, "meeting");
  focusWindow(mainWindow, "meeting", { topmost: false });
  sendWhenLoaded(mainWindow, "open-meeting");
}

function showFileTranscriptionWorkspace() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  targetWindowHandle = "";
  logEvent("file: show workspace");
  windowMode = "file";
  prepareWindowForDisplay(mainWindow, "file");
  mainWindow.show();
  enforceWindowGeometry(mainWindow, "file");
  focusWindow(mainWindow, "file", { topmost: false });
  sendWhenLoaded(mainWindow, "open-file");
}

function setWindowMode(mode) {
  windowMode = mode;
  if (!mainWindow) return;
  logEvent("window: mode", mode);
  enforceWindowGeometry(mainWindow, mode);
  // Meeting workspace is opened via open-meeting only (avoid dual-entry races).
  if (mode !== "meeting") {
    mainWindow.webContents.send("window-mode", mode);
  }
}

function enforceWindowGeometry(win, mode = windowMode) {
  if (!win || win.isDestroyed()) return;
  const size = WINDOW_SIZES[mode] || WINDOW_SIZES.compact;
  const isSettings = mode === "settings";
  const isMeeting = mode === "meeting";
  const isFile = mode === "file";
  const resizable = isSettings || isMeeting || isFile;
  if (isMeeting || isFile) {
    win.setMinimumSize(960, 640);
  } else if (isSettings) {
    win.setMinimumSize(720, 560);
  } else {
    win.setMinimumSize(1, 1);
  }
  if (!resizable && win.isMaximized()) win.unmaximize();
  win.setResizable(resizable);
  if (!win.isMaximized() && (mode !== "recording" || !win.isVisible())) {
    win.setContentSize(size.width, size.height, false);
    win.setBounds({ ...win.getBounds(), width: size.width, height: size.height }, false);
  }
  setWindowAlwaysOnTop(win, !isSettings && !isMeeting && !isFile);
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
  setWindowAlwaysOnTop(win, mode !== "settings");
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
  const shortHotkey = normalizeAccelerator(settings.hotkey?.trim() || DEFAULT_SETTINGS.hotkey) || DEFAULT_SETTINGS.hotkey;
  const meetingHotkey = normalizeAccelerator(settings.meetingHotkey?.trim() || DEFAULT_SETTINGS.meetingHotkey) || DEFAULT_SETTINGS.meetingHotkey;
  const list = [];
  if (shortHotkey) list.push({ accelerator: shortHotkey, action: "short" });
  if (meetingHotkey && meetingHotkey !== shortHotkey) list.push({ accelerator: meetingHotkey, action: "meeting" });
  return list;
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
  if (!hotkeyHelperProcess) return Promise.resolve();
  const child = hotkeyHelperProcess;
  hotkeyHelperProcess = null;
  child.stdout?.removeAllListeners();
  child.stderr?.removeAllListeners();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("exit", finish);
    child.kill();
    setTimeout(finish, 300);
  });
}

async function unregisterConfiguredHotkeys() {
  await stopWindowsHotkeyHelper();
  for (const accelerator of registeredHotkeys) {
    try {
      globalShortcut.unregister(accelerator);
    } catch {
      // The Windows helper owns these registrations on Windows.
    }
  }
  registeredHotkeys = [];
  registeredHotkeyMap = {};
}

async function suspendConfiguredHotkeys() {
  if (shortcutCaptureSuspended) return { ok: true };
  shortcutCaptureSuspended = true;
  await unregisterConfiguredHotkeys();
  logEvent("hotkey: suspended for capture");
  return { ok: true };
}

async function resumeConfiguredHotkeys() {
  if (!shortcutCaptureSuspended) return { ok: true };
  shortcutCaptureSuspended = false;
  await registerHotkey();
  logEvent("hotkey: resumed after capture");
  return { ok: true };
}

async function registerHotkey() {
  logEvent("hotkey: register start", JSON.stringify(hotkeyCandidates()));
  await unregisterConfiguredHotkeys();
  failedHotkeys = [];

  const candidates = hotkeyCandidates();
  if (os.platform() === "win32") {
    await startWindowsHotkeyHelper(candidates);
    logEvent("hotkey: register done", `registered=${registeredHotkeys.join(",")} failed=${failedHotkeys.join(",")}`);
    return;
  }

  for (const candidate of candidates) {
    const { accelerator, action } = candidate;
    try {
      const ok = globalShortcut.register(accelerator, () => runHotkeyAction(action));
      if (ok) {
        registeredHotkeys.push(accelerator);
        registeredHotkeyMap[accelerator] = action;
      } else {
        failedHotkeys.push(accelerator);
        console.warn(`Failed to register hotkey: ${accelerator}`);
      }
    } catch (error) {
      failedHotkeys.push(accelerator);
      console.warn(`Invalid hotkey: ${accelerator}`, error);
    }
  }
}

function runHotkeyAction(action) {
  if (windowMode === "settings") {
    logEvent("hotkey: ignored while editing settings", action || "short");
    return;
  }
  if (action === "meeting") {
    showMeetingWorkspace();
    return;
  }
  showAndStart();
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
    const spec = parseWindowsHotkey(candidate.accelerator);
    if (spec) {
      specs.push({ ...spec, action: candidate.action });
    } else {
      failedHotkeys.push(candidate.accelerator);
      console.warn(`Invalid Windows hotkey: ${candidate.accelerator}`);
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
  const actionsByLabel = new Map(specs.map((spec) => [spec.label, spec.action]));
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
        handleWindowsHotkeyHelperLine(line, expectedLabels, seenLabels, actionsByLabel);
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

function handleWindowsHotkeyHelperLine(line, expectedLabels, seenLabels, actionsByLabel) {
  logEvent("hotkey-helper: line", line);
  const [eventName, label, detail] = String(line || "").split("\t");
  if (!eventName || !label) return;

  if (eventName === "REGISTERED") {
    if (!registeredHotkeys.includes(label)) registeredHotkeys.push(label);
    registeredHotkeyMap[label] = actionsByLabel.get(label) || "short";
    seenLabels.add(label);
  } else if (eventName === "FAILED") {
    if (!failedHotkeys.includes(label)) failedHotkeys.push(label);
    seenLabels.add(label);
    console.warn(`Failed to register Windows hotkey: ${label}${detail ? ` (${detail})` : ""}`);
  } else if (eventName === "HOTKEY" && expectedLabels.has(label)) {
    runHotkeyAction(actionsByLabel.get(label) || registeredHotkeyMap[label]);
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
    { label: "文件转写", click: showFileTranscriptionWorkspace },
    { label: "会议工作台", click: showMeetingWorkspace },
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
  return voicePipeline?.resolveApiKey() || settings.asrApiKey || "";
}

function resolveBaseUrl(apiKey) {
  return voicePipeline?.resolveBaseUrl(apiKey) || "https://api.xiaomimimo.com/v1";
}

function qwenRealtimeSettings() {
  return {
    apiKey: settings.asrApiKey || process.env.QWEN_ASR_API_KEY || process.env.DASHSCOPE_API_KEY || "",
    model: settings.asrRealtimeModel || settings.asrModel || "qwen3-asr-flash-realtime",
    language: settings.asrLanguage || "",
    enableItn: Boolean(settings.asrEnableItn)
  };
}

function funRealtimeSettings() {
  return {
    apiKey: settings.asrApiKey || process.env.FUN_ASR_API_KEY || process.env.DASHSCOPE_API_KEY || "",
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
ipcMain.handle("shortcut:check", async (_event, payload) => checkHotkeyAvailability(payload));
ipcMain.handle("shortcut:capture-start", async () => suspendConfiguredHotkeys());
ipcMain.handle("shortcut:capture-end", async () => resumeConfiguredHotkeys());
ipcMain.handle("window:compact", async (_event, isCompact) => {
  if (isCompact) {
    setWindowMode("compact");
    mainWindow?.center();
  } else {
    showSettings();
  }
});
ipcMain.handle("window:minimize", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (win && !win.isDestroyed()) win.minimize();
  return { ok: true };
});
ipcMain.handle("window:toggle-maximize", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (!win || win.isDestroyed() || !["settings", "meeting", "file"].includes(windowMode)) {
    return { ok: false, maximized: false };
  }
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  const maximized = win.isMaximized();
  win.webContents.send("window-maximized", maximized);
  return { ok: true, maximized };
});
ipcMain.handle("window:is-maximized", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  return { ok: true, maximized: Boolean(win && !win.isDestroyed() && win.isMaximized()) };
});
ipcMain.handle("window:settings", async () => showSettings());
  ipcMain.handle("window:result", async () => showResultWindow());
  ipcMain.handle("window:meeting", async () => showMeetingWorkspace());
  ipcMain.handle("window:file", async () => showFileTranscriptionWorkspace());
  ipcMain.handle("window:recording-resize", async (_event, size) => resizeRecordingWindow(size));
ipcMain.handle("app:status", async () => ({
  hasApiKey: Boolean(resolveApiKey()),
  hasSavedApiKey: Boolean(settings.asrApiKey),
  hasEnvApiKey: Boolean(
    process.env.QWEN_ASR_API_KEY || process.env.FUN_ASR_API_KEY || process.env.DASHSCOPE_API_KEY
  ),
  baseUrl: resolveBaseUrl(resolveApiKey()),
  keyKind: resolveApiKey()?.startsWith("tp-") ? "token-plan" : "regular",
  registeredHotkeys,
  registeredHotkeyMap,
  failedHotkeys,
  audioPolicy: voicePipeline?.getAudioPolicy(),
  platform: os.platform(),
  settings
}));
ipcMain.handle("window:hide", async (event) => hideWindow(BrowserWindow.fromWebContents(event.sender) || mainWindow));
ipcMain.handle("app:log", async (_event, message, detail) => logEvent(`renderer: ${message}`, detail || ""));
ipcMain.handle("voice:transcribe", async (_event, payload) => voicePipeline.transcribe(payload));
ipcMain.handle("mimo:transcribe", async (_event, payload) => voicePipeline.transcribe(payload));
ipcMain.handle("voice:segment:transcribe", async (_event, payload) => voicePipeline.transcribeSegment(payload));
ipcMain.handle("voice:clean-text", async (_event, payload) => voicePipeline.cleanText(payload));
ipcMain.handle("voice:realtime:start", async (event) => startRealtimeAsr(event));
ipcMain.handle("voice:realtime:append", async (_event, base64Audio) => appendRealtimeAudio(base64Audio));
ipcMain.handle("voice:realtime:finish", async (_event, payload) => finishRealtimeAsr(payload));
ipcMain.handle("voice:realtime:cancel", async () => stopRealtimeAsr());
ipcMain.handle("connection:test", async () => voicePipeline.testConnection());
ipcMain.handle("input:inject", async (_event, text) => injectText(text));
ipcMain.handle("clipboard:write-text", async (_event, text) => clipboard.writeText(String(text || "")));
ipcMain.handle("recording:keys:clear", async () => unregisterRecordingKeyFallbacks());

function meetingIpcError(error) {
  return sanitizeIpcError(error);
}

function pickMeetingFields(input, keys) {
  const src = input && typeof input === "object" ? input : {};
  const out = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(src, key)) out[key] = src[key];
  }
  return out;
}

async function resolveMeetingProcessMode(sessionId, requestedMode, fallbackMode = "basic") {
  const current = await getMeetingCapture().store.readSession(sessionId);
  if (!current) {
    const error = new Error("session not found");
    error.code = "session_not_found";
    throw error;
  }
  const source = current.session?.source || (current.session?.import ? "import" : "capture");
  const requested = String(requestedMode || "").trim().toLowerCase();
  if (source === "import") return "file";
  if (requested === "file" || requested === "import" || requested === "file_transcription" || requested === "file-asr") {
    const error = new Error("文件转写模式只能用于已导入的音频或视频文件");
    error.code = "file_mode_requires_import";
    throw error;
  }
  return requested || fallbackMode || "basic";
}

// Stage 0B/2B meeting lifecycle IPC — no UI, no shared state with voice:* channels.
ipcMain.handle("meeting:status", async () => {
  try {
    const service = getMeetingCapture();
    return { ok: true, lifecycle: service.getLifecycle() };
  } catch (error) {
    return meetingIpcError(error);
  }
});
ipcMain.handle("meeting:sessions:list", async (_event, payload) => {
  try {
    const requestedSource = payload?.source === "import" || payload?.source === "capture" ? payload.source : null;
    const service = getMeetingCapture();
    const processor = getMeetingProcessor();
    const sessions = await service.listSessions();
    const enriched = [];
    for (const row of sessions) {
      if (requestedSource && (row.source || "capture") !== requestedSource) continue;
      const processing = await processor.getProcessStatus(row.id);
      const rawTitle = row.title == null ? "" : String(row.title);
      const title = rawTitle.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
      let hasRaw = false;
      let hasSummary = false;
      let hasArchive = false;
      let archiveTracks = [];
      try {
        const current = await service.store.readSession(row.id);
        if (current?.sessionDir) {
          const flags = await probeSessionArtifacts(current.sessionDir, fs);
          hasRaw = flags.hasRaw;
          hasSummary = flags.hasSummary;
          hasArchive = Boolean(flags.hasArchive);
          archiveTracks = flags.archiveTracks || [];
        }
      } catch {
        hasRaw = processing?.stage === "completed";
        hasSummary = false;
      }
      // Interrupted import after restart: surface for UI re-pick
      let status = row.status;
      if (status === "importing") {
        const live = getMeetingImportJobs().getImportStatus(row.id);
        if (!live.running) status = "import_interrupted";
      }
      enriched.push({
        id: row.id,
        title,
        status,
        source: row.source || "capture",
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        recoverable: row.recoverable,
        committedCount: row.committedCount,
        hasRaw,
        hasSummary,
        hasArchive,
        archiveTracks,
        importMeta: row.importMeta || null,
        processing: processing || toProcessStatusDto(null)
      });
    }
    return { ok: true, sessions: enriched };
  } catch (error) {
    return meetingIpcError(error);
  }
});
ipcMain.handle("meeting:sessions:scan", async (_event, sessionId) => {
  try {
    const service = getMeetingCapture();
    const processor = getMeetingProcessor();
    const scanned = await service.scanSession(sessionId);
    if (!scanned) return { ok: false, error: { code: "session_not_found", message: "session not found" } };
    const processing = await processor.getProcessStatus(sessionId);
    return {
      ok: true,
      session: {
        id: scanned.id,
        status: scanned.status,
        recovery: scanned.recovery,
        tracks: scanned.tracks,
        processing: processing || toProcessStatusDto(null)
      }
    };
  } catch (error) {
    return meetingIpcError(error);
  }
});
ipcMain.handle("meeting:helper:ready", async () => {
  try {
    const service = getMeetingCapture();
    const ready = await service.ensureReady();
    return {
      ok: true,
      helperAvailable: true,
      helperPresent: Boolean(ready.helperPath)
    };
  } catch (error) {
    return buildHelperReadyErrorResponse(error);
  }
});
ipcMain.handle("meeting:session:create", async (_event, payload) => {
  try {
    const { title } = pickMeetingFields(payload, ["title"]);
    const service = getMeetingCapture();
    const created = await service.createAndPrepareSession({ title });
    return { ok: true, ...created };
  } catch (error) {
    return meetingIpcError(error);
  }
});
ipcMain.handle("meeting:capture:start", async (_event, payload) => {
  try {
    const { sessionId, deviceId, systemDeviceId, captureMode } = pickMeetingFields(payload, [
      "sessionId",
      "deviceId",
      "systemDeviceId",
      "captureMode"
    ]);
    if (!sessionId) return { ok: false, error: { code: "invalid_session_id", message: "sessionId required" } };
    const service = getMeetingCapture();
    const mode = String(captureMode || "dual").toLowerCase();
    if (mode === "microphone" || mode === "mic") {
      return await service.startMicrophone(sessionId, { deviceId });
    }
    return await service.startDual(sessionId, { deviceId, systemDeviceId });
  } catch (error) {
    return meetingIpcError(error);
  }
});
ipcMain.handle("meeting:capture:pause", async (_event, payload) => {
  try {
    const { sessionId } = pickMeetingFields(payload, ["sessionId"]);
    const service = getMeetingCapture();
    return await service.pause(sessionId);
  } catch (error) {
    return meetingIpcError(error);
  }
});
ipcMain.handle("meeting:capture:resume", async (_event, payload) => {
  try {
    const { sessionId } = pickMeetingFields(payload, ["sessionId"]);
    const service = getMeetingCapture();
    return await service.resume(sessionId);
  } catch (error) {
    return meetingIpcError(error);
  }
});
ipcMain.handle("meeting:capture:stop", async (_event, payload) => {
  try {
    const { sessionId } = pickMeetingFields(payload, ["sessionId"]);
    const service = getMeetingCapture();
    // Local-only: never starts export/ASR
    const result = await service.stop(sessionId);
    return {
      ok: true,
      ...result,
      processing: {
        stage: "idle",
        hint: "call meeting:process:start to export and transcribe"
      }
    };
  } catch (error) {
    return meetingIpcError(error);
  }
});

// Stage 2B — devices + post-process (no UI)
ipcMain.handle("meeting:devices:query", async () => {
  try {
    const service = getMeetingCapture();
    await service.ensureReady();
    const raw = await service.queryDevices();
    return { ok: true, ...sanitizeDevicesPayload(raw?.result?.result?.data || raw?.result?.data || raw) };
  } catch (error) {
    return meetingIpcError(error);
  }
});
ipcMain.handle("meeting:process:start", async (_event, payload) => {
  try {
    const { sessionId, mode, processMode, bitrateKbps } = pickMeetingFields(payload, [
      "sessionId",
      "mode",
      "processMode",
      "bitrateKbps"
    ]);
    if (!sessionId) return { ok: false, error: { code: "invalid_session_id", message: "sessionId required" } };
    const processor = getMeetingProcessor();
    const effectiveMode = await resolveMeetingProcessMode(
      sessionId,
      mode || processMode,
      settings.meetingProcessMode || "basic"
    );
    const status = await processor.processSession(sessionId, {
      mode: effectiveMode,
      bitrateKbps:
        bitrateKbps != null ? bitrateKbps : settings.meetingUploadBitrateKbps
    });
    return { ok: true, processing: status };
  } catch (error) {
    const base = meetingIpcError(error);
    if (error?.processing) base.processing = error.processing;
    return base;
  }
});
ipcMain.handle("meeting:process:status", async (_event, payload) => {
  try {
    const { sessionId } = pickMeetingFields(payload, ["sessionId"]);
    if (!sessionId) return { ok: false, error: { code: "invalid_session_id", message: "sessionId required" } };
    const processor = getMeetingProcessor();
    const status = await processor.getProcessStatus(sessionId);
    if (!status) return { ok: false, error: { code: "session_not_found", message: "session not found" } };
    return { ok: true, processing: status };
  } catch (error) {
    return meetingIpcError(error);
  }
});
ipcMain.handle("meeting:process:retry", async (_event, payload) => {
  try {
    const { sessionId, resetAttempts, mode, processMode, bitrateKbps, forceResubmit } =
      pickMeetingFields(payload, [
        "sessionId",
        "resetAttempts",
        "mode",
        "processMode",
        "bitrateKbps",
        "forceResubmit"
      ]);
    if (!sessionId) return { ok: false, error: { code: "invalid_session_id", message: "sessionId required" } };
    const processor = getMeetingProcessor();
    const effectiveMode = await resolveMeetingProcessMode(sessionId, mode || processMode, "basic");
    const status = await processor.retryProcess(sessionId, {
      resetAttempts: resetAttempts !== false,
      mode: effectiveMode,
      bitrateKbps,
      forceResubmit: forceResubmit === true
    });
    return { ok: true, processing: status };
  } catch (error) {
    const base = meetingIpcError(error);
    if (error?.processing) base.processing = error.processing;
    return base;
  }
});
ipcMain.handle("meeting:process:cancel", async (_event, payload) => {
  try {
    const { sessionId } = pickMeetingFields(payload, ["sessionId"]);
    if (!sessionId) return { ok: false, error: { code: "invalid_session_id", message: "sessionId required" } };
    const processor = getMeetingProcessor();
    const status = await processor.cancelProcess(sessionId);
    return { ok: true, processing: status };
  } catch (error) {
    return meetingIpcError(error);
  }
});
ipcMain.handle("meeting:enhanced:test", async (_event, payload) => {
  try {
    const { target } = pickMeetingFields(payload, ["target"]);
    const processor = getMeetingProcessor();
    const result = await processor.testEnhancedConnection({
      target: target || "all"
    });
    // DTO: ok/target/latency/error codes only — never bucket/region/URL/key
    return {
      ok: Boolean(result.ok),
      target: result.target || "all",
      results: Array.isArray(result.results)
        ? result.results.map((r) => ({
            ok: Boolean(r.ok),
            target: r.target,
            latencyMs: Number(r.latencyMs) || 0,
            error: r.error
              ? {
                  code: r.error.code || "error",
                  message: String(r.error.message || "").slice(0, 200)
                }
              : null
          }))
        : [],
      error: result.error
        ? {
            code: result.error.code || "error",
            message: String(result.error.message || "").slice(0, 200)
          }
        : null
    };
  } catch (error) {
    return meetingIpcError(error);
  }
});
ipcMain.handle("meeting:transcript:get", async (_event, payload) => {
  try {
    const { sessionId } = pickMeetingFields(payload, ["sessionId"]);
    if (!sessionId) return { ok: false, error: { code: "invalid_session_id", message: "sessionId required" } };
    const processor = getMeetingProcessor();
    const transcript = await processor.getRawTranscript(sessionId);
    return { ok: true, transcript };
  } catch (error) {
    return meetingIpcError(error);
  }
});

// Stage 3A — analysis (correct + structured summary)
ipcMain.handle("meeting:analysis:start", async (_event, payload) => {
  try {
    const { sessionId, template, force } = pickMeetingFields(payload, ["sessionId", "template", "force"]);
    if (!sessionId) return { ok: false, error: { code: "invalid_session_id", message: "sessionId required" } };
    const analyzer = getMeetingAnalyzer();
    const analysis = await analyzer.startAnalysis(sessionId, {
      template: template || "auto",
      force: Boolean(force)
    });
    return { ok: true, analysis };
  } catch (error) {
    return meetingIpcError(error);
  }
});
ipcMain.handle("meeting:analysis:status", async (_event, payload) => {
  try {
    const { sessionId } = pickMeetingFields(payload, ["sessionId"]);
    if (!sessionId) return { ok: false, error: { code: "invalid_session_id", message: "sessionId required" } };
    const analysis = await getMeetingAnalyzer().getAnalysisStatus(sessionId);
    return { ok: true, analysis };
  } catch (error) {
    return meetingIpcError(error);
  }
});
ipcMain.handle("meeting:analysis:retry", async (_event, payload) => {
  try {
    const { sessionId, resetAttempts } = pickMeetingFields(payload, ["sessionId", "resetAttempts"]);
    if (!sessionId) return { ok: false, error: { code: "invalid_session_id", message: "sessionId required" } };
    const analysis = await getMeetingAnalyzer().retryAnalysis(sessionId, {
      resetAttempts: resetAttempts !== false
    });
    return { ok: true, analysis };
  } catch (error) {
    return meetingIpcError(error);
  }
});
ipcMain.handle("meeting:analysis:cancel", async (_event, payload) => {
  try {
    const { sessionId } = pickMeetingFields(payload, ["sessionId"]);
    if (!sessionId) return { ok: false, error: { code: "invalid_session_id", message: "sessionId required" } };
    const analysis = await getMeetingAnalyzer().cancelAnalysis(sessionId);
    return { ok: true, analysis };
  } catch (error) {
    return meetingIpcError(error);
  }
});
ipcMain.handle("meeting:analysis:corrected", async (_event, payload) => {
  try {
    const { sessionId } = pickMeetingFields(payload, ["sessionId"]);
    if (!sessionId) return { ok: false, error: { code: "invalid_session_id", message: "sessionId required" } };
    const corrected = await getMeetingAnalyzer().getCorrectedTranscript(sessionId);
    if (!corrected) {
      return {
        ok: false,
        error: { code: "analysis_corrected_missing", message: "校订结果文件不存在，请重试分析。" }
      };
    }
    return { ok: true, corrected };
  } catch (error) {
    return meetingIpcError(error);
  }
});
ipcMain.handle("meeting:analysis:summary", async (_event, payload) => {
  try {
    const { sessionId } = pickMeetingFields(payload, ["sessionId"]);
    if (!sessionId) return { ok: false, error: { code: "invalid_session_id", message: "sessionId required" } };
    const summary = await getMeetingAnalyzer().getSummary(sessionId);
    if (!summary) {
      return {
        ok: false,
        error: { code: "analysis_summary_missing", message: "结构化总结文件不存在，请重试分析。" }
      };
    }
    return { ok: true, summary };
  } catch (error) {
    return meetingIpcError(error);
  }
});

// —— Stage 4B-core: rename / speaker-map / export / import / playback ——
ipcMain.handle("meeting:session:rename", async (_event, payload) => {
  try {
    const { sessionId, title } = pickMeetingFields(payload, ["sessionId", "title"]);
    if (!sessionId) return { ok: false, error: { code: "invalid_session_id", message: "sessionId required" } };
    const service = getMeetingCapture();
    const renamed = await service.renameSession(sessionId, title);
    return { ok: true, session: renamed };
  } catch (error) {
    return meetingIpcError(error);
  }
});

ipcMain.handle("meeting:speaker-map:get", async (_event, payload) => {
  try {
    const { sessionId } = pickMeetingFields(payload, ["sessionId"]);
    if (!sessionId) return { ok: false, error: { code: "invalid_session_id", message: "sessionId required" } };
    const service = getMeetingCapture();
    const current = await service.store.readSession(sessionId);
    if (!current) return { ok: false, error: { code: "session_not_found", message: "session not found" } };
    const map = await meetingSpeakerMap.readSpeakerMap(current.sessionDir, sessionId);
    return { ok: true, speakerMap: map };
  } catch (error) {
    return meetingIpcError(error);
  }
});

ipcMain.handle("meeting:speaker-map:set", async (_event, payload) => {
  try {
    const { sessionId, speakers } = pickMeetingFields(payload, ["sessionId", "speakers"]);
    if (!sessionId) return { ok: false, error: { code: "invalid_session_id", message: "sessionId required" } };
    const service = getMeetingCapture();
    const current = await service.store.readSession(sessionId);
    if (!current) return { ok: false, error: { code: "session_not_found", message: "session not found" } };
    const map = await meetingSpeakerMap.writeSpeakerMap(current.sessionDir, sessionId, { speakers });
    return { ok: true, speakerMap: map };
  } catch (error) {
    return meetingIpcError(error);
  }
});

ipcMain.handle("meeting:export:save", async (_event, payload) => {
  try {
    const { sessionId, format, scope } = pickMeetingFields(payload, ["sessionId", "format", "scope"]);
    if (!sessionId) return { ok: false, error: { code: "invalid_session_id", message: "sessionId required" } };
    const fmt = String(format || "markdown").toLowerCase();
    const ext =
      fmt === "json" ? "json" : fmt === "txt" || fmt === "text" ? "txt" : fmt === "srt" ? "srt" : fmt === "docx" || fmt === "word" ? "docx" : "md";
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const picked = await dialog.showSaveDialog(win, {
      title: "导出会议结果",
      defaultPath: `meeting-${sessionId}.${ext}`,
      filters: [
        { name: ext.toUpperCase(), extensions: [ext] },
        { name: "All", extensions: ["*"] }
      ]
    });
    if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true };
    const service = getMeetingCapture();
    const current = await service.store.readSession(sessionId);
    if (!current) return { ok: false, error: { code: "session_not_found", message: "session not found" } };
    const processor = getMeetingProcessor();
    const analyzer = getMeetingAnalyzer();
    let transcript = null;
    let corrected = null;
    let summary = null;
    try {
      transcript = await processor.getRawTranscript(sessionId);
    } catch {
      transcript = null;
    }
    try {
      corrected = await analyzer.getCorrectedTranscript(sessionId);
    } catch {
      corrected = null;
    }
    try {
      summary = await analyzer.getSummary(sessionId);
    } catch {
      summary = null;
    }
    const speakerMap = await meetingSpeakerMap.readSpeakerMap(current.sessionDir, sessionId);
    const report = await meetingSessionExport.writeExportFiles({
      outPath: picked.filePath,
      format: fmt,
      scope: scope || "all",
      session: current.session,
      transcript,
      corrected,
      summary,
      speakerMap
    });
    return {
      ok: report.ok !== false,
      cancelled: false,
      format: fmt,
      scope: report.scope || scope || "all",
      skippedSrt: Boolean(report.skippedSrt),
      warnings: report.warnings || [],
      files: report.files || [],
      used: report.used || null
    };
  } catch (error) {
    return meetingIpcError(error);
  }
});

ipcMain.handle("file:export:save", async (_event, payload) => {
  try {
    const { sessionId, format, scope } = pickMeetingFields(payload, ["sessionId", "format", "scope"]);
    if (!sessionId) return { ok: false, error: { code: "invalid_session_id", message: "sessionId required" } };
    const service = getMeetingCapture();
    const current = await service.store.readSession(sessionId);
    if (!current) return { ok: false, error: { code: "session_not_found", message: "session not found" } };
    if (current.session?.source !== "import" && !current.session?.import) {
      return { ok: false, error: { code: "file_session_required", message: "仅支持导入文件记录导出" } };
    }
    const fmt = String(format || "markdown").toLowerCase();
    const ext =
      fmt === "txt" || fmt === "text" ? "txt" : fmt === "docx" || fmt === "word" ? "docx" : fmt === "json" ? "json" : "md";
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const picked = await dialog.showSaveDialog(win, {
      title: "导出文件转写结果",
      defaultPath: `file-${current.session?.id || sessionId}.${ext}`,
      filters: [
        { name: ext === "docx" ? "Word" : ext.toUpperCase(), extensions: [ext] },
        { name: "All", extensions: ["*"] }
      ]
    });
    if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true };

    const processor = getMeetingProcessor();
    const analyzer = getMeetingAnalyzer();
    const transcript = await processor.getRawTranscript(sessionId).catch(() => null);
    const corrected = await analyzer.getCorrectedTranscript(sessionId).catch(() => null);
    const summary = await analyzer.getSummary(sessionId).catch(() => null);
    const speakerMap = await meetingSpeakerMap.readSpeakerMap(current.sessionDir, sessionId);
    const report = await meetingSessionExport.writeExportFiles({
      outPath: picked.filePath,
      format: fmt,
      scope: scope || "all",
      session: current.session,
      transcript,
      corrected,
      summary,
      speakerMap
    });
    return {
      ok: report.ok !== false,
      cancelled: false,
      format: fmt,
      scope: report.scope || scope || "all",
      warnings: report.warnings || [],
      files: report.files || []
    };
  } catch (error) {
    return meetingIpcError(error);
  }
});

ipcMain.handle("meeting:import:wav", async (event, payload) => {
  try {
    const { title, sessionId: reuseId, track, role } = pickMeetingFields(payload || {}, [
      "title",
      "sessionId",
      "track",
      "role"
    ]);
    return await startMeetingImportFromDialog({
      title,
      reuseId,
      kind: "wav",
      track,
      role,
      dialogTitle: "导入 WAV 音频",
      parentWindow: BrowserWindow.fromWebContents(event.sender)
    });
  } catch (error) {
    return meetingIpcError(error);
  }
});

ipcMain.handle("meeting:import:media", async (event, payload) => {
  try {
    const { title, sessionId: reuseId, track, role } = pickMeetingFields(payload || {}, [
      "title",
      "sessionId",
      "track",
      "role"
    ]);
    return await startMeetingImportFromDialog({
      title,
      reuseId,
      kind: "media",
      track,
      role,
      dialogTitle: "导入媒体",
      parentWindow: BrowserWindow.fromWebContents(event.sender)
    });
  } catch (error) {
    return meetingIpcError(error);
  }
});

ipcMain.handle("meeting:import:status", async (_event, payload) => {
  try {
    const { sessionId } = pickMeetingFields(payload || {}, ["sessionId"]);
    if (!sessionId) return { ok: false, error: { code: "invalid_session_id", message: "sessionId required" } };
    const live = getMeetingImportJobs().getImportStatus(sessionId);
    const service = getMeetingCapture();
    const current = await service.store.readSession(sessionId);
    const diskStatus = current?.session?.status || null;
    let status = live.running ? "importing" : diskStatus;
    if (diskStatus === "importing" && !live.running) status = "import_interrupted";
    return {
      ok: true,
      sessionId,
      status,
      running: Boolean(live.running),
      phase: live.phase || current?.session?.import?.phase || null,
      progress: live.progress || null,
      import: current?.session?.import
        ? {
            sourceFileName: current.session.import.sourceFileName || null,
            durationMs: current.session.import.durationMs ?? null,
            track: current.session.import.track || null,
            mediaKind: current.session.import.mediaKind || null,
            extension: current.session.import.extension || null,
            importer: current.session.import.importer || null,
            phase: live.phase || current.session.import.phase || null,
            code: current.session.import.code || null,
            message: current.session.import.message || null
          }
        : null
    };
  } catch (error) {
    return meetingIpcError(error);
  }
});

ipcMain.handle("meeting:import:cancel", async (_event, payload) => {
  try {
    const { sessionId } = pickMeetingFields(payload || {}, ["sessionId"]);
    if (!sessionId) return { ok: false, error: { code: "invalid_session_id", message: "sessionId required" } };
    const res = await getMeetingImportJobs().cancelImport(sessionId);
    return { ok: true, ...res };
  } catch (error) {
    return meetingIpcError(error);
  }
});

ipcMain.handle("meeting:playback:token", async (_event, payload) => {
  try {
    const { sessionId, track } = pickMeetingFields(payload, ["sessionId", "track"]);
    if (!sessionId) return { ok: false, error: { code: "invalid_session_id", message: "sessionId required" } };
    const service = getMeetingCapture();
    const current = await service.store.readSession(sessionId);
    if (!current) return { ok: false, error: { code: "session_not_found", message: "session not found" } };
    const want = String(track || "auto").toLowerCase();
    const prefer =
      want === "system" || want === "microphone"
        ? [want]
        : current.session?.import?.track === "system"
          ? ["system", "microphone"]
          : ["microphone", "system"];
    let t = null;
    let wavPath = null;
    for (const cand of prefer) {
      const p = path.join(current.sessionDir, "archive", `${cand}.mono.wav`);
      try {
        await fs.access(p);
        t = cand;
        wavPath = p;
        break;
      } catch {
        /* try next */
      }
    }
    if (!wavPath || !t) {
      return { ok: false, error: { code: "archive_missing", message: "no archive wav" } };
    }
    const sessionsRoot = meetingPaths.getMeetingSessionsRoot(app.getPath("userData"));
    const issued = meetingMediaToken.issuePlaybackToken({
      sessionsRoot,
      sessionId,
      absPath: wavPath
    });
    let durationMs = null;
    try {
      const sc = JSON.parse(await fs.readFile(`${wavPath}.sidecar.json`, "utf8"));
      durationMs = sc.durationMs ?? null;
    } catch {
      durationMs = null;
    }
    return {
      ok: true,
      url: issued.url,
      track: t,
      durationMs,
      expiresAt: issued.expiresAt
    };
  } catch (error) {
    return meetingIpcError(error);
  }
});

function attachMeetingPlaybackProtocolHandler() {
  const scheme = meetingMediaToken.SCHEME;
  try {
    protocol.handle(scheme, async (request) => {
      try {
        const u = new URL(request.url);
        const token = (u.pathname || "").replace(/^\//, "") || u.hostname;
        const entry = meetingMediaToken.resolvePlaybackToken(token);
        const st = await fs.stat(entry.absPath);
        const size = st.size;
        const method = String(request.method || "GET").toUpperCase();
        const rangeHeader = request.headers?.get?.("range") || request.headers?.get?.("Range") || null;
        const built = buildPlaybackHeaders({ method, size, rangeHeader, contentType: "audio/wav" });
        if (built.status === 416) {
          return new Response(null, { status: 416, headers: built.headers });
        }
        if (built.isHead || method === "HEAD") {
          return new Response(null, { status: built.status, headers: built.headers });
        }
        const stream = fssync.createReadStream(entry.absPath, {
          start: built.start,
          end: built.end,
          highWaterMark: 64 * 1024
        });
        const webStream = Readable.toWeb(stream);
        return new Response(webStream, { status: built.status, headers: built.headers });
      } catch {
        return new Response("denied", {
          status: 403,
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      }
    });
  } catch (error) {
    logEvent("meeting: playback protocol handle failed", error?.code || "handle_failed");
  }
}

// registerSchemesAsPrivileged must run before app ready (minimal privileges)
try {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: meetingMediaToken.SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: false,
        bypassCSP: false
      }
    }
  ]);
} catch {
  // ignore if already registered / too late
}

app.whenReady().then(async () => {
  logEvent("app: ready");
  attachMeetingPlaybackProtocolHandler();
  await loadSettings();
  voicePipeline = createVoicePipeline({ getSettings: () => settings, logEvent });
  logEvent("settings: loaded", JSON.stringify({ hotkey: settings.hotkey, microphoneDeviceId: settings.microphoneDeviceId, transcriptionMode: settings.transcriptionMode }));
  configurePermissions();
  createWindow();
  createTray();
  await registerHotkey();
  setWindowMode("compact");
  if (process.argv.includes("--settings")) {
    showSettings();
  } else if (resolveApiKey()) {
    mainWindow.hide();
  } else {
    showSettings();
  }
  logEvent("app: initialized");
});

function cleanupHotkeysAndShortcuts() {
  unregisterRecordingKeyFallbacks();
  stopWindowsHotkeyHelper();
  globalShortcut.unregisterAll();
}

async function shutdownMeetingCaptureBounded(timeoutMs = MEETING_QUIT_TIMEOUT_MS) {
  if (meetingImportJobs) {
    const jobs = meetingImportJobs;
    meetingImportJobs = null;
    await Promise.race([
      jobs.shutdown(Math.min(2000, timeoutMs)).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, Math.min(2000, timeoutMs)))
    ]);
  }
  if (meetingAnalyzer) {
    const az = meetingAnalyzer;
    meetingAnalyzer = null;
    await Promise.race([
      az.shutdown().catch((error) => {
        logEvent("meeting-analysis: shutdown error", error?.message || String(error));
      }),
      new Promise((resolve) => setTimeout(resolve, Math.min(2000, timeoutMs)))
    ]);
  }
  if (meetingProcessor) {
    const proc = meetingProcessor;
    meetingProcessor = null;
    await Promise.race([
      proc.shutdown().catch((error) => {
        logEvent("meeting-process: shutdown error", error?.message || String(error));
      }),
      new Promise((resolve) => setTimeout(resolve, Math.min(2000, timeoutMs)))
    ]);
  }
  if (!meetingCapture) return;
  const service = meetingCapture;
  meetingCapture = null;
  await Promise.race([
    service.shutdown().catch((error) => {
      logEvent("meeting: shutdown error", error?.message || String(error));
    }),
    new Promise((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}

// Bounded meeting helper cleanup before process exit. preventDefault once, then app.exit.
app.on("before-quit", (event) => {
  if (meetingQuitCleanupStarted) return;
  meetingQuitCleanupStarted = true;
  event.preventDefault();
  logEvent("app: before-quit meeting cleanup");
  cleanupHotkeysAndShortcuts();
  shutdownMeetingCaptureBounded()
    .catch(() => {})
    .finally(() => {
      // Final exit line is enqueued inside close() then flushed before app.exit.
      const writer = runtimeLogWriter || getRuntimeLogWriter();
      const done = writer?.close?.("app: before-quit cleanup done") || Promise.resolve();
      Promise.resolve(done)
        .catch(() => {})
        .finally(() => app.exit(0));
    });
});

app.on("will-quit", () => {
  // Writer is closed in before-quit; do not enqueue after close.
  // Hotkeys already cleaned in before-quit when that path runs; keep as safety net.
  cleanupHotkeysAndShortcuts();
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
