import type { EventRow } from './types';
import {
  assertValidTimeZone,
  fromWallClock,
  toWallClock,
  weekdayOfDayNumber,
} from './time-zone';

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

export type RecurrenceEvent = Pick<
  EventRow,
  | 'start_at'
  | 'repeat_unit'
  | 'repeat_interval'
  | 'repeat_weekdays'
  | 'ends_at'
  | 'active'
>;

/**
 * First occurrence strictly after afterInstant, or null when the series is
 * inactive, over, or never produces one. Weeks are Monday-based, matching
 * repeat_weekdays (settings.week_starts_on only affects the cheat pass wallet).
 */
export function nextOccurrence(
  event: RecurrenceEvent,
  afterInstant: Date,
  tz: string
): Date | null {
  const first = occurrencesFrom(event, afterInstant.getTime() + 1, tz).next();
  return first.done ? null : first.value;
}

/** Occurrences in the half-open range [from, to), the shape FullCalendar asks for. */
export function occurrencesBetween(
  event: RecurrenceEvent,
  from: Date,
  to: Date,
  tz: string
): Date[] {
  const result: Date[] = [];
  for (const occurrence of occurrencesFrom(event, from.getTime(), tz)) {
    if (occurrence.getTime() >= to.getTime()) break;
    result.push(occurrence);
  }
  return result;
}

function* occurrencesFrom(
  event: RecurrenceEvent,
  notBeforeMs: number,
  tz: string
): Generator<Date, void, undefined> {
  assertValidTimeZone(tz);
  validate(event);
  if (!event.active) return;

  const start = new Date(event.start_at);
  const endMs = event.ends_at === null ? Infinity : new Date(event.ends_at).getTime();
  const floorMs = Math.max(notBeforeMs, start.getTime());
  if (floorMs > endMs) return;

  if (event.repeat_unit === 'none') {
    if (start.getTime() >= notBeforeMs) yield start;
    return;
  }

  if (event.repeat_unit === 'hour') {
    // Hours are real elapsed time, so jump straight to the first candidate
    // instead of stepping from start_at.
    const stepMs = event.repeat_interval * MS_PER_HOUR;
    const startMs = start.getTime();
    for (let k = Math.ceil((floorMs - startMs) / stepMs); ; k++) {
      const ms = startMs + k * stepMs;
      if (ms > endMs) return;
      yield new Date(ms);
    }
  }

  const startWall = toWallClock(start, tz);
  const floorDay = toWallClock(new Date(floorMs), tz).dayNumber;
  for (const day of wallDays(event, startWall.dayNumber, floorDay)) {
    // start_at is used as-is: re-deriving it from wall time would pick the
    // wrong instant when it falls in the repeated autumn hour.
    const occurrence =
      day === startWall.dayNumber ? start : fromWallClock(day, startWall.msOfDay, tz);
    if (occurrence.getTime() < floorMs) continue;
    if (occurrence.getTime() > endMs) return;
    yield occurrence;
  }
}

/**
 * Ascending local day numbers of the series, starting a day before floorDay
 * (callers filter by instant) so the walk skips years of earlier periods.
 */
function* wallDays(
  event: RecurrenceEvent,
  startDay: number,
  floorDay: number
): Generator<number, void, undefined> {
  const interval = event.repeat_interval;
  const from = floorDay - 1;

  if (event.repeat_unit === 'day') {
    for (let k = Math.max(0, Math.ceil((from - startDay) / interval)); ; k++) {
      yield startDay + k * interval;
    }
  }

  if (event.repeat_unit === 'week') {
    const startMonday = startDay - weekdayOfDayNumber(startDay);
    const weekdays =
      event.repeat_weekdays && event.repeat_weekdays.length > 0
        ? [...new Set(event.repeat_weekdays)].sort((a, b) => a - b)
        : [weekdayOfDayNumber(startDay)];
    const weeksSinceStart = Math.max(0, Math.floor((from - startMonday) / 7));
    for (let week = Math.floor(weeksSinceStart / interval) * interval; ; week += interval) {
      for (const weekday of weekdays) {
        const day = startMonday + week * 7 + weekday;
        if (day >= startDay) yield day;
      }
    }
  }

  const startDate = new Date(startDay * MS_PER_DAY);

  if (event.repeat_unit === 'year') {
    // Clamp from the original date each year, so a Feb 29 start gives Feb 28 in common years and
    // Feb 29 again in leap years (no drift to the 28th for good).
    const startYear = startDate.getUTCFullYear();
    const startMonth = startDate.getUTCMonth();
    const startDom = startDate.getUTCDate();
    const fromYear = new Date(from * MS_PER_DAY).getUTCFullYear();
    for (let k = Math.max(0, Math.floor((fromYear - startYear) / interval)); ; k++) {
      const year = startYear + k * interval;
      const lastDay = new Date(Date.UTC(year, startMonth + 1, 0)).getUTCDate();
      yield Date.UTC(year, startMonth, Math.min(startDom, lastDay)) / MS_PER_DAY;
    }
  }

  // month: clamp from the original day each time, so Jan 31 -> Feb 28 -> Mar 31.
  const startDayOfMonth = startDate.getUTCDate();
  const startMonthIndex = startDate.getUTCFullYear() * 12 + startDate.getUTCMonth();
  const fromDate = new Date(from * MS_PER_DAY);
  const fromMonthIndex = fromDate.getUTCFullYear() * 12 + fromDate.getUTCMonth();
  for (let k = Math.max(0, Math.floor((fromMonthIndex - startMonthIndex) / interval)); ; k++) {
    const monthIndex = startMonthIndex + k * interval;
    const year = Math.floor(monthIndex / 12);
    const month = monthIndex - year * 12;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    yield Date.UTC(year, month, Math.min(startDayOfMonth, lastDay)) / MS_PER_DAY;
  }
}

function validate(event: RecurrenceEvent): void {
  if (Number.isNaN(new Date(event.start_at).getTime())) {
    throw new RangeError(`Invalid start_at: ${event.start_at}`);
  }
  if (event.ends_at !== null && Number.isNaN(new Date(event.ends_at).getTime())) {
    throw new RangeError(`Invalid ends_at: ${event.ends_at}`);
  }
  if (event.repeat_unit === 'none') return;
  if (!Number.isInteger(event.repeat_interval) || event.repeat_interval < 1) {
    throw new RangeError(`repeat_interval must be an integer >= 1, got ${event.repeat_interval}`);
  }
  for (const weekday of event.repeat_weekdays ?? []) {
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new RangeError(`repeat_weekdays entries must be integers 0 to 6, got ${weekday}`);
    }
  }
}
