import { useEffect } from 'react';

import { subscribeAppResume } from '@/lib/app-resume';

import { updateSourceForPlatform } from './update-sources';
import {
  checkForUpdates,
  continueAfterPermission,
  loadUpdateState,
  restoreDownloadedUpdate,
  runAutoUpdateCheck,
} from './update-store';

/** The "Check now" button: ignores the 24 hour limit and tells the person how it went. */
export async function checkForUpdatesNow(): Promise<void> {
  const source = updateSourceForPlatform();
  if (source !== null) await checkForUpdates(source, true);
}

/**
 * Looks for a new release when the signed-in app opens and each time it comes back to the front (Android resume,
 * desktop window focus), at most once per 24 hours (see runAutoUpdateCheck). Also finishes an Install that was waiting
 * on the "install unknown apps" screen. Does nothing in the browser.
 */
export function useUpdateAutoCheck(): void {
  useEffect(() => {
    const source = updateSourceForPlatform();
    if (source === null) return;

    let active = true;
    const check = (): void => {
      if (active) void runAutoUpdateCheck(source);
    };
    void (async () => {
      await loadUpdateState(source);
      // A download that finished before the app was killed is picked up again before anything else starts.
      if (source.platform === 'android') await restoreDownloadedUpdate();
      check();
    })();

    const stopResume = subscribeAppResume(() => {
      check();
      void continueAfterPermission();
    });
    if (source.platform === 'electron') window.addEventListener('focus', check);
    return () => {
      active = false;
      stopResume();
      window.removeEventListener('focus', check);
    };
  }, []);
}
