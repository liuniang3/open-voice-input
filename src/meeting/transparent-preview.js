"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { minimalBounds } = require("../settings/meeting-window");

function createTransparentPreview({ BrowserWindow, ipcMain, screen, mainWindow, onPresentation, onBounds,
  platform = process.platform, schedule = setInterval, cancel = clearInterval } = {}) {
  const page = path.join(__dirname, "../renderer/meeting-preview.html");
  const url = pathToFileURL(page).href;
  let win = null, current = {}, draft = "", sessionId = null;
  let enabled = false, ready = false, pointerInside = false, pointerTimer = null, suspended = false;
  let resizeOrigin = null;
  function sender(event) {
    return win && !win.isDestroyed() && event.sender === win.webContents
      && event.sender.getURL() === url && (!event.senderFrame || event.senderFrame.url === url);
  }
  function snapshot() { return { text: draft, fontSize: current.fontSize || 14, hovered: pointerInside }; }
  function publish() { if (ready && win && !win.isDestroyed()) win.webContents.send("meeting:preview:update", snapshot()); }
  function pollPointer() {
    if (!enabled || !win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint(), b = win.getBounds();
    const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    if (inside !== pointerInside) { pointerInside = inside; publish(); }
  }
  function hide() {
    cancel(pointerTimer); pointerTimer = null; resizeOrigin = null;
    if (win && !win.isDestroyed()) win.hide();
    if (enabled && !mainWindow.isDestroyed()) mainWindow.showInactive();
    enabled = false; pointerInside = false;
  }
  function show() {
    if (!enabled || !ready || suspended || !win || win.isDestroyed() || mainWindow.isDestroyed()) return;
    win.setBounds(current.bounds, false);
    win.setAlwaysOnTop(Boolean(current.alwaysOnTop));
    publish(); win.showInactive(); win.moveTop?.(); mainWindow.hide();
    if (!pointerTimer) { pointerTimer = schedule(pollPointer, 100); pointerTimer?.unref?.(); }
    pollPointer();
  }
  function create() {
    win = new BrowserWindow({ ...current.bounds, minWidth: 240, minHeight: 100, show: false,
      frame: false, thickFrame: false, transparent: true, backgroundColor: "#00000000",
      resizable: false, movable: true, skipTaskbar: true, hasShadow: false,
      webPreferences: { preload: path.join(__dirname, "../meeting-preview-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    win.webContents.once("did-finish-load", () => { ready = true; show(); });
    win.webContents.setWindowOpenHandler?.(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, destination) => { if (destination !== url) event.preventDefault(); });
    win.on("move", () => {
      if (enabled && ready && !win.isDestroyed()) onBounds(win.getBounds());
    });
    win.on("close", event => { event.preventDefault(); hide(); });
    win.on("closed", () => { cancel(pointerTimer); pointerTimer = null; win = null; ready = false; });
    void win.loadFile(page).catch(() => { hide(); });
  }
  function update(value = {}) {
    const oldSession = sessionId;
    if (Object.hasOwn(value, "sessionId")) sessionId = value.sessionId;
    if (oldSession !== sessionId) draft = "";
    if (value.previewText) draft = String(value.previewText);
    else if (value.rawText) draft = String(value.rawText).split(/\n+/).filter(Boolean).at(-1) || draft;
    current = { ...current, ...value };
    const next = platform === "win32" && current.floating === true && current.opacity === 0 && current.bounds
      && minimalBounds(current.bounds) && !suspended;
    if (!next) { hide(); return; }
    const entering = !enabled;
    enabled = true;
    if (!win || win.isDestroyed()) create();
    else if (entering) show();
    else { win.setAlwaysOnTop(Boolean(current.alwaysOnTop)); publish(); }
  }
  const handlers = {
    "meeting:preview:ready": () => snapshot(),
    "meeting:preview:restore": () => onPresentation({ restoreNormal: true }),
    "meeting:preview:presentation": input => {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("preview_invalid");
      const patch = {};
      if (Object.hasOwn(input, "fontSize")) {
        if (!Number.isFinite(input.fontSize) || input.fontSize < 12 || input.fontSize > 28) throw new Error("preview_invalid");
        patch.fontSize = input.fontSize;
      }
      if (Object.hasOwn(input, "opacity")) {
        if (!Number.isFinite(input.opacity) || input.opacity < 0 || input.opacity > 1) throw new Error("preview_invalid");
        patch.opacity = input.opacity;
      }
      return onPresentation(patch);
    },
    "meeting:preview:resize": input => {
      const edge = String(input?.edge || "");
      if (!/^(?:n|ne|e|se|s|sw|w|nw)$/.test(edge) || typeof input?.phase !== "string") throw new Error("preview_invalid");
      if (input.phase === "start") {
        resizeOrigin = { edge, bounds: win.getBounds(), point: screen.getCursorScreenPoint() }; return;
      }
      if (!resizeOrigin || resizeOrigin.edge !== edge) return;
      if (input.phase === "end") { resizeOrigin = null; return; }
      if (input.phase !== "move") throw new Error("preview_invalid");
      const point = screen.getCursorScreenPoint(), initial = resizeOrigin.bounds;
      const dx = point.x - resizeOrigin.point.x, dy = point.y - resizeOrigin.point.y;
      const width = Math.min(6000, Math.max(240, initial.width + (edge.includes("w") ? -dx : edge.includes("e") ? dx : 0)));
      const height = Math.min(4000, Math.max(100, initial.height + (edge.includes("n") ? -dy : edge.includes("s") ? dy : 0)));
      const bounds = { width, height, x: initial.x + (edge.includes("w") ? initial.width - width : 0),
        y: initial.y + (edge.includes("n") ? initial.height - height : 0) };
      win.setBounds(bounds, false); onBounds(bounds);
    }
  };
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, async (event, input) => {
    if (!sender(event) || !enabled) return { ok: false, error: "preview_unavailable" };
    try { return { ok: true, value: await handler(input) }; }
    catch { return { ok: false, error: "preview_unavailable" }; }
  });
  return { update, reveal() {
      if (!enabled || !ready || suspended || !win || win.isDestroyed()) return false;
      show(); return true;
    }, suspend() { suspended = true; hide(); }, resume() { suspended = false; update(); },
    dispose() { hide(); if (win && !win.isDestroyed()) win.destroy(); for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel); } };
}

module.exports = { createTransparentPreview };
