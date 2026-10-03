import { useEffect } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { signOut } from '@/features/auth/auth-api';
import { AuthScreen } from '@/features/auth/auth-screen';
import { startAuthListener, useAuthStore } from '@/features/auth/auth-store';
import { CalendarPage } from '@/features/calendar/calendar-page';
import { useEventsStore } from '@/features/events/events-store';
import { usePassesStore } from '@/features/passes/passes-store';
import { SettingsPage } from '@/features/settings/settings-page';
import { useSettingsStore } from '@/features/settings/settings-store';

import { useAppData } from './app-data';
import { useDesktopSession, useLiveSync } from './use-live-sync';

/** Drops the previous user's data so a different account never briefly sees it. */
function resetAppData(): void {
  useSettingsStore.setState({ settings: null });
  useEventsStore.setState({ events: [], status: 'idle', error: null });
  usePassesStore.setState({ wallet: null, walletBeforeSync: null, cheatDays: [] });
}

export function App() {
  const status = useAuthStore((state) => state.status);

  useEffect(() => startAuthListener(), []);
  useDesktopSession();
  useEffect(() => {
    if (status === 'signed-out') resetAppData();
  }, [status]);

  return (
    <TooltipProvider>
      {status === 'loading' ? <BootSkeleton /> : null}
      {status === 'signed-out' ? <AuthScreen /> : null}
      {status === 'signed-in' ? <SignedInApp /> : null}
      <Toaster position="top-center" />
    </TooltipProvider>
  );
}

function SignedInApp() {
  const { status, error, retry } = useAppData();
  useLiveSync(status === 'ready');

  if (status === 'loading') return <BootSkeleton />;

  if (status === 'error') {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-6">
        <Alert variant="destructive">
          <AlertTitle>Couldn't load your calendar</AlertTitle>
          <AlertDescription>{error ?? 'Check your connection and try again.'}</AlertDescription>
        </Alert>
        <div className="flex gap-2">
          <Button onClick={retry}>Try again</Button>
          <Button variant="outline" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </main>
    );
  }

  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<CalendarPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}

/** Shaped like the calendar screen, so the real one replaces it without a jump. */
function BootSkeleton() {
  return (
    <div className="flex h-dvh flex-col gap-3 p-4" aria-busy="true" aria-label="Loading">
      <div className="flex items-center gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="ml-auto h-8 w-24" />
      </div>
      <Skeleton className="h-9 w-full" />
      <Skeleton className="min-h-0 w-full flex-1" />
    </div>
  );
}
