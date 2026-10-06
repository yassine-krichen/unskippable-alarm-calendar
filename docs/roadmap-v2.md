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
  - The window is the last 28 days, with recency weight `w = 0.5^(daysAgo / 14)`.
  - Done credit is `max(0.5, 1 - 0.1 * snoozes)`. A miss weighs `λ = 2`.
  - `score = 100 * Σ w·credit / Σ w·(done ? 1 : λ)`. Excused and pending occurrences are left out.
  - Fewer than 5 scored occurrences in the window means "Unranked". That is also how inactivity decays a rank.
- Tiers:

  | Tier | Score |
  |---|---|
  | Bronze | < 40 |
  | Silver | 40–59 |
  | Gold | 60–74 |
  | Platinum | 75–89 |
  | Diamond | ≥ 90 |

- Streaks: current and best run of consecutive done or excused occurrences.
- UI: a Stats screen with a tier badge, score, done/missed/excused counts and streaks per habit, plus an overall score weighted by scheduled count. The tier badge also shows on the event sheet.
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
