import { assertValidTimeZone, buildSchedulePayload, MAX_LOOKBACK_MINUTES, MAX_SHIFT_MS } from '@alarm-calendar/core';
import type {
  DesktopSession,
  ModeConfig,
  LegacySchedulePayload,
  ScheduleDropped,
  ScheduleEventInfo,
  ScheduleOccurrence,
  SchedulePayload,
} from '@alarm-calendar/core';
import { z } from 'zod';

import { parseOccurrenceId } from './alarm-ipc';

/**
 * Validation of everything the main window sends over IPC. The renderer is not
 * trusted: a compromised page must not be able to feed the scheduler malformed
 * data, exhaust memory, or point the session token at another server. Bounds
 * are generous (a real calendar is far below them) but finite.
 */

export const MAX_EVENTS = 5000;
export const MAX_CHEAT_DAYS = 5000;
export const MAX_COMPLETIONS = 5000;
// Same as core's MAX_SCHEDULE_OCCURRENCES: a list core built never exceeds it.
export const MAX_OCCURRENCES = 5000;
// Modes (roadmap v2, phase 5): a person has a handful of modes, a rule per (mode, alarm), and a few
// dozen switches and planned ranges. Bounds are generous but finite, like the rest.
export const MAX_MODES = 200;
export const MAX_MODE_RULES = 5000;
export const MAX_MODE_ACTIVATIONS = 5000;
export const MAX_MODE_EXAMS = 1000;

const uuid = z.string().regex(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
// Supabase returns '+00:00' offsets, the scheduler writes 'Z'; both are fine.
const timestamp = z.iso.datetime({ offset: true });
const smallInt = (min: number, max: number) => z.number().int().min(min).max(max);

const prayerName = z.enum(['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']);

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
  // Absent in a push from before prayer times: a normal alarm. These must be listed: the schema
  // strips unknown keys, and a prayer row that lost its kind would be scheduled from its start_at.
  kind: z.enum(['normal', 'prayer', 'pre_prayer']).optional(),
  prayer: prayerName.nullable().optional(),
}).refine((value) => (value.kind ?? 'normal') === 'normal' || (value.prayer ?? null) !== null, {
  message: 'a prayer event needs a prayer',
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
  // Core states a larger setting as the look-back, so a payload never needs more.
  grace_minutes: smallInt(0, MAX_LOOKBACK_MINUTES),
  sound: z
    .string()
    .regex(/^[a-z0-9-]{1,32}$/)
    .optional(),
  // Prayer times (all optional: a push from before the feature has none). The bounds are the
  // database's, so a value outside them is a corrupt push, not a user's choice.
  prayerSound: z
    .string()
    .regex(/^[a-z0-9-]{1,32}$/)
    .optional(),
  prayers_enabled: z.boolean().optional(),
  prayers_enabled_since: timestamp.nullable().optional(),
  latitude: z.number().min(-65).max(65).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  location_label: z.string().max(100).optional(),
  fajr_angle: z.number().min(10).max(22).optional(),
  isha_angle: z.number().min(10).max(22).optional(),
  asr_factor: z.union([z.literal(1), z.literal(2)]).optional(),
  fajr_offset_min: smallInt(-60, 60).optional(),
  dhuhr_offset_min: smallInt(-60, 60).optional(),
  asr_offset_min: smallInt(-60, 60).optional(),
  maghrib_offset_min: smallInt(-60, 60).optional(),
  isha_offset_min: smallInt(-60, 60).optional(),
  pre_prayer_minutes: smallInt(0, 120).optional(),
  prayer_max_snoozes: smallInt(0, 10).optional(),
  prayer_snooze_minutes: smallInt(1, 120).optional(),
  // Exam mode's automatic window (absent in a push from before modes).
  exam_mode_days_before: smallInt(0, 60).optional(),
});

const modeSchema = z.object({
  id: uuid,
  user_id: uuid,
  name: z.string().max(400),
  kind: z.enum(['builtin', 'custom']),
  builtin_key: z.enum(['exam', 'ramadan', 'vacation', 'sick']).nullable(),
  default_behavior: z.enum(['keep', 'skip']),
  active: z.boolean(),
});

