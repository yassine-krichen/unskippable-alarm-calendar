import { occurrencesBetween } from './recurrence';
import { isSilencedByCheatDay } from './snooze';
import { assertValidTimeZone } from './time-zone';
import type {
  AlarmSettings,
  CompletionRow,
  EventRow,
  ScheduleEventInfo,
  ScheduleOccurrence,
  SchedulePayload,
} from './types';

/**
 * The precomputed schedule (roadmap v2, phase 3). One pipeline turns the user's data into a flat
 * list of concrete occurrences; the platform engines only ring what is in the list, so the Kotlin
 * AlarmEngine needs no recurrence, cheat day, completion or (later) prayer and mode logic.
 *
 * Pipeline: sources (today the event series; prayer times and exam revision sessions join here as
 * further candidate lists) -> annotations (cheat days, completions; modes join here as transforms)
 * -> sort, dedupe and bound. Everything after the sources works on ScheduleOccurrence records, not
 * on events, which is what lets a prayer occurrence flow through unchanged.
 */

export const DEFAULT_HORIZON_DAYS = 60;

/**
 * Total size of one list (see docs/decisions.md for the byte sizes). Real calendars are far below it (20 alarms with a daily repeat make
 * 1200); hourly alarms are what fill it: one is 1440 over the default horizon.
 */
export const MAX_SCHEDULE_OCCURRENCES = 5000;

/** Per event, so one dense alarm cannot crowd out everything else. An hourly alarm over 60 days fits. */
export const MAX_OCCURRENCES_PER_EVENT = 1500;

/**
 * How far back the grace window can reach, so an occurrence missed while the device was off can
 * still ring. Matches how long the engine remembers completions; a larger `grace_minutes` setting
 * behaves as this value (validation and the engines clamp to it).
 */
export const MAX_LOOKBACK_MINUTES = 7 * 24 * 60;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** The identity of an occurrence: the same string the alarm screen and the completion upsert use. */
export function makeOccurrenceId(eventId: string, at: Date): string {
  return `${eventId}@${at.toISOString()}`;
}

export interface ExpandScheduleInput {
  events: readonly EventRow[];
  /** 'yyyy-MM-dd' in the user's timezone. */
  cheatDays: readonly string[];
  settings: Pick<AlarmSettings, 'timezone' | 'grace_minutes' | 'sound'>;
  /** Any completion marks its occurrence completed, whatever its status. */
  completions: ReadonlyArray<Pick<CompletionRow, 'event_id' | 'occurrence_at'>>;
  now: Date;
  /** Defaults to DEFAULT_HORIZON_DAYS. */
  horizonDays?: number;
  /** An event the recurrence rules refuse (malformed row) is skipped, and reported here. */
  onEventFailed?: (eventId: string, error: unknown) => void;
}

export interface ExpandedSchedule {
  /** Ascending by `at`, then event id, no duplicate ids. */
  occurrences: ScheduleOccurrence[];
  /** Per active event, whether or not it has an occurrence in range. */
  eventInfo: Record<string, ScheduleEventInfo>;
  /** The list is complete for every active event up to this instant, inclusive. */
  horizonEnd: string;
  /** True when a size cap shortened the horizon. */
  truncated: boolean;
}

/**
 * Expands the active events into concrete occurrences from `now` up to `now` plus the horizon,
 * flagging each as silenced (cheat day, passable events only) or completed. Before `now` it keeps
 * only the latest occurrence of each event inside the grace window: of several missed ones only
 * that one can ring, so the older ones would be dead weight.
 *
 * Bounded: at most MAX_OCCURRENCES_PER_EVENT per event and MAX_SCHEDULE_OCCURRENCES in all. When a
 * cap cuts occurrences off, the horizon moves back to just before the first one cut, so the list
 * stays truthful ("complete through horizonEnd") and the caller refills sooner. `truncated` says
 * it happened. A cap never cuts at or before `now`: the horizon never ends before it starts, and
 * the backfilled occurrence of an event is never traded for a later one.
 *
 * Not a bare array (as first sketched): a caller needs the possibly shortened horizon too.
 */
