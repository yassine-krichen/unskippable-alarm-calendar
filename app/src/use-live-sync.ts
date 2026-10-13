import { useEffect } from 'react';

import { startCompletionSync } from '@/features/alarm-adapter/completion-sync';
import { getAlarmAdapter } from '@/features/alarm-adapter/create-alarm-adapter';
import { startScheduleSync } from '@/features/alarm-adapter/schedule-sync';
import { startSessionSync } from '@/features/alarm-adapter/session-sync';
import { useAuthStore } from '@/features/auth/auth-store';
import { startCatchUpSync } from '@/features/exams/catch-up-sync';
import { loadExamData } from '@/features/exams/exams-store';
import { startHabitHistorySync } from '@/features/habits/habits-store';
import { startRealtime } from '@/features/realtime/realtime';
import { parseEnv } from '@/lib/env';
import { detectPlatform } from '@/lib/platform';
import { supabase } from '@/lib/supabase';

import { refreshAll } from './bootstrap';

/**
 * Desktop only: hands the Supabase session to the Electron main process so it can write
 * completions made while this window is closed or the network was down. Runs for the whole app
 * lifetime, signed in or not, because sign-in, token refresh and sign-out all matter to main.
 */
export function useDesktopSession(): void {
  useEffect(() => {
    const bridge = window.desktopApi;
    if (detectPlatform() !== 'electron' || bridge === undefined) return;
    const env = parseEnv(import.meta.env);
    return startSessionSync(bridge, { url: env.VITE_SUPABASE_URL, publishableKey: env.VITE_SUPABASE_PUBLISHABLE_KEY });
  }, []);
}

/**
 * Android only: moves the completions made on the alarm screen (also while the app was closed) to
 * Supabase. Needs only the session, not the first data load, so a Done made offline is uploaded
 * as soon as the phone has network again even when the calendar itself could not load.
 */
export function useCompletionSync(): void {
  const userId = useAuthStore((state) => state.session?.user.id ?? null);

  useEffect(() => {
    if (userId === null || detectPlatform() !== 'android') return;
    return startCompletionSync();
  }, [userId]);
}

/**
 * Once the first load finished: push the schedule to the platform alarm engine and keep it
 * current from the stores, and subscribe to realtime changes so another device's edits, passes
 * and completions reach this one while the app is open. Also starts the check that gives a missed revision
 * session its catch-up.
 */
export function useLiveSync(ready: boolean): void {
  const userId = useAuthStore((state) => state.session?.user.id ?? null);

  useEffect(() => {
    if (!ready || userId === null) return;
    const stopSchedule = startScheduleSync({ adapter: getAlarmAdapter() });
    const stopHabitHistory = startHabitHistorySync();
    // Not blocking, and not left to the realtime catch-up: if the channel never subscribes the Exams screen
    // would otherwise wait forever.
    void loadExamData();
    const stopCatchUps = startCatchUpSync();
    const stopRealtime = startRealtime(supabase, userId, () => {
      // After every (re)subscribe, catch up on whatever changed while the socket was not up.
      void refreshAll();
    });
    return () => {
      stopRealtime();
      stopCatchUps();
      stopHabitHistory();
      stopSchedule();
    };
  }, [ready, userId]);
}
