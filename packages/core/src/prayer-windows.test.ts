import { formatInTimeZone } from 'date-fns-tz';
import { describe, expect, it } from 'vitest';

import vectorFile from '../test-vectors/prayer-times.json';
import {
  DEFAULT_PRAYER_SETTINGS,
  PRAYER_FINAL_CALL_MINUTES,
  PRAYER_LATER_MINUTES,
  PRAYER_NAMES,
  prayerDayOf,
  prayerDeferralChoices,
  prayerFinalCallAt,
  prayerOccurrencesBetween,
  prayerTimesOnDay,
  prayerWindowEnd,
  resolvePrayerConfig,
  type PrayerConfig,
} from './prayer-times';
import { expandSchedule } from './schedule';
import { dayNumberFromDateString } from './time-zone';
import type { EventRow, PrayerName, PrayerSettings } from './types';

const MINUTE = 60_000;
const TUNIS = 'Africa/Tunis';

function configFor(overrides: Partial<PrayerSettings> = {}): PrayerConfig {
  const config = resolvePrayerConfig({ ...DEFAULT_PRAYER_SETTINGS, prayers_enabled: true, ...overrides });
  if (config === null) throw new Error('prayers should be on');
  return config;
}

function windowOf(config: PrayerConfig, prayer: PrayerName, date: string, tz: string): Date | null {
  const at = prayerTimesOnDay(config, dayNumberFromDateString(date))[prayer];
  return prayerWindowEnd(config, prayer, at, tz);
}

/** The Islamic midnight the way the spec states it, from the day's own times. */
function expectedMidnight(config: PrayerConfig, date: string): number {
  const day = dayNumberFromDateString(date);
  const maghrib = prayerTimesOnDay(config, day).maghrib.getTime();
  const nextFajr = prayerTimesOnDay(config, day + 1).fajr.getTime();
  return Math.floor((maghrib + (nextFajr - maghrib) / 2) / MINUTE) * MINUTE;
}

describe('sunrise and midnight against the independent vectors', () => {
  // Aladhan (midnightMode=1, halfway from Maghrib to the next Fajr), see the vector file's source note. Midnight
  // is the midpoint of two rounded times, so it gets 2 minutes (Aladhan itself is a minute or two off the exact midpoint on 2026-03-29).
  const cases = (vectorFile as unknown as {
    cases: Array<{
      label: string;
      latitude: number;
      longitude: number;
      timezone: string;
      fajrAngle: number;
      ishaAngle: number;
      asrFactor: 1 | 2;
      date: string;
      expected: { sunrise: string; midnight: string };
    }>;
  }).cases;

  const minutesOfDay = (clock: string): number => {
    const [hours, minutes] = clock.split(':').map(Number);
    return hours! * 60 + minutes!;
  };
  const clockDiff = (a: string, b: string): number => {
    let diff = minutesOfDay(a) - minutesOfDay(b);
    if (diff > 720) diff -= 1440;
    if (diff < -720) diff += 1440;
    return diff;
  };

  for (const vector of cases) {
    it(`${vector.label} on ${vector.date}`, () => {
      const config = configFor({
        latitude: vector.latitude,
        longitude: vector.longitude,
        fajr_angle: vector.fajrAngle,
        isha_angle: vector.ishaAngle,
        asr_factor: vector.asrFactor,
      });
      const times = prayerTimesOnDay(config, dayNumberFromDateString(vector.date));
      const sunrise = formatInTimeZone(times.sunrise, vector.timezone, 'HH:mm');
      expect(Math.abs(clockDiff(sunrise, vector.expected.sunrise)), `sunrise ${sunrise}`).toBeLessThanOrEqual(1);
      const end = prayerWindowEnd(config, 'isha', times.isha, vector.timezone);
      const midnight = formatInTimeZone(end!, vector.timezone, 'HH:mm');
      expect(Math.abs(clockDiff(midnight, vector.expected.midnight)), `midnight ${midnight}`).toBeLessThanOrEqual(2);
    });
  }
});

