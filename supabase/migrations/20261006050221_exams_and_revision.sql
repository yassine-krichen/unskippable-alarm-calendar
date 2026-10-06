-- Exams and revision sessions (roadmap-v2 phase 4).
--
-- An exam is a row in `exams`. Its alarms are ordinary one-off rows in `events` (kind = 'normal',
-- repeat_unit = 'none') linked to it by `exam_id`: the alarm at the exam itself (exam_role 'exam') and
-- the revision sessions generated backwards from the exam date (exam_role 'session'). They stay plain
-- normal alarms so recurrence, the schedule, the calendar, the cheat-day rule and the engines need no
-- new code path; only the app knows what the link means.
--
-- A session that was missed gets one catch-up session, itself an events row with exam_role 'session'
-- and `catch_up_of` = the id of the missed session's row. The unique index on `catch_up_of` is what makes
-- that idempotent across devices: two devices that both notice the miss both insert, one wins and the
-- other does nothing (the app uses INSERT ... ON CONFLICT (catch_up_of) DO NOTHING). It is a plain,
-- not a partial, unique index so that conflict target can name it; Postgres treats NULLs as distinct,
-- so the many rows without a catch_up_of do not collide.
--
-- Apply with `supabase db push`, after 20261006010617, 20261006010618 and 20261006042009. The app
-- selects the new events columns and the exams table, so it needs this migration.
--
-- Down (manual): alter table public.events drop column catch_up_of, drop column exam_role, drop column exam_id;
--                (that also drops events_exam_id_idx, events_exam_alarm_unique and events_catch_up_of_unique)
--                drop table public.exams;
--                then recreate events_insert and events_update as in the init_schema migration.

create table public.exams (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null check (length(btrim(title)) > 0),
  exam_at timestamptz not null,
  -- 1 easy, 2 normal, 3 hard. Hard exams get an extra revision session 14 days before.
  difficulty smallint not null default 2 check (difficulty between 1 and 3),
  notes text,
  -- Delete = set false, like events, so completions of its sessions keep their event.
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index exams_user_id_idx on public.exams (user_id);

create trigger exams_set_updated_at
before update on public.exams
for each row execute function private.set_updated_at();

alter table public.exams enable row level security;

revoke all on public.exams from anon;
revoke truncate, references, trigger on public.exams from authenticated;

create policy exams_select on public.exams for select to authenticated
  using (user_id = (select auth.uid()));
create policy exams_insert on public.exams for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy exams_update on public.exams for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy exams_delete on public.exams for delete to authenticated
  using (user_id = (select auth.uid()));

alter publication supabase_realtime add table public.exams;

-- Links from events. exam_id is set null (not cascaded) if an exam row is ever hard-deleted: the app
-- soft-deletes, and a stray hard delete should not take alarm history with it.
alter table public.events
  add column exam_id uuid references public.exams (id) on delete set null,
  add column exam_role text,
  add column catch_up_of uuid references public.events (id) on delete cascade;

alter table public.events add constraint events_exam_role_values check (
  exam_role is null or exam_role in ('exam', 'session')
);
-- A catch-up is a session, and never its own replacement. (`is not distinct from`, because a null
-- exam_role would make `exam_role = 'session'` unknown, and an unknown check passes.)
alter table public.events add constraint events_catch_up_shape check (
  catch_up_of is null or (exam_role is not distinct from 'session' and catch_up_of <> id)
);

-- "The alarms of this exam" lookups; partial, as most rows have no exam.
create index events_exam_id_idx on public.events (exam_id) where exam_id is not null;
-- At most one active alarm at the exam itself per exam.
create unique index events_exam_alarm_unique on public.events (exam_id)
  where exam_role = 'exam' and active;
-- At most one catch-up per missed session (see the header).
create unique index events_catch_up_of_unique on public.events (catch_up_of);

-- exam_id and catch_up_of are foreign keys, and foreign key checks ignore RLS, so without these checks a
-- client could link its alarm to somebody else's exam, or claim somebody else's session as catch_up_of
-- (the unique index is global, so that would block their real catch-up). The exams exists() sees only
-- the caller's own exams. A plain exists() on events inside an events policy recurses, so ownership of
-- the replaced session goes through a security-definer helper in its own schema, which PostgREST does
-- not expose.
create schema rls;
revoke all on schema rls from public;
grant usage on schema rls to authenticated;

create function rls.owns_event(p uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.events e where e.id = p and e.user_id = (select auth.uid()));
$$;
revoke all on function rls.owns_event(uuid) from public, anon;
grant execute on function rls.owns_event(uuid) to authenticated;

drop policy events_insert on public.events;
drop policy events_update on public.events;

create policy events_insert on public.events for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (exam_id is null or exists (select 1 from public.exams x where x.id = exam_id))
    and (catch_up_of is null or rls.owns_event(catch_up_of))
  );
create policy events_update on public.events for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and (exam_id is null or exists (select 1 from public.exams x where x.id = exam_id))
    and (catch_up_of is null or rls.owns_event(catch_up_of))
  );
