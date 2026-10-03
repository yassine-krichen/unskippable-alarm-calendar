# Acceptance checklist (spec section 13)

How each item is verified. "Automated" names the test files (`pnpm -r test`); "Manual" is a step
someone runs by hand. Android items are blocked until the `android/` project exists (no Android SDK
on the development machine); nothing in that column has been run.

Status as of the Windows packaging step: automated suites green (core 106, electron 122, app 200 tests).

| # | Spec item | Windows / web verification | Android | Status |
| --- | --- | --- | --- | --- |
| 1 | Recurrence: every 12 hours, every 2 days, every 3 days, weekly with chosen weekdays, monthly incl. the 31st | Automated: `packages/core/src/recurrence.test.ts` over `packages/core/test-vectors/recurrence.json` (12 h across both DST changes, every 3 days, monthly on the 31st incl. leap year, biweekly Mon + Thu, `ends_at` mid-series). The alarm engine rings from the same function: `electron/src/scheduler.test.ts` ("recurring events"). Manual: `task electron:seed`, check the two seeded alarms ring at about 1 and 1.5 min | Blocked: Kotlin mirror must pass the same JSON vectors | Windows done, Android blocked |
| 2 | Week and Month views show recurring occurrences; Agenda lists today first | Automated: `app/src/features/calendar/calendar-events.test.ts` (expansion, ordering, series end, running occurrences), `calendar-range.test.ts` (week / month / agenda ranges, agenda starts at the anchor day). Manual: open the three tabs with a daily and a weekly event and compare against the event form | Same UI (shared app) | Done |
| 3 | Alarm rings with the app closed, screen locked, no internet | Automated: `electron/src/scheduler.test.ts` (timer, 30 s re-check, grace window after sleep, restart recovery), `electron/src/cache.test.ts` (schedule read from the local cache). Manual: `task electron:seed`, close the main window to the tray, disable the network, wait for the alarm. Lock the machine and confirm sound and taskbar flash (the alarm window itself is not shown over the Windows lock screen, a documented limit) | Blocked: AlarmManager, service and full-screen intent on a real device | Windows done with the lock-screen limit, Android blocked |
| 4 | Alarm cannot be dismissed without Done or Snooze, and re-rings after the refire interval | Automated: `electron/src/scheduler.test.ts` ("closing the alarm window without a choice": re-ring after `refire_seconds`, survives restart, retry when the window fails to open). Manual: with `electron:seed`, press Alt+F4 and try to minimise or defocus the alarm window; it returns and re-opens | Blocked | Windows done, Android blocked |
| 5 | `max_snoozes = 3` allows exactly 3 snoozes then hides the button; `max_snoozes = 0` never shows it | Automated: `packages/core/src/snooze.test.ts` (limit, label "Snooze 5 min (2 left)", no-snooze notice), `electron/src/scheduler.test.ts` ("snoozing"). Manual: set an event to 3, then 0, and look at the alarm screen | Blocked | Windows done, Android blocked |
| 6 | Weekly pass grant follows the section 7 table, cap of 2, multi-week catch-up | Automated: `packages/core/src/wallet.test.ts` ("weekly grant (spec section 7 table)", "catch-up after being away"). Manual against the live project: `supabase db query --linked -f supabase/tests/wallet_rpcs.test.sql` (every row PASS, rolls back) and `supabase/tests/security_checks.sql` | n/a (server-side) | Done |
| 7 | A cheat day silences passable events only, and the calendar shows it | Automated: `electron/src/scheduler.test.ts` ("cheat days"), `app/src/features/calendar/calendar-events.test.ts` (greyed occurrences, non-passable never silenced, local-date assignment, counts in the dialog). Manual: `ALARM_DEV_CHEAT_DAY=1` seed rings only the non-passable event; the calendar shows the striped day and badge | Blocked (same silencing rule in Kotlin) | Windows done, Android blocked |
| 8 | Android permission dialog appears when full-screen intent or exact alarm is missing | None possible yet. Spec section 10 permission-flow copy is part of the Android project | Blocked | Blocked |
| 9 | UI uses shadcn (preset `b0`) and lucide, no native checkboxes, selects, date inputs or buttons | Manual check, repeatable: `grep -rnE "<(button\|select\|dialog)[ >]\|type=\"(checkbox\|radio\|date\|time)\"" app/src --include=*.tsx` returns nothing (returned nothing at this step). Components come from `app/src/components/ui`; icons from `lucide-react` only. Visual pass through every screen in dark and light | Same UI; the native alarm Activity mirrors the look by hand | Done (web), Android alarm screen blocked |
| 10 | Sign-in by emailed code on both platforms, session survives restarts | Automated: `app/src/features/auth/auth-errors.test.ts`, `app/src/features/alarm-adapter/session-sync.test.ts` (restored session is pushed to main again after a restart). Session persistence is `persistSession: true` in `app/src/lib/supabase.ts`. Manual: sign in by code in the browser and in Electron, quit from the tray, relaunch, confirm no sign-in prompt | Blocked | Windows / web: manual, Android blocked |
| 11 | No `sb_secret_` or service role key in the repo or built bundles; `.env` gitignored | Manual, repeatable: `git check-ignore app/.env`; `grep -rIlE "sb_secret_[A-Za-z0-9_-]{8,}" . --exclude-dir=node_modules --exclude-dir=.git --exclude=.env` returns nothing; the same regex over `app/dist`, `electron/dist` and `electron/release/win-unpacked` returns nothing (checked after the packaging build). A plain `grep sb_secret` does match two library files (supabase-js checks the key prefix and its doc comments mention `service_role`): they are code and comments, not key values. Android bundles: not built | Blocked for the APK | Done for web and Windows |

## Windows packaging checks (build-order step 7)

Run after `task package`, without running the installer (a packaged first run registers autostart):

- `electron/release/Alarm-Calendar-Setup-<version>.exe` exists.
- `npx @electron/fuses read --app "electron/release/win-unpacked/Alarm Calendar.exe"`: RunAsNode,
  EnableNodeOptionsEnvironmentVariable, EnableNodeCliInspectArguments disabled;
  OnlyLoadAppFromAsar, EnableEmbeddedAsarIntegrityValidation enabled.
- `electron/release/win-unpacked/resources/app-dist/` contains `index.html` and `sounds/{bell,chime,pulse}.wav`;
  `app.asar` contains `dist/main.cjs`, both preloads and `dist/tray.png`.
- The secret scan from item 11 over `electron/release/win-unpacked`.
