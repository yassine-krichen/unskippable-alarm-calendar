import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ConfigError } from '@/components/config-error';
import { ThemeProvider } from '@/components/theme-provider';
import { parseEnv } from '@/lib/env';

import './index.css';

async function start(): Promise<void> {
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing #root element');
  const root = createRoot(container);

  // Checked before the app (and its Supabase client) is imported, so a missing variable
  // shows a readable screen instead of a blank page.
  try {
    parseEnv(import.meta.env);
  } catch (error) {
    root.render(<ConfigError message={error instanceof Error ? error.message : String(error)} />);
    throw error;
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
