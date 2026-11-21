import { ChevronRightIcon, GraduationCapIcon, InfoIcon, SettingsIcon, ShieldAlertIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { Badge } from '@/components/ui/badge';
import { ModeIcon } from '@/features/modes/mode-icon';
import { NORMAL_LABEL } from '@/features/modes/mode-meta';
import { currentMode } from '@/features/modes/mode-status';
import { useModeTimeline } from '@/features/modes/use-modes';
import { showPermissionDialog, usePermissionsStore } from '@/features/permissions/permissions-store';
import { useSettingsStore } from '@/features/settings/settings-store';
import { useUpdateStore } from '@/features/updates/update-store';
import { useNow } from '@/hooks/use-now';
import { hapticSelection } from '@/lib/haptics';
import { detectPlatform } from '@/lib/platform';

import { PageHeader } from './page-header';

const ROW =
  'flex min-h-14 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50';

interface RowBodyProps {
  icon: LucideIcon | null;
  label: string;
  value?: ReactNode;
}

function RowBody({ icon: Icon, label, value }: RowBodyProps) {
  return (
    <>
      {Icon !== null ? <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
      <span className="min-w-0 flex-1 font-medium">{label}</span>
      {value !== undefined ? <span className="flex shrink-0 items-center gap-2 text-muted-foreground">{value}</span> : null}
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </>
  );
}

/** The fourth tab: the screens that are not part of the day-to-day loop. */
export function MorePage() {
  const settings = useSettingsStore((state) => state.settings);
  const timeline = useModeTimeline();
  const now = useNow();
  const summary = usePermissionsStore((state) => state.summary);
  const installed = useUpdateStore((state) => state.installedVersion);
  const updateAvailable = useUpdateStore((state) => state.latest !== null);
  const mode = settings === null ? null : currentMode(timeline, now, settings.timezone);
  // The guided dialog only opens when something needs attention, so the row appears only then.
  const permissionsToFix = detectPlatform() === 'android' && summary?.needsAttention === true ? summary.deniedCount : null;

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-var(--tab-bar-h,0px))] w-full max-w-2xl flex-col">
      <PageHeader title="More" tabRoot />
      <main className="flex flex-col gap-1 px-2 py-3">
        <Link to="/exams" className={ROW} onClick={hapticSelection}>
          <RowBody icon={GraduationCapIcon} label="Exams" />
        </Link>
        <Link to="/modes" className={ROW} onClick={hapticSelection}>
          <ModeIcon of={mode?.mode ?? null} className="size-5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 font-medium">Modes</span>
          <span className="max-w-32 shrink-0 truncate text-muted-foreground">{mode?.mode.name ?? NORMAL_LABEL}</span>
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Link>
        <Link to="/settings" className={ROW} onClick={hapticSelection}>
          <RowBody icon={SettingsIcon} label="Settings" />
        </Link>
        {permissionsToFix !== null ? (
          <button type="button" className={ROW} onClick={showPermissionDialog}>
            <RowBody
              icon={ShieldAlertIcon}
              label="Alarm permissions"
              value={<Badge variant="destructive">{permissionsToFix} to fix</Badge>}
            />
          </button>
        ) : null}
        <Link to="/about" className={ROW} onClick={hapticSelection}>
          <RowBody
            icon={InfoIcon}
            label="About and updates"
            value={
              <>
                {updateAvailable ? <Badge>Update available</Badge> : null}
                <span className="tabular-nums">{installed ?? __APP_VERSION__}</span>
              </>
            }
          />
        </Link>
      </main>
    </div>
  );
}
