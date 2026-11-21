import { addDays, dateFromString, startOfZonedDay, weekdayOfDate, zonedParts } from '@/lib/zoned-time';

export type CalendarView = 'day' | 'three-day' | 'week' | 'month' | 'agenda';

export const CALENDAR_VIEWS: readonly CalendarView[] = ['day', 'three-day', 'week', 'month', 'agenda'];

/** The views each layout offers. The phone has no Week (seven columns of 46px) and no Agenda (Today is the agenda). */
export const DESKTOP_VIEWS: readonly CalendarView[] = ['week', 'month', 'agenda'];
export const PHONE_VIEWS: readonly CalendarView[] = ['day', 'three-day', 'month'];

/** The view to show: the address's if this layout offers it, else the layout's default (Week, or Day on the phone). */
export function resolveCalendarView(param: string | null, phoneLayout: boolean): CalendarView {
  const offered = phoneLayout ? PHONE_VIEWS : DESKTOP_VIEWS;
  const parsed = parseCalendarView(param);
  if (parsed !== null && offered.includes(parsed)) return parsed;
  return phoneLayout ? 'day' : 'week';
}

/** How many days the time-grid views show. */
export const THREE_DAYS = 3;

/** How many days the agenda lists at once; previous and next page by the same amount. */
export const AGENDA_DAYS = 14;

/** Visible days as 'yyyy-MM-dd'; end is exclusive. */
export interface DayRange {
  start: string;
  end: string;
}

export function parseCalendarView(value: string | null): CalendarView | null {
  return CALENDAR_VIEWS.find((view) => view === value) ?? null;
}

/** The first day of the week containing day. weekStartsOn: Monday = 0. */
export function startOfWeek(day: string, weekStartsOn: number): string {
  const offset = (weekdayOfDate(day) - weekStartsOn + 7) % 7;
  return addDays(day, -offset);
}

function firstOfMonth(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** The days a view needs occurrences for. Month covers six weeks, the most a grid shows. */
export function visibleDayRange(view: CalendarView, anchor: string, weekStartsOn: number): DayRange {
  if (view === 'day') return { start: anchor, end: addDays(anchor, 1) };
  if (view === 'three-day') return { start: anchor, end: addDays(anchor, THREE_DAYS) };
  if (view === 'week') {
    const start = startOfWeek(anchor, weekStartsOn);
    return { start, end: addDays(start, 7) };
  }
  if (view === 'month') {
    const start = startOfWeek(firstOfMonth(anchor), weekStartsOn);
    return { start, end: addDays(start, 42) };
  }
  return { start: anchor, end: addDays(anchor, AGENDA_DAYS) };
}

export function rangeToInstants(range: DayRange, tz: string): { from: Date; to: Date } {
  return { from: startOfZonedDay(range.start, tz), to: startOfZonedDay(range.end, tz) };
}

/** Moves the anchor one page: a day, three days, a week, a month (landing on its first day) or an agenda window. */
export function shiftAnchor(view: CalendarView, anchor: string, direction: -1 | 1): string {
  if (view === 'day') return addDays(anchor, direction);
  if (view === 'three-day') return addDays(anchor, THREE_DAYS * direction);
  if (view === 'week') return addDays(anchor, 7 * direction);
  if (view === 'agenda') return addDays(anchor, AGENDA_DAYS * direction);

  const [year, month] = anchor.split('-').map(Number) as [number, number];
  const shifted = new Date(Date.UTC(year, month - 1 + direction, 1));
  return shifted.toISOString().slice(0, 10);
}

const monthFormat: Intl.DateTimeFormatOptions = { month: 'long', year: 'numeric' };
const DEFAULT_SCROLL_TIME = '07:00:00';

/**
 * Where a time grid starts scrolled. The desktop (and any other day) starts at 07:00. The phone's grid shows one to
 * three days in a tall column, so on today it opens an hour before now, which is where the next alarm is.
 */
export function initialScrollTime(compact: boolean, anchor: string, now: Date, tz: string): string {
  if (!compact) return DEFAULT_SCROLL_TIME;
  const parts = zonedParts(now, tz);
  if (parts.date !== anchor) return DEFAULT_SCROLL_TIME;
  const hour = Math.max(0, Number(parts.time.slice(0, 2)) - 1);
  return `${String(hour).padStart(2, '0')}:00:00`;
}

const shortDay: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
const dayFormat: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };

/** Heading for the visible period, e.g. 'Oct 5 – 11, 2026' or 'October 2026'. */
export function viewTitle(view: CalendarView, anchor: string, weekStartsOn: number): string {
  if (view === 'day') return dateFromString(anchor).toLocaleDateString(undefined, dayFormat);
  if (view === 'month') return dateFromString(anchor).toLocaleDateString(undefined, monthFormat);

  const range = visibleDayRange(view, anchor, weekStartsOn);
  const first = dateFromString(range.start);
  const last = dateFromString(addDays(range.end, -1));
  const sameMonth = first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear();
  const sameYear = first.getFullYear() === last.getFullYear();

  const left = first.toLocaleDateString(undefined, sameYear ? shortDay : { ...shortDay, year: 'numeric' });
  const right = sameMonth
    ? String(last.getDate())
    : last.toLocaleDateString(undefined, shortDay);
  return `${left} – ${right}, ${last.getFullYear()}`;
}
