import type { EventRow } from './types';
import {
  isRepeating,
  repeatFormFromRule,
  repeatRuleFromForm,
  usesWeekdays,
  type CustomRepeatUnit,
  type RepeatPreset,
} from './repeat-presets';
import { addDays, instantFromZoned, isRealDate, weekdayOfDate, zonedParts } from './wall-time';

// The alarm form's values and their conversion to and from database columns. Pure, shared by the app's
// form and the agent CLI so both write the same rows for the same intent.

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
  /** False keeps the alarm off the calendar (it still rings and counts in habits). */
  showInCalendar: boolean;
}

/**
 * The writable columns of an events row; id, user_id, active and updated_at are the database's. `agent_key`
 * is optional: the app never sets it (an update that leaves it out keeps it), the agent CLI does.
 */
export type EventWriteInput = Omit<EventRow, 'id' | 'user_id' | 'active' | 'updated_at'>;

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
    showInCalendar: true,
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
    showInCalendar: event.show_in_calendar ?? true,
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
    show_in_calendar: values.showInCalendar,
  };
}

// Re-exported so a caller that builds a form gets the repeat helpers it needs from one place.
export { isRepeating, usesWeekdays };
