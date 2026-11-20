-- Windowed prayer alarms (Later / Can't now / Qada) and honest prayer scoring.
--
-- The only schema change is one settings column: pre_prayer_skip_fajr, whether the reminder before Fajr is
-- left out (the Fajr alarm itself still rings; a second alarm 15 minutes earlier is just a worse night).
-- It defaults to true, and because the column is added with that default the existing row gets true too:
-- the owner gets one night's sleep from the next schedule push.
--
-- Nothing else is stored. Later and Can't now are ring control kept on the device, and a made-up prayer
-- (qada) is a normal completions row: status 'done', occurrence_at = the prayer's instant, done_at = when it was
-- made up (after the prayer's window closed). Its tier (on time, late, qada) is derived from done_at.
-- completions already allows a user to insert their own rows, so no table, policy or grant changes.
--
-- Down (manual): alter table public.settings drop column pre_prayer_skip_fajr;

alter table public.settings
  add column pre_prayer_skip_fajr boolean not null default true;

-- Column-level writes on settings (pass_cap stays out of reach, see wallet_hardening), as for the other prayer columns.
grant insert (pre_prayer_skip_fajr) on public.settings to authenticated;
grant update (pre_prayer_skip_fajr) on public.settings to authenticated;
