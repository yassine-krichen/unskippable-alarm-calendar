import type { Settings } from '@alarm-calendar/core';
import { describe, expect, it } from 'vitest';

import {
  parseDecimal,
  prayerFormSchema,
  prayerFormToPatch,
  prayerFormValues,
  prayerPreview,
  roundCoordinates,
} from './prayer-settings';

const BASE: Settings = {
  user_id: 'u1',
  timezone: 'Africa/Tunis',
  week_starts_on: 0,
  refire_seconds: 120,
  pass_cap: 2,
  grace_minutes: 30,
};

describe('prayerFormValues', () => {
  it('starts from Ariana with the Tunisian angles for a settings row without prayer columns', () => {
    expect(prayerFormValues(BASE)).toMatchObject({
      latitude: 36.8625,
      longitude: 10.1956,
      locationLabel: 'Ariana, Tunisia',
      fajrAngle: 18,
      ishaAngle: 18,
      asrFactor: 1,
      prePrayerMinutes: 15,
      prayerMaxSnoozes: 0,
    });
  });

  it('reads what the settings hold', () => {
    const values = prayerFormValues({ ...BASE, latitude: 48.85, asr_factor: 2, dhuhr_offset_min: 3, prayer_max_snoozes: 2 });
    expect(values).toMatchObject({ latitude: 48.85, asrFactor: 2, dhuhrOffset: 3, prayerMaxSnoozes: 2 });
  });
});

describe('showing the prayers in the calendar (form mapping)', () => {
  it('starts from the settings value, and from off when the row predates the column', () => {
    expect(prayerFormValues(BASE).showInCalendar).toBe(false);
    expect(prayerFormValues({ ...BASE, show_prayers_in_calendar: true }).showInCalendar).toBe(true);
  });

  it('writes the switch as settings.show_prayers_in_calendar', () => {
    expect(prayerFormToPatch({ ...prayerFormValues(BASE), showInCalendar: true })).toMatchObject({
      show_prayers_in_calendar: true,
    });
    expect(prayerFormToPatch(prayerFormValues(BASE))).toMatchObject({ show_prayers_in_calendar: false });
  });

  it('is a plain boolean in the form schema', () => {
    expect(prayerFormSchema.safeParse({ ...prayerFormValues(BASE), showInCalendar: 'yes' }).success).toBe(false);
  });
});

describe('prayerFormToPatch', () => {
  it('writes the settings columns, trims the place name and leaves the on/off switch to the RPC', () => {
    const patch = prayerFormToPatch({ ...prayerFormValues(BASE), locationLabel: '  Tunis  ', ishaOffset: -2 });
    expect(patch).toMatchObject({ location_label: 'Tunis', isha_offset_min: -2, latitude: 36.8625, asr_factor: 1 });
    expect(patch).not.toHaveProperty('prayers_enabled');
    expect(patch).not.toHaveProperty('prayers_enabled_since');
  });
});

describe('prayerFormSchema', () => {
  const valid = prayerFormValues(BASE);

  it('mirrors the database bounds', () => {
    expect(prayerFormSchema.safeParse(valid).success).toBe(true);
    expect(prayerFormSchema.safeParse({ ...valid, latitude: 91 }).success).toBe(false);
    // Nearer the poles there are no prayer times to calculate.
    expect(prayerFormSchema.safeParse({ ...valid, latitude: 65.1 }).success).toBe(false);
    expect(prayerFormSchema.safeParse({ ...valid, latitude: -65 }).success).toBe(true);
    expect(prayerFormSchema.safeParse({ ...valid, longitude: -181 }).success).toBe(false);
    expect(prayerFormSchema.safeParse({ ...valid, fajrAngle: 9.9 }).success).toBe(false);
    expect(prayerFormSchema.safeParse({ ...valid, ishaAngle: 22.1 }).success).toBe(false);
    expect(prayerFormSchema.safeParse({ ...valid, asrFactor: 3 }).success).toBe(false);
    expect(prayerFormSchema.safeParse({ ...valid, fajrOffset: 61 }).success).toBe(false);
    expect(prayerFormSchema.safeParse({ ...valid, fajrOffset: -60 }).success).toBe(true);
    expect(prayerFormSchema.safeParse({ ...valid, prePrayerMinutes: 121 }).success).toBe(false);
    expect(prayerFormSchema.safeParse({ ...valid, prePrayerMinutes: 0 }).success).toBe(true);
    expect(prayerFormSchema.safeParse({ ...valid, prayerMaxSnoozes: 11 }).success).toBe(false);
    expect(prayerFormSchema.safeParse({ ...valid, prayerSnoozeMinutes: 0 }).success).toBe(false);
  });

  it('refuses a coordinate that is still half typed', () => {
    expect(prayerFormSchema.safeParse({ ...valid, latitude: Number.NaN }).success).toBe(false);
  });
});

describe('prayerPreview', () => {
  const NOW = new Date('2026-10-06T09:00:00.000Z');

  it("lists today's five times in the settings zone", () => {
    const rows = prayerPreview(prayerFormValues(BASE), 'Africa/Tunis', NOW);
    expect(rows?.map((row) => row.label)).toEqual(['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']);
    // Checked against the independent vectors (Aladhan, 2026-10-06): Fajr 04:53, Dhuhr 12:07, Maghrib 17:55, Isha 19:21.
    expect(rows?.find((row) => row.prayer === 'fajr')?.time).toBe('04:53');
    expect(rows?.find((row) => row.prayer === 'dhuhr')?.time).toBe('12:07');
    expect(rows?.find((row) => row.prayer === 'maghrib')?.time).toBe('17:55');
    expect(rows?.find((row) => row.prayer === 'isha')?.time).toBe('19:21');
  });

  it('follows an offset in the form before it is saved', () => {
    const rows = prayerPreview({ ...prayerFormValues(BASE), dhuhrOffset: 5 }, 'Africa/Tunis', NOW);
    expect(rows?.find((row) => row.prayer === 'dhuhr')?.time).toBe('12:12');
  });

  it('is null while a field is invalid', () => {
    expect(prayerPreview({ ...prayerFormValues(BASE), latitude: Number.NaN }, 'Africa/Tunis', NOW)).toBeNull();
    expect(prayerPreview({ ...prayerFormValues(BASE), fajrAngle: 99 }, 'Africa/Tunis', NOW)).toBeNull();
  });
});

describe('parseDecimal', () => {
  it('accepts plain decimals with a point or a comma and a leading minus', () => {
    expect(parseDecimal('36.8625')).toBe(36.8625);
    expect(parseDecimal(' 10,1956 ')).toBe(10.1956);
    expect(parseDecimal('-6.2')).toBe(-6.2);
    expect(parseDecimal('18')).toBe(18);
  });

  it('refuses anything else instead of guessing', () => {
    for (const text of ['', '-', '.', '1e3', '12abc', '1.2.3', '36°']) expect(parseDecimal(text), text).toBeNull();
  });
});

describe('roundCoordinates', () => {
  it('rounds to 4 decimals', () => {
    expect(roundCoordinates({ latitude: 36.862512345, longitude: 10.195649 })).toEqual({ latitude: 36.8625, longitude: 10.1956 });
  });
});
