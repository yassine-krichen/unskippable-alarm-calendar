import { create } from 'zustand';

import { createLatestRequestGuard } from '@/lib/latest-request';
import type { Result } from '@/lib/result';

import { fetchCheatDays, refundPass, spendPass, syncWallet } from './passes-api';
import type { WalletSnapshot } from './pass-status';

interface PassesState {
  /** Null until the first sync_wallet returns. */
  wallet: WalletSnapshot | null;
  /** The wallet as it was before the latest sync; passToday needs both. */
  walletBeforeSync: WalletSnapshot | null;
  /** Calendar days ('yyyy-MM-dd') that are cheat days, ascending. */
  cheatDays: string[];
}

export const usePassesStore = create<PassesState>(() => ({
  wallet: null,
  walletBeforeSync: null,
  cheatDays: [],
}));

// A slow sync_wallet or cheat-day fetch must not overwrite what a later request, a spend or a
// refund already put in the store.
const walletGuard = createLatestRequestGuard();
const cheatDaysGuard = createLatestRequestGuard();

function applyWallet(wallet: WalletSnapshot): void {
  walletGuard.invalidate();
  usePassesStore.setState((state) => ({
    wallet,
    walletBeforeSync: state.wallet ?? wallet,
  }));
}

/** Call on launch and on window focus (spec section 7). */
export async function syncPassWallet(): Promise<Result<WalletSnapshot>> {
  const isLatest = walletGuard.begin();
  const result = await syncWallet();
  if (result.data && isLatest()) applyWallet(result.data);
  return result;
}

export async function loadCheatDays(): Promise<Result<string[]>> {
  const isLatest = cheatDaysGuard.begin();
  const result = await fetchCheatDays();
  if (result.data && isLatest()) usePassesStore.setState({ cheatDays: result.data });
  return result;
}

// Using or refunding a pass needs the network (spec section 7). After success the cheat-day
// list is refetched so the calendar and the alarm adapter see the same days: the schedule sync
// (features/alarm-adapter/schedule-sync.ts) watches `cheatDays` and pushes it to the platform.
export async function spendPassOnDay(day: string): Promise<Result<WalletSnapshot>> {
  const result = await spendPass(day);
  if (result.data) {
    applyWallet(result.data);
    await loadCheatDays();
  }
  return result;
}

export async function refundPassOnDay(day: string): Promise<Result<WalletSnapshot>> {
  const result = await refundPass(day);
  if (result.data) {
    applyWallet(result.data);
    await loadCheatDays();
  }
  return result;
}
