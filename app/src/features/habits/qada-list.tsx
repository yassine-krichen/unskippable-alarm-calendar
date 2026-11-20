import { PRAYER_LABELS, type PrayerLogEntry } from '@alarm-calendar/core';
import { useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { insertQadaCompletion } from '@/features/completions/completions-api';
import { formatDay } from '@/lib/zoned-time';

import type { HabitCompletionRow } from './habits-api';
import { loadHabitCompletions, upsertHabitCompletion } from './habits-store';
import { usePrayerLog } from './use-prayer-log';

/**
 * The prayers of the last four weeks whose time ran out unprayed, each with a button to say it was made up. A made-up
 * prayer counts at half credit and keeps the day streak alive; the miss it repairs stops weighing double. Only the
 * prayers you really missed belong here: the button writes a completion, there is no undo in the app.
 */
export function QadaList() {
  const log = usePrayerLog();
  const [working, setWorking] = useState<string | null>(null);

  if (log === null) return null;
  // Most recent first: the one you can still remember is the one to settle.
  const open = log.filter((entry) => entry.tier === 'missed').reverse();

  async function madeUp(entry: PrayerLogEntry): Promise<void> {
    const key = `${entry.eventId}@${entry.at.toISOString()}`;
    setWorking(key);
    const result = await insertQadaCompletion(entry.eventId, entry.at.toISOString());
    setWorking(null);
    if (result.error !== null) {
      toast.error("Couldn't save that. Qada needs a connection, try again when you're online.");
      return;
    }
    if (result.data === null) {
      // A row was already there (another device got there first): show what the server holds.
      toast.info('That prayer already has a record. Showing the latest.');
      void loadHabitCompletions();
      return;
    }
    upsertHabitCompletion(result.data as HabitCompletionRow);
    toast.success(`${PRAYER_LABELS[entry.prayer]} marked as made up`);
  }

  return (
    <section aria-label="Prayers to make up" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-medium">Qada</h4>
        <Badge variant={open.length > 0 ? 'secondary' : 'outline'}>{open.length}</Badge>
      </div>
      {open.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing to make up from the last four weeks.</p>
      ) : (
        <>
          <ul className="flex flex-col divide-y rounded-lg border">
            {open.map((entry) => {
              const key = `${entry.eventId}@${entry.at.toISOString()}`;
              return (
                <li key={key} className="flex items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {PRAYER_LABELS[entry.prayer]}, {formatDay(entry.day)}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={working !== null}
                    aria-label={`Mark ${PRAYER_LABELS[entry.prayer]} of ${formatDay(entry.day)} as made up`}
                    onClick={() => void madeUp(entry)}
                  >
                    Made up
                  </Button>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-muted-foreground">
            A device that was offline may still hold a Prayed for one of these. Whichever reaches the server first is kept.
          </p>
        </>
      )}
    </section>
  );
}
