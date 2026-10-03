-- Wallet hardening after code review (spec sections 3 and 7). The earlier
-- migrations are already applied and stay untouched; this one changes
-- privileges, constraints and the wallet functions.
--
-- B1  pass forging: settings.pass_cap was client-writable, and sync_wallet
--     granted ceil(days / 7) so cycling week_starts_on farmed ~1 pass a day.
-- S2  TRUNCATE / REFERENCES / TRIGGER were granted to client roles.
-- S3  timezone validation accepted POSIX-style zones such as 'UTC+5'.
-- M1  switching settings.timezone could refund today's cheat day or spend a
--     pass on yesterday.
-- M2  correction of a comment in the first migration, see the end of the file.

-- ---------------------------------------------------------------------------
-- S2: client roles get no TRUNCATE, REFERENCES or TRIGGER on any table.
-- ---------------------------------------------------------------------------

revoke truncate, references, trigger
on public.events, public.completions, public.settings, public.pass_wallet, public.cheat_days
from anon, authenticated;

-- ---------------------------------------------------------------------------
-- B1a: column-level privileges on settings.
-- pass_cap is not in any grant list, so a client can neither set it on insert
-- (it takes the default 2) nor update it. Clients must update settings with
-- UPDATE, not upsert: an upsert's ON CONFLICT DO UPDATE would touch user_id.
-- Delete is gone as well; the RPCs recreate a missing row (ensure_user_rows).
-- ---------------------------------------------------------------------------

revoke insert, update, delete on public.settings from authenticated;
grant insert (user_id, timezone, week_starts_on, refire_seconds, grace_minutes)
  on public.settings to authenticated;
grant update (timezone, week_starts_on, refire_seconds, grace_minutes)
  on public.settings to authenticated;
drop policy settings_delete on public.settings;

-- Belt and braces next to the privileges above. The cap is a fixed rule of the
-- product (spec section 7), the column only exists so a future version can vary it.
alter table public.settings
  add constraint settings_pass_cap_range check (pass_cap between 0 and 2);

-- ---------------------------------------------------------------------------
-- S3: only names that exist in the time zone database. `at time zone` also
-- accepts POSIX strings like 'UTC+5' (which means UTC-5), so it is not a check.
-- Same message as before so existing clients see the same error.
-- ---------------------------------------------------------------------------

create or replace function private.validate_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from pg_catalog.pg_timezone_names where name = new.timezone
  ) then
    raise exception 'time zone "%" not recognized', new.timezone
      using errcode = '22023';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- B1b + M1: the wallet keeps its own copy of timezone and week_starts_on.
--
-- All wallet math (week start, grants, "today" in use_pass / refund_pass) uses
-- this snapshot, never settings directly. pass_wallet has no client write
-- grants, so only the functions below change it. Settings reach the snapshot
-- in exactly two places, both inside private.sync_wallet:
--   1. once, when the wallet has never been anchored (anchored_at is null):
--      copy settings and set last_granted_week_start to the current week
--      start WITHOUT granting. This fixes new accounts, whose wallet is
--      created at signup with default UTC settings before the client sets
--      its real timezone, which used to produce a second pass.
--   2. at a grant boundary: apply the grants under the old snapshot, then
--      adopt the current settings.
-- Rows that exist today are backfilled as un-anchored (anchored_at null).
-- ---------------------------------------------------------------------------

alter table public.pass_wallet
  add column timezone text not null default 'UTC',
  add column week_starts_on integer not null default 0 check (week_starts_on between 0 and 6),
  add column anchored_at timestamptz;

create or replace function private.ensure_user_rows(p_user_id uuid, p_now timestamptz)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_settings public.settings;
begin
  insert into public.settings (user_id) values (p_user_id)
  on conflict (user_id) do nothing;

  select * into v_settings from public.settings where user_id = p_user_id;

  -- anchored_at stays null: the first sync re-anchors to the settings the
  -- client has by then.
  insert into public.pass_wallet (
    user_id, balance, last_granted_week_start, timezone, week_starts_on
  )
  values (
    p_user_id,
    1,
    private.week_start(p_now, v_settings.timezone, v_settings.week_starts_on),
    v_settings.timezone,
    v_settings.week_starts_on
  )
  on conflict (user_id) do nothing;
end;
$$;

-- Locks the wallet row until the end of the transaction, applies the weekly
-- grants, and returns the wallet. Callers inherit the lock.
--
-- Invariant: grants only come from whole 7-day steps between two week starts
-- of the same snapshot, and after adopting new settings the next grant is
-- never earlier than 7 days after the one just applied. So at most one grant
-- per 7 days, however often timezone or week_starts_on are changed.
create or replace function private.sync_wallet(p_user_id uuid, p_now timestamptz)
returns public.pass_wallet
language plpgsql
set search_path = ''
as $$
declare
  v_settings public.settings;
  v_wallet public.pass_wallet;
  v_current_week_start date;
  v_new_week_start date;
  v_grants integer;
