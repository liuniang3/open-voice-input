"use strict";

const { EventEmitter } = require("node:events");

const UPDATE_REPOSITORY = Object.freeze({
  provider: "github",
  owner: "liuniang3",
  repo: "open-voice-input"
});

const SUPPORTED_PLATFORMS = new Set(["win32", "darwin"]);

function updateChannel(platform, arch) {
  return platform === "darwin" ? `latest-${arch === "arm64" ? "arm64" : "x64"}` : "latest";
}

function safeUpdateError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "").toLowerCase();
  if (code === "update_busy") {
    return { code, message: "录音或转写任务尚未结束，请完成当前任务后再安装更新。" };
  }
  if (code.includes("CHANNEL_FILE_NOT_FOUND") || message.includes("channel") && message.includes("not found")) {
    return { code: "update_metadata_missing", message: "最新版本缺少当前平台的更新文件。" };
  }
  if (code.includes("INVALID_UPDATE_INFO") || message.includes("sha512") || message.includes("checksum")) {
    return { code: "update_integrity_failed", message: "更新文件校验失败，已停止安装。" };
  }
  if (message.includes("signature") || message.includes("code sign") || message.includes("codesign")) {
    return { code: "update_signature_required", message: "此构建缺少系统要求的应用签名，无法自动安装。" };
  }
  if (code.includes("HTTP") || message.includes("network") || message.includes("timed out")
    || message.includes("timeout") || message.includes("enotfound") || message.includes("econn")) {
    return { code: "update_network_failed", message: "无法连接 GitHub 更新服务，请稍后重试。" };
  }
  return { code: "update_failed", message: "更新失败，当前版本未被修改。" };
}

function publicInfo(info) {
  if (!info || typeof info !== "object") return {};
  return {
    version: typeof info.version === "string" ? info.version.slice(0, 64) : "",
    releaseName: typeof info.releaseName === "string" ? info.releaseName.slice(0, 200) : "",
    releaseDate: typeof info.releaseDate === "string" ? info.releaseDate.slice(0, 64) : ""
  };
}

function createUpdateService({
  autoUpdater,
  currentVersion,
  isPackaged,
  platform = process.platform,
  arch = process.arch,
  beforeInstall = async () => {},
  onStatus = () => {},
  logger = () => {}
} = {}) {
  if (!autoUpdater || typeof autoUpdater.on !== "function") throw new TypeError("autoUpdater required");
  if (typeof currentVersion !== "string" || !currentVersion) throw new TypeError("currentVersion required");

  const events = new EventEmitter();
  const channel = updateChannel(platform, arch);
  const supported = Boolean(isPackaged && SUPPORTED_PLATFORMS.has(platform));
  let checkPromise = null;
  let downloadPromise = null;
  let installPromise = null;
  let state = {
    status: supported ? "idle" : "unsupported",
    currentVersion,
    availableVersion: "",
    releaseName: "",
    releaseDate: "",
    downloaded: false,
    progress: null,
    error: null,
    supported,
    platform,
    arch,
    channel
  };

  const snapshot = () => structuredClone(state);
  const publish = (patch = {}) => {
    state = { ...state, ...patch };
    const value = snapshot();
    onStatus(value);
    events.emit("status", value);
    return value;
  };
  const fail = (error) => {
    const safe = safeUpdateError(error);
    logger("updater: failed", safe.code);
    return publish({ status: "error", error: safe });
  };

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  if (platform === "darwin") autoUpdater.channel = channel;
  autoUpdater.allowDowngrade = false;
  autoUpdater.fullChangelog = false;
  autoUpdater.setFeedURL?.({ ...UPDATE_REPOSITORY, channel });

  autoUpdater.on("checking-for-update", () => publish({ status: "checking", error: null }));
  autoUpdater.on("update-available", (info) => {
    const clean = publicInfo(info);
    publish({ status: "available", availableVersion: clean.version, releaseName: clean.releaseName,
      releaseDate: clean.releaseDate, downloaded: false, progress: null, error: null });
  });
  autoUpdater.on("update-not-available", () => publish({ status: "current", availableVersion: "",
    releaseName: "", releaseDate: "", downloaded: false, progress: null, error: null }));
  autoUpdater.on("download-progress", (progress = {}) => publish({
    status: "downloading",
    error: null,
    progress: {
      percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
      bytesPerSecond: Math.max(0, Number(progress.bytesPerSecond) || 0),
      transferred: Math.max(0, Number(progress.transferred) || 0),
      total: Math.max(0, Number(progress.total) || 0)
    }
  }));
  autoUpdater.on("update-downloaded", (info) => {
    const clean = publicInfo(info);
    publish({ status: "downloaded", availableVersion: clean.version || state.availableVersion,
      releaseName: clean.releaseName || state.releaseName, releaseDate: clean.releaseDate || state.releaseDate,
      downloaded: true, progress: { ...(state.progress || {}), percent: 100 }, error: null });
  });
  // electron-updater emits errors even when the initiating promise also rejects.
  autoUpdater.on("error", (error) => fail(error));

  async function check() {
    if (!supported) return publish({ status: "unsupported", error: null });
    if (state.downloaded || state.status === "installing") return snapshot();
    if (checkPromise) return checkPromise;
    if (downloadPromise || installPromise) return snapshot();
    checkPromise = Promise.resolve()
      .then(() => autoUpdater.checkForUpdates())
      .then(() => snapshot())
      .catch(fail)
      .finally(() => { checkPromise = null; });
    return checkPromise;
  }

  async function download() {
    if (!supported) return publish({ status: "unsupported", error: null });
    if (state.downloaded) return snapshot();
    if (!state.availableVersion) return fail(Object.assign(new Error("update unavailable"), { code: "update_unavailable" }));
    if (downloadPromise) return downloadPromise;
    if (installPromise) return snapshot();
    publish({ status: "downloading", progress: state.progress || { percent: 0 }, error: null });
    downloadPromise = Promise.resolve()
      .then(() => autoUpdater.downloadUpdate())
      .then(() => snapshot())
      .catch(fail)
      .finally(() => { downloadPromise = null; });
    return downloadPromise;
  }

  async function install() {
    if (!supported) return publish({ status: "unsupported", error: null });
    if (!state.downloaded) return fail(Object.assign(new Error("update not downloaded"), { code: "update_unavailable" }));
    if (installPromise) return installPromise;
    installPromise = Promise.resolve()
      .then(() => beforeInstall())
      .then(() => {
        publish({ status: "installing", error: null });
        autoUpdater.quitAndInstall(false, true);
        return snapshot();
      })
      .catch(fail)
      .finally(() => { installPromise = null; });
    return installPromise;
  }

  return { status: snapshot, check, download, install, on: events.on.bind(events), safeUpdateError };
}

module.exports = { UPDATE_REPOSITORY, createUpdateService, safeUpdateError, updateChannel };
