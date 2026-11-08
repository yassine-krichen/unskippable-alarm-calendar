import {
  dateStringFromDayNumber,
  dayNumberFromDateString,
  fromWallClock,
  localDateString,
  toWallClock,
  weekdayOfDayNumber,
} from './time-zone';

// Wall-clock helpers shared by the app and the agent CLI: a local date ('yyyy-MM-dd') and time ('HH:mm')
// in an IANA zone, converted to and from instants with the DST rules of time-zone.ts.

const MS_PER_MINUTE = 60_000;

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

/** Whether a 'yyyy-MM-dd' string names a real calendar date. */
export function isRealDate(date: string): boolean {
  try {
    dayNumberFromDateString(date);
    return true;
  } catch {
    return false;
  }
}
