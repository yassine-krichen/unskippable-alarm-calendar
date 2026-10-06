-- Modes (roadmap-v2 phase 5): Normal (no row, the default), the built-ins Exam, Ramadan, Vacation and
-- Sick, and custom ones. A mode changes how alarms behave while it is in effect: per alarm it can keep,
-- skip (pause), shift or shorten it. The rules are applied by packages/core while the schedule, the
-- calendar and habit scoring are computed, so the platform alarm engines need no mode logic and the
-- alarm rows themselves are never edited by a mode.
--
-- Tables
--   modes            one row per mode; the four built-ins are created by ensure_builtin_modes().
--   mode_rules       per (mode, alarm) behavior; an alarm with no rule follows the mode's default_behavior.
--   mode_activations when a mode is in effect: 'manual' (the header switch, open-ended until switched
--                    back, or ending at a date) or 'range' (a planned start and end). Exam mode's
--                    automatic window before an exam is NOT stored: core derives it from the exams and
--                    settings.exam_mode_days_before, so editing an exam moves it by itself.
--
-- Apply with `supabase db push`, after 20261006050221. The app selects these tables and the new
-- settings column, so it needs this migration.
--
-- Down (manual): drop function public.set_manual_mode(uuid, timestamptz, timestamptz);
--                drop function public.ensure_builtin_modes();
--                drop table public.mode_activations, public.mode_rules, public.modes;
--                alter table public.settings drop column exam_mode_days_before;

create table public.modes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  kind text not null default 'custom' check (kind in ('builtin', 'custom')),
  -- Set exactly for the built-ins; the app finds them by this key, never by name.
  builtin_key text check (builtin_key in ('exam', 'ramadan', 'vacation', 'sick')),
  -- What happens to an alarm with no rule of its own. Non-passable alarms are never skipped (see below).
  default_behavior text not null default 'keep' check (default_behavior in ('keep', 'skip')),
  -- Off = the mode never takes effect (its activations are ignored). The app's "delete" for a custom mode.
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- `is not null` is explicit: a null in `in (...)` would make the check unknown, and unknown passes.
  constraint modes_builtin_shape check (
    (kind = 'builtin' and builtin_key is not null) or (kind = 'custom' and builtin_key is null)
  )
);

-- One of each built-in per user. Partial, so custom modes (builtin_key null) are not constrained.
create unique index modes_builtin_unique on public.modes (user_id, builtin_key) where builtin_key is not null;
create index modes_user_id_idx on public.modes (user_id);

create table public.mode_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  mode_id uuid not null references public.modes (id) on delete cascade,
  event_id uuid not null references public.events (id) on delete cascade,
  -- keep: ring as usual. skip: paused, never rings and is not scored. shift: rings shift_minutes later
  -- (negative = earlier). shorten: only the calendar block is shorter (duration_min); it still rings.
  behavior text not null check (behavior in ('keep', 'skip', 'shift', 'shorten')),
  shift_minutes integer,
  duration_min integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mode_rules_mode_event_unique unique (mode_id, event_id),
  -- The value belongs to exactly its behavior. Written with explicit `is not null` on both sides for
  -- the same reason as modes_builtin_shape. A shift is at most 12 hours either way.
  constraint mode_rules_shift_shape check (
    (behavior = 'shift' and shift_minutes is not null and shift_minutes between -720 and 720)
    or (behavior <> 'shift' and shift_minutes is null)
  ),
  constraint mode_rules_shorten_shape check (
    (behavior = 'shorten' and duration_min is not null and duration_min between 1 and 1440)
    or (behavior <> 'shorten' and duration_min is null)
  )
);

create index mode_rules_event_id_idx on public.mode_rules (event_id);

create table public.mode_activations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  mode_id uuid not null references public.modes (id) on delete cascade,
  starts_at timestamptz not null,
  -- Null = open-ended, until switched back. Only a manual activation may be open-ended.
  ends_at timestamptz,
  source text not null check (source in ('manual', 'range')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mode_activations_order check (ends_at is null or ends_at > starts_at),
  constraint mode_activations_range_bounded check (source = 'manual' or ends_at is not null)
);

create index mode_activations_mode_id_idx on public.mode_activations (mode_id);
create index mode_activations_user_starts_idx on public.mode_activations (user_id, starts_at);

create trigger modes_set_updated_at before update on public.modes
for each row execute function private.set_updated_at();
create trigger mode_rules_set_updated_at before update on public.mode_rules
for each row execute function private.set_updated_at();
create trigger mode_activations_set_updated_at before update on public.mode_activations
for each row execute function private.set_updated_at();

alter table public.modes enable row level security;
alter table public.mode_rules enable row level security;
alter table public.mode_activations enable row level security;

revoke all on public.modes, public.mode_rules, public.mode_activations from anon;
revoke truncate, references, trigger on public.modes, public.mode_rules, public.mode_activations from authenticated;

-- A built-in's identity (kind, builtin_key) is fixed at insert: update is column-limited, so a client
-- cannot turn a custom mode into a built-in or the reverse. user_id is never client-updatable either.
revoke insert, update on public.modes from authenticated;
grant insert (name, kind, builtin_key, default_behavior, active) on public.modes to authenticated;
grant update (name, default_behavior, active) on public.modes to authenticated;

