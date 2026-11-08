import { toWallClock, weekdayOfDayNumber, zonedParts } from '@alarm-calendar/core';

export const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** An instant as the agent should read it: the wall clock in the user's zone, with the ISO instant beside it. */
export interface InstantView {
  /** 'yyyy-MM-dd HH:mm' in `timezone`. */
  local: string;
  weekday: string;
  timezone: string;
  /** The same instant, ISO 8601 UTC. */
  iso: string;
}

export function viewInstant(iso: string, tz: string): InstantView {
  const date = new Date(iso);
  const parts = zonedParts(date, tz);
  const weekday = WEEKDAY_SHORT[weekdayOfDayNumber(toWallClock(date, tz).dayNumber)] ?? '';
  return { local: `${parts.date} ${parts.time}`, weekday, timezone: tz, iso: date.toISOString() };
}

/** 'Mon 2026-11-09 07:30' for tables (the zone is stated once above the table). */
export function shortLocal(iso: string, tz: string): string {
  const view = viewInstant(iso, tz);
  return `${view.weekday} ${view.local}`;
}

/** 'Mon 2026-11-09 07:30 Africa/Tunis (2026-11-09T06:30:00.000Z)' for detail views and change summaries. */
export function longLocal(iso: string, tz: string): string {
  const view = viewInstant(iso, tz);
  return `${view.weekday} ${view.local} ${tz} (${view.iso})`;
}
