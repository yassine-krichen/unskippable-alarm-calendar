# Acceptance checklist (spec section 13)

How each item is verified. "Automated" names the test files (`pnpm -r test`); "Manual" is a step
someone runs by hand. The Android column describes the native engine (build-order step 3, stage 1), built in `android/`; the app is not wired to it until step 6. It was
run on an Android 17 emulator and not yet on the owner's HyperOS phone, whose installer refused the debug build (see "Android engine" below).

Status as of the holidays round (2026-10-12): automated suites green (core 479, app 528, electron 243 tests), both
builds pass, `supabase/tests/security_checks.sql` 343 rows PASS against PGlite. Roadmap v2 phases 0 to 5 and the first
owner feedback round are covered by the second table below; nothing in it needs Android.

| # | Spec item | Windows / web verification | Android | Status |
| --- | --- | --- | --- | --- |
| 1 | Recurrence: every 12 hours, every 2 days, every 3 days, weekly with chosen weekdays, monthly incl. the 31st | Automated: `packages/core/src/recurrence.test.ts` over `packages/core/test-vectors/recurrence.json` (12 h across both DST changes, every 3 days, monthly on the 31st incl. leap year, biweekly Mon + Thu, `ends_at` mid-series). The alarm engine rings from the same function: `electron/src/scheduler.test.ts` ("recurring events"). Manual: `task electron:seed`, check the two seeded alarms ring at about 1 and 1.5 min | Not needed on Android: it rings from the precomputed list, core builds it (the recurrence mirror was dropped with roadmap v2 phase 3a). The engine runs the shared `alarm-engine.json` scenarios | Windows done, Android engine verified (rows reach it with step 6) |
| 2 | Week and Month views show recurring occurrences; Agenda lists today first | Automated: `app/src/features/calendar/calendar-events.test.ts` (expansion, ordering, series end, running occurrences), `calendar-range.test.ts` (week / month / agenda ranges, agenda starts at the anchor day). Manual: open the three tabs with a daily and a weekly event and compare against the event form | Same UI (shared app) | Done |
| 3 | Alarm rings with the app closed, screen locked, no internet | Automated: `electron/src/scheduler.test.ts` (timer, 30 s re-check, grace window after sleep, restart recovery), `electron/src/cache.test.ts` (schedule read from the local cache). Manual: `task electron:seed`, close the main window to the tray, disable the network, wait for the alarm. Lock the machine and confirm sound and taskbar flash (the alarm window itself is not shown over the Windows lock screen, a documented limit) | Emulator (Android 17), no network needed: screen off, alarm turns it on and shows the alarm screen; app process killed with `am kill`; reboot. Phone: owner (see "Android engine") | Windows done with the lock-screen limit, Android emulator done, phone pending |
| 4 | Alarm cannot be dismissed without Done or Snooze, and re-rings after the refire interval | Automated: `electron/src/scheduler.test.ts` ("closing the alarm window without a choice": re-ring after `refire_seconds`, survives restart, retry when the window fails to open). Manual: with `electron:seed`, press Alt+F4 and try to minimise or defocus the alarm window; it returns and re-opens | Emulator: the alarm screen destroyed without a choice (debug `CLOSE_SCREEN`) silences the sound and re-rings after `refire_seconds`; Back and the back gesture do nothing; Home leaves the sound on. Phone: owner | Windows done, Android emulator done, phone pending |
| 5 | `max_snoozes = 3` allows exactly 3 snoozes then hides the button; `max_snoozes = 0` never shows it | Automated: `packages/core/src/snooze.test.ts` (limit, label "Snooze 5 min · 2 left", no-snooze notice), `electron/src/scheduler.test.ts` ("snoozing"). Manual: set an event to 3, then 0, and look at the alarm screen | JVM: `SharedVectorsTest` ("snooze limit", "max_snoozes 0"), `EngineRuntimeTest` (label "Snooze 5 min \· 2 left", notice). Emulator: 2 snoozes then only Done with "No snoozes left, do it now"; a 0-snooze alarm shows only Done | Windows done, Android emulator done, phone pending |
| 6 | Weekly pass grant follows the section 7 table, cap of 2, multi-week catch-up | Automated: `packages/core/src/wallet.test.ts` ("weekly grant (spec section 7 table)", "catch-up after being away"). Manual against the live project: `supabase db query --linked -f supabase/tests/wallet_rpcs.test.sql` (every row PASS, rolls back) and `supabase/tests/security_checks.sql` | n/a (server-side) | Done |
| 7 | A cheat day silences passable events only, and the calendar shows it | Automated: `electron/src/scheduler.test.ts` ("cheat days"), `app/src/features/calendar/calendar-events.test.ts` (greyed occurrences, non-passable never silenced, local-date assignment, counts in the dialog). Manual: `ALARM_DEV_CHEAT_DAY=1` seed rings only the non-passable event; the calendar shows the striped day and badge | JVM: `silenced` and `completed` occurrences never ring (`SharedVectorsTest`); core sets the flags from the cheat days when it builds the list | Windows done, Android engine verified |
| 8 | Android permission dialog appears when full-screen intent or exact alarm is missing | Status side done: `getPermissionStatus` answers exact alarm, full-screen intent, notifications, battery and the Xiaomi switches (emulator: all true but battery; checked through the Capacitor bridge). The blocking shadcn dialog and its copy are app work (step 6) | Status and deep links in the plugin; dialog pending | Partly done |
| 9 | UI uses shadcn (preset `b0`) and lucide, no native checkboxes, selects, date inputs or buttons | Manual check, repeatable: `grep -rnE "<(button\|select\|dialog)[ >]\|type=\"(checkbox\|radio\|date\|time)\"" app/src --include=*.tsx` returns nothing (returned nothing at this step). Components come from `app/src/components/ui`; icons from `lucide-react` only. Visual pass through every screen in dark and light | Same UI; the native alarm Activity mirrors the look by hand | Done (web), Android alarm screen blocked |
| 10 | Sign-in by emailed code on both platforms, session survives restarts | Automated: `app/src/features/auth/auth-errors.test.ts`, `app/src/features/alarm-adapter/session-sync.test.ts` (restored session is pushed to main again after a restart). Session persistence is `persistSession: true` in `app/src/lib/supabase.ts`. Manual: sign in by code in the browser and in Electron, quit from the tray, relaunch, confirm no sign-in prompt | Blocked | Windows / web: manual, Android blocked |
| 11 | No `sb_secret_` or service role key in the repo or built bundles; `.env` gitignored | Manual, repeatable: `git check-ignore app/.env`; `grep -rIlE "sb_secret_[A-Za-z0-9_-]{8,}" . --exclude-dir=node_modules --exclude-dir=.git --exclude=.env` returns nothing; the same regex over `app/dist`, `electron/dist` and `electron/release/win-unpacked` returns nothing (checked after the packaging build). A plain `grep sb_secret` does match two library files (supabase-js checks the key prefix and its doc comments mention `service_role`): they are code and comments, not key values. Android bundles: `app/dist-android` is built with the same variables; the APK was built with dummy values only (`VITE_SUPABASE_URL=https://example.supabase.co`) and holds no secret | Debug and release APK built, no key in them | Done for web and Windows; re-run the scan over `app/dist-android` and the APK before a release build |

