import type { Settings } from '@alarm-calendar/core';

import { supabase } from '@/lib/supabase';
import { fail, ok, type Result } from '@/lib/result';

const SETTINGS_COLUMNS = 'user_id, timezone, week_starts_on, refire_seconds, pass_cap, grace_minutes';

/** The columns a client may write. pass_cap is the product's rule, not a preference. */
export type SettingsPatch = Partial<
  Pick<Settings, 'timezone' | 'week_starts_on' | 'refire_seconds' | 'grace_minutes'>
>;

const WRITABLE_COLUMNS = ['timezone', 'week_starts_on', 'refire_seconds', 'grace_minutes'] as const;

/** Drops anything a caller smuggled in (pass_cap, user_id): the database would reject it anyway. */
function writableColumns(patch: SettingsPatch): SettingsPatch {
  const picked: SettingsPatch = {};
  for (const column of WRITABLE_COLUMNS) {
    const value = patch[column];
    if (value !== undefined) Object.assign(picked, { [column]: value });
  }
  return picked;
}

/** Null data means the row does not exist yet; sync_wallet recreates it. */
export async function fetchSettings(): Promise<Result<Settings | null>> {
  const { data, error } = await supabase
    .from('settings')
    .select(SETTINGS_COLUMNS)
    .maybeSingle<Settings>();
  if (error) return fail(error.message);
  return ok(data);
}

/**
 * Plain UPDATE, never upsert: an upsert's ON CONFLICT DO UPDATE touches user_id and
 * pass_cap, which clients have no column privilege on, so it fails by design.
 */
export async function updateSettings(userId: string, patch: SettingsPatch): Promise<Result<Settings>> {
  const { data, error } = await supabase
    .from('settings')
    .update(writableColumns(patch))
    .eq('user_id', userId)
    .select(SETTINGS_COLUMNS)
    .maybeSingle<Settings>();
  if (error) return fail(error.message);
  if (data === null) return fail('Your settings could not be found. Reload the app and try again.');
  return ok(data);
}

/**
 * Creates the settings row when it is missing (the signup trigger normally makes it). A plain
 * INSERT of the granted columns only, so the device zone is in place before the first
 * sync_wallet anchors the wallet.
 */
export async function createSettings(userId: string, timezone: string): Promise<Result<Settings>> {
  const { data, error } = await supabase
    .from('settings')
    .insert({ user_id: userId, timezone })
    .select(SETTINGS_COLUMNS)
    .single<Settings>();
  if (error) return fail(error.message);
  return ok(data);
}
