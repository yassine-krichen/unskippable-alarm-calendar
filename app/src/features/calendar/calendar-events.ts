import {
  MAX_SHIFT_MS,
  applyModesToInstants,
  buildModeTimeline,
  eventKindOf,
  eventOccurrencesBetween,
  isEventPassable,
  type EventKind,
  type EventRow,
  type ExamRole,
  type ModeTimeline,
  type OccurrenceSettings,
  type PrayerName,
} from '@alarm-calendar/core';

import {
  CATEGORY_CHIP_CLASS,
  CATEGORY_COLORS,
  alarmCategoryOf,
  type AlarmCategory,
} from '@/features/events/category-colors';
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
  /** A mode skips it (roadmap v2, phase 5): it does not ring and is not scored. Shown greyed with the mode's name. */
  paused: boolean;
  /** A mode moved it: `start` is where it rings now. */
  shifted: boolean;
  /** The mode that paused, shifted or shortened it; null when nothing changed. */
  modeName: string | null;
  /** Birthday, exam alarm, revision session or catch-up: its colour is fixed (index.css `--cat-*`). Null for the rest. */
  category: AlarmCategory | null;
  /**
   * Hidden from the calendar by the person (the alarm's "Show in calendar" switch, or the prayers' one in Settings).
   * It rings and counts in habits all the same; `visibleOccurrences` leaves it out unless "Show hidden" is on.
   */
  hidden: boolean;
}

/**
 * Whether the calendar leaves an alarm out by default. A prayer follows the one Settings switch (off by default, and
 * its own row's flag is ignored); any other alarm follows its own `show_in_calendar`. Presentation only: nothing that
 * decides what rings or what is scored reads this.
 */
export function isHiddenFromCalendar(
  event: Pick<EventRow, 'kind' | 'show_in_calendar'>,
  settings: OccurrenceSettings
): boolean {
  if (eventKindOf(event) === 'prayer') return settings.show_prayers_in_calendar !== true;
  return event.show_in_calendar === false;
}

/** Whether any active alarm is hidden, so the toolbar knows when to offer "Show hidden". */
export function hasHiddenAlarms(events: readonly EventRow[], settings: OccurrenceSettings): boolean {
  return events.some(
    (event) =>
      event.active &&
      eventKindOf(event) !== 'pre_prayer' &&
      (eventKindOf(event) !== 'prayer' || settings.prayers_enabled === true) &&
      isHiddenFromCalendar(event, settings)
  );
}

/**
 * How many distinct alarms in `occurrences` are hidden, for the Agenda's note. The prayers are left out: they are
 * hidden by default (five a day would make the number meaningless) and Settings says so.
 */
export function hiddenAlarmCount(occurrences: readonly Occurrence[]): number {
  return new Set(
    occurrences.filter((occurrence) => occurrence.hidden && occurrence.kind !== 'prayer').map((occurrence) => occurrence.eventId)
  ).size;
}

/** What the views draw: everything, or without the hidden alarms (the default). */
export function visibleOccurrences(occurrences: readonly Occurrence[], showHidden: boolean): Occurrence[] {
  return showHidden ? [...occurrences] : occurrences.filter((occurrence) => !occurrence.hidden);
}

