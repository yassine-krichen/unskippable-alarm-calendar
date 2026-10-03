-- Follow-up to wallet_hardening (M1 residual). A settings.timezone switch timed
-- at a weekly grant boundary made the pre-check sync adopt the new zone, so
-- "today" moved backwards inside the same call: refund_pass could refund a cheat
-- day that had already started, and the adopted zone could stay for the whole
-- week so use_pass could hit a real yesterday.
--
-- Rule: "today" for use_pass / refund_pass is the latest of the local date in
--   * the wallet's snapshot zone BEFORE the sync (what the wallet believed when
--     the call began),
--   * the wallet's snapshot zone AFTER the sync (what it adopted),
--   * settings.timezone (what the user's device says now).
-- A zone switch can therefore only make a pass decision stricter, never looser.
-- Mirrors passToday() in packages/core/src/wallet.ts. Both comparisons stay:
-- use_pass fails when day < today, refund_pass when day <= today.

create function private.pass_today(
  p_now timestamptz,
  p_wallet_tz_before text,
  p_wallet_tz_after text,
  p_settings_tz text
)
returns date
language sql
stable
set search_path = ''
as $$
  -- greatest() ignores nulls: the wallet or settings row may not have existed
  -- before the sync (self-heal).
  select greatest(
    (p_now at time zone p_wallet_tz_before)::date,
    (p_now at time zone p_wallet_tz_after)::date,
    (p_now at time zone p_settings_tz)::date
  );
$$;

revoke execute on function private.pass_today(timestamptz, text, text, text)
from public, anon, authenticated;

create or replace function private.use_pass(p_user_id uuid, p_day date, p_now timestamptz)
returns public.pass_wallet
language plpgsql
set search_path = ''
as $$
declare
  v_settings public.settings;
  v_wallet public.pass_wallet;
  v_tz_before text;
  v_today date;
begin
  if p_day is null then
    raise exception using errcode = 'P0001', message = 'invalid_day';
  end if;

  select timezone into v_tz_before from public.pass_wallet where user_id = p_user_id;
  v_wallet := private.sync_wallet(p_user_id, p_now);
  select * into v_settings from public.settings where user_id = p_user_id;
  v_today := private.pass_today(p_now, v_tz_before, v_wallet.timezone, v_settings.timezone);

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
  v_tz_before text;
  v_today date;
begin
  if p_day is null then
    raise exception using errcode = 'P0001', message = 'invalid_day';
  end if;

  select timezone into v_tz_before from public.pass_wallet where user_id = p_user_id;
  v_wallet := private.sync_wallet(p_user_id, p_now);
  select * into v_settings from public.settings where user_id = p_user_id;
  v_today := private.pass_today(p_now, v_tz_before, v_wallet.timezone, v_settings.timezone);

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

-- The public RPCs also return the wallet's snapshot, so a client can compute
-- the same "today" (latest of wallet zone and its own settings zone).

create or replace function public.sync_wallet()
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_wallet public.pass_wallet;
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  v_wallet := private.sync_wallet(v_user_id, now());
  return json_build_object(
    'balance', v_wallet.balance,
    'last_granted_week_start', v_wallet.last_granted_week_start,
    'timezone', v_wallet.timezone,
    'week_starts_on', v_wallet.week_starts_on
  );
end;
$$;

create or replace function public.use_pass(day date)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_wallet public.pass_wallet;
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  v_wallet := private.use_pass(v_user_id, day, now());
  return json_build_object(
    'balance', v_wallet.balance,
    'last_granted_week_start', v_wallet.last_granted_week_start,
    'timezone', v_wallet.timezone,
    'week_starts_on', v_wallet.week_starts_on
  );
end;
$$;

create or replace function public.refund_pass(day date)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_wallet public.pass_wallet;
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  v_wallet := private.refund_pass(v_user_id, day, now());
  return json_build_object(
    'balance', v_wallet.balance,
    'last_granted_week_start', v_wallet.last_granted_week_start,
    'timezone', v_wallet.timezone,
    'week_starts_on', v_wallet.week_starts_on
  );
end;
$$;
