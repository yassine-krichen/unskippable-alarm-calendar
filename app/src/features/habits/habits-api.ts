import { HABIT_WINDOW_DAYS } from '@alarm-calendar/core';
import type { HabitCompletion } from '@alarm-calendar/core';

import { fail, ok, type Result } from '@/lib/result';
import { supabase } from '@/lib/supabase';

/** What scoring reads of a completion, plus the id a realtime DELETE identifies it by. */
export interface HabitCompletionRow extends HabitCompletion {
  id: string;
}

/** A habit whose scoring window is longer than the bulk 28 days, so it needs older history. */
export interface LongWindowHabit {
  id: string;
  windowDays: number;
}

const HABIT_COMPLETION_COLUMNS = 'id, event_id, occurrence_at, status, snoozes_used';

const MS_PER_DAY = 86_400_000;
/** The bulk fetch: 28 days plus one so an occurrence at the window edge is never cut by clock skew. */
export const HABIT_LOAD_WINDOW_MS = (HABIT_WINDOW_DAYS + 1) * MS_PER_DAY;

// PostgREST answers at most 1000 rows per request, so a busy account (an hourly alarm alone is
// 672 occurrences in 28 days) is read in pages. The cap keeps the read bounded.
const PAGE_SIZE = 1000;
const MAX_PAGES = 5;

interface PageResponse {
  data: HabitCompletionRow[] | null;
  error: { message: string } | null;
}

/**
 * Reads page after page until a short one. If the cap is reached with the last page still full
 * there may be more rows, and scoring a partial history would turn the missing ones into
 * misses, so that is a failure rather than a truncated list.
 */
async function readPages(read: (from: number, to: number) => PromiseLike<PageResponse>): Promise<Result<HabitCompletionRow[]>> {
  const rows: HabitCompletionRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await read(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (error) return fail(error.message);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return ok(rows);
  }
  return fail('Too many completions to load the full history.');
}

/**
 * Completions whose occurrence falls in the last 28 days (plus a margin), newest first, for every
 * habit. This is separate from the 3-day list the alarm engine gets (completions-api.ts), so the
 * schedule push does not carry weeks of history.
 */
export function fetchHabitCompletions(now: Date = new Date()): Promise<Result<HabitCompletionRow[]>> {
  const since = new Date(now.getTime() - HABIT_LOAD_WINDOW_MS).toISOString();
  return readPages((from, to) =>
    supabase
      .from('completions')
      .select(HABIT_COMPLETION_COLUMNS)
      .gte('occurrence_at', since)
      .order('occurrence_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to)
      .overrideTypes<HabitCompletionRow[], { merge: false }>()
  );
}

/**
 * The older history only the long-window habits (weekly, monthly, slow intervals) need: rows
 * before the bulk range, back to the longest of their windows. A fast habit such as an hourly
 * alarm is never in this list, so it never pulls months of rows.
 */
export async function fetchExtendedHabitCompletions(
  habits: readonly LongWindowHabit[],
  now: Date = new Date()
): Promise<Result<HabitCompletionRow[]>> {
  if (habits.length === 0) return ok([]);
  const longest = Math.max(...habits.map((habit) => habit.windowDays));
  const since = new Date(now.getTime() - (longest + 1) * MS_PER_DAY).toISOString();
  const before = new Date(now.getTime() - HABIT_LOAD_WINDOW_MS).toISOString();
  const ids = habits.map((habit) => habit.id);
  return readPages((from, to) =>
    supabase
      .from('completions')
      .select(HABIT_COMPLETION_COLUMNS)
      .in('event_id', ids)
      .gte('occurrence_at', since)
      .lt('occurrence_at', before)
      .order('occurrence_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to)
      .overrideTypes<HabitCompletionRow[], { merge: false }>()
  );
}