// The same shape the database enforces: the value belongs to exactly its behavior, a shift is at most 12 hours.
const modeRuleSchema = z
  .object({
    id: uuid,
    user_id: uuid,
    mode_id: uuid,
    event_id: uuid,
    behavior: z.enum(['keep', 'skip', 'shift', 'shorten']),
    shift_minutes: smallInt(-720, 720).nullable(),
    duration_min: smallInt(1, 1440).nullable(),
  })
  .refine((rule) => (rule.behavior === 'shift') === (rule.shift_minutes !== null), { message: 'shift_minutes only for a shift' })
  .refine((rule) => (rule.behavior === 'shorten') === (rule.duration_min !== null), { message: 'duration_min only for a shorten' });

const modeActivationSchema = z
  .object({
    id: uuid,
    user_id: uuid,
    mode_id: uuid,
    starts_at: timestamp,
    ends_at: timestamp.nullable(),
    source: z.enum(['manual', 'range']),
  })
  .refine((activation) => activation.ends_at === null || Date.parse(activation.ends_at) > Date.parse(activation.starts_at), {
    message: 'ends before it starts',
  });

const modeExamSchema = z.object({ id: z.string().max(100), exam_at: timestamp, active: z.boolean() });

const completionSchema = z.object({
  id: uuid,
  user_id: uuid,
  event_id: uuid,
  occurrence_at: timestamp,
  status: z.enum(['done', 'skipped_cheat']),
  snoozes_used: smallInt(0, 1000),
  done_at: timestamp,
});

// Rows are validated one at a time (see parseSchedulePayload); the envelopes only fix the shape.
const legacyPayloadEnvelope = z.object({
  events: z.array(z.unknown()).max(MAX_EVENTS),
  cheatDays: z.array(z.unknown()).max(MAX_CHEAT_DAYS),
  settings: settingsSchema,
  completions: z.array(z.unknown()).max(MAX_COMPLETIONS),
});

const payloadEnvelope = z.object({
  version: z.literal(2),
  generatedAt: timestamp,
  horizonEnd: timestamp,
  truncated: z.boolean(),
  settings: settingsSchema,
  occurrences: z.array(z.unknown()).max(MAX_OCCURRENCES),
  eventInfo: z.record(z.string(), z.unknown()),
  refillSource: z.object({
    events: z.array(z.unknown()).max(MAX_EVENTS),
    cheatDays: z.array(z.unknown()).max(MAX_CHEAT_DAYS),
    // Absent in a push from before modes. Rows are validated one at a time, like events.
    modes: z
      .object({
        modes: z.array(z.unknown()).max(MAX_MODES),
        rules: z.array(z.unknown()).max(MAX_MODE_RULES),
        activations: z.array(z.unknown()).max(MAX_MODE_ACTIVATIONS),
        exams: z.array(z.unknown()).max(MAX_MODE_EXAMS),
      })
      .optional(),
  }),
});

const eventInfoSchema = z.object({
  title: z
    .string()
    .max(2000)
    .refine((value) => value.trim().length > 0, { message: 'blank title' }),
  notes: z.string().max(20_000).nullable(),
  maxSnoozes: smallInt(0, 10),
  snoozeMinutes: smallInt(1, 100_000),
  soundId: z
    .string()
    .regex(/^[a-z0-9-]{1,32}$/)
    .nullable(),
  kind: z.enum(['normal', 'prayer', 'pre_prayer']).optional(),
  prayer: prayerName.optional(),
});

