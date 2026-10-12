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
  notes stay on disk in `schedule.json` (and, while ringing, `cache.json`) until the next push replaces them, and deleting `cache.json`
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
- **The desktop alarm is a centered, 70%-opaque panel, not a full-screen layer (roadmap v2, phase 0).**
  Owner feedback: full screen covered a call or a demo. The window is 560x440 (capped at 90% of the
  work area), centered on the display holding the cursor, and uses `BrowserWindow` `opacity: 0.7` rather
  than `transparent: true` (opacity works on any frameless Windows window and keeps rounded corners and
  shadow). The step-4 guarantees are unchanged: frameless, always on top at `screen-saver` level, not
  minimizable, maximizable or resizable, re-fronted on minimize, hide, blur and every evaluation, re-opened
  after `refire_seconds`, taskbar flash, no close button. The panel has no drag
  region, so it stays centered. Extra simultaneous alarms cascade by 36 px (five slots, then wrap). The
  alarm screen stacks Done above Snooze, both full width, and shortens core's label "Snooze 5 min (2 left)"
  to "Snooze 5 min · 2 left" in the app (`snooze-label.ts`); core's `snoozeUi` is unchanged. The old
  button was off-center because the button component's `has-data-[icon=inline-start]:pl-2` overrode the
  large left padding while the right padding stayed, so the alarm buttons no longer use `data-icon`.

- **Seeded and scratch Electron runs never share the daily dev folder.** The unpackaged daily run uses
  `%APPDATA%\alarm-calendar-dev`, which is the owner's real data; a seeded test run once wiped it. Now
  `ALARM_DEV_SEED=1` or `ALARM_DEV_SEED_RESET=1` selects `%APPDATA%\alarm-calendar-dev-seed`, and
  `ALARM_USER_DATA_DIR` (unpackaged only) picks any scratch folder; `resolveUserDataDir` in
  `electron/src/config.ts` decides, and refuses a seed flag combined with an override that points at the
  daily dev or installed folder. Packaged builds ignore all of it. The single-instance lock is keyed by
  userData, so a seeded run (no real alarms) can run beside the daily instance without double-ringing.

- **Habit scoring (roadmap-v2 phase 1) lives in `packages/core/src/habits.ts`** with shared vectors in
  `test-vectors/habits.json`. Each habit has its own window, `max(28 days, 5 × nominal repeat period)` capped at 180,
  and the recency half-life is half of it. The app loads 28 days of completions for everything and older history only
  for slow habits; it never scores a habit whose window the loaded history does not cover.
- **`events.created_at` is pinned by a trigger, not a column grant.** `authenticated` holds table-wide INSERT and UPDATE
  on `events`, so `private.pin_event_created_at` sets it to `now()` on insert (whatever the client sends) and keeps the
  old value on update. Scoring ignores occurrences before it. The migration backfills existing rows with
  `least(start_at, now())` and pauses the `updated_at` trigger meanwhile, so no row's `updated_at` moves. Setting the
  column by hand (an import, say) needs the trigger dropped first. `supabase/tests/security_checks.sql` checks the trigger
  and the NOT NULL.

- **Yearly repeat and the birthday template (roadmap-v2 phase 2).** `repeat_unit` gains `year` (migration
  `repeat_unit_year`, `add value if not exists`; the value cannot be used in the same transaction that adds it, and Postgres
  cannot drop it again). Recurrence walks years from `start_at` and clamps the day to the month's length each time, so a
  Feb 29 series is Feb 28, Feb 28, Feb 28, Feb 29. The Kotlin mirror must pass the new vectors in `recurrence.json` and
  `habits.json`. Electron's schedule validation (`desktop-payloads.ts`) accepts `year`; an older Electron build drops a
  yearly alarm as an invalid row (counted and toasted) rather than breaking the schedule.
- **`events.group_id` is a plain nullable uuid with a partial index, no table and no foreign key** (migration
  `events_group_id`). RLS is untouched: the column sits on rows the user already owns. The app reads it, and until the
  migration is pushed the first read that fails on the column is retried without it (`events-api.ts`), so everything else
  keeps working; the flag also disables the Birthday tab (with a hint) until then. Only a 42703 or PGRST204 error that
  names `group_id` counts as the missing column; any other error is surfaced.
- **The birthday template is a tab of the New alarm sheet, not a separate action.** It is one decision ("what is this
  alarm for?") made before any field is filled, it needs no extra header button (the phone FAB stays a single
  "New alarm"), and the two forms share nothing after that, so each is its own component and switching tabs while
  creating starts that form fresh. Editing a grouped alarm opens the template form, because editing the prep alarm alone
  would let the pair drift apart.
- **How the pair is recognised on edit.** Same `group_id`, exactly two active members, both `year`, titles in the template's
  shape ("Prep for X's birthday", "Wish X a happy birthday"); the titles, not the dates, tell prep from wish, because a
  save that failed half-way can leave the prep dated after the wish. Anything else opens the
  normal form, so a hand-renamed or half-deleted pair is never misread.
- **A series without a typed year starts at the next occurrence; with one it starts in that year** (a past birth year starts
  in the past, which only affects what the calendar shows and not scoring, because scoring starts at `created_at`). A Feb 29
  series always starts on a real Feb 29, the latest leap year not after the next ring, so the clamp rule returns it to the
  29th. Editing a pair with no typed year plans from the pair's `created_at`, the basis the form uses to decide whether a
  year was typed, so a later edit never turns a derived year into a shown one.


- **Precomputed schedule (roadmap-v2 phase 3a): the engines consume a list, core computes it.** `expandSchedule` in
  `packages/core/src/schedule.ts` produces concrete occurrences (id `${eventId}@${utcIso}`, as before) with cheat day
  silencing and completions already applied; `SchedulePayload` version 2 replaces the events-based push. Reason: the
  Kotlin AlarmEngine would otherwise need the recurrence mirror, the cheat day rule and, from the next phases, prayer
  times, modes and exam sessions. The pipeline is sources (event series now; prayer and exam sessions later) then
  annotations (cheat days, completions; modes later) then sort, dedupe and bound, all on one `ScheduleOccurrence`
  record, so a new source never touches an engine. An occurrence is thin (`id`, `eventId`, `at`, `silenced`,
  `completed`); title, notes, snooze rules and sound are stored once per event in `eventInfo`, whose keys are also the
  active event ids. A later source that needs a per-occurrence text (the pre-prayer "You haven't logged Dhuhr") adds an
  optional override on the occurrence rather than a second copy of everything.
- **`expandSchedule` returns an object, not a bare array.** A caller also needs the horizon the list is actually complete
  to (a cap can shorten it) and which events were active. `buildSchedulePayload` wraps it for the adapters.
