"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createLoginStartup, STARTUP_NAME } = require("../src/platform/login-startup");
const { mainHarness } = require("./test-settings-shortcuts");
const root = path.resolve(__dirname, "..");

function nativeFixture(platform = "win32", overrides = {}) {
  const calls = [];
  let state = platform === "darwin" ? { openAtLogin: false, status: "not-registered", wasOpenedAtLogin: false }
    : { openAtLogin: false, executableWillLaunchAtLogin: false, launchItems: [] };
  const app = {
    isPackaged: true,
    getLoginItemSettings: options => { calls.push({ method: "get", options }); return state; },
    setLoginItemSettings: options => {
      calls.push({ method: "set", options });
      state = platform === "darwin" ? { ...state, openAtLogin: options.openAtLogin, status: options.openAtLogin ? "enabled" : "not-registered" }
        : { openAtLogin: options.openAtLogin, executableWillLaunchAtLogin: options.enabled,
          launchItems: options.openAtLogin ? [{ name: options.name, path: options.path, args: options.args, scope: "user", enabled: options.enabled }] : [] };
    }
  };
  const options = { app, platform, execPath: "C:\\Program Files\\Open Voice Input\\Open Voice Input.exe", env: {}, ...overrides };
  return { app, calls, options, service: createLoginStartup(options), state: value => { state = value; } };
}

function unitTests() {
  for (const portable of [false, true]) {
    const f = nativeFixture("win32", portable ? { execPath: "C:\\Temp\\extract\\Open Voice Input.exe",
      env: { PORTABLE_EXECUTABLE_FILE: "D:\\My Apps\\Voice Portable.exe" } } : {});
    assert.equal(f.service.readStatus().enabled, false);
    assert.equal(f.calls.some(call => call.method === "set"), false, "reading a default never registers login items");
    assert.equal(f.service.setEnabled(true).enabled, true);
    const set = f.calls.find(call => call.method === "set").options;
    assert.equal(set.path, portable ? f.options.env.PORTABLE_EXECUTABLE_FILE : f.options.execPath);
    assert.equal(set.name, STARTUP_NAME);
    assert.deepEqual(set.args, ["--autostart"]);
    assert.deepEqual(f.calls.at(-1).options, { path: set.path, args: set.args }, "query the same path and arguments");
    const own = { name: STARTUP_NAME, path: set.path, args: set.args, scope: "user", enabled: false };
    f.state({ openAtLogin: true, executableWillLaunchAtLogin: true, launchItems: [own,
      { ...own, name: "another-program", args: [], enabled: true }, { ...own, name: "other", enabled: true }] });
    assert.equal(f.service.readStatus().enabled, false, "Task Manager disabling our item takes precedence");
    assert.equal(f.service.setEnabled(false).enabled, false);
    assert.equal(f.calls.findLast(call => call.method === "set").options.openAtLogin, false);
    assert.equal(f.service.wasOpenedAtLogin(["--autostart"]), true);
  }
  for (const invalid of ["", "relative.exe", "C:\\Temp\\app.cmd", "C:\\Temp\\bad\n.exe", "https://example.invalid/app.exe"]) {
    const f = nativeFixture("win32", { env: { PORTABLE_EXECUTABLE_FILE: invalid } });
    assert.equal(f.service.setEnabled(true).supported, false, "never register an invalid portable path or fall back to the extracted executable");
    assert.equal(f.calls.length, 0);
  }
  for (const platform of ["win32", "darwin", "linux"]) {
    const f = nativeFixture(platform);
    f.app.isPackaged = false;
    assert.equal(f.service.setEnabled(true).supported, false);
    assert.equal(f.calls.length, 0, "source launches never register themselves");
  }
  const mac = nativeFixture("darwin");
  assert.equal(mac.service.setEnabled(true).enabled, true);
  assert.deepEqual(mac.calls.find(call => call.method === "set").options, { type: "mainAppService", openAtLogin: true });
  mac.state({ openAtLogin: true, status: "requires-approval", wasOpenedAtLogin: true });
  assert.equal(mac.service.readStatus().enabled, false);
  assert.equal(mac.service.readStatus().state, "requires-approval");
  assert.equal(mac.service.wasOpenedAtLogin([]), true);
  mac.app.setLoginItemSettings = () => {};
  assert.equal(mac.service.setEnabled(true).ok, true, "waiting for system approval is an accepted registration");
  mac.state({ openAtLogin: false, status: "not-found" });
  assert.equal(mac.service.setEnabled(true).ok, false);
  const failing = nativeFixture();
  failing.app.setLoginItemSettings = () => { throw new Error("private path and configuration"); };
  assert.equal(failing.service.setEnabled(true).enabled, false);
  assert.doesNotMatch(JSON.stringify(failing.service.setEnabled(true)), /private/);
  failing.app.getLoginItemSettings = () => { throw new Error("private path"); };
  assert.equal(failing.service.readStatus().enabled, null);
  assert.doesNotMatch(JSON.stringify(failing.service.readStatus()), /private/);
  const mismatch = nativeFixture();
  mismatch.app.setLoginItemSettings = () => {};
  assert.equal(mismatch.service.setEnabled(true).ok, false, "verify system read-back instead of assuming registration succeeded");
  for (const payload of [null, "true", {}, { path: "injected.exe" }]) assert.equal(mismatch.service.setEnabled(payload).ok, false);
}

