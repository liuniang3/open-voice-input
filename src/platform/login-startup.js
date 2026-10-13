const path = require("node:path");

const STARTUP_NAME = "com.liuniang.openvoiceinput";
const STARTUP_ARGS = ["--autostart"];

function windowsExecutable(value) {
  return typeof value === "string"
    && /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/i.test(value)
    && /\.exe$/i.test(value) && !/[\x00-\x1f"]/.test(value);
}

function sameWindowsPath(left, right) {
  return typeof left === "string" && typeof right === "string"
    && path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}

function createLoginStartup({ app, platform = process.platform, execPath = process.execPath, env = process.env }) {
  function configuration() {
    if (!["win32", "darwin"].includes(platform)) return { reason: "此系统暂不支持开机自启。" };
    if (!app.isPackaged) return { reason: "请使用安装版或便携版设置开机自启；源码启动不会注册登录项。" };
    if (typeof app.getLoginItemSettings !== "function" || typeof app.setLoginItemSettings !== "function") {
      return { reason: "当前运行环境不支持系统登录项。" };
    }
    if (platform === "darwin") return { query: { type: "mainAppService" } };
    // Portable builds extract Electron to a temporary directory on every launch.
    const executable = Object.hasOwn(env, "PORTABLE_EXECUTABLE_FILE") ? env.PORTABLE_EXECUTABLE_FILE : execPath;
    if (!windowsExecutable(executable)) return { reason: "无法确定有效的启动程序路径，请从安装版或便携版重新打开。" };
    return { query: { path: executable, args: [...STARTUP_ARGS] } };
  }

  function readStatus() {
    const config = configuration();
    if (config.reason) return { ok: true, supported: false, enabled: false, state: "unavailable", message: config.reason };
    try {
      const native = app.getLoginItemSettings(config.query);
      if (platform === "darwin") {
        const pending = native.status === "requires-approval";
        const missing = native.status === "not-found";
        const enabled = !pending && !missing && native.openAtLogin === true;
        return { ok: true, supported: true, enabled, state: pending ? "requires-approval" : missing ? "not-found" : enabled ? "enabled" : "disabled",
          message: pending ? "请在 macOS 系统设置 → 通用 → 登录项中允许 Open Voice Input，然后重新打开此页面。"
            : missing ? "系统未找到此登录项，请将应用放入“应用程序”目录后重新设置。"
              : enabled ? "登录后自动驻留菜单栏，不打开主窗口。" : "开机自启已关闭。" };
      }
      const matches = Array.isArray(native.launchItems) ? native.launchItems.filter(item =>
        sameWindowsPath(item.path, config.query.path)
        && Array.isArray(item.args) && item.args.length === STARTUP_ARGS.length
        && item.args.every((arg, index) => arg === STARTUP_ARGS[index])) : null;
      const ownItem = matches?.find(item => item.name === STARTUP_NAME && item.scope === "user");
      const enabled = native.openAtLogin === true && (ownItem ? ownItem.enabled === true
        : matches ? matches.some(item => item.enabled === true) : native.executableWillLaunchAtLogin === true);
      return { ok: true, supported: true, enabled, state: enabled ? "enabled" : "disabled",
        message: enabled ? "登录后自动驻留托盘，不打开主窗口。" : "开机自启已关闭。" };
    } catch {
      return { ok: false, supported: true, enabled: null, state: "error", message: "无法读取系统登录项，请稍后重新打开此页面。" };
    }
  }

  function setEnabled(enabled) {
    if (typeof enabled !== "boolean") return { ...readStatus(), ok: false, message: "开机自启设置无效，请重试。" };
    const config = configuration();
    if (config.reason) return readStatus();
    try {
      app.setLoginItemSettings({ ...config.query, openAtLogin: enabled,
        ...(platform === "win32" ? { name: STARTUP_NAME, enabled } : {}) });
    } catch {
      return { ...readStatus(), ok: false, message: "系统未能修改开机自启，请检查系统登录项后重试。" };
    }
    const result = readStatus();
    if (result.ok && (result.enabled === enabled || (enabled && result.state === "requires-approval"))) return result;
    return { ...result, ok: false, message: "系统尚未应用开机自启设置，请检查系统登录项后重试。" };
  }

  function wasOpenedAtLogin(argv = []) {
    if (argv.includes("--autostart")) return true;
    const config = configuration();
    if (platform !== "darwin" || config.reason) return false;
    try { return app.getLoginItemSettings(config.query).wasOpenedAtLogin === true; }
    catch { return false; }
  }

  return { readStatus, setEnabled, wasOpenedAtLogin };
}

module.exports = { createLoginStartup, STARTUP_NAME, STARTUP_ARGS };