- **Horizon 60 days, grace look-back at most 7 days, caps 1500 per event and 5000 in all.** The horizon is uniform: a
  shorter horizon for sub-daily alarms was considered and dropped, because it would make `horizonEnd` the minimum over
  all events and shrink everyone's safety margin for one hourly alarm (one hourly alarm is 1440 occurrences and fits).
  Instead a cap that cuts anything moves `horizonEnd` back to just before the first occurrence cut and sets `truncated`,
  so the list is always truthful ("complete through horizonEnd") and an engine never mistakes a cut for silence. The 7 day
  look-back equals how long the scheduler remembers completions; it only matters for a `grace_minutes` setting above
  that. Before `now` only the latest occurrence of each event is listed (the only one that can ring), and a cap never
  cuts at or before `now`, so `horizonEnd` is never earlier than `generatedAt`; if the backfilled occurrences alone
  exceed the cap (more than 5000 active events) they all stay and the horizon ends at `now`. `grace_minutes` is validated
  up to the look-back (10080) and the scheduler clamps to it; `buildSchedulePayload` states a larger database setting as
  the look-back, so a legitimate push is never refused. Measured (Europe/Paris, `JSON.stringify`, titles about 35
  characters): 20 daily alarms are 1220 occurrences, 240 KB as pushed and as `schedule.json`; four hourly alarms hit the
  5000 cap, 0.94 MB; the worst case found, four hourly alarms with 20 kB notes each, is 1.10 MB (the notes are stored
  twice, once in `eventInfo` and once in `refillSource.events`); 100 daily alarms hit the cap at 0.99 MB. The previous
  shape (title, notes, snooze rules and sound repeated in every occurrence) was about 330 bytes per occurrence, 1.6 MB
  at the cap, plus the notes once per occurrence.
- **The list is renewed by the app and by main.** The app re-pushes on every change, launch, window focus and once a day.
  Electron main additionally keeps the events, cheat days and settings it was last given (`refillSource`, stored in
  `schedule.json`) and re-expands the list itself when it is a day old or under 7 days of horizon remain (at most hourly,
  so a cap-shortened horizon does not re-expand every 30 s), when none exists, or when it is dated in the future after a
  clock change. Reason: a renderer that is closed, crashed or signed out for weeks must not leave the alarms without a
  future, and the daily rule bounds the damage of a wrong `horizonEnd`.
- **Android implication.** A native engine that only stores the list has no way to extend it: after 60 days without the
  app opening it goes silent. 3a does not change that, it makes the fix small: either a periodic WorkManager job that
  wakes the app to re-push (and, when the horizon is under 7 days, notifies the user to open it), or the Kotlin side
  mirrors `expandSchedule`'s recurrence. Prefer the first; decide when the Android project exists. The engine also needs
  `eventInfo` (to dismiss an alarm whose event was deleted) and must keep its own copy of the title and snooze rules
  of a ringing or snoozed alarm, as Electron now does, because an occurrence leaves the list once it is older than the grace window.
- **`completed` and `silenced` are flags in the list, not rules in the engine.** Completions no longer travel in the
  payload; an occurrence done on any device arrives as `completed: true`. The Electron scheduler still keeps the ids it
  has seen for 7 days (`knownCompletions`), so a later push with fewer flags cannot make a done occurrence ring again.
  The cost: a cheat day or completion added while the app is closed is not seen by an engine until the next push (before:
  cheat days had the same limit, they came from the last push).
- **Ringing and snoozed state carries its own copy of the alarm's text and snooze rules.** The list drops an occurrence
  once it is older than the grace window, but a long snooze or an unclosed alarm outlives that. A new push refreshes the
  copy from the event's `eventInfo` (an edited title applies to a ringing alarm, as before).
- **The cache is two files, so a ring does not rewrite the list.** `schedule.json` (events, cheat days, settings and the
  schedule, written atomically by `createCachePersister`) is rewritten only when a push or a refill replaced those
  objects (compared by identity); `cache.json` (ringing and snoozed state, watermarks, pending and known completions,
  autostart flag) is small and written on every state change, also atomically (temp file, fsync, rename). Measured: a
  typical ring writes 7 KB (20 alarms ringing at once) instead of the 240 KB list, and about 1.6 KB with nothing
  ringing; the schedule file is written at most once per push, once per focus after an hour, daily, and per refill. The
  schedule file is written first, so a crash between the two leaves state one step behind a newer schedule, which the
  watermarks make harmless. The files fail independently: a corrupt `schedule.json` is moved aside and costs the
  schedule (the next push rebuilds it), not the ringing state or the pending completions.
- **Electron cache `version: 2` (state in `cache.json`, schedule in `schedule.json`), migrated on load; an old build cannot read it.** A version 1 file keeps its events,
  cheat days, settings, watermarks and completions; ringing and snoozed states are filled from their events (and dropped if
  the event is gone); the list is rebuilt on the first start. Going back is not supported: a build that predates 3a moves a
  version 2 file aside as unreadable and starts empty until the next push. Do not point an old build at a data folder the
  new one has used (the daily dev folder `%APPDATA%\alarm-calendar-dev` is shared by worktrees).
- **A push in the old events-based format is still accepted by Electron main** and expanded there with the same function,
  so a renderer that predates 3a (an app bundle cached or not yet rebuilt) keeps ringing. Delete `upgradeLegacyPayload`
  and the version 1 parse path once that cannot happen. The payload check keeps the three parts consistent: an
  occurrence or `eventInfo` entry of an event that is not among the kept `refillSource` events (invalid or absent) is
  dropped and counted in `dropped.occurrences`. Main's `makeOccurrenceId` is a copy of core's (the preload bundles
  `alarm-ipc.ts` and must not pull in the recurrence code); a test keeps them equal.
- **Parity is proven against the real phase 2 scheduler, vendored.** `electron/test-fixtures/legacy/` holds frozen copies
  of `scheduler.ts`, `cache.ts` and `alarm-ipc.ts` from commit 3ab5731 (outside `src/`, so not in the build);
  `schedule-parity.test.ts` runs the old and the list-driven scheduler on one fake clock with the same pushes and the
  same user actions and compares (occurrence id, ring instant, snooze label) and the pending completions. Variants: every
  alarm answered at once for 30 days (Paris across both DST changes and the Feb 28 clamp, Tunis as the no-DST control),
  never answered (window closed, refire), snoozed to the limit then done, and a mid-run re-push with an edited time. The
  30 day runs use an hourly alarm every hour only in the spring window (every 6 hours elsewhere) to keep the suite near
  15 s. Delete the fixtures and the test once phase 3b has shipped.
- **The renderer skips redundant pushes.** Expansion is memoized on the identity of its inputs (events, cheat days,
  settings, completions, sound) for an hour; a focus with unchanged inputs and a list under an hour old pushes nothing.
  A refused push clears the memo.

