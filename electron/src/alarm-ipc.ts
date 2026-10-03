/**
 * Contract between the alarm window (renderer) and the main process. The view
 * and API types live in @alarm-calendar/core so the React app shares them.
 */

export const ALARM_CHANNELS = {
  get: 'alarm:get',
  done: 'alarm:done',
  snooze: 'alarm:snooze',
} as const;

/** Channels of the main (React app) window; see desktop-ipc.ts. */
export const DESKTOP_CHANNELS = {
  setSchedule: 'desktop:set-schedule',
  drainCompletions: 'desktop:drain-completions',
  setSession: 'desktop:set-session',
  getAutostart: 'desktop:get-autostart',
  setAutostart: 'desktop:set-autostart',
} as const;

export type { ActionResult, AlarmApi, AlarmView } from '@alarm-calendar/core';

const EVENT_ID_PATTERN = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** An occurrence is identified by its event and its scheduled instant. */
export function makeOccurrenceId(eventId: string, occurrenceAt: Date): string {
  return `${eventId}@${occurrenceAt.toISOString()}`;
}

export interface ParsedOccurrenceId {
  eventId: string;
  occurrenceAt: string;
}

/** Returns null for anything that is not exactly `<uuid>@<ISO UTC instant>`. */
export function parseOccurrenceId(value: unknown): ParsedOccurrenceId | null {
  if (typeof value !== 'string' || value.length > 100) return null;
  const separator = value.indexOf('@');
  if (separator < 0) return null;
  const eventId = value.slice(0, separator);
  const occurrenceAt = value.slice(separator + 1);
  if (!EVENT_ID_PATTERN.test(eventId) || !ISO_UTC_PATTERN.test(occurrenceAt)) return null;
  const parsed = new Date(occurrenceAt);
  // Round-trip rejects impossible dates such as 2026-02-31 that Date would roll over.
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== occurrenceAt) return null;
  return { eventId, occurrenceAt };
}
