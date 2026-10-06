import { formatInTimeZone } from 'date-fns-tz';
import { afterEach, describe, expect, it } from 'vitest';

import vectorFile from '../test-vectors/prayer-times.json';
import {
  DEFAULT_PRAYER_SETTINGS,
  PRAYER_NAMES,
  prayerOccurrencesBetween,
  prayerTimesOnDay,
  prePrayerLabel,
  previousPrayer,
  resetPrayerTimesCache,
  resolvePrayerConfig,
  unloggedPrayerLabel,
  type PrayerConfig,
} from './prayer-times';
import { dayNumberFromDateString } from './time-zone';
import type { PrayerName, PrayerSettings } from './types';

interface VectorCase {
  label: string;
  latitude: number;
  longitude: number;
  timezone: string;
  fajrAngle: number;
  ishaAngle: number;
  asrFactor: 1 | 2;
  date: string;
  expected: Record<PrayerName, string>;
  asrNoaa: string;
}

const file = vectorFile as unknown as {
  toleranceMinutes: { default: number; asr: number };
  cases: VectorCase[];
};

const MINUTE = 60_000;

function configFor(overrides: Partial<PrayerSettings> = {}): PrayerConfig {
  const config = resolvePrayerConfig({ ...DEFAULT_PRAYER_SETTINGS, prayers_enabled: true, ...overrides });
  if (config === null) throw new Error('prayers should be on');
  return config;
}

function minutesOfDay(clock: string): number {
  const [hours, minutes] = clock.split(':').map(Number);
  return hours! * 60 + minutes!;
}

/** Signed difference of two HH:mm clock times in minutes, across midnight. */
function clockDiff(a: string, b: string): number {
  let diff = minutesOfDay(a) - minutesOfDay(b);
  if (diff > 720) diff -= 1440;
  if (diff < -720) diff += 1440;
  return diff;
}

describe('prayer times against the independent vectors', () => {
  // Expected values come from the Aladhan API (fetched 2026-10-06), a separate implementation of the
  // calculation; see the file header. Asr is allowed 2 minutes: adhan reads the sun's declination at
  // solar noon, the exact value (asrNoaa, no adhan code) is up to 2 minutes away from it.
  for (const vector of file.cases) {
    it(`${vector.label} on ${vector.date}`, () => {
      const config = configFor({
        latitude: vector.latitude,
        longitude: vector.longitude,
        fajr_angle: vector.fajrAngle,
        isha_angle: vector.ishaAngle,
        asr_factor: vector.asrFactor,
      });
      const times = prayerTimesOnDay(config, dayNumberFromDateString(vector.date));
      for (const prayer of PRAYER_NAMES) {
        const local = formatInTimeZone(times[prayer], vector.timezone, 'HH:mm');
        const tolerance = prayer === 'asr' ? file.toleranceMinutes.asr : file.toleranceMinutes.default;
        expect(Math.abs(clockDiff(local, vector.expected[prayer])), `${prayer} ${local} vs ${vector.expected[prayer]}`).toBeLessThanOrEqual(tolerance);
      }
      // The exact value (no adhan code) is the better reference for Asr: adhan is within a minute of it.
      const asrLocal = formatInTimeZone(times.asr, vector.timezone, 'HH:mm');
      expect(Math.abs(clockDiff(asrLocal, vector.asrNoaa)), `asr ${asrLocal} vs exact ${vector.asrNoaa}`).toBeLessThanOrEqual(1);
    });
  }

  it('covers both solstices and a DST change in Ariana and Madrid', () => {
    const dates = file.cases.map((vector) => `${vector.label.slice(0, 6)} ${vector.date}`);
    expect(dates).toContain('Ariana 2026-06-21');
    expect(dates).toContain('Ariana 2026-12-21');
    expect(dates).toContain('Madrid 2026-03-29');
    expect(dates).toContain('Madrid 2026-10-25');
  });
});