- **Prayer times (roadmap-v2 phase 3b): the `adhan` library, run on the device.** `adhan` 4.4.6 (batoulapps/adhan-js, MIT, last
  published 2026-08-30, ships types, no dependencies); the Kotlin twin of the same library is the Android plan. The method is
  `CalculationMethod.Other()` with the user's Fajr and Isha angles, the Asr shadow factor (`Madhab.Shafi` for 1, `Hanafi` for 2)
  and a per-prayer minute offset (`adjustments`); defaults are Ariana (36.8625 N, 10.1956 E), 18 and 18, factor 1 (the owner
  follows no specific method). Times are rounded to the minute by the library. `prayerTimesOnDay` takes a calendar date and
  builds adhan's `Date` from the date's own year, month and day, so the machine's zone never matters (tested under five
  `TZ` values); the zone setting only decides which local dates a range covers, so a zone with DST works (checked in Madrid
  across both changes). The library already puts every time on the right local day for any longitude (checked once over a longitude
  and latitude grid, and by the Auckland and Los Angeles vectors). Not handled: high latitudes where Fajr or Isha do not exist use adhan's night-portion rule, and a polar
  date with no sunrise throws and shows no times.
- **Verification of the times.** `packages/core/test-vectors/prayer-times.json` holds 23 cases (Ariana through both solstices,
  an equinox, today, a Hanafi Asr, Madrid across both DST changes, Jakarta, Auckland, Los Angeles) with expectations from the
  Aladhan API (`/v1/timings`, custom method 99, fetched 2026-10-06 04:19 UTC), a separate implementation. Fajr, Dhuhr, Maghrib
  and Isha match to the minute in all 23. Asr differs by up to 2 minutes: adhan reads the solar declination at solar noon,
  while an independent calculation that evaluates it at the Asr instant itself (NOAA equations, stored as `asrNoaa`) agrees with
  Aladhan within a minute. The tests allow 1 minute for the four and 2 for Asr against Aladhan, and 1 minute for Asr against the
  independent value.
- **Prayer rows are real events, one per prayer and kind.** Migration `20261006042009_prayer_times`: enum `event_kind`
  (`events.kind`, default `normal`), `events.prayer` with a check that it is set exactly when the kind is not normal, a partial
  unique index on `(user_id, kind, prayer)`, the prayer columns on `settings` (with the column grants), and the RPC
  `set_prayers_enabled(boolean)` (security invoker, one transaction, `ON CONFLICT ... WHERE kind <> 'normal' DO UPDATE SET active
  = true`). The check first passed a prayer row with no prayer (a null inside `IN (...)` makes it unknown, and unknown passes);
  `prayer is not null` is now explicit. The migration, the RPC and `security_checks.sql` were run against a Postgres (PGlite) with
  stubbed Supabase roles: shape checks, the unique index, grants (the prayer columns writable, `pass_cap` not), switching on twice,
  off and on again, and no access for `anon`.
- **`prayers_enabled_since`** (not in the first design). Switching prayers off deactivates the rows, and switching them on
  again would make habit scoring count the whole stretch with prayers off as missed. Scoring of a prayer starts at
  `max(window start, created_at, prayers_enabled_since)`, and the pre-prayer text ignores prayers from before it.
- **Snooze rules and `passable` of prayers are not read from the row.** `prayer_max_snoozes` and `prayer_snooze_minutes` on
  `settings` fill `eventInfo` for all ten alarms, and `isEventPassable` is false for every non-normal kind, so a row edited by hand
  cannot be silenced by a cheat day or get its own snooze count. One setting is easier to reason about than ten rows.
- **Every consumer goes through `eventOccurrencesBetween`** (`packages/core/src/occurrences.ts`): `expandSchedule`, the
  calendar (`expandOccurrences`, `dayImpact`) and habit scoring. A normal alarm is exactly `occurrencesBetween` as before (the
  recurrence and habit vectors are untouched and pass). `Settings`' prayer fields are optional in the type (a cache or push from
  before the feature, and test fixtures), and absent means prayers off.
- **The "not logged" text is decided at ring time, not when the list is built (a flaw in the first design).** A list built at 08:00
  cannot know whether Dhuhr will be logged before the Asr reminder at 15:09, and re-pushing on completion changes does not help
  when nothing is completed (nothing triggers a push as Dhuhr passes). So a pre-prayer occurrence carries `label` ("Asr in 15
  min") and, whenever the previous prayer is not known to be completed at build time (behind us or still to come),
  `labelIfUnlogged` with that prayer's occurrence id. The engine shows the alternative
  text when that occurrence is not completed as the alarm rings (`AlarmScheduler.textFor`: the list's `completed` flags, the
  completions it knows, its own pending ones). That is the one rule an engine learns for prayers; a Kotlin engine needs it too.
  Limits: a completion made on another device while the app is closed is not seen; a reminder that rings late (device asleep)
  still says "in 15 min"; the engine keeps the text it rang with (it is refreshed from the next list only while the occurrence is
  still in it).
- **"Previous prayer".** Fajr follows the previous day's Isha. The text uses the previous prayer only when its time is at or
  after `prayers_enabled_since`, is not later than the reminder itself (a 2 hour lead can put the Isha reminder before Maghrib),
  and its event is active. "You have until <this prayer>" is the owner's wording; for Fajr it would be wrong (its time ends at
  sunrise, long before the Dhuhr reminder), so that one reads "You haven't logged Fajr — its time ended at sunrise".
- **Calendar.** The five prayers show outlined with a moon icon (`.occurrence-prayer`, no new colour); the reminders are left
  out (five more items a day would bury it). A prayer opens a short summary with "Open prayer settings", not the event form: it has
  no time to edit and its snooze and sound are settings. "Cheat day" counts the prayers as alarms that ring anyway.
- **Habits.** Each prayer is a habit (done means prayed, window 28 days like any daily alarm); the reminders are not
  (`isHabit`). Prayer completions go through the same `completions` table and realtime.
