import {
  holidaysByDay,
  islamicHolidaysBetween,
  mergeHolidays,
  normalizeHijriOffset,
  stretchDays,
  type CalendarHoliday,
  type PublicHoliday,
  type Settings,
  type StretchDay,
} from '@alarm-calendar/core';

import { addDays } from '@/lib/zoned-time';

/** What the holiday settings ask for, with absent columns read as "no holidays". */
export interface HolidayPreferences {
  /** ISO 3166-1 alpha-2, or null for none. */
  country: string | null;
  islamic: boolean;
  offsetDays: number;
}

export function holidayPreferencesOf(settings: Settings | null): HolidayPreferences {
  return {
    country: settings?.holiday_country ?? null,
    islamic: settings?.islamic_holidays === true,
    offsetDays: normalizeHijriOffset(settings?.hijri_offset_days),
  };
}

/** The Hijri shift can move a library holiday across a year end, so ask for the neighbouring year too. */
const YEAR_MARGIN_DAYS = 3;

/** The calendar years a visible range [start, end) touches, widened by a few days on each side. */
export function yearsToLoad(start: string, end: string): number[] {
  const first = Number(addDays(start, -YEAR_MARGIN_DAYS).slice(0, 4));
  const last = Number(addDays(end, YEAR_MARGIN_DAYS).slice(0, 4));
  const years: number[] = [];
  for (let year = first; year <= last; year++) years.push(year);
  return years;
}

export interface HolidaysInRange {
  holidays: CalendarHoliday[];
  byDay: Map<string, CalendarHoliday[]>;
  stretches: Map<string, StretchDay>;
}

export const NO_HOLIDAYS: HolidaysInRange = { holidays: [], byDay: new Map(), stretches: new Map() };

/**
 * Everything the calendar draws for days [start, end): the country's public holidays (already loaded, or empty while
 * they load), merged with the computed Islamic ones when those are switched on.
 */
export function holidaysInRange(
  preferences: HolidayPreferences,
  publicHolidays: readonly PublicHoliday[],
  start: string,
  end: string
): HolidaysInRange {
  const last = addDays(end, -1);
  const islamic = preferences.islamic
    ? islamicHolidaysBetween(addDays(start, -YEAR_MARGIN_DAYS), addDays(last, YEAR_MARGIN_DAYS), preferences.offsetDays)
    : [];
  const holidays = mergeHolidays({
    publicHolidays: preferences.country === null ? [] : publicHolidays,
    islamic,
    offsetDays: preferences.offsetDays,
  }).filter((holiday) => holiday.endDay >= start && holiday.day <= last);
  if (holidays.length === 0) return NO_HOLIDAYS;
  return { holidays, byDay: holidaysByDay(holidays, start, last), stretches: stretchDays(holidays, start, last) };
}
