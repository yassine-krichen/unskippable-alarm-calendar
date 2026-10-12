import { dateStringFromDayNumber, dayNumberFromDateString } from './time-zone';

/**
 * Holidays for the calendar (display only: they never ring, are not in the schedule list and are not habits).
 *
 * Islamic holidays are computed here from the Hijri calendar the runtime already ships (`Intl`, no dependency):
 * Umm al-Qura, the Saudi civil calendar, with the tabular Islamic civil calendar as a fallback. Public holidays of a
 * country come from a library in the app (it is large, so it is loaded on demand); this file only merges them with
 * the Islamic ones and shifts the Hijri-dated ones by the person's adjustment.
 *
 * Tunisia, like most countries, starts its months by local moon sighting, so the printed dates can be a day off the
 * Umm al-Qura ones. `hijri_offset_days` (-2 to 2) is that correction, applied to every Hijri-derived date.
 */

const MS_PER_DAY = 86_400_000;

/** The bounds the database checks on `settings.hijri_offset_days` (migration holidays). */
export const HIJRI_OFFSET_LIMITS = { min: -2, max: 2 } as const;

/** What `holidaysByDay` and the calendar read; the columns of migration holidays, all optional like the other groups. */
export interface HolidaySettings {
  /** ISO 3166-1 alpha-2 code whose public holidays are shown; null or absent shows none. */
  holiday_country: string | null;
  /** Show the Islamic holidays (Ramadan, the Eids, Islamic New Year, ...). */
  islamic_holidays: boolean;
  /** Days added to every computed Hijri date, -2 to 2, to follow the local moon sighting. */
  hijri_offset_days: number;
}

export const DEFAULT_HOLIDAY_SETTINGS: HolidaySettings = {
  holiday_country: null,
  islamic_holidays: false,
  hijri_offset_days: 0,
};

/** Clamps a stored or typed adjustment to a whole number inside the allowed range. */
export function normalizeHijriOffset(value: unknown): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
  return Math.min(HIJRI_OFFSET_LIMITS.max, Math.max(HIJRI_OFFSET_LIMITS.min, number));
}

export interface HijriDate {
  year: number;
  /** 1 (Muharram) to 12 (Dhu al-Hijjah). */
  month: number;
  day: number;
}

let hijriFormatter: Intl.DateTimeFormat | null | undefined;

/**
 * The Hijri formatter, or null when this runtime has neither calendar. A runtime without support silently
 * formats with the Gregorian calendar, so the resolved calendar is checked rather than trusted.
 */
function getHijriFormatter(): Intl.DateTimeFormat | null {
  if (hijriFormatter !== undefined) return hijriFormatter;
  hijriFormatter = null;
  for (const calendar of ['islamic-umalqura', 'islamic-civil']) {
    try {
      const candidate = new Intl.DateTimeFormat(`en-u-ca-${calendar}`, {
        timeZone: 'UTC',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
      });
      if (candidate.resolvedOptions().calendar === calendar) {
        hijriFormatter = candidate;
        break;
      }
    } catch {
      // This runtime does not know the calendar; try the next one.
    }
  }
  return hijriFormatter;
}

/** Whether Islamic holidays can be computed here at all. */
export function hijriCalendarAvailable(): boolean {
  return getHijriFormatter() !== null;
}

const hijriByDayNumber = new Map<number, HijriDate | null>();

function hijriOfDayNumber(dayNumber: number): HijriDate | null {
  const cached = hijriByDayNumber.get(dayNumber);
  if (cached !== undefined) return cached;
  const formatter = getHijriFormatter();
  let result: HijriDate | null = null;
  if (formatter !== null) {
    // Noon UTC: the formatter runs in UTC, so the day number is the civil day whatever the machine's zone.
    const parts = formatter.formatToParts(new Date(dayNumber * MS_PER_DAY + MS_PER_DAY / 2));
    const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
    const year = read('year');
    const month = read('month');
    const day = read('day');
    if (Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)) result = { year, month, day };
  }
  hijriByDayNumber.set(dayNumber, result);
  return result;
}

/**
 * The Hijri date of a civil day 'yyyy-MM-dd'. With a positive `offsetDays` the Hijri calendar runs later (1 Muharram
 * lands one civil day later), so the date shown for day D is the computed date of D minus the offset.
 */
