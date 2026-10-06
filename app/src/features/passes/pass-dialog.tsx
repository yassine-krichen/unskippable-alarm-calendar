import { TicketIcon, Undo2Icon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { dayImpact } from '@/features/calendar/calendar-events';
import { useEventsStore } from '@/features/events/events-store';
import { useModeTimeline } from '@/features/modes/use-modes';
import { useSettingsStore } from '@/features/settings/settings-store';
import { dateFromString, formatDay, pickerWeekStart, stringFromDate } from '@/lib/zoned-time';

import { passErrorMessage } from './pass-errors';
import { nextPassLabel, passChipLabel } from './pass-status';
import { refundPassOnDay, spendPassOnDay, usePassesStore } from './passes-store';
import { usePassToday } from './use-pass-today';

interface PassDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Spend a pass on a day, see what it silences, and undo upcoming cheat days. */
export function PassDialog({ open, onOpenChange }: PassDialogProps) {
  const settings = useSettingsStore((state) => state.settings);
  const wallet = usePassesStore((state) => state.wallet);
  const cheatDays = usePassesStore((state) => state.cheatDays);
  const events = useEventsStore((state) => state.events);
  const modeTimeline = useModeTimeline();
  const today = usePassToday();

  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const cheatDayDates = useMemo(() => cheatDays.map(dateFromString), [cheatDays]);
  const upcoming = useMemo(() => (today === null ? [] : cheatDays.filter((day) => day >= today)), [cheatDays, today]);
  const impact = useMemo(
    () => (selected !== null && settings ? dayImpact(events, selected, settings, new Date(), modeTimeline) : null),
    [events, selected, settings, modeTimeline]
  );

  if (!settings || !wallet || today === null) return null;

  const noPassesLeft = wallet.balance <= 0;

  async function onSpend(): Promise<void> {
    if (selected === null) return;
    setPending('spend');
    const result = await spendPassOnDay(selected);
    setPending(null);
    if (result.error !== null) {
      toast.error(passErrorMessage(result.error));
      return;
    }
    const left = result.data.balance;
    toast.success(`Cheat day set for ${formatDay(selected)}. ${left} ${left === 1 ? 'pass' : 'passes'} left.`);
    setSelected(null);
  }

  async function onUndo(day: string): Promise<void> {
    setPending(day);
    const result = await refundPassOnDay(day);
    setPending(null);
    if (result.error !== null) {
      toast.error(passErrorMessage(result.error));
      return;
    }
    toast.success(`Pass refunded. ${formatDay(day)} is a normal day again.`);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cheat passes</DialogTitle>
          <DialogDescription>
            A pass turns one day into a cheat day. Alarms marked "cheat day can skip this" stay silent
            that day. Everything else still rings.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 text-sm">
          <TicketIcon className="size-4" />
          <span className="font-medium tabular-nums">{passChipLabel(wallet.balance, settings.pass_cap)}</span>
          <span className="text-muted-foreground">{nextPassLabel(wallet, settings.pass_cap)}</span>
        </div>

        {noPassesLeft ? (
          <Alert>
            <TicketIcon />
            <AlertTitle>No passes left</AlertTitle>
            <AlertDescription>
              {nextPassLabel(wallet, settings.pass_cap)}. You can still undo an upcoming cheat day below to get
              its pass back.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-col items-center gap-3">
          <Calendar
            mode="single"
            selected={selected === null ? undefined : dateFromString(selected)}
            onSelect={(date) => setSelected(date ? stringFromDate(date) : null)}
            defaultMonth={dateFromString(today)}
            weekStartsOn={pickerWeekStart(settings.week_starts_on)}
            disabled={[{ before: dateFromString(today) }, ...cheatDayDates]}
            modifiers={{ cheat: cheatDayDates }}
            modifiersClassNames={{ cheat: 'cheat-day' }}
            className="rounded-lg border"
          />
          <p aria-live="polite" className="min-h-10 text-center text-sm text-muted-foreground">
            {selected === null || impact === null ? (
              'Pick today or a later day. Days with hatching are already cheat days.'
            ) : (
              <>
                <span className="font-medium text-foreground">
                  This silences {impact.silenced} {impact.silenced === 1 ? 'event' : 'events'}
                </span>{' '}
                on {formatDay(selected)}.
                {impact.stillRing > 0
                  ? ` ${impact.stillRing} more will still ring because ${impact.stillRing === 1 ? 'it is' : 'they are'} set to always ring.`
                  : ''}
              </>
            )}
          </p>
        </div>

        <Button
          size="lg"
          onClick={() => void onSpend()}
          disabled={selected === null || noPassesLeft || pending !== null}
        >
          {selected === null ? 'Use a pass' : `Use a pass on ${formatDay(selected)}`}
        </Button>

        <Separator />

        <section aria-labelledby="upcoming-cheat-days" className="flex flex-col gap-2">
          <h3 id="upcoming-cheat-days" className="text-sm font-medium">
            Upcoming cheat days
          </h3>
          {upcoming.length === 0 ? (
            <p className="text-sm text-muted-foreground">None yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {upcoming.map((day) => {
                const isToday = day === today;
                return (
                  <li key={day} className="flex items-center gap-2 rounded-md px-2 py-1">
                    <span className="text-sm">{formatDay(day, { year: true })}</span>
                    {isToday ? <Badge variant="secondary">Today</Badge> : null}
                    <div className="ml-auto">
                      {isToday ? (
                        <span className="text-xs text-muted-foreground">Can't be undone once the day has begun</span>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending !== null}
                          onClick={() => void onUndo(day)}
                        >
                          <Undo2Icon data-icon="inline-start" />
                          Undo
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}
