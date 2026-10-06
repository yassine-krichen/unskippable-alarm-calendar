import {
  dateStringFromDayNumber,
  dayNumberFromDateString,
  fromWallClock,
  localDateString,
  toWallClock,
  weekdayOfDayNumber,
} from '@alarm-calendar/core';

const MS_PER_MINUTE = 60_000;

const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

/** Monday = 0 through Sunday = 6, the indexing used by repeat_weekdays. */
export function weekdayName(weekday: number): string {
  return WEEKDAY_NAMES[weekday] ?? '';
}

export function weekdayShortName(weekday: number): string {
  return weekdayName(weekday).slice(0, 3);
}

export interface ZonedParts {
  /** Local calendar date, 'yyyy-MM-dd'. */
  date: string;
  /** Local time of day, 'HH:mm'. */
  time: string;
}

/** The wall-clock date and time an instant has in tz. */
export function zonedParts(instant: Date, tz: string): ZonedParts {
  const { dayNumber, msOfDay } = toWallClock(instant, tz);
  const minutes = Math.floor(msOfDay / MS_PER_MINUTE);
  return {
    date: dateStringFromDayNumber(dayNumber),
    time: formatMinutes(minutes),
  };
}

/** The instant for a wall-clock date ('yyyy-MM-dd') and time ('HH:mm') entered in tz. */
export function instantFromZoned(date: string, time: string, tz: string): Date {
  return fromWallClock(dayNumberFromDateString(date), parseTimeToMinutes(time) * MS_PER_MINUTE, tz);
}

export function formatMinutes(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Throws on anything other than a 24-hour 'HH:mm' value. */
export function parseTimeToMinutes(time: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) throw new RangeError(`Expected a 24-hour 'HH:mm' time, got: ${time}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Monday = 0 through Sunday = 6 for a 'yyyy-MM-dd' date. */
export function weekdayOfDate(date: string): number {
  return weekdayOfDayNumber(dayNumberFromDateString(date));
}

export function addDays(date: string, days: number): string {
  return dateStringFromDayNumber(dayNumberFromDateString(date) + days);
}

/** Start instant of a local calendar day in tz. */
export function startOfZonedDay(date: string, tz: string): Date {
  return fromWallClock(dayNumberFromDateString(date), 0, tz);
}

/** The local calendar date of an instant in tz. */
export function zonedDate(instant: Date, tz: string): string {
  return localDateString(instant, tz);
}

/**
 * The first weekday of the week for react-day-picker (Sunday = 0), from the settings' week start (Monday = 0). The
 * date pickers and the calendar grid take it.
 */
export function pickerWeekStart(weekStartsOn: number): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  return ((weekStartsOn + 1) % 7) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

/** Whether a 'yyyy-MM-dd' string names a real calendar date. */
export function isRealDate(date: string): boolean {
  try {
    dayNumberFromDateString(date);
    return true;
  } catch {
    return false;
  }
}

/** A Date at local noon, safe to hand to date pickers without a day shift. */
export function dateFromString(date: string): Date {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, day, 12);
}

/** Formats the local calendar fields of a picker Date back to 'yyyy-MM-dd'. */
export function stringFromDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 'Thu, Oct 8' for a 'yyyy-MM-dd' date. */
export function formatDay(date: string, options?: { year?: boolean }): string {
  return dateFromString(date).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(options?.year ? { year: 'numeric' } : {}),
  });
}

/** 24-hour 'HH:mm' of an instant in tz, matching the form and the calendar grid. */
export function formatTimeInZone(instant: Date, tz: string): string {
  return zonedParts(instant, tz).time;
}

/** The device's IANA zone, or null when the browser cannot name one. */
export function detectDeviceTimeZone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && tz.length > 0 ? tz : null;
  } catch {
    return null;
  }
}
