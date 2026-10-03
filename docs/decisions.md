# Implementation notes

Decisions made while building that go beyond or refine `spec.md`. The Kotlin
mirror (step 10) and the app code must follow these.

- **Realtime DELETE on `cheat_days` carries only the primary key.** Under RLS,
  Supabase realtime DELETE payloads contain just the id, whatever the replica
  identity (`replica identity full` stays but does not help). On a DELETE event
  refetch `cheat_days` instead of reading `day` from the payload.

- **The wallet snapshots its own timezone and week start.** `pass_wallet` has
  `timezone`, `week_starts_on` and `anchored_at`, none client-writable. All
  wallet math (week start, grants, "today" in `use_pass` / `refund_pass`) uses
  that snapshot, never `settings` directly. Settings reach the snapshot in two
  places, both inside
  `sync_wallet` (SQL `private.sync_wallet`, TS `syncWallet`):
  1. Once, on the first sync (`anchored_at` is null): copy settings and set
     `last_granted_week_start` to the current week start without granting. A
     wallet is created at signup with default UTC settings, so without this a
     new account whose client then sets its real zone could collect a second
     pass. Clients should write their timezone to `settings` before the first
     sync; a sync before that anchors in UTC, and the real zone is adopted at
     the next grant boundary.
  2. At a grant boundary: grants are applied under the old snapshot, then the
     current settings are adopted. If the adopted week start would fall before
     the boundary just granted for, it moves forward by whole weeks, so the next
     grant is never earlier than 7 days after this one. Cycling
     `week_starts_on` or the zone cannot farm passes. Cost: a legitimate change
     can delay the next grant by up to a week.
  - Grants = whole weeks (`days_behind / 7`, floored) between
    `last_granted_week_start` and the current week start, both from the same
    snapshot. `last_granted_week_start` only changes when grants > 0 (or on the
    first anchor), so it can end up in the future by less than a week.
  - "Today" for `use_pass` / `refund_pass` is the latest of three local dates:
    the wallet's zone before the sync, the wallet's zone after the sync (a
    grant boundary may have adopted new settings), and the settings zone
    (`private.pass_today`, TS `passToday(before, after, now, settingsTz)`).
    Changing the timezone can therefore only make a pass decision stricter,
    never move today backwards, including a switch timed at a grant boundary.
    The public RPCs return `timezone` and `week_starts_on` next to the balance
    so a client can compute the same date.
  - Travellers going east to west (settings zone behind the wallet's) see the
    stricter, later "today" until the next weekly boundary adopts the new zone.
  - Wallets that existed before the snapshot migration lose any catch-up grant
    they were owed when they re-anchor on their first sync (accepted, the app
    is pre-release).
  - Clients update `settings` with UPDATE, not upsert (column privileges: no
    `pass_cap`, no `user_id` update; no delete). The RPCs recreate a missing row.

- **DST gaps and overlaps follow `java.time` semantics.** A wall time inside a
  spring-forward gap moves forward by the gap; a wall time that occurs twice in
  autumn resolves to the earlier instant. TS (`fromWallClock`) and Kotlin
  (`ZonedDateTime.ofLocal`) must agree, and the shared test vectors cover it.

- **Weekly recurrence counts weeks from Monday, regardless of
  `week_starts_on`.** The "every Nth week" count starts at the Monday of the
  week containing `start_at`; `settings.week_starts_on` only affects the pass
  wallet. If `start_at`'s weekday is not in `repeat_weekdays`, `start_at` itself
  does not fire (only the listed weekdays do, and never before `start_at`). The
  Kotlin mirror must match.

- **RPC error codes and check order.** Every failure is `raise exception` with
  errcode `P0001` and the code as the message (`error.message` in supabase-js).
  - `sync_wallet`: `not_authenticated`.
  - `use_pass(day)`: `not_authenticated`, `invalid_day`, `no_passes_left`,
    `day_in_past`, `already_cheat_day`, checked in that order.
  - `refund_pass(day)`: `not_authenticated`, `invalid_day`, `not_a_cheat_day`,
    `day_not_in_future`, checked in that order.
  - The pure TS `usePass` / `refundPass` use the same codes and order.

- Accepted residual (pass "today"): a user who keeps the wallet snapshot in a far-western zone and sets settings to that zone right before the first sync after a weekly boundary still gets about one day of slack, at most once a week. This is the same slack any user gets by picking a western zone, since the client chooses the zone. The airtight option was rejected because it hurts honest western users: treat a day as started once it has begun anywhere (`Pacific/Kiritimati`).

- **Dependency advisory (shadcn CLI, `braces` <= 3.0.3, high).** It comes in through the `shadcn` CLI, which the app only uses at build time for its CSS import (`shadcn/tailwind.css`), so it is a devDependency and not in the bundle. The patched `braces` 3.0.4 is not on npm yet; add a pnpm override once it is.
- **Dependency advisory (electron-builder, `http-cache-semantics` <= 4.2.0, high).** It comes in through electron-builder → @electron/get → got, which only runs while packaging and is never part of the app. The patched 4.2.1 is not on npm yet; add a pnpm override once it is.
- **app-dist is outside the asar.** The asar-integrity fuse covers only `app.asar`, not `resources/app-dist`. A per-user install is writable by that user anyway, so this protects against nothing extra; moving the React build into the asar is a possible later hardening step.

- **Desktop adapter (build-order step 6).** The Electron main process is the single flush
  owner for completions (`electron/src/completion-flusher.ts`); the app never upserts them on
  desktop, and `ElectronAlarmAdapter.drainCompletions()` returns nothing. Android keeps the
  spec's drain-then-upsert flow in JS. Main receives the access token only, not the refresh
  token: two clients refreshing one rotating refresh token get the session revoked, so only the
  renderer refreshes and pushes each new access token. The token lives in main's memory (the
  renderer restores its session on every launch and pushes it again), and main refuses a
  Supabase URL other than the one built in.
