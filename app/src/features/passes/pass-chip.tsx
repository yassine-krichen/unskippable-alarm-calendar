import { TicketIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useSettingsStore } from '@/features/settings/settings-store';

import { nextPassLabel, passChipLabel } from './pass-status';
import { usePassesStore } from './passes-store';

interface PassChipProps {
  onOpen: () => void;
}

/** Header chip: how many cheat passes are left and when the next one arrives. */
export function PassChip({ onOpen }: PassChipProps) {
  const wallet = usePassesStore((state) => state.wallet);
  const cap = useSettingsStore((state) => state.settings?.pass_cap);

  if (wallet === null || cap === undefined) {
    return <Skeleton className="h-8 w-24" />;
  }

  return (
    <div className="flex flex-col items-end">
      <Button variant="outline" onClick={onOpen} aria-label={`${passChipLabel(wallet.balance, cap)}. Open cheat passes`}>
        <TicketIcon data-icon="inline-start" />
        <span className="tabular-nums">{passChipLabel(wallet.balance, cap)}</span>
      </Button>
      <span className="mt-0.5 hidden text-xs text-muted-foreground sm:block">{nextPassLabel(wallet, cap)}</span>
    </div>
  );
}
