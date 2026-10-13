import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useAuthStore } from '@/features/auth/auth-store';
import { subscribeAppResume } from '@/lib/app-resume';

import { bootstrap, refreshAll } from './bootstrap';

export type BootStatus = 'loading' | 'ready' | 'error';

const FOCUS_REFRESH_MIN_GAP_MS = 10_000;
const STALE_TOAST_ID = 'refresh-failed';

/**
 * Loads the signed-in user's data once, then re-syncs the wallet and data whenever the
 * window regains focus or the tab becomes visible. Returns the boot status for the first load.
 */
export function useAppData(): { status: BootStatus; error: string | null; retry: () => void } {
  const userId = useAuthStore((state) => state.session?.user.id ?? null);
  const [status, setStatus] = useState<BootStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const lastRefresh = useRef(0);

  useEffect(() => {
    if (userId === null) return;
    let cancelled = false;
    setStatus('loading');
    void bootstrap(userId).then((problem) => {
      if (cancelled) return;
      lastRefresh.current = Date.now();
      setError(problem);
      setStatus(problem === null ? 'ready' : 'error');
    });
    return () => {
      cancelled = true;
    };
  }, [userId, attempt]);

  useEffect(() => {
    if (status !== 'ready') return;
    function refreshIfStale(): void {
      const now = Date.now();
      if (now - lastRefresh.current < FOCUS_REFRESH_MIN_GAP_MS) return;
      lastRefresh.current = now;
      void refreshAll().then((failures) => {
        if (failures.length === 0) return;
        console.warn('Refresh failed:', failures);
        // Fixed id so repeated failures show one toast, not a stack.
        toast.error("Couldn't refresh. You may be looking at older data.", { id: STALE_TOAST_ID });
      });
    }
    // A tab brought back from the background fires visibilitychange, not always focus.
    function onVisibilityChange(): void {
      if (document.visibilityState === 'visible') refreshIfStale();
    }
    window.addEventListener('focus', refreshIfStale);
    document.addEventListener('visibilitychange', onVisibilityChange);
    // The Android WebView does not reliably report either of those when the app is brought back.
    const stopResume = subscribeAppResume(refreshIfStale);
    return () => {
      stopResume();
      window.removeEventListener('focus', refreshIfStale);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [status]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  // Launched offline (an autostart before the network is up): load as soon as it comes back
  // instead of waiting for a manual retry, so the alarm schedule gets refreshed.
  useEffect(() => {
    if (status !== 'error') return;
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [status, retry]);

  return { status, error, retry };
}
