-- events.group_id (roadmap-v2 phase 2): links the alarms one template created, so the two
-- alarms of a birthday or anniversary (prep 7 days before, wish on the day) can be edited and
-- deleted together. Null for a plain alarm. There is no table for groups and no foreign key: the
-- id only has to be the same on the rows that belong together.
--
-- RLS is unchanged: the column lives on rows the user already owns, and the existing per-user
-- policies and table-wide grants on events cover it. The partial index serves "the other alarms
-- of this group" lookups without indexing the (usually null) bulk of the table.
--
-- Down (manual): drop index public.events_group_id_idx;
--                alter table public.events drop column group_id;

alter table public.events add column group_id uuid;

create index events_group_id_idx on public.events (group_id) where group_id is not null;
