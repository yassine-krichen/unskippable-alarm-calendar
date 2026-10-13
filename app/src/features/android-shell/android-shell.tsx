import { App } from '@capacitor/app';
import { SystemBars, SystemBarsStyle } from '@capacitor/core';
import { useEffect } from 'react';

import { useTheme } from '@/components/theme-provider';
import { useAuthStore } from '@/features/auth/auth-store';
import { detectPlatform } from '@/lib/platform';

import { decideBackAction, hashPathname, historyIndexOf, pressEscapeOn, topOpenOverlay } from './back-action';
import { useBootStatusStore } from './boot-status';

/**
 * Android's back button for the whole app, from the top of the tree so it also covers loading, the
 * sign-in screen and the load error (see decideBackAction). Without a handler the WebView would go
 * back through the hash history and could leave the app on an empty page. It talks to the hash
 * router through the address, which the router follows (a fragment navigation fires popstate).
 */
export function useAndroidBackButton(): void {
  useEffect(() => {
    if (detectPlatform() !== 'android') return;
    const handle = App.addListener('backButton', () => {
      const overlay = topOpenOverlay();
      const action = decideBackAction({
        overlayOpen: overlay !== null,
        authStatus: useAuthStore.getState().status,
        bootStatus: useBootStatusStore.getState().bootStatus,
        pathname: hashPathname(window.location.hash),
        historyIndex: historyIndexOf(window.history.state),
      });
      if (action === 'close-overlay' && overlay !== null) pressEscapeOn(overlay);
      else if (action === 'previous-screen') window.history.back();
      else if (action === 'calendar') window.location.replace('#/');
      else if (action === 'minimize') void App.minimizeApp();
    });
    return () => {
      void handle.then((listener) => listener.remove());
    };
  }, []);
}

/**
 * Android only: the status and navigation bar icons follow the app's own theme (the phone's theme
 * is a separate setting, so the default would put dark icons on the dark app).
 */
export function useSystemBarsStyle(): void {
  const { theme } = useTheme();
  useEffect(() => {
    if (detectPlatform() !== 'android') return;
    SystemBars.setStyle({ style: theme === 'dark' ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(
      (error: unknown) => console.warn('Could not set the system bar style:', error)
    );
  }, [theme]);
}
