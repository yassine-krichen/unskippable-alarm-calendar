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
