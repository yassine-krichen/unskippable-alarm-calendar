import type { EventRow } from '@alarm-calendar/core';
import { create } from 'zustand';

import { supabase } from '@/lib/supabase';
import { fail, ok, type Result } from '@/lib/result';

import type { EventWriteInput } from './event-form';

const BASE_COLUMNS =
  'id, user_id, title, notes, start_at, duration_min, repeat_unit, repeat_interval, repeat_weekdays, ends_at, max_snoozes, snooze_minutes, passable, color, active, created_at, updated_at, kind, prayer';

// Until the events_group_id migration is pushed the column does not exist and a select that names it
// fails as a whole. The first such failure turns the column off for the session and the read is retried
// without it, so the rest of the app keeps working (grouped alarms simply behave as plain ones). The flag
// lives in a store so the event sheet can hide the birthday template while it is set.
export const useGroupIdSupport = create<{ missing: boolean }>(() => ({ missing: false }));

function groupIdColumnMissing(): boolean {
  return useGroupIdSupport.getState().missing;
}

function eventColumns(): string {
  return groupIdColumnMissing() ? BASE_COLUMNS : `${BASE_COLUMNS}, group_id`;
}

/**
 * Postgres reports an unknown column in a select as 42703 and PostgREST reports one in a write as
 * PGRST204. The message must name group_id as well, so an unrelated failure that happens to mention the
 * column (a constraint, say) is surfaced instead of being retried and hidden.
 */
function isMissingGroupIdColumn(error: { message: string; code?: string }): boolean {
  return (error.code === '42703' || error.code === 'PGRST204') && /group_id/.test(error.message);
}

interface ColumnResponse<T> {
  data: T | null;
  error: { message: string; code?: string } | null;
}

async function withEventColumns<T>(run: (columns: string) => PromiseLike<ColumnResponse<T>>): Promise<ColumnResponse<T>> {
  const response = await run(eventColumns());
  if (response.error && !groupIdColumnMissing() && isMissingGroupIdColumn(response.error)) {
    useGroupIdSupport.setState({ missing: true });
    return run(eventColumns());
  }
  return response;
}

/** Test hook: forget that the group_id column was found missing. */
export function resetGroupIdColumnProbe(): void {
  useGroupIdSupport.setState({ missing: false });
}

export async function fetchActiveEvents(): Promise<Result<EventRow[]>> {
  const { data, error } = await withEventColumns((columns) =>
    supabase
      .from('events')
      .select(columns)
      .eq('active', true)
      .order('start_at', { ascending: true })
      .overrideTypes<EventRow[], { merge: false }>()
  );
  if (error || data === null) return fail(error?.message ?? 'No data');
  return ok(data);
}

export async function createEvent(input: EventWriteInput): Promise<Result<EventRow>> {
  // user_id defaults to auth.uid() in the database; RLS rejects anything else.
  const { data, error } = await withEventColumns((columns) =>
    supabase.from('events').insert(input).select(columns).single<EventRow>()
  );
  if (error || data === null) return fail(error?.message ?? 'No data');
  return ok(data);
}

/** One statement, so the alarms of a template are created together or not at all. */
export async function createEvents(inputs: EventWriteInput[]): Promise<Result<EventRow[]>> {
  const { data, error } = await withEventColumns((columns) =>
    supabase.from('events').insert(inputs).select(columns).overrideTypes<EventRow[], { merge: false }>()
  );
  if (error || data === null) return fail(error?.message ?? 'No data');
  return ok(data);
}

/** Editing a recurring event changes the whole series going forward; past completions stay. */
export async function updateEvent(id: string, input: EventWriteInput): Promise<Result<EventRow>> {
  const { data, error } = await withEventColumns((columns) =>
    supabase.from('events').update(input).eq('id', id).select(columns).single<EventRow>()
  );
  if (error || data === null) return fail(error?.message ?? 'No data');
  return ok(data);
}

/** Delete is a soft delete: the row stays so completions keep their event. */
export async function deactivateEvent(id: string): Promise<Result<null>> {
  return deactivateEvents([id]);
}

/** Soft-deletes several alarms in one statement; each id must match a row of the signed-in user. */
export async function deactivateEvents(ids: string[]): Promise<Result<null>> {
  const { data, error } = await supabase
    .from('events')
    .update({ active: false })
    .in('id', ids)
    .select('id')
    .overrideTypes<Array<{ id: string }>, { merge: false }>();
  if (error) return fail(error.message);
  // RLS hides rows that are not yours and a stale id matches nothing; neither is a delete.
  if (data.length === 0) return fail('That alarm no longer exists. Reload and try again.');
  return ok(null);
}