const occurrenceSchema = z
  .object({
    id: z.string().max(100),
    eventId: uuid,
    at: timestamp,
    silenced: z.boolean(),
    completed: z.boolean(),
    // Only for an occurrence a mode shifted: when it would have rung without the shift.
    originalAt: timestamp.optional(),
    label: z.string().min(1).max(200).optional(),
    labelIfUnlogged: z
      .object({
        id: z.string().max(100).refine((value) => parseOccurrenceId(value) !== null, { message: 'not an occurrence id' }),
        label: z.string().min(1).max(200),
      })
      .optional(),
  })
  .refine(
    // The id and the instant are what the alarm screen and the completion upsert are keyed by; a
    // list whose id disagrees with its own fields could ring one thing and complete another.
    (value) => {
      const parsed = parseOccurrenceId(value.id);
      return parsed !== null && parsed.eventId === value.eventId && parsed.occurrenceAt === value.at;
    },
    { message: 'id does not match eventId and at' }
  )
  .refine(
    // A shift is at most 12 hours and never zero, so an original instant outside that is not one a mode produced.
    (value) => {
      if (value.originalAt === undefined) return true;
      const gap = Math.abs(Date.parse(value.originalAt) - Date.parse(value.at));
      return gap > 0 && gap <= MAX_SHIFT_MS;
    },
    { message: 'originalAt is not within a shift of at' }
  );

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
  | { ok: true; version: 1; value: LegacySchedulePayload; dropped: ScheduleDropped }
  | { ok: true; version: 2; value: SchedulePayload; dropped: ScheduleDropped }
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
 * One malformed row must not freeze the whole schedule: invalid occurrences, events, cheat days and
 * completions are dropped one at a time and counted, so the rest still reaches the scheduler.
 * Only a bad envelope (not an object, arrays too large) or invalid settings rejects the payload,
 * since without a time zone nothing can be scheduled at all.
 *
 * A payload with `version: 2` is the precomputed schedule. One without a version is the older
 * events-based push from a renderer that predates it; it is accepted as version 1 and the caller
 * expands it (see upgradeLegacyPayload).
 */
export function parseSchedulePayload(payload: unknown): ScheduleParseResult {
  const isVersioned =
    typeof payload === 'object' && payload !== null && 'version' in payload;
  return isVersioned ? parseVersion2(payload) : parseVersion1(payload);
}

function parseVersion1(payload: unknown): ScheduleParseResult {
  const envelope = parseWith(legacyPayloadEnvelope, payload);
  if (!envelope.ok) return envelope;
  const events = keepValid(envelope.value.events, eventSchema);
  const cheatDays = keepValid(envelope.value.cheatDays, cheatDaySchema);
  const completions = keepValid(envelope.value.completions, completionSchema);
  return {
    ok: true,
    version: 1,
    value: {
      events: events.kept,
      cheatDays: cheatDays.kept,
      settings: envelope.value.settings,
      completions: completions.kept,
    },
    dropped: {
      occurrences: 0,
      events: events.dropped,
      cheatDays: cheatDays.dropped,
      completions: completions.dropped,
    },
  };
}

function parseVersion2(payload: unknown): ScheduleParseResult {
  const envelope = parseWith(payloadEnvelope, payload);
  if (!envelope.ok) return envelope;
  const { value } = envelope;
  if (Object.keys(value.eventInfo).length > MAX_EVENTS) {
    return { ok: false, reason: 'eventInfo: too many entries' };
  }
  const events = keepValid(value.refillSource.events, eventSchema);
  const cheatDays = keepValid(value.refillSource.cheatDays, cheatDaySchema);
  const parsedModes = parseModes(value.refillSource.modes);

  // The list, its per-event info and the events it can be refilled from must agree: an entry for
  // an event that is not among the kept events (dropped as invalid, or never sent) is dropped too.
  const keptEventIds = new Set(events.kept.map((event) => event.id));
  const eventInfo: Record<string, ScheduleEventInfo> = {};
  let droppedInfo = 0;
  for (const [eventId, info] of Object.entries(value.eventInfo)) {
    const parsedInfo = eventInfoSchema.safeParse(info);
    if (keptEventIds.has(eventId) && parsedInfo.success) eventInfo[eventId] = parsedInfo.data;
    else droppedInfo++;
  }
  const occurrences = keepValid<ScheduleOccurrence>(value.occurrences, occurrenceSchema);
  const listed = occurrences.kept.filter((occurrence) => Object.hasOwn(eventInfo, occurrence.eventId));
  const droppedOccurrences = value.occurrences.length - listed.length;

  return {
    ok: true,
    version: 2,
    value: {
      version: 2,
      generatedAt: value.generatedAt,
      horizonEnd: value.horizonEnd,
      truncated: value.truncated,
      settings: value.settings,
      occurrences: listed,
      eventInfo,
      refillSource: {
        events: events.kept,
        cheatDays: cheatDays.kept,
        ...(parsedModes === null ? {} : { modes: parsedModes.config }),
      },
    },
    dropped: {
      // Occurrences of a dropped event and info entries without a valid event count here too.
      occurrences: droppedOccurrences + droppedInfo,
      events: events.dropped,
      cheatDays: cheatDays.dropped,
      completions: 0,
      ...(parsedModes === null || parsedModes.dropped === 0 ? {} : { modeRows: parsedModes.dropped }),
    },
  };
}

