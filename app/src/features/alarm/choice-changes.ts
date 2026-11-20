import type { PrayerChoices } from '@alarm-calendar/core';

const MINUTE_MS = 60_000;

/**
 * The next instant at which what a prayer's choices show changes by itself: a Later option stops fitting (10 minutes
 * before the window ends, minus its own length), or Can't now turns into the give-up button (a minute before the last
 * call). Null when nothing is left to change. The alarm screen redraws from the engine then, so a stale button is
 * never left on screen.
 */
export function nextChoiceChangeMs(choices: PrayerChoices, nowMs: number): number | null {
  const endMs = Date.parse(choices.windowEnd);
  const boundaries = [
    ...(choices.cantNow === 'until_last_call' ? [Date.parse(choices.lastCallAt) - MINUTE_MS] : []),
    // An option is offered while now + minutes <= end - 10 min, so it is gone one millisecond after that.
    ...choices.laterMinutes.map((minutes) => endMs - 10 * MINUTE_MS - minutes * MINUTE_MS + 1),
  ].filter((at) => Number.isFinite(at) && at > nowMs);
  return boundaries.length === 0 ? null : Math.min(...boundaries);
}
