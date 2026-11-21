import type { ReactNode } from 'react';

import { SheetCloseHeader, revealFocusedField } from '@/components/responsive-sheet';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Drawer, DrawerContent } from '@/components/ui/drawer';
import { useIsDesktop } from '@/hooks/use-media-query';

interface ResponsiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** Classes for the desktop dialog's panel (its width, say); the phone drawer ignores them. */
  contentClassName?: string;
  children: ReactNode;
}

/**
 * A centered Dialog on desktop and a bottom Drawer on phones, for the short dialogs that are really small forms
 * (cheat passes, modes). The drawer scrolls its own body and keeps the header and its close button in view. A
 * dialog that blocks (the permission dialog) is deliberately not one of these: it cannot be swiped away.
 */
export function ResponsiveDialog({
  open,
  onOpenChange,
  title,
  description,
  contentClassName,
  children,
}: ResponsiveDialogProps) {
  const isDesktop = useIsDesktop();

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className={contentClassName}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {children}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} showSwipeHandle>
      <DrawerContent onFocusCapture={revealFocusedField}>
        <SheetCloseHeader title={title} description={description} />
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {children}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
