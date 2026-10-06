import { occurrencesBetween, type RecurrenceEvent } from './recurrence';
import { PRAYER_NAMES, prayerDayOf, prayerOccurrencesBetween, resolvePrayerConfig } from './prayer-times';
import type { EventKind, EventRow, PrayerSettings, Settings } from './types';

/** An event as the occurrence rules see it: the recurrence fields plus what kind of alarm it is. */
export type OccurrenceEvent = RecurrenceEvent & Pick<EventRow, 'kind' | 'prayer'>;

/** What the occurrence rules need of the settings: the zone, and the prayer fields when prayers are on. */
export type OccurrenceSettings = Pick<Settings, 'timezone'> & Partial<PrayerSettings>;

/** Absent means a normal alarm (rows from before the kind column, and test fixtures). */
export function eventKindOf(event: Pick<EventRow, 'kind'>): EventKind {
  return event.kind ?? 'normal';
}

/** A cheat day never silences a prayer or its reminder, whatever the row's `passable` says. */
export function isEventPassable(event: Pick<EventRow, 'passable' | 'kind'>): boolean {
  return eventKindOf(event) === 'normal' && event.passable;
}

/**
 * Occurrences of an event in the half-open range [from, to): the one function the schedule, the
 * calendar and habit scoring all use. A normal alarm follows its recurrence rule (recurrence.ts); a
 * prayer or pre-prayer alarm follows the prayer times in `settings` and ignores its own start_at and
 * repeat columns. Returns nothing for an inactive event, and nothing for a prayer event while
 * prayers are switched off. Throws RangeError for a malformed event or prayer settings.
 */
export function eventOccurrencesBetween(
  event: OccurrenceEvent,
  from: Date,
  to: Date,
  settings: OccurrenceSettings
): Date[] {
  const kind = eventKindOf(event);
  if (kind === 'normal') return occurrencesBetween(event, from, to, settings.timezone);

  if (event.prayer == null || !PRAYER_NAMES.includes(event.prayer)) {
    throw new RangeError(`A ${kind} event needs a prayer, got ${String(event.prayer)}`);
  }
  if (!event.active) return [];
  const config = resolvePrayerConfig(settings);
  if (config === null) return [];
  return prayerOccurrencesBetween(kind, event.prayer, config, from, to, settings.timezone);
}

/**
 * What identifies a prayer occurrence for completion matching: its event and its prayer-day (see
 * prayerDayOf), not its exact instant. A completion is keyed by the instant its alarm had, and changing the
 * prayer settings moves later alarms by minutes; matching by instant would orphan "prayed at 05:59" when the
 * 06:01 alarm appears, ring it again and score it missed. Null for a normal alarm (it keeps matching by
 * exact instant) and while prayers are off. Throws RangeError for malformed prayer settings, like
 * eventOccurrencesBetween.
 */
export function prayerDayKey(
  event: Pick<EventRow, 'id' | 'kind' | 'prayer'>,
  instant: Date,
  settings: OccurrenceSettings
): string | null {
  const kind = eventKindOf(event);
  if (kind === 'normal') return null;
  if (event.prayer == null || !PRAYER_NAMES.includes(event.prayer)) return null;
  const config = resolvePrayerConfig(settings);
  if (config === null) return null;
  const lead = kind === 'pre_prayer' ? config.prePrayerMinutes * 60_000 : 0;
  return `${event.id}|${prayerDayOf(config, event.prayer, instant, settings.timezone, lead)}`;
}
