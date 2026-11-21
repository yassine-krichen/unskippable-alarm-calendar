import type { EventRow } from '@alarm-calendar/core';

import { formatDay, weekdayShortName, zonedParts } from '@/lib/zoned-time';

import { describeRepeat } from './repeat-presets';

/** 'Every week on Mon, Wed, Fri', 'Every 2 days', 'Does not repeat'. */
export function describeRepeatRule(
  event: Pick<EventRow, 'repeat_unit' | 'repeat_interval' | 'repeat_weekdays'>
): string {
  const base = describeRepeat({ unit: event.repeat_unit, interval: event.repeat_interval });
  const weekdays = event.repeat_weekdays;
  // Every day of the week listed is just "every week"; naming all seven would only add noise.
  if (event.repeat_unit !== 'week' || weekdays === null || weekdays.length === 0 || weekdays.length === 7) return base;
  return `${base} on ${[...weekdays].sort((a, b) => a - b).map(weekdayShortName).join(', ')}`;
}

/** '3 snoozes, 5 min each', or 'No snooze: you have to answer on the spot'. */
export function describeSnooze(maxSnoozes: number, snoozeMinutes: number): string {
  if (maxSnoozes === 0) return 'No snooze: you have to answer on the spot';
  return `${maxSnoozes} ${maxSnoozes === 1 ? 'snooze' : 'snoozes'}, ${snoozeMinutes} min each`;
}

/** 'Today 09:00 · 45 min' or 'Mon, Nov 23 09:00 · 45 min', in the settings zone. */
export function describeWhen(start: Date, durationMin: number, tz: string, today: string): string {
  const parts = zonedParts(start, tz);
  const day = parts.date === today ? 'Today' : formatDay(parts.date);
  return `${day} ${parts.time} · ${durationMin} min`;
}
