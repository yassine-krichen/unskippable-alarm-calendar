-- Agent keys (the `alarm-cal` command line tool): a stable, human-readable name an agent gives an alarm or an
-- exam, like `workout/push-day`, so a declarative plan can find it again, update it in place and leave it
-- alone when nothing changed. The key is optional and null for everything made in the app.
--
--   events.agent_key, exams.agent_key   text, 1 to 100 characters of [a-z0-9/_.-], starting with a letter or
--                                        digit; unique per user among the rows that have one.
--
-- The unique index covers inactive rows too: a soft-deleted alarm keeps its key, and the tool re-activates it
-- when a plan names it again instead of creating a second one. The app never selects, sets or shows the
-- column; its updates leave out columns they do not name, so an alarm edited in the app keeps its key.
--
-- RLS and grants: `events` and `exams` carry table-wide INSERT and UPDATE for authenticated, which cover the new
-- columns, and the existing per-user policies decide which rows are reachable. No policy or grant changes.
--
-- Apply with `supabase db push`. Nothing in the app needs it (it does not read the column); the CLI does.
--
-- Down (manual): drop index public.events_agent_key_unique; drop index public.exams_agent_key_unique;
--                alter table public.events drop column agent_key;
--                alter table public.exams drop column agent_key;

alter table public.events add column agent_key text;
alter table public.exams add column agent_key text;

alter table public.events add constraint events_agent_key_format
  check (agent_key is null or agent_key ~ '^[a-z0-9][a-z0-9/_.-]{0,99}$');
alter table public.exams add constraint exams_agent_key_format
  check (agent_key is null or agent_key ~ '^[a-z0-9][a-z0-9/_.-]{0,99}$');

create unique index events_agent_key_unique on public.events (user_id, agent_key) where agent_key is not null;
create unique index exams_agent_key_unique on public.exams (user_id, agent_key) where agent_key is not null;
