import { parseHijriRule, type PublicHoliday } from '@alarm-calendar/core';

import { addDays } from '@/lib/zoned-time';

/**
 * The public holidays of a country, from the `date-holidays` library (ISC code, CC-BY-3.0 data, offline). The library
 * and its world dataset are about 1.4 MB, so they are a separate chunk that loads the first time a country is
 * chosen or the country list is opened, never with the main bundle.
 */
type HolidaysLibrary = (typeof import('date-holidays'))['default'];

let library: Promise<HolidaysLibrary> | null = null;

function loadLibrary(): Promise<HolidaysLibrary> {
  library ??= import('date-holidays').then(
    (module) => module.default,
    (error: unknown) => {
      // Forget a failed load so the next attempt tries again.
      library = null;
      throw error;
    }
  );
  return library;
}

export interface HolidayCountry {
  /** ISO 3166-1 alpha-2. */
  code: string;
  name: string;
}

/** English first, then French: the owner reads both, and Tunisia's own holidays have French and Arabic names only. */
const LANGUAGES = ['en', 'fr'];

export async function listHolidayCountries(): Promise<HolidayCountry[]> {
  const Holidays = await loadLibrary();
  const names = new Holidays().getCountries('en');
  return Object.entries(names)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** How many civil days a library holiday lasts: a duration in its rule ('1 Shawwal P3D', 'PT90H') or one day. */
export function holidayLengthDays(rule: string): number {
  const match = /\bP(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?\s*$/.exec(rule.trim());
  if (match === null) return 1;
  const hours = Number(match[1] ?? 0) * 24 + Number(match[2] ?? 0);
  return hours > 0 ? Math.ceil(hours / 24) : 1;
}

const instances = new Map<string, InstanceType<HolidaysLibrary>>();
const years = new Map<string, PublicHoliday[]>();

/**
 * The country's nationwide public holidays for the given calendar years, in date order. Regional and optional
 * holidays, bank days and observances are left out. Rejects when the library cannot be loaded.
 */
export async function publicHolidaysFor(country: string, forYears: readonly number[]): Promise<PublicHoliday[]> {
  const Holidays = await loadLibrary();
  const result: PublicHoliday[] = [];
  for (const year of forYears) {
    const key = `${country}:${year}`;
    let list = years.get(key);
    if (list === undefined) {
      let instance = instances.get(country);
      if (instance === undefined) {
        instance = new Holidays(country, { languages: LANGUAGES, types: ['public'] });
        instances.set(country, instance);
      }
      list = instance
        .getHolidays(year)
        .filter((holiday) => holiday.type === 'public')
        .map((holiday) => {
          // The date's own text is the civil day in the country; its Date fields are instants in odd zones for Hijri ones.
          const day = holiday.date.slice(0, 10);
          return {
            name: holiday.name,
            day,
            endDay: addDays(day, holidayLengthDays(holiday.rule) - 1),
            hijri: parseHijriRule(holiday.rule),
          };
        });
      years.set(key, list);
    }
    result.push(...list);
  }
  return result.sort((a, b) => a.day.localeCompare(b.day));
}
