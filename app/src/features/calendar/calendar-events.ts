import { occurrencesBetween, type EventRow } from '@alarm-calendar/core';

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
}

export interface TimeRange {
  from: Date;
  to: Date;
}

/**
 * Expands every event into the occurrences that start inside range, using the shared
 * recurrence function so the calendar and the alarm engines agree on what fires.
 * The range is widened by a day on the left so a long event that began just before it still shows.
 */
export function expandOccurrences(
  events: readonly EventRow[],
  range: TimeRange,
  tz: string,
  cheatDays: readonly string[]
): Occurrence[] {
  const cheatDaySet = new Set(cheatDays);
  const searchFrom = new Date(range.from.getTime() - MS_PER_DAY);
  const occurrences: Occurrence[] = [];

  for (const event of events) {
    if (!event.active) continue;
    const durationMs = event.duration_min * MS_PER_MINUTE;
    for (const start of occurrencesBetween(event, searchFrom, range.to, tz)) {
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
        passable: event.passable,
        silenced: event.passable && cheatDaySet.has(day),
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
  tz: string,
  now: Date = new Date()
): DayImpact {
  const dayStart = startOfZonedDay(day, tz);
  const from = day === zonedDate(now, tz) && now.getTime() > dayStart.getTime() ? now : dayStart;
  const range = { from, to: startOfZonedDay(addDays(day, 1), tz) };
  let silenced = 0;
  let stillRing = 0;
  for (const occurrence of expandOccurrences(events, range, tz, [])) {
    if (occurrence.day !== day || occurrence.start.getTime() < from.getTime()) continue;
    if (occurrence.passable) silenced += 1;
    else stillRing += 1;
  }
  return { silenced, stillRing };
}

/** The class the calendar grid puts on greyed-out (silenced) occurrences. */
export const SILENCED_CLASS = 'occurrence-silenced';

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
  extendedProps: { eventId: string; silenced: boolean; passable: boolean };
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
    className: occurrence.silenced ? SILENCED_CLASS : '',
    extendedProps: {
      eventId: occurrence.eventId,
      silenced: occurrence.silenced,
      passable: occurrence.passable,
    },
  };
}