const NO_MODES = buildModeTimeline(undefined, { timezone: 'UTC' });

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
  onEventFailed?: (event: EventRow) => void,
  /** The modes in effect: skipped occurrences stay in the list, flagged `paused`; shifted ones show where they ring. */
  modes?: ModeTimeline
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
    const hidden = isHiddenFromCalendar(event, settings);
    const category = alarmCategoryOf(event);
    const durationMs = event.duration_min * MS_PER_MINUTE;
    let moded: ReturnType<typeof applyModesToInstants>;
    try {
      // A shift moves an occurrence up to 12 hours, so look that much further and filter on where it rings.
      const slack = modes?.active === true && kind === 'normal' ? MAX_SHIFT_MS : 0;
      const starts = eventOccurrencesBetween(
        event,
        new Date(searchFrom.getTime() - slack),
        new Date(range.to.getTime() + slack),
        settings
      );
      moded = applyModesToInstants(event, starts, modes ?? NO_MODES);
    } catch {
      // A malformed row or unusable prayer settings must not blank the whole calendar.
      onEventFailed?.(event);
      continue;
    }
    for (const { at: start, paused, durationMin, mode, original } of moded) {
      const end = new Date(start.getTime() + (durationMin === null ? durationMs : durationMin * MS_PER_MINUTE));
      if (start.getTime() >= range.to.getTime() || end.getTime() <= range.from.getTime()) continue;
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
        // A paused alarm does not ring either way; the mode, not the cheat day, is why it is grey.
        silenced: !paused && passable && cheatDaySet.has(day),
        kind,
        prayer: event.prayer ?? null,
        examRole: event.exam_role ?? null,
        paused,
        shifted: original.getTime() !== start.getTime(),
        modeName: mode?.name ?? null,
        category,
        hidden,
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
  now: Date = new Date(),
  /** Alarms a mode pauses neither ring nor can be silenced, so they are not counted. */
  modes?: ModeTimeline
): DayImpact {
  const tz = settings.timezone;
  const dayStart = startOfZonedDay(day, tz);
  const from = day === zonedDate(now, tz) && now.getTime() > dayStart.getTime() ? now : dayStart;
  const range = { from, to: startOfZonedDay(addDays(day, 1), tz) };
  let silenced = 0;
  let stillRing = 0;
  for (const occurrence of expandOccurrences(events, range, settings, [], undefined, modes)) {
    if (occurrence.day !== day || occurrence.start.getTime() < from.getTime() || occurrence.paused) continue;
    if (occurrence.passable) silenced += 1;
    else stillRing += 1;
  }
  return { silenced, stillRing };
}

/** The class the calendar grid puts on greyed-out (silenced) occurrences. */
export const SILENCED_CLASS = 'occurrence-silenced';

/** The class for an occurrence a mode skips: dashed and greyed, so it reads as "not going to ring". */
export const PAUSED_CLASS = 'occurrence-paused';

/** The class for the five daily prayers, which the stylesheet draws apart from ordinary alarms. */
export const PRAYER_CLASS = 'occurrence-prayer';

/** The class for an alarm hidden from the calendar that "Show hidden" has brought back: faded. */
export const HIDDEN_CLASS = 'occurrence-hidden';

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
    paused: boolean;
    modeName: string | null;
    hidden: boolean;
    category: AlarmCategory | null;
  };
}

export function toCalendarEvent(occurrence: Occurrence): CalendarEvent {
  // A category's colour is fixed: it wins over whatever colour the row carries (the form no longer offers one).
  const fixed = occurrence.category === null ? undefined : CATEGORY_COLORS[occurrence.category];
  const color = fixed?.color ?? occurrence.color;
  const contrastColor = fixed?.contrast ?? contrastFor(occurrence.color);
  return {
    id: occurrence.key,
    title: occurrence.title,
    start: occurrence.start.toISOString(),
    end: occurrence.end.toISOString(),
    ...(color !== null ? { color } : {}),
    ...(contrastColor !== undefined ? { contrastColor } : {}),
    className: [
      occurrence.silenced ? SILENCED_CLASS : '',
      occurrence.paused ? PAUSED_CLASS : '',
      occurrence.kind === 'prayer' ? PRAYER_CLASS : '',
      occurrence.category === null ? '' : CATEGORY_CHIP_CLASS[occurrence.category],
      occurrence.hidden ? HIDDEN_CLASS : '',
    ]
      .filter((name) => name !== '')
      .join(' '),
    extendedProps: {
      eventId: occurrence.eventId,
      silenced: occurrence.silenced,
      passable: occurrence.passable,
      prayer: occurrence.kind === 'prayer',
      examRole: occurrence.examRole,
      paused: occurrence.paused,
      modeName: occurrence.modeName,
      hidden: occurrence.hidden,
      category: occurrence.category,
    },
  };
}
