# Roadmap v2: smart calendar

Agreed with the owner on 2026-10-06, based on the concept doc "smart-calendar-concept.md". Single user, no leaderboards. Every reminder is a normal alarm (no softer "nudge" level). Pre-prayer and birthday-prep reminders are separate alarms.

Each phase ends with tests green, a code review, and a commit. Android work waited for the SDK and a real device; the SDK is there since 2026-10-13 and the native engine (spec build-order step 3, stage 1) is built against the precomputed schedule, verified on an emulator, with the phone check and the app wiring (step 6) still to do. The phase that changes the adapter contract (phase 3) keeps the Android side simple on purpose.

## Phase 0: alarm pop-up polish

- The Electron alarm window becomes a centered panel, not a full-screen layer. It stays always-on-top, can't be minimized, and is re-fronted like today.
- Window opacity is about 70%, so whatever is behind it (a call, a demo) stays visible through it.
- The Snooze button's icon and label are centered. The label is shortened so it fits, e.g. "Snooze 5 min · 2 left".
- Accept: the window is centered on the display that has the cursor or the primary display, opacity is about 0.7, the step-4 guarantees still hold, and the button is visually centered.

## Phase 1: habits and ranks

- Only recurring events count as habits; one-off events are not scored.
- Outcome per past occurrence:
  - done (with its snoozes),
  - missed (past the grace window with no completion),
  - excused (a cheat day on a passable event),
  - pending (not yet due, or still inside grace).
- Score per habit, computed in `packages/core`:
  - Each habit has its own window: `max(28 days, 5 × its nominal repeat period)`, capped at 180 days, so slow habits (weekly, monthly) can be ranked. Nominal period: hour = interval hours; day = interval days; week = interval × 7 days divided by the number of weekdays chosen; month = interval × 30 days. A weekly habit gets 35 days, a monthly one 150, every 2 months or slower 180.
  - Recency weight is `w = 0.5^(daysAgo / (window / 2))`, so the half-life is 14 days for the 28-day window.
  - Done credit is `max(0.5, 1 - 0.1 * snoozes)`. A miss weighs `λ = 2`.
  - `score = 100 * Σ w·credit / Σ w·(done ? 1 : λ)`. Excused and pending occurrences are left out.
  - Fewer than 5 scored occurrences (done or missed) in the window means "Unranked". That is also how inactivity decays a rank.
- Tiers:

  | Tier | Score |
  |---|---|
  | Bronze | < 40 |
  | Silver | 40–59 |
  | Gold | 60–74 |
  | Platinum | 75–89 |
  | Diamond | ≥ 90 |

- Streaks use the same per-habit window: current and best run of consecutive done occurrences. An excused occurrence keeps a run alive but does not add to it, so cheat days cannot inflate a streak; a miss resets it. Pending occurrences are skipped. The UI labels the best run "Best in N weeks", because it only sees the window.
- Overall score: pooled over the ranked habits as `100 × ΣN / ΣD`, where N and D are each habit's weighted credit and weighted possible total (the numerator and denominator of its score, using its own weights). Unranked habits are left out. A habit with more recent scored occurrences therefore counts for more.
- Scoring starts at `max(window start, event.created_at)`: occurrences before the alarm existed are neither done nor missed, so a habit created today with a start date last week is not charged for last week. `events.created_at` is set by the database (migration `events_created_at`, existing rows backfilled with `least(start_at, now())`) and a trigger pins it, since clients hold table-wide write access to `events`.
- A skipped_cheat completion excuses an occurrence only for a passable event, like a cheat day.
- Data: the app bulk-loads the last 28 days of completions (explicit columns, paged; hitting the page cap with a full last page is a failed read, never a truncated list). Habits whose window is longer get one extra read (`event_id in (...)`, rows older than the bulk range, back to the longest of their windows), so a fast habit such as an hourly one never pulls 180 days. The history loads after the app is ready, so startup and the alarm schedule push never wait for it, and reloads when a slow habit is added or its window changes. The store records which window each slow habit was loaded for; a habit whose window is not covered is shown as loading or unavailable (with a retry), never scored. Realtime changes that arrive during a load are replayed over its result, and each row is pruned by its own habit's window. The 3-day list sent to the alarm engine is unchanged.
- UI: a Stats screen with a tier badge, score, done/missed/excused counts and streaks per habit, plus the pooled overall score. The tier badge also shows on the event sheet.
- Known limit: editing a series recomputes its past occurrences with the new rule (spec §4 "applies going forward"). Scores near an edit can shift.

