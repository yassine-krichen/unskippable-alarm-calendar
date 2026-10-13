import { TriangleAlertIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';

import { showPermissionDialog, usePermissionsStore } from './permissions-store';

/**
 * The persistent reminder after "Remind me later": shown while something is not allowed, and a tap
 * brings the dialog back. Renders nothing when everything is fine and off Android, where nothing is read.
 */
export function PermissionChip() {
  const summary = usePermissionsStore((state) => state.summary);
  if (summary === null || !summary.needsAttention) return null;
  const count = summary.deniedCount;
  return (
    <div className="shrink-0 px-4 pb-2 sm:px-6">
      <Button
        variant="destructive"
        className="h-10 w-full justify-start"
        onClick={showPermissionDialog}
        aria-label={`${count} alarm ${count === 1 ? 'setting needs' : 'settings need'} attention. Open the list`}
      >
        <TriangleAlertIcon data-icon="inline-start" />
        Alarms may not ring: {count} {count === 1 ? 'setting' : 'settings'} to fix
      </Button>
    </div>
  );
}
