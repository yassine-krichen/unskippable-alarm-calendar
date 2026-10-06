-- Calendar visibility (owner feedback, 2026-10-06): an alarm can ring without being drawn on the calendar.
--
-- events.show_in_calendar    per alarm; false hides it from Week, Month and Agenda (the calendar's "Show hidden"
--                            toggle reveals it, greyed). Default true, so every existing alarm stays visible.
-- settings.show_prayers_in_calendar
--                            one switch for the five prayers (their rows keep show_in_calendar = true and are
--                            ignored for it). Default false: the salat alarm is a given, it does not need to
--                            take space on the calendar.
--
-- Presentation only. Hidden alarms are in the schedule list, ring, can be snoozed or done and count in habit
-- scores exactly like visible ones; nothing in packages/core's occurrence rules or the alarm engines reads these.
--
-- RLS and grants: authenticated already holds table-wide INSERT and UPDATE on events, which covers the new
-- column; settings is written by column, so the new column is granted explicitly (the same pattern as
-- exam_mode_days_before in the modes migration).
--
-- Apply with `supabase db push`, after 20261006153533. The app selects both columns, so it needs this migration.
--
-- Down (manual): alter table public.settings drop column show_prayers_in_calendar;
--                alter table public.events drop column show_in_calendar;

alter table public.events add column show_in_calendar boolean not null default true;

alter table public.settings add column show_prayers_in_calendar boolean not null default false;

grant insert (show_prayers_in_calendar) on public.settings to authenticated;
grant update (show_prayers_in_calendar) on public.settings to authenticated;
