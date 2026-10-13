import {
  AlarmClockIcon,
  BatteryChargingIcon,
  BellIcon,
  CheckIcon,
  LayersIcon,
  PowerIcon,
  SmartphoneNfcIcon,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

import type { PermissionRow, PermissionRowKind } from './permission-model';
import { openPermissionScreen } from './permissions-store';

const ICONS: Record<PermissionRowKind, LucideIcon> = {
  notifications: BellIcon,
  fullScreenIntent: SmartphoneNfcIcon,
  exactAlarm: AlarmClockIcon,
  batteryOptimization: BatteryChargingIcon,
  autostart: PowerIcon,
  lockScreen: SmartphoneNfcIcon,
  backgroundPopup: LayersIcon,
};

async function open(kind: PermissionRowKind): Promise<void> {
  const problem = await openPermissionScreen(kind);
  if (problem !== null) toast.error(problem);
}

function StateBadge({ row }: { row: PermissionRow }) {
  if (row.state === 'granted') {
    return (
      <Badge variant="secondary">
        <CheckIcon data-icon="inline-start" />
        On
      </Badge>
    );
  }
  if (row.state === 'check') return <Badge variant="outline">Check manually</Badge>;
  return row.required ? <Badge variant="destructive">Needed</Badge> : <Badge variant="secondary">Recommended</Badge>;
}

interface PermissionListProps {
  rows: readonly PermissionRow[];
  /** The dialog lists what still needs attention and leaves granted rows out; Settings lists everything. */
  buttonOnGranted: boolean;
}

/** One row per permission: what it is for in a line, its state, and the button that opens the matching system screen. */
export function PermissionList({ rows, buttonOnGranted }: PermissionListProps) {
  return (
    <ul className="flex flex-col divide-y rounded-lg border">
      {rows.map((row) => {
        const Icon = ICONS[row.kind];
        const showButton = row.state !== 'granted' || buttonOnGranted;
        return (
          <li key={row.kind} className="flex items-center gap-3 p-3">
            <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium">{row.title}</span>
                <StateBadge row={row} />
              </div>
              <p className="text-sm text-muted-foreground">{row.why}</p>
            </div>
            {showButton ? (
              <Button
                variant={row.state === 'denied' && row.required ? 'default' : 'outline'}
                className="h-11 shrink-0 px-3"
                aria-label={`${row.state === 'denied' ? 'Allow' : 'Open settings for'} ${row.title}`}
                onClick={() => void open(row.kind)}
              >
                {row.state === 'denied' ? 'Allow' : 'Open'}
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