export function hijriDateOfDay(day: string, offsetDays = 0): HijriDate | null {
  return hijriOfDayNumber(dayNumberFromDateString(day) - normalizeHijriOffset(offsetDays));
}

export type IslamicHolidayId =
  | 'islamic-new-year'
  | 'ashura'
  | 'mawlid'
  | 'isra-miraj'
  | 'ramadan'
  | 'laylat-al-qadr'
  | 'eid-al-fitr'
  | 'arafah'
  | 'eid-al-adha';

interface IslamicHolidayDefinition {
  id: IslamicHolidayId;
  name: string;
  month: number;
  day: number;
}

/** In calendar order. Ramadan is the one stretch: it is listed on 1 Ramadan and runs to the end of the month. */
export const ISLAMIC_HOLIDAY_DEFINITIONS: readonly IslamicHolidayDefinition[] = [
  { id: 'islamic-new-year', name: 'Islamic New Year', month: 1, day: 1 },
  { id: 'ashura', name: 'Ashura', month: 1, day: 10 },
  { id: 'mawlid', name: 'Mawlid', month: 3, day: 12 },
  { id: 'isra-miraj', name: "Isra and Mi'raj", month: 7, day: 27 },
  { id: 'ramadan', name: 'Ramadan begins', month: 9, day: 1 },
  // The night falls on the evening before; the 27th is the date most calendars print, and it is only the likely one.
  { id: 'laylat-al-qadr', name: 'Laylat al-Qadr (likely)', month: 9, day: 27 },
  { id: 'eid-al-fitr', name: 'Eid al-Fitr', month: 10, day: 1 },
  { id: 'arafah', name: 'Day of Arafah', month: 12, day: 9 },
  { id: 'eid-al-adha', name: 'Eid al-Adha', month: 12, day: 10 },
];

const RAMADAN_MONTH = 9;
const RAMADAN_NAME = 'Ramadan';

export interface IslamicHoliday {
  id: IslamicHolidayId;
  name: string;
  /** First civil day, 'yyyy-MM-dd'. */
  day: string;
  /** Last civil day, inclusive; equal to `day` except for Ramadan, which runs the whole month. */
  endDay: string;
  hijriYear: number;
}

/** A Ramadan lasts 29 or 30 days; scanning this far beyond a range always catches the whole month. */
const SCAN_PADDING_DAYS = 31;

/**
 * The Islamic holidays that fall on or overlap `fromDay`..`toDay` (inclusive, 'yyyy-MM-dd'), with the Hijri
 * adjustment applied. Empty when the runtime has no Hijri calendar.
 */
export function islamicHolidaysBetween(fromDay: string, toDay: string, offsetDays = 0): IslamicHoliday[] {
  const from = dayNumberFromDateString(fromDay);
  const to = dayNumberFromDateString(toDay);
  if (to < from || !hijriCalendarAvailable()) return [];
  const offset = normalizeHijriOffset(offsetDays);

  const found: IslamicHoliday[] = [];
  const ramadans = new Map<number, { start: number; end: number }>();
  for (let dayNumber = from - SCAN_PADDING_DAYS; dayNumber <= to + SCAN_PADDING_DAYS; dayNumber++) {
    const hijri = hijriOfDayNumber(dayNumber - offset);
    if (hijri === null) continue;
    if (hijri.month === RAMADAN_MONTH) {
      const run = ramadans.get(hijri.year);
      if (run === undefined) ramadans.set(hijri.year, { start: dayNumber, end: dayNumber });
      else run.end = dayNumber;
    }
    for (const definition of ISLAMIC_HOLIDAY_DEFINITIONS) {
      if (definition.id === 'ramadan' || definition.month !== hijri.month || definition.day !== hijri.day) continue;
      const day = dateStringFromDayNumber(dayNumber);
      found.push({ id: definition.id, name: definition.name, day, endDay: day, hijriYear: hijri.year });
    }
  }
  const ramadan = ISLAMIC_HOLIDAY_DEFINITIONS.find((definition) => definition.id === 'ramadan');
  if (ramadan !== undefined) {
    for (const [hijriYear, run] of ramadans) {
      found.push({
        id: 'ramadan',
        name: ramadan.name,
        day: dateStringFromDayNumber(run.start),
        endDay: dateStringFromDayNumber(run.end),
        hijriYear,
      });
    }
  }

  return found
    .filter((holiday) => holiday.day <= toDay && holiday.endDay >= fromDay)
    .sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
}

