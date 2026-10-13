import type { CompletionRow } from '@alarm-calendar/core';

import { useAuthStore } from '@/features/auth/auth-store';
import { loadRecentCompletions } from '@/features/completions/completions-store';
import { subscribeAppResume } from '@/lib/app-resume';
import { supabase } from '@/lib/supabase';

import { classifyUploadFailure, flushCompletions, type CompletionSyncDeps, type UploadOutcome } from './completion-flush';
import { getAlarmAdapter } from './create-alarm-adapter';
import { reportCompletionProblem } from './schedule-problem';

// While the app is in front a Done pressed on the alarm screen is picked up within this long; a resume does not wait for it.
const FLUSH_INTERVAL_MS = 60_000;

export async function uploadToSupabase(row: CompletionRow): Promise<UploadOutcome> {
  try {
    const { error, status } = await supabase
      .from('completions')
      // First completion wins, like the desktop flusher: ON CONFLICT DO NOTHING, a duplicate counts as success.
      .upsert(row, { onConflict: 'event_id,occurrence_at', ignoreDuplicates: true });
    if (error === null) return { kind: 'ok' };
    return classifyUploadFailure(status, error.message, error.code);
  } catch (error) {
    return { kind: 'transient', reason: String(error) };
  }
}

function signedInUserId(): string | null {
  return useAuthStore.getState().session?.user.id ?? null;
}

/**
 * Android only. Flushes on start, whenever the app resumes, when the network comes back and every
 * minute while the app is open. A flush that is still running absorbs the triggers that arrive
 * meanwhile into one more pass. Returns the stop function.
 */
export function startCompletionSync(deps: Partial<CompletionSyncDeps> = {}): () => void {
  let loggedOtherUser = false;
  const full: CompletionSyncDeps = {
    adapter: getAlarmAdapter(),
    upload: uploadToSupabase,
    userId: signedInUserId,
    onUploaded: () => void loadRecentCompletions(),
    onRejected: reportCompletionProblem,
    log: (event, fields) => {
      // The rows of another account wait in the engine for as long as this one is signed in: say so once, not every minute.
      if (event === 'completions.other_user_rows_kept') {
        if (loggedOtherUser) return;
        loggedOtherUser = true;
      }
      console.info(event, fields ?? '');
    },
    ...deps,
  };
  let running = false;
  let again = false;

  const run = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        try {
          await flushCompletions(full);
        } catch (error) {
          // The rows stay in the engine; the next trigger tries again.
          console.warn('Could not upload completions:', error instanceof Error ? error.message : 'unknown');
        }
      } while (again);
    } finally {
      running = false;
    }
  };

  const onVisible = (): void => {
    if (document.visibilityState === 'visible') void run();
  };
  const onOnline = (): void => void run();
  const timer = setInterval(onVisible, FLUSH_INTERVAL_MS);
  const stopResume = subscribeAppResume(() => void run());
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisible);
  void run();
  return () => {
    clearInterval(timer);
    stopResume();
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
