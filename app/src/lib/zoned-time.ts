import { zonedParts } from '@alarm-calendar/core';

// The pure wall-clock helpers live in core (shared with the agent CLI); they are re-exported so the app's
// imports stay as they were.
export {
  addDays,
  formatMinutes,
  instantFromZoned,
  isRealDate,
  parseTimeToMinutes,
  startOfZonedDay,
  weekdayOfDate,
  zonedDate,
  zonedParts,
} from '@alarm-calendar/core';
export type { ZonedParts } from '@alarm-calendar/core';

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

/**
 * The first weekday of the week for react-day-picker (Sunday = 0), from the settings' week start (Monday = 0). The
 * date pickers and the calendar grid take it.
 */
export function pickerWeekStart(weekStartsOn: number): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  return ((weekStartsOn + 1) % 7) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
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
