// main.js
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification } = require("electron");
const path = require("path");
const Store = require("electron-store");
const RiotClient = require("./riotClient");

const store = new Store();

let mainWindow = null;
let tray = null;
let riotClient = null;
let isQuitting = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 680,
    minWidth: 420,
    minHeight: 560,
    show: true, // always show on launch so the user sees the app before it ever minimizes
    backgroundColor: "#080a10",
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Clicking the window's (X) hides to tray instead of quitting — the app keeps
  // watching in the background. Quitting is only ever done from the tray menu
  // or the in-app Quit button, both explicit choices.
  mainWindow.on("close", (e) => {
    if (isQuitting) return;
    e.preventDefault();
    mainWindow.hide();
    if (!store.get("hasShownTrayNotice")) {
      showTrayNotice();
      store.set("hasShownTrayNotice", true);
    }
  });
}

function showTrayNotice() {
  if (Notification.isSupported()) {
    new Notification({
      title: "RA Tracker is still running",
      body: "It keeps watching for matches in the background. Click the tray icon any time to reopen it.",
    }).show();
  }
}

function createTray() {
  const trayIconPath = path.join(__dirname, "assets", "icon-tray.png");
  let image = nativeImage.createFromPath(trayIconPath);
  if (image.isEmpty()) image = nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip("RA Tracker");
  updateTrayMenu("idle");

  tray.on("click", () => toggleWindow());
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function updateTrayMenu(status) {
  if (!tray) return;
  const statusLabel =
    {
      idle: "Status: Not watching",
      watching: "Status: Watching for matches",
      paused: "Status: Paused",
      error: "Status: Needs attention",
    }[status] || "Status: Unknown";

  const menu = Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { type: "separator" },
    {
      label: "Show RA Tracker",
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      },
    },
    {
      label: "Quit RA Tracker",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  riotClient = new RiotClient({
    getConfig: () => ({
      apiUrl: store.get("apiUrl", "https://tracker2-ten.vercel.app"),
      trackerKey: store.get("trackerKey", ""),
      riotId: store.get("riotId", ""),
    }),
    onLog: (msg) => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send("log", msg),
    onStatus: (status) => {
      updateTrayMenu(status);
      mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send("status", status);
    },
    onUpload: (result) => {
      mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send("upload-result", result);
      if (Notification.isSupported()) {
        new Notification({
          title: result.ok ? "Match uploaded" : "Upload needs attention",
          body: result.message,
        }).show();
      }
    },
  });

  // If it's already configured from a previous run, start watching immediately.
  if (store.get("trackerKey")) riotClient.start();
});

app.on("window-all-closed", (e) => {
  // Never quit on window close — this is a background/tray app.
  e.preventDefault();
});

app.on("before-quit", () => {
  isQuitting = true;
  riotClient && riotClient.stop();
});

// ---------------- IPC ----------------

ipcMain.handle("get-config", () => ({
  apiUrl: store.get("apiUrl", "https://tracker2-ten.vercel.app"),
  trackerKey: store.get("trackerKey", ""),
  riotId: store.get("riotId", ""),
  autostart: store.get("autostart", false),
  watching: !!(riotClient && riotClient.running && !riotClient.paused),
  paused: !!(riotClient && riotClient.paused),
}));

ipcMain.handle("save-config", (e, cfg) => {
  store.set("apiUrl", (cfg.apiUrl || "").trim());
  store.set("trackerKey", (cfg.trackerKey || "").trim());
  store.set("riotId", (cfg.riotId || "").trim());
  store.set("autostart", !!cfg.autostart);
  app.setLoginItemSettings({ openAtLogin: !!cfg.autostart });
  return true;
});

ipcMain.handle("start-watching", () => {
  riotClient.start();
  return true;
});

ipcMain.handle("stop-watching", () => {
  riotClient.stop();
  return true;
});

ipcMain.handle("pause-watching", () => {
  riotClient.pause();
  return true;
});

ipcMain.handle("resume-watching", () => {
  riotClient.resume();
  return true;
});

ipcMain.handle("minimize-to-tray", () => {
  mainWindow.hide();
  return true;
});

ipcMain.handle("test-connection", async (e, cfg) => riotClient.testTrackerKey(cfg));

ipcMain.handle("quit-app", () => {
  isQuitting = true;
  app.quit();
});
