import { XIcon } from 'lucide-react';
import type { FocusEvent, ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useIsDesktop } from '@/hooks/use-media-query';

interface ResponsiveSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
}

/**
 * Keeps the field being typed in on screen inside a bottom drawer. The on-screen keyboard shrinks the window after
 * the focus event, so the field is centered once it has had time to open (the drawer's own body scrolls).
 */
export function revealFocusedField(event: FocusEvent<HTMLElement>): void {
  const target = event.target;
  if (!target.matches('input, textarea, [contenteditable=true]')) return;
  window.setTimeout(() => target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
}

/**
 * A side Sheet on desktop and a bottom Drawer on phones. The body scrolls on its own so the footer inside
 * children (a FormFooter) stays reachable. On the phone the drawer has a drag handle, a left-aligned header and a
 * close button, so a sheet can be dismissed without knowing the swipe.
 */
export function ResponsiveSheet({ open, onOpenChange, title, description, children }: ResponsiveSheetProps) {
  const isDesktop = useIsDesktop();

  if (isDesktop) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="gap-0 data-[side=right]:sm:max-w-md">
          <SheetHeader className="border-b">
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription>{description}</SheetDescription>
          </SheetHeader>
          {children}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} showSwipeHandle>
      <DrawerContent onFocusCapture={revealFocusedField}>
        <SheetCloseHeader title={title} description={description} />
        {children}
      </DrawerContent>
    </Drawer>
  );
}

/** The drawer's header: title and description on the left, a close button on the right. */
export function SheetCloseHeader({ title, description }: { title: string; description?: string }) {
  return (
    <DrawerHeader className="flex-row items-start gap-2 border-b pb-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <DrawerTitle className="text-lg font-semibold">{title}</DrawerTitle>
        {description ? <DrawerDescription>{description}</DrawerDescription> : null}
      </div>
      <DrawerClose render={<Button type="button" variant="ghost" size="icon" aria-label="Close" className="-mt-1 -mr-1" />}>
        <XIcon />
      </DrawerClose>
    </DrawerHeader>
  );
}
