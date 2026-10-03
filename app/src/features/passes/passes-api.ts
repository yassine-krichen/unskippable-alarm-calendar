import { supabase } from '@/lib/supabase';
import { fail, ok, type Result } from '@/lib/result';

import { walletSnapshotSchema, type WalletSnapshot } from './pass-status';

async function callWalletRpc(
  name: 'sync_wallet' | 'use_pass' | 'refund_pass',
  args?: { day: string }
): Promise<Result<WalletSnapshot>> {
  const { data, error } = args ? await supabase.rpc(name, args) : await supabase.rpc(name);
  if (error) return fail(error.message);

  const parsed = walletSnapshotSchema.safeParse(data);
  if (!parsed.success) return fail('The server returned an unexpected wallet response.');
  return ok(parsed.data);
}

/** Grants any weekly passes owed (including multi-week catch-up) and returns the wallet. */
export function syncWallet(): Promise<Result<WalletSnapshot>> {
  return callWalletRpc('sync_wallet');
}

export function spendPass(day: string): Promise<Result<WalletSnapshot>> {
  return callWalletRpc('use_pass', { day });
}

export function refundPass(day: string): Promise<Result<WalletSnapshot>> {
  return callWalletRpc('refund_pass', { day });
}

export async function fetchCheatDays(): Promise<Result<string[]>> {
  const { data, error } = await supabase
    .from('cheat_days')
    .select('day')
    .order('day', { ascending: true })
    .overrideTypes<Array<{ day: string }>, { merge: false }>();
  if (error) return fail(error.message);
  return ok(data.map((row) => row.day));
}

/**
 * Whether the wallet has already copied the user's settings (pass_wallet.anchored_at is set).
 * Clients have select-only access to pass_wallet. A missing row counts as not anchored:
 * sync_wallet creates it.
 */
export async function fetchWalletAnchored(): Promise<Result<boolean>> {
  const { data, error } = await supabase
    .from('pass_wallet')
    .select('anchored_at')
    .maybeSingle<{ anchored_at: string | null }>();
  if (error) return fail(error.message);
  return ok(data !== null && data.anchored_at !== null);
}
