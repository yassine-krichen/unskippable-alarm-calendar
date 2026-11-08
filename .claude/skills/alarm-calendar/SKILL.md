---
name: alarm-calendar
description: Read and change the owner's unskippable alarm calendar through the `alarm-cal` CLI. Use whenever the owner wants alarms, routines, workouts, medication, study blocks, exams or birthdays set up, changed, paused or removed in the calendar; wants a document of theirs (a workout plan, a medication schedule, a study timetable, a syllabus) turned into alarms; wants to disable or lower something on sick days, holidays, exam weeks or Ramadan; or asks what rings when, what is scheduled, or how their habits are doing. Also use to undo a calendar change.
---

# Alarm calendar

You drive the owner's alarm calendar with the `alarm-cal` command. The owner's job is deciding what the day should look like; yours is the tedious translation of that into alarms, modes and rules. Changes apply immediately, every one is journalled, and `alarm-cal undo` reverts it.

Run `alarm-cal help --json` once if you need the exact options of a command; `alarm-cal schema plan` prints the JSON Schema of a plan. Details are in `references/commands.md` and `references/plan-format.md`; ready-made plans are `references/*.plan.json`.

## Before you touch anything

1. `alarm-cal whoami`. Exit 3 means not signed in. Signing in needs a code emailed to the owner, so ask them to run `alarm-cal login` themselves (or to paste the digits: `alarm-cal login --email <their email> --code <digits>`). Never try to read their mailbox.
2. If `alarm-cal` is not found, the CLI is not on PATH: from the personal root run `task alarm-calendar:cli:install` once, or call `task alarm-calendar:cli -- <args>`.
3. Learn the current state, always with `--json` so you can read it exactly:
   - `alarm-cal settings get --json` (timezone, prayers, grace)
   - `alarm-cal events list --all --json` (what already exists, with `agent_key`s)
   - `alarm-cal modes list --json` (modes, their rules, what is switched on now)

All times you read or write are wall-clock times in the owner's timezone (`settings.timezone`). Output shows the local time and the ISO instant side by side; do not convert zones yourself.

## Turning a document into alarms

1. Read the owner's document. Extract, per activity: what, which weekdays or dates, what time, how long, how strict it is (can it ever be skipped?), what changes in special periods.
2. Decide the structure and say it back in chat when anything is ambiguous or the plan is large (more than about ten alarms, or anything that replaces existing alarms). Ask about gaps instead of guessing a time. The CLI applies directly, so the conversation is the only confirmation step.
3. Write a plan file (JSON) with a `namespace` per topic (`workout`, `meds`, `study`, `exams`, `birthdays`) and one item per alarm keyed `<namespace>/<slug>`. Start from the matching example in `references/`.
4. `alarm-cal plan check plan.json --json`. Fix every reported problem; read the warnings (a `skip` rule on a non-passable alarm does nothing).
5. `alarm-cal plan diff plan.json` and read what it will create, change and switch off. If it touches alarms you did not expect, stop and check with the owner.
6. `alarm-cal plan apply plan.json`. Show the owner the diff it printed and tell them they can say "undo that" (`alarm-cal undo`).
7. Verify with `alarm-cal occurrences --from <date> --to <date>` for the next week.

Applying is idempotent: the same plan twice changes nothing the second time. Re-run it after every edit of the plan. With `"prune": true`, alarms of that namespace that are no longer in the plan are switched off, never deleted.

## Rules that matter

