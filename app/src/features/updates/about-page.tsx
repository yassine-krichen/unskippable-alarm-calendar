import { DownloadIcon, RefreshCwIcon } from 'lucide-react';
import { useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { PageHeader } from '@/features/app-shell/page-header';
import { detectPlatform } from '@/lib/platform';

import { UpdateSheet } from './update-sheet';
import { checkForUpdatesNow } from './use-update-check';
import { useUpdateStore } from './update-store';
import { lastCheckedLabel } from './update-view';

/** About and updates: the installed version, when it last looked, "Check now", and the update when there is one. */
export function AboutPage() {
  const installed = useUpdateStore((state) => state.installedVersion);
  const latest = useUpdateStore((state) => state.latest);
  const phase = useUpdateStore((state) => state.phase);
  const checkedAt = useUpdateStore((state) => state.checkedAt);
  const upToDate = useUpdateStore((state) => state.upToDate);
  const error = useUpdateStore((state) => state.error);
  const [sheetOpen, setSheetOpen] = useState(false);
  const canCheck = detectPlatform() !== 'web';

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col">
      <PageHeader title="About and updates" backTo="/settings" backLabel="Back to settings" />

      <main className="flex flex-col gap-6 px-4 py-6 sm:px-6">
        <section aria-labelledby="about-version" className="flex flex-col gap-1">
          <h2 id="about-version" className="text-sm text-muted-foreground">
            Installed version
          </h2>
          <p className="text-2xl font-semibold tabular-nums">{installed ?? __APP_VERSION__}</p>
        </section>

        {canCheck ? (
          <section aria-labelledby="about-updates" className="flex flex-col gap-3">
            <h2 id="about-updates" className="text-sm text-muted-foreground">
              Updates
            </h2>
            {latest !== null ? (
              <Alert>
                <DownloadIcon />
                <AlertDescription className="flex flex-col items-start gap-2">
                  Version {latest.version} is available.
                  <Button onClick={() => setSheetOpen(true)}>See what's new</Button>
                </AlertDescription>
              </Alert>
            ) : upToDate ? (
              <p role="status" className="text-sm">
                You're up to date.
              </p>
            ) : null}
            {error !== null ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" disabled={phase !== 'idle'} onClick={() => void checkForUpdatesNow()}>
                {phase === 'checking' ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
                Check now
              </Button>
              <p className="text-sm text-muted-foreground">{lastCheckedLabel(checkedAt, Date.now())}. It looks again once a day on its own.</p>
            </div>
          </section>
        ) : (
          <p className="text-sm text-muted-foreground">Updates are checked in the Android and desktop apps.</p>
        )}
      </main>

      <UpdateSheet open={sheetOpen} onOpenChange={setSheetOpen} />
    </div>
  );
}
