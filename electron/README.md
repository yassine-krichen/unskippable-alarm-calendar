# Electron shell

Main process: scheduler, centered alarm panels, tray, local JSON cache, and the
loader for the shared React app (`app/`). See `docs/spec.md` sections 6 and 9.

## Run

- `task alarm-calendar:electron` starts the Vite dev server of the React app on port 3021
  (unless something already answers there) and Electron, which loads it. Sign in by emailed
  code in the main window. Only processes the script started are stopped when Electron exits.
- `task alarm-calendar:electron:seed` adds two seeded test alarms (about 1 and 1.5 min after
  launch) to an empty seed cache; once a signed-in sync has delivered real events they replace the seed.
  `task alarm-calendar:electron:reset` wipes the seed cache first. Both use the separate seed
  folder, so they never touch the daily dev data.
- `task alarm-calendar:build` then `task alarm-calendar:electron:built` runs the packaged-style
  path: the built `app/dist` served from `app://alarm-calendar/` (no dev server).
- Env flags: `ALARM_APP_URL` (dev server to load, only honoured unpackaged), `ALARM_DEV_SEED=1`,
  `ALARM_DEV_SEED_RESET=1`, `ALARM_USER_DATA_DIR` (explicit data folder, unpackaged only), `ALARM_DEV_CHEAT_DAY=1`, `ALARM_AUTOSTART=1|0` (touch the OS login
  items in dev), `ALARM_APP_DIST` (serve another app build; unpackaged only). Extra arguments to
  `pnpm --filter @alarm-calendar/electron dev` go to Electron.
- The Electron build needs the Supabase URL (`VITE_SUPABASE_URL` in the environment or in
  `app/.env`); it is baked in as the only origin the CSP and the session hand-off allow.
- Data folders (`cache.json`, `main.log`), chosen by `resolveUserDataDir` in `config.ts`:
  - Daily dev run (`task alarm-calendar:electron`): `%APPDATA%\alarm-calendar-dev`. This is the
    owner's real data; do not run tests or agents against it.
  - Any run with `ALARM_DEV_SEED=1` or `ALARM_DEV_SEED_RESET=1` (the seed and reset tasks):
    `%APPDATA%\alarm-calendar-dev-seed`. A reset can only ever wipe this folder.
  - `ALARM_USER_DATA_DIR=<folder>` overrides both, for scratch runs by agents and tests. It is
    ignored in packaged builds, and combining it with a seed flag is refused when it points at the
    daily dev or the installed folder.
  - Packaged: `%APPDATA%\alarm-calendar`. Every override and seed flag is ignored.
- The single-instance lock is keyed by the userData folder, so a seeded or scratch run (its own
  folder, no real alarms) starts beside a running daily dev app instead of quitting; two runs on
  the same folder still collide, and the second one exits.

## How the pieces fit

- **Windows.** The main window shows the React app. The alarm window shows the same bundle at
  `#/alarm?occurrence=...` (`app/src/alarm-entry.tsx`), which imports no Supabase client. Each
  window has its own preload (`main-preload.ts` exposes `desktopApi`, `alarm-preload.ts` exposes
  `alarmApi`), so the alarm page cannot call the sync API. `contextIsolation` and `sandbox` stay on.
- **Origin and CSP.** `app-server.ts`: dev loads `http://localhost:3021`, otherwise `app://alarm-calendar`
  (custom protocol, path-traversal guarded, serves `app/dist`). Navigation and redirects are
  allowed only within that exact origin; windows and webviews are never opened. CSP: Supabase over
  https and wss, nothing else; inline scripts only in dev (react-refresh).
- **Schedule.** The renderer pushes events, cheat days, settings (with the sound choice) and
  recent completions through `desktopApi.setSchedule` after the first load and after every change
  (including realtime changes). Main validates the payload with zod (`desktop-payloads.ts`),
  persists it to the cache and re-evaluates, so alarms keep working with the app closed and offline.
  Invalid rows are dropped one at a time (counted, logged, and the app shows one toast); only bad
  settings or an invalid envelope reject the push.
- **The window exists from launch.** The main window is created hidden at start (an autostarted
  launch passes `--hidden` and stays in the tray) because the React app is what syncs from Supabase.
