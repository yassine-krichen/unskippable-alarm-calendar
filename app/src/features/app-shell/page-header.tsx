import { ArrowLeftIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';
import { historyIndexOf } from '@/features/android-shell/back-action';
import { useIsPhoneLayout } from '@/hooks/use-media-query';

interface PageHeaderProps {
  title: string;
  /** A tab root on the phone layout (Habits): the tab bar is the way out, so no back arrow. */
  tabRoot?: boolean;
  /** Where the back arrow goes on the desktop layout; the phone layout goes to the previous screen. */
  backTo?: string;
  backLabel?: string;
  /** Actions on the right, e.g. a "New exam" button. */
  children?: ReactNode;
}

/**
 * The header every full-page screen shares: safe-area padding, the title, an optional back arrow and the page's
 * actions. On the phone layout the arrow behaves like the Android back button (the previous screen, else More);
 * on the desktop layout it goes to a fixed place, as it always did.
 */
export function PageHeader({ title, tabRoot = false, backTo = '/', backLabel = 'Back to calendar', children }: PageHeaderProps) {
  const navigate = useNavigate();
  const phone = useIsPhoneLayout();
  const showBack = !(phone && tabRoot);

  function goBack(): void {
    if (!phone) {
      navigate(backTo);
      return;
    }
    const index = historyIndexOf(window.history.state);
    if (index !== null && index > 0) navigate(-1);
    else navigate('/more', { replace: true });
  }

  return (
    <header className="flex min-h-14 shrink-0 items-center gap-2 border-b px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-6">
      {showBack ? (
        <Button variant="ghost" size="icon" aria-label={phone ? 'Back' : backLabel} onClick={goBack}>
          <ArrowLeftIcon />
        </Button>
      ) : null}
      <h1 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">{title}</h1>
      {children}
    </header>
  );
}
