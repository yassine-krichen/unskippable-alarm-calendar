-- Prayer times (roadmap-v2 phase 3b): five prayer alarms a day plus a pre-prayer alarm before each,
-- computed on the device from the location in settings (the `adhan` library, packages/core).
--
-- Prayer alarms are real rows in events, so completions (FK), habit scores, realtime and the soft
-- delete work as for any alarm. The row only anchors the series: its start_at, repeat and ends_at
-- are ignored by the occurrence rules for kind <> 'normal', and every user has at most one row per
-- (kind, prayer), 10 in all. The prayer settings live on the settings row, one place for the
-- location, the method and the offsets.
--
-- Apply with `supabase db push`. The app expects this migration: it selects events.kind,
-- events.prayer and the new settings columns.
--
-- Down (manual): drop function public.set_prayers_enabled(boolean);
--                delete from public.events where kind <> 'normal';
--                drop index public.events_prayer_unique;
--                alter table public.events drop constraint events_prayer_shape,
--                  drop column prayer, drop column kind;
--                drop type public.event_kind;
--                alter table public.settings drop every column added below.

create type public.event_kind as enum ('normal', 'prayer', 'pre_prayer');

alter table public.events
  add column kind public.event_kind not null default 'normal',
  add column prayer text;

-- A prayer row names its prayer, a normal row never does. (`prayer is not null` is explicit because a
-- null in `in (...)` makes the check unknown, and an unknown check passes.)
alter table public.events add constraint events_prayer_shape check (
  (kind = 'normal' and prayer is null)
  or (kind <> 'normal' and prayer is not null and prayer in ('fajr', 'dhuhr', 'asr', 'maghrib', 'isha'))
);

-- At most one row per prayer and kind for a user. Partial, so the (many) normal rows are not indexed.
create unique index events_prayer_unique on public.events (user_id, kind, prayer) where kind <> 'normal';

-- Defaults are Ariana, Tunis with the Tunisian ministry convention (Fajr 18, Isha 18) and the
-- Shafi/Maliki Asr (shadow factor 1); all of it is editable in the app.
alter table public.settings
  add column prayers_enabled boolean not null default false,
  -- When prayers were last switched on. Scoring and the "not logged" reminders ignore prayers
  -- before it, so switching them off for a while does not turn that time into misses.
  add column prayers_enabled_since timestamptz,
  -- 65 degrees at most: nearer the poles the sun can fail to rise or set, and there are no prayer times.
  add column latitude double precision not null default 36.8625
    check (latitude between -65 and 65),
  add column longitude double precision not null default 10.1956
    check (longitude between -180 and 180),
  add column location_label text not null default 'Ariana, Tunisia'
    check (char_length(location_label) <= 100),
  add column fajr_angle double precision not null default 18
    check (fajr_angle between 10 and 22),
  add column isha_angle double precision not null default 18
    check (isha_angle between 10 and 22),
  -- Asr shadow factor: 1 (Shafi, Maliki, Hanbali) or 2 (Hanafi).
  add column asr_factor smallint not null default 1
    check (asr_factor in (1, 2)),
  -- Minutes added to each computed prayer time.
  add column fajr_offset_min smallint not null default 0 check (fajr_offset_min between -60 and 60),
  add column dhuhr_offset_min smallint not null default 0 check (dhuhr_offset_min between -60 and 60),
  add column asr_offset_min smallint not null default 0 check (asr_offset_min between -60 and 60),
  add column maghrib_offset_min smallint not null default 0 check (maghrib_offset_min between -60 and 60),
  add column isha_offset_min smallint not null default 0 check (isha_offset_min between -60 and 60),
  -- Minutes before each prayer for its pre-prayer alarm; 0 turns those alarms off.
  add column pre_prayer_minutes smallint not null default 15
    check (pre_prayer_minutes between 0 and 120),
  -- Snooze rules of the prayer and pre-prayer alarms (no snooze unless the user raises it).
  add column prayer_max_snoozes smallint not null default 0
    check (prayer_max_snoozes between 0 and 10),
  add column prayer_snooze_minutes smallint not null default 5
    check (prayer_snooze_minutes between 1 and 120);

-- Column-level writes on settings (pass_cap stays out of reach, see wallet_hardening).
grant insert (
  prayers_enabled, prayers_enabled_since, latitude, longitude, location_label, fajr_angle, isha_angle,
  asr_factor, fajr_offset_min, dhuhr_offset_min, asr_offset_min, maghrib_offset_min, isha_offset_min,
  pre_prayer_minutes, prayer_max_snoozes, prayer_snooze_minutes
) on public.settings to authenticated;
grant update (
  prayers_enabled, prayers_enabled_since, latitude, longitude, location_label, fajr_angle, isha_angle,
  asr_factor, fajr_offset_min, dhuhr_offset_min, asr_offset_min, maghrib_offset_min, isha_offset_min,
  pre_prayer_minutes, prayer_max_snoozes, prayer_snooze_minutes
) on public.settings to authenticated;

-- Switching prayers on or off in one transaction: the flag and the 10 anchor rows. Security invoker,
-- so RLS and the column grants apply exactly as for the client's own writes. Switching on creates the
-- rows that are missing and re-activates the ones switched off earlier (the unique index makes it
-- safe to call twice); switching off deactivates them, so completions and history stay.
create function public.set_prayers_enabled(p_enabled boolean)
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

  if p_enabled then
    update public.settings
    set prayers_enabled = true,
        prayers_enabled_since = case
          when prayers_enabled then coalesce(prayers_enabled_since, now())
          else now()
        end
    where user_id = v_user_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'settings_missing';
    end if;

    insert into public.events (
      user_id, title, start_at, duration_min, repeat_unit, repeat_interval,
      max_snoozes, snooze_minutes, passable, kind, prayer
    )
    select v_user_id, p.title, now(), 15, 'day', 1, 0, 5, false, p.kind::public.event_kind, p.prayer
    from (values
      ('Fajr', 'prayer', 'fajr'), ('Dhuhr', 'prayer', 'dhuhr'), ('Asr', 'prayer', 'asr'),
      ('Maghrib', 'prayer', 'maghrib'), ('Isha', 'prayer', 'isha'),
      ('Before Fajr', 'pre_prayer', 'fajr'), ('Before Dhuhr', 'pre_prayer', 'dhuhr'),
      ('Before Asr', 'pre_prayer', 'asr'), ('Before Maghrib', 'pre_prayer', 'maghrib'),
      ('Before Isha', 'pre_prayer', 'isha')
    ) as p (title, kind, prayer)
    on conflict (user_id, kind, prayer) where kind <> 'normal'
    do update set active = true where public.events.active = false;
  else
    update public.settings set prayers_enabled = false where user_id = v_user_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'settings_missing';
    end if;
    update public.events set active = false
    where user_id = v_user_id and kind <> 'normal' and active;
  end if;
end;
$$;

revoke execute on function public.set_prayers_enabled(boolean) from public, anon;
grant execute on function public.set_prayers_enabled(boolean) to authenticated;
