import type { CompletionRow, ExamDifficulty, ExamRow } from '@alarm-calendar/core';

import { fail, ok, type Result } from '@/lib/result';
import { supabase } from '@/lib/supabase';

const EXAM_COLUMNS = 'id, user_id, title, exam_at, difficulty, notes, active, created_at, updated_at';
const COMPLETION_COLUMNS = 'id, user_id, event_id, occurrence_at, status, snoozes_used, done_at';

/** The writable columns of an exams row; the rest is the database's. */
export interface ExamWriteInput {
  title: string;
  exam_at: string;
  difficulty: ExamDifficulty;
  notes: string | null;
}

export async function fetchActiveExams(): Promise<Result<ExamRow[]>> {
  const { data, error } = await supabase
    .from('exams')
    .select(EXAM_COLUMNS)
    .eq('active', true)
    .order('exam_at', { ascending: true })
    .overrideTypes<ExamRow[], { merge: false }>();
  if (error || data === null) return fail(error?.message ?? 'No data');
  return ok(data);
}

export async function createExam(input: ExamWriteInput): Promise<Result<ExamRow>> {
  // user_id defaults to auth.uid() in the database; RLS rejects anything else.
  const { data, error } = await supabase.from('exams').insert(input).select(EXAM_COLUMNS).single<ExamRow>();
  if (error || data === null) return fail(error?.message ?? 'No data');
  return ok(data);
}

export async function updateExam(id: string, input: ExamWriteInput): Promise<Result<ExamRow>> {
  const { data, error } = await supabase.from('exams').update(input).eq('id', id).select(EXAM_COLUMNS).single<ExamRow>();
  if (error || data === null) return fail(error?.message ?? 'No data');
  return ok(data);
}

/** Delete is a soft delete, like events: the row stays so completions of its sessions keep their event. */
export async function deactivateExam(id: string): Promise<Result<null>> {
  const { data, error } = await supabase
    .from('exams')
    .update({ active: false })
    .eq('id', id)
    .select('id')
    .overrideTypes<Array<{ id: string }>, { merge: false }>();
  if (error) return fail(error.message);
  if (data.length === 0) return fail('That exam no longer exists. Reload and try again.');
  return ok(null);
}

// One request per this many event ids keeps the `in (...)` filter, which travels in the URL, short.
const IDS_PER_REQUEST = 100;

/**
 * Every completion of the given events. A one-off session has at most one, so the count is bounded by
 * the number of ids and a read never needs paging.
 */
export async function fetchCompletionsOfEvents(eventIds: readonly string[]): Promise<Result<CompletionRow[]>> {
  const rows: CompletionRow[] = [];
  for (let start = 0; start < eventIds.length; start += IDS_PER_REQUEST) {
    const { data, error } = await supabase
      .from('completions')
      .select(COMPLETION_COLUMNS)
      .in('event_id', eventIds.slice(start, start + IDS_PER_REQUEST))
      .overrideTypes<CompletionRow[], { merge: false }>();
    if (error) return fail(error.message);
    rows.push(...(data ?? []));
  }
  return ok(rows);
}
