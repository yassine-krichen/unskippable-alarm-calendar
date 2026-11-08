import { DEFAULT_SESSION_TIME, MAX_LEAD_MINUTES } from '@alarm-calendar/core';
import { z } from 'zod';

import { addDays, instantFromZoned, isRealDate } from '@/lib/zoned-time';

import { DEFAULT_EXAM_LEAD_MINUTES, DEFAULT_SESSION_MINUTES, type ExamFormValues } from './exam-plan';

// Reading an exam back into form values moved to core (shared with the agent CLI).
export { examToFormValues } from '@alarm-calendar/core';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export const DEFAULT_EXAM_TIME = '09:00';
export { MAX_LEAD_MINUTES };

export interface ExamFormContext {
  tz: string;
  now: () => Date;
  /** A new exam in the past would plan nothing and ring nothing, so creating one is refused. */
  isNew: boolean;
}

const timeField = z.string().regex(TIME_PATTERN, 'Enter a time like 08:30.');

const dateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date.')
  .refine(isRealDate, 'Pick a real date.');

export function createExamFormSchema(context: ExamFormContext) {
  return z
    .object({
      title: z.string().trim().min(1, 'Give the exam a name.').max(100, 'Keep the name under 100 characters.'),
      notes: z.string().max(2000, 'Keep notes under 2000 characters.'),
      examDate: dateField,
      examTime: timeField,
      difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      sessionTime: timeField,
      sessionMinutes: z
        .number('Enter a length in minutes.')
        .int('Use whole minutes.')
        .min(5, 'A session is at least 5 minutes.')
        .max(480, 'A session is at most 8 hours.'),
      leadMinutes: z
        .number('Enter a number of minutes.')
        .int('Use whole minutes.')
        .min(0, 'Minutes can not be negative.')
        .max(MAX_LEAD_MINUTES, 'At most 24 hours before.'),
      showInCalendar: z.boolean(),
    })
    .superRefine((values, ctx) => {
      if (!context.isNew || !isRealDate(values.examDate) || !TIME_PATTERN.test(values.examTime)) return;
      if (instantFromZoned(values.examDate, values.examTime, context.tz).getTime() <= context.now().getTime()) {
        ctx.addIssue({ code: 'custom', path: ['examDate'], message: 'That time has already passed.' });
      }
    });
}

/** A new exam starts on the clicked day, or the next one when 09:00 that day has already passed. */
export function defaultExamFormValues(slotDate: string, tz: string, now: Date): ExamFormValues {
  const passed = instantFromZoned(slotDate, DEFAULT_EXAM_TIME, tz).getTime() <= now.getTime();
  return {
    title: '',
    notes: '',
    examDate: passed ? addDays(slotDate, 1) : slotDate,
    examTime: DEFAULT_EXAM_TIME,
    difficulty: 2,
    sessionTime: DEFAULT_SESSION_TIME,
    sessionMinutes: DEFAULT_SESSION_MINUTES,
    leadMinutes: DEFAULT_EXAM_LEAD_MINUTES,
    showInCalendar: true,
  };
}
