import type { EventRow, Settings } from './types';
import { isEventPassable } from './occurrences';
import { localDateString } from './time-zone';

const MS_PER_MINUTE = 60_000;

type SnoozeRules = Pick<EventRow, 'max_snoozes' | 'snooze_minutes'>;

export interface SnoozeResult {
  snoozesUsed: number;
  /** When the alarm rings again. */
  refireAt: Date;
}

export interface SnoozeUi {
  /** Button label, or null when the button must not be shown. */
  label: string | null;
  /** Shown instead of the button once a snooze limit above 0 is used up. */
  notice: string | null;
}

export function snoozesLeft(event: SnoozeRules, snoozesUsed: number): number {
  return Math.max(0, event.max_snoozes - snoozesUsed);
}

/** max_snoozes = 0 never allows a snooze. */
export function canSnooze(event: SnoozeRules, snoozesUsed: number): boolean {
  return snoozesLeft(event, snoozesUsed) > 0;
}

export function snoozeUi(event: SnoozeRules, snoozesUsed: number): SnoozeUi {
  if (canSnooze(event, snoozesUsed)) {
    const left = snoozesLeft(event, snoozesUsed);
    return { label: `Snooze ${event.snooze_minutes} min (${left} left)`, notice: null };
  }
  // With max_snoozes = 0 no snooze was ever offered, so there is nothing to explain.
  const notice = event.max_snoozes > 0 ? 'No snoozes left, do it now' : null;
  return { label: null, notice };
}

export function applySnooze(event: SnoozeRules, snoozesUsed: number, now: Date): SnoozeResult {
  if (!canSnooze(event, snoozesUsed)) {
    throw new RangeError('No snoozes left for this occurrence');
  }
  return {
    snoozesUsed: snoozesUsed + 1,
    refireAt: new Date(now.getTime() + event.snooze_minutes * MS_PER_MINUTE),
  };
}

/** Re-ring time after the alarm UI was closed without Done or Snooze. */
export function refireAfterDismissal(settings: Pick<Settings, 'refire_seconds'>, now: Date): Date {
  return new Date(now.getTime() + settings.refire_seconds * 1000);
}

/**
 * Whether a device that was off or asleep should ring immediately for an
 * occurrence it missed. Future occurrences are not missed yet, and the window
 * is inclusive of exactly grace_minutes.
 */
export function shouldRingMissedOccurrence(
  occurrenceAt: Date,
  now: Date,
  graceMinutes: number,
  alreadyCompleted: boolean
): boolean {
  if (alreadyCompleted) return false;
  const lateMs = now.getTime() - occurrenceAt.getTime();
  return lateMs >= 0 && lateMs <= graceMinutes * MS_PER_MINUTE;
}

/**
 * A cheat day silences an occurrence only for passable events, by the occurrence's local date.
 * Prayer alarms are never passable (see isEventPassable).
 */
export function isSilencedByCheatDay(
  event: Pick<EventRow, 'passable' | 'kind'>,
  occurrenceAt: Date,
  cheatDays: readonly string[],
  tz: string
): boolean {
  return isEventPassable(event) && cheatDays.includes(localDateString(occurrenceAt, tz));
}