## Roadmap v2 (desktop and web)

Same conventions as above. "Manual" steps need the migrations pushed (`supabase db push`, in order:
`20261006010617`, `20261006010618`, `20261006042009`, `20261006050221`, `20261006153533`, `20261006173000`, `20261012090000`).

| # | Feature | Verification | Status |
| --- | --- | --- | --- |
| v2-0 | Alarm pop-up is a centered, about 70% opaque panel; Snooze centered with a short label | Automated: `electron/src/alarm-bounds.test.ts`, `app/src/features/alarm/snooze-label.test.ts`. Manual: `task electron:seed`, trigger an alarm over another window | Done |
| v2-1 | Habits and ranks: per-habit window, tiers, streaks, overall pooled score, Stats screen, tier badge in the sheet | Automated: `packages/core/src/habits.test.ts` over `test-vectors/habits.json`, `habits-modes.test.ts`, `app/src/features/habits/*.test.ts` | Done |
| v2-1a | Birthdays and every yearly alarm are not habits: never scored, not on Stats, no badge in the sheet | Automated: `habits-prayer.test.ts` ("birthday alarms are not habits", `isHabit`). Manual: add a birthday, open Stats and the sheet: no row, no rank | Done |
| v2-1b | The five prayers are one "Prayer" habit: pooled score, combined counts, day streak (all five prayed, a miss breaks it), counted once in the overall score, combined rank in the prayer sheet | Automated: `habits-prayer.test.ts` ("prayers pooled into one habit"), `prayer-day.test.ts`, `habit-view.test.ts`. Manual: Stats shows one Prayer row; open a prayer in the calendar sheet for the same badge | Done |
| v2-2 | Yearly repeat and the Birthday / anniversary template (prep 7 days before, wish on the day, edited as a pair) | Automated: `recurrence.test.ts` (year vectors), `relationship-template.test.ts`, `repeat-presets.test.ts` | Done |
| v2-3 | Precomputed 60-day schedule drives the engine; electron refills it | Automated: `schedule.test.ts`, `electron/src/schedule-engine.test.ts`, `schedule-parity.test.ts` | Done |
| v2-3b | Salat: prayer times offline, reminders before each, custom sound, cheat days never silence | Automated: `prayer-times.test.ts` over `test-vectors/prayer-times.json`, `schedule-prayer.test.ts`, `electron/src/prayer-engine.test.ts`, `app/src/features/settings/prayer-*.test.ts` | Done |
| v2-3c | Prayers hidden from the calendar by default (Settings, Prayer times, "Show prayers in calendar"); they still ring and still count | Automated: `calendar-visibility.test.ts`, `prayer-settings.test.ts`, `settings-api.test.ts`, security checks for the new column | Done |
| v2-3d | Per-alarm "Show in calendar" (alarm, birthday pair, exam and its alarms); Week / Month / Agenda hide those; toolbar "Show hidden" toggle (per device) reveals them faded | Automated: `calendar-visibility.test.ts`, `event-form.test.ts`, `relationship-template.test.ts`, `exam-plan.test.ts`, `electron/src/desktop-payloads-prayer.test.ts` (accepted, never read), `events-api.test.ts`. Manual: turn the switch off, confirm it still rings (`task electron:seed`) and shows with Show hidden | Done |
| v2-4 | Exams: exam alarm, revision sessions, catch-up of a missed one, Exams screen | Automated: `exams.test.ts`, `exams-modes.test.ts`, `app/src/features/exams/*.test.ts` | Done |
| v2-4a | Birthdays, the exam alarm, revision sessions and catch-ups have fixed colors (light and dark) outside the picker palette; picker not offered for them | Automated: `category-colors.test.ts` (mapping, tokens in both themes, none a picker color). Contrast checked by script, both themes: text on its fill 7.7:1 or more, accent edges 4.3:1 or more against the page. Visual pass done in a throwaway harness (Week and Month, light and dark) | Done |
| v2-5 | Modes: manual switch, ranges, Exam mode auto-window, per-alarm keep / skip / shift / shorten | Automated: `modes.test.ts`, `schedule-modes.test.ts`, `habits-modes.test.ts`, `exams-modes.test.ts`, `app/src/features/modes/*.test.ts`, `electron/src/schedule-modes.test.ts` | Done |
| v2-6 | Holidays (display only): a country's public holidays and Islamic holidays on Week (all-day row), Month and Agenda; Settings country picker, Islamic switch and Hijri adjustment; never rings | Automated: `packages/core/src/holidays.test.ts` over `test-vectors/islamic-holidays.json` (Umm al-Qura dates for 1446 to 1449 AH from van Gent's published table and two calendar sites, offsets, merging), `app/src/features/holidays/*.test.ts` (library, Tunisia, merge agreement 2024 to 2029), `app/src/features/settings/holiday-settings.test.ts`, `electron/src/desktop-payloads-holidays.test.ts`, security checks for the three columns. Manual: with the migration pushed, Settings, Holidays, pick Tunisia and switch Islamic on: the week of 12 October 2026 shows the Evacuation Day flag chip on the 15th, February 2027 shows Ramadan from the 8th with the green wash, and 9 March shows Eid al-Fitr tagged Public holiday; compare the Eid date with the announced one and use the adjustment if it is a day off | Done |
| v2-db | Migrations and RLS for all of the above | Manual, repeatable: `supabase db query --linked -f supabase/tests/security_checks.sql` (every row PASS) | Done against PGlite; run on the live project after pushing |

