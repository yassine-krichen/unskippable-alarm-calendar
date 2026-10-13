import { App } from '@capacitor/app';

import { detectPlatform } from '@/lib/platform';

/**
 * Calls `callback` when the Android app comes back to the front (the activity's onResume). The
 * WebView's own focus and visibility events are not reliable there, so everything that must catch
 * up after the phone was away (the data refresh, the schedule push, the completion upload, the
 * permission check) listens here as well. Does nothing elsewhere; returns the unsubscribe function.
 */
export function subscribeAppResume(callback: () => void): () => void {
  if (detectPlatform() !== 'android') return () => undefined;
  const handle = App.addListener('resume', callback);
  return () => {
    void handle.then((listener) => listener.remove());
  };
}
