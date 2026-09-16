"use strict";

const { execFile, execFileSync } = require("node:child_process");
const path = require("node:path");
const { resolveHelperPath } = require("../meeting/paths");

// Lazy Electron access keeps the module importable by portable Node tests.
function createMacOSUtilities({ electron, execFileImpl = execFile, execFileSyncImpl = execFileSync,
  platform = process.platform, helperPath } = {}) {
  const api = () => electron || require("electron");
  const supported = () => {
    if (platform !== "darwin") throw Object.assign(new Error("macOS utility unavailable"), { code: "platform_unsupported" });
  };
  const binary = () => helperPath || resolveHelperPath({ platform: "darwin",
    isPackaged: Boolean(api().app.isPackaged), resourcesPath: process.resourcesPath || "",
    appRoot: path.resolve(__dirname, "../..") });

  function getForegroundApp() {
    supported();
    try {
      const pid = String(execFileSyncImpl(binary(), ["--foreground-app"], {
        encoding: "utf8", timeout: 2000, maxBuffer: 4096, windowsHide: true
      })).trim();
      return /^[1-9]\d*$/.test(pid) ? pid : "";
    } catch { return ""; }
  }

  async function pasteToApp(pid) {
    supported();
    if (!/^[1-9]\d{0,9}$/.test(String(pid)) || Number(pid) > 2147483647) {
      throw Object.assign(new Error("Invalid target application PID"), { code: "invalid_pid" });
    }
    if (!api().systemPreferences.isTrustedAccessibilityClient(false)) {
      throw Object.assign(new Error("Allow Accessibility access for Open Voice Input in System Settings"), { code: "accessibility_denied" });
    }
    return new Promise((resolve, reject) => {
      execFileImpl(binary(), ["--paste-to-app", String(pid)], {
        timeout: 5000, maxBuffer: 4096, windowsHide: true
      }, (error) => error
        ? reject(Object.assign(new Error("Could not focus/paste into the target application; check Accessibility access"), { code: "paste_failed" }))
        : resolve(true));
    });
  }

  async function requestMicrophoneAccess() {
    supported();
    return api().systemPreferences.askForMediaAccess("microphone");
  }

  async function requestScreenAccess() {
    supported();
    const host = api();
    if (host.systemPreferences.getMediaAccessStatus("screen") === "granted") return true;
    // Ask in the Electron host's TCC identity when possible. No thumbnails are retained.
    if (host.desktopCapturer?.getSources) {
      try {
        const sources = await host.desktopCapturer.getSources({ types: ["screen"],
          thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
        return host.systemPreferences.getMediaAccessStatus("screen") === "granted" || sources.length > 0;
      } catch { return false; }
    }
    return new Promise(resolve => {
      execFileImpl(binary(), ["--request-screen-access"], { timeout: 90000, maxBuffer: 4096, windowsHide: true },
        (error, stdout) => resolve(!error && String(stdout).trim() === "true"));
    });
  }

  function getPermissionStatus() {
    supported();
    const prefs = api().systemPreferences;
    return { microphone: prefs.getMediaAccessStatus("microphone"), screen: prefs.getMediaAccessStatus("screen"),
      accessibility: prefs.isTrustedAccessibilityClient(false) ? "granted" : "denied" };
  }

  async function openPermissionSettings(kind) {
    supported();
    const panes = { microphone: "Privacy_Microphone", screen: "Privacy_ScreenCapture", accessibility: "Privacy_Accessibility" };
    if (!Object.hasOwn(panes, kind)) throw Object.assign(new Error("Unknown permission kind"), { code: "invalid_permission" });
    await api().shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${panes[kind]}`);
  }
  return { getForegroundApp, pasteToApp, requestMicrophoneAccess, requestScreenAccess, getPermissionStatus, openPermissionSettings };
}

module.exports = { ...createMacOSUtilities(), createMacOSUtilities };
