import type { PublicHoliday } from '@alarm-calendar/core';
import { useEffect, useMemo, useState } from 'react';

import { useSettingsStore } from '@/features/settings/settings-store';

import { publicHolidaysFor } from './country-holidays';
import { holidayPreferencesOf, holidaysInRange, yearsToLoad, type HolidaysInRange } from './holiday-range';

interface LoadedPublicHolidays {
  country: string;
  holidays: PublicHoliday[];
}

export interface UseHolidays extends HolidaysInRange {
  /** The country's holidays could not be loaded; the Islamic ones and everything else still show. */
  publicFailed: boolean;
}

/**
 * The holidays for days [start, end) under the person's Settings. The Islamic ones are computed on the spot; the
 * country's come from a lazily loaded library, so they appear a moment after the first request for a country.
 */
export function useHolidays(start: string, end: string): UseHolidays {
  const settings = useSettingsStore((state) => state.settings);
  const country = settings?.holiday_country ?? null;
  const islamic = settings?.islamic_holidays === true;
  const offsetDays = settings?.hijri_offset_days;
  const preferences = useMemo(
    () => holidayPreferencesOf(settings),
    // The three columns are the only inputs; the rest of settings changing must not recompute.
    [country, islamic, offsetDays]
  );

  const requestKey = country === null ? null : `${country}:${yearsToLoad(start, end).join(',')}`;
  const [loaded, setLoaded] = useState<LoadedPublicHolidays | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);

  useEffect(() => {
    if (country === null || requestKey === null) return;
    let cancelled = false;
    publicHolidaysFor(country, yearsToLoad(start, end)).then(
      (holidays) => {
        if (cancelled) return;
        setLoaded({ country, holidays });
        // A later success (the list loaded on a retry) must not leave the old failure showing.
        setFailedKey(null);
      },
      () => {
        if (!cancelled) setFailedKey(requestKey);
      }
    );
    return () => {
      cancelled = true;
    };
  // start and end only decide the years, which requestKey already carries.
  }, [country, requestKey]);

  // Paging to another year keeps the last list on screen until the next one arrives; another country never does.
  const publicHolidays = loaded !== null && loaded.country === country ? loaded.holidays : EMPTY;
  const inRange = useMemo(
    () => holidaysInRange(preferences, publicHolidays, start, end),
    [preferences, publicHolidays, start, end]
  );
  return { ...inRange, publicFailed: requestKey !== null && failedKey === requestKey };
}

const EMPTY: PublicHoliday[] = [];