describe('prayerTimesOnDay', () => {
  afterEach(() => {
    delete process.env['TZ'];
    resetPrayerTimesCache();
  });

  it('gives the five prayers in order', () => {
    const times = prayerTimesOnDay(configFor(), dayNumberFromDateString('2026-10-06'));
    const instants = PRAYER_NAMES.map((name) => times[name].getTime());
    expect([...instants].sort((a, b) => a - b)).toEqual(instants);
  });

  it('does not depend on the zone of the machine', () => {
    const day = dayNumberFromDateString('2026-06-21');
    const results = ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'].map((zone) => {
      process.env['TZ'] = zone;
      resetPrayerTimesCache();
      const times = prayerTimesOnDay(configFor(), day);
      return PRAYER_NAMES.map((name) => times[name].toISOString());
    });
    for (const result of results) expect(result).toEqual(results[0]);
  });

  it('puts every time on the right local day for a location far from Greenwich', () => {
    const config = configFor({ latitude: -36.8485, longitude: 174.7633, fajr_angle: 18, isha_angle: 17 });
    const day = dayNumberFromDateString('2026-06-21');
    const times = prayerTimesOnDay(config, day);
    for (const name of PRAYER_NAMES) {
      const local = formatInTimeZone(times[name], 'Pacific/Auckland', 'yyyy-MM-dd');
      expect(local, name).toBe('2026-06-21');
    }
    const far = configFor({ latitude: 34.0522, longitude: -118.2437, fajr_angle: 15, isha_angle: 15 });
    for (const name of PRAYER_NAMES) {
      expect(formatInTimeZone(prayerTimesOnDay(far, day)[name], 'America/Los_Angeles', 'yyyy-MM-dd'), name).toBe('2026-06-21');
    }
  });

  it('moves a prayer by its offset', () => {
    const day = dayNumberFromDateString('2026-10-06');
    const plain = prayerTimesOnDay(configFor(), day);
    const shifted = prayerTimesOnDay(configFor({ fajr_offset_min: 10, isha_offset_min: -5 }), day);
    expect(shifted.fajr.getTime() - plain.fajr.getTime()).toBe(10 * MINUTE);
    expect(shifted.isha.getTime() - plain.isha.getTime()).toBe(-5 * MINUTE);
    expect(shifted.dhuhr.getTime()).toBe(plain.dhuhr.getTime());
  });

  it('makes Asr later with the Hanafi shadow factor and leaves the rest alone', () => {
    const day = dayNumberFromDateString('2026-06-21');
    const shafi = prayerTimesOnDay(configFor({ asr_factor: 1 }), day);
    const hanafi = prayerTimesOnDay(configFor({ asr_factor: 2 }), day);
    expect(hanafi.asr.getTime()).toBeGreaterThan(shafi.asr.getTime() + 30 * MINUTE);
    expect(hanafi.dhuhr.getTime()).toBe(shafi.dhuhr.getTime());
  });
});

describe('resolvePrayerConfig', () => {
  it('is null while prayers are off or the field is absent', () => {
    expect(resolvePrayerConfig({})).toBeNull();
    expect(resolvePrayerConfig({ prayers_enabled: false })).toBeNull();
  });

  it('fills the Ariana defaults for absent fields', () => {
    const config = resolvePrayerConfig({ prayers_enabled: true });
    expect(config).toMatchObject({
      latitude: 36.8625,
      longitude: 10.1956,
      fajrAngle: 18,
      ishaAngle: 18,
      asrFactor: 1,
      prePrayerMinutes: 15,
      maxSnoozes: 0,
      enabledSinceMs: null,
    });
  });

  it.each([
    ['latitude', { latitude: 91 }],
    ['a latitude near the poles', { latitude: 66 }],
    ['longitude', { longitude: -181 }],
    ['fajr_angle', { fajr_angle: 5 }],
    ['isha_angle', { isha_angle: 30 }],
    ['asr_factor', { asr_factor: 3 as unknown as 1 }],
    ['an offset', { dhuhr_offset_min: 61 }],
    ['pre_prayer_minutes', { pre_prayer_minutes: -1 }],
    ['a NaN', { latitude: Number.NaN }],
  ])('refuses %s outside the bounds the database enforces', (_name, overrides) => {
    expect(() => resolvePrayerConfig({ prayers_enabled: true, ...overrides })).toThrow(RangeError);
  });
});

