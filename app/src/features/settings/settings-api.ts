import type { HolidaySettings, PrayerSettings, Settings } from '@alarm-calendar/core';

import { supabase } from '@/lib/supabase';
import { fail, ok, type Result } from '@/lib/result';

const PRAYER_COLUMNS =
  'prayers_enabled, prayers_enabled_since, latitude, longitude, location_label, fajr_angle, isha_angle, asr_factor, fajr_offset_min, dhuhr_offset_min, asr_offset_min, maghrib_offset_min, isha_offset_min, pre_prayer_minutes, prayer_max_snoozes, prayer_snooze_minutes, show_prayers_in_calendar';

const HOLIDAY_COLUMNS = 'holiday_country, islamic_holidays, hijri_offset_days';

const SETTINGS_COLUMNS = `user_id, timezone, week_starts_on, refire_seconds, pass_cap, grace_minutes, exam_mode_days_before, ${PRAYER_COLUMNS}, ${HOLIDAY_COLUMNS}`;

/**
 * The prayer settings a client edits directly. prayers_enabled and prayers_enabled_since are
 * written only by the set_prayers_enabled RPC, together with the 10 prayer alarms they switch on.
 */
export type PrayerSettingsPatch = Partial<Omit<PrayerSettings, 'prayers_enabled' | 'prayers_enabled_since'>>;

/** The columns a client may write. pass_cap is the product's rule, not a preference. */
export type SettingsPatch = Partial<
  Pick<Settings, 'timezone' | 'week_starts_on' | 'refire_seconds' | 'grace_minutes' | 'exam_mode_days_before'>
> &
  PrayerSettingsPatch &
  Partial<HolidaySettings>;

const WRITABLE_COLUMNS = [
  'timezone',
  'week_starts_on',
  'refire_seconds',
  'grace_minutes',
  'exam_mode_days_before',
  'latitude',
  'longitude',
  'location_label',
  'fajr_angle',
  'isha_angle',
  'asr_factor',
  'fajr_offset_min',
  'dhuhr_offset_min',
  'asr_offset_min',
  'maghrib_offset_min',
  'isha_offset_min',
  'pre_prayer_minutes',
  'prayer_max_snoozes',
  'prayer_snooze_minutes',
  'show_prayers_in_calendar',
  'holiday_country',
  'islamic_holidays',
  'hijri_offset_days',
] as const;

/** Drops anything a caller smuggled in (pass_cap, user_id, the prayer switch): the database would reject or ignore it anyway. */
function writableColumns(patch: SettingsPatch): SettingsPatch {
  const picked: SettingsPatch = {};
  for (const column of WRITABLE_COLUMNS) {
    const value = patch[column];
    if (value !== undefined) Object.assign(picked, { [column]: value });
  }
  return picked;
}

/** Null data means the row does not exist yet; sync_wallet recreates it. */
export async function fetchSettings(): Promise<Result<Settings | null>> {
  const { data, error } = await supabase
    .from('settings')
    .select(SETTINGS_COLUMNS)
    .maybeSingle<Settings>();
  if (error) return fail(error.message);
  return ok(data);
}

/**
 * Plain UPDATE, never upsert: an upsert's ON CONFLICT DO UPDATE touches user_id and
 * pass_cap, which clients have no column privilege on, so it fails by design.
 */
export async function updateSettings(userId: string, patch: SettingsPatch): Promise<Result<Settings>> {
  const { data, error } = await supabase
    .from('settings')
    .update(writableColumns(patch))
    .eq('user_id', userId)
    .select(SETTINGS_COLUMNS)
    .maybeSingle<Settings>();
  if (error) return fail(error.message);
  if (data === null) return fail('Your settings could not be found. Reload the app and try again.');
  return ok(data);
}

/**
 * Switches the prayer alarms on or off in one database call: the flag on settings and the 10 anchor
 * rows (five prayers, five reminders), created or re-activated, or deactivated. Safe to repeat.
 */
export async function setPrayersEnabled(enabled: boolean): Promise<Result<null>> {
  const { error } = await supabase.rpc('set_prayers_enabled', { p_enabled: enabled });
  if (error) return fail(error.message);
  return ok(null);
}

/**
 * Creates the settings row when it is missing (the signup trigger normally makes it). A plain
 * INSERT of the granted columns only, so the device zone is in place before the first
 * sync_wallet anchors the wallet.
 */
export async function createSettings(userId: string, timezone: string): Promise<Result<Settings>> {
  const { data, error } = await supabase
    .from('settings')
    .insert({ user_id: userId, timezone })
    .select(SETTINGS_COLUMNS)
    .single<Settings>();
  if (error) return fail(error.message);
  return ok(data);
}
