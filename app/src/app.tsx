import { useEffect, type ReactNode } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAndroidBackButton, useSystemBarsStyle } from '@/features/android-shell/android-shell';
import { useBootStatusStore } from '@/features/android-shell/boot-status';
import { AppLayout } from '@/features/app-shell/app-layout';
import { MorePage } from '@/features/app-shell/more-page';
import { signOut } from '@/features/auth/auth-api';
import { AuthScreen } from '@/features/auth/auth-screen';
import { startAuthListener, useAuthStore } from '@/features/auth/auth-store';
import { CalendarPage } from '@/features/calendar/calendar-page';
import { useEventsStore } from '@/features/events/events-store';
import { resetCatchUps } from '@/features/exams/catch-up-sync';
import { resetExams } from '@/features/exams/exams-store';
import { ExamsPage } from '@/features/exams/exams-page';
import { StatsPage } from '@/features/habits/stats-page';
import { resetModes } from '@/features/modes/modes-store';
import { ModesPage } from '@/features/modes/modes-page';
import { PermissionDialog, usePermissionChecks } from '@/features/permissions/permission-dialog';
import { resetHabitCompletions } from '@/features/habits/habits-store';
import { usePassesStore } from '@/features/passes/passes-store';
import { SettingsPage } from '@/features/settings/settings-page';
import { useSettingsStore } from '@/features/settings/settings-store';
import { TodayPage } from '@/features/today/today-page';
import { AboutPage } from '@/features/updates/about-page';
import { useUpdateAutoCheck } from '@/features/updates/use-update-check';
import { useIsPhoneLayout } from '@/hooks/use-media-query';

import { useAppData, type BootStatus } from './app-data';
import { useCompletionSync, useDesktopSession, useLiveSync } from './use-live-sync';

/** Drops the previous user's data so a different account never briefly sees it. */
function resetAppData(): void {
  useSettingsStore.setState({ settings: null });
  useEventsStore.setState({ events: [], status: 'idle', error: null });
  usePassesStore.setState({ wallet: null, walletBeforeSync: null, cheatDays: [] });
  resetHabitCompletions();
  resetExams();
  resetModes();
  resetCatchUps();
}

export function App() {
  const status = useAuthStore((state) => state.status);

  useEffect(() => startAuthListener(), []);
  useDesktopSession();
  useSystemBarsStyle();
  useAndroidBackButton();
  useEffect(() => {
    if (status === 'signed-out') resetAppData();
  }, [status]);

  return (
    <TooltipProvider>
      {status === 'loading' ? <BootSkeleton /> : null}
      {status === 'signed-out' ? <AuthScreen /> : null}
      {status === 'signed-in' ? <SignedInApp /> : null}
      <AppToaster />
    </TooltipProvider>
  );
}

// Above the tab bar and the gesture-bar inset. Passed as both offsets: sonner switches from `offset` to `mobileOffset`
// at 600px, and the phone layout reaches 767px.
const PHONE_TOAST_OFFSET = { bottom: 'calc(env(safe-area-inset-bottom) + 4.5rem)' };

/**
 * Top-center on the desktop layout. On the phone layout toasts sit at the bottom, above the tab bar and the
 * gesture-bar inset, where the thumb and the eyes already are (sonner's mobileOffset is for narrow screens).
 */
function AppToaster() {
  const phone = useIsPhoneLayout();
  return phone ? (
    <Toaster position="bottom-center" offset={PHONE_TOAST_OFFSET} mobileOffset={PHONE_TOAST_OFFSET} />
  ) : (
    <Toaster position="top-center" />
  );
}

function SignedInApp() {
  const { status, error, retry } = useAppData();
  useLiveSync(status === 'ready');
  useCompletionSync();
  usePermissionChecks();
  useUpdateAutoCheck();
  useEffect(() => {
    useBootStatusStore.setState({ bootStatus: status });
    return () => useBootStatusStore.setState({ bootStatus: null });
  }, [status]);

  return (
    <>
      <SignedInScreens status={status} error={error} retry={retry} />
      <PermissionDialog />
    </>
  );
}

function SignedInScreens({ status, error, retry }: { status: BootStatus; error: string | null; retry: () => void }) {
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
        <Route element={<AppLayout />}>
          <Route path="/" element={<Home />} />
          <Route path="/today" element={<TodayPage />} />
          <Route path="/calendar" element={<PhoneOnly><CalendarPage /></PhoneOnly>} />
          <Route path="/more" element={<PhoneOnly><MorePage /></PhoneOnly>} />
          <Route path="/exams" element={<ExamsPage />} />
          <Route path="/modes" element={<ModesPage />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}

/** `/` is the calendar on the desktop layout and Today on the phone layout. */
function Home() {
  const phone = useIsPhoneLayout();
  return phone ? <Navigate to="/today" replace /> : <CalendarPage />;
}

/** Calendar and More are phone tabs; the desktop layout's calendar is `/` and it reaches the rest from its header. */
function PhoneOnly({ children }: { children: ReactNode }) {
  const phone = useIsPhoneLayout();
  return phone ? children : <Navigate to="/" replace />;
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