export function expandSchedule(input: ExpandScheduleInput): ExpandedSchedule {
  const { events, cheatDays, settings, completions, now } = input;
  const horizonDays = input.horizonDays ?? DEFAULT_HORIZON_DAYS;
  assertValidTimeZone(settings.timezone);

  const nowMs = now.getTime();
  const windowStart = new Date(
    nowMs - Math.min(settings.grace_minutes, MAX_LOOKBACK_MINUTES) * MS_PER_MINUTE
  );
  const requestedEndMs = nowMs + horizonDays * MS_PER_DAY;
  const soundId = settings.sound ?? null;
  const completedIds = completedOccurrenceIds(completions);

  // First instant that must NOT be in the list because a cap cut occurrences from there on.
  let cutAtMs = Infinity;
  const candidates: ScheduleOccurrence[] = [];
  const eventInfo: Record<string, ScheduleEventInfo> = {};

  for (const event of events) {
    if (!event.active) continue;
    eventInfo[event.id] = {
      title: event.title,
      notes: event.notes,
      maxSnoozes: event.max_snoozes,
      snoozeMinutes: event.snooze_minutes,
      soundId,
    };

    let instants: Date[];
    try {
      // occurrencesBetween is half-open; +1 ms makes the horizon inclusive.
      instants = occurrencesBetween(event, windowStart, new Date(requestedEndMs + 1), settings.timezone);
    } catch (error) {
      input.onEventFailed?.(event.id, error);
      continue;
    }
    const firstFuture = instants.findIndex((at) => at.getTime() > nowMs);
    const pastCount = firstFuture === -1 ? instants.length : firstFuture;
    const latestPast = pastCount > 0 ? [instants[pastCount - 1]!] : [];
    let future = firstFuture === -1 ? [] : instants.slice(firstFuture);
    const futureRoom = MAX_OCCURRENCES_PER_EVENT - latestPast.length;
    if (future.length > futureRoom) {
      // Always after now: only future occurrences are ever cut.
      cutAtMs = Math.min(cutAtMs, future[futureRoom]!.getTime());
      future = future.slice(0, futureRoom);
    }
    for (const at of [...latestPast, ...future]) {
      const id = makeOccurrenceId(event.id, at);
      candidates.push({
        id,
        eventId: event.id,
        at: at.toISOString(),
        silenced: isSilencedByCheatDay(event, at, cheatDays, settings.timezone),
        completed: completedIds.has(id),
      });
    }
  }

  const sorted = sortAndDedupe(candidates.filter((occurrence) => Date.parse(occurrence.at) < cutAtMs));
  let bounded = sorted;
  if (sorted.length > MAX_SCHEDULE_OCCURRENCES) {
    // Cut at an instant boundary, never between two occurrences of the same instant, and never at
    // or before now (if the backfilled occurrences alone exceed the cap, they all stay).
    const firstCut = Math.max(Date.parse(sorted[MAX_SCHEDULE_OCCURRENCES]!.at), nowMs + 1);
    cutAtMs = Math.min(cutAtMs, firstCut);
    bounded = sorted.filter((occurrence) => Date.parse(occurrence.at) < cutAtMs);
  }

  const truncated = cutAtMs !== Infinity;
  const horizonEndMs = truncated ? Math.min(requestedEndMs, cutAtMs - 1) : requestedEndMs;
  return {
    occurrences: bounded,
    eventInfo,
    horizonEnd: new Date(horizonEndMs).toISOString(),
    truncated,
  };
}

/** The payload an engine receives: the expanded list plus what main needs to refill it. */
export function buildSchedulePayload(
  input: Omit<ExpandScheduleInput, 'settings'> & { settings: AlarmSettings }
): SchedulePayload {
  const expanded = expandSchedule(input);
  return {
    version: 2,
    generatedAt: input.now.toISOString(),
    horizonEnd: expanded.horizonEnd,
    truncated: expanded.truncated,
    // A grace window beyond the look-back behaves as the look-back; say so, so validation can be strict.
    settings: {
      ...input.settings,
      grace_minutes: Math.min(input.settings.grace_minutes, MAX_LOOKBACK_MINUTES),
    },
    occurrences: expanded.occurrences,
    eventInfo: expanded.eventInfo,
    refillSource: { events: [...input.events], cheatDays: [...input.cheatDays] },
  };
}

function completedOccurrenceIds(
  completions: ReadonlyArray<Pick<CompletionRow, 'event_id' | 'occurrence_at'>>
): Set<string> {
  const ids = new Set<string>();
  for (const completion of completions) {
    const at = new Date(completion.occurrence_at);
    // Supabase writes '+00:00', the ids use 'Z'; a row with an unreadable instant matches nothing.
    if (!Number.isNaN(at.getTime())) ids.add(makeOccurrenceId(completion.event_id, at));
  }
  return ids;
}

function sortAndDedupe(occurrences: ScheduleOccurrence[]): ScheduleOccurrence[] {
  const byId = new Map<string, ScheduleOccurrence>();
  for (const occurrence of occurrences) byId.set(occurrence.id, occurrence);
  return [...byId.values()].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0)
  );
}