async function mainTests() {
  for (const platform of ["win32", "darwin"]) {
    const f = nativeFixture(platform);
    const h = mainHarness(platform, { "./providers/voice-pipeline": { createVoicePipeline: () => ({}) } });
    Object.assign(h.app, f.app);
    h.context.process.execPath = f.options.execPath;
    const before = f.calls.length;
    assert.equal((await h.invoke("app:startup:set", true, { sender: {} })).ok, false);
    assert.equal((await h.invoke("app:startup:status", null, { sender: {} })).ok, false);
    assert.equal((await h.invoke("app:startup:set", true, { sender: h.webContents, senderFrame: { url: "https://untrusted.invalid" } })).ok, false);
    for (const payload of [null, {}, "yes"]) assert.equal((await h.invoke("app:startup:set", payload)).ok, false);
    assert.equal(f.calls.length, before, "untrusted IPC and malformed values cannot reach system APIs");
    assert.equal((await h.invoke("app:startup:set", true)).enabled, true);
    assert.equal((await h.invoke("app:startup:status")).enabled, true);
    assert.equal(h.controls.writes.length, 0, "OS startup state never rewrites provider or model settings");

    h.context.testEvents = h.events;
    h.run(`loadSettings = async () => {};
      attachMeetingPlaybackProtocolHandler = () => {};
      configurePermissions = () => {};
      createWindow = () => testEvents.push("window-created");
      configureApplicationMenu = () => {};
      createTray = () => testEvents.push("tray-created");
      recoverLiveMeeting = async () => { testEvents.push("recovery"); return {}; };
      publishLiveUpdate = () => {};
      registerHotkey = async () => testEvents.push("hotkeys-ready");
      setWindowMode = () => {};
      configureUpdateSchedule = () => testEvents.push("updates-ready");
      showHome = () => testEvents.push("home");
      showSettings = () => testEvents.push("settings");
      showWindowOnly = () => testEvents.push("manual-open");`);
    if (platform === "win32") h.context.process.argv = ["--autostart"];
    else f.state({ openAtLogin: true, status: "enabled", wasOpenedAtLogin: true });
    h.appEvents.get("activate")();
    assert.equal(h.events.includes("manual-open"), false, "initial macOS activation cannot defeat quiet startup");
    await h.controls.ready();
    for (const event of ["window-created", "tray-created", "recovery", "hotkeys-ready", "updates-ready"]) assert.ok(h.events.includes(event));
    assert.equal(h.events.includes("home"), false);
    assert.equal(h.events.includes("settings"), false);
    h.appEvents.get("activate")();
    assert.equal(h.events.at(-1), "manual-open", "later user activation still opens the application");
    h.events.length = 0;
    h.appEvents.get("second-instance")({}, ["--autostart"]);
    assert.equal(h.events.length, 0, "a duplicate login launch never foregrounds an existing instance");
    h.appEvents.get("second-instance")({}, ["--autostart", "--settings"]);
    assert.equal(h.events.at(-1), "settings");
    h.events.length = 0;
    h.context.process.argv = [];
    f.state({ openAtLogin: true, status: "enabled", wasOpenedAtLogin: false });
    await h.controls.ready();
    assert.ok(h.events.includes("home"), "normal launches open the home page");
    h.events.length = 0;
    h.context.process.argv = ["--autostart", "--settings"];
    await h.controls.ready();
    assert.ok(h.events.includes("settings"), "explicit settings launch overrides login background mode");
  }

  let api;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/preload.js"), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { invoke: (...args) => calls.push(args) } })
  });
  api.getStartupStatus(); api.setStartupEnabled(false);
  assert.deepEqual(calls, [["app:startup:status"], ["app:startup:set", false]]);
}

