import { eventKindOf, eventOccurrencesBetween, prayerDayKey } from './occurrences';
import {
  prePrayerLabel,
  previousPrayer,
  resolvePrayerConfig,
  unloggedPrayerLabel,
  type PrayerConfig,
} from './prayer-times';
import { isSilencedByCheatDay } from './snooze';
import { assertValidTimeZone } from './time-zone';
import type {
  AlarmSettings,
  CompletionRow,
  EventRow,
  PrayerName,
  PrayerSettings,
  ScheduleEventInfo,
  ScheduleOccurrence,
  SchedulePayload,
} from './types';

/**
 * The precomputed schedule (roadmap v2, phase 3). One pipeline turns the user's data into a flat
 * list of concrete occurrences; the platform engines only ring what is in the list, so the Kotlin
 * AlarmEngine needs no recurrence, cheat day, completion or (later) prayer and mode logic.
 *
 * Pipeline: sources (the event series, which for a prayer event means the prayer times; exam
 * revision sessions join here later) -> annotations (cheat days, completions; modes join here as
 * transforms) -> sort, dedupe and bound. Everything after the sources works on ScheduleOccurrence
 * records, not on events, which is what lets a prayer occurrence flow through unchanged. Where an
 * occurrence comes from (a recurrence rule or the prayer times) is decided in one place,
 * eventOccurrencesBetween.
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
  settings: Pick<AlarmSettings, 'timezone' | 'grace_minutes' | 'sound' | 'prayerSound'> & Partial<PrayerSettings>;
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

  // Prayer settings that cannot be used fail every prayer event, and only those. Prayers switched
  // off (no config) leave their events out of the schedule altogether, so a ringing prayer alarm is
  // dismissed when the user turns prayers off.
  let prayerConfig: PrayerConfig | null = null;
  let prayerConfigError: { error: unknown } | null = null;
  try {
    prayerConfig = resolvePrayerConfig(settings);
  } catch (error) {
    prayerConfigError = { error };
  }
  const prayerEvents = prayerEventsByPrayer(events);
  // A prayer completion is matched by event and prayer-day, not by exact instant (see prayerDayKey):
  // changing an offset or the location moves the alarm, and a done prayer must stay done.
  const completedPrayerDays =
    prayerConfig === null ? new Set<string>() : completedPrayerDayKeys(events, completions, settings);
  const isCompleted = (event: EventRow, at: Date): boolean => {
    if (completedIds.has(makeOccurrenceId(event.id, at))) return true;
    if (eventKindOf(event) === 'normal' || prayerConfig === null) return false;
    const key = prayerDayKey(event, at, settings);
    return key !== null && completedPrayerDays.has(key);
  };

  // First instant that must NOT be in the list because a cap cut occurrences from there on.
  let cutAtMs = Infinity;
  const candidates: ScheduleOccurrence[] = [];
  const eventInfo: Record<string, ScheduleEventInfo> = {};

  for (const event of events) {
    if (!event.active) continue;
    const kind = eventKindOf(event);
    if (kind !== 'normal') {
      if (prayerConfigError !== null) {
        input.onEventFailed?.(event.id, prayerConfigError.error);
        continue;
      }
      if (prayerConfig === null) continue;
    }
    eventInfo[event.id] = eventInfoOf(event, soundId, settings.prayerSound ?? soundId, prayerConfig);

    let instants: Date[];
    try {
      // The range is half-open; +1 ms makes the horizon inclusive.
      instants = eventOccurrencesBetween(event, windowStart, new Date(requestedEndMs + 1), settings);
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
      const occurrence: ScheduleOccurrence = {
        id,
        eventId: event.id,
        at: at.toISOString(),
        silenced: isSilencedByCheatDay(event, at, cheatDays, settings.timezone),
        completed: isCompleted(event, at),
      };
      if (kind === 'pre_prayer' && prayerConfig !== null && event.prayer != null) {
        Object.assign(
          occurrence,
          prePrayerText(event.prayer, at, prayerConfig, prayerEvents, isCompleted, settings.timezone)
        );
      }
      candidates.push(occurrence);
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

function eventInfoOf(
  event: EventRow,
  soundId: string | null,
  prayerSoundId: string | null,
  prayerConfig: PrayerConfig | null
): ScheduleEventInfo {
  const kind = eventKindOf(event);
  if (kind === 'normal' || prayerConfig === null) {
    return {
      title: event.title,
      notes: event.notes,
      maxSnoozes: event.max_snoozes,
      snoozeMinutes: event.snooze_minutes,
      soundId,
    };
  }
  return {
    title: event.title,
    notes: event.notes,
    // The snooze rules of the prayer alarms are one setting, not a per-row choice.
    maxSnoozes: prayerConfig.maxSnoozes,
    snoozeMinutes: prayerConfig.snoozeMinutes,
    // The prayer itself may use another sound (a takbir recording); its reminder is a plain alarm.
    soundId: kind === 'prayer' ? prayerSoundId : soundId,
    kind,
    ...(event.prayer ? { prayer: event.prayer } : {}),
  };
}

function prayerEventsByPrayer(events: readonly EventRow[]): Partial<Record<PrayerName, EventRow>> {
  const byPrayer: Partial<Record<PrayerName, EventRow>> = {};
  for (const event of events) {
    if (event.active && eventKindOf(event) === 'prayer' && event.prayer) byPrayer[event.prayer] = event;
  }
  return byPrayer;
}

/** The prayer-day keys of the completions that belong to a prayer or pre-prayer event. */
function completedPrayerDayKeys(
  events: readonly EventRow[],
  completions: ReadonlyArray<Pick<CompletionRow, 'event_id' | 'occurrence_at'>>,
  settings: ExpandScheduleInput['settings']
): Set<string> {
  const prayerEventsById = new Map<string, EventRow>();
  for (const event of events) {
    if (event.active && eventKindOf(event) !== 'normal') prayerEventsById.set(event.id, event);
  }
  const keys = new Set<string>();
  for (const completion of completions) {
    const event = prayerEventsById.get(completion.event_id);
    const at = new Date(completion.occurrence_at);
    if (event === undefined || Number.isNaN(at.getTime())) continue;
    const key = prayerDayKey(event, at, settings);
    if (key !== null) keys.add(key);
  }
  return keys;
}

