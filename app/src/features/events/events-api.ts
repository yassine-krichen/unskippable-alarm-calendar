import type { EventRow } from '@alarm-calendar/core';

import { supabase } from '@/lib/supabase';
import { fail, ok, type Result } from '@/lib/result';

import type { EventWriteInput } from './event-form';

const EVENT_COLUMNS =
  'id, user_id, title, notes, start_at, duration_min, repeat_unit, repeat_interval, repeat_weekdays, ends_at, max_snoozes, snooze_minutes, passable, color, active, created_at, updated_at';

export async function fetchActiveEvents(): Promise<Result<EventRow[]>> {
  const { data, error } = await supabase
    .from('events')
    .select(EVENT_COLUMNS)
    .eq('active', true)
    .order('start_at', { ascending: true })
    .overrideTypes<EventRow[], { merge: false }>();
  if (error) return fail(error.message);
  return ok(data);
}

export async function createEvent(input: EventWriteInput): Promise<Result<EventRow>> {
  // user_id defaults to auth.uid() in the database; RLS rejects anything else.
  const { data, error } = await supabase
    .from('events')
    .insert(input)
    .select(EVENT_COLUMNS)
    .single<EventRow>();
  if (error) return fail(error.message);
  return ok(data);
}

/** Editing a recurring event changes the whole series going forward; past completions stay. */
export async function updateEvent(id: string, input: EventWriteInput): Promise<Result<EventRow>> {
  const { data, error } = await supabase
    .from('events')
    .update(input)
    .eq('id', id)
    .select(EVENT_COLUMNS)
    .single<EventRow>();
  if (error) return fail(error.message);
  return ok(data);
}

/** Delete is a soft delete: the row stays so completions keep their event. */
export async function deactivateEvent(id: string): Promise<Result<null>> {
  const { data, error } = await supabase
    .from('events')
    .update({ active: false })
    .eq('id', id)
    .select('id')
    .overrideTypes<Array<{ id: string }>, { merge: false }>();
  if (error) return fail(error.message);
  // RLS hides rows that are not yours and a stale id matches nothing; neither is a delete.
  if (data.length === 0) return fail('That alarm no longer exists. Reload and try again.');
  return ok(null);
}
