import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { subscribeAppResume } from '@/lib/app-resume';

import { PermissionList } from './permission-list';
import {
  checkPermissions,
  dismissPermissionDialog,
  isDialogOpen,
  usePermissionsStore,
} from './permissions-store';

/** Android only: checks the permissions on launch and every time the app comes back. */
export function usePermissionChecks(): void {
  useEffect(() => {
    void checkPermissions('launch');
    return subscribeAppResume(() => void checkPermissions('resume'));
  }, []);
}

/**
 * Opens on launch and on resume while an alarm could fail to appear. Notifications and full-screen
 * alarms are required: with either missing the dialog has no way out except granting it (no close
 * button, Escape and the Android back button do nothing). When only the optional ones are missing,
 * "Remind me later" closes it until the next launch (or an hour), and the warning chip stays.
 */
export function PermissionDialog() {
  const open = usePermissionsStore(isDialogOpen);
  const summary = usePermissionsStore((state) => state.summary);
  if (summary === null) return null;

  const { blocking } = summary;
  // What still needs doing; a granted row only reappears in Settings.
  const rows = summary.rows.filter((row) => row.state !== 'granted');

  return (
    <Dialog
      open={open}
      disablePointerDismissal={blocking}
      onOpenChange={(next) => {
        if (!next && !blocking) dismissPermissionDialog();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={`max-h-[calc(100dvh-4rem)] ${blocking ? 'grid-rows-[auto_minmax(0,1fr)]' : 'grid-rows-[auto_minmax(0,1fr)_auto]'}`}
      >
        <DialogHeader>
          <DialogTitle>{blocking ? 'Allow these so your alarms can ring' : 'A few settings could stop an alarm'}</DialogTitle>
          <DialogDescription>
            {blocking
              ? 'Notifications and full-screen alarms are needed. Without them an alarm can ring with no screen to turn it off.'
              : 'Your alarms will work, but these make them more reliable. Each button opens one settings screen; come back here after.'}
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-1 overflow-y-auto px-1">
          <PermissionList rows={rows} buttonOnGranted={false} />
        </div>
        {blocking ? null : (
          <DialogFooter>
            <Button variant="outline" className="h-11" onClick={dismissPermissionDialog}>
              Remind me later
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
