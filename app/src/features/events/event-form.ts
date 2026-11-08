import { MAX_SNOOZE_LIMIT, firstAlarmDate, type EventFormValues } from '@alarm-calendar/core';
import { z } from 'zod';

import { instantFromZoned, isRealDate } from '@/lib/zoned-time';

import { isEventColor } from './event-colors';
import { CUSTOM_REPEAT_UNITS, REPEAT_PRESETS, isRepeating, usesWeekdays, type CustomRepeatUnit } from './repeat-presets';

// The form's values and their conversion to database columns moved to core (shared with the agent CLI);
// the zod schema, with the app's messages, stays here.
export {
  DEFAULT_DURATION_MIN,
  DEFAULT_MAX_SNOOZES,
  DEFAULT_SNOOZE_MINUTES,
  MAX_SNOOZE_LIMIT,
  alignStartDate,
  defaultEventFormValues,
  eventFormToWriteInput,
  eventToFormValues,
  firstAlarmDate,
  sortedWeekdays,
} from '@alarm-calendar/core';
export type { EventFormValues, EventWriteInput } from '@alarm-calendar/core';

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
      showInCalendar: z.boolean(),
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
