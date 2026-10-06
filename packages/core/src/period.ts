import type { EventRow } from './types';

/**
 * How often the habit nominally repeats, in days: hours / 24, days as is, weeks times 7 divided
 * by the number of chosen weekdays, months times 30, years times 365. Only a yardstick for the window.
 */
export function nominalPeriodDays(
  event: Pick<EventRow, 'repeat_unit' | 'repeat_interval' | 'repeat_weekdays'>
): number {
  const interval = event.repeat_interval;
  switch (event.repeat_unit) {
    case 'hour':
      return interval / 24;
    case 'day':
      return interval;
    case 'week': {
      const weekdays = new Set(event.repeat_weekdays ?? []).size;
      return (interval * 7) / Math.max(1, weekdays);
    }
    case 'month':
      return interval * 30;
    case 'year':
      return interval * 365;
    case 'none':
      return 0;
  }
}
