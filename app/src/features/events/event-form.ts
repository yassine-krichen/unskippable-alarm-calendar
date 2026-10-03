import type { EventRow } from '@alarm-calendar/core';
import { z } from 'zod';

import { addDays, instantFromZoned, isRealDate, weekdayOfDate, zonedParts } from '@/lib/zoned-time';

import { isEventColor } from './event-colors';
import {
  CUSTOM_REPEAT_UNITS,
  REPEAT_PRESETS,
  isRepeating,
  repeatFormFromRule,
  repeatRuleFromForm,
  usesWeekdays,
  type CustomRepeatUnit,
  type RepeatPreset,
} from './repeat-presets';

export const DEFAULT_DURATION_MIN = 15;
export const DEFAULT_MAX_SNOOZES = 3;
export const DEFAULT_SNOOZE_MINUTES = 5;
export const MAX_SNOOZE_LIMIT = 10;

/** What the form edits. Dates and times are wall-clock values in settings.timezone. */
export interface EventFormValues {
  title: string;
  notes: string;
  /** 'yyyy-MM-dd' */
  startDate: string;
  /** 'HH:mm' */
  startTime: string;
  durationMin: number;
  repeatPreset: RepeatPreset;
  customInterval: number;
  customUnit: CustomRepeatUnit;
  /** Monday = 0. Only used when the repeat rule is weekly. */
  weekdays: number[];
  /** 'yyyy-MM-dd', or '' for no end. */
  endsDate: string;
  maxSnoozes: number;
  snoozeMinutes: number;
  passable: boolean;
  color: string | null;
}

/** The writable columns of an events row; id, user_id, active and updated_at are the database's. */
export type EventWriteInput = Omit<EventRow, 'id' | 'user_id' | 'active' | 'updated_at'>;

export interface EventFormContext {
  tz: string;
  now: () => Date;
  /** A new one-time alarm in the past would silently never ring, so creating one is refused. */
  isNew: boolean;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const timeField = z.string().regex(TIME_PATTERN, 'Enter a time like 08:30.');

const dateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date.')
  .refine(isRealDate, 'Pick a real date.');

/** Mirrors the database checks on events (title not blank, intervals >= 1, ends_at >= start_at, ...). */
export function createEventFormSchema(context: EventFormContext) {
  return z
    .object({
      title: z.string().trim().min(1, 'Give the alarm a title.').max(120, 'Keep the title under 120 characters.'),
      notes: z.string().max(2000, 'Keep notes under 2000 characters.'),
      startDate: dateField,
      startTime: timeField,
      durationMin: z
        .number('Enter a duration in minutes.')
        .int('Use whole minutes.')
        .min(1, 'Duration must be at least 1 minute.')
        .max(1440, 'Duration can be at most 24 hours.'),
      repeatPreset: z.enum(REPEAT_PRESETS),
      customInterval: z
        .number('Enter a number.')
        .int('Use a whole number.')
        .min(1, 'Must be at least 1.')
        .max(999, 'Must be 999 or less.'),
      customUnit: z.enum(CUSTOM_REPEAT_UNITS as [CustomRepeatUnit, ...CustomRepeatUnit[]]),
      weekdays: z.array(z.number().int().min(0).max(6)),
      endsDate: z.union([z.literal(''), dateField]),
      maxSnoozes: z
        .number('Enter a number from 0 to 10.')
        .int('Use a whole number.')
        .min(0, 'Snoozes can not be negative.')
        .max(MAX_SNOOZE_LIMIT, `At most ${MAX_SNOOZE_LIMIT} snoozes.`),
      snoozeMinutes: z
        .number('Enter a snooze length in minutes.')
        .int('Use whole minutes.')
        .min(1, 'Snooze must be at least 1 minute.')
        .max(120, 'Snooze can be at most 120 minutes.'),
      passable: z.boolean(),
      color: z
        .string()
        .nullable()
        .refine((value) => value === null || isEventColor(value), 'Pick one of the listed colors.'),
    })
    .superRefine((values, ctx) => {
      const repeating = isRepeating(values);

      if (usesWeekdays(values) && values.weekdays.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['weekdays'], message: 'Pick at least one weekday.' });
      }

      const firstDate = firstAlarmDate(values);

      if (repeating && values.endsDate !== '' && values.endsDate < firstDate) {
        ctx.addIssue({
          code: 'custom',
          path: ['endsDate'],
          message: 'The end date comes before the first alarm.',
        });
      }

      // The field checks above already reported a malformed time or date; these refinements still run, so skip them.
      const startIsUsable = isRealDate(values.startDate) && TIME_PATTERN.test(values.startTime);

      if (startIsUsable && context.isNew && !repeating) {
        const start = instantFromZoned(firstDate, values.startTime, context.tz);
        if (start.getTime() <= context.now().getTime()) {
          ctx.addIssue({
            code: 'custom',
            path: ['startDate'],
            message: 'That time has already passed, so this alarm would never ring.',
          });
        }
      }
    });
}

