import {
  DEFAULT_DURATION_MIN,
  DEFAULT_MAX_SNOOZES,
  DEFAULT_SNOOZE_MINUTES,
  EVENT_COLORS,
  REPEAT_PRESETS,
  addDays,
  eventFormToWriteInput,
  isRealDate,
  repeatFormFromRule,
  weekdayOfDate,
  zonedDate,
  zonedParts,
  instantFromZoned,
  firstAlarmDate,
  type CustomRepeatUnit,
  type EventFormValues,
  type EventRow,
  type EventWriteInput,
  type RepeatPreset,
} from '@alarm-calendar/core';
import { z } from 'zod';

import { CliError } from '../errors';

// The friendly description of one alarm, used by `events add|update` flags and by plan items. It says what a
// person would say ("07:30 on Monday, Wednesday and Friday, 60 minutes"); resolveEventSpec turns it into the
// same EventFormValues the app's form edits and then into the same columns the app would have written.

export const AGENT_KEY_PATTERN = /^[a-z0-9][a-z0-9/_.-]{0,99}$/;

export const WEEKDAY_TOKENS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const WEEKDAY_FULL = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

export const COLOR_NAMES = EVENT_COLORS.map((color) => color.label.toLowerCase());

/** Repeat presets an agent may name; `custom` is expressed as `{ every, unit }` instead. */
export const NAMED_REPEATS = REPEAT_PRESETS.filter((preset) => preset !== 'custom');

const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a 24-hour time like "07:30"')
  .describe('Wall-clock time in the user timezone, 24-hour HH:mm.');

export const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date like "2026-11-09"')
  .refine(isRealDate, 'is not a real calendar date');

const durationField = z
  .union([z.number().int().min(1).max(1440), z.string().regex(/^(\d+h)?(\d+m)?$/, 'must be minutes or text like "45m", "1h", "1h30m"')])
  .describe('Calendar block length: whole minutes (1 to 1440) or text like "45m", "1h30m". Default 15.');

const repeatField = z
  .union([
    z.enum(NAMED_REPEATS as [RepeatPreset, ...RepeatPreset[]]),
    z.strictObject({
      every: z.number().int().min(1).max(999),
      unit: z.enum(['hour', 'day', 'week', 'month', 'year']),
    }),
  ])
  .describe('A named preset, or { every: N, unit }. Omit for a one-time alarm. With `days`, only "weekly" or { every, unit: "week" } fit.');

const daysField = z
  .union([
    z.array(z.enum(WEEKDAY_TOKENS)).min(1),
    z.enum(['weekdays', 'weekends']),
  ])
  .describe('Weekdays it rings on: ["mon","wed","fri"], or "weekdays" / "weekends". Implies a weekly repeat.');

const colorField = z
  .union([z.enum(COLOR_NAMES as [string, ...string[]]), z.enum(EVENT_COLORS.map((color) => color.value) as [string, ...string[]])])
  .describe('One of the palette colours by name (red, orange, yellow, green, blue, violet, pink) or its hex value.');

export const eventSpecShape = {
  title: z.string().trim().min(1).max(120).describe('Alarm title, 1 to 120 characters.'),
  notes: z.string().max(2000).nullable().optional().describe('Free text shown on the alarm, up to 2000 characters.'),
  time: timeOfDay,
  duration: durationField.optional(),
  start: dateString
    .optional()
    .describe('First date, or the date of a one-time alarm, in the user timezone. Defaults to today (the next occurrence for a one-time alarm); an existing alarm keeps its start.'),
  ends: dateString.nullable().optional().describe('Last date the series rings on (inclusive). Repeating alarms only.'),
  repeat: repeatField.optional(),
  days: daysField.optional(),
  maxSnoozes: z.number().int().min(0).max(10).optional().describe('Snoozes allowed, 0 to 10; 0 hides the snooze button. Default 3.'),
  snoozeMinutes: z.number().int().min(1).max(120).optional().describe('Minutes a snooze lasts, 1 to 120. Default 5.'),
  passable: z
    .boolean()
    .optional()
    .describe('Whether a cheat-day pass or a mode may silence it. Default true. Use false for medication or anything that must always ring.'),
  color: colorField.nullable().optional(),
  showInCalendar: z.boolean().optional().describe('False keeps it off the calendar; it still rings and counts in habits. Default true.'),
};

export const eventSpecSchema = z.strictObject(eventSpecShape);
export type EventSpec = z.infer<typeof eventSpecSchema>;

/** Minutes from `45`, `"45"`, `"1h"`, `"1h30m"`, `"90m"`. */
export function parseDuration(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;
  const match = /^(?:(\d+)h)?(?:(\d+)m?)?$/.exec(value.trim());
  if (match === null || (match[1] === undefined && match[2] === undefined)) {
    throw new CliError('invalid_input', `Duration "${value}" is not minutes or text like "1h30m".`);
  }
  const minutes = Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
  if (minutes < 1 || minutes > 1440) throw new CliError('invalid_input', `Duration must be 1 to 1440 minutes, got ${minutes}.`);
  return minutes;
}

