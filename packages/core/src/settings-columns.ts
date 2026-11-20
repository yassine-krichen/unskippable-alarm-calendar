// The settings columns, in one place for the app and the agent CLI.

const PRAYER_COLUMNS =
  'prayers_enabled, prayers_enabled_since, latitude, longitude, location_label, fajr_angle, isha_angle, asr_factor, fajr_offset_min, dhuhr_offset_min, asr_offset_min, maghrib_offset_min, isha_offset_min, pre_prayer_minutes, pre_prayer_skip_fajr, prayer_max_snoozes, prayer_snooze_minutes, show_prayers_in_calendar';

const HOLIDAY_COLUMNS = 'holiday_country, islamic_holidays, hijri_offset_days';

/** Every settings column a client reads (a select list). */
export const SETTINGS_COLUMNS = `user_id, timezone, week_starts_on, refire_seconds, pass_cap, grace_minutes, exam_mode_days_before, ${PRAYER_COLUMNS}, ${HOLIDAY_COLUMNS}`;

/**
 * The columns a client may UPDATE (the database grants exactly these). pass_cap is the product's rule,
 * user_id is identity, and prayers_enabled / prayers_enabled_since are written only by the
 * set_prayers_enabled RPC together with the ten prayer alarms they switch on.
 */
export const WRITABLE_SETTINGS_COLUMNS = [
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
  'pre_prayer_skip_fajr',
  'prayer_max_snoozes',
  'prayer_snooze_minutes',
  'show_prayers_in_calendar',
  'holiday_country',
  'islamic_holidays',
  'hijri_offset_days',
] as const;

export type WritableSettingsColumn = (typeof WRITABLE_SETTINGS_COLUMNS)[number];
