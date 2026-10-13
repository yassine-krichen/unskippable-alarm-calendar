# Android app

The phone runs the same React app as the desktop, inside a Capacitor 8 shell (`android/`), plus the native `AlarmEngine`
plugin (Kotlin) that owns every ring. This page is how to build it, what the app does on Android and how it was checked.
Decisions and their reasons are in `docs/decisions.md` ("Android app wiring"); the engine is described in spec section 10.

## Build and install

All from the project folder (or `task alarm-calendar:<task>` from the personal root). The tasks pin JDK 21 and the SDK path.

| Task | What it does |
| --- | --- |
| `task android:web` | `vite build --mode android` into `app/dist-android` (never `app/dist`, the Electron input), then `cap sync android`. Vite reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` from `app/.env` (and an optional `app/.env.android`) like any build. Nothing is printed. |
| `task android:build` | `android:web`, then the debug APK in `android/app/build/outputs/apk/debug/`. |
| `task android:install` | `android:build`, then `adb install -r` on the connected device. With a phone and an emulator attached, pass `DEVICE=<serial>` (from `adb devices`). |
| `task android:run` | `android:install`, then starts the app. |
| `task android:test` | The Kotlin engine tests on the JVM. |
| `task android:logcat` | The engine's log (tag `AlarmEngine`). |

`--mode android` loads `.env`, `.env.local`, `.env.android` and `.env.android.local` from `app/` through Vite's normal env loading (later files win); a variable already set in the shell wins over every file. Nothing is printed.

The first sign-in needs the real project URL and key in `app/.env`, so a build without that file fails at startup with the
readable configuration screen. A quick check that the APK holds the real project and not a dummy: the project ref appears in
the JavaScript under `assets/public/assets/` of the APK, and `example.supabase.co` does not.

HyperOS refuses `adb install` until Developer options has "Install via USB" (and "USB debugging (Security settings)") switched
on. That is a phone setting, the task cannot change it.

## What the app does on Android

- **Schedule.** `CapacitorAlarmAdapter` hands core's precomputed 60-day schedule to the plugin (without `refillSource`, which only
  the desktop uses). It is pushed when the first load is done, after every data change, when the app comes back to the front
  (Capacitor `App` `resume`), and once a day while it stays open. A push also removes the engine's "open the app to extend your
  alarms" notice once the list reaches 7 days or more.
- **Completions.** A Done pressed on the alarm screen is kept by the engine from that moment, also with the app closed. The app
  does `peekCompletions`, upserts each row to `completions` (`on conflict event_id,occurrence_at do nothing`, first completion wins,
  like the desktop) and only then `ackCompletions(ids)`. It runs on launch, on resume, when the network comes back and every
  minute while the app is in front. A failed upload acknowledges nothing, so the next run sends the same rows. Only a row the server
  refuses for good (Postgres 42501, 23503 or 23505, or a 409) is forgotten, with a log line and one toast per session; the
  desktop flusher applies the same rule. Every other failure, any 4xx included, keeps the row. If the signed-in account changes
  while a run is in progress, the run stops before the next upload.
- **Permissions.** On launch and on resume the app asks the engine for the permission status. Notifications and full-screen
  alarms are required: while either is missing a dialog covers the app and cannot be closed (no close button, the back button
  does nothing). Exact alarms and battery optimization, and on Xiaomi / HyperOS autostart, "show on lock screen" and "pop-ups
  while in the background", are recommended: the dialog offers "Remind me later" (until the next launch, or an hour), and a red
  chip under the calendar header stays while one is denied. The three HyperOS switches the OS does not report show as "Check
  manually", never as denied, and never open the dialog on their own. Each row's button opens the matching system screen
  (`openPermissionSettings(kind)`); the status is read again when the app returns. Settings has the same list (Android only).
- **Back button.** It closes the topmost sheet, dialog or list, otherwise goes back one screen (to the calendar when there is
  nothing before the screen), and on the calendar moves the app to the background.
- **Layout.** Edge to edge: Capacitor's `SystemBars` plugin supplies the safe-area insets and shrinks the page when the keyboard
  opens. The status and navigation bar icons follow the app's theme. Agenda is the default view on a phone. The desktop-only
  parts (start with the computer, a prayer sound from a file, "Use my location") are not shown.

## Checking it

Automated (`pnpm -r test`): the adapter against a fake plugin (`capacitor-alarm-adapter.test.ts`), the peek, upload, ack order and
the retry after a failure (`completion-flush.test.ts`), which adapter each platform gets (`create-alarm-adapter.test.ts`), the
resume push (`schedule-sync-resume.test.ts`), unknown versus denied and required versus optional permissions
(`permission-model.test.ts`, `permissions-store.test.ts`) and the back button rules (`back-action.test.ts`).

On an emulator without the real Supabase: build the bundle with a dummy project and the debug switch, then copy it into the
native project and build the APK.

```
VITE_SUPABASE_URL=https://example.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_dummy VITE_ALARM_DEBUG=1 \
  pnpm --filter app exec vite build --mode android --outDir <some folder outside app/dist*> --emptyOutDir
# copy that folder over android/app/src/main/assets/public, then: gradlew assembleDebug and adb install
```

`VITE_ALARM_DEBUG=1` adds `features/alarm-adapter/debug-hooks.ts`: a fake Supabase (it answers the REST calls for
`example.supabase.co` from memory, with one alarm about 90 seconds after the first start, and plants a signed-in session) and
`window.__alarmDebug` for driving the app over the WebView's DevTools port
(`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`). The flag is a build-time constant: the owner's build contains
none of it. The next `task android:web` replaces the dummy bundle with the real one.

## What to test on the phone

1. Enable Developer options, "Install via USB" and "USB debugging (Security settings)". `task android:run`.
2. Sign in by the emailed code. Force-close and reopen: still signed in.
3. The permission dialog opens. Allow notifications (system dialog), then full-screen alarms. After each, come back: the row is gone.
   Optional rows: try Battery ("No restrictions"), Autostart, Lock screen, Pop-ups. They show "Check manually" if HyperOS does not
   answer; check each by eye. Settings, Permissions lists all of them.
4. Create an alarm two minutes ahead, lock the phone, swipe the app away. It rings over the lock screen. Press Done.
5. Open the app (airplane mode on first, then off): the Done reaches Supabase (the occurrence shows done on the desktop). With
   airplane mode on, a Done is kept and uploaded after the network returns.
6. Back button: open a sheet, press back (closes), press back on Settings (calendar), press back on the calendar (app leaves).
7. Keyboard: tap the title field of a new alarm; the form stays reachable.
