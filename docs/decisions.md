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
