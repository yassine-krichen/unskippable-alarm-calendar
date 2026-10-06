import { fail, ok, type Result } from '@/lib/result';
import { addDays, isRealDate, startOfZonedDay, zonedDate } from '@/lib/zoned-time';

import type { ManualSwitchInput } from './modes-api';

/** When the new mode starts: right now, or from the start of today ("I got sick this morning"). */
export type StartChoice = 'now' | 'today';

/** How long it lasts: until the person switches it off, or until the end of a chosen day. */
export type EndChoice = 'open' | 'date';

export interface SwitchForm {
  /** The mode to switch to, or null for "back to normal". */
  modeId: string | null;
  start: StartChoice;
  end: EndChoice;
  /** 'yyyy-MM-dd'; only read when `end` is 'date'. */
  endDate: string;
}

/**
 * The request the header switch sends. Normal has no start or end to choose. "From this morning" starts at
 * the beginning of today in the settings zone, so the alarms already past today are not scored against the
 * person (the database accepts a start up to 7 days back, never in the future). A chosen end day is included
 * whole: the mode ends when the next day begins. Returns a message instead of a request when the end is
 * missing, not a date, or before today.
 */
export function buildSwitchRequest(form: SwitchForm, now: Date, tz: string): Result<ManualSwitchInput> {
  if (form.modeId === null) return ok({ modeId: null, startsAt: null, endsAt: null });

  const today = zonedDate(now, tz);
  const startsAt = form.start === 'today' ? startOfZonedDay(today, tz).toISOString() : null;
  if (form.end === 'open') return ok({ modeId: form.modeId, startsAt, endsAt: null });

  if (form.endDate === '' || !isRealDate(form.endDate)) return fail('Pick the last day of the mode.');
  if (form.endDate < today) return fail('The last day cannot be before today.');
  return ok({ modeId: form.modeId, startsAt, endsAt: startOfZonedDay(addDays(form.endDate, 1), tz).toISOString() });
}

/** A planned range as the form has it: first and last day, both included. */
export interface RangeForm {
  modeId: string;
  /** 'yyyy-MM-dd' */
  firstDay: string;
  /** 'yyyy-MM-dd' */
  lastDay: string;
}

export interface RangeWrite {
  modeId: string;
  startsAt: string;
  endsAt: string;
}

/** The two ISO instants of a planned range: the start of its first day to the start of the day after its last. */
export function buildRange(form: RangeForm, tz: string): Result<RangeWrite> {
  if (!isRealDate(form.firstDay) || !isRealDate(form.lastDay)) return fail('Pick the first and the last day.');
  if (form.lastDay < form.firstDay) return fail('The last day cannot be before the first.');
  return ok({
    modeId: form.modeId,
    startsAt: startOfZonedDay(form.firstDay, tz).toISOString(),
    endsAt: startOfZonedDay(addDays(form.lastDay, 1), tz).toISOString(),
  });
}

// The set_manual_mode RPC raises P0001 with a code as its message, like the pass RPCs.
const MODE_ERROR_MESSAGES: Record<string, string> = {
  mode_not_found: 'That mode no longer exists or is switched off. Reload and try again.',
  invalid_start: "The start can't be in the future or more than 7 days ago.",
  invalid_end: 'The end has to be after the start.',
  not_authenticated: 'Your session expired. Sign in again.',
};

/** Friendly toast text for a failed mode switch or save. */
export function modeErrorMessage(rawError: string): string {
  const known = MODE_ERROR_MESSAGES[rawError.trim()];
  if (known !== undefined) return known;
  if (/failed to fetch|network|load failed/i.test(rawError)) return "Can't reach the server. Check your connection and try again.";
  return 'Something went wrong. Try again in a moment.';
}
