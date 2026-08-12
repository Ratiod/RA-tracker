// preload.js
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  saveConfig: (cfg) => ipcRenderer.invoke("save-config", cfg),
  startWatching: () => ipcRenderer.invoke("start-watching"),
  stopWatching: () => ipcRenderer.invoke("stop-watching"),
  pauseWatching: () => ipcRenderer.invoke("pause-watching"),
  resumeWatching: () => ipcRenderer.invoke("resume-watching"),
  minimizeToTray: () => ipcRenderer.invoke("minimize-to-tray"),
  testConnection: (cfg) => ipcRenderer.invoke("test-connection", cfg),
  quitApp: () => ipcRenderer.invoke("quit-app"),

  onLog: (cb) => ipcRenderer.on("log", (_e, msg) => cb(msg)),
  onStatus: (cb) => ipcRenderer.on("status", (_e, status) => cb(status)),
  onUploadResult: (cb) => ipcRenderer.on("upload-result", (_e, result) => cb(result)),
});
