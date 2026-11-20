# alarm-cal commands

Add `--json` to any command for one JSON document (errors too). Without it you get text. `alarm-cal help <command>` shows every option; `alarm-cal help --json` is the machine-readable version.

## Account

| Command | What it does |
|---|---|
| `login --email X` | Sends a sign-in code to the owner's email. |
| `login --email X --code 12345678` | Verifies the code and saves the session (it refreshes itself). |
| `whoami` | Account and timezone. Exit 3 if not signed in. |
| `logout` | Revokes and deletes the saved session. |
| `config show` / `config set url\|key <value>` | Where the Supabase URL and publishable key come from. Inside the repository they are read from `app/.env` automatically. |

## Read

| Command | What it shows |
|---|---|
| `events list [--all] [--key-prefix workout/]` | Alarms with key, schedule, next ring. `--all` includes switched-off ones. |
| `events get <id\|key>` | One alarm in full, its `spec` (plan vocabulary) and its mode rules. |
| `occurrences [--from D] [--to D] [--key-prefix P] [--include-prayers]` | Every ring in a range (default: next 7 days) with `paused`, `shifted`, `silenced_by_cheat_day` and the mode segments. A date `--to` includes the whole day. |
| `modes list` | Modes, their rules per alarm, running and planned activations, what is in effect now. |
| `exams list [--all]` | Exams and their upcoming revision sessions. |
| `settings get` | The settings row and the fields you may change. |
| `stats` | Habit scores, tiers, streaks. The Prayer habit also carries `prayer_timings` (on time, late, qada, open qada). |
| `prayers [--date D] [--days N]` | Each prayer's `prayer_day`, time, when its window ends and its status: on time, late, qada (made up), missed, open (still inside its time) or to come. `--date` is a prayer-day. |
| `qada list` | The prayers of the last 28 days whose time ran out with no record: the ones that can still be made up. Each has a `prayer_day`. |
| `passes` | Pass wallet and cheat days. |
| `history [--limit N]` | The local undo journal. |

## Write (all journalled, all undoable)

| Command | What it does |
|---|---|
| `events add --title T --time HH:mm [--days mon,wed] [--repeat daily] [--start D] [--duration 45m] [--key ns/slug] [--no-passable] ...` | Creates an alarm. `--at "2026-11-20 09:15"` is a one-time alarm. |
| `events update <ref> [same flags]` | Changes only the flags given. `--ends none`, `--notes ""`, `--color none` clear a field. `--key` assigns or renames the key. |
| `events disable <ref...>` / `--key-prefix P` | Switches alarms off (soft delete). |
| `events enable <ref...>` / `--key-prefix P` | Switches them back on. |
| `modes rule set <mode> <event> keep\|skip\|inherit\|shift <±min>\|shorten <min>` | One alarm's behaviour under a mode. |
| `modes switch <mode> [--since today\|ISO] [--until D] [--open]` | Switches a mode on now (sick day: `--since today`). Ends the previous manual mode. |
| `modes normal` | Ends the manual mode. A planned range or exam window can still apply. |
| `modes range add <mode> --from D --to D` / `range remove <id>` | Plans a mode for whole days (both ends included). |
| `exams add --title T --date D [--time HH:mm] [--difficulty easy\|normal\|hard] [--session-time HH:mm] [--session-minutes N] [--lead N] [--key K]` | Creates an exam, its alarm and its revision sessions. |
| `exams update <ref> [flags]` / `exams remove <ref>` | Regenerates the future alarms by diff / removes the exam and switches its alarms off. |
| `settings set <field> <value> [<field> <value> ...]` | Writable settings only (see `settings get`). `prayers_enabled` switches the ten prayer alarms. |
| `qada done <prayer> --date D` | `D` is the `prayer_day` that `prayers` and `qada list` print (an Isha after midnight belongs to the evening before, not to the clock date of its time). Records a missed prayer as made up (a completion done now). Refused for a prayer still inside its time, one that already has a record, one older than 28 days. Undo deletes the row. |
| `plan check\|diff\|apply <file\|->` | Declarative alarms; `-` reads the plan from standard input. |
| `undo [--steps N]` | Reverts the last N changes, newest first. Undoing a create switches the alarm off. |

`<ref>` is an alarm id, an 8+ character id prefix, or an agent key. `<mode>` is `exam`, `ramadan`, `vacation`, `sick`, a custom mode name, or an id.

## Exit codes

0 ok, 1 internal, 2 usage, 3 not signed in / not configured, 4 not found or ambiguous, 5 invalid input or plan (nothing written), 6 conflict, 7 server, network, permission or missing migration.