export function sortedWeekdays(weekdays: readonly number[]): number[] {
  return [...new Set(weekdays)].sort((a, b) => a - b);
}

/**
 * The first selected weekday on or after startDate. A weekly series whose start day is not
 * one of its weekdays does not fire on start_at itself, so start_at is moved to the first
 * day that does fire and the series starts where the person sees it start.
 */
export function alignStartDate(startDate: string, weekdays: readonly number[]): string {
  if (weekdays.length === 0) return startDate;
  const chosen = new Set(weekdays);
  for (let offset = 0; offset < 7; offset++) {
    const candidate = addDays(startDate, offset);
    if (chosen.has(weekdayOfDate(candidate))) return candidate;
  }
  return startDate;
}

/** The date start_at will actually be saved with. */
export function firstAlarmDate(values: EventFormValues): string {
  if (!isRealDate(values.startDate) || !usesWeekdays(values)) return values.startDate;
  return alignStartDate(values.startDate, values.weekdays);
}

export function defaultEventFormValues(startDate: string, startTime: string): EventFormValues {
  return {
    title: '',
    notes: '',
    startDate,
    startTime,
    durationMin: DEFAULT_DURATION_MIN,
    repeatPreset: 'none',
    customInterval: 1,
    customUnit: 'day',
    weekdays: [weekdayOfDate(startDate)],
    endsDate: '',
    maxSnoozes: DEFAULT_MAX_SNOOZES,
    snoozeMinutes: DEFAULT_SNOOZE_MINUTES,
    passable: true,
    color: null,
  };
}

export function eventToFormValues(event: EventRow, tz: string): EventFormValues {
  const start = zonedParts(new Date(event.start_at), tz);
  const repeat = repeatFormFromRule({ unit: event.repeat_unit, interval: event.repeat_interval });
  return {
    title: event.title,
    notes: event.notes ?? '',
    startDate: start.date,
    startTime: start.time,
    durationMin: event.duration_min,
    repeatPreset: repeat.repeatPreset,
    customInterval: repeat.customInterval,
    customUnit: repeat.customUnit,
    // null means "the weekday of start_at" in the database.
    weekdays: event.repeat_weekdays ?? [weekdayOfDate(start.date)],
    endsDate: event.ends_at === null ? '' : zonedParts(new Date(event.ends_at), tz).date,
    maxSnoozes: event.max_snoozes,
    snoozeMinutes: event.snooze_minutes,
    passable: event.passable,
    color: event.color,
  };
}

/** Converts validated form values to database columns; times become UTC instants. */
export function eventFormToWriteInput(values: EventFormValues, tz: string): EventWriteInput {
  const rule = repeatRuleFromForm(values);
  const weekdays = rule.unit === 'week' ? sortedWeekdays(values.weekdays) : null;
  const startDate = rule.unit === 'week' ? alignStartDate(values.startDate, values.weekdays) : values.startDate;
  const trimmedNotes = values.notes.trim();

  return {
    title: values.title.trim(),
    notes: trimmedNotes === '' ? null : trimmedNotes,
    start_at: instantFromZoned(startDate, values.startTime, tz).toISOString(),
    duration_min: values.durationMin,
    repeat_unit: rule.unit,
    repeat_interval: rule.interval,
    repeat_weekdays: weekdays,
    // The end date is inclusive, so the series runs to the last minute of that day.
    ends_at:
      rule.unit !== 'none' && values.endsDate !== ''
        ? instantFromZoned(values.endsDate, '23:59', tz).toISOString()
        : null,
    max_snoozes: values.maxSnoozes,
    snooze_minutes: values.snoozeMinutes,
    passable: values.passable,
    color: values.color,
  };
}
