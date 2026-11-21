import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The bar under a sheet's form. On the desktop it is one row: an optional Delete on the left, Cancel and the main
 * button on the right. On the phone the main button is full width on top, Cancel under it and Delete last, and the
 * bar is padded by the gesture-bar inset so nothing sits under it. Put the Delete button (if any) first, then a
 * FormFooterActions.
 */
export function FormFooter({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      data-slot="form-footer"
      className={cn(
        'flex shrink-0 flex-col gap-2 border-t px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:flex-row md:items-center',
        // Delete is the rarest action, so on the phone it goes last instead of first.
        '[&>[data-slot=button]]:order-last md:[&>[data-slot=button]]:order-none',
        className
      )}
    >
      {children}
    </div>
  );
}

/** Cancel and the main button. Write them in that order: the phone reverses them so the main one is on top. */
export function FormFooterActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-col-reverse gap-2 md:ml-auto md:flex-row">{children}</div>;
}
