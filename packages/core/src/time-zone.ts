import { formatInTimeZone } from 'date-fns-tz';

const MS_PER_DAY = 86_400_000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface WallClock {
  /** Days since 1970-01-01 of the local calendar date. */
  dayNumber: number;
  /** Milliseconds since local midnight. */
  msOfDay: number;
}

export function assertValidTimeZone(tz: string): void {
  try {
    offsetAt(tz, 0);
  } catch {
    throw new RangeError(`Invalid IANA time zone: ${tz}`);
  }
}

/**
 * Zone offset in ms at an instant. Derived from formatInTimeZone because
 * date-fns-tz's getTimezoneOffset returns the wrong offset for up to an hour
 * after a DST transition (verified against Intl for 2026 in several zones).
 */
function offsetAt(tz: string, instantMs: number): number {
  const wall = formatInTimeZone(new Date(instantMs), tz, "yyyy-MM-dd'T'HH:mm:ss.SSS");
  return Date.parse(`${wall}Z`) - instantMs;
}

/**
 * Local calendar date and time of day of an instant in tz. Computed from the
 * zone offset so the result never depends on the machine's own time zone.
 */
export function toWallClock(instant: Date, tz: string): WallClock {
  const localMs = instant.getTime() + offsetAt(tz, instant.getTime());
  const dayNumber = Math.floor(localMs / MS_PER_DAY);
  return { dayNumber, msOfDay: localMs - dayNumber * MS_PER_DAY };
}

/**
 * Instant for a local date and time of day in tz. DST rules match
 * java.time's ZonedDateTime.ofLocal so the Kotlin mirror agrees: a wall time
 * inside a spring-forward gap moves forward by the gap, and a wall time that
 * occurs twice in autumn resolves to the earlier instant.
 */
export function fromWallClock(dayNumber: number, msOfDay: number, tz: string): Date {
  const localMs = dayNumber * MS_PER_DAY + msOfDay;
  // The true instant is within 14h of localMs, so offsets a day either side
  // are the ones before and after any transition near it.
  const offsetBefore = offsetAt(tz, localMs - MS_PER_DAY);
  const offsetAfter = offsetAt(tz, localMs + MS_PER_DAY);

  const candidates = [offsetBefore, offsetAfter]
    .filter((offset, i, all) => all.indexOf(offset) === i)
    .map((offset) => localMs - offset)
    .filter((utcMs) => offsetAt(tz, utcMs) === localMs - utcMs);

  if (candidates.length === 0) {
    return new Date(localMs - offsetBefore);
  }
  return new Date(Math.min(...candidates));
}

export function dayNumberFromDateString(day: string): number {
  const match = DATE_PATTERN.exec(day);
  if (!match) throw new RangeError(`Expected a 'yyyy-MM-dd' date, got: ${day}`);
  const [year, month, date] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const ms = Date.UTC(year, month, date);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== date) {
    throw new RangeError(`Not a real calendar date: ${day}`);
  }
  return ms / MS_PER_DAY;
}

export function dateStringFromDayNumber(dayNumber: number): string {
  return new Date(dayNumber * MS_PER_DAY).toISOString().slice(0, 10);
}

/** The local calendar date of an instant in tz, 'yyyy-MM-dd'. */
export function localDateString(instant: Date, tz: string): string {
  return dateStringFromDayNumber(toWallClock(instant, tz).dayNumber);
}

/** Monday = 0 through Sunday = 6, the indexing used by repeat_weekdays. */
export function weekdayOfDayNumber(dayNumber: number): number {
  // 1970-01-01 was a Thursday (3).
  return (((dayNumber + 3) % 7) + 7) % 7;
}
