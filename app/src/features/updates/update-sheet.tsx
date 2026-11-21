import { DownloadIcon, ExternalLinkIcon, RefreshCwIcon } from 'lucide-react';

import { ResponsiveSheet } from '@/components/responsive-sheet';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress';
import { detectPlatform } from '@/lib/platform';

import { downloadUpdate, installUpdate, useUpdateStore } from './update-store';
import { downloadPercent, formatMegabytes } from './update-view';

interface UpdateSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The new version's notes and the one action for this shell: download and install (Android) or open the release page (desktop). */
export function UpdateSheet({ open, onOpenChange }: UpdateSheetProps) {
  const latest = useUpdateStore((state) => state.latest);
  const installed = useUpdateStore((state) => state.installedVersion);
  const phase = useUpdateStore((state) => state.phase);
  const progress = useUpdateStore((state) => state.progress);
  const error = useUpdateStore((state) => state.error);
  const waiting = useUpdateStore((state) => state.waitingForInstallPermission);
  const platform = detectPlatform();

  if (latest === null) return null;

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={`Update ${latest.version}`}
      description={installed === null ? 'A newer version is available.' : `You have ${installed}.`}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        {latest.notes.trim() === '' ? (
          <p className="text-sm text-muted-foreground">No release notes.</p>
        ) : (
          // Plain text on purpose: release notes are never rendered as markdown or HTML.
          <p className="max-h-64 overflow-y-auto text-sm whitespace-pre-wrap">{latest.notes}</p>
        )}

        {error !== null ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {phase === 'downloading' ? (
          <Progress value={downloadPercent(progress)} aria-label="Download progress">
            <ProgressLabel>Downloading</ProgressLabel>
            <ProgressValue />
          </Progress>
        ) : null}

        {waiting ? (
          <p role="status" className="text-sm text-muted-foreground">
            Allow Alarm Calendar to install apps on the screen that just opened, then come back. The install continues by itself.
          </p>
        ) : null}

        {platform === 'android' ? <AndroidActions /> : <DesktopActions />}
      </div>
    </ResponsiveSheet>
  );
}

function AndroidActions() {
  const latest = useUpdateStore((state) => state.latest);
  const phase = useUpdateStore((state) => state.phase);

  if (latest?.android == null) {
    return <p className="text-sm text-muted-foreground">This release has no Android download yet.</p>;
  }
  if (phase === 'ready') {
    return (
      <div className="flex flex-col gap-2 pb-[env(safe-area-inset-bottom)]">
        <Button onClick={() => void installUpdate()}>
          <RefreshCwIcon data-icon="inline-start" />
          Install
        </Button>
        <p className="text-sm text-muted-foreground">
          Android asks you to confirm. Alarm Calendar restarts and your alarms stay scheduled.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 pb-[env(safe-area-inset-bottom)]">
      <Button disabled={phase !== 'idle'} onClick={() => void downloadUpdate()}>
        <DownloadIcon data-icon="inline-start" />
        Download ({formatMegabytes(latest.android.sizeBytes)})
      </Button>
    </div>
  );
}

function DesktopActions() {
  return (
    <div className="flex flex-col gap-2">
      <Button onClick={() => void window.desktopApi?.openReleasePage()}>
        <ExternalLinkIcon data-icon="inline-start" />
        Open release page
      </Button>
      <p className="text-sm text-muted-foreground">
        Download the installer there and run it. Windows may warn about an unknown publisher (More info, then Run anyway).
        If it asks to close Alarm Calendar, finish any ringing or snoozed alarm first: Quit is refused until then.
      </p>
    </div>
  );
}
