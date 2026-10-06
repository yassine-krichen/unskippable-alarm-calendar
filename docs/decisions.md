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
