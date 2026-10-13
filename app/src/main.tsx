import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ConfigError } from '@/components/config-error';
import { ThemeProvider } from '@/components/theme-provider';
import { parseEnv } from '@/lib/env';

import './index.css';

async function start(): Promise<void> {
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing #root element');

  // The alarm window loads this same bundle at #/alarm?occurrence=... and needs none of the app.
  if (window.location.hash.startsWith('#/alarm')) {
    const { startAlarmWindow } = await import('./alarm-entry');
    startAlarmWindow(container);
    return;
  }

  const root = createRoot(container);

  // Checked before the app (and its Supabase client) is imported, so a missing variable
  // shows a readable screen instead of a blank page.
  try {
    parseEnv(import.meta.env);
  } catch (error) {
    root.render(<ConfigError message={error instanceof Error ? error.message : String(error)} />);
    throw error;
  }

  // Emulator verification only. Both conditions are build-time constants and the second is the dummy project of
  // docs/android.md, so a bundle built for the real project has none of this even if the flag leaks in.
  if (import.meta.env.VITE_ALARM_DEBUG === '1' && import.meta.env.VITE_SUPABASE_URL === 'https://example.supabase.co') {
    const { installAlarmDebugHooks } = await import('@/features/alarm-adapter/debug-hooks');
    installAlarmDebugHooks();
  }

  const { App } = await import('./app');
  root.render(
    <StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </StrictMode>
  );
}

void start();
