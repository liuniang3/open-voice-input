"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dictationPreview", {
  ready: () => ipcRenderer.invoke("dictation:preview:ready"),
  command: value => { if (["stop", "cancel"].includes(value)) ipcRenderer.send("dictation:preview:command", value); },
  onState: callback => ipcRenderer.on("dictation:preview:state", (_event, value) => callback(value)),
  onSpectrum: callback => ipcRenderer.on("dictation:preview:spectrum", (_event, value) => callback(value))
});
