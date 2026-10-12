-- Holidays in the calendar (display only, they never ring).
-- holiday_country: ISO 3166-1 alpha-2 code whose public holidays are shown, null = none.
-- islamic_holidays: show Islamic holidays (Ramadan, Eids, Islamic New Year, Mawlid, ...).
-- hijri_offset_days: shifts computed Hijri dates by -2..2 days to follow the local moon sighting,
-- which can differ from the astronomical calendar.
--
-- Existing rows in Africa/Tunis start with Tunisia and Islamic holidays on: the owner asked for
-- both, and the column defaults stay neutral for anyone else.
--
-- Down (manual): alter table public.settings drop column hijri_offset_days,
--   drop column islamic_holidays, drop column holiday_country;

alter table public.settings
  add column holiday_country text check (holiday_country ~ '^[A-Z]{2}$'),
  add column islamic_holidays boolean not null default false,
  add column hijri_offset_days smallint not null default 0
    check (hijri_offset_days between -2 and 2);

update public.settings
set holiday_country = 'TN', islamic_holidays = true
where timezone = 'Africa/Tunis';

grant insert (holiday_country, islamic_holidays, hijri_offset_days) on public.settings to authenticated;
grant update (holiday_country, islamic_holidays, hijri_offset_days) on public.settings to authenticated;
