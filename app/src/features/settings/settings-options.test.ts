import { describe, expect, it } from 'vitest';

import { shouldAdoptDeviceTimeZone } from './device-timezone';
import { holidayFormValues } from './holiday-settings';
import { prayerFormValues } from './prayer-settings';
import {
  GRACE_OPTIONS,
  REFIRE_OPTIONS,
  listTimeZones,
  seconds,
  settingsFormSchema,
  withCurrentOption,
} from './settings-options';

describe('shouldAdoptDeviceTimeZone', () => {
  it('adopts the device zone while settings hold the UTC default and the wallet is not anchored', () => {
    expect(shouldAdoptDeviceTimeZone('UTC', 'Africa/Tunis', false)).toBe(true);
  });

  it('never overwrites UTC once the wallet is anchored: that is a choice, not a default', () => {
    expect(shouldAdoptDeviceTimeZone('UTC', 'Africa/Tunis', true)).toBe(false);
  });

  it('never overwrites a zone the person already chose', () => {
    expect(shouldAdoptDeviceTimeZone('Europe/Berlin', 'Africa/Tunis', false)).toBe(false);
  });

  it('does nothing when the device is on UTC, unknown, or reports a bogus name', () => {
    expect(shouldAdoptDeviceTimeZone('UTC', 'UTC', false)).toBe(false);
    expect(shouldAdoptDeviceTimeZone('UTC', null, false)).toBe(false);
    expect(shouldAdoptDeviceTimeZone('UTC', 'Mars/Olympus', false)).toBe(false);
  });
});

describe('withCurrentOption', () => {
  it('leaves the presets alone when the stored value is one of them', () => {
    expect(withCurrentOption(REFIRE_OPTIONS, 120, seconds)).toEqual([...REFIRE_OPTIONS]);
  });

  it('adds an unusual stored value in order so the picker never shows blank', () => {
    const options = withCurrentOption(REFIRE_OPTIONS, 90, seconds);
    expect(options.map((option) => option.value)).toEqual([30, 60, 90, 120, 180, 300, 600]);
    expect(options.find((option) => option.value === 90)?.label).toBe('90 seconds');
  });

  it('offers a no-grace choice for the late alarm window', () => {
    expect(GRACE_OPTIONS.some((option) => option.value === 0)).toBe(true);
  });
});

describe('listTimeZones', () => {
  it('always includes UTC and the current zone, without duplicates', () => {
    const zones = listTimeZones('Africa/Tunis');
    expect(zones).toContain('UTC');
    expect(zones).toContain('Africa/Tunis');
    expect(new Set(zones).size).toBe(zones.length);
  });
});

describe('settingsFormSchema', () => {
  const valid = {
    timezone: 'Africa/Tunis',
    weekStartsOn: 0,
    refireSeconds: 120,
    graceMinutes: 30,
    ...prayerFormValues({ user_id: 'u1', timezone: 'Africa/Tunis', week_starts_on: 0, refire_seconds: 120, pass_cap: 2, grace_minutes: 30 }),
    ...holidayFormValues({ user_id: 'u1', timezone: 'Africa/Tunis', week_starts_on: 0, refire_seconds: 120, pass_cap: 2, grace_minutes: 30 }),
  };

  it('mirrors the database checks', () => {
    expect(settingsFormSchema.safeParse(valid).success).toBe(true);
    expect(settingsFormSchema.safeParse({ ...valid, weekStartsOn: 7 }).success).toBe(false);
    expect(settingsFormSchema.safeParse({ ...valid, refireSeconds: 0 }).success).toBe(false);
    expect(settingsFormSchema.safeParse({ ...valid, graceMinutes: -1 }).success).toBe(false);
    expect(settingsFormSchema.safeParse({ ...valid, graceMinutes: 0 }).success).toBe(true);
  });
});