/**
 * The Ramadan that contains `onOrAfterDay` or is the next to start, for pre-filling a date range. Null when the
 * runtime has no Hijri calendar.
 */
export function ramadanOnOrAfter(onOrAfterDay: string, offsetDays = 0): { start: string; end: string; hijriYear: number } | null {
  const horizon = dateStringFromDayNumber(dayNumberFromDateString(onOrAfterDay) + 400);
  const ramadan = islamicHolidaysBetween(onOrAfterDay, horizon, offsetDays).find((holiday) => holiday.id === 'ramadan');
  return ramadan === undefined ? null : { start: ramadan.day, end: ramadan.endDay, hijriYear: ramadan.hijriYear };
}

/** A public holiday of a country, as the app's library adapter hands it over. */
export interface PublicHoliday {
  name: string;
  /** First civil day, 'yyyy-MM-dd', in the country. */
  day: string;
  /** Last civil day, inclusive. */
  endDay: string;
  /** The Hijri day and month the library dated it by, or null for a fixed, Easter-based or other holiday. */
  hijri: { month: number; day: number } | null;
}

const HIJRI_MONTH_NUMBERS: Readonly<Record<string, number>> = {
  muharram: 1,
  safar: 2,
  'rabi al-awwal': 3,
  'rabi al-thani': 4,
  'jumada al-awwal': 5,
  'jumada al-thani': 6,
  rajab: 7,
  shaban: 8,
  ramadan: 9,
  shawwal: 10,
  'dhu al-qidah': 11,
  'dhu al-hijjah': 12,
};

