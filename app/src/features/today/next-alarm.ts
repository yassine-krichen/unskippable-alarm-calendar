import type { Occurrence } from '@/features/calendar/calendar-events';

/**
 * The next ring after `now`: the earliest occurrence that will actually ring. One a cheat day silenced or a mode
 * paused is skipped (it will not ring); one hidden from the calendar still counts (it rings all the same).
 */
export function findNextOccurrence(occurrences: readonly Occurrence[], now: Date): Occurrence | null {
  let next: Occurrence | null = null;
  for (const occurrence of occurrences) {
    if (occurrence.silenced || occurrence.paused) continue;
    if (occurrence.start.getTime() <= now.getTime()) continue;
    if (next === null || occurrence.start.getTime() < next.start.getTime()) next = occurrence;
  }
  return next;
}

const MS_PER_MINUTE = 60_000;

/** 'in 2h 10m', 'in 45m', 'in 3 days', or 'now' within the minute. Rounded up, so "in 1m" never reads as "now" early. */
export function formatCountdown(ms: number): string {
  const minutes = Math.ceil(ms / MS_PER_MINUTE);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `in ${hours}h` : `in ${hours}h ${rest}m`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'in 1 day' : `in ${days} days`;
}
