-- Cheat pass wallet (spec section 7). The logic mirrors packages/core/src/wallet.ts.
--
-- Errors: every failure is `raise exception` with errcode P0001 and the error
-- code as the message, so supabase-js surfaces it as error.message:
--   sync_wallet : not_authenticated
--   use_pass    : not_authenticated, invalid_day, no_passes_left, day_in_past, already_cheat_day
--   refund_pass : not_authenticated, invalid_day, not_a_cheat_day, day_not_in_future
--
-- Logic lives in private.* functions taking (user, now) so tests can control
-- the clock; the public RPCs are thin wrappers passing auth.uid() and now().

-- Local start-of-week date of the week containing p_now. p_week_starts_on uses
-- Monday = 0, like settings.week_starts_on.
create function private.week_start(p_now timestamptz, p_tz text, p_week_starts_on integer)
returns date
language sql
stable
set search_path = ''
as $$
  select d - ((extract(isodow from d)::integer - 1 - p_week_starts_on + 7) % 7)
  from (select (p_now at time zone p_tz)::date as d) as local_day;
$$;

-- Creates missing settings / wallet rows (self-heal for users that predate the
-- signup trigger or had a row deleted).
create function private.ensure_user_rows(p_user_id uuid, p_now timestamptz)
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

  insert into public.pass_wallet (user_id, balance, last_granted_week_start)
  values (
    p_user_id,
    1,
    private.week_start(p_now, v_settings.timezone, v_settings.week_starts_on)
  )
  on conflict (user_id) do nothing;
end;
$$;

-- Locks the wallet row until the end of the transaction, applies the weekly
-- grant catch-up, and returns the wallet. Callers inherit the lock.
create function private.sync_wallet(p_user_id uuid, p_now timestamptz)
returns public.pass_wallet
language plpgsql
set search_path = ''
as $$
declare
  v_settings public.settings;
  v_wallet public.pass_wallet;
  v_current_week_start date;
  v_days_behind integer;
begin
  perform private.ensure_user_rows(p_user_id, p_now);

  select * into v_wallet from public.pass_wallet where user_id = p_user_id for update;
  select * into v_settings from public.settings where user_id = p_user_id;

  v_current_week_start :=
    private.week_start(p_now, v_settings.timezone, v_settings.week_starts_on);
  v_days_behind := v_current_week_start - v_wallet.last_granted_week_start;
  if v_days_behind <= 0 then
    return v_wallet;
  end if;

  -- ceil, not exact division: if week_starts_on changed, the stored week start
  -- may not be aligned with the new one, yet each boundary still grants one.
  update public.pass_wallet
  set balance = least(balance + ceil(v_days_behind / 7.0)::integer, v_settings.pass_cap),
      last_granted_week_start = v_current_week_start
  where user_id = p_user_id
  returning * into v_wallet;

  return v_wallet;
end;
$$;

create function private.use_pass(p_user_id uuid, p_day date, p_now timestamptz)
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
  v_today := (p_now at time zone v_settings.timezone)::date;

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

create function private.refund_pass(p_user_id uuid, p_day date, p_now timestamptz)
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
  v_today := (p_now at time zone v_settings.timezone)::date;

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

-- Public RPCs

create function public.sync_wallet()
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
    'last_granted_week_start', v_wallet.last_granted_week_start
  );
end;
$$;

create function public.use_pass(day date)
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
    'last_granted_week_start', v_wallet.last_granted_week_start
  );
end;
$$;

create function public.refund_pass(day date)
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
    'last_granted_week_start', v_wallet.last_granted_week_start
  );
end;
$$;

-- New accounts get default settings (timezone is updated by the client later)
-- and a wallet holding the initial pass.
create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.ensure_user_rows(new.id, now());
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function private.handle_new_user();

-- Privileges. Functions are executable by PUBLIC by default, and Supabase also
-- grants anon/authenticated explicitly, so revoke from all three.
revoke execute on function
  private.week_start(timestamptz, text, integer),
  private.ensure_user_rows(uuid, timestamptz),
  private.sync_wallet(uuid, timestamptz),
  private.use_pass(uuid, date, timestamptz),
  private.refund_pass(uuid, date, timestamptz),
  private.handle_new_user(),
  private.set_updated_at(),
  private.validate_timezone()
from public, anon, authenticated;

revoke execute on function
  public.sync_wallet(), public.use_pass(date), public.refund_pass(date)
from public, anon;
grant execute on function
  public.sync_wallet(), public.use_pass(date), public.refund_pass(date)
to authenticated;
