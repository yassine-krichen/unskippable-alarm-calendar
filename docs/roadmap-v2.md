# Roadmap v2: smart calendar

Agreed with the owner on 2026-10-06, based on the concept doc "smart-calendar-concept.md". Single user, no leaderboards. Every reminder is a normal alarm (no softer "nudge" level). Pre-prayer and birthday-prep reminders are separate alarms.

Each phase ends with tests green, a code review, and a commit. Android work stays blocked until the SDK and a real device are available. The phase that changes the adapter contract (phase 3) keeps the Android side simple on purpose.

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

- New `repeat_unit` value `year`. Feb 29 lands on Feb 28 in non-leap years, using the same clamping rule as months.
- "Birthday / anniversary" template: one form that creates two linked yearly alarms. One is 7 days before ("Prep for <name>", with gift-idea notes), the other is on the day ("Wish <name>").

## Phase 3: precomputed schedule and salat

- Adapter contract change: `packages/core` expands concrete occurrences for the next 60 days and pushes that list to the adapters. Electron still runs its scheduler, but from the list. Android then needs almost no logic.
- The list is re-pushed on every change, on launch and focus, and once a day while running.
- Prayer times use the `adhan` library (offline). Its Kotlin twin exists for Android.
  - Defaults for Tunis/Ariana: Fajr 18°, Isha 18° (the Tunisian ministry convention), Asr shadow factor 1 (Maliki), location Ariana (about 36.86 N, 10.19 E).
  - Method, location and per-prayer minute offsets are editable in Settings.
- Five prayer alarms a day. They are never silenced by a cheat day. Done means prayed, and Snooze is configurable (default off).
- Pre-prayer alarm 15 minutes before each prayer. If the previous prayer has no Done, it says "You haven't logged Dhuhr, you have until Asr".
- Prayer sound: a user-chosen audio file (for example a takbir recording), because no bundled recording is shipped. It falls back to a bundled tone.

## Phase 4: exams and revision

- Exam entity: title, date and time, difficulty from 1 to 3.
- Revision sessions are generated backwards from the exam date: 7, 3 and 1 days before, plus 14 days before for difficulty 3. Each one is a one-off alarm event linked to the exam.
- A missed session schedules one catch-up session halfway between now and the exam, if there is room.

## Phase 5: modes

- Built-in modes: Normal, Exam, Ramadan, Vacation, Sick, plus custom ones.
- Per-habit rule for each mode: keep, shift (new time), shorten, skip (paused, not scored), or replace with another event.
- Activation:
  - a **manual switch** in the header, open-ended until switched back (for example on a sick day),
  - or a date range,
  - Exam mode can auto-activate N days before an exam and end the day after.
- Sick mode defaults: everything paused except non-passable alarms (medication, prayers).
- Paused occurrences are excluded from scoring, like excused ones.

## Deferred

- Leaderboards and anything social.
- Calendar import (Google, CalDAV).
