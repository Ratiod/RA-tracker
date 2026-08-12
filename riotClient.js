// riotClient.js
// Node port of SCRIM_STATS_LAST2.bat — reads the local Riot lockfile, fetches
// match details + player names, and pushes finished scrims to the tracker API.

const fs = require("fs");
const path = require("path");
const https = require("https");

// Same base64 client-platform header the .bat used.
const CLIENT_PLATFORM_B64 =
  "ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9";

const FALLBACK_CLIENT_VERSION = "release-12.06-shipping-19-4440219";
const MATCH_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

// How long a match ID has to go "quiet" in the log (no new mentions) before
// we treat the match as finished and try to fetch/upload it.
const QUIET_MS = 45_000;
// How often we poll the log file for new lines / re-check quiet matches.
const POLL_MS = 5_000;
// Matches older than this are dropped from memory so the map doesn't grow forever.
const FORGET_MS = 6 * 60 * 60 * 1000; // 6 hours

function getLockfilePath() {
  return path.join(process.env.LOCALAPPDATA || "", "Riot Games", "Riot Client", "Config", "lockfile");
}
function getLogPath() {
  return path.join(process.env.LOCALAPPDATA || "", "VALORANT", "Saved", "Logs", "ShooterGame.log");
}

function httpRequest(url, { method = "GET", headers = {}, body = null, insecure = false } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(e);
    }
    const options = {
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers,
    };
    if (insecure) options.rejectUnauthorized = false;

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

class RiotClient {
  /**
   * @param {object} opts
   * @param {() => {apiUrl:string, trackerKey:string, riotId:string}} opts.getConfig
   * @param {(msg:string)=>void} opts.onLog
   * @param {(status:'idle'|'watching'|'error')=>void} opts.onStatus
   * @param {(result:{ok:boolean,message:string})=>void} opts.onUpload
   */
  constructor({ getConfig, onLog, onStatus, onUpload }) {
    this.getConfig = getConfig;
    this.onLog = onLog || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onUpload = onUpload || (() => {});

    this.running = false;
    this.paused = false;
    this.timer = null;
    this.logReadPos = 0;
    this.seenMatches = new Map(); // matchId -> { lastSeen, uploaded }
    this.puuid = null;
    this._loggedWaiting = false;
  }

  log(msg) {
    this.onLog(`[${new Date().toLocaleTimeString()}] ${msg}`);
  }

  start() {
    this.paused = false;
    if (this.running) {
      this.onStatus("watching");
      this.log("Resumed \u2014 watching for finished matches\u2026");
      return;
    }
    this.running = true;
    this.onStatus("watching");
    this.log("Watching for finished matches\u2026");
    this._loop();
  }

  /** Stop picking up new matches, but let anything already mid-upload finish. */
  pause() {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.onStatus("paused");
    this.log("Paused \u2014 no new matches will be picked up until resumed.");
  }

  resume() {
    if (!this.running || !this.paused) return;
    this.start();
  }

  /** Halt everything immediately, including the poll loop. */
  stop() {
    this.running = false;
    this.paused = false;
    if (this.timer) clearTimeout(this.timer);
    this.onStatus("idle");
    this.log("Stopped watching.");
  }

  async _loop() {
    if (!this.running) return;
    try {
      if (!this.paused) await this._tick();
    } catch (err) {
      this.log(`Watcher error: ${err.message}`);
    }
    this.timer = setTimeout(() => this._loop(), POLL_MS);
  }

