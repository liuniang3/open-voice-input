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
  shell,
  Tray
} = require("electron");
const { execFile, execFileSync, spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { Readable } = require("node:stream");
const { createRuntimeLogWriter } = require("./runtime-log");
const { createVoicePipeline } = require("./providers/voice-pipeline");
const { testProviderConnection } = require("./providers/provider-connection-test");
const { listProviderModels } = require("./providers/provider-model-catalog");
const { createQwenRealtimeSession, isQwenAudioStreamingModel } = require("./providers/asr/qwen-realtime-session");
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
const { resolveProviderConnection } = require("./settings/provider-connections");
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

const RESIZABLE_WINDOW_MODES = new Set(["settings", "result", "meeting", "file"]);

const DEFAULT_SETTINGS = {
  hotkey: "CommandOrControl+Alt+M",
  meetingHotkey: "CommandOrControl+Alt+Shift+M",
  model: "mimo-v2.5",
  apiKey: "",
  baseUrl: "",
  asrProvider: "mimo",
  asrMode: "batch",
  asrModel: "mimo-v2.5-asr",
  asrRealtimeModel: "qwen-audio-3.0-asr-flash-streaming",
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
  // Credentials are shared only inside a provider family; model-specific maps
  // remain as migration/fallback data for custom third-party endpoints.
  providerConnections: {
    mimo: {
      provider: "mimo",
      baseUrl: "https://api.xiaomimimo.com/v1",
      apiKey: "",
      apiStyle: "chat-completions"
    },
    aliyun: {
      provider: "aliyun",
      baseUrl: "https://dashscope.aliyuncs.com",
      apiKey: ""
    },
    openai: {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      apiStyle: "responses"
    },
    "opencode-go": {
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "",
      apiStyle: "chat-completions"
    }
  },
  openaiModelCatalog: [],
  openaiModelCapabilities: {},
  openaiModelCatalogUpdatedAt: "",
  openCodeGoModelCatalog: [],
  openCodeGoModelCapabilities: {},
  openCodeGoModelCatalogUpdatedAt: "",
  // Meeting-scoped model choices and non-provider storage settings.
  meetingMicrophoneDeviceId: "",
  meetingSystemDeviceId: "",
  meetingCaptureMode: "dual",
  meetingRealtimeDestination: "",
  meetingRealtimeModel: "qwen-audio-3.0-asr-flash-streaming",
  meetingTranscriptionIntervalSeconds: 30,
  meetingAutosaveIntervalSeconds: 30,
  meetingQwenApiKey: "",
  meetingQwenBaseUrl: "",
  meetingQwenModel: "qwen-audio-3.0-asr-flash-streaming",
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
  meetingAnalysisTimeoutMs: 120000,
  updateAutoCheck: true
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
let realtimeMeeting = null;
let liveStartPromise = null;
let liveStopPromise = null;
let liveRecoveryPromise = null;
let liveActionPromise = null;
let liveControlPromise = null;
let liveWindowFlags = { floating: false, compact: false, alwaysOnTop: false };
let liveWindowRestore = null;
let captureOwner = null;
let legacySessionId = null;
let legacyCapturePending = false;
let shortStartPending = false;
let macUtilities = null;
const liveOutputPaths = new Set();
let meetingQuitCleanupStarted = false;
let updateService = null;
let updateStartupTimer = null;
let updateIntervalTimer = null;
const MEETING_QUIT_TIMEOUT_MS = 15000;
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

function getMacUtilities() {
  if (os.platform() !== "darwin") return null;
  if (!macUtilities) macUtilities = require("./platform/macos");
  return macUtilities;
}

function liveError(code) {
  return Object.assign(new Error(code), { code });
}

function liveIpcError(error) {
  const messages = {
    capture_busy: "已有录音正在进行，请先停止当前录音。",
    live_busy: "当前会议仍在处理，请等待完成后重试。",
    live_session_invalid: "会议已切换，请刷新当前会议后重试。",
    live_cleanup_not_ready: "请等待录音和转写完成后再清理。",
    live_summary_not_ready: "请等待录音和转写完成后再总结。",
    live_no_text: "当前会议没有可处理的文本。",
    live_pause_failed: "暂停失败，请检查录音状态后重试。",
    live_resume_failed: "恢复录音失败，请检查录音状态后重试。",
    live_review_failed: "音频复核失败，原始文本与音频已保留。",
    live_summary_failed: "总结失败，已有文本与音频已保留。",
    live_connection_failed: "实时模型连接测试失败，请检查该模型的凭据、地域地址和网络。",
    window_mode_unavailable: "请先打开会议实时转录。",
    app_quitting: "应用正在退出，请稍后重新打开。",
    microphone_permission: "请在系统设置中允许麦克风访问后重试。",
    screen_permission: "请在系统设置中允许屏幕与系统音频录制，或改用仅麦克风模式。",
    accessibility_permission: "文本已复制，请允许辅助功能权限后使用自动粘贴。",
    invalid_payload: "请求参数无效。",
    path_not_allowed: "只能打开当前服务生成的 Markdown 或 WAV 文件。",
    open_path_failed: "无法打开文件，请确认文件存在且有可用的应用。",
    untrusted_sender: "此页面无权执行该操作。",
    permission_unavailable: "此平台不支持该权限设置入口。",
    live_credentials_missing: "所选模型未配置独立凭据，请在设置中配置该模型。",
    live_model_unsupported: "所选模型不支持会议转写，请选择可用的 ASR 模型。",
    live_asr_token_plan_unsupported: "当前凭据类型不支持会议转写，请检查模型配置。",
    live_audio_failed: "音频归档失败，原始片段仍保留，请检查磁盘后重试。",
    live_save_failed: "Markdown 保存失败，请检查文件权限、磁盘空间或外部编辑。",
    live_asr_failed: "转写失败，录音已保留，请检查模型配置或网络后重试。",
    live_cleanup_failed: "清理失败，原始文本和录音保留，请检查清理模型配置。",
    live_cleanup_validation_failed: "清理结果未通过校验，原始文本未修改。",
    live_capture_failed: "录音失败，请检查系统权限及音频设备。",
    live_stop_failed: "尚未确认录音停止，请重试停止；应用不会提前退出。"
  };
  const code = Object.hasOwn(messages, error?.code) ? error.code
    : Object.hasOwn(messages, error?.message) ? error.message : "meeting_live_failed";
  return { ok: false, error: { code, message: messages[code] || "会议操作失败，请检查模型配置、系统权限和本地文件后重试。" } };
}

function liveClaimDto(node) {
  if (!node || typeof node !== "object" || Array.isArray(node) || typeof node.text !== "string") return null;
  return {
    text: node.text, uncertain: node.uncertain === true,
    provenance: Array.isArray(node.provenance) ? node.provenance.slice(0, 256).map(item =>
      Object.fromEntries(Object.entries(pickMeetingFields(item, ["sourceId", "quote", "source", "startFrame", "endFrame", "charStart", "charEnd"]))
        .filter(([, field]) => typeof field === "string" || typeof field === "number" && Number.isFinite(field)))) : []
  };
}

function liveMindmapDto(root) {
  let remaining = 1000;
  const visit = (node, depth = 0) => {
    if (depth > 32 || remaining-- <= 0) return null;
    const claim = liveClaimDto(node);
    if (!claim) return null;
    return {
      ...claim,
      children: Array.isArray(node.children) ? node.children.slice(0, 1000).map(child => visit(child, depth + 1)).filter(Boolean) : []
    };
  };
  return visit(root);
}

function liveDto(value = {}) {
  if (value?.ok === false) throw liveError(value.error?.code || "meeting_live_failed");
  const dto = pickMeetingFields(value, [
    "sessionId", "title", "status", "recording", "rawText", "correctedText", "markdownPath",
    "cleanedMarkdownPath", "audioPaths", "pendingSegments", "failedSegments", "lastSavedAt",
    "cleanupStatus", "modelId", "startedAtMs", "durationMs", "captureMode", "cleanupModelId",
    "finalizationPending", "paused", "previewText", "previewStatus", "reviewedText",
    "reviewedMarkdownPath", "summaryMarkdownPath", "postprocessStatus", "transport",
    "transcriptionIntervalSeconds", "saveIntervalSeconds"
  ]);
  // Nested service objects also cross the trust boundary; never forward provider bodies.
  for (const key of Object.keys(dto)) {
    if (dto[key] !== null && !["string", "number", "boolean"].includes(typeof dto[key]) && key !== "audioPaths") delete dto[key];
  }
  const validPath = (file) => typeof file === "string" && path.isAbsolute(file) && /\.(md|wav)$/i.test(file);
  for (const key of ["markdownPath", "cleanedMarkdownPath", "reviewedMarkdownPath", "summaryMarkdownPath"]) {
    if (dto[key] && !validPath(dto[key])) delete dto[key];
  }
  dto.audioPaths = Array.isArray(value.audioPaths) ? value.audioPaths.filter(validPath)
    : Object.fromEntries(Object.entries(pickMeetingFields(value.audioPaths, ["microphone", "system", "mixed"])).filter(([, file]) => validPath(file)));
  for (const key of ["cleanupProgress", "postprocessProgress"]) {
    dto[key] = Object.fromEntries(Object.entries(pickMeetingFields(value[key], ["completed", "total", "failed", "kind", "stage"]))
      .filter(([field, item]) => ["kind", "stage"].includes(field) ? typeof item === "string" : typeof item === "number" && Number.isFinite(item)));
  }
  dto.summary = value.summary ? {
    ...Object.fromEntries(Object.entries(pickMeetingFields(value.summary, ["title", "markdown"]))
      .filter(([, item]) => typeof item === "string")),
    mindmap: liveMindmapDto(value.summary.mindmap),
    ...(Array.isArray(value.summary.sections) ? {
      sections: value.summary.sections.slice(0, 1000)
        .filter(section => section && typeof section === "object" && !Array.isArray(section) && typeof section.heading === "string")
        .map(section => ({ heading: section.heading,
          items: Array.isArray(section.items) ? section.items.slice(0, 1000).map(liveClaimDto).filter(Boolean) : [] }))
    } : {})
  } : null;
  dto.recoverableSessions = Array.isArray(value.recoverableSessions) ? value.recoverableSessions.map((item) =>
    Object.fromEntries(Object.entries(pickMeetingFields(item, [
      "sessionId", "title", "status", "startedAtMs", "durationMs", "modelId",
      "hasTranscript", "hasCorrection", "hasSummary"
    ])).filter(([, field]) => ["string", "number", "boolean"].includes(typeof field)))) : [];
  dto.window = { ...liveWindowFlags };
  dto.error = value.error ? liveIpcError(value.error).error : null;
  const remember = (file) => {
    if (typeof file === "string" && path.isAbsolute(file) && /\.(md|wav)$/i.test(file)) {
      liveOutputPaths.add(path.resolve(file));
    }
  };
  remember(dto.markdownPath);
  remember(dto.cleanedMarkdownPath);
  remember(dto.reviewedMarkdownPath);
  remember(dto.summaryMarkdownPath);
  for (const file of Object.values(dto.audioPaths || {})) remember(file);
  return dto;
}

function publishLiveUpdate(value) {
  const active = realtimeMeeting?.status();
  if (value?.sessionId && active?.sessionId && value.sessionId !== active.sessionId) return;
  const dto = liveDto(value);
  if (captureOwner === "live" && !liveStartPromise && !liveStopPromise && !dto.recording && !dto.paused
    && ["completed", "needs_retry", "interrupted", "failed"].includes(dto.status)) {
    captureOwner = null;
  }
  if (mainWindow && !mainWindow.isDestroyed()) sendWhenLoaded(mainWindow, "meeting:live:update", dto);
}

function getRealtimeMeeting() {
  if (!realtimeMeeting) {
    const { createRealtimeMeetingService } = require("./meeting/realtime");
    realtimeMeeting = createRealtimeMeetingService({
      captureService: getMeetingCapture(),
      getSettings: () => structuredClone(settings),
      defaultDirectory: path.join(app.getPath("documents"), APP_DISPLAY_NAME, "Meetings"),
      onUpdate: publishLiveUpdate,
      logger: () => logEvent("meeting-live: service event")
    });
  }
  return realtimeMeeting;
}

function assertCaptureAvailable(owner) {
  if (meetingQuitCleanupStarted) throw liveError("app_quitting");
  if (captureOwner && captureOwner !== owner) throw liveError("capture_busy");
  if (owner !== "live" && (liveStartPromise || liveStopPromise || liveControlPromise || realtimeMeeting?.status().recording || realtimeMeeting?.status().paused)) {
    throw liveError("capture_busy");
  }
}

async function requireCapturePermissions(mode) {
  const mac = getMacUtilities();
  if (!mac) return;
  if (mode !== "system" && !await mac.requestMicrophoneAccess()) throw liveError("microphone_permission");
  let permissions = mac.getPermissionStatus();
  if (["dual", "system"].includes(mode) && permissions.screen === "not-determined") {
    await mac.requestScreenAccess();
    permissions = mac.getPermissionStatus();
  }
  if (["dual", "system"].includes(mode) && ["denied", "restricted", "not-determined"].includes(permissions.screen)) {
    throw liveError("screen_permission");
  }
}

function livePostprocessBusy(current = realtimeMeeting?.status()) {
  return [current?.cleanupStatus, current?.postprocessStatus].some(status =>
    ["running", "reviewing", "cleaning", "summarizing", "pending"].includes(status));
}

function startLiveMeeting(payload = {}) {
  if (meetingQuitCleanupStarted) return Promise.reject(liveError("app_quitting"));
  if (liveStartPromise) return liveStartPromise;
  if (liveActionPromise || liveControlPromise || livePostprocessBusy()) throw liveError("live_busy");
  if (liveStopPromise) return liveStopPromise.then(() => getRealtimeMeeting().status());
  const current = realtimeMeeting?.status();
  if (current?.recording || current?.paused || current?.status === "stopping") return Promise.resolve(current);
  if (current?.finalizationPending) throw liveError("live_busy");
  assertCaptureAvailable("live");
  captureOwner = "live";
  liveStartPromise = (async () => {
    if (liveRecoveryPromise) await liveRecoveryPromise;
    const input = pickMeetingFields(payload, ["destinationPath", "title", "captureMode", "modelId", "provider",
      "transcriptionIntervalSeconds", "saveIntervalSeconds"]);
    for (const value of [input.destinationPath, input.title, input.captureMode, input.modelId, input.provider].filter(value => value !== undefined)) {
      if (typeof value !== "string" || value.length > 4096) throw liveError("invalid_payload");
    }
    for (const [field, min, max] of [["transcriptionIntervalSeconds", 5, 30], ["saveIntervalSeconds", 5, 300]]) {
      if (!Object.hasOwn(input, field)) continue;
      if (!Number.isInteger(input[field]) || input[field] < min || input[field] > max) throw liveError("invalid_payload");
    }
    input.captureMode ||= settings.meetingCaptureMode || "dual";
    input.modelId ||= settings.meetingRealtimeModel || "qwen-audio-3.0-asr-flash-streaming";
    if (!["dual", "microphone", "system"].includes(input.captureMode)) throw liveError("invalid_payload");
    if (!Object.hasOwn(input, "destinationPath") && settings.meetingRealtimeDestination) {
      input.destinationPath = settings.meetingRealtimeDestination;
    }
    if (input.destinationPath && (!path.isAbsolute(input.destinationPath) || !/\.md$/i.test(input.destinationPath))) {
      throw liveError("invalid_payload");
    }
    await requireCapturePermissions(input.captureMode);
    if (meetingQuitCleanupStarted) throw liveError("app_quitting");
    return await getRealtimeMeeting().start(input);
  })().catch((error) => {
    if (!realtimeMeeting?.status().recording && !realtimeMeeting?.status().paused) captureOwner = null;
    throw error;
  }).finally(() => { liveStartPromise = null; });
  return liveStartPromise;
}

function stopLiveMeeting() {
  if (liveStopPromise) return liveStopPromise;
  liveStopPromise = (async () => {
    if (liveStartPromise) await liveStartPromise.catch(() => {});
    if (liveRecoveryPromise) await liveRecoveryPromise;
    if (liveActionPromise) await liveActionPromise.catch(() => {});
    if (liveControlPromise) await liveControlPromise.catch(() => {});
    const result = await getRealtimeMeeting().stop();
    if (result.recording || result.paused) throw liveError("live_stop_failed");
    // B returns only once the local capture tail is drained; ASR may still be stopping.
    if (captureOwner === "live") captureOwner = null;
    return result;
  })().finally(() => { liveStopPromise = null; });
  return liveStopPromise;
}

function recoverLiveMeeting(payload = {}) {
  if (livePostprocessBusy()) throw liveError("live_busy");
  if (captureOwner || liveStartPromise || liveStopPromise || liveActionPromise || liveControlPromise
    || realtimeMeeting?.status().recording || realtimeMeeting?.status().paused || realtimeMeeting?.status().status === "stopping") {
    throw liveError("capture_busy");
  }
  if (liveRecoveryPromise) return liveRecoveryPromise;
  const input = pickMeetingFields(payload, ["sessionId"]);
  if (input.sessionId != null && (typeof input.sessionId !== "string" || input.sessionId.length > 256)) {
    throw liveError("invalid_payload");
  }
  liveRecoveryPromise = Promise.resolve().then(() => getRealtimeMeeting().recover(input))
    .finally(() => { liveRecoveryPromise = null; });
  return liveRecoveryPromise;
}

function openLiveMeetingHistory(payload = {}) {
  if (livePostprocessBusy()) throw liveError("live_busy");
  if (captureOwner || liveStartPromise || liveStopPromise || liveActionPromise || liveControlPromise
    || realtimeMeeting?.status().recording || realtimeMeeting?.status().paused || realtimeMeeting?.status().status === "stopping") {
    throw liveError("capture_busy");
  }
  if (liveRecoveryPromise) return liveRecoveryPromise;
  const input = pickMeetingFields(payload, ["sessionId"]);
  if (typeof input.sessionId !== "string" || !input.sessionId || input.sessionId.length > 256) {
    throw liveError("invalid_payload");
  }
  liveRecoveryPromise = Promise.resolve().then(() => getRealtimeMeeting().openHistory(input))
    .finally(() => { liveRecoveryPromise = null; });
  return liveRecoveryPromise;
}

async function showCaptureError(error) {
  const safe = liveIpcError(error);
  const kind = { microphone_permission: "microphone", screen_permission: "screen", accessibility_permission: "accessibility" }[safe.error.code];
  const result = await dialog.showMessageBox(mainWindow, {
    type: "warning", title: APP_DISPLAY_NAME, message: safe.error.message,
    buttons: kind ? ["打开系统设置", "取消"] : ["确定"], defaultId: 0, cancelId: kind ? 1 : 0
  });
  if (kind && result.response === 0) await getMacUtilities()?.openPermissionSettings(kind);
}

function showAndStartLiveMeeting() {
  if (captureOwner && captureOwner !== "live") {
    void showCaptureError(liveError("capture_busy")).catch(() => {});
    return;
  }
  showMeetingWorkspace();
  void Promise.resolve().then(() => startLiveMeeting()).then(publishLiveUpdate).catch((error) => {
    publishLiveUpdate({ ...realtimeMeeting?.status(), error });
    return showCaptureError(error);
  }).catch(() => {});
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
    const saved = JSON.parse(raw);
    if (!saved.meetingQwenModel && saved.meetingQwenApiKey) saved.meetingQwenModel = "qwen3-asr-flash";
    settings = ensureConnectionProfiles({ ...DEFAULT_SETTINGS, ...saved });
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
  const next = ensureConnectionProfiles({ ...settings, ...nextSettings,
    meetingRealtimeDestination: settings.meetingRealtimeDestination });
  const shortCheck = validateHotkey(next.hotkey, { otherHotkeys: [next.meetingHotkey] });
  if (!shortCheck.ok) throw new Error(`短语音快捷键：${shortCheck.message}`);
  const meetingCheck = validateHotkey(next.meetingHotkey, { otherHotkeys: [next.hotkey] });
  if (!meetingCheck.ok) throw new Error(`实时会议快捷键：${meetingCheck.message}`);
  next.hotkey = shortCheck.accelerator;
  next.meetingHotkey = meetingCheck.accelerator;
  settings = next;
  settings.transcriptionMode = normalizeTranscriptionMode(settings.transcriptionMode);
  settings.asrMode = normalizeAsrMode(settings.asrMode);
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
  if (!shortcutCaptureSuspended) await registerHotkey();
  configureUpdateSchedule();
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
  const isWindows = os.platform() === "win32";
  mainWindow = new BrowserWindow({
    width: WINDOW_SIZES.compact.width,
    height: WINDOW_SIZES.compact.height,
    useContentSize: true,
    show: false,
    frame: false,
    thickFrame: isWindows,
    movable: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: os.platform() !== "darwin",
    icon: APP_ICON_PATH,
    // Electron/Chromium cannot provide reliable resize hit-testing for a
    // transparent frameless HWND. Acrylic keeps the visual treatment while
    // preserving the native Windows resize frame and cursor.
    transparent: !isWindows,
    backgroundColor: isWindows ? "#eef4f1" : "#00000000",
    ...(isWindows ? { backgroundMaterial: "acrylic" } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("maximize", () => mainWindow.webContents.send("window-maximized", true));
  mainWindow.on("unmaximize", () => mainWindow.webContents.send("window-maximized", false));
  mainWindow.on("blur", () => {
    mainWindow.webContents.send("window-blur");
  });
  mainWindow.on("close", (event) => {
    if (!meetingQuitCleanupStarted) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

function isAppLocalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.href === pathToFileURL(path.join(__dirname, "renderer", "index.html")).href;
  } catch {
    return false;
  }
}

function isAppSender(webContents, frameUrl) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && webContents === mainWindow.webContents
    && isAppLocalUrl(webContents.getURL()) && (!frameUrl || isAppLocalUrl(frameUrl)));
}

function configurePermissions() {
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details = {}) => {
    return permission === "media" && isAppSender(webContents)
      && (requestingOrigin === "file://" || isAppLocalUrl(requestingOrigin))
      && (!details.embeddingOrigin || details.embeddingOrigin === "file://" || isAppLocalUrl(details.embeddingOrigin))
      && details.mediaType !== "video" && !meetingQuitCleanupStarted
      && (!captureOwner || captureOwner === "short");
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    const allowed = permission === "media" && isAppSender(webContents, details.requestingUrl)
      && details.isMainFrame !== false && !details.mediaTypes?.includes("video")
      && !meetingQuitCleanupStarted && (!captureOwner || captureOwner === "short");
    if (!allowed) return callback(false);
    captureOwner = "short";
    requireCapturePermissions("microphone").then(() => callback(true)).catch(() => {
      if (captureOwner === "short") captureOwner = null;
      callback(false);
    });
  });
}

function showAndStart() {
  if (!mainWindow || mainWindow.isDestroyed() || shortStartPending) return;
  try {
    assertCaptureAvailable("short");
  } catch (error) {
    void showCaptureError(error).catch(() => {});
    return;
  }
  if (captureOwner !== "short") targetWindowHandle = getForegroundWindowHandle();
  captureOwner = "short";
  shortStartPending = true;
  void requireCapturePermissions("microphone").then(() => {
    if (meetingQuitCleanupStarted) throw liveError("app_quitting");
    logEvent("hotkey: showAndStart");
    setWindowMode("recording");
    prepareWindowForDisplay(mainWindow, "recording");
    mainWindow.show();
    enforceWindowGeometry(mainWindow, "recording");
    focusMainWindow();
    registerRecordingKeyFallbacks();
    sendWhenLoaded(mainWindow, "hotkey-record");
  }).catch((error) => {
    if (captureOwner === "short") captureOwner = null;
    return showCaptureError(error);
  }).catch(() => {}).finally(() => { shortStartPending = false; });
}

function showWindowOnly() {
  if (!mainWindow) return;
  if (captureOwner || realtimeMeeting?.status().recording) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  setWindowMode("compact");
  prepareWindowForDisplay(mainWindow, "compact");
  mainWindow.show();
  enforceWindowGeometry(mainWindow, "compact");
  mainWindow.focus();
}

function showSettings(tabName = "") {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  targetWindowHandle = "";
  logEvent("settings: show in main window");
  setWindowMode("settings");
  prepareWindowForDisplay(mainWindow, "settings");
  mainWindow.show();
  enforceWindowGeometry(mainWindow, "settings");
  focusWindow(mainWindow, "settings", { topmost: false });
  sendWhenLoaded(mainWindow, "open-settings", typeof tabName === "string" ? tabName : "");
}

function showUpdateSettings() {
  showSettings("updates");
  void getUpdateService().check();
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
  focusWindow(mainWindow, "meeting", { topmost: liveWindowFlags.alwaysOnTop });
  sendWhenLoaded(mainWindow, "open-meeting");
}

function showFileTranscriptionWorkspace() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  targetWindowHandle = "";
  logEvent("file: show workspace");
  setWindowMode("file");
  prepareWindowForDisplay(mainWindow, "file");
  mainWindow.show();
  enforceWindowGeometry(mainWindow, "file");
  focusWindow(mainWindow, "file", { topmost: false });
  sendWhenLoaded(mainWindow, "open-file");
}

function setWindowMode(mode) {
  const previousMode = windowMode;
  if (mode !== "meeting") restoreLiveWindow();
  windowMode = mode;
  if (!mainWindow) return;
  logEvent("window: mode", mode);
  enforceWindowGeometry(mainWindow, mode, previousMode !== mode);
  // Meeting workspace is opened via open-meeting only (avoid dual-entry races).
  if (mode !== "meeting") {
    mainWindow.webContents.send("window-mode", mode);
  }
}

function restoreLiveWindow() {
  const saved = liveWindowRestore;
  liveWindowRestore = null;
  liveWindowFlags = { floating: false, compact: false, alwaysOnTop: false };
  if (!saved || !mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  mainWindow.setMinimumSize(...saved.minimumSize);
  mainWindow.setResizable(saved.resizable);
  mainWindow.setBounds(saved.bounds, false);
  setWindowAlwaysOnTop(mainWindow, saved.alwaysOnTop);
  if (saved.maximized) mainWindow.maximize();
}

function setLiveWindow(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw liveError("invalid_payload");
  const input = pickMeetingFields(payload, ["floating", "compact", "alwaysOnTop"]);
  if (Object.values(input).some(value => typeof value !== "boolean")) throw liveError("invalid_payload");
  // Delayed renderer actions must not resize the settings or short-recording view.
  if (!mainWindow || mainWindow.isDestroyed() || windowMode !== "meeting") throw liveError("window_mode_unavailable");
  const next = { ...liveWindowFlags, ...input };
  if (input.compact === true && input.floating !== false) next.floating = true;
  if (!next.floating) next.compact = false;
  if (input.floating === true && !liveWindowFlags.floating && input.alwaysOnTop === undefined) next.alwaysOnTop = true;
  if (input.floating === false && input.alwaysOnTop === undefined) next.alwaysOnTop = false;
  if (next.floating || next.compact || next.alwaysOnTop) {
    if (!liveWindowRestore) {
      liveWindowRestore = {
        bounds: mainWindow.getNormalBounds(), minimumSize: mainWindow.getMinimumSize(),
        resizable: mainWindow.isResizable(), alwaysOnTop: mainWindow.isAlwaysOnTop(), maximized: mainWindow.isMaximized()
      };
    }
    const layoutChanged = next.floating !== liveWindowFlags.floating || next.compact !== liveWindowFlags.compact;
    liveWindowFlags = next;
    if (layoutChanged && mainWindow.isMaximized()) mainWindow.unmaximize();
    mainWindow.setMinimumSize(...(next.floating ? next.compact ? [360, 240] : [520, 420] : liveWindowRestore.minimumSize));
    mainWindow.setResizable(true);
    if (layoutChanged) {
      const size = next.floating ? next.compact ? { width: 420, height: 300 } : { width: 640, height: 560 } : liveWindowRestore.bounds;
      mainWindow.setBounds({ ...mainWindow.getBounds(), ...size }, false);
      if (!next.floating && liveWindowRestore.maximized) mainWindow.maximize();
    }
    setWindowAlwaysOnTop(mainWindow, next.alwaysOnTop);
  } else restoreLiveWindow();
  const window = { ...liveWindowFlags, bounds: mainWindow.getBounds(), minimumSize: mainWindow.getMinimumSize(),
    resizable: mainWindow.isResizable(), alwaysOnTop: mainWindow.isAlwaysOnTop() };
  publishLiveUpdate(getRealtimeMeeting().status());
  return { ...window, window };
}

function enforceWindowGeometry(win, mode = windowMode, resetSize = false) {
  if (!win || win.isDestroyed()) return;
  if (win === mainWindow && mode === "meeting" && liveWindowRestore) {
    win.setResizable(true);
    setWindowAlwaysOnTop(win, liveWindowFlags.alwaysOnTop);
    return;
  }
  const size = WINDOW_SIZES[mode] || WINDOW_SIZES.compact;
  const isSettings = mode === "settings";
  const isResult = mode === "result";
  const isMeeting = mode === "meeting";
  const isFile = mode === "file";
  const resizable = RESIZABLE_WINDOW_MODES.has(mode);
  if (isMeeting || isFile) {
    win.setMinimumSize(720, 520);
  } else if (isSettings) {
    win.setMinimumSize(640, 480);
  } else if (isResult) {
    win.setMinimumSize(420, 320);
  } else {
    win.setMinimumSize(1, 1);
  }
  if (!resizable && win.isMaximized()) win.unmaximize();
  win.setResizable(resizable);
  if (!win.isMaximized() && (resetSize || mode !== "recording" || !win.isVisible())) {
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
  setWindowAlwaysOnTop(win, mode === "meeting" ? liveWindowFlags.alwaysOnTop : !["settings", "file"].includes(mode));
  if (!win.isVisible() && !(win === mainWindow && mode === "meeting" && liveWindowRestore)) win.center();
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

function publishUpdateStatus(value) {
  sendWhenLoaded(mainWindow, "app:update:status", value);
}

function updateInstallBlocked() {
  const live = realtimeMeeting?.status();
  return Boolean(captureOwner || shortStartPending || legacyCapturePending || liveStartPromise || liveStopPromise
    || liveRecoveryPromise || liveActionPromise || liveControlPromise || livePostprocessBusy(live)
    || live?.recording || live?.paused || live?.status === "stopping");
}

function macReleaseCanAutoInstall() {
  if (os.platform() !== "darwin") return true;
  if (!app.isPackaged) return false;
  let current = path.resolve(process.execPath);
  while (path.dirname(current) !== current && path.extname(current).toLowerCase() !== ".app") {
    current = path.dirname(current);
  }
  if (path.extname(current).toLowerCase() !== ".app") return false;
  const checked = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", current], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const details = `${checked.stdout || ""}\n${checked.stderr || ""}`;
  return checked.status === 0
    && /^Authority=Developer ID Application:/im.test(details)
    && /^TeamIdentifier=(?!not set$)\S+/im.test(details);
}

function getUpdateService() {
  if (updateService) return updateService;
  const { autoUpdater } = require("electron-updater");
  const { createUpdateService } = require("./updater");
  updateService = createUpdateService({
    autoUpdater,
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: os.platform(),
    arch: process.arch,
    automaticInstall: macReleaseCanAutoInstall(),
    openDownloadedFile: async (downloadedFile) => {
      const openError = await shell.openPath(downloadedFile);
      if (openError) throw Object.assign(new Error("open downloaded update failed"), { code: "update_package_open_failed" });
      shell.showItemInFolder(downloadedFile);
    },
    beforeInstall: async () => {
      if (updateInstallBlocked() || meetingQuitCleanupStarted) throw liveError("update_busy");
    },
    onStatus: publishUpdateStatus,
    logger: (message, detail) => logEvent(message, detail)
  });
  return updateService;
}

function configureUpdateSchedule() {
  if (updateStartupTimer) clearTimeout(updateStartupTimer);
  if (updateIntervalTimer) clearInterval(updateIntervalTimer);
  updateStartupTimer = null;
  updateIntervalTimer = null;
  if (!app.isPackaged || settings.updateAutoCheck === false) return;
  const check = () => getUpdateService().check().catch(() => {});
  updateStartupTimer = setTimeout(check, 12000);
  updateStartupTimer.unref?.();
  updateIntervalTimer = setInterval(check, 6 * 60 * 60 * 1000);
  updateIntervalTimer.unref?.();
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
  const focusMode = windowMode;
  const focusFlags = liveWindowFlags;
  for (const delay of [80, 180, 360, 720]) {
    setTimeout(() => {
      if (!win || win.isDestroyed() || !win.isVisible()) return;
      if (win === mainWindow && (windowMode !== focusMode || liveWindowFlags !== focusFlags)) return;
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
  if (action === "meeting") {
    showAndStartLiveMeeting();
    return;
  }
  if (windowMode === "settings") {
    logEvent("hotkey: ignored while editing settings", action || "short");
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
  if (os.platform() === "darwin") image = image.resize({ width: 18, height: 18 });
  tray = new Tray(image);
  tray.setToolTip(APP_DISPLAY_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示", click: showWindowOnly },
    { label: "设置", click: showSettings },
    { label: "检查更新", click: showUpdateSettings },
    { label: "文件转写", click: showFileTranscriptionWorkspace },
    { label: "开始实时会议转写", click: showAndStartLiveMeeting },
    { label: "开始录音", click: showAndStart },
    { label: "重试上一次转写", click: retryLastVoiceRequest },
    { label: "隐藏", click: () => hideWindow() },
    { type: "separator" },
    { label: "退出", click: () => app.quit() }
  ]));
  tray.on("double-click", showSettings);
  logEvent("tray: created");
}

function configureApplicationMenu() {
  if (os.platform() !== "darwin") return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: APP_DISPLAY_NAME, submenu: [
      { role: "about" }, { type: "separator" },
      { label: "设置", accelerator: "Command+,", click: showSettings },
      { label: "检查更新", click: showUpdateSettings },
      { type: "separator" }, { role: "services" }, { type: "separator" },
      { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
      { type: "separator" }, { role: "quit" }
    ] },
    { role: "editMenu" },
    { label: "会议", submenu: [
      { label: "开始实时会议转写", click: showAndStartLiveMeeting }
    ] },
    { role: "windowMenu" }
  ]));
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
  const model = settings.asrRealtimeModel || settings.asrModel || "qwen-audio-3.0-asr-flash-streaming";
  const fallback = settings.asrProfiles?.[settings.asrModel] || {
    apiKey: settings.asrApiKey,
    baseUrl: settings.asrBaseUrl
  };
  const connection = resolveProviderConnection(settings, {
    modelId: model,
    provider: "qwen3-asr",
    operation: isQwenAudioStreamingModel(model) ? "streaming" : "realtime",
    fallback
  });
  return {
    apiKey: connection.apiKey || process.env.QWEN_ASR_API_KEY || process.env.DASHSCOPE_API_KEY || "",
    baseUrl: connection.baseUrl,
    model,
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
  assertCaptureAvailable("short");
  captureOwner = "short";
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
  return realtimeSession?.appendPcm16Base64(base64Audio);
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
  const closing = realtimeSession?.close();
  realtimeSession = null;
  return closing;
}

function sendPasteKeystroke() {
  if (os.platform() === "darwin") return getMacUtilities().pasteToApp(targetWindowHandle);
  if (os.platform() !== "win32") return Promise.reject(liveError("permission_unavailable"));
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
  try {
    const mac = getMacUtilities();
    if (mac) {
      const access = mac.getPermissionStatus().accessibility;
      if (access !== true && access !== "granted") throw liveError("accessibility_permission");
    }
    await sendPasteKeystroke();
    return { ok: true };
  } catch (error) {
    if (os.platform() === "darwin") await showCaptureError(liveError("accessibility_permission")).catch(() => {});
    return liveIpcError(error);
  }
}

function getForegroundWindowHandle() {
  try {
    if (os.platform() === "darwin") return getMacUtilities().getForegroundApp();
    if (os.platform() !== "win32") return "";
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
ipcMain.handle("app:update:status", async () => getUpdateService().status());
ipcMain.handle("app:update:check", async () => getUpdateService().check());
ipcMain.handle("app:update:download", async () => getUpdateService().download());
ipcMain.handle("app:update:install", async () => getUpdateService().install());
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
  if (!win || win.isDestroyed() || !RESIZABLE_WINDOW_MODES.has(windowMode)) {
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
ipcMain.handle("provider:test-connection", async (event, payload = {}) => {
  try {
    if (!isAppSender(event.sender, event.senderFrame?.url)) throw new Error("untrusted_sender");
    const provider = typeof payload?.provider === "string" ? payload.provider.trim() : "";
    return await testProviderConnection({ settings, provider });
  } catch (error) {
    return sanitizeIpcError(error);
  }
});
ipcMain.handle("provider:list-models", async (event, payload = {}) => {
  try {
    if (!isAppSender(event.sender, event.senderFrame?.url)) throw new Error("untrusted_sender");
    const provider = typeof payload?.provider === "string" ? payload.provider.trim() : "";
    return await listProviderModels({ settings, provider });
  } catch (error) {
    return sanitizeIpcError(error);
  }
});
ipcMain.handle("input:inject", async (_event, text) => injectText(text));
ipcMain.handle("clipboard:write-text", async (_event, text) => clipboard.writeText(String(text || "")));
ipcMain.handle("recording:keys:clear", async () => {
  unregisterRecordingKeyFallbacks();
  if (captureOwner === "short" && !shortStartPending) captureOwner = null;
});

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

function registerLiveIpc(channel, handler) {
  ipcMain.handle(channel, async (event, payload) => {
    try {
      if (!isAppSender(event.sender, event.senderFrame?.url)) throw liveError("untrusted_sender");
      if (meetingQuitCleanupStarted) throw liveError("app_quitting");
      return { ...await handler(payload), ok: true };
    } catch (error) {
      return liveIpcError(error);
    }
  });
}

registerLiveIpc("meeting:live:status", () => liveDto(getRealtimeMeeting().status()));
registerLiveIpc("meeting:live:history", async () => liveDto(await getRealtimeMeeting().listHistory()));
registerLiveIpc("meeting:live:open-session", async (payload) => liveDto(await openLiveMeetingHistory(payload)));
registerLiveIpc("meeting:live:start", async (payload) => liveDto(await startLiveMeeting(payload)));
registerLiveIpc("meeting:live:stop", async () => {
  if (captureOwner && captureOwner !== "live") throw liveError("capture_busy");
  return liveDto(await stopLiveMeeting());
});
registerLiveIpc("meeting:live:recover", async (payload) => liveDto(await recoverLiveMeeting(payload)));
registerLiveIpc("meeting:live:window", setLiveWindow);
registerLiveIpc("meeting:live:test-connection", async (payload = {}) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw liveError("invalid_payload");
  const requestedModel = payload.modelId ?? settings.meetingRealtimeModel ?? settings.meetingQwenModel;
  if (typeof requestedModel !== "string" || requestedModel.length > 256) throw liveError("invalid_payload");
  const modelId = requestedModel.trim();
  if (!modelId) throw liveError("invalid_payload");
  if (captureOwner || liveStartPromise || liveStopPromise || realtimeMeeting?.status().recording) throw liveError("capture_busy");
  const { previewProfileFor, profileFor, MIMO_BATCH_MODEL } = require("./meeting/realtime/providers");
  if (modelId === MIMO_BATCH_MODEL) {
    profileFor(settings, modelId);
    return { modelId, scope: "meeting-batch", audioTested: false };
  }
  const { createAliMeetingStream } = require("./providers/asr/ali-meeting-stream");
  const profile = previewProfileFor(settings, modelId);
  let stream;
  try {
    stream = createAliMeetingStream({ ...profile, readyTimeoutMs: 10000, closeTimeoutMs: 1000 });
    await stream.ready;
    return { modelId, scope: "meeting-preview", audioTested: false };
  } catch {
    throw liveError("live_connection_failed");
  } finally {
    if (stream) await stream.close();
  }
});
for (const action of ["pause", "resume"]) {
  registerLiveIpc(`meeting:live:${action}`, async () => {
    if (captureOwner !== "live" || liveStartPromise || liveStopPromise || liveRecoveryPromise || liveActionPromise || liveControlPromise) throw liveError("capture_busy");
    const current = getRealtimeMeeting().status();
    if (!current.recording && !current.paused) throw liveError("capture_busy");
    liveControlPromise = Promise.resolve().then(() => getRealtimeMeeting()[action]());
    try { return liveDto(await liveControlPromise); }
    finally { liveControlPromise = null; }
  });
}
for (const action of ["retry", "cleanup", "summarize"]) {
  registerLiveIpc(`meeting:live:${action}`, async (payload) => {
    if (captureOwner || liveStartPromise || liveStopPromise || liveRecoveryPromise || liveActionPromise || liveControlPromise) throw liveError("capture_busy");
    const current = getRealtimeMeeting().status();
    if (livePostprocessBusy(current) || current.recording || current.paused || current.status === "stopping") throw liveError("live_busy");
    const input = pickMeetingFields(payload, action === "cleanup" ? ["sessionId", "modelId", "useMimoReview", "reviewModelId"]
      : action === "summarize" ? ["sessionId", "modelId"] : ["sessionId"]);
    for (const [key, value] of Object.entries(input)) {
      if (key === "useMimoReview") {
        if (typeof value !== "boolean") throw liveError("invalid_payload");
        continue;
      }
      if (typeof value !== "string" || value.length > 4096) throw liveError("invalid_payload");
    }
    if (input.sessionId != null && (!input.sessionId || input.sessionId.length > 256)) throw liveError("invalid_payload");
    if (input.sessionId && input.sessionId !== current.sessionId) throw liveError("live_session_invalid");
    // Pin even legacy payloads without an id to the session checked above.
    if (current.sessionId) input.sessionId = current.sessionId;
    liveActionPromise = Promise.resolve().then(() => getRealtimeMeeting()[action](input));
    try {
      const result = await liveActionPromise;
      if (input.sessionId && (result.sessionId !== input.sessionId || getRealtimeMeeting().status().sessionId !== input.sessionId)) {
        throw liveError("live_session_invalid");
      }
      return liveDto(result);
    } finally {
      liveActionPromise = null;
    }
  });
}

registerLiveIpc("meeting:live:choose-destination", async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "选择实时会议 Markdown 保存位置",
    defaultPath: settings.meetingRealtimeDestination || path.join(app.getPath("documents"), APP_DISPLAY_NAME, "Meetings", "meeting.md"),
    filters: [{ name: "Markdown", extensions: ["md"] }],
    properties: ["createDirectory", "showOverwriteConfirmation"]
  });
  if (result.canceled || !result.filePath) return { cancelled: true };
  const destinationPath = /\.md$/i.test(result.filePath) ? result.filePath : `${result.filePath}.md`;
  if (!path.isAbsolute(destinationPath)) throw liveError("invalid_payload");
  const next = { ...settings, meetingRealtimeDestination: destinationPath };
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(next, null, 2), "utf8");
  // Starting a session never persists its destination.
  settings.meetingRealtimeDestination = destinationPath;
  return { cancelled: false, destinationPath };
});

registerLiveIpc("meeting:live:open-path", async (payload) => {
  const requested = typeof payload === "string" ? payload : payload?.path;
  if (typeof requested !== "string" || !path.isAbsolute(requested)) throw liveError("path_not_allowed");
  liveDto(getRealtimeMeeting().status());
  const resolved = path.resolve(requested);
  if (!liveOutputPaths.has(resolved)) throw liveError("path_not_allowed");
  const canonical = await fs.realpath(resolved);
  // Do not follow an output that has been replaced by a symlink to another file.
  if (canonical !== resolved || !(await fs.lstat(resolved)).isFile()) throw liveError("path_not_allowed");
  if (await shell.openPath(canonical)) throw liveError("open_path_failed");
  return {};
});

registerLiveIpc("app:permissions:status", () => getMacUtilities()?.getPermissionStatus() || {
  microphone: "unknown", screen: "unknown", accessibility: "not-required"
});
registerLiveIpc("app:permissions:microphone", async () => ({
  granted: getMacUtilities() ? Boolean(await getMacUtilities().requestMicrophoneAccess()) : true
}));
registerLiveIpc("app:permissions:open-settings", async (payload) => {
  const kind = typeof payload === "string" ? payload : payload?.kind;
  if (!["microphone", "screen", "accessibility"].includes(kind)) throw liveError("invalid_payload");
  const mac = getMacUtilities();
  if (!mac) throw liveError("permission_unavailable");
  await mac.openPermissionSettings(kind);
  return {};
});

async function legacyCaptureOperation(action, input) {
  assertCaptureAvailable("legacy");
  if (legacyCapturePending || (legacySessionId && legacySessionId !== input.sessionId)) throw liveError("capture_busy");
  const previousOwner = captureOwner;
  captureOwner = "legacy";
  legacyCapturePending = true;
  try {
    const service = getMeetingCapture();
    let result;
    if (action === "start") {
      const mode = String(input.captureMode || "dual").toLowerCase();
      await requireCapturePermissions(mode === "mic" ? "microphone" : mode);
      if (meetingQuitCleanupStarted) throw liveError("app_quitting");
      result = mode === "microphone" || mode === "mic"
        ? await service.startMicrophone(input.sessionId, { deviceId: input.deviceId })
        : await service.startDual(input.sessionId, { deviceId: input.deviceId, systemDeviceId: input.systemDeviceId });
    } else {
      result = await service[action](input.sessionId);
    }
    if (result?.ok === false) {
      captureOwner = previousOwner;
    } else if (action === "stop") {
      captureOwner = null;
      legacySessionId = null;
    } else {
      legacySessionId = input.sessionId;
    }
    return result;
  } catch (error) {
    captureOwner = previousOwner;
    throw error;
  } finally {
    legacyCapturePending = false;
  }
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
  let reserved = false;
  try {
    assertCaptureAvailable("legacy");
    if (captureOwner || legacyCapturePending) throw liveError("capture_busy");
    captureOwner = "legacy";
    legacyCapturePending = true;
    reserved = true;
    const { title } = pickMeetingFields(payload, ["title"]);
    const service = getMeetingCapture();
    const created = await service.createAndPrepareSession({ title });
    return { ok: true, ...created };
  } catch (error) {
    return meetingIpcError(error);
  } finally {
    if (reserved) {
      captureOwner = null;
      legacyCapturePending = false;
    }
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
    return await legacyCaptureOperation("start", { sessionId, deviceId, systemDeviceId, captureMode });
  } catch (error) {
    return meetingIpcError(error);
  }
});
ipcMain.handle("meeting:capture:pause", async (_event, payload) => {
  try {
    const { sessionId } = pickMeetingFields(payload, ["sessionId"]);
    return await legacyCaptureOperation("pause", { sessionId });
  } catch (error) {
    return meetingIpcError(error);
  }
});
ipcMain.handle("meeting:capture:resume", async (_event, payload) => {
  try {
    const { sessionId } = pickMeetingFields(payload, ["sessionId"]);
    return await legacyCaptureOperation("resume", { sessionId });
  } catch (error) {
    return meetingIpcError(error);
  }
});
ipcMain.handle("meeting:capture:stop", async (_event, payload) => {
  try {
    const { sessionId } = pickMeetingFields(payload, ["sessionId"]);
    // Local-only: never starts export/ASR
    const result = await legacyCaptureOperation("stop", { sessionId });
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
  configureApplicationMenu();
  createTray();
  try {
    publishLiveUpdate(await recoverLiveMeeting());
  } catch (error) {
    logEvent("meeting-live: recovery failed", liveIpcError(error).error.code);
    publishLiveUpdate({ status: "failed", recording: false, error });
  }
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
  configureUpdateSchedule();
});

function cleanupHotkeysAndShortcuts() {
  unregisterRecordingKeyFallbacks();
  stopWindowsHotkeyHelper();
  globalShortcut.unregisterAll();
}

async function shutdownMeetingCaptureBounded(timeoutMs = MEETING_QUIT_TIMEOUT_MS) {
  // Never race durable live audio/Markdown writes against a quit timeout.
  if (liveRecoveryPromise) await liveRecoveryPromise;
  if (liveStartPromise) await liveStartPromise.catch(() => {});
  if (liveActionPromise) await liveActionPromise.catch(() => {});
  if (realtimeMeeting) {
    await stopLiveMeeting();
    await realtimeMeeting.shutdown();
  }
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

// Live disk writes must finish before the bounded legacy-helper cleanup and exit.
app.on("before-quit", (event) => {
  event.preventDefault();
  if (meetingQuitCleanupStarted) return;
  meetingQuitCleanupStarted = true;
  logEvent("app: before-quit meeting cleanup");
  cleanupHotkeysAndShortcuts();
  shutdownMeetingCaptureBounded()
    .then(() => {
      // Final exit line is enqueued inside close() then flushed before app.exit.
      const writer = runtimeLogWriter || getRuntimeLogWriter();
      const done = writer?.close?.("app: before-quit cleanup done") || Promise.resolve();
      Promise.resolve(done)
        .catch(() => {})
        .finally(() => app.exit(0));
    })
    .catch(async (error) => {
      // Keep the process and service alive so a failed local write can be retried.
      meetingQuitCleanupStarted = false;
      logEvent("meeting-live: quit blocked", liveIpcError(error).error.code);
      await registerHotkey().catch(() => {});
      showMeetingWorkspace();
      publishLiveUpdate({ ...realtimeMeeting?.status(), error });
      await showCaptureError(error).catch(() => {});
    });
});

app.on("will-quit", () => {
  // Writer is closed in before-quit; do not enqueue after close.
  // Hotkeys already cleaned in before-quit when that path runs; keep as safety net.
  cleanupHotkeysAndShortcuts();
});

app.on("render-process-gone", (_event, webContents, details) => {
  if (webContents === mainWindow?.webContents && captureOwner === "short") {
    captureOwner = null;
    stopRealtimeAsr();
    unregisterRecordingKeyFallbacks();
  }
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

app.on("activate", () => {
  if (meetingQuitCleanupStarted) return;
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (realtimeMeeting?.status().recording || captureOwner === "live") showMeetingWorkspace();
  else showWindowOnly();
});

// Keep the tray application alive when its last window closes, including on macOS.
app.on("window-all-closed", () => {});
