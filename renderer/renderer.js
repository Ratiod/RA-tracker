// renderer.js
const $ = (id) => document.getElementById(id);

const els = {
  apiUrl: $("apiUrl"),
  trackerKey: $("trackerKey"),
  riotId: $("riotId"),
  autostart: $("autostart"),
  saveBtn: $("saveBtn"),
  testBtn: $("testBtn"),
  testResult: $("testResult"),
  startBtn: $("startBtn"),
  pauseBtn: $("pauseBtn"),
  stopBtn: $("stopBtn"),
  statusDot: $("statusDot"),
  statusText: $("statusText"),
  minBtn: $("minBtn"),
  log: $("log"),
};

function addLog(text, cls) {
  const empty = els.log.querySelector(".empty");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.className = "line" + (cls ? ` ${cls}` : "");
  div.textContent = text;
  els.log.appendChild(div);
  els.log.scrollTop = els.log.scrollHeight;
}

function setStatus(status) {
  els.statusDot.className =
    "dot" + (status === "watching" ? " watching" : status === "error" ? " error" : status === "paused" ? " paused" : "");
  els.statusText.textContent =
    {
      watching: "WATCHING",
      paused: "PAUSED",
      error: "NEEDS ATTENTION",
    }[status] || "NOT WATCHING";

  // Button availability follows the current state:
  // idle -> only Start enabled
  // watching -> Pause + Stop enabled
  // paused -> Start (acts as Resume) + Stop enabled
  els.startBtn.disabled = status === "watching";
  els.startBtn.textContent = status === "paused" ? "Resume watching" : "Start watching";
  els.pauseBtn.disabled = status !== "watching";
  els.stopBtn.disabled = status === "idle";
}

async function loadConfig() {
  const cfg = await window.api.getConfig();
  els.apiUrl.value = cfg.apiUrl || "";
  els.trackerKey.value = cfg.trackerKey || "";
  els.riotId.value = cfg.riotId || "";
  els.autostart.checked = !!cfg.autostart;
  setStatus(cfg.paused ? "paused" : cfg.watching ? "watching" : "idle");
}

async function saveConfig() {
  await window.api.saveConfig({
    apiUrl: els.apiUrl.value,
    trackerKey: els.trackerKey.value,
    riotId: els.riotId.value,
    autostart: els.autostart.checked,
  });
}

els.saveBtn.addEventListener("click", async () => {
  await saveConfig();
  await window.api.startWatching();
  addLog("Settings saved. Starting watcher\u2026");
});

els.startBtn.addEventListener("click", async () => {
  await saveConfig();
  if (els.startBtn.textContent === "Resume watching") {
    await window.api.resumeWatching();
  } else {
    await window.api.startWatching();
  }
});

els.pauseBtn.addEventListener("click", async () => {
  await window.api.pauseWatching();
});

els.stopBtn.addEventListener("click", async () => {
  await window.api.stopWatching();
});

els.testBtn.addEventListener("click", async () => {
  els.testResult.textContent = "Testing\u2026";
  els.testResult.className = "test-result";
  const result = await window.api.testConnection({
    apiUrl: els.apiUrl.value,
    trackerKey: els.trackerKey.value,
  });
  els.testResult.textContent = result.message;
  els.testResult.className = "test-result " + (result.ok ? "ok" : "fail");
});

els.minBtn.addEventListener("click", () => {
  window.api.minimizeToTray();
});

window.api.onLog((msg) => addLog(msg));
window.api.onStatus((status) => setStatus(status));
window.api.onUploadResult((result) => addLog(result.message, result.ok ? "upload-ok" : "upload-fail"));

loadConfig();
