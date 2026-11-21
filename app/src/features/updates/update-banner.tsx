import { DownloadIcon, XIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

import { UpdateSheet } from './update-sheet';
import { dismissUpdateBanner, isBannerVisible, useUpdateStore } from './update-store';

/** A dismissible "Update x.y.z available" row. Dismissing hides it until a newer version comes out. */
export function UpdateBanner() {
  const latest = useUpdateStore((state) => state.latest);
  const visible = useUpdateStore(isBannerVisible);
  const [open, setOpen] = useState(false);

  if (latest === null || !visible) return null;
  return (
    <div className="shrink-0 px-4 pb-2 sm:px-6">
      <div role="status" className="flex items-center gap-2 rounded-lg border bg-card py-1 pr-1 pl-3 text-sm">
        <DownloadIcon className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">Update {latest.version} available</span>
        <Button variant="outline" onClick={() => setOpen(true)}>
          View
        </Button>
        <Button variant="ghost" size="icon" aria-label="Dismiss the update notice" onClick={dismissUpdateBanner}>
          <XIcon />
        </Button>
      </div>
      <UpdateSheet open={open} onOpenChange={setOpen} />
    </div>
  );
}
