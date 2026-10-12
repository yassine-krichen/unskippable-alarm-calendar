import { buildSchedulePayload } from '@alarm-calendar/core';
import { describe, expect, it } from 'vitest';

import { parseSchedulePayload } from './desktop-payloads';

const USER = '99999999-9999-4999-8999-999999999999';
const NOW = new Date('2026-10-12T09:00:00.000Z');

const SETTINGS = {
  user_id: USER,
  timezone: 'Africa/Tunis',
  week_starts_on: 0,
  refire_seconds: 120,
  pass_cap: 2,
  grace_minutes: 30,
};

function build(settings: typeof SETTINGS & Record<string, unknown>) {
  return buildSchedulePayload({ events: [], cheatDays: [], settings, completions: [], now: NOW, horizonDays: 3 });
}

describe('parseSchedulePayload, holiday settings', () => {
  it('accepts the holiday columns and leaves them out of what the engine acts on', () => {
    const baseline = build(SETTINGS);
    const withHolidays = parseSchedulePayload(
      build({ ...SETTINGS, holiday_country: 'TN', islamic_holidays: true, hijri_offset_days: -1 })
    );
    expect(withHolidays.ok).toBe(true);
    if (withHolidays.ok && withHolidays.version === 2) {
      expect(withHolidays.value.occurrences).toEqual(baseline.occurrences);
      expect(withHolidays.value.settings).toMatchObject({ holiday_country: 'TN', islamic_holidays: true, hijri_offset_days: -1 });
    }
  });

  it('accepts a cleared country (null) as it comes from the database', () => {
    const parsed = parseSchedulePayload(build({ ...SETTINGS, holiday_country: null, islamic_holidays: false, hijri_offset_days: 0 }));
    expect(parsed.ok).toBe(true);
  });

  it('never rejects the push over a malformed holiday column: it reads as absent', () => {
    const parsed = parseSchedulePayload({
      ...build(SETTINGS),
      settings: { ...SETTINGS, holiday_country: 12, islamic_holidays: 'yes', hijri_offset_days: 'a day' },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.version === 2) {
      expect(parsed.value.settings.holiday_country).toBeUndefined();
      expect(parsed.value.settings.islamic_holidays).toBeUndefined();
      expect(parsed.value.settings.hijri_offset_days).toBeUndefined();
    }
  });

  it('still accepts a push from a renderer that knows nothing of holidays', () => {
    expect(parseSchedulePayload(build(SETTINGS)).ok).toBe(true);
  });
});