- **Completions: main is the only flush owner.** Done writes a pending row into the cache; the
  `CompletionFlusher` upserts it (`on_conflict=event_id,occurrence_at`, `ignoreDuplicates`: the first completion wins, a duplicate counts as success) as soon as it can,
  retries every 60 s and whenever a session arrives, and removes a row only after the server accepted
  it. The React app does not upsert on desktop: `ElectronAlarmAdapter.drainCompletions()` returns
  nothing, so nothing is written twice. A row the server refuses for good (RLS, deleted event) is
  dropped with a log line; rows of another account stay queued for that account.
- **Session.** The renderer hands main its access token (never the refresh token), expiry, user id,
  the Supabase URL and the publishable key on sign-in, every token refresh and sign-out
  (`app/src/features/alarm-adapter/session-sync.ts`). Only the renderer refreshes the session, so two
  clients never race on a rotating refresh token. Main accepts a URL only for the origin it was
  built for, keeps the token in memory only, never logs it, and uses it solely for the completions
  upsert. After a restart the renderer restores its session and pushes it again; completions made
  offline wait in the cache until then. No `safeStorage` is needed for that.
- **Done on another device.** Synced completions are merged into `cache.knownCompletions`; an
  occurrence in there does not ring when the machine wakes inside the grace window. A completion
  seen once is kept for 7 days even if a later sync has a narrower window.
- **Recovery.** The hidden main window is not throttled; a renderer crash or failed load is reloaded
  with backoff (1 s, 5 s, 30 s, 5 min), then the window is rebuilt (`main-window-recovery.ts`).
- **Autostart.** The Settings switch calls `setLoginItemSettings` (with `--hidden`). The packaged
  default (on) is applied once on first run; after that the OS entry is the user's. Unpackaged
  runs only flip an in-memory flag unless `ALARM_AUTOSTART` is set.

## Behaviour to know

- The alarm window is a centered panel (560x440, at most 90% of the work area), not full screen.
  It opens on the display that holds the cursor (the primary display if none does) and is about
  70% opaque (`opacity: 0.7`, set in `alarm-window.ts`), so a call or demo behind it stays
  visible. Several simultaneous alarms cascade 36 px down and right (`alarm-bounds.ts`) instead
  of stacking exactly. It is the opacity option, not `transparent: true`, so it keeps the OS
  rounded corners and shadow and works the same on any frameless Windows window. The window
  logs its bounds and opacity as `alarm_window.opened`.
- The alarm window cannot be minimized; hiding or defocusing it brings it back.
  Closing it (Alt+F4) re-opens it after `refire_seconds`. If its page fails to load it beeps and
  is retried after `refire_seconds`.
- Tray > Quit is disabled ("Quit (finish alarms first)") while any occurrence is
  ringing or snoozed. A Windows shutdown or logoff is never blocked; the cache is
  already on disk, so the alarm resumes on the next launch.
- **Killing the process (Task Manager, `taskkill`) silences every alarm until the
  app runs again.** Nothing can ring while it is not running. Autostart (packaged
  builds) restarts it after a reboot or logoff, and an alarm that was ringing or
  snoozed when the process died rings again at launch.
- Signing out stops the completions flush and clears the token but keeps the cached schedule, so
  alarms keep ringing until another account signs in (titles stay in `cache.json` until then).
- Always-on-top does not draw over exclusive-fullscreen games; use borderless
  windowed. Sound and the taskbar flash still happen.

## Sounds and icons

`pnpm --filter @alarm-calendar/electron generate-assets` writes the three alarm sounds
(`app/public/sounds/{bell,chime,pulse}.wav`, synthesised, no third-party audio), `assets/tray.png`
and the multi-size `assets/icon.ico`. Output is committed. The Settings sound picker maps its three
ids to those files in `app/src/features/alarm/alarm-sounds.ts`.

## Packaging

`task alarm-calendar:package` builds `app/dist`, the main bundle, and the unsigned per-user NSIS
installer: `electron/release/Alarm-Calendar-Setup-<version>.exe` (`release/` is gitignored). Config is
`electron-builder.yml`; the rationale and the fuse list are in `docs/decisions.md`.

- `app.asar` holds `dist/` (main, preloads, tray icon); `resources/app-dist` is the built React app,
  which `defaultDistDir` in `app-server.ts` serves over `app://alarm-calendar/`.
- Check the result without running it: `npx @electron/fuses read --app "release/win-unpacked/Alarm Calendar.exe"`.
  Do not run the installer or `win-unpacked` on a machine you care about: a packaged first run
  registers autostart.
- Unsigned, so SmartScreen warns on first run ("More info", then "Run anyway").
