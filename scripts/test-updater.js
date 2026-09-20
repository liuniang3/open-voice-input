"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createUpdateService, safeUpdateError, updateChannel } = require("../src/updater");

class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.feed = null;
    this.checks = 0;
    this.downloads = 0;
    this.installs = [];
  }

  setFeedURL(value) { this.feed = value; }
  async checkForUpdates() {
    this.checks++;
    this.emit("checking-for-update");
    this.emit("update-available", { version: "0.4.0", releaseName: "Release", releaseDate: "2026-09-18" });
  }
  async downloadUpdate() {
    this.downloads++;
    this.emit("download-progress", { percent: 37.5, bytesPerSecond: 1024, transferred: 3, total: 8 });
    this.emit("update-downloaded", { version: "0.4.0", downloadedFile: "/safe/cache/update.zip" });
  }
  quitAndInstall(...args) { this.installs.push(args); }
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

(async () => {
  await test("packaged Windows checks, downloads and installs without opening a browser", async () => {
    const updater = new FakeUpdater();
    let prepared = 0;
    const states = [];
    const service = createUpdateService({ autoUpdater: updater, currentVersion: "0.3.1", isPackaged: true,
      platform: "win32", arch: "x64", beforeInstall: async () => { prepared++; }, onStatus: s => states.push(s) });
    assert.equal(updater.autoDownload, false);
    assert.equal(updater.autoInstallOnAppQuit, false);
    assert.equal(updater.allowPrerelease, false);
    assert.equal(updater.allowDowngrade, false);
    assert.deepEqual(updater.feed, { provider: "github", owner: "liuniang3", repo: "open-voice-input", channel: "latest" });
    assert.equal((await service.check()).status, "available");
    assert.equal((await service.download()).status, "downloaded");
    assert.equal(states.find(s => s.status === "downloading").progress.percent, 0);
    assert.equal(states.find(s => s.progress?.percent === 37.5).progress.total, 8);
    assert.equal((await service.install()).status, "installing");
    assert.equal(prepared, 1);
    assert.deepEqual(updater.installs, [[false, true]]);
  });

  await test("macOS architectures use independent release channels", async () => {
    assert.equal(updateChannel("darwin", "arm64"), "latest-arm64");
    assert.equal(updateChannel("darwin", "x64"), "latest-x64");
    const updater = new FakeUpdater();
    createUpdateService({ autoUpdater: updater, currentVersion: "0.3.1", isPackaged: true,
      platform: "darwin", arch: "arm64" });
    assert.equal(updater.channel, "latest-arm64");
    assert.equal(updater.allowDowngrade, false, "channel setter must not enable downgrades");
    assert.equal(updater.feed.channel, "latest-arm64");
  });

  await test("unsigned macOS opens the verified local package instead of invoking Squirrel", async () => {
    const updater = new FakeUpdater();
    const opened = [];
    const service = createUpdateService({ autoUpdater: updater, currentVersion: "0.3.1", isPackaged: true,
      platform: "darwin", arch: "arm64", automaticInstall: false,
      openDownloadedFile: async file => opened.push(file) });
    await service.check();
    const downloaded = await service.download();
    assert.equal(downloaded.installMode, "manual");
    assert.equal("downloadedFile" in downloaded, false, "local cache paths must not cross IPC");
    const status = await service.install();
    assert.equal(status.status, "manual_install");
    assert.equal(status.downloaded, true);
    assert.deepEqual(opened, ["/safe/cache/update.zip"]);
    assert.equal(updater.installs.length, 0);
  });

  await test("a macOS signature rejection falls back to the downloaded package", async () => {
    const updater = new FakeUpdater();
    const service = createUpdateService({ autoUpdater: updater, currentVersion: "0.3.1", isPackaged: true,
      platform: "darwin", arch: "x64", automaticInstall: true, openDownloadedFile: async () => {} });
    await service.check();
    await service.download();
    updater.emit("error", new Error("Code signature at URL did not pass validation"));
    const status = service.status();
    assert.equal(status.status, "downloaded");
    assert.equal(status.installMode, "manual");
    assert.equal(status.error, null);
  });

  await test("missing macOS package path remains downloadable", async () => {
    const updater = new FakeUpdater();
    updater.downloadUpdate = async function downloadWithoutLocalPath() {
      this.downloads++;
      this.emit("update-downloaded", { version: "0.4.0", downloadedFile: "relative/update.zip" });
    };
    const service = createUpdateService({ autoUpdater: updater, currentVersion: "0.3.1", isPackaged: true,
      platform: "darwin", arch: "arm64", automaticInstall: false, openDownloadedFile: async () => {} });
    await service.check();
    await service.download();
    const status = await service.install();
    assert.equal(status.status, "error");
    assert.equal(status.error.code, "update_package_missing");
    assert.equal(status.downloaded, false);
    assert.equal(status.progress, null);
  });

  await test("development builds never contact GitHub", async () => {
    const updater = new FakeUpdater();
    const service = createUpdateService({ autoUpdater: updater, currentVersion: "0.3.1", isPackaged: false,
      platform: "win32", arch: "x64" });
    assert.equal((await service.check()).status, "unsupported");
    assert.equal(updater.checks, 0);
    assert.equal(updater.downloads, 0);
  });

  await test("errors expose local codes without remote URLs or response bodies", async () => {
    const safe = safeUpdateError(new Error("request to https://example.invalid/private timed out: secret-body"));
    assert.deepEqual(safe, { code: "update_network_failed", message: "无法连接 GitHub 更新服务，请稍后重试。" });
    assert.doesNotMatch(JSON.stringify(safe), /example|secret-body/);
    const signature = safeUpdateError(new Error("code signature invalid at C:\\private\\app.exe"));
    assert.equal(signature.code, "update_signature_required");
    assert.doesNotMatch(JSON.stringify(signature), /private|app\.exe/);
  });

  await test("install safety failure keeps the downloaded update retryable", async () => {
    const updater = new FakeUpdater();
    const service = createUpdateService({ autoUpdater: updater, currentVersion: "0.3.1", isPackaged: true,
      platform: "win32", arch: "x64", beforeInstall: async () => {
        throw Object.assign(new Error("busy"), { code: "update_busy" });
      } });
    await service.check();
    await service.download();
    const status = await service.install();
    assert.equal(status.status, "error");
    assert.equal(status.error.code, "update_busy");
    assert.equal(status.downloaded, true);
    assert.equal(updater.installs.length, 0);
  });

  console.log("Updater service tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
