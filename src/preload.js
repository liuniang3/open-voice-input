const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mimoInput", {
  getStatus: () => ipcRenderer.invoke("app:status"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  log: (message, detail) => ipcRenderer.invoke("app:log", message, detail),
  transcribe: (payload) => ipcRenderer.invoke("voice:transcribe", payload),
  startRealtimeAsr: () => ipcRenderer.invoke("voice:realtime:start"),
  appendRealtimeAudio: (base64Audio) => ipcRenderer.invoke("voice:realtime:append", base64Audio),
  finishRealtimeAsr: (payload) => ipcRenderer.invoke("voice:realtime:finish", payload),
  cancelRealtimeAsr: () => ipcRenderer.invoke("voice:realtime:cancel"),
  testConnection: () => ipcRenderer.invoke("connection:test"),
  injectText: (text) => ipcRenderer.invoke("input:inject", text),
  copyText: (text) => ipcRenderer.invoke("clipboard:write-text", text),
  hide: () => ipcRenderer.invoke("window:hide"),
  clearRecordingKeys: () => ipcRenderer.invoke("recording:keys:clear"),
  resizeRecordingWindow: (size) => ipcRenderer.invoke("window:recording-resize", size),
  setCompactMode: (isCompact) => ipcRenderer.invoke("window:compact", isCompact),
  openSettings: () => ipcRenderer.invoke("window:settings"),
  openResultWindow: () => ipcRenderer.invoke("window:result"),
  onHotkeyRecord: (callback) => ipcRenderer.on("hotkey-record", callback),
  onRecordingCommand: (callback) => ipcRenderer.on("recording-command", (_event, command) => callback(command)),
  onRetryLastVoiceRequest: (callback) => ipcRenderer.on("retry-last-voice-request", callback),
  onOpenSettings: (callback) => ipcRenderer.on("open-settings", callback),
  onWindowMode: (callback) => ipcRenderer.on("window-mode", (_event, mode) => callback(mode)),
  onWindowBlur: (callback) => ipcRenderer.on("window-blur", callback),
  onPartialTranscript: (callback) => ipcRenderer.on("voice:partial-transcript", (_event, text) => callback(text))
});
