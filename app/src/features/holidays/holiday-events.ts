import type { CalendarHoliday, HolidayKind } from '@alarm-calendar/core';

import { addDays } from '@/lib/zoned-time';

const CHIP_CLASS: Record<HolidayKind, string> = {
  public: 'holiday-public',
  religious: 'holiday-religious',
};

/** The Agenda's note classes, same tokens as the chips. */
export const NOTE_CLASS: Record<HolidayKind, string> = {
  public: 'holiday-note-public',
  religious: 'holiday-note-religious',
};

/** An all-day event for FullCalendar. It carries `holiday: true` so a click on it opens nothing. */
export interface HolidayCalendarEvent {
  id: string;
  title: string;
  /** 'yyyy-MM-dd' */
  start: string;
  /** Exclusive, as FullCalendar wants all-day ends. */
  end: string;
  allDay: true;
  className: string;
  editable: false;
  extendedProps: {
    holiday: true;
    kind: HolidayKind;
    publicHoliday: boolean;
  };
}

/**
 * One chip per holiday. A multi-day holiday is one bar across its days; a stretch such as Ramadan is a chip on its
 * first day only (its other days are tinted by the grid), so it does not take a row of every week.
 */
export function toHolidayCalendarEvents(holidays: readonly CalendarHoliday[]): HolidayCalendarEvent[] {
  return holidays.map((holiday) => ({
    id: holiday.id,
    title: holiday.name,
    start: holiday.day,
    end: addDays(holiday.rangeName === null ? holiday.endDay : holiday.day, 1),
    allDay: true,
    className: CHIP_CLASS[holiday.kind],
    editable: false,
    extendedProps: { holiday: true, kind: holiday.kind, publicHoliday: holiday.publicHoliday },
  }));
}
