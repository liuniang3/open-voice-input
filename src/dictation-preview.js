"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createWindowMotion } = require("./window-motion");

function createDictationPreview({ BrowserWindow, ipcMain, mainWindow, authorized, onCommand,
  platform = process.platform } = {}) {
  if (platform !== "win32") return null;
  const page = path.join(__dirname, "renderer/dictation-preview.html"), url = pathToFileURL(page).href;
  let win = null, motion = null, ready = null, reducedMotion = true;
  let enabled = false, disposed = false, failed = false, revision = 0;
  let state = { kind: "recording", title: "正在录音", detail: "", preview: false };
  const alive = () => !disposed && win && !win.isDestroyed();
  const sender = event => alive() && event.sender === win.webContents && event.sender.getURL() === url
    && (!event.senderFrame || event.senderFrame.url === url);
  function publish() { if (alive() && enabled) win.webContents.send("dictation:preview:state", state); }
  function create() {
    win = new BrowserWindow({ width: 340, height: 116, useContentSize: true, frame: false,
      thickFrame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
      backgroundMaterial: "none", roundedCorners: false,
      show: false, resizable: false, movable: true, skipTaskbar: true, alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, "dictation-preview-preload.js"),
        contextIsolation: true, nodeIntegration: false, sandbox: true } });
    motion = createWindowMotion({ window: win });
    motion.setReducedMotion(reducedMotion);
    ready = win.loadFile(page).then(() => true).catch(() => false);
    // Per-pixel alpha is the only backdrop on Windows. Native Acrylic/accent
    // paints a rectangle outside the CSS radius and can turn opaque on blur.
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, destination) => { if (destination !== url) event.preventDefault(); });
    win.webContents.on("render-process-gone", () => {
      failed = true;
      if (!enabled || !alive() || mainWindow.isDestroyed()) return;
      enabled = false; motion.hide(); mainWindow.show(); mainWindow.focus();
    });
    win.on("close", event => { event.preventDefault(); if (enabled) onCommand("cancel"); });
  }

  const onState = (event, value) => {
    if (!authorized(event) || !value || typeof value !== "object" || !enabled) return;
    if (!["ready", "recording", "transcribing", "warning", "error"].includes(value.kind)
      || typeof value.title !== "string" || typeof value.detail !== "string") return;
    state = { kind: value.kind, title: value.title, detail: value.detail, preview: value.preview === true };
    publish();
  };
  const onSpectrum = (event, levels) => {
    if (!authorized(event) || !enabled || !alive() || state.kind !== "recording" || !Array.isArray(levels) || levels.length !== 36
      || levels.some(value => !Number.isFinite(value) || value < 0 || value > 1)) return;
    win.webContents.send("dictation:preview:spectrum", levels);
  };
  const onPreviewCommand = (event, command) => {
    if (sender(event) && enabled && ["stop", "cancel"].includes(command)) onCommand(command);
  };
  ipcMain.on("dictation:preview:update", onState);
  ipcMain.on("dictation:preview:bands", onSpectrum);
  ipcMain.on("dictation:preview:command", onPreviewCommand);
  ipcMain.handle("dictation:preview:ready", event => sender(event) ? state : null);

  return {
    async show() {
      if (disposed || failed) return false;
      if (!alive()) create();
      const current = ++revision;
      if (!enabled) state = { kind: "recording", title: "正在录音", detail: "", preview: false };
      enabled = true;
      if (!await ready || !alive() || failed || !enabled || revision !== current) return false;
      if (!win.isVisible()) win.setBounds(mainWindow.getBounds(), false);
      publish(); motion.show(); mainWindow.hide(); return true;
    },
    hide(onHidden) {
      enabled = false; revision++;
      return motion ? motion.hide(onHidden) : Promise.resolve(false);
    },
    getWindow: () => alive() ? win : null,
    isVisible: () => alive() && enabled && win.isVisible(),
    setReducedMotion: value => { reducedMotion = value; motion?.setReducedMotion(value); },
    dispose() {
      if (disposed) return;
      disposed = true; enabled = false; revision++; motion?.dispose();
      ipcMain.removeListener("dictation:preview:update", onState);
      ipcMain.removeListener("dictation:preview:bands", onSpectrum);
      ipcMain.removeListener("dictation:preview:command", onPreviewCommand);
      ipcMain.removeHandler("dictation:preview:ready");
      if (win && !win.isDestroyed()) win.destroy();
    }
  };
}

module.exports = { createDictationPreview };
