import { PlusIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * The phone layout's "New alarm": 56px, bottom right, just above the tab bar. Today and Calendar only; the
 * desktop layout has a "New alarm" button in its header instead.
 */
export function NewAlarmFab({ onClick }: { onClick: () => void }) {
  return (
    <Button
      className="fixed right-4 bottom-[calc(var(--tab-bar-h,0px)+1rem)] z-40 size-14 rounded-full shadow-lg [&_svg:not([class*='size-'])]:size-6"
      aria-label="New alarm"
      onClick={onClick}
    >
      <PlusIcon />
    </Button>
  );
}
