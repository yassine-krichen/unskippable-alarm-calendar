-- events.created_at: when the alarm was created (roadmap-v2 phase 1). Habit scoring starts at
-- max(window start, created_at), so a habit created today with a start_at last week is not
-- charged for the days before it existed.
--
-- The client roles hold table-wide INSERT and UPDATE on events, so the column cannot be kept
-- out of reach with a column grant without reworking every grant on the table. A trigger pins
-- it instead: set to now() on insert whatever the client sent, and never changed on update.
--
-- Down (manual): drop trigger events_pin_created_at on public.events;
--                drop function private.pin_event_created_at();
--                alter table public.events drop column created_at;

alter table public.events add column created_at timestamptz;

-- Backfill so existing alarms keep their current scoring window: they count from their first
-- occurrence, or from now if that is still in the future. The updated_at trigger is paused so
-- the backfill does not bump every row's updated_at (clients compare it to drop stale echoes).
alter table public.events disable trigger events_set_updated_at;
update public.events set created_at = least(start_at, now());
alter table public.events enable trigger events_set_updated_at;

alter table public.events
  alter column created_at set default now(),
  alter column created_at set not null;

create function private.pin_event_created_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

create trigger events_pin_created_at
before insert or update on public.events
for each row execute function private.pin_event_created_at();
