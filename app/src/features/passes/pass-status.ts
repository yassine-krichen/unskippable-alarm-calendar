import { passToday, type PassWallet } from '@alarm-calendar/core';
import { z } from 'zod';

import { addDays, weekdayName, weekdayOfDate } from '@/lib/zoned-time';

/** The json that sync_wallet, use_pass and refund_pass return. */
export const walletSnapshotSchema = z.object({
  balance: z.number().int().min(0),
  last_granted_week_start: z.string(),
  timezone: z.string(),
  week_starts_on: z.number().int().min(0).max(6),
});

export type WalletSnapshot = z.infer<typeof walletSnapshotSchema>;

export function passChipLabel(balance: number, cap: number): string {
  return `Pass ${balance}/${cap}`;
}

/**
 * Weekly grants land seven days after the last one (decisions.md: grants are whole
 * weeks between two week starts of the wallet's own snapshot).
 */
export function nextPassDay(wallet: WalletSnapshot): string {
  return addDays(wallet.last_granted_week_start, 7);
}

/** The line under the pass chip: 'At cap' or 'Next pass: Monday'. */
export function nextPassLabel(wallet: WalletSnapshot, cap: number): string {
  if (wallet.balance >= cap) return 'At cap';
  return `Next pass: ${weekdayName(weekdayOfDate(nextPassDay(wallet)))}`;
}

// passToday only reads the wallet's timezone; the other fields are placeholders for the
// columns the RPC json does not carry.
function asPassWallet(snapshot: WalletSnapshot, userId: string): PassWallet {
  return { ...snapshot, user_id: userId, anchored_at: null };
}

/**
 * "Today" for pass hints: the latest of the wallet's local date before and after the sync
 * and the settings zone's date, exactly as the use_pass / refund_pass RPCs decide it.
 */
export function passTodayFromSnapshots(
  before: WalletSnapshot,
  after: WalletSnapshot,
  now: Date,
  settingsTz: string,
  userId: string
): string {
  return passToday(asPassWallet(before, userId), asPassWallet(after, userId), now, settingsTz);
}