describe('prayerWindowEnd', () => {
  it('ends each prayer at the next one, Fajr at sunrise and Isha at the Islamic midnight', () => {
    const config = configFor();
    const times = prayerTimesOnDay(config, dayNumberFromDateString('2026-10-06'));
    expect(windowOf(config, 'fajr', '2026-10-06', TUNIS)).toEqual(times.sunrise);
    expect(windowOf(config, 'dhuhr', '2026-10-06', TUNIS)).toEqual(times.asr);
    expect(windowOf(config, 'asr', '2026-10-06', TUNIS)).toEqual(times.maghrib);
    expect(windowOf(config, 'maghrib', '2026-10-06', TUNIS)).toEqual(times.isha);
    expect(windowOf(config, 'isha', '2026-10-06', TUNIS)?.getTime()).toBe(expectedMidnight(config, '2026-10-06'));
  });

  it('floors the midnight to the minute', () => {
    const end = windowOf(configFor(), 'isha', '2026-10-06', TUNIS)!;
    expect(end.getTime() % MINUTE).toBe(0);
  });

  it('gives every prayer a window of a sensible length on both solstices in Ariana', () => {
    const config = configFor();
    for (const date of ['2026-06-21', '2026-12-21']) {
      for (const prayer of PRAYER_NAMES) {
        const at = prayerTimesOnDay(config, dayNumberFromDateString(date))[prayer];
        const end = prayerWindowEnd(config, prayer, at, TUNIS)!;
        const minutes = (end.getTime() - at.getTime()) / MINUTE;
        expect(minutes, `${prayer} ${date}`).toBeGreaterThan(30);
        expect(minutes, `${prayer} ${date}`).toBeLessThan(8 * 60);
      }
    }
  });

  it('stays an absolute instant across a DST change in Madrid', () => {
    const madrid = configFor({ latitude: 40.4168, longitude: -3.7038 });
    for (const date of ['2026-03-28', '2026-03-29', '2026-10-24', '2026-10-25']) {
      const end = windowOf(madrid, 'isha', date, 'Europe/Madrid')!;
      expect(end.getTime(), date).toBe(expectedMidnight(madrid, date));
      expect(prayerDayOf(madrid, 'isha', prayerTimesOnDay(madrid, dayNumberFromDateString(date)).isha, 'Europe/Madrid')).toBe(
        dayNumberFromDateString(date)
      );
    }
    // Dhuhr's window ends at that day's Asr, an hour later on the clock after the change.
    const dhuhrBefore = windowOf(madrid, 'dhuhr', '2026-03-28', 'Europe/Madrid')!;
    const dhuhrAfter = windowOf(madrid, 'dhuhr', '2026-03-29', 'Europe/Madrid')!;
    const clockHours = (date: Date): number => Number(formatInTimeZone(date, 'Europe/Madrid', 'H'));
    expect(clockHours(dhuhrAfter) - clockHours(dhuhrBefore)).toBe(1);
  });

  it('lands the Isha midnight on the next local date far east of UTC and still on the same date far west', () => {
    const auckland = configFor({ latitude: -36.8485, longitude: 174.7633, isha_angle: 17 });
    const end = windowOf(auckland, 'isha', '2026-12-21', 'Pacific/Auckland')!;
    expect(end.getTime()).toBe(expectedMidnight(auckland, '2026-12-21'));
    expect(formatInTimeZone(end, 'Pacific/Auckland', 'yyyy-MM-dd')).toBe('2026-12-22');
    const losAngeles = configFor({ latitude: 34.0522, longitude: -118.2437, fajr_angle: 15, isha_angle: 15 });
    const west = windowOf(losAngeles, 'isha', '2026-12-21', 'America/Los_Angeles')!;
    expect(west.getTime()).toBe(expectedMidnight(losAngeles, '2026-12-21'));
    expect(formatInTimeZone(west, 'America/Los_Angeles', 'yyyy-MM-dd HH')).toMatch(/^2026-12-21 2[0-3]$/);
  });

  it('keeps an Isha pushed past local midnight by an offset with its own prayer-day (+5:30 zone)', () => {
    // Ariana's Isha is 23:16 in India; an hour's offset puts it at 00:16 the next date.
    const config = configFor({ isha_offset_min: 60 });
    const tz = 'Asia/Kolkata';
    const day = dayNumberFromDateString('2026-01-01');
    const isha = prayerTimesOnDay(config, day).isha;
    expect(formatInTimeZone(isha, tz, 'yyyy-MM-dd')).toBe('2026-01-02');
    expect(prayerDayOf(config, 'isha', isha, tz)).toBe(day);
    const end = prayerWindowEnd(config, 'isha', isha, tz)!;
    expect(end.getTime()).toBe(expectedMidnight(config, '2026-01-01'));
    expect(end.getTime()).toBeGreaterThan(isha.getTime());
  });

  it('is null when the offsets leave no usable window, and the schedule then carries none', () => {
    // Maghrib an hour later and Isha an hour earlier: Isha comes before Maghrib.
    const config = configFor({ maghrib_offset_min: 60, isha_offset_min: -60 });
    expect(windowOf(config, 'maghrib', '2026-10-06', TUNIS)).toBeNull();
    // The other prayers keep theirs.
    expect(windowOf(config, 'dhuhr', '2026-10-06', TUNIS)).not.toBeNull();
  });
});

