import { toast } from 'sonner';

const MESSAGE = "Some alarms couldn't be scheduled on this PC";

/**
 * Tells the user once per session that the desktop engine refused part of the schedule (or all
 * of it). Once, because the same bad row would otherwise toast on every push. The details are in
 * the desktop app's log; the user's next step is to look at the event that is not ringing.
 */
export function createScheduleProblemReporter(notify: (message: string) => void): () => void {
  let reported = false;
  return () => {
    if (reported) return;
    reported = true;
    notify(MESSAGE);
  };
}

export const reportScheduleProblem = createScheduleProblemReporter((message) => {
  toast.error(message, { description: 'Open the event list and check the ones that do not ring.' });
});
