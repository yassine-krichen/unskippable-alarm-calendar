# Plan format

A plan is one JSON file. `alarm-cal schema plan` (or `cli/plan.schema.json` in the repository) is the JSON Schema; `alarm-cal plan check` reports every problem with its path. Examples next to this file: `workout.plan.json`, `medication.plan.json`, `study.plan.json`, `birthdays.plan.json`.

```json
{
  "namespace": "workout",
  "prune": true,
  "items": {
    "workout/push-day": { "title": "Push day", "time": "07:30", "days": ["mon", "thu"], "duration": "1h",
                           "modes": { "sick": "skip", "exam": { "shorten": 30 } } }
  }
}
```

## Top level

| Field | Meaning |
|---|---|
| `namespace` | Lowercase letters, digits, `_ . -`. Every item key must start with `<namespace>/`. |
| `prune` | `true` switches off active alarms in this namespace that are not in the plan. Default `false`. Nothing is ever deleted, and other namespaces and alarms without a key are never touched. |
| `items` | Object keyed by agent key (lowercase letters, digits, `/ _ . -`, up to 100 characters). |

## An item (an alarm)

| Field | Meaning |
|---|---|
| `title` | Required, 1 to 120 characters. |
| `time` | Required, 24-hour `HH:mm` in the owner's timezone. A time inside a spring-forward gap rings an hour later that day, as in the app. |
| `duration` | Calendar block: minutes (1 to 1440) or text `"45m"`, `"1h"`, `"1h30m"`. Default 15. |
| `days` | Weekdays it rings on: `["mon","wed","fri"]`, or `"weekdays"` / `"weekends"`. Implies a weekly repeat. |
| `repeat` | `"none"`, `"every-12-hours"`, `"daily"`, `"every-2-days"`, `"every-3-days"`, `"weekly"`, `"monthly"`, `"yearly"`, or `{ "every": 2, "unit": "week" }` (units: hour, day, week, month, year). Omit for a one-time alarm. With `days` only `"weekly"` or a week unit fits. |
| `start` | First date `yyyy-MM-dd`, or the date of a one-time alarm. Default: today for a repeating alarm, the next time `time` comes round for a one-time alarm. An existing alarm keeps its start date, so applying again never moves it. If the start day is not one of `days`, the series starts on the first listed day after it. |
| `ends` | Last date (inclusive) of a repeating alarm, or `null`. |
| `notes` | Text up to 2000 characters, or `null`. |
| `maxSnoozes` | 0 to 10 (0 hides the snooze button). Default 3. |
| `snoozeMinutes` | 1 to 120. Default 5. |
| `passable` | Default `true`. `false` for medication: no pass and no mode can silence it. |
| `color` | `red`, `orange`, `yellow`, `green`, `blue`, `violet`, `pink`, or `null`. |
| `showInCalendar` | `false` keeps it off the calendar; it still rings and counts in habits. Default `true`. |
| `enabled` | `false` keeps the alarm switched off (and switches it off if it exists). Default `true`. |
| `modes` | What this alarm does under a mode (below). |

An item describes the whole alarm: a field you leave out goes back to its default on the next apply. Anything you changed in the app on a plan-managed alarm is reset to the plan the next time the plan is applied; tell the owner if they might edit it there.

## `modes`

Keys: `exam`, `ramadan`, `vacation`, `sick`, or the name of a custom mode (it must exist; the CLI does not create custom modes).

| Value | Effect while the mode is in effect |
|---|---|
| `"keep"` | Rings as usual (use it to exempt an alarm from a mode whose default is `skip`). |
| `"skip"` | Paused: does not ring, not scored. Only for passable alarms. |
| `{ "shift": -60 }` | Rings that many minutes later (negative: earlier), at most 720. Never moved to before the mode began. |
| `{ "shorten": 30 }` | The calendar block is 30 minutes long; it still rings. |
| `"inherit"` | Remove this alarm's own rule; the mode default applies. |

Modes not listed in `modes` keep whatever rule they already have.

## What apply does

`plan diff` and `plan apply` match items to alarms by `agent_key`:

- no alarm with the key: create it;
- an alarm with the key that differs: update only the changed columns, same id (completions and habit history stay attached);
- an alarm with the key that was switched off: switch it on again and update it;
- identical: leave it alone;
- rules: created, replaced or removed to match `modes`.

The diff lists, per alarm, `create`, `update`, `enable`, `disable` or `unchanged`, the field-level changes in this same vocabulary (`time: "07:30" -> "08:00"`), and the rule changes.
