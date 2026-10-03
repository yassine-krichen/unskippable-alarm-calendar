-- Schema for the alarm calendar (spec section 3). Everything is per-user and
-- guarded by RLS; pass_wallet and cheat_days are only writable through the
-- RPCs in the next migration so passes cannot be forged from a client.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create type public.repeat_unit as enum ('none', 'hour', 'day', 'week', 'month');
create type public.completion_status as enum ('done', 'skipped_cheat');

create table public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null check (length(btrim(title)) > 0),
  notes text,
  start_at timestamptz not null,
  duration_min integer not null default 15 check (duration_min >= 1),
  repeat_unit public.repeat_unit not null default 'none',
  repeat_interval integer not null default 1 check (repeat_interval >= 1),
  -- 0 to 6, Monday = 0; null means the weekday of start_at.
  repeat_weekdays integer[] check (
    repeat_weekdays is null
    or (cardinality(repeat_weekdays) >= 1 and repeat_weekdays <@ array[0, 1, 2, 3, 4, 5, 6])
  ),
  ends_at timestamptz,
  max_snoozes integer not null default 3 check (max_snoozes between 0 and 10),
  snooze_minutes integer not null default 5 check (snooze_minutes >= 1),
  passable boolean not null default true,
  color text,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  check (ends_at is null or ends_at >= start_at)
);

create table public.completions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  event_id uuid not null references public.events (id) on delete cascade,
  occurrence_at timestamptz not null,
  status public.completion_status not null,
  snoozes_used integer not null default 0 check (snoozes_used >= 0),
  done_at timestamptz not null default now(),
  unique (event_id, occurrence_at)
);

create table public.settings (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  timezone text not null default 'UTC',
  -- 0 = Monday, same indexing as events.repeat_weekdays.
  week_starts_on integer not null default 0 check (week_starts_on between 0 and 6),
  refire_seconds integer not null default 120 check (refire_seconds >= 1),
  pass_cap integer not null default 2 check (pass_cap >= 0),
  grace_minutes integer not null default 30 check (grace_minutes >= 0)
);

create table public.pass_wallet (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  balance integer not null default 1 check (balance >= 0),
  last_granted_week_start date not null
);

create table public.cheat_days (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Calendar day in the user's timezone.
  day date not null,
  created_at timestamptz not null default now(),
  unique (user_id, day)
);

-- Unique constraints already cover cheat_days(user_id, day) and
-- completions(event_id, ...); these serve the "everything for this user" reads.
create index events_user_id_idx on public.events (user_id);
create index completions_user_id_idx on public.completions (user_id);

-- Triggers

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger events_set_updated_at
before update on public.events
for each row execute function private.set_updated_at();

-- An unknown zone would make every wallet RPC fail, so reject it at write time.
create function private.validate_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform now() at time zone new.timezone;
  return new;
end;
$$;

create trigger settings_validate_timezone
before insert or update of timezone on public.settings
for each row execute function private.validate_timezone();

-- Row level security

alter table public.events enable row level security;
alter table public.completions enable row level security;
alter table public.settings enable row level security;
alter table public.pass_wallet enable row level security;
alter table public.cheat_days enable row level security;

-- Supabase's default privileges grant everything to anon/authenticated on new
-- public tables; trim that to what the policies below actually allow.
revoke all on public.events, public.completions, public.settings,
  public.pass_wallet, public.cheat_days from anon;
revoke insert, update, delete on public.pass_wallet, public.cheat_days from authenticated;

create policy events_select on public.events for select to authenticated
  using (user_id = (select auth.uid()));
create policy events_insert on public.events for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy events_update on public.events for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy events_delete on public.events for delete to authenticated
  using (user_id = (select auth.uid()));

-- The exists() stops a user attaching a completion to someone else's event.
create policy completions_select on public.completions for select to authenticated
  using (user_id = (select auth.uid()));
create policy completions_insert on public.completions for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.events e where e.id = event_id)
  );
create policy completions_update on public.completions for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.events e where e.id = event_id)
  );
create policy completions_delete on public.completions for delete to authenticated
  using (user_id = (select auth.uid()));

create policy settings_select on public.settings for select to authenticated
  using (user_id = (select auth.uid()));
create policy settings_insert on public.settings for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy settings_update on public.settings for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy settings_delete on public.settings for delete to authenticated
  using (user_id = (select auth.uid()));

create policy pass_wallet_select on public.pass_wallet for select to authenticated
  using (user_id = (select auth.uid()));

create policy cheat_days_select on public.cheat_days for select to authenticated
  using (user_id = (select auth.uid()));

-- Realtime (step 6 subscribes to these). Full replica identity so a DELETE
-- payload on cheat_days carries the day, not only the id.
alter publication supabase_realtime add table
  public.events, public.completions, public.cheat_days, public.settings;
alter table public.cheat_days replica identity full;