## Windows packaging checks (build-order step 7)

Run after `task package`, without running the installer (a packaged first run registers autostart):

- `electron/release/Alarm-Calendar-Setup-<version>.exe` exists.
- `npx @electron/fuses read --app "electron/release/win-unpacked/Alarm Calendar.exe"`: RunAsNode,
  EnableNodeOptionsEnvironmentVariable, EnableNodeCliInspectArguments disabled;
  OnlyLoadAppFromAsar, EnableEmbeddedAsarIntegrityValidation enabled.
- `electron/release/win-unpacked/resources/THIRD_PARTY_NOTICES.md` exists (the holiday data credit, CC BY 3.0).
- `electron/release/win-unpacked/resources/app-dist/` contains `index.html` and `sounds/{bell,chime,pulse}.wav`;
  `app.asar` contains `dist/main.cjs`, both preloads and `dist/tray.png`.
- The secret scan from item 11 over `electron/release/win-unpacked`.

## Android engine (build-order step 3, stage 1)

What exists is the native engine; the React app does not call it yet (step 6), so every check below drives it with adb or over the WebView's DevTools port. Run
from `my-unskippable-alarm-calendar`, in a shell with the Android platform-tools on `PATH` (and `MSYS_NO_PATHCONV=1` in Git Bash).