/**
 * The text of one pre-prayer alarm: "Asr in 15 min", unless the prayer before it is not known to be
 * completed, in which case the alternative ("You haven't logged Dhuhr ...") goes along as
 * `labelIfUnlogged` and the engine picks when the alarm rings, whether that prayer is behind us or
 * still to come. The list cannot decide: it is built before the day happens, and a completion made
 * later (or on another device) must still win. Prayers from before the user switched prayers on do not
 * count, and neither does one that is not over when the reminder rings.
 */
function prePrayerText(
  prayer: PrayerName,
  at: Date,
  config: PrayerConfig,
  prayerEvents: Partial<Record<PrayerName, EventRow>>,
  isCompleted: (event: EventRow, at: Date) => boolean,
  tz: string
): Pick<ScheduleOccurrence, 'label' | 'labelIfUnlogged'> {
  const plain = prePrayerLabel(prayer, config.prePrayerMinutes);
  const prayerAt = new Date(at.getTime() + config.prePrayerMinutes * MS_PER_MINUTE);
  const previous = previousPrayer(config, prayer, prayerAt, tz);
  const previousEvent = previous === null ? undefined : prayerEvents[previous.prayer];
  if (previous === null || previousEvent === undefined) return { label: plain };
  const previousMs = previous.at.getTime();
  if (previousMs > at.getTime()) return { label: plain };
  if (config.enabledSinceMs !== null && previousMs < config.enabledSinceMs) return { label: plain };
  if (isCompleted(previousEvent, previous.at)) return { label: plain };
  return {
    label: plain,
    labelIfUnlogged: {
      id: makeOccurrenceId(previousEvent.id, previous.at),
      label: unloggedPrayerLabel(previous.prayer, prayer),
    },
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
