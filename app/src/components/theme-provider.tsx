import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { readDevicePreference, writeDevicePreference } from '@/lib/device-preference';

export type Theme = 'dark' | 'light';

const THEME_KEY = 'alarm-calendar-theme';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function initialTheme(): Theme {
  // Dark is the default; only an explicit saved 'light' changes it.
  return readDevicePreference(THEME_KEY) === 'light' ? 'light' : 'dark';
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

/**
 * Dark by default with a light toggle. The saved choice is applied before first paint by
 * the inline script in index.html; this keeps React and the class in step afterwards.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(initialTheme);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    applyTheme(next);
    writeDevicePreference(THEME_KEY, next);
  }, []);

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider');
  return context;
}
