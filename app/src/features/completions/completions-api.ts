import type { CompletionRow } from '@alarm-calendar/core';

import { fail, ok, type Result } from '@/lib/result';
import { supabase } from '@/lib/supabase';

const COMPLETION_COLUMNS = 'id, user_id, event_id, occurrence_at, status, snoozes_used, done_at';

/**
 * Only the recent past matters: the alarm engine uses completions to avoid re-ringing an
 * occurrence that was already done inside the grace window, and the longest grace option is
 * 2 hours. Three days leaves a wide margin.
 */
export const COMPLETION_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const COMPLETION_LIMIT = 1000;

export async function fetchRecentCompletions(now: Date = new Date()): Promise<Result<CompletionRow[]>> {
  const since = new Date(now.getTime() - COMPLETION_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from('completions')
    .select(COMPLETION_COLUMNS)
    .gte('occurrence_at', since)
    .order('occurrence_at', { ascending: false })
    .limit(COMPLETION_LIMIT)
    .overrideTypes<CompletionRow[], { merge: false }>();
  if (error) return fail(error.message);
  return ok(data ?? []);
}

/**
 * Records a made-up prayer (qada): an ordinary 'done' completion of the missed occurrence, with done_at = now, which
 * is after the prayer's window and so scores as a qada (see prayerTimingOf in core). First write wins, like the
 * alarm engines' own upserts: if a row for the occurrence already exists nothing is written and the result is null
 * (the caller reloads to show what is there). Online only; user_id comes from the session in the database.
 */
export async function insertQadaCompletion(
  eventId: string,
  occurrenceAt: string,
  now: Date = new Date()
): Promise<Result<CompletionRow | null>> {
  const { data, error } = await supabase
    .from('completions')
    .upsert(
      { event_id: eventId, occurrence_at: occurrenceAt, status: 'done', snoozes_used: 0, done_at: now.toISOString() },
      { onConflict: 'event_id,occurrence_at', ignoreDuplicates: true }
    )
    .select(COMPLETION_COLUMNS)
    .overrideTypes<CompletionRow[], { merge: false }>();
  if (error) return fail(error.message);
  return ok(data?.[0] ?? null);
}
