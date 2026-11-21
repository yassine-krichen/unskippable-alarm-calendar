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
| `task android:release` | `android:web`, then the **signed** release APK in `android/app/build/outputs/apk/release/`. Needs the `ALARMCAL_*` signing properties (see `docs/releasing.md`); fails without them. |
| `task android:install:release` | `android:release`, then `adb install -r`. |
| `task android:test` | The Kotlin engine and updater-rule tests on the JVM. |
| `task android:logcat` | The engine's log (tag `AlarmEngine`). |

`--mode android` loads `.env`, `.env.local`, `.env.android` and `.env.android.local` from `app/` through Vite's normal env loading (later files win); a variable already set in the shell wins over every file. Nothing is printed.

The first sign-in needs the real project URL and key in `app/.env`, so a build without that file fails at startup with the
readable configuration screen. A quick check that the APK holds the real project and not a dummy: the project ref appears in
the JavaScript under `assets/public/assets/` of the APK, and `example.supabase.co` does not.

The debug build and the release build share one app id but are signed with different keys, so `adb install -r` of one over the other
fails on the signature: `adb uninstall com.yassine.alarmcalendar` first (open the app online beforehand so pending Dones are
uploaded). Releasing, the keystore and the in-app updater are in `docs/releasing.md`; the version comes from the root `package.json`.

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
- **Back button.** It closes the topmost sheet, dialog or list first. Then, on the phone layout: Calendar, Habits and More go to
  Today (the tabs replace each other in the history, so there is nothing "before" them), Today moves the app to the background,
  and a screen opened from More (Exams, Modes, Settings, About and updates) goes back to More (or to Today when it was opened
  directly). A tablet 768px or wider has no tabs: it goes to the previous screen, and from the calendar leaves. The rule is
  `decideBackAction` in `features/android-shell/back-action.ts`, with tests. A native date or time dialog is closed by Android
  itself; the web layer never sees that press.
- **Layout.** Edge to edge: Capacitor's `SystemBars` plugin supplies the safe-area insets and shrinks the page when the keyboard
  opens. The status and navigation bar icons follow the app's theme. The desktop-only parts (start with the computer, a prayer
  sound from a file, "Use my location") are not shown.
  - **Shell by width.** Under 768px the app has a bottom tab bar (**Today, Calendar, Habits, More**; Exams, Modes, Settings,
    Alarm permissions and About and updates are rows of More). It hides while a text field has focus and sits above the
    gesture bar (`env(safe-area-inset-bottom)`). `--tab-bar-h` is measured, so a larger system font does not push the calendar
    under it. A 768px or wider screen (a tablet) keeps the desktop layout.
  - **Today** is the home: the next alarm that will ring, the Mode and Pass chips, the update banner (an update shows a dot on More
    as well), the permission chip, and a two-week list. **Calendar** offers Day, 3 days and Month; swipe sideways to move.
    There is no pull to refresh: realtime plus the resume reload keep it current, and the gesture would fight the time grid's
    vertical scroll.
  - **Tapping an alarm** opens a details sheet; Edit swaps it for the form in the same sheet. The ring-screen sentence in the
    New alarm sheet says "full-screen, even on the lock screen" here and "centered panel" on the desktop.
  - **Sheets** are bottom drawers with a drag handle, a close button, a left-aligned header and a footer with the main button full
    width, padded by the safe-area inset. Cheat passes and Modes are sheets too; the permission dialog stays a dialog that cannot
    be swiped away. Fields are scrolled into view when the keyboard opens.
  - **Touch.** Buttons, inputs, selects and toggles are at least 44px under `(pointer: coarse)` (one block in `index.css`); the
    desktop keeps its density. Toasts sit at the bottom, above the tab bar.
  - **Pickers.** Time and date fields are buttons that open the phone's own dialogs (`NativePickers` plugin: `pickTime` /
    `pickDate`, platform `TimePickerDialog` / `DatePickerDialog`, 12 or 24 hour as the phone is set, dark or light as the app is).
    They exchange wall-clock strings (`HH:mm`, `yyyy-MM-dd`) only. Desktop and web keep the text field and the calendar popover.
    On HyperOS the dialogs can look a little different from stock Android; they stay functional.
  - **Haptics.** `@capacitor/haptics` (pinned like the other Capacitor packages): a light tick on a tab change, a success tick on
    a save, a warning tick on a delete. Nothing happens off Android.

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
6. Back button: open a sheet, press back (closes). Today, More, Settings, then back, back, back: More, Today, the app leaves.
   Calendar or Habits, then back: Today. With the New alarm sheet open on the Calendar tab, back closes the sheet first.
7. Keyboard: tap the title field of a new alarm; the field stays visible and the tab bar steps aside.
8. Prayer windows (needs the new app build and the `prayer_windows` migration): seed a prayer with a 30 minute window,
   `... -a com.yassine.alarmcalendar.debug.SEED --ei a 30 --ei window 30` (alarm A becomes a Dhuhr prayer whose window closes 30 minutes
   after it rings). The screen shows Prayed, one "+20 min" button (only +20 still ends 10 minutes before the window does), "Can't now ·
   last call HH:mm" and "Dhuhr time ends HH:mm", and no Snooze. Walk it with the screen off and once across a reboot: Later +20 rings
   again 20 minutes after the press; Can't now is silent until the last call (15 minutes in), which says "Can't pray in time" and ends the
   alarm when pressed; an unanswered prayer disappears at the window end and does not ring again; Prayed after Later records the press
   time (check `done_at` in Supabase). Finish with the CLEAR broadcast.
9. Mobile layout (the redesign): the four tabs and the thumb reach of the New alarm button; Calendar Day, 3 days and Month with a swipe
   sideways (a vertical scroll must not change the day, and a swipe must not open a new alarm); tap an alarm: details sheet, Edit,
   Delete (asks first); the update dot on More and the banner on Today when an update exists.
10. Native pickers: in a New alarm, tap Date and Time. The phone's own dialogs open, in the app's theme (try dark and light), in 12 or 24
    hour as the phone is set. Cancel changes nothing; OK fills the field. Gesture navigation against 3-button navigation: the tab bar and
    the sheet footers must clear the system bar.
11. Font scale at 130% and 200% (system Display settings): the tab bar labels, the Today card, the sheet footers and the buttons do not clip.
12. Haptics: a light tick on a tab change, a success tick when an alarm is saved, a warning tick when one is deleted (needs vibration on).