const HIJRI_RULE = /^(\d{1,2}) ([A-Za-z' -]+?)(?= P|\b and\b|$)/;

/**
 * The Hijri day and month in a holiday rule of the library ('10 Dhu al-Hijjah', '1 Shawwal P3D',
 * '1 Shawwal and if sunday then next monday'), or null when the rule is not Hijri-dated.
 */
export function parseHijriRule(rule: string): { month: number; day: number } | null {
  const match = HIJRI_RULE.exec(rule.trim());
  if (match === null) return null;
  const month = HIJRI_MONTH_NUMBERS[(match[2] ?? '').trim().toLowerCase().replace(/[’ʻʿ]/g, '')];
  const day = Number(match[1]);
  return month === undefined || day < 1 || day > 30 ? null : { month, day };
}

export type HolidayKind = 'public' | 'religious';

/** One thing the calendar draws for a day or a run of days. */
export interface CalendarHoliday {
  /** Stable per holiday and year, used as the calendar's event id. */
  id: string;
  name: string;
  /** First civil day, 'yyyy-MM-dd'. */
  day: string;
  /** Last civil day, inclusive. */
  endDay: string;
  /** 'religious' for an Islamic holiday (even when the country also makes it a day off), else 'public'. */
  kind: HolidayKind;
  /** Whether the chosen country marks it as a public holiday. Always true for kind 'public'. */
  publicHoliday: boolean;
  /**
   * Set for a stretch such as Ramadan: the chip is drawn once on `day`, and every day of the run is tinted and
   * says "<rangeName>, day N" instead of getting a chip of its own.
   */
  rangeName: string | null;
}

export interface MergeHolidaysInput {
  publicHolidays: readonly PublicHoliday[];
  islamic: readonly IslamicHoliday[];
  offsetDays: number;
}

/** How far apart the library's Hijri table and the runtime's can disagree before two entries stop being one holiday. */
const MERGE_TOLERANCE_DAYS = 2;

function shiftDay(day: string, days: number): string {
  return dateStringFromDayNumber(dayNumberFromDateString(day) + days);
}

/**
 * Combines a country's public holidays with the Islamic holidays into one list.
 *
 * - A Hijri-dated public holiday is shifted by the adjustment, like the computed Islamic ones. The library has no
 *   such setting, so this moves its answer. A rule such as "if Sunday then next Monday" is not re-applied after the
 *   shift (it matters only to countries whose weekend is not Friday and Saturday).
 * - A public holiday that is the same Hijri day as an Islamic one (the Eids, Islamic New Year, Mawlid ...) becomes one
 *   entry: religious in style, tagged as a public holiday, on the computed day, as long as the country's own days.
 * - Islamic holidays with no country counterpart, and country holidays with no Islamic counterpart, stay as they are.
 */
export function mergeHolidays({ publicHolidays, islamic, offsetDays }: MergeHolidaysInput): CalendarHoliday[] {
  const offset = normalizeHijriOffset(offsetDays);
  const publics = publicHolidays.map((holiday) =>
    holiday.hijri === null || offset === 0
      ? holiday
      : { ...holiday, day: shiftDay(holiday.day, offset), endDay: shiftDay(holiday.endDay, offset) }
  );
  const taken = new Set<number>();
  const merged: CalendarHoliday[] = [];

  for (const holiday of islamic) {
    const definition = ISLAMIC_HOLIDAY_DEFINITIONS.find((candidate) => candidate.id === holiday.id);
    let match = -1;
    let closest = Infinity;
    publics.forEach((candidate, index) => {
      if (taken.has(index) || definition === undefined || candidate.hijri === null) return;
      if (candidate.hijri.month !== definition.month || candidate.hijri.day !== definition.day) return;
      const distance = Math.abs(dayNumberFromDateString(candidate.day) - dayNumberFromDateString(holiday.day));
      if (distance <= MERGE_TOLERANCE_DAYS && distance < closest) {
        match = index;
        closest = distance;
      }
    });
    const counterpart = match === -1 ? undefined : publics[match];
    if (counterpart !== undefined) taken.add(match);
    const publicSpan = counterpart === undefined ? 0 : dayNumberFromDateString(counterpart.endDay) - dayNumberFromDateString(counterpart.day);
    const endDay = holiday.endDay >= shiftDay(holiday.day, publicSpan) ? holiday.endDay : shiftDay(holiday.day, publicSpan);
    merged.push({
      id: `islamic:${holiday.id}:${holiday.hijriYear}`,
      name: holiday.name,
      day: holiday.day,
      endDay,
      kind: 'religious',
      publicHoliday: counterpart !== undefined,
      rangeName: holiday.id === 'ramadan' ? RAMADAN_NAME : null,
    });
  }

  publics.forEach((holiday, index) => {
    if (taken.has(index)) return;
    merged.push({
      id: `public:${holiday.day}:${holiday.name}`,
      name: holiday.name,
      day: holiday.day,
      endDay: holiday.endDay,
      kind: 'public',
      publicHoliday: true,
      rangeName: null,
    });
  });

  return merged.sort((a, b) => a.day.localeCompare(b.day) || kindOrder(a) - kindOrder(b) || a.name.localeCompare(b.name));
}

// A day off the country marks comes before a purely religious observance on the same day.
function kindOrder(holiday: CalendarHoliday): number {
  return holiday.kind === 'public' ? 0 : 1;
}

/**
 * The chips of each day in `fromDay`..`toDay`: a holiday is listed on every day it runs, except a stretch (Ramadan),
 * which is listed on its first day only; `stretchDays` carries the rest.
 */
export function holidaysByDay(
  holidays: readonly CalendarHoliday[],
  fromDay: string,
  toDay: string
): Map<string, CalendarHoliday[]> {
  const byDay = new Map<string, CalendarHoliday[]>();
  for (const holiday of holidays) {
    const last = holiday.rangeName === null ? holiday.endDay : holiday.day;
    for (let day = holiday.day < fromDay ? fromDay : holiday.day; day <= last && day <= toDay; day = shiftDay(day, 1)) {
      const list = byDay.get(day);
      if (list === undefined) byDay.set(day, [holiday]);
      else list.push(holiday);
    }
  }
  return byDay;
}

/** A day inside a stretch such as Ramadan. */
export interface StretchDay {
  name: string;
  /** 1 on the first day. */
  dayNumber: number;
  totalDays: number;
}

/** The stretch (Ramadan) each day in `fromDay`..`toDay` belongs to; days outside any stretch are absent. */
export function stretchDays(holidays: readonly CalendarHoliday[], fromDay: string, toDay: string): Map<string, StretchDay> {
  const byDay = new Map<string, StretchDay>();
  for (const holiday of holidays) {
    if (holiday.rangeName === null) continue;
    const first = dayNumberFromDateString(holiday.day);
    const totalDays = dayNumberFromDateString(holiday.endDay) - first + 1;
    for (let day = holiday.day < fromDay ? fromDay : holiday.day; day <= holiday.endDay && day <= toDay; day = shiftDay(day, 1)) {
      byDay.set(day, { name: holiday.rangeName, dayNumber: dayNumberFromDateString(day) - first + 1, totalDays });
    }
  }
  return byDay;
}