- `AlarmAdapter.setSchedule` takes an optional fourth argument, recent completions
  (`CompletionRow[]`), and the settings argument may carry the per-device `sound`
  (`AlarmSettings`). The Kotlin plugin must accept both. An occurrence with a known completion
  does not ring on wake-up inside the grace window; a completion on another device does not
  silence an alarm that is already ringing (spec 6.9).
- The Electron main window is created at launch (hidden for an autostart) so the React app can
  sync and hand over the session; the alarm window is the same bundle at `#/alarm?occurrence=...`
  and loads no Supabase client.
- **The first completion wins.** The desktop flush upserts with `ignoreDuplicates: true` (ON CONFLICT
  DO NOTHING on `(event_id, occurrence_at)`), so when two devices complete the same occurrence the row
  that arrived first is kept (including its `snoozes_used`) and the second write counts as success. This
  refines spec 6.9 ("both write the same upsert"): nothing is overwritten.
- **One bad row must not freeze the schedule.** Main validates `setSchedule` rows one at a time: an
  invalid event, cheat day or completion is dropped and counted (logged as
  `desktop.schedule_rows_dropped`, returned to the app, which shows one toast per session). Only an
  invalid envelope or invalid settings rejects the whole push. The bounds follow the database checks
  (non-blank title, `duration_min >= 1`, a non-empty weekday list, `max_snoozes` 0 to 10).
- **Signing out keeps the cached schedule.** On sign-out main drops the token and the sink client but
  leaves `cache.json` as is, so alarms keep ringing until another account signs in and replaces it (an
  unskippable alarm should not be switchable off by signing out). Two side effects: event titles and
  notes stay on disk in `cache.json` until the next push replaces them, and deleting `cache.json`
  (a cache reset) re-applies the packaged autostart default, because `autostartInitialized` lives there.
- **A hidden main window recovers on its own.** It is created at launch and never throttled
  (`backgroundThrottling: false`). A renderer crash or a failed page load is retried with backoff
  (1 s, 5 s, 30 s, 5 min) and, if that keeps failing, the window is rebuilt.
- **Loaders ignore out-of-order responses.** Each store loader (events, cheat days, settings, wallet,
  completions) applies a response only if no newer request of the same loader started since. The
  user's own writes (save or delete an event, save settings, spend or refund a pass) also make older
  in-flight loads stale. Realtime changes deliberately do not, so the catch-up fetch after a
  reconnect always lands.

- **Windows packaging (build-order step 7): electron-builder over Electron Forge.** The target is one
  unsigned per-user NSIS installer. electron-builder produces it from a single declarative file
  (`electron/electron-builder.yml`), has NSIS built in, copies extra resources (`app/dist` ->
  `resources/app-dist`) and applies Electron fuses and the embedded asar integrity from config
  (`electronFuses`). Forge would need a separate NSIS maker package plus a hook or plugin for the fuses.
  Pinned to 26.15.3 (the current stable `latest`; v27 is still alpha).
  - The main process and both preloads are already bundled by `build.mjs`, so nothing from `node_modules`
    ships. `@alarm-calendar/core`, `@supabase/supabase-js` and `zod` therefore moved to `devDependencies`
    of the electron package (they are build inputs, and it keeps electron-builder from walking the pnpm
    workspace for production dependencies).
  - Fuses set at package time: `RunAsNode`, `EnableNodeCliInspectArguments` and
    `EnableNodeOptionsEnvironmentVariable` off; `OnlyLoadAppFromAsar` and
    `EnableEmbeddedAsarIntegrityValidation` on. The integrity hash covers `app.asar` only. `app-dist`
    is a plain folder next to it, served as data over `app://`, so it is not integrity-checked (an
    attacker who can write to the per-user install folder can already write to the user's startup entry).
  - Left at their defaults: `EnableCookieEncryption` and `GrantFileProtocolExtraPrivileges` (the app
    loads nothing over `file://`, so turning the second off is a later hardening step).
  - **No code signing** (no certificate). Windows SmartScreen warns on first run of the installer
    ("More info", then "Run anyway"). The installer is per-user (`perMachine: false`), so it needs no
    administrator rights; app data (`%APPDATA%\Alarm Calendar`) is kept on uninstall.
  - `pnpm-workspace.yaml` sets `electron-winstaller: false` under `allowBuilds` (it is only used by
    electron-builder's Squirrel target, which is not built).
- **Alarm sounds are generated, not downloaded.** `electron/scripts/generate-assets.mjs` synthesises
  `bell.wav`, `chime.wav` and `pulse.wav` (44.1 kHz mono 16-bit, one loop cycle each that ends in
  silence), scaled to the same RMS so none is much louder than the others. WAV rather than mp3 (spec
  section 9) because there is no dependency-free mp3 encoder and no third-party audio is allowed in the
  repo; the three files total about 690 KB. The same script draws the clock icon at 16 to 256 px into
  `electron/assets/icon.ico` and `tray.png`.
- **Spec step 7 "permission flow copy" is Android-only** (section 10) and waits for the Android project.