## Phase 2: yearly repeat and relationship reminders

Built on branch `v2-overnight`, not yet pushed or released. Needs the two migrations `20261006010617_repeat_unit_year` and `20261006010618_events_group_id` pushed to the database before the app can save a yearly alarm or a birthday.

- New `repeat_unit` value `year`. Same month and day as `start_at`, every N years, wall-clock in the user's zone. Feb 29 lands on Feb 28 in non-leap years, clamped from the original date each year (so it returns to Feb 29 in leap years). Shared vectors in `recurrence.json`; habit nominal period is `interval × 365` days, so a yearly habit has the 180-day window and is almost always "Unranked". The repeat picker has an "Every year" preset and a custom unit "years".
- "Birthday / anniversary" template, a second tab at the top of the New alarm sheet (Alarm | Birthday / anniversary). Fields: kind (birthday or anniversary), person, month and day, optional year, one alarm time, gift ideas. Saving writes two yearly alarms in one insert, linked by the new nullable `events.group_id`:
  - prep, 7 days before: "Prep for <name>'s birthday", notes = the gift ideas;
  - wish, on the day: "Wish <name> a happy birthday".
  - Both use a plain alarm's defaults (snooze 3 times, 5 minutes) and both stay passable: a cheat day can skip them, since a missed birthday wish is not a missed medication. Change a row's switch elsewhere and edits keep it.
- Editing: any alarm with a `group_id` and a template-shaped partner opens the template form and saves both (name, date, time and gift changes propagate; per-alarm snooze, color, cheat-day switch and duration are kept). Delete asks "Delete both alarms?". An alarm whose partner is gone opens the normal form.
- Known limits: the prep date is fixed in the start year, so across a 29 February it is one day more or fewer than 7 days ahead in some years (a Feb 29 birthday preps on Feb 22 every year, 6 days before the Feb 28 wish in common years; a Mar 3 birthday preps 8 days ahead in leap years). A group edit is two update requests, so a failure on the second leaves the first applied; saving again repairs it. The year field is remembered only through the start year of the series, and a typed year equal to the one the app would pick anyway shows as empty when reopened.

## Phase 3: precomputed schedule and salat

### 3a: precomputed schedule (done on branch `v2-overnight`, not yet pushed or released)

- Adapter contract change: `packages/core` expands concrete occurrences for the next 60 days (`expandSchedule`, `buildSchedulePayload` in `schedule.ts`) and pushes that list to the adapters (`SchedulePayload` version 2, spec section 2). Electron still runs its scheduler, but from the list. Android then needs almost no logic.
- The list is re-pushed on every change, on launch and focus, and once a day while running. Electron main also keeps the events, cheat days and settings it was last given and re-expands the list itself when under 7 days of horizon remain and at least daily, so a closed or crashed window does not run the alarms dry.
- Caps: 1500 occurrences per event, 5000 in all; a cap shortens `horizonEnd` instead of silently dropping the tail. Details in `docs/decisions.md`.
- Electron cache is `version: 2` (migrated from 1 on load); a version 1 push from an older renderer is still accepted.
- For salat (3b): prayer times become another occurrence source inside `expandSchedule`, with `passable: false` (so a cheat day never silences them), a sound id for the user-chosen file, and snooze rules from settings (default off). The engines need only one small addition (the pre-prayer text, see 3b).

### 3b: salat (done on branch `v2-overnight`, not yet pushed or released)

Needs migration `20261006042009_prayer_times` pushed (`supabase db push`) before the app can load: it selects the new `events.kind`, `events.prayer` and settings columns. Built as specified below, with these changes made while building (details in `docs/decisions.md`):