describe('prayerFinalCallAt', () => {
  const at = new Date('2026-10-06T12:00:00.000Z');
  const after = (minutes: number): Date => new Date(at.getTime() + minutes * MINUTE);

  it('rings 20 minutes before the window ends', () => {
    expect(prayerFinalCallAt(at, after(180)).getTime()).toBe(after(160).getTime());
    expect(PRAYER_FINAL_CALL_MINUTES).toBe(20);
  });

  it('is exactly 20 minutes at a window of 40 and half the window below that', () => {
    expect(prayerFinalCallAt(at, after(40)).getTime()).toBe(after(20).getTime());
    expect(prayerFinalCallAt(at, after(30)).getTime()).toBe(after(15).getTime());
    expect(prayerFinalCallAt(at, after(10)).getTime()).toBe(after(5).getTime());
  });
});

describe('prayerDeferralChoices', () => {
  const at = new Date('2026-10-06T12:00:00.000Z').getTime();
  const end = at + 180 * MINUTE;
  const choices = (minutesLeft: number, lastCall = false): ReturnType<typeof prayerDeferralChoices> =>
    prayerDeferralChoices(at, end, end - minutesLeft * MINUTE, lastCall);

  it('offers +20, +40 and +60 while they end 10 minutes before the window does', () => {
    expect([...PRAYER_LATER_MINUTES]).toEqual([20, 40, 60]);
    expect(choices(170).laterMinutes).toEqual([20, 40, 60]);
    expect(choices(70).laterMinutes).toEqual([20, 40, 60]);
    expect(choices(69).laterMinutes).toEqual([20, 40]);
  });

  it('shrinks near the end: 50 minutes left offers 20 and 40, 25 minutes left offers nothing', () => {
    expect(choices(50).laterMinutes).toEqual([20, 40]);
    expect(choices(30).laterMinutes).toEqual([20]);
    expect(choices(29).laterMinutes).toEqual([]);
    expect(choices(25).laterMinutes).toEqual([]);
    expect(choices(0).laterMinutes).toEqual([]);
  });

  it("makes Can't now wait for the last call, until a minute before it", () => {
    // The last call is 20 minutes before the end.
    expect(choices(100).cantNow).toBe('until_last_call');
    expect(choices(22).cantNow).toBe('until_last_call');
    expect(choices(21).cantNow).toBe('give_up');
    expect(choices(20).cantNow).toBe('give_up');
    expect(choices(5).cantNow).toBe('give_up');
  });

  it("gives up at once when this ring is the last call, whatever the clock says", () => {
    expect(choices(100, true).cantNow).toBe('give_up');
  });

  it('uses half the window for a short one', () => {
    const shortEnd = at + 30 * MINUTE;
    // Last call at 15 minutes in; 17 minutes in is still two minutes... one minute before it is give_up.
    expect(prayerDeferralChoices(at, shortEnd, at + 10 * MINUTE, false).cantNow).toBe('until_last_call');
    expect(prayerDeferralChoices(at, shortEnd, at + 14 * MINUTE, false).cantNow).toBe('give_up');
  });
});