- **Custom prayer sound (desktop).** The file is chosen in a dialog opened by main, checked by size (5 MB), extension and content
  (mp3, wav, ogg, m4a), and copied to `<userData>/custom-sound/prayer-sound.<ext>`; renderers never name a path, the alarm window
  can only read it while it is ringing an occurrence, and main re-checks the stored file on every read. The alarm window plays it
  from a blob (`media-src` already allows `blob:`), which works in the packaged app and under the dev server alike (a custom URL on
  the app scheme would not be same-origin under Vite). A missing or undecodable file falls back to the bundled bell. The sound
  choice is per device like the alarm sound (`settings.prayerSound` in the push: a bundled id, `custom`, or absent for "same as the
  alarm sound"). The reminders keep the normal alarm sound.
- **Location.** Latitude and longitude are typed; "Use my location" uses `navigator.geolocation` where it exists and is hidden in
  the desktop app, whose shell denies every web permission and where Chromium's location service needs a Google key. A live
  line of today's five times follows the form so a wrong value is visible before saving. Ariana's coordinates (36.8625 N,
  10.1956 E) are the city centre (36 51 45 N, 10 11 44 E).
- **Electron zod schemas list every new field.** The schemas strip unknown keys, and a prayer row that lost its `kind` would be
  scheduled from its `start_at` as a one-off alarm; a prayer event without a prayer is dropped. Invalid prayer settings reject
  the push as a whole (the previous schedule stays), like an invalid zone.
- **Switching prayers off** drops them from the schedule completely (no `eventInfo`), so a ringing prayer alarm is dismissed
  by the next push, and main's own refill does the same.
- **Parity fixtures.** The note above says to delete `electron/test-fixtures/legacy` and `schedule-parity.test.ts` once phase 3b
  has shipped. It is done on the branch but not released, so they stay until the owner has the 3a and 3b builds in use.
- **A prayer completion matches by event and prayer-day, not by exact instant (review fix).** A completion is stored with
  the instant its alarm had. Changing an offset, the angles or the location moves later alarms by minutes, so matching by
  instant would orphan "prayed at 05:59" once the 06:01 alarm appears: it would ring again and be scored missed. Core's
  `prayerDayKey(event, instant, settings)` (`occurrences.ts`; `prayerDayOf` in `prayer-times.ts`) names `<event id>|<day>`, where
  the day is the one of the three nearest local dates (in `settings.timezone`) whose own time for that prayer is closest to the
  instant. That is the day the time was computed for, so a late Isha pushed past midnight by an offset keeps its day instead of
  drifting to the next date (tested in a +5:30 zone). A pre-prayer alarm uses its lead. One helper serves all three places:
  `expandSchedule` (the `completed` flag and the "previous prayer" check), habit scoring (`computeHabitStats`) and the Electron
  scheduler (`isKnownCompleted`, which also looks at pending completions and the known ones). Normal alarms still match by exact
  instant. `prayers_enabled_since` is not touched by settings edits. Limit: a settings change that moves a prayer by half a day
  or more (a location on the other side of the world) can map a completion to the wrong day.
- **The engine always decides the "not logged" text (review fix).** `labelIfUnlogged` is emitted whenever the previous prayer is
  not known to be completed when the list is built, including when it is already past, because a Done made afterwards (here,
  pending, or on another device) must still win. `label` is then always the plain text. Main's refill now passes its pending
  completions as well as the known ones, and `textFor` already asked `isKnownCompleted`, which covers pending ones.
- **Prayer latitude is limited to 65 degrees north or south (review fix).** Beyond it the sun can stay up or down all day and there
  is no prayer time to calculate. The limit is in the migration check (`latitude between -65 and 65`), the form, core's
  `PRAYER_LIMITS` and the Electron schema. If a corrupt row still produces no times, nothing crashes: the calendar and the cheat
  day dialog skip that event (`expandOccurrences` takes an `onEventFailed` callback, and the page shows one line), the Stats report
  lists it in `failed` (one line there too), and the schedule reports it through `onEventFailed` as before.

- **Exams and revision (roadmap-v2 phase 4): the alarms are plain one-off `normal` events linked by `exam_id`.** The alternative, a new
  `events.kind` like the prayers, would have made every consumer of `eventOccurrencesBetween` (schedule, calendar, habits, Electron's
  schema and scheduler) learn a second source whose times are not computed but fixed. A session has a fixed instant, so it is exactly a
  one-off normal alarm: recurrence, the schedule list, cheat-day silencing, completions, realtime and the engines work unchanged
  (Electron needs no change; its zod schema strips the new columns, which it never reads). `exam_id` is the only link the app needs.
  Sessions are not habits (`repeat_unit = 'none'`), so they are never scored.
- **Migration `exams_and_revision`.** Table `exams` (RLS own rows, grants like `events`, realtime, `updated_at` trigger, soft delete with
  `active`), and on `events`: `exam_id` (fk, on delete set null), `catch_up_of` (fk to `events`, on delete cascade) and one column that was
  not in the brief, `exam_role` (`exam` or `session`). It exists because the exam's own alarm and a session are otherwise
  indistinguishable (a title convention would be fragile, and `passable` would be an implicit marker), and because it lets the database
  keep "at most one active exam alarm per exam" with a partial unique index. `events_insert` and `events_update` now also check
  `exam_id is null or exists (own exam)`: foreign key checks ignore RLS, so without it a client could link an alarm to someone else's exam
  (the same pattern as `completions`). The first draft of the catch-up shape check, `catch_up_of is null or (exam_role = 'session' ...)`,
  let a null role through (an unknown check passes, as with the prayer shape in 3b); `is not distinct from` fixes it. Found by running the
  migration in PGlite.
- **`catch_up_of` has a plain unique index, not a partial one.** The app writes a catch-up with `INSERT ... ON CONFLICT (catch_up_of) DO
  NOTHING` (supabase-js `upsert(..., { onConflict: 'catch_up_of', ignoreDuplicates: true })`), and PostgREST cannot pass the predicate of a
  partial index, so the conflict target could not name it. Postgres treats NULLs as distinct, so the many events without a catch-up do
  not collide. A deactivated catch-up keeps its row, so the missed session never gets a second one: that is deliberate, the miss has been
  dealt with once.
- **What is a missed session, and when to act.** `classifySession` (core): completed (done, or `skipped_cheat`) is done or skipped; a cheat
  day silencing a passable session is skipped (the person chose the day off, so no catch-up); otherwise upcoming, due (inside
  `grace_minutes`) or missed. For catch-ups the app waits a further 10 minutes (`CATCH_UP_SETTLE_MINUTES`), because a Done pressed on an
  offline device reaches the database only when it reconnects. Before writing, `runCatchUps` asks the database for the completions of the
  sessions it is about to act on, so a stale local list can never cause a catch-up nobody needed; if that read fails, nothing is written
  and the next run retries. The check runs from `use-live-sync` (after the first load), on a 1 second debounce after any change to
  events, exams, exam completions, cheat days or settings (so realtime completions and edits trigger it), on window focus and every 5
  minutes (time passing is what turns a session missed; nothing in a store changes when it does), never inside rendering. A module-level
  set remembers missed sessions already handled in this run of the app so the 5 minute tick does not re-ask the database about them; the
  unique index, not that set, is what protects against another device.
- **Catch-up timing (`planCatchUp`).** The ideal is halfway between now and the exam. The chosen time is the quarter hour nearest to it
  that is inside 08:00 to 21:00 local (the settings zone, DST included), at least 30 minutes after now, at least an hour before the exam
  and at least an hour from every other alarm of the exam (so two missed sessions get catch-ups that do not stack, and a catch-up never
  sits on a session). That is a search outward from the ideal rather than clamping it, so a halfway point at 03:00 goes to whichever of
  21:00 the evening before and 08:00 that morning is nearer and still fits. No slot, or under 3 hours left, means no catch-up; a catch-up
  is never itself caught up. Reference values live in `exams.test.ts`.
- **Passable.** Revision sessions are passable (a plain alarm's default), so a pass silences them; the exam alarm is not, so a cheat day
  never silences it. Reason: a cheat day is a day the person chose to switch off, and forcing revision through it would contradict the
  pass; the exam itself is the one thing that must not be slept through. A session silenced that way counts as skipped, not missed.
- **The exam alarm.** It rings `leadMinutes` before the exam (default 60, 0 to 1440, a field in the form), is not passable, and its calendar
  block runs from the alarm to the start of the exam (at least 15 minutes). Because `exams` has no columns for the form's session time,
  session length or lead, they are read back from the alarms when an exam is edited: the lead from the exam alarm, the time and length
  from the latest planned (not catch-up) session, so sessions kept from before an edit do not outvote the new ones. Defaults when absent.
- **Editing regenerates by diff, not by delete and recreate (`diffExamAlarms`).** Sessions whose time has passed (done or missed) are
  kept untouched. Sessions to come are matched to the new plan by their start instant: matches are updated in place (a new title), the
  rest are deactivated and the unmatched planned ones inserted; a future catch-up is kept (retitled) while it still has an hour before
  the, possibly moved, exam. So a title edit keeps every id, a date edit replaces only what moved, and saving again after a failed write
  repairs a half-applied edit, because the diff is against what exists. The edit is several requests (exam row, inserts, updates,
  deactivation), not a transaction. Creating writes the exam, then every alarm in one insert; if the alarms fail it deactivates the exam.
  Deleting switches off the exam's alarms first, then the exam, so nothing keeps ringing if the last step fails.
- **UI.** The creation flow is the third tab "Exam" of the New alarm sheet, like Birthday / anniversary: the choice "what is this for" comes
  first and the form that follows shares nothing with the others. A separate Exams screen (`/exams`, graduation cap in the header) lists
  upcoming then past exams with done / to go / missed counts and opens the same sheet for edit; clicking any alarm of an exam on the
  calendar opens the exam form, since editing one session alone would let the plan drift. The form previews the sessions and the exam
  alarm. A new exam defaults to the clicked day, or the next day once 09:00 has passed. The calendar tags the exam alarm with a graduation
  cap and sessions with an open book.
- **Exam data loads after the first render, like the habit history.** `loadExams` and `loadExamCompletions` run from `refreshAll`, which
  the realtime subscription calls on subscribe, so startup and the schedule push never wait for them. The completions of the exam
  alarms are fetched by event id (an exam can be weeks old, beyond the 3 day recent list). The app requires the migration (it selects
  `exam_id`, `exam_role`, `catch_up_of` with the events), like 3b.
- **Phase 5 hook.** Exam mode's auto-activation can read `useExamsStore` (`exam_at`, `active`); nothing else about exams needs to change.
- **Review fixes (phase 4).**
  - `catch_up_of` must belong to the caller: `rls.owns_event(uuid)` (security definer, in a schema PostgREST does not expose, execute for
    `authenticated` only) is part of the WITH CHECK of `events_insert` and `events_update`. A plain `exists` on `events` inside an `events`
    policy would recurse, and the foreign key check ignores RLS.
  - A Done pressed offline on this device: before inserting, `runCatchUps` also asks the adapter for the occurrence ids main has not flushed
    yet (`AlarmAdapter.getPendingDoneOccurrences`; Electron: channel `desktop:pending-done-occurrences`, main window only, no arguments,
    zod-checked ids only, read from `cache.pendingCompletions`; the no-op adapter returns `[]`). If the adapter cannot answer the run writes
    nothing (a late catch-up beats a spare one). A future catch-up whose session later gets a completion is switched off
    (`catchUpsToCancel`); a past one is left as history.
  - The exam data loads once from `use-live-sync` (`loadExamData`: exams, then completions), independent of the realtime subscribe, so the
    Exams screen shows an error with a retry instead of a skeleton that never ends. Completions are loaded only for exams that are still to
    come or ended under 7 days ago (`EXAM_COMPLETION_HORIZON_DAYS`); the progress of an older exam is not shown (it would be computed from a
    list that leaves its completions out). A realtime completion that arrives during that load is merged and replayed over its result;
    it no longer invalidates the load, which used to leave the status on "loading".
  - Catch-up runs do not overlap; a trigger that arrives during a run sets a pending flag and one more run follows.
- **Known limits (phase 4).** A catch-up is created only by an app that is running (the desktop app runs in the tray; a laptop that is
  off all day creates it on the next start, possibly late). A Done made on another device that is offline and not yet saved is invisible
  to this one until it reaches the database. Changing the exam time keeps catch-ups still to come; one that is now before an
  earlier-moved session is not re-planned.

- **Modes (roadmap-v2 phase 5): applied while occurrences are computed, never to the alarm rows.** The schedule list, the calendar and habit scoring
  all go through one core module (`modes.ts`): `buildModeTimeline` resolves the modes once, `modeEffectOf` says what the mode in effect does to
  one alarm, `applyModesToInstants` applies it to the instants a recurrence produced. The engines needed no mode logic.
  - **Skip is omission from the engine list, "paused" everywhere else.** A paused occurrence is not in `SchedulePayload.occurrences`; the calendar
    keeps it in its list flagged `paused` (greyed, dashed, struck through, with the mode name), and habit scoring gives it the outcome `paused`
    (new `HabitStats.paused`, left out of the score and the counts like `excused`, a streak is kept alive but not extended). The alternative, a
    `paused` flag in the list for engines to honour, would have been the first mode logic in an engine. Limit: an alarm that is already ringing or
    snoozed when a mode switches on keeps ringing (the engine only dismisses an alarm whose event is gone); Done or Snooze ends it.
  - **Shift keeps the engine contract: the id follows the new instant.** `ScheduleOccurrence.id` must equal `${eventId}@${at}` (Electron's schema
    checks it), so a shifted occurrence has a new id and a completion written for it is keyed by the shifted instant. To keep switching modes from
    orphaning a Done, completion matching accepts either instant (`expandSchedule`'s `completed`, habit scoring): a Done pressed before a shift took
    effect still counts after it, and the reverse. The mode is chosen by the occurrence's original time, the cheat day by the day it rings on. A
    shift moves an occurrence at most 12 hours, so the recurrence is asked for 12 hours more on each side and the result is filtered on where it
    rings (the same in `expandSchedule`, `expandOccurrences` and `computeHabitStats`). Two occurrences landing on one instant keep one, live over
    paused. Shorten is a calendar-only change.
  - **A shift never makes an alarm vanish (review fix).** Two guards, for every alarm and not only non-passable ones. `modeEffectOf` ignores a shift
    that would put the occurrence before the start of the window of the mode in effect (a manual switch made at 09:40 does not move the 10:00
    medication to 09:00 or 08:00: it would have rung before the switch, or been dropped as already past). And `expandSchedule` keeps an occurrence at
    its own time when its shifted time falls before the grace window while the original is still ahead or inside it (an alarm 09:20, shift -120,
    now 09:00).
  - **Completion matching across a shift is symmetric (review fix).** `ModeTimeline.matchInstants(event, at)` returns the occurrence's own instant and
    that instant moved by each shift minute any active mode has for the alarm, either way. A Done pressed at the shifted 08:30 therefore covers the
    09:00 occurrence once the mode that shifted it ended at 08:35 (no second ring, habits count it done), and the reverse. A shift as long as the
    alarm's own repeat period is ignored (an hourly alarm shifted by an hour would otherwise count the neighbouring occurrence). It is used in
    `expandSchedule` (the `completed` flag), `computeHabitStats` and, live, in Electron's `isKnownCompleted` (the scheduler builds the timeline from
    its cached modes, memoized). Exam sessions needed nothing: a session is one-off and its completion is matched by event, not by instant.
    Limit: it matches only shifts that still exist as rules; deleting the rule afterwards leaves a Done at the old shifted time unmatched.
  - **`originalAt`.** A shifted occurrence in the list carries `originalAt` (when it would have rung without the shift). Electron validates it (a
    timestamp, different from `at`, at most 12 hours away) and `isKnownCompleted` also checks it, which matters where the reverse match is off (fast
    alarms) and for a Done seen from another device before the list was rebuilt.
  - **Non-passable alarms are never paused; an explicit shift or shorten rule may still move them.** The brief asked whether an explicit rule may
    skip one: no. Skipping needs `isEventPassable`, so medication, the alarm before an exam and every prayer are immune to a default and to a rule
    (the editor disables Pause for them and shows "Always rings"). Shifting a non-passable alarm is allowed because that is the person choosing its
    time (Ramadan moving a medication), not a mode silencing it. Prayers and their reminders are fully immune, shift included; they are not even
    listed in the editor.
  - **Precedence and Normal.** Manual beats range beats exam; among windows of one source the one that started last wins, so a new switch overrides an
    older open-ended one even if the database kept both. Normal is the absence of a row, so "back to normal" only ends the manual activation: under a
    range or an exam window the planned mode applies again, and the dialog says so (Normal is disabled with an explanation when only a planned
    mode is on). Opting out of an exam window is the lead setting (0) or switching the Exam mode off.
  - **Exam auto-activation is derived, one global setting.** `settings.exam_mode_days_before` (default 10, 0 = off) instead of a per-exam
    value: one number is enough for one user, and a column on `settings` is writable with the other settings. The window is the local midnight that
    many days before the exam day to the end of the day after it, in the settings zone, for the built-in Exam mode when it is on. `examModeWindows`
    computes it on every call from the active exams, so moving or deleting an exam moves or removes it, with no stored rows to go stale. Deviation
    from the brief: `mode_activations.source` is only `manual` or `range` and there is no `exam_id` column, because a stored exam activation would
    contradict "computed, not stored", and without the column there is one less cross-table check. In core the computed windows have source `exam`.
  - **`effectiveModeAt` takes a config object.** `effectiveModeAt(instant, config, settings)` with `config = { modes, rules, activations, exams }`
    rather than the four-argument form in the brief, because the Exam mode's id (to attach the computed windows to) lives in `modes`.
    `effectiveModeSegments(from, to, config, settings)` is the range variant (the calendar's day marking, "next mode").
  - **Built-ins by RPC, not a client upsert.** `ensure_builtin_modes()` (security invoker, `search_path ''`): the conflict target is the partial index
    `modes_builtin_unique`, which PostgREST cannot name (the same reason `events.catch_up_of` has a plain unique index). The app calls it from
    `loadModes` when a built-in is missing. It never updates an existing row, so a user's edits and an off switch survive. Kind and key are fixed at
    insert by column-limited grants (`kind` and `builtin_key` are insertable but not updatable; `user_id` is neither), so a client cannot turn a custom
    mode into the Exam mode.
  - **Vacation also defaults to skip.** The brief gave a default only for Sick. An empty Vacation would do nothing until configured, so it is created
    with Sick's default (editable in the Modes screen). Exam and Ramadan keep everything until rules are added.
  - **The switch is one RPC.** `set_manual_mode(mode, starts_at, ends_at)` ends the running manual activation and starts the new one atomically.
    "Since this morning" passes a start earlier than now (up to 7 days, enforced) so alarms that already rang today are paused rather than missed.
  - **Loading and the first push.** Modes and exams are read in `bootstrap` (best effort, with the events), so the first schedule push already knows
    them; a failed read means every alarm rings, the safe direction, and the push is repeated when they arrive. The schedule sync watches the modes
    store and the exams store (moving an exam re-pushes). A payload for a person with no mode has no `modes` key. Modes and rules are loaded whole (a
    full page of 1000 is a failed read, like the habit history). Activations are loaded in pages of 1000 (up to 10, then a failed read) and only
    those that are open-ended or ended within the last 181 days (the longest habit window plus a day), since an older one cannot change a score or
    what rings: a missing activation would un-pause alarms, so a partial list is never accepted.
  - **Electron.** `refillSource.modes` is validated with bounds as the database (shift +-720, shorten 1 to 1440, the value only for its behavior, an
    activation that ends after it starts, up to 200 modes, 5000 rules and activations, 1000 exams; the mode name is `max(400)`, looser than the
    database's 60 on purpose). A mode is used whole or not at all (review fix): if any rule or activation of a mode is invalid, that mode, its rules and
    its activations are all dropped, because a missing rule or activation would change what the mode does and the safe direction is ringing; one too
    broken to name its mode drops every mode. An invalid mode row or exam is dropped alone (nothing then applies for it). Everything dropped is counted
    in `dropped.modeRows`. The cache stores `modes` beside the events and cheat days in `schedule.json` (optional there, so an older file loads), and
    `AlarmScheduler.refillIfStale` passes them to `expandSchedule`.
  - **Exam sessions.** `sessionStateOf`, `examProgress` and `planCatchUps` take the modes: a session a mode pauses is `skipped` (never `missed`), so
    sleeping through Sick does not earn a catch-up the day after.
  - **Known limits.** History is recomputed from the current data: editing a mode's rules or default, deleting a custom mode, switching a built-in
    off, deleting an exam (Exam mode's past window disappears) or changing the exam lead changes what was paused in the past, and so past scores.
    Manual and range activations are stored and keep their history. The mode applies to one-off alarms too (through the default), but rules are
    editable only for repeating ones. A mode cannot be switched to "Normal" over a planned one. The Kotlin engine needs nothing; a Kotlin mirror of
    `modes.ts` is needed only if Android ever expands the schedule itself.
  - **Test timing.** `schedule-parity.test.ts` (30 days of every alarm on a fake clock) took 4 to 5 seconds per case against the default 5 second
    limit and failed whenever the machine was busy, also before phase 5. Its top-level `describe` now has a 30 second timeout.
  - **Verification.** The migration and `supabase/tests/security_checks.sql` (306 rows, all PASS) were run against PGlite with stubbed Supabase roles,
    together with a probe (79 checks) for: built-ins created once per user, identity and `user_id` not client-writable, cross-user `mode_id`,
    `event_id` and random ids denied on rules and activations, rule shape bounds (shift +-720, shorten 1 to 1440, value only for its behavior), the
    unique `(mode_id, event_id)` upsert, the manual switch (open-ended, bounded, since this morning, supersession, back to normal, future and
    8-days-back starts denied, inactive and foreign modes denied), anon denied on every table and RPC, the settings column bounds, and cascades.

- **Feedback round 1: habits (2026-10-06).**
  - **Yearly and template alarms are not habits (`isHabit`).** Chosen: exclude every `repeat_unit = 'year'` alarm and anything with a `group_id`, not just
    template-shaped pairs. The owner's example is the birthday template, but a rank needs 5 scored occurrences, so any yearly alarm would be
    "Unranked" for 5 years; a permanent "0 of 5" row on Stats says nothing. `group_id` is also excluded explicitly so a pair whose titles or repeat were
    edited by hand still stays out. Side effect: the 180-day history read no longer includes yearly alarms. The Modes rule editor still lists them
    (a mode may reasonably pause a birthday prep alarm).
  - **One pooled Prayer habit (`pooledPrayerHabit` in `habits.ts`).** Each prayer event is still scored by `computeHabitStats` (weights, grace, prayer-day
    matching and `prayers_enabled_since` are untouched); `computeHabitsReport` then sums the five into one `HabitStats` with `eventId = PRAYER_HABIT_ID`,
    `pooled: 'prayer'`. Score = 100 x sum earned / sum possible, the overall score's own formula. The overall score takes that one entry with its summed
    numerator and denominator, which is numerically what five separate habits gave, so the overall number did not move; Prayer is one entry in "ranked
    habits" now. If the owner wants Prayer to weigh like one daily alarm instead of five, divide its earned and possible by the number of prayer events
    before pooling (one line).
  - **The prayer streak counts prayer-days.** An occurrence belongs to the day it was computed for, `prayerDayOf(config, prayer, instant, tz)`, the same day
    completions are matched by (review fix: bucketing by the local date of the instant put an Isha pushed past midnight by an offset on the next day, and
    would split the five of one day over two). Day outcome (`prayerDayOutcome`): any miss makes it missed; else any pending makes it pending; else any done
    makes it done; only excused or paused keeps a streak alive. Streak rules are then the habit rules: done adds, missed resets, pending skipped.
    Two incomplete days are left out of the days, `scoredDays` and the streak altogether (review fix): the first day when the window starts part-way
    through it (the scoring floor is the window start, `created_at` or `prayers_enabled_since`, whichever is latest), even if a prayer on it was missed,
    and the last day while its later prayers have not come yet, because occurrences only exist up to `now` and a streak would grow at Fajr. A day is
    "incomplete" when it holds fewer occurrences than there are prayer events. The prayers on those days are still in the counts and the score.
  - **Ranked from 5 scored prayer-days, not 5 prayers.** Five scored prayers is one day. `scoredDays` is the evidence count and Stats says "3 of 5 days
    scored"; `scored` stays done + missed (prayers).
  - **The badge in the prayer sheet** is the pooled one ("All five prayers together"); the pre-prayer reminders show none, as before.
- **Feedback round 1: calendar visibility.** `events.show_in_calendar boolean not null default true` and `settings.show_prayers_in_calendar boolean not null
  default false` (migration `20261006173000_show_in_calendar`; `events` is covered by the table-wide grants, the settings column is granted for insert and
  update like `exam_mode_days_before`; `security_checks.sql` checks grants, NOT NULL and defaults). A prayer follows only the settings flag and ignores its own
  row's flag (ten rows would be ten things to keep in step). The flag is read in one place, `isHiddenFromCalendar` (`calendar-events.ts`);
  `expandOccurrences` still returns every occurrence with `hidden`, and `visibleOccurrences` is the only filter, so `dayImpact` keeps counting hidden alarms.
  Nothing in core's occurrence rules, the schedule list, the engines or habit scoring reads it; Electron's zod schemas list both fields (optional booleans with
  `.catch(undefined)`, so a malformed value reads as absent and can never drop an event or reject a push) and never use them, tested by comparing the schedule of
  hidden and visible rows. The toolbar "Show hidden" toggle appears only when something is hidden
  (an active alarm with the switch off, or prayers on and hidden), is kept in `localStorage` through `device-preference` (`show-hidden-preference.ts`; a
  refused write still holds for the session) and shows hidden alarms faded with an eye-off icon (and a "Hidden" badge in the Agenda). The Agenda says "N
  hidden alarms ring in this period" when it is quiet only because of hiding; the number counts distinct alarms (not
  rings) and leaves the prayers out (`hiddenAlarmCount`). The birthday switch sets both alarms; the exam switch sets the exam alarm and
  every session, is read back from the exam alarm on edit (like the lead), updates sessions still to come in place (`diffExamAlarms`), and a catch-up copies
  the flag of the session it replaces.
- **Feedback round 1: category colors.** `alarmCategoryOf` (`events/category-colors.ts`): `exam_role` exam / session (catch-up when `catch_up_of` is set) and
  `group_id` (birthday). The colors are `--cat-*` tokens in `index.css`, in oklch, with separate light and dark values. Rose (hue 8) for birthdays; indigo
  (hue 275) for the exam family: the exam alarm is a solid fill, a session a soft tint with a bold left edge, a catch-up the same tint outlined. The tinted
  chip is also what sets them apart from the picker's solid blocks: rose sits between the picker's red and pink, so hue alone would not. Each category has an icon (gift,
  graduation cap, open book, rotate-back arrow), so color is never the only cue. Contrast (WCAG, computed from the oklch values): text on fill 9.98 (birthday) /
  8.32 (exam) / 9.98 (revision) in light, 10.77 / 7.76 / 11.24 in dark; accent edge against the page 4.36 / 8.71 / 5.14 in light (white) and 7.43 / 8.42 / 6.67 in dark.
  The category color wins over `events.color`; the form shows "... alarms have a fixed color" instead of the picker (the template and exam forms never had one).
  Week and Month share the `.cat-*` classes; the month dot takes the accent through FullCalendar's per-event color (a CSS variable string). Prayer styling, cheat-day,
  paused and hidden treatments stack on top.
- **Holidays (owner request, 2026-10-12).** Display only: Tunisia's public holidays (or any country's, picked in Settings) and Islamic holidays on Week, Month
  and Agenda. They never ring, are not in the schedule list or the engines, are not habits and are not in the pass logic; nothing in `packages/core`'s
  occurrence rules reads them. Migration `20261012090000_holidays` adds `settings.holiday_country` (ISO alpha-2 or null), `islamic_holidays` (bool, default
  false) and `hijri_offset_days` (smallint, -2 to 2, default 0), granted for insert and update by column; existing `Africa/Tunis` rows start as TN with Islamic
  holidays on. `security_checks.sql` checks the grants, NOT NULL, the defaults and both value checks. There is no per-holiday editing and no toolbar toggle: the
  three settings are the switch (country None and Islamic off draws nothing).
  - **Country holidays: `date-holidays` 3.37.0** (ISC code, data CC-BY-3.0, so attribution applies; actively maintained, last release 2026-09-20; 207 countries; works
    offline, the data is in the package). Tunisia is covered with its four Hijri-dated holidays (1 Muharram, 12 Rabi' al-awwal, 1 Shawwal, 10 Dhu al-Hijjah)
    plus the fixed ones. Nager.Date was rejected (a web API, no offline mode). The library and its world dataset are about 1.4 MB minified (238 KB gzipped, of which
    725 KB minified is moment-timezone data it pulls in), so `country-holidays.ts` loads it with a dynamic `import()`: it is its own chunk, fetched only when a country is
    set or the Settings country list is opened, and the main bundle grew by about 15 KB for all the holiday code. Only `type: 'public'` is kept (the library also
    lists observances, bank and school days) and only nationwide days (no states or regions). Names come out in English, then French (the owner reads both;
    Tunisia's own national holidays have French and Arabic names only), then the country's own language. CC BY 3.0 attribution ("Public holiday data: date-holidays by commenthol, CC BY 3.0, https://github.com/commenthol/date-holidays") is in the README,
    under the Settings country picker, and in `THIRD_PARTY_NOTICES.md` at the repo root (the library, its parser and their bundled dependencies with licenses), which
    `electron-builder.yml` copies to `resources/THIRD_PARTY_NOTICES.md` in the installer.
  - **Islamic holidays: `Intl`, no dependency** (`packages/core/src/holidays.ts`). `Intl.DateTimeFormat('en-u-ca-islamic-umalqura')` in UTC on the civil day, falling back
    to `islamic-civil`, and to "no Islamic holidays" when neither resolves (a runtime without the calendar silently formats Gregorian, so `resolvedOptions().calendar`
    is checked). Node 24 (ICU 78) and Chromium (so Electron 44 and the web build, checked in Chromium) have it. Holidays: Islamic New Year (1 Muharram), Ashura (10 Muharram),
    Mawlid (12 Rabi' al-awwal), Isra and Mi'raj (27 Rajab), Ramadan (1 Ramadan, the whole month as a run), Laylat al-Qadr (27 Ramadan, labelled "likely"), Eid al-Fitr (1 Shawwal,
    one day), Day of Arafah (9 Dhu al-Hijjah), Eid al-Adha (10 Dhu al-Hijjah). Hijri days start at sunset, the calendar day here is the civil one, so Laylat al-Qadr
    (the night of the 27th, which begins on the evening of the 26th) is shown on the 27th as most printed calendars do.
  - **Verification.** The computed dates match R.H. van Gent's published Umm al-Qura table (Utrecht University, webspace.science.uu.nl/~gent0113/islam/ummalqura_principal.htm)
    for 1 Muharram, 12 Rabi' al-awwal, 1 Ramadan, 1 Shawwal and 10 Dhu al-Hijjah in 1446 to 1449 AH, and the other days against ummalquracalendar.org and hijria.com
    (`packages/core/test-vectors/islamic-holidays.json`, 24 dates and both Ramadan lengths: 30 days in 1447 AH, 29 in 1448 AH). These are the astronomical Saudi dates.
  - **The adjustment.** Tunisia, like most countries, starts months by local moon sighting, so Eid can be a day off Umm al-Qura. `hijri_offset_days` shifts every Hijri-derived date:
    the date shown for day D is the computed Hijri date of D minus the offset (so +1 moves 1 Muharram one civil day later). `date-holidays` has no such option and its own Hijri
    table is fixed, so the app shifts the library's answer for every holiday whose rule is Hijri-dated (`parseHijriRule` reads '10 Dhu al-Hijjah', '1 Shawwal P3D', ...); a
    "if Sunday then next Monday" substitute rule is not re-applied after the shift (it only matters to countries whose weekend is not Friday and Saturday). The Settings
    stepper shows the next Ramadan start live ("Mon, Feb 8, 2027 (1448 AH)") so it can be checked against the announced date before saving.
  - **Merging.** A country holiday that is the same Hijri day as an Islamic one (the Eids, Islamic New Year, Mawlid, ... all count) becomes one entry: religious style, tagged "Public
    holiday" (flag beside the mosque), on the computed day, as long as the country's own span (Eid al-Fitr is 3 days in the UAE). They merge when within two days of each other: the
    library's own Hijri table matches the runtime's from 2024 to 2029 (a test walks Tunisia's six years) and differs by a day on a few dates from 2030, which would otherwise show twice.
    With Islamic holidays off, a country's Hijri-dated holidays still show, as plain public holidays, with the adjustment applied.
  - **Calendar.** `useHolidays(range)` merges the computed Islamic holidays with the lazily loaded country list (the last list stays on screen while paging to another year; a failed load shows
    one line and the Islamic ones still show). Holidays are all-day FullCalendar events, so Week gets an all-day row only when the visible days have one (it was off before), Month gets chips
    in the cell, and a multi-day holiday is one bar. A click on one opens nothing. Ramadan is a chip on its first day ("Ramadan begins") and each of its days gets a faint green wash
    (`.stretch-day`, a colour like `.mode-day`, which can share the day) and "Ramadan 12" beside the date, so it does not take a row in every week. The Agenda lists a holiday's day even
    when nothing rings (like cheat and mode days), as a tinted note under the day heading with the icon, and says "Ramadan, day 12 of 30" on the days inside the run.
  - **Colors and icons.** New tokens `--hol-public-*` (amber, hue 75 to 85) and `--hol-religious-*` (green, hue 165) in `index.css`, light and dark, outside the picker palette and the `--cat-*` family:
    a flat tinted chip with a thin outline (the categories have a heavy left edge, the prayers are outlined in the foreground colour). A flag icon for a public holiday, a mosque for an Islamic
    one, both for a merged one (the prayers keep the moon and star). Contrast (WCAG, computed from the oklch values): ink on the chip fill 9.2 (public) / 9.0 (religious) in light, 11.2 / 11.4 in dark;
    accent edge and icon against the page 3.7 / 4.0 in light, 9.8 / 9.1 in dark, against the chip fill 3.4 / 3.6 in light, 6.8 / 6.3 in dark.
  - **Settings.** A "Holidays" section: a searchable shadcn combobox of "None" plus the 207 countries (the list loads the first time it opens; until then it holds None and the chosen country,
    named through `Intl.DisplayNames`), an "Islamic holidays" switch (disabled with a note when the runtime has no Hijri calendar), and the stepper, which only appears when something Hijri-dated shows.
    All three save with the page's Save button through the existing `updateSettings` UPDATE (never an upsert), and `realtime-handlers.ts` reads them from a settings change.
  - **Electron.** `desktop-payloads.ts` declares the three fields optional with `.catch(undefined)` (a malformed value reads as absent and never rejects a push); main never uses them.
  - **Modes.** The Ramadan mode's Planned dates has a "Use Ramadan 1448 dates" button that fills the two date pickers from the Hijri calendar (with the adjustment); the person still reviews and adds.
    It names the Hijri year instead of "this year" because the next Ramadan is often in the following calendar year.
  - **Known limits.** Eid al-Fitr and Eid al-Adha are one day (Tunisia gives more days off; the library lists one for Tunisia and the owner asked for one). Regional holidays are not shown. The
    library's data is community-maintained and licensed CC-BY-3.0. Public holiday dates that depend on a decree (Tunisia sometimes moves a bridge day) are not in it.