- **Use keys.** Everything you create gets an `agent_key`, so you can find it again and update it in place instead of making a duplicate. You may change or disable any alarm, including the ones the owner made in the app: give it a key with `alarm-cal events update <id> --key ns/slug` first if you want to manage it from a plan.
- **Deletes are soft.** "Delete" means `events disable`; the alarm can come back with `events enable`.
- **Prayers are settings, never alarms.** Do not create prayer alarms. Prayer times, offsets and the on/off switch are `alarm-cal settings set ...` (`prayers_enabled`, `latitude`, `longitude`, `fajr_angle`, ...). Prayers and their reminders ignore modes and passes.
- **Non-passable alarms always ring.** `passable: false` means neither a cheat-day pass nor a mode can silence it. Use it for medication and anything safety-relevant. A `skip` rule on such an alarm does nothing; a `shift` or `shorten` rule still applies.
- **Be strict by default only where it matters.** Everything else stays passable so the owner can use a pass.
- **Exams have their own command.** `alarm-cal exams add --title ... --date ... --difficulty hard` plans the exam alarm and the revision sessions the way the app does. Do not hand-build those alarms in a plan. Exam mode switches itself on `exam_mode_days_before` days ahead.
- **Birthdays and anniversaries** follow the app's template: two yearly alarms, a prep alarm 7 days before titled `Prep for <Name>'s birthday` (gift ideas in the notes) and a wish alarm on the day titled `Wish <Name> a happy birthday`, both at 09:00 unless told otherwise. See `references/birthdays.plan.json`. Pairs made by the CLI are two plain yearly alarms; the app cannot edit them together as it does its own template pairs, so mention that and manage both from the plan.
- **Never touch secrets.** Do not read `app/.env`, and never ask for or use a Supabase secret or service-role key. The CLI uses the publishable key and the owner's own sign-in.
- **No hype in alarm text.** Titles say what to do; notes carry the details from the document.

## Sick days, holidays, exam weeks, Ramadan

Modes change how alarms behave without editing them. Each mode has a default (Sick and Vacation skip every passable alarm, Exam and Ramadan keep everything) and per-alarm rules: `keep`, `skip`, `shift <±minutes>` (max 12 h), `shorten <minutes>` (a shorter calendar block; it still rings).

- **The owner is sick today:** `alarm-cal modes switch sick --since today --until <last day>` (omit `--until` to stay on until `alarm-cal modes normal`). Passable alarms are paused and not counted against their habit score; medication keeps ringing. To check: `alarm-cal occurrences --to <date>`.
- **Lower or disable the workout when sick:** put `"sick": "skip"` in each workout item's `modes` (best, it survives plan re-applies), or `alarm-cal modes rule set sick workout/push-day skip`. `shorten` only trims the calendar block and `shift` moves the ring; neither changes what the alarm says. A genuinely lighter session means a separate alarm (say `workout-light/push-day`) that you leave switched off and enable with `events enable` while the owner is ill.
- **Disable the whole workout:** `alarm-cal events disable --key-prefix workout/`; back on with `events enable --key-prefix workout/`. For a defined time frame use a range: `alarm-cal modes range add vacation --from 2026-12-20 --to 2027-01-03`.
- **Ramadan:** `shift` rules move alarms by minutes; plan the dates with `modes range add ramadan --from <date> --to <date>` (the app can fill the Hijri dates; ask the owner for the moon-sighting dates if it matters).

`alarm-cal modes switch ...` can start at most 7 days in the past and never in the future. A mode that is switched off in the app has no effect; say so if `modes list` shows `active: false`.

## Reading answers back

- What rings when: `alarm-cal occurrences --from 2026-11-09 --to 2026-11-15 --json` (paused, shifted and cheat-day effects are marked per ring).
- How habits are going: `alarm-cal stats --json`. Passes: `alarm-cal passes --json`.
- What changed recently: `alarm-cal history`; revert with `alarm-cal undo` (or `--steps 3`).

## Errors

With `--json`, errors are `{ "ok": false, "error": { "code", "message", "hint" } }` and the exit code says which kind: 2 usage, 3 not signed in, 4 not found or ambiguous, 5 invalid input or plan (nothing written), 6 conflict (key already used), 7 server or permission or missing migration. Exit 7 with code `migration_missing` means the owner has not pushed the `agent_keys` migration yet (`supabase db push`); you cannot do that for them. A half-finished command reports how many changes landed and `alarm-cal undo` reverts them.