export function parseWeekday(token: string): number {
  const lowered = token.trim().toLowerCase();
  const short = (WEEKDAY_TOKENS as readonly string[]).indexOf(lowered.slice(0, 3));
  if (short !== -1 && (lowered.length === 3 || lowered === WEEKDAY_FULL[short])) return short;
  throw new CliError('invalid_input', `"${token}" is not a weekday; use mon, tue, wed, thu, fri, sat, sun.`);
}

/** Weekday numbers (Monday = 0) from a list of names or the shorthands "weekdays" / "weekends". */
export function parseDays(days: readonly string[] | 'weekdays' | 'weekends' | string): number[] {
  const list = typeof days === 'string' ? days.split(',').map((item) => item.trim()).filter((item) => item !== '') : [...days];
  const numbers = list.flatMap((item) => {
    const lowered = item.toLowerCase();
    if (lowered === 'weekdays') return [0, 1, 2, 3, 4];
    if (lowered === 'weekends') return [5, 6];
    if (lowered === 'daily' || lowered === 'everyday') return [0, 1, 2, 3, 4, 5, 6];
    return [parseWeekday(item)];
  });
  return [...new Set(numbers)].sort((a, b) => a - b);
}

export function weekdayNames(weekdays: readonly number[]): string[] {
  return weekdays.map((weekday) => WEEKDAY_TOKENS[weekday] ?? '?');
}

export function colorFromName(color: string | null | undefined): string | null {
  if (color === null || color === undefined || color === 'none') return null;
  const lowered = color.toLowerCase();
  const byName = EVENT_COLORS.find((candidate) => candidate.label.toLowerCase() === lowered);
  if (byName !== undefined) return byName.value;
  if (EVENT_COLORS.some((candidate) => candidate.value === lowered)) return lowered;
  throw new CliError('invalid_input', `"${color}" is not a palette colour; use ${COLOR_NAMES.join(', ')} or none.`);
}

export function colorName(hex: string | null): string | null {
  if (hex === null) return null;
  return EVENT_COLORS.find((candidate) => candidate.value === hex)?.label.toLowerCase() ?? hex;
}

export interface ResolveContext {
  tz: string;
  now: Date;
  /** The alarm this spec is for, when it already exists: keeps its start date unless the spec names one. */
  existing?: EventRow | undefined;
}

export interface ResolvedEvent {
  input: EventWriteInput;
  values: EventFormValues;
  warnings: string[];
}

interface RepeatChoice {
  preset: RepeatPreset;
  interval: number;
  unit: CustomRepeatUnit;
  weekdays: number[] | null;
}

function chooseRepeat(spec: Pick<EventSpec, 'repeat' | 'days'>): RepeatChoice {
  const days = spec.days === undefined ? null : parseDays(spec.days);
  const repeat = spec.repeat;
  if (days !== null) {
    if (repeat === undefined || repeat === 'weekly') return { preset: 'weekly', interval: 1, unit: 'week', weekdays: days };
    if (typeof repeat === 'object' && repeat.unit === 'week') {
      return { preset: 'custom', interval: repeat.every, unit: 'week', weekdays: days };
    }
    throw new CliError('invalid_input', '`days` only works with a weekly repeat: omit `repeat`, or use "weekly" or { every: N, unit: "week" }.');
  }
  if (repeat === undefined) return { preset: 'none', interval: 1, unit: 'day', weekdays: null };
  if (typeof repeat === 'string') return { preset: repeat, interval: 1, unit: 'day', weekdays: null };
  return { preset: 'custom', interval: repeat.every, unit: repeat.unit, weekdays: null };
}

/**
 * Turns a friendly spec into the columns the app would have written for the same form. The spec is the whole
 * desired state: a field it leaves out gets the app's default. The start date is the one exception, because
 * "today" would move on every run: an existing alarm keeps the date it started on, so applying the same plan
 * twice changes nothing.
 */
export function resolveEventSpec(spec: EventSpec, context: ResolveContext): ResolvedEvent {
  const { tz, now, existing } = context;
  const warnings: string[] = [];
  const choice = chooseRepeat(spec);
  const repeating = choice.preset !== 'none';
  const today = zonedDate(now, tz);

  let startDate: string;
  if (spec.start !== undefined) startDate = spec.start;
  else if (existing !== undefined) startDate = zonedParts(new Date(existing.start_at), tz).date;
  else if (repeating) startDate = today;
  else startDate = instantFromZoned(today, spec.time, tz).getTime() > now.getTime() ? today : addDays(today, 1);

  const weekdays = choice.weekdays ?? [weekdayOfDate(startDate)];
  const values: EventFormValues = {
    title: spec.title.trim(),
    notes: spec.notes ?? '',
    startDate,
    startTime: spec.time,
    durationMin: parseDuration(spec.duration) ?? DEFAULT_DURATION_MIN,
    repeatPreset: choice.preset,
    customInterval: choice.interval,
    customUnit: choice.unit,
    weekdays,
    endsDate: repeating ? (spec.ends ?? '') : '',
    maxSnoozes: spec.maxSnoozes ?? DEFAULT_MAX_SNOOZES,
    snoozeMinutes: spec.snoozeMinutes ?? DEFAULT_SNOOZE_MINUTES,
    passable: spec.passable ?? true,
    color: colorFromName(spec.color),
    showInCalendar: spec.showInCalendar ?? true,
  };

  if (!repeating && spec.ends !== undefined && spec.ends !== null) {
    warnings.push('`ends` is ignored for a one-time alarm.');
  }
  const firstDate = firstAlarmDate(values);
  if (repeating && values.endsDate !== '' && values.endsDate < firstDate) {
    throw new CliError('invalid_input', `\`ends\` (${values.endsDate}) is before the first alarm (${firstDate}).`);
  }
  const input = eventFormToWriteInput(values, tz);
  if (!repeating && existing === undefined && Date.parse(input.start_at) <= now.getTime()) {
    throw new CliError('invalid_input', `A one-time alarm at ${startDate} ${spec.time} (${tz}) is already in the past, so it would never ring.`);
  }
  return { input, values, warnings };
}

