import { parseTimeInput } from '@/features/events/time-input-parser';

import type { NativePickerAnswer } from './native-pickers-plugin';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The time the picker opens on when the field holds nothing usable (the first alarm hour of a normal day). */
export const DEFAULT_PICKER_TIME = '09:00';

/**
 * The 'HH:mm' to open the time dialog on. The field can hold half-typed text, so anything the time parser accepts
 * ('8', '830', '8:30 pm') is normalized and anything else falls back to the default.
 */
export function timeToPick(fieldValue: string): string {
  return parseTimeInput(fieldValue) ?? DEFAULT_PICKER_TIME;
}

/** Whether `value` is a real calendar day written 'yyyy-MM-dd' (no 2026-02-30). */
export function isPlainDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/** The 'yyyy-MM-dd' to open the date dialog on: the field's own date, else `today`. */
export function dateToPick(fieldValue: string, today: string): string {
  return isPlainDate(fieldValue) ? fieldValue : today;
}

/**
 * What a picker answer means: the picked value, or null when the dialog was cancelled (or answered with something
 * that is not a value, which is treated the same way: nothing changes).
 */
export function pickedValue(answer: NativePickerAnswer, check: (value: string) => boolean): string | null {
  if (answer.cancelled === true) return null;
  const value = answer.value;
  return typeof value === 'string' && check(value) ? value : null;
}
