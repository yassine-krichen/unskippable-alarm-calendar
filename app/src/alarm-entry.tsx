import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Route, Routes } from 'react-router';

import { AlarmScreen } from '@/features/alarm/alarm-screen';

/**
 * Entry of the alarm window (`#/alarm?occurrence=...`). Kept apart from the app on purpose: it
 * imports no Supabase client, so the alarm window never runs a second auth/refresh loop next to
 * the main window's, and it works without any sign-in or network.
 */
export function startAlarmWindow(container: HTMLElement): void {
  // The alarm is black and white whatever theme the app uses.
  document.documentElement.classList.add('dark');
  createRoot(container).render(
    <StrictMode>
      <HashRouter>
        <Routes>
          <Route path="/alarm" element={<AlarmScreen />} />
        </Routes>
      </HashRouter>
    </StrictMode>
  );
}