/**
 * The modes of a push. A mode is used whole or not at all: if any of its rules or activations is invalid, the
 * mode and everything attached to it is dropped (a rule or an activation that is missing would change what the
 * mode does, and the safe direction is ringing). A rule or activation too broken to say which mode it belongs
 * to drops every mode. An invalid mode row is dropped on its own (its rules and activations then do nothing),
 * and so is an invalid exam (its Exam-mode window is simply not there). Dropped rows are counted, the ones
 * discarded with their mode included. Null when the push carried no modes.
 */
function parseModes(raw: { modes: unknown[]; rules: unknown[]; activations: unknown[]; exams: unknown[] } | undefined): {
  config: ModeConfig;
  dropped: number;
} | null {
  if (raw === undefined) return null;
  const total = raw.modes.length + raw.rules.length + raw.activations.length + raw.exams.length;
  const modes = keepValid(raw.modes, modeSchema);
  const exams = keepValid(raw.exams, modeExamSchema);
  const rules = keepValidAttributed(raw.rules, modeRuleSchema);
  const activations = keepValidAttributed(raw.activations, modeActivationSchema);

  if (rules.unattributable > 0 || activations.unattributable > 0) {
    return { config: { modes: [], rules: [], activations: [], exams: [] }, dropped: total };
  }
  const poisoned = new Set([...rules.failedModeIds, ...activations.failedModeIds]);
  const config: ModeConfig = {
    modes: modes.kept.filter((mode) => !poisoned.has(mode.id)),
    rules: rules.kept.filter((rule) => !poisoned.has(rule.mode_id)),
    activations: activations.kept.filter((activation) => !poisoned.has(activation.mode_id)),
    exams: exams.kept,
  };
  const keptRows = config.modes.length + config.rules.length + config.activations.length + config.exams.length;
  return { config, dropped: total - keptRows };
}

/** Like keepValid, but remembers the mode id of a row that failed, or counts it when even that is unreadable. */
function keepValidAttributed<T>(
  items: readonly unknown[],
  schema: z.ZodType<T>
): { kept: T[]; failedModeIds: Set<string>; unattributable: number } {
  const kept: T[] = [];
  const failedModeIds = new Set<string>();
  let unattributable = 0;
  for (const item of items) {
    const parsed = schema.safeParse(item);
    if (parsed.success) {
      kept.push(parsed.data);
      continue;
    }
    const modeId = typeof item === 'object' && item !== null ? (item as Record<string, unknown>).mode_id : undefined;
    if (typeof modeId === 'string') failedModeIds.add(modeId);
    else unattributable += 1;
  }
  return { kept, failedModeIds, unattributable };
}

/**
 * Turns an events-based push into the precomputed schedule, with the same core pipeline the
 * renderer now runs itself, so an older renderer keeps working during the transition.
 */
export function upgradeLegacyPayload(
  legacy: LegacySchedulePayload,
  now: Date,
  onEventFailed?: (eventId: string, error: unknown) => void
): SchedulePayload {
  return buildSchedulePayload({ ...legacy, now, onEventFailed });
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

/** The id getter takes no arguments; anything extra is refused. */
export function parseNoArguments(args: readonly unknown[]): ParseResult<[]> {
  return parseWith(z.tuple([]), args);
}

/** Ids only, each exactly `<uuid>@<ISO UTC instant>`, bounded in count: all the id getter may return. */
const occurrenceIdList = z
  .array(z.string().max(100).refine((value) => parseOccurrenceId(value) !== null, { message: 'bad occurrence id' }))
  .max(10_000);

export function parseOccurrenceIdList(ids: unknown): ParseResult<string[]> {
  return parseWith(occurrenceIdList, ids);
}

export function parseBoolean(payload: unknown): ParseResult<boolean> {
  return typeof payload === 'boolean' ? { ok: true, value: payload } : { ok: false, reason: 'not a boolean' };
}
