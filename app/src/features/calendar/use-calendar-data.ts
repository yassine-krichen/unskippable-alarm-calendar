import type { CalendarHoliday, ModeRow, Settings, StretchDay } from '@alarm-calendar/core';
import { useMemo } from 'react';

import { useEventsStore } from '@/features/events/events-store';
import { toHolidayCalendarEvents, type HolidayCalendarEvent } from '@/features/holidays/holiday-events';
import { useHolidays } from '@/features/holidays/use-holidays';
import { modesByDay } from '@/features/modes/mode-status';
import { useModeTimeline } from '@/features/modes/use-modes';
import { usePassesStore } from '@/features/passes/passes-store';

import {
  expandOccurrences,
  hasHiddenAlarms,
  hiddenAlarmCount,
  toCalendarEvent,
  visibleOccurrences,
  type CalendarEvent,
  type Occurrence,
} from './calendar-events';
import { rangeToInstants, visibleDayRange, type CalendarView, type DayRange } from './calendar-range';
import { useShowHiddenStore } from './show-hidden-preference';

export interface CalendarData {
  range: DayRange;
  /** Every occurrence in the range, hidden ones included (details lookups need them). */
  allOccurrences: Occurrence[];
  occurrences: Occurrence[];
  /** A one-line notice for alarms that could not be laid out, or null. */
  skipped: string | null;
  hiddenInRange: number;
  offerShowHidden: boolean;
  showHidden: boolean;
  setShowHidden: (show: boolean) => void;
  calendarEvents: CalendarEvent[];
  holidayEvents: HolidayCalendarEvent[];
  holidays: ReturnType<typeof useHolidays>;
  modeDays: ReadonlyMap<string, ModeRow>;
  cheatDaySet: ReadonlySet<string>;
  /** Holidays by day and the days inside a stretch such as Ramadan, for the agenda. */
  holidayDays: ReadonlyMap<string, readonly CalendarHoliday[]>;
  stretchDays: ReadonlyMap<string, StretchDay>;
}

/**
 * Everything a calendar-like screen shows for a period: the occurrences laid out against cheat days, modes and
 * holidays. Shared by the Calendar and Today screens so both answer "what rings" from the same place.
 */
export function useCalendarData(view: CalendarView, anchor: string, settings: Settings): CalendarData {
  const tz = settings.timezone;
  const events = useEventsStore((state) => state.events);
  const cheatDays = usePassesStore((state) => state.cheatDays);
  const modeTimeline = useModeTimeline();
  const showHidden = useShowHiddenStore((state) => state.showHidden);
  const setShowHidden = useShowHiddenStore((state) => state.setShowHidden);

  const cheatDaySet = useMemo(() => new Set(cheatDays), [cheatDays]);
  const range = useMemo(
    () => visibleDayRange(view, anchor, settings.week_starts_on),
    [view, anchor, settings.week_starts_on]
  );
  const { allOccurrences, skipped } = useMemo(() => {
    const failed: string[] = [];
    const expanded = expandOccurrences(
      events,
      rangeToInstants(range, tz),
      settings,
      cheatDays,
      (event) => failed.push(event.kind ?? 'normal'),
      modeTimeline
    );
    return { allOccurrences: expanded, skipped: skippedNotice(failed) };
  }, [events, range, tz, cheatDays, settings, modeTimeline]);
  // Hidden alarms still ring; the calendar only leaves them out unless this device asked to see them.
  const occurrences = useMemo(() => visibleOccurrences(allOccurrences, showHidden), [allOccurrences, showHidden]);
  const hiddenInRange = showHidden ? 0 : hiddenAlarmCount(allOccurrences);
  const offerShowHidden = useMemo(() => hasHiddenAlarms(events, settings), [events, settings]);
  const calendarEvents = useMemo(() => occurrences.map(toCalendarEvent), [occurrences]);
  // Holidays are display only: they never reach the alarm schedule, the habits or the pass logic.
  const holidays = useHolidays(range.start, range.end);
  const holidayEvents = useMemo(() => toHolidayCalendarEvents(holidays.holidays), [holidays.holidays]);
  // The days a mode covers most of, marked quietly in the grid and the agenda.
  const modeDays = useMemo(() => modesByDay(modeTimeline, range.start, range.end, tz), [modeTimeline, range, tz]);

  return {
    range,
    allOccurrences,
    occurrences,
    skipped,
    hiddenInRange,
    offerShowHidden,
    showHidden,
    setShowHidden,
    calendarEvents,
    holidayEvents,
    holidays,
    modeDays,
    cheatDaySet,
    holidayDays: holidays.byDay,
    stretchDays: holidays.stretches,
  };
}

/** One line for alarms the calendar had to leave out, or null when it showed everything. */
function skippedNotice(failedKinds: readonly string[]): string | null {
  if (failedKinds.length === 0) return null;
  if (failedKinds.some((kind) => kind !== 'normal')) {
    return "Prayer times couldn't be calculated, so the prayer alarms are not shown. Check your location in Settings.";
  }
  return "Some alarms couldn't be shown because their settings are not valid.";
}