- The "You haven't logged ..." text cannot be fixed when the list is built: the list would be stale by the time the reminder rings. An occurrence can carry `labelIfUnlogged` (a text plus the id of the previous prayer's occurrence) and the engine picks at ring time.
- A prayer completion matches by event and prayer-day, not by exact instant, so changing an offset or the location does not orphan "prayed". Latitude is limited to 65 degrees. This is the one new thing an engine must do for prayers.
- For the Fajr reminder's missed-previous text, the wording is "its time ended at sunrise" instead of "you have until Dhuhr", because Fajr is over long before Dhuhr.
- Prayer settings are on `settings` (location, angles, Asr factor, five offsets, reminder lead, snooze count and length, `prayers_enabled`, `prayers_enabled_since`); the 10 rows in `events` are created and switched by the `set_prayers_enabled` RPC.
- Calendar shows the five prayers, outlined with a moon icon, and hides the reminders. Prayer rows open a short summary with a link to Settings, not the event form. (Since the feedback round below the prayers are hidden from the calendar by default; a Settings switch shows them.)

Original plan:

- Prayer times use the `adhan` library (offline). Its Kotlin twin exists for Android.
  - Defaults for Tunis/Ariana: Fajr 18°, Isha 18° (the Tunisian ministry convention), Asr shadow factor 1 (Maliki), location Ariana (about 36.86 N, 10.19 E).
  - Method, location and per-prayer minute offsets are editable in Settings.
- Five prayer alarms a day. They are never silenced by a cheat day. Done means prayed, and Snooze is configurable (default off).
- Pre-prayer alarm 15 minutes before each prayer. If the previous prayer has no Done, it says "You haven't logged Dhuhr, you have until Asr".
- Prayer sound: a user-chosen audio file (for example a takbir recording), because no bundled recording is shipped. It falls back to a bundled tone.

## Phase 4: exams and revision (done on branch `v2-overnight`, not yet pushed or released)

Needs migration `20261006050221_exams_and_revision` pushed (after `20261006010617`, `20261006010618` and `20261006042009`); the app selects the new `events` columns and the `exams` table. Built as specified below; details and the reasons for the choices are in `docs/decisions.md`.

- Exam entity: title, date and time, difficulty from 1 to 3 (table `exams`, soft delete with `active`, realtime).
- Revision sessions are generated backwards from the exam date: 7, 3 and 1 days before, plus 14 days before for difficulty 3. Each one is a one-off alarm event (`kind = 'normal'`, no repeat) linked to the exam by `events.exam_id`, at a time of day chosen in the form (default 18:00, in the settings zone). Sessions already in the past when the exam is created are skipped. Pure planning in `packages/core/src/exams.ts` (`planRevisionSessions`, `planCatchUp`, `planCatchUps`, `classifySession`, `examProgress`).
- The exam itself is an alarm too (`exam_role = 'exam'`), by default 60 minutes before the start (the form's "Exam alarm" field), not passable.
- A missed session (past its grace window, with no completion, not silenced by a cheat day) gets one catch-up session halfway between now and the exam, rounded to a quarter hour and moved to the nearest slot in 08:00 to 21:00 local time, at least 30 minutes ahead and 1 hour before the exam, only while 3 hours or more remain. A catch-up never spawns another. One per missed session, kept by the unique index on `events.catch_up_of` (the app inserts with `ON CONFLICT (catch_up_of) DO NOTHING`), so two devices cannot both add one.
- UI: an "Exam" tab in the New alarm sheet next to Birthday / anniversary, an Exams screen (graduation cap in the header) with done / to go / missed per exam, and edit and delete. Editing regenerates the sessions still to come and keeps the finished ones; deleting switches off every alarm of the exam. Sessions and exam alarms carry a book or graduation cap icon on the calendar and open the exam form when clicked.
- Habits: sessions are one-off, so they are never scored.

## Phase 5: modes (done on branch `v2-overnight`, not yet pushed or released)

Needs migration `20261006153533_modes` pushed (after `20261006050221`); the app selects the three new tables and `settings.exam_mode_days_before`. Built as specified below, with the choices and deviations listed in `docs/decisions.md`.

- Built-in modes: Normal (no row, the default), Exam, Ramadan, Vacation, Sick, plus custom ones. The four built-ins are created by the RPC `ensure_builtin_modes()`.
- Per-habit rule for each mode: keep, skip (paused, not scored), shift (rings N minutes earlier or later, up to 12 hours), or shorten (the calendar block only). "Replace with another event" was dropped: it is a skip plus an ordinary alarm, which the person can already make.
- Activation:
  - a **manual switch** in the header (a chip and a dialog), open-ended until switched back (for example on a sick day) or until the end of a chosen day, starting now or "since this morning",
  - or a planned date range (Modes screen),
  - Exam mode auto-activates `settings.exam_mode_days_before` days (default 10, 0 = off) before each exam and ends with the day after it. The window is derived from the exams, never stored, so editing an exam moves it.
  - One mode at any instant: manual beats range beats exam; among equals the one that started last wins.
- Sick (and Vacation) skip every passable alarm by default. A non-passable alarm (medication, the alarm before an exam) is never paused, by a default or by a rule; an explicit rule may still shift or shorten it. Prayers and their reminders are never changed by a mode.
- Paused occurrences are excluded from scoring, like excused ones (a streak is kept alive, not extended), and an exam session a mode paused counts as skipped, so it gets no catch-up.
- Modes are applied while occurrences are computed (schedule list, calendar, habit scoring), so the engines need no mode logic: a paused occurrence is left out of the list, a shifted one is listed at its new time. Electron's own refill applies the modes too (they ride along in `refillSource`).
- UI: mode chip and dialog in the header, a Modes screen (list, per-alarm rules, planned dates, the exam lead), paused alarms greyed and struck through with the mode's name, days under a mode tinted and labelled, and a "Paused" count and legend on the Stats screen.

## Feedback round 1 (2026-10-06): habits, prayers and colors

Owner feedback after the first run of phases 0 to 5. Needs migration `20261006173000_show_in_calendar` pushed (after `20261006153533`); the app selects the two new columns. Choices and reasons in `docs/decisions.md`.

- **No ranks for birthdays.** Every yearly alarm and anything made by the birthday template (`group_id`) is not a habit: not scored, not on Stats, no tier badge in the sheet. A rank needs 5 occurrences, so a yearly alarm could never be ranked in a useful time anyway.
- **One Prayer habit.** The five prayers are one "Prayer" entry on Stats: counts and weighted credit summed (the pooled score), a streak counted in prayer-days, and the combined rank on the prayer sheet. A prayer-day is done when every prayer that day is done; one missed prayer makes it missed and resets the streak; today stays open until all of today's prayers have come. It is ranked once 5 prayer-days are scored. The overall score counts Prayer once, with its pooled numerator and denominator.
- **Hiding alarms from the calendar.** `settings.show_prayers_in_calendar` (default false, Settings, Prayer times) and `events.show_in_calendar` (default true, a "Show in calendar" switch on the alarm, birthday and exam forms). Week, Month and Agenda leave hidden alarms out; a "Show hidden" toggle in the calendar toolbar (kept per device) brings them back faded with an eye-off icon. Presentation only: hidden alarms ring, can be snoozed and done, and count in habit scores.
- **Fixed category colors.** Birthday / anniversary (rose), exam alarm (solid indigo), revision sessions (soft indigo tint) and catch-ups (the same tint, outlined) have fixed colors in CSS tokens for light and dark (`--cat-*` in `app/src/index.css`), outside the picker palette, applied on the calendar, Agenda and Exams screen. The color picker is not offered for them.

## Feedback round 2 (2026-10-12): holidays

Owner request: show Tunisian holidays on the calendar (any country if it can be chosen), and the Islamic ones. Needs migration `20261012090000_holidays` pushed (after `20261006173000`); the app selects the three new settings columns. Choices, sources and limits in `docs/decisions.md`.

- Display only: never an alarm, not in the schedule list, not a habit. Week (an all-day row that appears when a holiday is in view), Month (cell chips) and Agenda (a note under the day heading; a quiet day with a holiday is listed).
- Settings, "Holidays": a searchable country picker (None plus 207 countries, from `date-holidays`, loaded lazily so the main bundle stays small), an "Islamic holidays" switch, and a Hijri date adjustment of -2 to +2 days because Tunisia sights the moon locally.
- Islamic holidays come from `Intl` (Umm al-Qura), checked against published tables for 1446 to 1449 AH. Ramadan is a faint green run with its first day chipped; Eid dates the country also gives off are merged into one "Public holiday" entry.
- The Ramadan mode can fill its planned dates from the computed Ramadan.

## Deferred

- Leaderboards and anything social.
- Calendar import (Google, CalDAV).
