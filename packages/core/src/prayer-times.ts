import { CalculationMethod, Coordinates, Madhab, PrayerTimes } from 'adhan';

import { toWallClock } from './time-zone';
import type { PrayerName, PrayerSettings } from './types';

/**
 * Prayer times (roadmap v2, phase 3b), computed offline with `adhan` (batoulapps/adhan-js, MIT, the
 * library the Kotlin twin of this code will use on Android). The method is a custom one: a Fajr
 * angle, an Isha angle and the Asr shadow factor, plus a per-prayer offset in minutes. Nothing here
 * reads the machine's time zone: a calendar date goes in and absolute instants come out.
 */

export const PRAYER_NAMES: readonly PrayerName[] = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];

export const PRAYER_LABELS: Readonly<Record<PrayerName, string>> = {
  fajr: 'Fajr',
  dhuhr: 'Dhuhr',
  asr: 'Asr',
  maghrib: 'Maghrib',
  isha: 'Isha',
};

/**
 * Ariana, Tunis, with the Tunisian ministry's angles (Fajr 18, Isha 18) and the Maliki/Shafi Asr.
 * The same values are the column defaults of the prayer_times migration.
 */
export const DEFAULT_PRAYER_SETTINGS: Readonly<PrayerSettings> = {
  prayers_enabled: false,
  prayers_enabled_since: null,
  latitude: 36.8625,
  longitude: 10.1956,
  location_label: 'Ariana, Tunisia',
  fajr_angle: 18,
  isha_angle: 18,
  asr_factor: 1,
  fajr_offset_min: 0,
  dhuhr_offset_min: 0,
  asr_offset_min: 0,
  maghrib_offset_min: 0,
  isha_offset_min: 0,
  pre_prayer_minutes: 15,
  prayer_max_snoozes: 0,
  prayer_snooze_minutes: 5,
};

/** The same bounds the database checks (migration prayer_times). */
export const PRAYER_LIMITS = {
  // Beyond about 65 degrees the sun can fail to rise or set in summer, where prayer times are not a
  // simple calculation any more (and adhan has no answer for the polar day).
  latitude: { min: -65, max: 65 },
  angle: { min: 10, max: 22 },
  offsetMin: { min: -60, max: 60 },
  prePrayerMinutes: { min: 0, max: 120 },
  maxSnoozes: { min: 0, max: 10 },
  snoozeMinutes: { min: 1, max: 120 },
} as const;

