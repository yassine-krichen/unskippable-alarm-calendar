import type { Settings } from '@alarm-calendar/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fake } from '@/test/fake-supabase';

vi.mock('@/lib/supabase', async () => {
  const { fakeClient } = await import('@/test/fake-supabase');
  return { supabase: fakeClient };
});

import { holidayFormSchema, holidayFormToPatch, holidayFormValues } from './holiday-settings';
import { fetchSettings, updateSettings } from './settings-api';

const BASE: Settings = {
  user_id: 'u1',
  timezone: 'Africa/Tunis',
  week_starts_on: 0,
  refire_seconds: 120,
  pass_cap: 2,
  grace_minutes: 30,
};

describe('holidayFormValues', () => {
  it('starts with no holidays for a row without the columns', () => {
    expect(holidayFormValues(BASE)).toEqual({ holidayCountry: '', islamicHolidays: false, hijriOffset: 0 });
  });

  it('reads the stored values', () => {
    const settings = { ...BASE, holiday_country: 'TN', islamic_holidays: true, hijri_offset_days: -1 };
    expect(holidayFormValues(settings)).toEqual({ holidayCountry: 'TN', islamicHolidays: true, hijriOffset: -1 });
  });
});

describe('holidayFormToPatch', () => {
  it('writes none as null and keeps the rest', () => {
    expect(holidayFormToPatch({ holidayCountry: '', islamicHolidays: true, hijriOffset: 2 })).toEqual({
      holiday_country: null,
      islamic_holidays: true,
      hijri_offset_days: 2,
    });
    expect(holidayFormToPatch({ holidayCountry: 'TN', islamicHolidays: false, hijriOffset: 0 }).holiday_country).toBe('TN');
  });
});

describe('holidayFormSchema', () => {
  it('accepts none, a two-letter code and an adjustment of two days either way', () => {
    for (const hijriOffset of [-2, 0, 2]) {
      expect(holidayFormSchema.safeParse({ holidayCountry: 'TN', islamicHolidays: true, hijriOffset }).success).toBe(true);
    }
    expect(holidayFormSchema.safeParse({ holidayCountry: '', islamicHolidays: false, hijriOffset: 0 }).success).toBe(true);
  });

  it('rejects what the database would', () => {
    expect(holidayFormSchema.safeParse({ holidayCountry: 'tn', islamicHolidays: false, hijriOffset: 0 }).success).toBe(false);
    expect(holidayFormSchema.safeParse({ holidayCountry: 'TUN', islamicHolidays: false, hijriOffset: 0 }).success).toBe(false);
    expect(holidayFormSchema.safeParse({ holidayCountry: 'TN', islamicHolidays: false, hijriOffset: 3 }).success).toBe(false);
    expect(holidayFormSchema.safeParse({ holidayCountry: 'TN', islamicHolidays: false, hijriOffset: -3 }).success).toBe(false);
    expect(holidayFormSchema.safeParse({ holidayCountry: 'TN', islamicHolidays: false, hijriOffset: 0.5 }).success).toBe(false);
  });
});

describe('the holiday columns in the settings API', () => {
  beforeEach(() => {
    fake.reset();
    fake.responses['update:settings'] = { data: BASE, error: null };
  });

  it('updates them with a plain UPDATE, a cleared country going out as null', async () => {
    await updateSettings('u1', { holiday_country: null, islamic_holidays: true, hijri_offset_days: 1 });
    expect(fake.names()).toEqual(['update:settings']);
    expect(fake.payloadOf('update:settings')).toEqual({ holiday_country: null, islamic_holidays: true, hijri_offset_days: 1 });
  });

  it('selects them with the rest of the row', async () => {
    fake.responses['select:settings'] = { data: BASE, error: null };
    await fetchSettings();
    expect(String(fake.payloadOf('select:settings'))).toMatch(/holiday_country, islamic_holidays, hijri_offset_days/);
  });
});
