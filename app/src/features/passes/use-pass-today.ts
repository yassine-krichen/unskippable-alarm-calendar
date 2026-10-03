import { useAuthStore } from '@/features/auth/auth-store';
import { useSettingsStore } from '@/features/settings/settings-store';

import { passTodayFromSnapshots } from './pass-status';
import { usePassesStore } from './passes-store';

/**
 * "Today" as the pass RPCs decide it ('yyyy-MM-dd'), or null before the first sync.
 * Used for hints only: the database makes the real decision.
 */
export function usePassToday(): string | null {
  const userId = useAuthStore((state) => state.session?.user.id ?? null);
  const timezone = useSettingsStore((state) => state.settings?.timezone ?? null);
  const wallet = usePassesStore((state) => state.wallet);
  const walletBeforeSync = usePassesStore((state) => state.walletBeforeSync);

  if (userId === null || timezone === null || wallet === null || walletBeforeSync === null) return null;
  return passTodayFromSnapshots(walletBeforeSync, wallet, new Date(), timezone, userId);
}