describe('the Fajr reminder skip', () => {
  const from = new Date('2026-10-06T00:00:00.000Z');
  const to = new Date('2026-10-09T00:00:00.000Z');

  it('drops only the Fajr reminder when it is on', () => {
    const on = configFor({ pre_prayer_skip_fajr: true });
    expect(prayerOccurrencesBetween('pre_prayer', 'fajr', on, from, to, TUNIS)).toEqual([]);
    expect(prayerOccurrencesBetween('pre_prayer', 'dhuhr', on, from, to, TUNIS)).toHaveLength(3);
    expect(prayerOccurrencesBetween('prayer', 'fajr', on, from, to, TUNIS)).toHaveLength(3);
  });

  it('keeps it when it is off, and when the field is absent from an older settings object', () => {
    const off = configFor({ pre_prayer_skip_fajr: false });
    expect(prayerOccurrencesBetween('pre_prayer', 'fajr', off, from, to, TUNIS)).toHaveLength(3);
    const { pre_prayer_skip_fajr: _skipped, ...older } = DEFAULT_PRAYER_SETTINGS;
    const config = resolvePrayerConfig({ ...older, prayers_enabled: true })!;
    expect(config.skipFajrReminder).toBe(false);
    expect(prayerOccurrencesBetween('pre_prayer', 'fajr', config, from, to, TUNIS)).toHaveLength(3);
  });

  it('defaults to on for new settings', () => {
    expect(DEFAULT_PRAYER_SETTINGS.pre_prayer_skip_fajr).toBe(true);
  });
});

describe('windowEnd in the schedule', () => {
  const USER = '99999999-9999-4999-8999-999999999999';
  const NOW = new Date('2026-10-06T09:00:00.000Z');

  function event(id: string, kind: 'prayer' | 'pre_prayer' | 'normal', prayer?: PrayerName): EventRow {
    return {
      id,
      user_id: USER,
      title: id,
      notes: null,
      start_at: '2026-10-06T10:00:00.000Z',
      duration_min: 15,
      repeat_unit: 'day',
      repeat_interval: 1,
      repeat_weekdays: null,
      ends_at: null,
      max_snoozes: 1,
      snooze_minutes: 5,
      passable: false,
      color: null,
      active: true,
      updated_at: NOW.toISOString(),
      kind,
      ...(prayer === undefined ? {} : { prayer }),
    };
  }

  const settings = {
    user_id: USER,
    timezone: TUNIS,
    week_starts_on: 0 as const,
    refire_seconds: 120,
    pass_cap: 2,
    grace_minutes: 30,
    ...DEFAULT_PRAYER_SETTINGS,
    prayers_enabled: true,
    prayers_enabled_since: '2026-09-01T00:00:00.000Z',
    pre_prayer_skip_fajr: false,
  };

  it('sets it on prayer occurrences only, equal to prayerWindowEnd', () => {
    const events = [
      ...PRAYER_NAMES.map((prayer) => event(`prayer-${prayer}`, 'prayer', prayer)),
      ...PRAYER_NAMES.map((prayer) => event(`pre-${prayer}`, 'pre_prayer', prayer)),
      event('normal', 'normal'),
    ];
    const config = resolvePrayerConfig(settings)!;
    const result = expandSchedule({ events, cheatDays: [], settings, completions: [], now: NOW, horizonDays: 3 });
    for (const occurrence of result.occurrences) {
      if (occurrence.eventId.startsWith('prayer-')) {
        const prayer = occurrence.eventId.slice('prayer-'.length) as PrayerName;
        const expected = prayerWindowEnd(config, prayer, new Date(occurrence.at), TUNIS);
        expect(occurrence.windowEnd, occurrence.id).toBe(expected?.toISOString());
        expect(Date.parse(occurrence.windowEnd!)).toBeGreaterThan(Date.parse(occurrence.at));
        expect(Date.parse(occurrence.windowEnd!) - Date.parse(occurrence.at)).toBeLessThanOrEqual(24 * 60 * MINUTE);
      } else {
        expect(occurrence.windowEnd, occurrence.id).toBeUndefined();
      }
    }
    expect(result.occurrences.some((occurrence) => occurrence.windowEnd !== undefined)).toBe(true);
  });

  it('leaves the Fajr reminder out of the list when the skip is on', () => {
    const events = [event('pre-fajr', 'pre_prayer', 'fajr'), event('pre-dhuhr', 'pre_prayer', 'dhuhr')];
    const result = expandSchedule({
      events,
      cheatDays: [],
      settings: { ...settings, pre_prayer_skip_fajr: true },
      completions: [],
      now: NOW,
      horizonDays: 3,
    });
    expect(result.occurrences.some((occurrence) => occurrence.eventId === 'pre-fajr')).toBe(false);
    expect(result.occurrences.some((occurrence) => occurrence.eventId === 'pre-dhuhr')).toBe(true);
  });
});
