import { HABIT_MAX_WINDOW_DAYS, type ModeActivationRow, type ModeBehavior, type ModeRow, type ModeRuleRow } from '@alarm-calendar/core';

import { fail, ok, type Result } from '@/lib/result';
import { supabase } from '@/lib/supabase';

const MODE_COLUMNS = 'id, user_id, name, kind, builtin_key, default_behavior, active, created_at, updated_at';
const RULE_COLUMNS = 'id, user_id, mode_id, event_id, behavior, shift_minutes, duration_min, updated_at';
const ACTIVATION_COLUMNS = 'id, user_id, mode_id, starts_at, ends_at, source, updated_at';

// PostgREST returns at most this many rows unless asked for more; a full page is treated as a failed read
// rather than silently dropping the rest (a missing activation would un-pause alarms, a missing rule would
// change what an alarm does).
export const MODES_PAGE_LIMIT = 1000;

async function fetchAll<T>(table: string, columns: string, orderBy: string): Promise<Result<T[]>> {
  const { data, error } = await supabase
    .from(table)
    .select(columns)
    .order(orderBy, { ascending: true })
    .limit(MODES_PAGE_LIMIT)
    .overrideTypes<T[], { merge: false }>();
  if (error || data === null) return fail(error?.message ?? 'No data');
  if (data.length >= MODES_PAGE_LIMIT) return fail(`Too many rows in ${table} to load safely.`);
  return ok(data);
}

/** Every mode, switched off ones included (a built-in that is off is still listed; a deleted custom one is hidden by the UI). */
export function fetchModes(): Promise<Result<ModeRow[]>> {
  return fetchAll<ModeRow>('modes', MODE_COLUMNS, 'created_at');
}

export function fetchModeRules(): Promise<Result<ModeRuleRow[]>> {
  return fetchAll<ModeRuleRow>('mode_rules', RULE_COLUMNS, 'created_at');
}

/**
 * How far back an activation can still matter: the longest habit scoring window (180 days) plus a day. An
 * activation that ended before that cannot change a score or what rings, so it is not loaded.
 */
export const ACTIVATION_LOOKBACK_DAYS = HABIT_MAX_WINDOW_DAYS + 1;

/** At most this many pages of MODES_PAGE_LIMIT activations; more than that is a failed read, not a truncated list. */
export const MAX_ACTIVATION_PAGES = 10;

/**
 * The activations that are open-ended, still running or planned, or ended within the look-back, in pages (a
 * person who switches modes often can pass 1000 rows in a year or two). Ordered by start and id so the pages
 * never overlap or skip. A list that does not fit in MAX_ACTIVATION_PAGES fails: a missing activation would
 * un-pause alarms.
 */
export async function fetchModeActivations(now: Date = new Date()): Promise<Result<ModeActivationRow[]>> {
  const cutoff = new Date(now.getTime() - ACTIVATION_LOOKBACK_DAYS * 86_400_000).toISOString();
  const rows: ModeActivationRow[] = [];
  for (let page = 0; page < MAX_ACTIVATION_PAGES; page++) {
    const { data, error } = await supabase
      .from('mode_activations')
      .select(ACTIVATION_COLUMNS)
      .or(`ends_at.is.null,ends_at.gt.${cutoff}`)
      .order('starts_at', { ascending: true })
      .order('id', { ascending: true })
      .range(page * MODES_PAGE_LIMIT, (page + 1) * MODES_PAGE_LIMIT - 1)
      .overrideTypes<ModeActivationRow[], { merge: false }>();
    if (error || data === null) return fail(error?.message ?? 'No data');
    rows.push(...data);
    if (data.length < MODES_PAGE_LIMIT) return ok(rows);
  }
  return fail('Too many mode activations to load safely.');
}

/** Creates the built-in modes that are missing; safe to repeat (see the modes migration). */
export async function ensureBuiltinModes(): Promise<Result<null>> {
  const { error } = await supabase.rpc('ensure_builtin_modes');
  if (error) return fail(error.message);
  return ok(null);
}

export interface ManualSwitchInput {
  /** The mode to switch to, or null for "back to normal". */
  modeId: string | null;
  /** ISO instant the person says it began; null = now. At most 7 days back (the database enforces it). */
  startsAt: string | null;
  /** ISO instant it ends; null = open-ended, until switched back. */
  endsAt: string | null;
}

/** The header switch: ends the manual mode in effect and starts the new one, in one transaction. */
export async function setManualMode(input: ManualSwitchInput): Promise<Result<null>> {
  const { error } = await supabase.rpc('set_manual_mode', {
    p_mode_id: input.modeId,
    p_starts_at: input.startsAt,
    p_ends_at: input.endsAt,
  });
  if (error) return fail(error.message);
  return ok(null);
}

export async function createMode(name: string, defaultBehavior: 'keep' | 'skip'): Promise<Result<ModeRow>> {
  // user_id, kind and builtin_key take their defaults: a client creates custom modes only.
  const { data, error } = await supabase
    .from('modes')
    .insert({ name, default_behavior: defaultBehavior })
    .select(MODE_COLUMNS)
    .single<ModeRow>();
  if (error || data === null) return fail(error?.message ?? 'No data');
  return ok(data);
}

/** What a client may change on a mode; the database refuses anything else (column grants). */
export interface ModePatch {
  name?: string;
  default_behavior?: 'keep' | 'skip';
  active?: boolean;
}

export async function updateMode(id: string, patch: ModePatch): Promise<Result<ModeRow>> {
  const { data, error } = await supabase.from('modes').update(patch).eq('id', id).select(MODE_COLUMNS).single<ModeRow>();
  if (error || data === null) return fail(error?.message ?? 'No data');
  return ok(data);
}

export interface RuleWriteInput {
  mode_id: string;
  event_id: string;
  behavior: ModeBehavior;
  shift_minutes: number | null;
  duration_min: number | null;
}

/** Writes rules, replacing the one of the same (mode, alarm): ON CONFLICT (mode_id, event_id) DO UPDATE. */
export async function upsertModeRules(rules: readonly RuleWriteInput[]): Promise<Result<null>> {
  if (rules.length === 0) return ok(null);
  const { error } = await supabase.from('mode_rules').upsert([...rules], { onConflict: 'mode_id,event_id' });
  if (error) return fail(error.message);
  return ok(null);
}

export async function deleteModeRules(ids: readonly string[]): Promise<Result<null>> {
  if (ids.length === 0) return ok(null);
  const { error } = await supabase.from('mode_rules').delete().in('id', [...ids]);
  if (error) return fail(error.message);
  return ok(null);
}

/** A planned range; both ends are ISO instants. The manual switch goes through setManualMode instead. */
export async function createRangeActivation(modeId: string, startsAt: string, endsAt: string): Promise<Result<ModeActivationRow>> {
  const { data, error } = await supabase
    .from('mode_activations')
    .insert({ mode_id: modeId, starts_at: startsAt, ends_at: endsAt, source: 'range' })
    .select(ACTIVATION_COLUMNS)
    .single<ModeActivationRow>();
  if (error || data === null) return fail(error?.message ?? 'No data');
  return ok(data);
}

export async function deleteActivation(id: string): Promise<Result<null>> {
  const { error } = await supabase.from('mode_activations').delete().eq('id', id);
  if (error) return fail(error.message);
  return ok(null);
}
