# Electron alarm engine

Main process: scheduler, full-screen alarm windows, tray, local JSON cache.
The calendar UI is a placeholder until build-order step 5. See `docs/spec.md`
sections 6 and 9.

## Run

- `task electron` seeds two dev alarms (about 1 and 1.5 min after launch) into an
  empty dev cache and keeps that cache across relaunches.
- `task electron:reset` wipes the dev cache and seeds again.
- Env flags: `ALARM_DEV_SEED=0` (no seed), `ALARM_DEV_SEED_RESET=1`,
  `ALARM_DEV_CHEAT_DAY=1`, `ALARM_AUTOSTART=1|0` (autostart is on only in
  packaged builds by default).
- Dev data lives in `%APPDATA%\alarm-calendar-dev` (`cache.json`, `main.log`).

## Behaviour to know

- The alarm window cannot be minimized; hiding or defocusing it brings it back.
  Closing it (Alt+F4) re-opens it after `refire_seconds`.
- Tray > Quit is disabled ("Quit (finish alarms first)") while any occurrence is
  ringing or snoozed. A Windows shutdown or logoff is never blocked; the cache is
  already on disk, so the alarm resumes on the next launch.
- **Killing the process (Task Manager, `taskkill`) silences every alarm until the
  app runs again.** Nothing can ring while it is not running. Autostart (packaged
  builds) restarts it after a reboot or logoff, and an alarm that was ringing or
  snoozed when the process died rings again at launch.
- Always-on-top does not draw over exclusive-fullscreen games; use borderless
  windowed. Sound and the taskbar flash still happen.

## Temporary pieces (replace in step 5)

`src/renderer/alarm.*` and `main-window.html` are plain-HTML placeholders for the
React `/alarm?occurrence=...` route and the main window. `assets/alarm.wav` is a
generated placeholder tone.
