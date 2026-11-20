import type { CantNowChoice, PrayerChoices as PrayerChoicesData } from '@alarm-calendar/core';

import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface PrayerChoicesProps {
  prayer: string;
  choices: PrayerChoicesData;
  busy: boolean;
  onLater(minutes: number): void;
  /** Gets the variant that was on the button, so the engine can refuse a press the clock has since made stale. */
  onCantNow(shown: CantNowChoice): void;
}

/**
 * What a prayer offers besides Prayed: put it off for a while (Later, only the options that still end before the
 * prayer's time does), or say it can't be done right now. "Can't now" waits for the last call; once it is that
 * late it says so and ends the alarm, and the prayer can be made up afterwards. The line under the buttons says
 * when the prayer's time ends, so the choices are never blind.
 */
export function PrayerChoices({ prayer, choices, busy, onLater, onCantNow }: PrayerChoicesProps) {
  const giveUp = choices.cantNow === 'give_up';
  return (
    <>
      {choices.laterMinutes.length > 0 ? (
        <ButtonGroup className="w-full" aria-label="Pray later">
          {choices.laterMinutes.map((minutes) => (
            <Button
              key={minutes}
              size="lg"
              variant="outline"
              disabled={busy}
              onClick={() => onLater(minutes)}
              className="h-12 flex-1 text-base font-semibold"
            >
              +{minutes} min
            </Button>
          ))}
        </ButtonGroup>
      ) : null}
      <Button
        size="lg"
        variant="outline"
        disabled={busy}
        onClick={() => onCantNow(choices.cantNow)}
        className="h-12 w-full text-base font-semibold"
      >
        {giveUp ? "Can't pray in time" : `Can't now · last call ${formatTime(choices.lastCallAt)}`}
      </Button>
      <p className="text-base text-neutral-400">
        {prayer} time ends {formatTime(choices.windowEnd)}
      </p>
    </>
  );
}