create policy modes_select on public.modes for select to authenticated
  using (user_id = (select auth.uid()));
create policy modes_insert on public.modes for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy modes_update on public.modes for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy modes_delete on public.modes for delete to authenticated
  using (user_id = (select auth.uid()));

-- mode_id and event_id are foreign keys, and foreign key checks ignore RLS, so without these checks a
-- client could attach a rule or an activation to somebody else's mode or alarm. The exists() subqueries
-- run under the caller's RLS and see only their own rows (neither modes nor events policies read these
-- tables, so there is no recursion).
create policy mode_rules_select on public.mode_rules for select to authenticated
  using (user_id = (select auth.uid()));
create policy mode_rules_insert on public.mode_rules for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.modes m where m.id = mode_rules.mode_id)
    and exists (select 1 from public.events e where e.id = mode_rules.event_id)
  );
create policy mode_rules_update on public.mode_rules for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.modes m where m.id = mode_rules.mode_id)
    and exists (select 1 from public.events e where e.id = mode_rules.event_id)
  );
create policy mode_rules_delete on public.mode_rules for delete to authenticated
  using (user_id = (select auth.uid()));

create policy mode_activations_select on public.mode_activations for select to authenticated
  using (user_id = (select auth.uid()));
create policy mode_activations_insert on public.mode_activations for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.modes m where m.id = mode_activations.mode_id)
  );
create policy mode_activations_update on public.mode_activations for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.modes m where m.id = mode_activations.mode_id)
  );
create policy mode_activations_delete on public.mode_activations for delete to authenticated
  using (user_id = (select auth.uid()));

alter publication supabase_realtime add table public.modes, public.mode_rules, public.mode_activations;

-- How many days before an exam Exam mode switches itself on (it ends the day after the exam). 0 turns
-- the automatic window off. Not stored per exam: one number is enough for one user.
alter table public.settings
  add column exam_mode_days_before smallint not null default 10
    check (exam_mode_days_before between 0 and 60);
grant insert (exam_mode_days_before) on public.settings to authenticated;
grant update (exam_mode_days_before) on public.settings to authenticated;

-- Creates the four built-in modes that are missing. A security-invoker RPC rather than a client upsert:
-- the conflict target is a partial index, which PostgREST cannot name. Safe to call any number of
-- times, and it never touches a built-in that exists (so a user's edits and an off switch stay).
-- Sick and Vacation skip every passable alarm by default; Exam and Ramadan keep everything until rules
-- are added.
create function public.ensure_builtin_modes()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;

  -- user_id is left to its default (auth.uid()): it is not an insertable column for clients.
  insert into public.modes (name, kind, builtin_key, default_behavior)
  select p.name, 'builtin', p.builtin_key, p.default_behavior
  from (values
    ('Exam', 'exam', 'keep'),
    ('Ramadan', 'ramadan', 'keep'),
    ('Vacation', 'vacation', 'skip'),
    ('Sick', 'sick', 'skip')
  ) as p (name, builtin_key, default_behavior)
  on conflict (user_id, builtin_key) where builtin_key is not null do nothing;
end;
$$;

revoke execute on function public.ensure_builtin_modes() from public, anon;
grant execute on function public.ensure_builtin_modes() to authenticated;

-- The header switch, in one transaction: ends whatever manual mode is in effect and starts the new one.
-- p_mode_id null means "back to normal" (only the ending half). p_starts_at is the moment the person says
-- it began (null = now; at most 7 days back, never in the future), so "I got sick this morning" pauses this
-- morning's alarms too. p_ends_at null = open-ended, until switched back. A manual activation that began
-- at or after the new start is superseded and removed; one that began earlier is ended at the new start.
-- Security invoker, so RLS applies as for the client's own writes (another user's mode is "not found").
create function public.set_manual_mode(
  p_mode_id uuid,
  p_starts_at timestamptz default null,
  p_ends_at timestamptz default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_start timestamptz := coalesce(p_starts_at, now());
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'not_authenticated';
  end if;
  if v_start > now() or v_start < now() - interval '7 days' then
    raise exception using errcode = 'P0001', message = 'invalid_start';
  end if;
  if p_mode_id is not null then
    if p_ends_at is not null and p_ends_at <= v_start then
      raise exception using errcode = 'P0001', message = 'invalid_end';
    end if;
    perform 1 from public.modes where id = p_mode_id and user_id = v_user_id and active;
    if not found then
      raise exception using errcode = 'P0001', message = 'mode_not_found';
    end if;
  end if;

  delete from public.mode_activations
  where user_id = v_user_id and source = 'manual' and starts_at >= v_start;
  update public.mode_activations set ends_at = v_start
  where user_id = v_user_id and source = 'manual' and starts_at < v_start
    and (ends_at is null or ends_at > v_start);

  if p_mode_id is not null then
    insert into public.mode_activations (user_id, mode_id, starts_at, ends_at, source)
    values (v_user_id, p_mode_id, v_start, p_ends_at, 'manual');
  end if;
end;
$$;

revoke execute on function public.set_manual_mode(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.set_manual_mode(uuid, timestamptz, timestamptz) to authenticated;
