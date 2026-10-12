import { HIJRI_OFFSET_LIMITS, normalizeHijriOffset, type HolidaySettings, type Settings } from '@alarm-calendar/core';
import { z } from 'zod';

/** What the Holidays part of the settings form edits; the bounds are the database's (migration holidays). */
export const holidayFormSchema = z.object({
  /** ISO 3166-1 alpha-2, or '' for none (a combobox value cannot be null). */
  holidayCountry: z.string().regex(/^([A-Z]{2})?$/, 'Pick a country from the list.'),
  islamicHolidays: z.boolean(),
  hijriOffset: z.number().int().min(HIJRI_OFFSET_LIMITS.min).max(HIJRI_OFFSET_LIMITS.max),
});

export type HolidayFormValues = z.infer<typeof holidayFormSchema>;

/** The form's starting values: what settings hold, or "no holidays" for a row without the columns. */
export function holidayFormValues(settings: Settings): HolidayFormValues {
  return {
    holidayCountry: settings.holiday_country ?? '',
    islamicHolidays: settings.islamic_holidays === true,
    hijriOffset: normalizeHijriOffset(settings.hijri_offset_days),
  };
}

/** The settings columns a save writes. */
export function holidayFormToPatch(values: HolidayFormValues): Partial<HolidaySettings> {
  return {
    holiday_country: values.holidayCountry === '' ? null : values.holidayCountry,
    islamic_holidays: values.islamicHolidays,
    hijri_offset_days: values.hijriOffset,
  };
}

/** The country's name without loading the holiday library (the list loads when the picker opens). */
export function regionName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}
