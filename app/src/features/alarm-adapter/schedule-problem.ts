import { toast } from 'sonner';

import { detectPlatform } from '@/lib/platform';

const message = (device: string): string => `Some alarms couldn't be scheduled on this ${device}`;

/**
 * Tells the user once per session that the desktop engine refused part of the schedule (or all
 * of it). Once, because the same bad row would otherwise toast on every push. The details are in
 * the desktop app's log; the user's next step is to look at the event that is not ringing.
 */
export function createScheduleProblemReporter(notify: (message: string) => void, device = 'PC'): () => void {
  let reported = false;
  return () => {
    if (reported) return;
    reported = true;
    notify(message(device));
  };
}

let sharedReporter: (() => void) | null = null;

/** Built on first use because the platform is only known once the page is running. */
export function reportScheduleProblem(): void {
  sharedReporter ??= createScheduleProblemReporter(
    (text) => {
      toast.error(text, { description: 'Open the event list and check the ones that do not ring.' });
    },
    detectPlatform() === 'android' ? 'phone' : 'PC'
  );
  sharedReporter();
}

let completionProblemReported = false;

/**
 * A completed alarm that the server refused for good was dropped (Android; the desktop flusher only logs it).
 * Once per session, for the same reason as the schedule problem: the same row would otherwise toast every minute.
 */
export function reportCompletionProblem(): void {
  if (completionProblemReported) return;
  completionProblemReported = true;
  toast.error("A finished alarm couldn't be saved to your account", {
    description: 'It was marked done on this phone, but the server refused it.',
  });
}