Automated, no device: `task android:test` (69 JVM tests: instants, payload validation, the engine, the files, and the 15 shared scenarios in
`packages/core/test-vectors/alarm-engine.json`, which `electron/src/engine-vectors.test.ts` also runs against the reference scheduler). `task android:build`
builds the web bundle into `app/dist-android` and the debug APK; `./gradlew :app:lintDebug` has no errors.

Debug-build commands (the receiver is only in debug builds and only accepts senders holding `DUMP`, which the adb shell has):

```
adb shell am broadcast -n com.yassine.alarmcalendar/.alarm.DebugSeedReceiver -a com.yassine.alarmcalendar.debug.SEED --ei a 60 --ei b 90 --ei refire 20
  a: seconds until the alarm with 2 snoozes of 1 minute; b: seconds until the no-snooze alarm; refire: refire_seconds; grace: grace_minutes
... -a com.yassine.alarmcalendar.debug.CLEAR          forget the schedule and state, cancel the alarm, stop the service
... -a com.yassine.alarmcalendar.debug.DUMP           engine state to logcat (lines "dump ...")
... -a com.yassine.alarmcalendar.debug.CLOSE_SCREEN   destroy the alarm screen without a choice
... -a com.yassine.alarmcalendar.debug.PERMS          permission status to logcat
adb logcat -s AlarmEngine:I      (or task android:logcat)
adb shell dumpsys alarm | grep -A6 "yassine"   an RTC_WAKEUP alarm with "Alarm clock: triggerTime=" and the FIRE tag
```

