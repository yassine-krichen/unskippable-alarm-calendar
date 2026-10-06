import {
  eventKindOf,
  eventOccurrencesBetween,
  isEventPassable,
  type EventKind,
  type EventRow,
  type ExamRole,
  type OccurrenceSettings,
  type PrayerName,
} from '@alarm-calendar/core';

import { contrastFor } from '@/features/events/event-colors';
import { addDays, startOfZonedDay, zonedDate } from '@/lib/zoned-time';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** One concrete ring time of an event, already resolved against cheat days. */
export interface Occurrence {
  /** Unique per event and start time, used as the calendar's event id. */
  key: string;
  eventId: string;
  title: string;
  start: Date;
  end: Date;
  /** Local calendar day of start in the settings timezone, 'yyyy-MM-dd'. */
  day: string;
  color: string | null;
  passable: boolean;
  /** True when a cheat day silences it: the alarm will not ring. */
  silenced: boolean;
  /** 'prayer' for one of the five daily prayers; the calendar draws those apart. */
  kind: EventKind;
  prayer: PrayerName | null;
  /** 'exam' for the alarm before an exam, 'session' for a revision session; null for any other alarm. */
  examRole: ExamRole | null;
}

export interface TimeRange {
  from: Date;
  to: Date;
}

/**
 * Expands every event into the occurrences that start inside range, using the shared
 * occurrence function (recurrence for a normal alarm, the prayer times for a prayer) so the
 * calendar and the alarm engines agree on what fires. The pre-prayer reminders are left out: five
 * more items a day would bury the calendar, and they are only a nudge towards the prayer shown.
 * The range is widened by a day on the left so a long event that began just before it still shows.
 */
export function expandOccurrences(
  events: readonly EventRow[],
  range: TimeRange,
  settings: OccurrenceSettings,
  cheatDays: readonly string[],
  /** Called for an event whose occurrences cannot be computed (it is skipped, the rest still shows). */
  onEventFailed?: (event: EventRow) => void
): Occurrence[] {
  const tz = settings.timezone;
  const cheatDaySet = new Set(cheatDays);
  const searchFrom = new Date(range.from.getTime() - MS_PER_DAY);
  const occurrences: Occurrence[] = [];

  for (const event of events) {
    if (!event.active) continue;
    const kind = eventKindOf(event);
    if (kind === 'pre_prayer') continue;
    const passable = isEventPassable(event);
    const durationMs = event.duration_min * MS_PER_MINUTE;
    let starts: Date[];
    try {
      starts = eventOccurrencesBetween(event, searchFrom, range.to, settings);
    } catch {
      // A malformed row or unusable prayer settings must not blank the whole calendar.
      onEventFailed?.(event);
      continue;
    }
    for (const start of starts) {
      const end = new Date(start.getTime() + durationMs);
      if (end.getTime() <= range.from.getTime()) continue;
      const day = zonedDate(start, tz);
      occurrences.push({
        key: `${event.id}@${start.toISOString()}`,
        eventId: event.id,
        title: event.title,
        start,
        end,
        day,
        color: event.color,
        passable,
        silenced: passable && cheatDaySet.has(day),
        kind,
        prayer: event.prayer ?? null,
        examRole: event.exam_role ?? null,
      });
    }
  }

  return occurrences.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export interface DayGroup {
  day: string;
  occurrences: Occurrence[];
}

/** Groups an ascending list of occurrences by local day, keeping the order. */
export function groupByDay(occurrences: readonly Occurrence[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const occurrence of occurrences) {
    const last = groups[groups.length - 1];
    if (last && last.day === occurrence.day) {
      last.occurrences.push(occurrence);
    } else {
      groups.push({ day: occurrence.day, occurrences: [occurrence] });
    }
  }
  return groups;
}

export interface DayImpact {
  /** Occurrences a cheat day would silence. */
  silenced: number;
  /** Occurrences that ring anyway because the event is not passable. */
  stillRing: number;
}

/**
 * What spending a pass on day would do, for the "This silences N events" line. For today only
 * the alarms still to come count: the ones that already rang cannot be silenced.
 */
export function dayImpact(
  events: readonly EventRow[],
  day: string,
  settings: OccurrenceSettings,
  now: Date = new Date()
): DayImpact {
  const tz = settings.timezone;
  const dayStart = startOfZonedDay(day, tz);
  const from = day === zonedDate(now, tz) && now.getTime() > dayStart.getTime() ? now : dayStart;
  const range = { from, to: startOfZonedDay(addDays(day, 1), tz) };
  let silenced = 0;
  let stillRing = 0;
  for (const occurrence of expandOccurrences(events, range, settings, [])) {
    if (occurrence.day !== day || occurrence.start.getTime() < from.getTime()) continue;
    if (occurrence.passable) silenced += 1;
    else stillRing += 1;
  }
  return { silenced, stillRing };
}

/** The class the calendar grid puts on greyed-out (silenced) occurrences. */
export const SILENCED_CLASS = 'occurrence-silenced';

/** The class for the five daily prayers, which the stylesheet draws apart from ordinary alarms. */
export const PRAYER_CLASS = 'occurrence-prayer';

/** Shape handed to FullCalendar: plain events, no rrule plugin. */
export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO 8601 UTC; the calendar converts to its own time zone. */
  start: string;
  end: string;
  color?: string;
  contrastColor?: string;
  /** Space-separated classes; the calendar attaches them to the event element. */
  className: string;
  extendedProps: {
    eventId: string;
    silenced: boolean;
    passable: boolean;
    prayer: boolean;
    examRole: ExamRole | null;
  };
}

export function toCalendarEvent(occurrence: Occurrence): CalendarEvent {
  const contrastColor = contrastFor(occurrence.color);
  return {
    id: occurrence.key,
    title: occurrence.title,
    start: occurrence.start.toISOString(),
    end: occurrence.end.toISOString(),
    ...(occurrence.color !== null ? { color: occurrence.color } : {}),
    ...(contrastColor !== undefined ? { contrastColor } : {}),
    className: [occurrence.silenced ? SILENCED_CLASS : '', occurrence.kind === 'prayer' ? PRAYER_CLASS : '']
      .filter((name) => name !== '')
      .join(' '),
    extendedProps: {
      eventId: occurrence.eventId,
      silenced: occurrence.silenced,
      passable: occurrence.passable,
      prayer: occurrence.kind === 'prayer',
      examRole: occurrence.examRole,
    },
  };
}
