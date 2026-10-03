/**
 * Contract between the alarm window (renderer) and the main process. Shared by
 * main, preload and the renderer so the three cannot drift apart.
 */

export const ALARM_CHANNELS = {
  get: 'alarm:get',
  done: 'alarm:done',
  snooze: 'alarm:snooze',
} as const;

/** Everything the alarm screen needs to draw one ringing occurrence. */
export interface AlarmView {
  occurrenceId: string;
  title: string;
  notes: string | null;
  /** ISO 8601 scheduled time of the occurrence. */
  occurrenceAt: string;
  /** Snooze button text, or null when the button must not be shown. */
  snoozeLabel: string | null;
  /** Shown instead of the button when the snooze limit is used up. */
  snoozeNotice: string | null;
}

export interface ActionResult {
  ok: boolean;
}

/** The only surface the preload exposes to the alarm page. */
export interface AlarmApi {
  getAlarm(occurrenceId: string): Promise<AlarmView | null>;
  done(occurrenceId: string): Promise<ActionResult>;
  snooze(occurrenceId: string): Promise<ActionResult>;
}

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