export interface PrayerConfig {
  latitude: number;
  longitude: number;
  fajrAngle: number;
  ishaAngle: number;
  asrFactor: 1 | 2;
  offsetsMin: Readonly<Record<PrayerName, number>>;
  /** 0 means no pre-prayer alarms. */
  prePrayerMinutes: number;
  maxSnoozes: number;
  snoozeMinutes: number;
  /** Prayers before this instant do not count (null: all count). */
  enabledSinceMs: number | null;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

function inRange(name: string, value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

/**
 * The prayer configuration in settings, or null when prayers are off (the field is absent or
 * false). Absent fields take the Ariana defaults. Throws RangeError on a value outside the bounds
 * the database enforces, so a corrupted cache cannot produce nonsense times.
 */
export function resolvePrayerConfig(settings: Partial<PrayerSettings>): PrayerConfig | null {
  if (settings.prayers_enabled !== true) return null;
  const d = DEFAULT_PRAYER_SETTINGS;
  const { latitude, angle, offsetMin, prePrayerMinutes, maxSnoozes, snoozeMinutes } = PRAYER_LIMITS;
  const asrFactor = settings.asr_factor ?? d.asr_factor;
  if (asrFactor !== 1 && asrFactor !== 2) throw new RangeError(`asr_factor must be 1 or 2, got ${asrFactor}`);
  const sinceMs = settings.prayers_enabled_since ? Date.parse(settings.prayers_enabled_since) : Number.NaN;
  const offset = (name: string, value: number | undefined): number =>
    inRange(name, value ?? 0, offsetMin.min, offsetMin.max);
  return {
    latitude: inRange('latitude', settings.latitude ?? d.latitude, latitude.min, latitude.max),
    longitude: inRange('longitude', settings.longitude ?? d.longitude, -180, 180),
    fajrAngle: inRange('fajr_angle', settings.fajr_angle ?? d.fajr_angle, angle.min, angle.max),
    ishaAngle: inRange('isha_angle', settings.isha_angle ?? d.isha_angle, angle.min, angle.max),
    asrFactor,
    offsetsMin: {
      fajr: offset('fajr_offset_min', settings.fajr_offset_min),
      dhuhr: offset('dhuhr_offset_min', settings.dhuhr_offset_min),
      asr: offset('asr_offset_min', settings.asr_offset_min),
      maghrib: offset('maghrib_offset_min', settings.maghrib_offset_min),
      isha: offset('isha_offset_min', settings.isha_offset_min),
    },
    prePrayerMinutes: inRange(
      'pre_prayer_minutes',
      settings.pre_prayer_minutes ?? d.pre_prayer_minutes,
      prePrayerMinutes.min,
      prePrayerMinutes.max
    ),
    maxSnoozes: inRange(
      'prayer_max_snoozes',
      settings.prayer_max_snoozes ?? d.prayer_max_snoozes,
      maxSnoozes.min,
      maxSnoozes.max
    ),
    snoozeMinutes: inRange(
      'prayer_snooze_minutes',
      settings.prayer_snooze_minutes ?? d.prayer_snooze_minutes,
      snoozeMinutes.min,
      snoozeMinutes.max
    ),
    enabledSinceMs: Number.isNaN(sinceMs) ? null : sinceMs,
  };
}

type DayTimes = Readonly<Record<PrayerName, Date>>;

// Computing a day takes tens of microseconds, but a calendar render, a habit report and a 60 day
// expansion ask for the same days over and over. Bounded so a long session cannot grow it forever.
const MAX_CACHED_DAYS = 2000;
const dayCache = new Map<string, DayTimes>();

/** Test seam: forget every computed day (a test that changes the machine zone must not see old results). */
export function resetPrayerTimesCache(): void {
  dayCache.clear();
}

function dayKey(config: PrayerConfig, dayNumber: number): string {
  const o = config.offsetsMin;
  return [
    dayNumber,
    config.latitude,
    config.longitude,
    config.fajrAngle,
    config.ishaAngle,
    config.asrFactor,
    o.fajr,
    o.dhuhr,
    o.asr,
    o.maghrib,
    o.isha,
  ].join('|');
}

/**
 * The five prayer instants of one calendar day at the configured location. `dayNumber` is days since
 * 1970-01-01 of the date (the user's local date, see toWallClock). Not for callers to mutate.
 */
export function prayerTimesOnDay(config: PrayerConfig, dayNumber: number): DayTimes {
  const key = dayKey(config, dayNumber);
  const cached = dayCache.get(key);
  if (cached !== undefined) return cached;

  const day = new Date(dayNumber * MS_PER_DAY);
  const params = CalculationMethod.Other();
  params.fajrAngle = config.fajrAngle;
  params.ishaAngle = config.ishaAngle;
  params.madhab = config.asrFactor === 2 ? Madhab.Hanafi : Madhab.Shafi;
  params.adjustments = { ...params.adjustments, ...config.offsetsMin };
  // adhan reads the year, month and day of the Date it is given in the machine's zone; building it
  // from those same parts (at noon, clear of any midnight DST gap) makes the result independent of it.
  const date = new Date(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12);
  const raw = new PrayerTimes(new Coordinates(config.latitude, config.longitude), date, params);

  const times: DayTimes = Object.freeze({
    fajr: raw.fajr,
    dhuhr: raw.dhuhr,
    asr: raw.asr,
    maghrib: raw.maghrib,
    isha: raw.isha,
  });
  for (const name of PRAYER_NAMES) {
    if (Number.isNaN(times[name].getTime())) {
      throw new RangeError(`No ${name} time at latitude ${config.latitude} on that date`);
    }
  }

  if (dayCache.size >= MAX_CACHED_DAYS) dayCache.clear();
  dayCache.set(key, times);
  return times;
}

/**
 * Instants of one prayer (kind 'prayer') or of its reminder (kind 'pre_prayer', the prayer time minus
 * `prePrayerMinutes`) in the half-open range [from, to), ascending. The days are the user's local
 * dates in `tz`; each is widened by a day either side so a time pushed over midnight by an offset or
 * the reminder lead is not lost. Prayers before `enabledSince` are not left out here: the series
 * exists while prayers are on, and only scoring and reminders care about the switch-on time.
 */
export function prayerOccurrencesBetween(
  kind: 'prayer' | 'pre_prayer',
  prayer: PrayerName,
  config: PrayerConfig,
  from: Date,
  to: Date,
  tz: string
): Date[] {
  if (kind === 'pre_prayer' && config.prePrayerMinutes === 0) return [];
  const leadMs = kind === 'pre_prayer' ? config.prePrayerMinutes * MS_PER_MINUTE : 0;
  const firstDay = toWallClock(from, tz).dayNumber - 1;
  const lastDay = toWallClock(new Date(Math.max(to.getTime() - 1, from.getTime())), tz).dayNumber + 1;

  const seen = new Set<number>();
  const result: Date[] = [];
  for (let day = firstDay; day <= lastDay; day++) {
    const ms = prayerTimesOnDay(config, day)[prayer].getTime() - leadMs;
    if (ms >= from.getTime() && ms < to.getTime() && !seen.has(ms)) {
      seen.add(ms);
      result.push(new Date(ms));
    }
  }
  return result.sort((a, b) => a.getTime() - b.getTime());
}

/**
 * The calendar day a prayer instant belongs to: the day (days since 1970-01-01 of the local date in `tz`)
 * whose own time for that prayer is closest to it. A completion keeps the instant its alarm had when it was
 * done; if the settings change afterwards (an offset, the location, the angles) the alarm moves by minutes,
 * and this still names the same day, because adjacent days are a day apart. It also does not drift across
 * midnight: a late Isha pushed past 00:00 by an offset belongs to the day it was computed for, not the
 * next local date. Pass `leadMs` for a pre-prayer alarm, which sits that long before the prayer.
 */
export function prayerDayOf(
  config: PrayerConfig,
  prayer: PrayerName,
  instant: Date,
  tz: string,
  leadMs = 0
): number {
  const around = toWallClock(instant, tz).dayNumber;
  let best = around;
  let bestDistance = Infinity;
  for (let day = around - 1; day <= around + 1; day++) {
    const distance = Math.abs(prayerTimesOnDay(config, day)[prayer].getTime() - leadMs - instant.getTime());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = day;
    }
  }
  return best;
}

/** The prayer before `prayer` at the given instant of it (Fajr follows the previous day's Isha), or null if `at` is not one of its times. */
export function previousPrayer(
  config: PrayerConfig,
  prayer: PrayerName,
  at: Date,
  tz: string
): { prayer: PrayerName; at: Date } | null {
  const around = toWallClock(at, tz).dayNumber;
  for (let day = around - 1; day <= around + 1; day++) {
    if (prayerTimesOnDay(config, day)[prayer].getTime() !== at.getTime()) continue;
    const index = PRAYER_NAMES.indexOf(prayer);
    if (index > 0) {
      const previous = PRAYER_NAMES[index - 1]!;
      return { prayer: previous, at: prayerTimesOnDay(config, day)[previous] };
    }
    return { prayer: 'isha', at: prayerTimesOnDay(config, day - 1).isha };
  }
  return null;
}

/** "Asr in 15 min": what a pre-prayer alarm says when the previous prayer needs no mention. */
export function prePrayerLabel(prayer: PrayerName, minutes: number): string {
  return `${PRAYER_LABELS[prayer]} in ${minutes} min`;
}

/**
 * What a pre-prayer alarm says when the previous prayer has not been logged. The prayer's own window
 * closes at the next prayer, so "you have until Asr" for Dhuhr; Fajr is the exception, its time ends at
 * sunrise, long before the Dhuhr reminder.
 */
export function unloggedPrayerLabel(previous: PrayerName, next: PrayerName): string {
  const name = PRAYER_LABELS[previous];
  if (previous === 'fajr') return `You haven't logged ${name} — its time ended at sunrise`;
  return `You haven't logged ${name} — you have until ${PRAYER_LABELS[next]}`;
}