describe('prayerOccurrencesBetween', () => {
  const TUNIS = 'Africa/Tunis';

  it('lists one prayer per day over a range, in the half-open interval', () => {
    const config = configFor();
    const from = new Date('2026-10-05T22:00:00.000Z');
    const to = new Date('2026-10-08T22:00:00.000Z');
    const fajr = prayerOccurrencesBetween('prayer', 'fajr', config, from, to, TUNIS);
    expect(fajr).toHaveLength(3);
    // Exactly at `from` counts, exactly at `to` does not.
    const exact = prayerOccurrencesBetween('prayer', 'fajr', config, fajr[0]!, fajr[2]!, TUNIS);
    expect(exact.map((at) => at.getTime())).toEqual([fajr[0]!.getTime(), fajr[1]!.getTime()]);
  });

  it('puts the pre-prayer alarm the configured minutes before the prayer', () => {
    const config = configFor({ pre_prayer_minutes: 20 });
    const from = new Date('2026-10-06T00:00:00.000Z');
    const to = new Date('2026-10-07T00:00:00.000Z');
    const prayer = prayerOccurrencesBetween('prayer', 'asr', config, from, to, TUNIS);
    const pre = prayerOccurrencesBetween('pre_prayer', 'asr', config, from, to, TUNIS);
    expect(prayer).toHaveLength(1);
    expect(prayer[0]!.getTime() - pre[0]!.getTime()).toBe(20 * MINUTE);
  });

  it('has no pre-prayer alarms when the lead is 0', () => {
    const config = configFor({ pre_prayer_minutes: 0 });
    const from = new Date('2026-10-06T00:00:00.000Z');
    const to = new Date('2026-10-20T00:00:00.000Z');
    expect(prayerOccurrencesBetween('pre_prayer', 'isha', config, from, to, TUNIS)).toEqual([]);
    expect(prayerOccurrencesBetween('prayer', 'isha', config, from, to, TUNIS)).toHaveLength(14);
  });

  it('finds a pre-prayer alarm that lands before the range start day boundary', () => {
    // Fajr plus a 120 minute lead can fall on the previous local date; the day widening keeps it.
    const config = configFor({ pre_prayer_minutes: 120 });
    const from = new Date('2026-06-21T00:00:00.000Z');
    const to = new Date('2026-06-22T00:00:00.000Z');
    const pre = prayerOccurrencesBetween('pre_prayer', 'fajr', config, from, to, TUNIS);
    expect(pre).toHaveLength(1);
  });

  it('stays correct across the DST change of a zone that has one', () => {
    const config = configFor({ latitude: 40.4168, longitude: -3.7038 });
    const from = new Date('2026-03-28T00:00:00.000Z');
    const to = new Date('2026-04-01T00:00:00.000Z');
    const dhuhr = prayerOccurrencesBetween('prayer', 'dhuhr', config, from, to, 'Europe/Madrid');
    expect(dhuhr.map((at) => formatInTimeZone(at, 'Europe/Madrid', 'HH:mm'))).toEqual(['13:20', '14:20', '14:19', '14:19']);
  });
});

describe('previousPrayer', () => {
  const TUNIS = 'Africa/Tunis';
  const day = dayNumberFromDateString('2026-10-06');

  it('is the prayer before it on the same day', () => {
    const config = configFor();
    const times = prayerTimesOnDay(config, day);
    expect(previousPrayer(config, 'dhuhr', times.dhuhr, TUNIS)).toEqual({ prayer: 'fajr', at: times.fajr });
    expect(previousPrayer(config, 'isha', times.isha, TUNIS)).toEqual({ prayer: 'maghrib', at: times.maghrib });
  });

  it('is the previous day Isha for Fajr', () => {
    const config = configFor();
    const fajr = prayerTimesOnDay(config, day).fajr;
    const previousIsha = prayerTimesOnDay(config, day - 1).isha;
    expect(previousPrayer(config, 'fajr', fajr, TUNIS)).toEqual({ prayer: 'isha', at: previousIsha });
  });

  it('is null for an instant that is not a time of that prayer', () => {
    const config = configFor();
    expect(previousPrayer(config, 'asr', new Date('2026-10-06T12:00:00.000Z'), TUNIS)).toBeNull();
  });
});

describe('alarm texts', () => {
  it('says how long is left before the prayer', () => {
    expect(prePrayerLabel('isha', 15)).toBe('Isha in 15 min');
    expect(prePrayerLabel('maghrib', 30)).toBe('Maghrib in 30 min');
  });

  it('names the previous prayer and how long it has', () => {
    expect(unloggedPrayerLabel('dhuhr', 'asr')).toBe("You haven't logged Dhuhr — you have until Asr");
    expect(unloggedPrayerLabel('isha', 'fajr')).toBe("You haven't logged Isha — you have until Fajr");
  });

  it('says Fajr ended at sunrise, which is before the Dhuhr reminder', () => {
    expect(unloggedPrayerLabel('fajr', 'dhuhr')).toBe("You haven't logged Fajr — its time ended at sunrise");
  });
});
