import { assertValidTimeZone } from '@alarm-calendar/core';
import type { DesktopSession, ScheduleDropped, SchedulePayload } from '@alarm-calendar/core';
import { z } from 'zod';

/**
 * Validation of everything the main window sends over IPC. The renderer is not
 * trusted: a compromised page must not be able to feed the scheduler malformed
 * data, exhaust memory, or point the session token at another server. Bounds
 * are generous (a real calendar is far below them) but finite.
 */

export const MAX_EVENTS = 5000;
export const MAX_CHEAT_DAYS = 5000;
export const MAX_COMPLETIONS = 5000;

const uuid = z.string().regex(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
// Supabase returns '+00:00' offsets, the scheduler writes 'Z'; both are fine.
const timestamp = z.iso.datetime({ offset: true });
const smallInt = (min: number, max: number) => z.number().int().min(min).max(max);

const eventSchema = z.object({
  id: uuid,
  user_id: uuid,
  // The database requires a non-blank title.
  title: z
    .string()
    .max(2000)
    .refine((value) => value.trim().length > 0, { message: 'blank title' }),
  notes: z.string().max(20_000).nullable(),
  start_at: timestamp,
  duration_min: smallInt(1, 1_000_000),
  repeat_unit: z.enum(['none', 'hour', 'day', 'week', 'month', 'year']),
  repeat_interval: smallInt(1, 100_000),
  // The database requires null or at least one weekday.
  repeat_weekdays: z.array(smallInt(0, 6)).min(1).max(7).nullable(),
  ends_at: timestamp.nullable(),
  max_snoozes: smallInt(0, 10),
  snooze_minutes: smallInt(1, 100_000),
  passable: z.boolean(),
  color: z.string().max(100).nullable(),
  active: z.boolean(),
  updated_at: timestamp,
});

const timeZone = z.string().max(100).refine(
  (value) => {
    try {
      assertValidTimeZone(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'not an IANA time zone' }
);

const settingsSchema = z.object({
  user_id: uuid,
  timezone: timeZone,
  week_starts_on: smallInt(0, 6),
  refire_seconds: smallInt(1, 604_800),
  pass_cap: smallInt(0, 1000),
  grace_minutes: smallInt(0, 525_600),
  sound: z
    .string()
    .regex(/^[a-z0-9-]{1,32}$/)
    .optional(),
});

const completionSchema = z.object({
  id: uuid,
  user_id: uuid,
  event_id: uuid,
  occurrence_at: timestamp,
  status: z.enum(['done', 'skipped_cheat']),
  snoozes_used: smallInt(0, 1000),
  done_at: timestamp,
});

// Rows are validated one at a time (see parseSchedulePayload); the envelope only fixes the shape.
const schedulePayloadEnvelope = z.object({
  events: z.array(z.unknown()).max(MAX_EVENTS),
  cheatDays: z.array(z.unknown()).max(MAX_CHEAT_DAYS),
  settings: settingsSchema,
  completions: z.array(z.unknown()).max(MAX_COMPLETIONS),
});

const cheatDaySchema = z.iso.date();

const sessionSchema = z.object({
  url: z.url().max(300),
  publishableKey: z.string().regex(/^[A-Za-z0-9._-]{1,600}$/),
  userId: uuid,
  // A JWT: three base64url segments. Shape only; Supabase verifies it.
  accessToken: z.string().max(8192).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/),
  expiresAt: z.number().int().positive(),
});

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function parseWith<T>(schema: z.ZodType<T>, payload: unknown): ParseResult<T> {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return { ok: true, value: parsed.data };
  // Paths only, never values: a bad session payload must not leak a token into a log.
  const first = parsed.error.issues[0];
  const where = first === undefined ? 'payload' : first.path.join('.') || 'payload';
  return { ok: false, reason: `${where}: ${first?.message ?? 'invalid'}` };
}

export type ScheduleParseResult =
  | { ok: true; value: SchedulePayload; dropped: ScheduleDropped }
  | { ok: false; reason: string };

function keepValid<T>(items: readonly unknown[], schema: z.ZodType<T>): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  for (const item of items) {
    const parsed = schema.safeParse(item);
    if (parsed.success) kept.push(parsed.data);
  }
  return { kept, dropped: items.length - kept.length };
}

/**
 * One malformed row must not freeze the whole schedule: invalid events, cheat days and
 * completions are dropped one at a time and counted, so the rest still reaches the scheduler.
 * Only a bad envelope (not an object, arrays too large) or invalid settings rejects the payload,
 * since without a time zone nothing can be scheduled at all.
 */
export function parseSchedulePayload(payload: unknown): ScheduleParseResult {
  const envelope = parseWith(schedulePayloadEnvelope, payload);
  if (!envelope.ok) return envelope;
  const events = keepValid(envelope.value.events, eventSchema);
  const cheatDays = keepValid(envelope.value.cheatDays, cheatDaySchema);
  const completions = keepValid(envelope.value.completions, completionSchema);
  return {
    ok: true,
    value: {
      events: events.kept,
      cheatDays: cheatDays.kept,
      settings: envelope.value.settings,
      completions: completions.kept,
    },
    dropped: { events: events.dropped, cheatDays: cheatDays.dropped, completions: completions.dropped },
  };
}

/**
 * A session is only accepted for the Supabase origin this build was made for,
 * so a compromised renderer cannot make main send the token to another host.
 * Null (sign-out) is always accepted.
 */
export function parseSessionPayload(
  payload: unknown,
  allowedOrigin: string | null
): ParseResult<DesktopSession | null> {
  if (payload === null) return { ok: true, value: null };
  const parsed = parseWith(sessionSchema, payload);
  if (!parsed.ok) return parsed;
  if (allowedOrigin === null || new URL(parsed.value.url).origin !== allowedOrigin) {
    return { ok: false, reason: 'url: not the Supabase origin of this build' };
  }
  return parsed;
}

export function parseBoolean(payload: unknown): ParseResult<boolean> {
  return typeof payload === 'boolean' ? { ok: true, value: payload } : { ok: false, reason: 'not a boolean' };
}