  async _tick() {
    const lockfilePath = getLockfilePath();
    if (!fs.existsSync(lockfilePath)) {
      if (!this._loggedWaiting) {
        this.log("Waiting for Valorant to be running\u2026");
        this._loggedWaiting = true;
      }
      return;
    }
    this._loggedWaiting = false;

    const logPath = getLogPath();
    if (!fs.existsSync(logPath)) return;

    const stats = fs.statSync(logPath);
    if (stats.size < this.logReadPos) this.logReadPos = 0; // log rotated

    if (stats.size > this.logReadPos) {
      const fd = fs.openSync(logPath, "r");
      const length = stats.size - this.logReadPos;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, this.logReadPos);
      fs.closeSync(fd);
      this.logReadPos = stats.size;

      const chunk = buffer.toString("utf8");
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.includes("ares-coregame")) continue;
        const ids = line.match(MATCH_ID_RE);
        if (!ids) continue;
        for (const id of ids) {
          if (this.puuid && id === this.puuid) continue;
          const entry = this.seenMatches.get(id) || { lastSeen: 0, uploaded: false };
          entry.lastSeen = Date.now();
          this.seenMatches.set(id, entry);
        }
      }
    }

    await this._checkQuietMatches();
    this._forgetOldMatches();
  }

  async _checkQuietMatches() {
    const now = Date.now();
    for (const [id, entry] of this.seenMatches) {
      if (entry.uploaded) continue;
      if (now - entry.lastSeen >= QUIET_MS) {
        entry.uploaded = true; // don't retry automatically even on failure — avoids spamming the API
        await this._processMatch(id);
      }
    }
  }

  _forgetOldMatches() {
    const now = Date.now();
    for (const [id, entry] of this.seenMatches) {
      if (now - entry.lastSeen > FORGET_MS) this.seenMatches.delete(id);
    }
  }

  async _processMatch(matchId) {
    const cfg = this.getConfig();
    if (!cfg.trackerKey || !cfg.apiUrl) {
      this.log(`Match ${matchId.slice(0, 8)}\u2026 finished, but no tracker key is set yet.`);
      return;
    }

    this.log(`Match ${matchId.slice(0, 8)}\u2026 finished \u2014 fetching details\u2026`);
    try {
      const auth = await this._getAuth();
      const clientVersion = this._getClientVersion();
      const shard = this._getShard();

      const matchData = await this._fetchMatchDetails({ ...auth, clientVersion, shard, matchId });
      await this._resolveNames({ ...auth, clientVersion, shard, matchData });

      const result = await this._uploadToTracker({
        apiUrl: cfg.apiUrl,
        trackerKey: cfg.trackerKey,
        riotId: cfg.riotId,
        matchData,
      });
      this.onUpload(result);
      this.log(result.message);
    } catch (err) {
      const msg = `Couldn't process match ${matchId.slice(0, 8)}\u2026: ${err.message}`;
      this.log(msg);
      this.onUpload({ ok: false, message: msg });
    }
  }

  async _getAuth() {
    const lockfilePath = getLockfilePath();
    const raw = fs.readFileSync(lockfilePath, "utf8").trim();
    const parts = raw.split(":");
    const port = parts[2];
    const password = parts[3];
    if (!port || !password) throw new Error("Could not read the Riot lockfile.");

    const resp = await httpRequest(`https://127.0.0.1:${port}/entitlements/v1/token`, {
      headers: { Authorization: "Basic " + Buffer.from(`riot:${password}`).toString("base64") },
      insecure: true,
    });
    let json;
    try {
      json = JSON.parse(resp.body);
    } catch {
      throw new Error("Riot client API returned an unexpected response.");
    }
    if (!json.accessToken) throw new Error("Could not get a Riot auth token (is Valorant running and logged in?).");
    this.puuid = json.subject;
    return { accessToken: json.accessToken, entitlementToken: json.token, puuid: json.subject, port, password };
  }

  _getClientVersion() {
    try {
      const log = fs.readFileSync(getLogPath(), "utf8");
      const m =
        log.match(/(release-\d+\.\d+-shipping-\d+-\d+)/) || log.match(/(release-[\d.]+-shipping-\d+-\d+)/);
      if (m) return m[1];
    } catch {
      /* fall through to default */
    }
    return FALLBACK_CLIENT_VERSION;
  }

  _getShard() {
    try {
      const log = fs.readFileSync(getLogPath(), "utf8");
      const m = log.match(/pd\.([a-z]+)\.a\.pvp\.net/);
      if (m) return m[1];
    } catch {
      /* fall through to default */
    }
    return "ap";
  }

  async _fetchMatchDetails({ accessToken, entitlementToken, clientVersion, shard, matchId }) {
    const resp = await httpRequest(`https://pd.${shard}.a.pvp.net/match-details/v1/matches/${matchId}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Riot-Entitlements-JWT": entitlementToken,
        "X-Riot-ClientPlatform": CLIENT_PLATFORM_B64,
        "X-Riot-ClientVersion": clientVersion,
      },
    });
    let json;
    try {
      json = JSON.parse(resp.body);
    } catch {
      throw new Error("Match-details API returned an unexpected response.");
    }
    if (json.errorCode) throw new Error(`Riot API error: ${json.errorCode}`);
    return json;
  }

  async _resolveNames({ accessToken, entitlementToken, clientVersion, shard, matchData, port, password }) {
    const puuids = (matchData.players || []).map((p) => p.subject);

    const resp = await httpRequest(`https://pd.${shard}.a.pvp.net/name-service/v2/players`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Riot-Entitlements-JWT": entitlementToken,
        "X-Riot-ClientPlatform": CLIENT_PLATFORM_B64,
        "X-Riot-ClientVersion": clientVersion,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(puuids),
    });

    let nameList = [];
    try {
      nameList = JSON.parse(resp.body);
    } catch {
      /* best effort */
    }
    const nameMap = {};
    for (const entry of Array.isArray(nameList) ? nameList : []) {
      if (entry.Subject) nameMap[entry.Subject] = entry;
    }
    for (const player of matchData.players || []) {
      const info = nameMap[player.subject];
      if (info && info.GameName) {
        player.gameName = info.GameName;
        player.tagLine = info.TagLine;
      }
    }

    // Fallback for accounts the name-service can't resolve (e.g. some CN accounts) —
    // same local chat-API trick the .bat used.
    const missing = (matchData.players || []).filter((p) => !p.gameName);
    if (missing.length && port && password) {
      try {
        const chatResp = await httpRequest(`https://127.0.0.1:${port}/chat/v5/participants`, {
          headers: { Authorization: "Basic " + Buffer.from(`riot:${password}`).toString("base64") },
          insecure: true,
        });
        const chatJson = JSON.parse(chatResp.body);
        const chatMap = {};
        for (const p of chatJson.participants || []) {
          if (p.puuid) chatMap[p.puuid] = p;
        }
        for (const player of missing) {
          const cp = chatMap[player.subject];
          if (cp && cp.game_name) {
            player.gameName = cp.game_name;
            player.tagLine = cp.game_tag;
          } else if (cp && cp.name) {
            player.gameName = cp.name;
            player.tagLine = "";
          }
        }
      } catch {
        /* best effort — leave unresolved names as-is */
      }
    }

    for (const player of matchData.players || []) {
      if (!player.gameName) {
        player.gameName = "Unknown";
        player.tagLine = (player.subject || "").slice(0, 8);
      }
    }
  }

  async _uploadToTracker({ apiUrl, trackerKey, riotId, matchData }) {
    const resp = await httpRequest(`${apiUrl.replace(/\/$/, "")}/api/tracker/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-tracker-key": trackerKey },
      body: JSON.stringify({ matchData, myRiotId: riotId }),
    });
    let json = {};
    try {
      json = JSON.parse(resp.body);
    } catch {
      /* non-JSON error page etc */
    }
    if (resp.statusCode === 200 && json.success) {
      const s = json.scrim || {};
      return { ok: true, message: `Uploaded: ${s.map || "match"}${s.score ? ` (${s.score})` : ""}` };
    }
    if (resp.statusCode === 409) {
      return { ok: true, message: "Already uploaded \u2014 skipped duplicate." };
    }
    return { ok: false, message: json.error || `Upload failed (HTTP ${resp.statusCode}).` };
  }

  /** Quick check used by the Setup screen's "Test connection" button. */
  async testTrackerKey(cfg) {
    if (!cfg.apiUrl || !cfg.trackerKey) return { ok: false, message: "Enter an API URL and tracker key first." };
    try {
      const resp = await httpRequest(`${cfg.apiUrl.replace(/\/$/, "")}/api/tracker/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tracker-key": cfg.trackerKey },
        body: JSON.stringify({}),
      });
      if (resp.statusCode === 401) return { ok: false, message: "That tracker key was rejected." };
      return { ok: true, message: "Connected \u2014 tracker key accepted." };
    } catch (err) {
      return { ok: false, message: `Couldn't reach ${cfg.apiUrl}: ${err.message}` };
    }
  }
}

module.exports = RiotClient;