async function verifyBrowser(page) {
  const { prepareBrowser } = require("./test-meeting-live-ui");
  const errors = await prepareBrowser(page);
  await page.evaluate(async () => {
    window.mockStartup = { ok: true, supported: true, enabled: false, state: "disabled", message: "开机自启已关闭。" };
    window.mockApiOverrides ||= {};
    window.mockApiOverrides.getStartupStatus = async () => ({ ...window.mockStartup });
    window.mockApiOverrides.setStartupEnabled = async enabled => {
      window.mockStartup = { ok: true, supported: true, enabled, state: enabled ? "enabled" : "disabled", message: enabled ? "登录后自动驻留托盘，不打开主窗口。" : "开机自启已关闭。" };
      return window.mockStartup;
    };
    await window.mockOpenSettings();
  });
  await page.locator('[data-settings-tab="updates"]').click();
  const input = page.locator("#startupEnabledInput");
  await page.waitForFunction(() => !document.getElementById("startupEnabledInput").disabled);
  assert.equal(await input.isChecked(), false);
  await input.check();
  await page.waitForFunction(() => document.getElementById("startupStatus").textContent.includes("驻留托盘"));
  assert.equal(await input.isChecked(), true);
  assert.equal(await page.evaluate(() => "startupEnabled" in window.mockSettings()), false);
  await page.evaluate(() => { window.mockStartup = { ok: true, supported: true, enabled: false, state: "disabled", message: "开机自启已关闭。" }; });
  await page.locator('[data-settings-tab="asr"]').click();
  await page.locator('[data-settings-tab="updates"]').click();
  await page.waitForFunction(() => !document.getElementById("startupEnabledInput").checked);
  await page.evaluate(() => { window.mockApiOverrides.setStartupEnabled = async () => ({ ok: false, supported: true, enabled: false, message: "系统未能修改开机自启，请重试。" }); });
  await input.click();
  await page.waitForFunction(() => document.getElementById("startupStatus").dataset.kind === "error");
  assert.equal(await input.isChecked(), false);
  assert.equal(await input.isEnabled(), true);
  await page.evaluate(() => { window.mockApiOverrides.setStartupEnabled = async () => { throw new Error("private native exception"); }; });
  await input.click();
  await page.waitForFunction(() => document.getElementById("startupStatus").textContent.includes("未能保存"));
  assert.equal(await input.isChecked(), false);
  assert.doesNotMatch(await page.locator("#startupStatus").innerText(), /private/);
  await page.evaluate(() => { window.mockApiOverrides.setStartupEnabled = async () => ({ ok: true, supported: true, enabled: false, state: "requires-approval", message: "请在 macOS 系统设置 → 通用 → 登录项中允许 Open Voice Input。" }); });
  await input.click();
  await page.waitForFunction(() => document.getElementById("startupEnabledInput").indeterminate);
  assert.match(await page.locator("#startupStatus").innerText(), /macOS/);
  await page.evaluate(() => { window.mockApiOverrides.setStartupEnabled = async enabled => {
    window.mockPendingChoice = enabled;
    return { ok: true, supported: true, enabled, state: enabled ? "enabled" : "disabled", message: "开机自启已关闭。" };
  }; });
  await input.click();
  await page.waitForFunction(() => window.mockPendingChoice === false);
  assert.equal(await input.isChecked(), false, "a pending macOS login registration can still be cancelled");
  await page.evaluate(() => { window.mockApiOverrides.getStartupStatus = async () => ({ ok: true, supported: false, enabled: false, state: "unavailable", message: "请使用安装版或便携版设置开机自启；源码启动不会注册登录项。" }); });
  await page.locator('[data-settings-tab="asr"]').click();
  await page.locator('[data-settings-tab="updates"]').click();
  await page.waitForFunction(() => document.getElementById("startupStatus").textContent.includes("源码"));
  assert.equal(await input.isDisabled(), true);
  await page.evaluate(() => { window.mockApiOverrides.getStartupStatus = async () => ({ ok: true, supported: true, enabled: true, state: "enabled", message: "登录后自动驻留托盘，不打开主窗口。" }); });
  await page.locator('[data-settings-tab="asr"]').click();
  await page.locator('[data-settings-tab="updates"]').click();
  await page.waitForFunction(() => document.getElementById("startupEnabledInput").checked);
  const output = path.join(root, "output/playwright"); fs.mkdirSync(output, { recursive: true });
  for (const size of [{ width: 1040, height: 780 }, { width: 540, height: 620 }]) {
    await page.setViewportSize(size);
    assert.equal(await page.locator("#settingsUpdatesPanel").evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    await page.screenshot({ path: path.join(output, `startup-settings-${size.width}.png`) });
  }
  assert.deepEqual(errors, []);
  console.log("Startup browser: immediate save, external changes, failures, approval, source mode and narrow layout passed.");
}

async function verifyNative() {
  const { _electron } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|MIMO|QWEN|DASHSCOPE|FUN_ASR|CLEANER|OSS|OVI_/i.test(key)));
  const sandbox = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ovi-startup-native-"));
  const application = await _electron.launch({ executablePath: require("electron"),
    args: [path.join(__dirname, "test-home-ui.js"), "--electron-app-fixture", sandbox, "--autostart"], env });
  try {
    const page = await application.firstWindow();
    await page.waitForFunction(async () => {
      await window.mimoInput.getSettings();
      return true;
    });
    await page.waitForFunction(() => appSettings.hotkey && currentWindowMode === "compact");
    const userData = await application.evaluate(({ app }) => app.getPath("userData"));
    assert.ok(userData.startsWith(sandbox));
    const logFile = path.join(userData, "open-voice-input.log");
    const deadline = Date.now() + 15000;
    let initialized = false;
    while (Date.now() < deadline && !initialized) {
      try { initialized = fs.readFileSync(logFile, "utf8").includes("app: initialized"); }
      catch { /* The asynchronous log writer may not have created its file yet. */ }
      if (!initialized) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(initialized, true, "quiet startup must complete initialization");
    const state = await application.evaluate(({ app, BrowserWindow }) => ({
      userData: app.getPath("userData"), visible: BrowserWindow.getAllWindows().some(window => window.isVisible())
    }));
    assert.ok(state.userData.startsWith(sandbox));
    assert.equal(state.visible, false, "real Electron login launch must keep every window hidden");
    const startup = await page.evaluate(() => window.mimoInput.getStartupStatus());
    assert.equal(startup.supported, false, "native source test never registers a user login item");
    await page.evaluate(() => window.mimoInput.openSettings());
    await page.waitForFunction(() => document.body.classList.contains("settings-open"));
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible())), true);
    await page.locator('[data-settings-tab="updates"]').click();
    await page.waitForFunction(() => document.getElementById("startupStatus").textContent.includes("源码"));
    assert.equal(await page.locator("#startupEnabledInput").isDisabled(), true);
    console.log("Native Electron: login launch finishes with no visible window; explicit settings activation works; user login items untouched.");
  } finally { await application.close(); }
}

module.exports = { verifyBrowser, verifyNative };
if (require.main === module) {
  (async () => {
    unitTests(); await mainTests();
    if (process.argv.includes("--native")) await verifyNative();
    if (process.argv.includes("--browser")) {
      const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
      const browser = await chromium.launch({ channel: "chrome", headless: true });
      try { await verifyBrowser(await browser.newPage()); } finally { await browser.close(); }
    }
    console.log("Login startup tests passed (Windows/macOS system mocks; no user login items modified).");
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
