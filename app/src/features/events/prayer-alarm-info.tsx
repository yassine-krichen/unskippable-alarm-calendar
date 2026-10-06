import type { EventRow } from '@alarm-calendar/core';
import { SettingsIcon } from 'lucide-react';
import { useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';
import { EventRank } from '@/features/habits/event-rank';
import { useSettingsStore } from '@/features/settings/settings-store';

interface PrayerAlarmInfoProps {
  event: EventRow;
  onDone: () => void;
}

/**
 * What a prayer alarm shows instead of the event form. Its time comes from the prayer times and its
 * snooze rules and sound from the Prayer times settings, so there is nothing to edit on the alarm
 * itself; the one useful action is going to where it is edited.
 */
export function PrayerAlarmInfo({ event, onDone }: PrayerAlarmInfoProps) {
  const navigate = useNavigate();
  const settings = useSettingsStore((state) => state.settings);
  const isPrayer = event.kind === 'prayer';
  const maxSnoozes = settings?.prayer_max_snoozes ?? 0;
  const snoozeMinutes = settings?.prayer_snooze_minutes ?? 5;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">
      {isPrayer ? <EventRank eventId={event.id} /> : null}
      <dl className="flex flex-col gap-3 text-sm">
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">When</dt>
          <dd>
            {isPrayer
              ? 'At the calculated prayer time, every day.'
              : 'Before the prayer, by the reminder time in your prayer settings.'}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">Snooze</dt>
          <dd>{maxSnoozes === 0 ? 'No snooze: you have to answer on the spot.' : `${maxSnoozes} times, ${snoozeMinutes} minutes each.`}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">Cheat days</dt>
          <dd>Never silenced.</dd>
        </div>
      </dl>
      <div className="mt-auto flex flex-col gap-2 border-t pt-4">
        <p className="text-sm text-muted-foreground">
          Location, calculation method, offsets, reminders, snooze and sound are set for all prayers together.
        </p>
        <Button
          onClick={() => {
            onDone();
            navigate('/settings');
          }}
        >
          <SettingsIcon data-icon="inline-start" />
          Open prayer settings
        </Button>
      </div>
    </div>
  );
}