begin
  perform private.ensure_user_rows(p_user_id, p_now);

  select * into v_wallet from public.pass_wallet where user_id = p_user_id for update;
  select * into v_settings from public.settings where user_id = p_user_id;

  if v_wallet.anchored_at is null then
    update public.pass_wallet
    set timezone = v_settings.timezone,
        week_starts_on = v_settings.week_starts_on,
        last_granted_week_start =
          private.week_start(p_now, v_settings.timezone, v_settings.week_starts_on),
        anchored_at = p_now
    where user_id = p_user_id
    returning * into v_wallet;
    return v_wallet;
  end if;

  v_current_week_start :=
    private.week_start(p_now, v_wallet.timezone, v_wallet.week_starts_on);
  -- Both dates are week starts of the same snapshot, so this is whole weeks;
  -- integer division is floor for the positive case, and a clock that went
  -- backwards gives 0 or less.
  v_grants := (v_current_week_start - v_wallet.last_granted_week_start) / 7;
  if v_grants <= 0 then
    return v_wallet;
  end if;

  -- Adopt the current settings. Their week start can fall before the one just
  -- granted for (a different week_starts_on, or a zone that is behind); then
  -- the next boundary would arrive in under 7 days and the settings could be
  -- cycled for a pass a day. Shift by whole weeks so it is never before it.
  v_new_week_start :=
    private.week_start(p_now, v_settings.timezone, v_settings.week_starts_on);
  while v_new_week_start < v_current_week_start loop
    v_new_week_start := v_new_week_start + 7;
  end loop;

  update public.pass_wallet
  set balance = least(balance + v_grants, v_settings.pass_cap),
      last_granted_week_start = v_new_week_start,
      timezone = v_settings.timezone,
      week_starts_on = v_settings.week_starts_on
  where user_id = p_user_id
  returning * into v_wallet;

  return v_wallet;
end;
$$;

-- "Today" is the wallet's day, not settings': changing the timezone cannot make
-- today's cheat day refundable or yesterday spendable.
create or replace function private.use_pass(p_user_id uuid, p_day date, p_now timestamptz)
returns public.pass_wallet
language plpgsql
set search_path = ''
as $$
declare
  v_wallet public.pass_wallet;
  v_today date;
begin
  if p_day is null then
    raise exception using errcode = 'P0001', message = 'invalid_day';
  end if;

  v_wallet := private.sync_wallet(p_user_id, p_now);
  v_today := (p_now at time zone v_wallet.timezone)::date;

  if v_wallet.balance <= 0 then
    raise exception using errcode = 'P0001', message = 'no_passes_left';
  end if;
  if p_day < v_today then
    raise exception using errcode = 'P0001', message = 'day_in_past';
  end if;
  if exists (
    select 1 from public.cheat_days where user_id = p_user_id and day = p_day
  ) then
    raise exception using errcode = 'P0001', message = 'already_cheat_day';
  end if;

  insert into public.cheat_days (user_id, day) values (p_user_id, p_day);
  update public.pass_wallet
  set balance = balance - 1
  where user_id = p_user_id
  returning * into v_wallet;

  return v_wallet;
end;
$$;

create or replace function private.refund_pass(p_user_id uuid, p_day date, p_now timestamptz)
returns public.pass_wallet
language plpgsql
set search_path = ''
as $$
declare
  v_settings public.settings;
  v_wallet public.pass_wallet;
  v_today date;
begin
  if p_day is null then
    raise exception using errcode = 'P0001', message = 'invalid_day';
  end if;

  v_wallet := private.sync_wallet(p_user_id, p_now);
  select * into v_settings from public.settings where user_id = p_user_id;
  v_today := (p_now at time zone v_wallet.timezone)::date;

  if not exists (
    select 1 from public.cheat_days where user_id = p_user_id and day = p_day
  ) then
    raise exception using errcode = 'P0001', message = 'not_a_cheat_day';
  end if;
  -- Today is not refundable: the day has already begun.
  if p_day <= v_today then
    raise exception using errcode = 'P0001', message = 'day_not_in_future';
  end if;

  delete from public.cheat_days where user_id = p_user_id and day = p_day;
  update public.pass_wallet
  set balance = least(balance + 1, v_settings.pass_cap)
  where user_id = p_user_id
  returning * into v_wallet;

  return v_wallet;
end;
$$;

-- ---------------------------------------------------------------------------
-- M2: correction to the realtime comment in the first migration. Under RLS a
-- Supabase realtime DELETE payload carries only the primary key, whatever the
-- replica identity, so `replica identity full` on cheat_days does NOT deliver
-- the deleted day. It is harmless and stays; clients must refetch cheat_days
-- when a DELETE event arrives instead of reading the day from the payload.
-- ---------------------------------------------------------------------------