| Check | How | Emulator (Android 17, API 37) |
| --- | --- | --- |
| Alarm-clock alarm is set | seed, `dumpsys alarm` | Done: `*walarm*:...FIRE`, `Alarm clock`, `exactAllowReason=policy_permission`, alarm icon in the status bar |
| Rings with the screen off, over the lock screen | seed, `input keyevent 26`, wait | Done: screen wakes, `AlarmActivity` is the focused window, sound started by the service (`service.ringing`). The emulator has no lock credential, so `isKeyguardShowing` was false; the phone's PIN case is the owner's |
| Foreground service type | `dumpsys activity services` | Done: `types=0x400` (systemExempted), start allowed by `ALARM_MANAGER_ALARM_CLOCK` |
| Snooze limit | tap Snooze twice | Done: "Snooze 1 min \· 2 left", then "1 left", then only Done and "No snoozes left, do it now" |
| max_snoozes 0 | seed `--ei b 15 --ei a 3000` | Done: only Done, no notice |
| Done writes a completion | tap Done, `peekCompletions` through the bridge | Done: status `done`, `snoozes_used`, `done_at`; peeking again returns the same row until `ackCompletions({ ids })` removes it |
| Screen destroyed without a choice, re-fire | `CLOSE_SCREEN` | Done: `activity.closed_without_choice`, sound stops, rings again after 20 s |
| App process killed, still rings | `am kill` while idle, then wait | Done: pid gone, alarm still in `dumpsys alarm`, new process rings on time. `force-stop` is not a fair test: it cancels the app's alarms by design |
| Process killed while ringing | `run-as com.yassine.alarmcalendar kill -9 <pid>` | Done: the sticky service restarts, the alarm rings again in about 5 s |
| Doze | `dumpsys battery unplug`, screen off, `cmd deviceidle force-idle deep` | Partly: deep Doze is entered only when the alarm is more than an hour away; an alarm-clock alarm inside the hour keeps the device out of it. The alarm carries `FLAG_WAKE_FROM_IDLE`. A real overnight test is the owner's |
| Time change | `cmd alarm set-time <ms>` | Done: `TIME_SET` reschedules, the alarm rings at the new time |
| Reboot | seed `--ei a 200`, `adb reboot` | Done: `BOOT_COMPLETED` rebuilt the alarm from the files (about 90 s after boot on the emulator), it rang on time |
| Reboot with a PIN, ring before the first unlock | `adb shell locksettings set-pin 1234`, seed `--ei a 400`, `adb reboot`, do not unlock | Done: user `RUNNING_LOCKED`, `LOCKED_BOOT_COMPLETED` rebuilt the alarm, it rang at the right time and `AlarmActivity` was the focused window over the keyguard. Clear the PIN afterwards (`locksettings clear --old 1234`) |
| App opened while an alarm rings | Home, then start `MainActivity` | Done: the alarm screen comes to the front |
| Notification swiped away | swipe it in the shade | Done: the delete intent re-runs the engine and the notification is posted again (also every 30 s) |
| Notifications denied | `pm revoke ... POST_NOTIFICATIONS`, seed, screen off | The alarm rings (service and sound), the screen does not come up by itself on the emulator; the app keeps trying every 30 s. The permission dialog (step 6) must block until this is granted |
| Schedule through the Capacitor bridge | `Capacitor.nativePromise('AlarmEngine', 'setSchedule', { payload })` over DevTools | Done: accepted, a malformed row dropped and counted, rang with the pushed sound id |
| Horizon notice | push a list with 3 days of horizon | Done: notification on channel `alarm_schedule`, next check in 24 h |
| Back and the back gesture | `input keyevent KEYCODE_BACK`, an edge swipe | Done: nothing happens |

Owner, on the HyperOS phone (Xiaomi POCO F7, Android 16). One-time: Settings, Additional settings, Developer options, switch on "Install via USB" and "USB debugging
(Security settings)" (HyperOS asks for the Mi account), then `task android:install DEVICE=91d169f4`. Then:

1. Grant, in the app's page of Settings, Apps: Notifications on; "Autostart" on; under Other permissions "Display on lock screen" and "Display pop-up windows while
   running in the background" allowed; Battery saver "No restrictions". Check `adb shell cmd appops get com.yassine.alarmcalendar` for `MIUIOP(10008)` (autostart),
   `MIUIOP(10020)` and `MIUIOP(10021)`: `allow` is on. Run the PERMS broadcast and read the `perms` line.
2. Seed, lock the phone with the PIN, switch the screen off: the screen must turn on over the lock screen with the black alarm screen and the sound must be
   audible at the alarm volume (Settings, Sound, Alarm). Press Home and the power button while it rings: the sound continues. Snooze twice, then only Done remains.
3. Seed again, swipe the app away from recents (the alarm screen itself is not in recents) and wait: it must still ring.
4. Seed with `--ei a 300`, then restart the phone and do not unlock it: the alarm must ring on time over the lock screen (the engine files are device-protected; HyperOS autostart may still decide otherwise).
5. With the phone unlocked and in use, an alarm shows as a heads-up banner plus sound; tap it to open the alarm screen. If "Display pop-up windows" is granted and
   it opens by itself, that is the better case.
6. Leave a seeded alarm unanswered ("dismissal without a choice"): Home, then destroy the screen with the CLOSE_SCREEN broadcast; it must ring again after 20 s.
7. Finish with the CLEAR broadcast so no test alarm stays scheduled.
