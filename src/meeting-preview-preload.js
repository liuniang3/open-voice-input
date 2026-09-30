"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("meetingPreview", {
  ready: () => ipcRenderer.invoke("meeting:preview:ready"),
  restore: () => ipcRenderer.invoke("meeting:preview:restore"),
  presentation: input => ipcRenderer.invoke("meeting:preview:presentation", input),
  resize: input => ipcRenderer.invoke("meeting:preview:resize", input),
  onUpdate: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on("meeting:preview:update", listener);
    return () => ipcRenderer.removeListener("meeting:preview:update", listener); }
});