export interface FriendlyEvent {
  title: string;
  notes: string | null;
  start: string;
  time: string;
  duration: number;
  /** Plan vocabulary: a preset name ("none", "daily", "weekly", ...) or { every, unit }. */
  repeat: string | { every: number; unit: string };
  days: string[] | null;
  ends: string | null;
  maxSnoozes: number;
  snoozeMinutes: number;
  passable: boolean;
  color: string | null;
  showInCalendar: boolean;
}

/** The friendly view of a row, field for field the spec language; used to show what an update changes. */
export function describeEventRow(row: Pick<EventRow, 'title' | 'notes' | 'start_at' | 'duration_min' | 'repeat_unit' | 'repeat_interval' | 'repeat_weekdays' | 'ends_at' | 'max_snoozes' | 'snooze_minutes' | 'passable' | 'color' | 'show_in_calendar'>, tz: string): FriendlyEvent {
  const start = zonedParts(new Date(row.start_at), tz);
  const form = repeatFormFromRule({ unit: row.repeat_unit, interval: row.repeat_interval });
  const repeat: FriendlyEvent['repeat'] =
    form.repeatPreset === 'custom' ? { every: row.repeat_interval, unit: row.repeat_unit } : form.repeatPreset;
  return {
    title: row.title,
    notes: row.notes,
    start: start.date,
    time: start.time,
    duration: row.duration_min,
    repeat,
    days: row.repeat_unit === 'week' ? weekdayNames(row.repeat_weekdays ?? [weekdayOfDate(start.date)]) : null,
    ends: row.ends_at === null ? null : zonedParts(new Date(row.ends_at), tz).date,
    maxSnoozes: row.max_snoozes,
    snoozeMinutes: row.snooze_minutes,
    passable: row.passable,
    color: colorName(row.color),
    showInCalendar: row.show_in_calendar ?? true,
  };
}

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Field-level differences in friendly terms, in a stable order. */
export function diffFriendly(from: FriendlyEvent, to: FriendlyEvent): FieldChange[] {
  const order: Array<keyof FriendlyEvent> = [
    'title', 'notes', 'start', 'time', 'duration', 'repeat', 'days', 'ends', 'maxSnoozes', 'snoozeMinutes', 'passable', 'color', 'showInCalendar',
  ];
  return order.filter((field) => !same(from[field], to[field])).map((field) => ({ field, from: from[field], to: to[field] }));
}

const COLUMN_FIELDS = [
  'title', 'notes', 'duration_min', 'repeat_unit', 'repeat_interval', 'ends_at', 'max_snoozes', 'snooze_minutes', 'passable', 'color', 'show_in_calendar',
] as const;

/** The columns of `desired` that differ from `existing`, normalised so equal instants and equal weekday sets match. */
export function changedColumns(existing: EventRow, desired: EventWriteInput, tz: string): Partial<EventWriteInput> {
  const patch: Record<string, unknown> = {};
  const instantDiffers = (a: string | null, b: string | null | undefined): boolean =>
    (a === null ? null : Date.parse(a)) !== (b === null || b === undefined ? null : Date.parse(b));
  if (instantDiffers(existing.start_at, desired.start_at)) patch['start_at'] = desired.start_at;
  for (const column of COLUMN_FIELDS) {
    const before = column === 'show_in_calendar' ? (existing.show_in_calendar ?? true) : existing[column];
    const after = desired[column];
    if (column === 'ends_at') {
      if (instantDiffers(existing.ends_at, desired.ends_at)) patch[column] = after;
    } else if (after !== undefined && !same(before, after)) {
      patch[column] = after;
    }
  }
  const existingDays = existing.repeat_unit === 'week' ? (existing.repeat_weekdays ?? [weekdayOfDate(zonedParts(new Date(existing.start_at), tz).date)]) : null;
  const desiredDays = desired.repeat_unit === 'week' ? (desired.repeat_weekdays ?? null) : null;
  if (!same(existingDays === null ? null : [...existingDays].sort((a, b) => a - b), desiredDays === null ? null : [...desiredDays].sort((a, b) => a - b))) {
    patch['repeat_weekdays'] = desired.repeat_weekdays ?? null;
  }
  return patch as Partial<EventWriteInput>;
}
