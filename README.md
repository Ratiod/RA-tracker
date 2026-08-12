# RA Tracker (desktop app)

This is the "RA Tracker.exe" the Admin Panel's **Tracker Keys** tab already
promises. It replaces `SCRIM_STATS_LAST2.bat`: instead of double-clicking a
script after every scrim and manually uploading the JSON it produces, this
app sits in the system tray, watches Valorant's log in the background, and
uploads each finished match to your tracker site automatically.

No server or database changes were needed — it POSTs to the existing
`/api/tracker/upload` endpoint using the same `matchData` / `myRiotId` shape
and `x-tracker-key` header the backend already expects.

## How it works

1. On launch you see a window (not hidden in the tray) with a Setup panel:
   tracker site URL, tracker key (from Admin Panel → Tracker Keys → Generate),
   and optionally your Riot ID.
2. **Save & Connect** starts the watcher. You can then click **Minimize to
   tray** yourself, or just close the window — both keep it running in the
   background; it only ever quits from the tray menu's "Quit RA Tracker."
3. In the background it polls `ShooterGame.log` every 5s (same file the
   `.bat` read), extracts `ares-coregame` match IDs, and — once an ID has
   stopped appearing in the log for ~45s (i.e. the match ended) — fetches
   match details + player names from Riot's local/pd APIs exactly like the
   `.bat` did, then uploads the result.
4. Duplicate matches (already-uploaded map+date+score) are reported as
   "skipped duplicate," matching the server's existing 409 response.

## Run it in dev

```bash
cd tracker-app
npm install
npm start
```

Requires Windows with Valorant installed (the lockfile/log paths are
Windows-only, same as the original `.bat`).

## Build the installer

```bash
npm run dist
```

This uses `electron-builder` with the NSIS target already configured in
`package.json` and produces `RA Tracker Setup.exe` under `dist/`. Host that
file (e.g. as a GitHub release asset or a static file in `api/public/`) and
point the Admin Panel's "Download RA Tracker.exe" button at its URL.

## Notes / things to keep an eye on

- The Riot **client version** used in API headers is scraped live from the
  log the same way the `.bat` did, with a hardcoded fallback in
  `riotClient.js` (`FALLBACK_CLIENT_VERSION`) in case that regex ever misses
  a new log format — bump that string if Riot changes their log format and
  matches stop resolving.
- The 45-second "quiet period" (`QUIET_MS` in `riotClient.js`) is a
  heuristic for "the match is over": tune it if matches are being fetched
  too early (incomplete stats) or too late.
- Auth/session tokens are re-fetched fresh for every match rather than
  cached, so there's nothing to expire or refresh.
- Settings are stored locally via `electron-store` (plain JSON under the
  user's AppData), not synced anywhere else.
