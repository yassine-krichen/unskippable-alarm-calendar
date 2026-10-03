import type { DesktopApi, DesktopSession } from '@alarm-calendar/core';
import type { Session } from '@supabase/supabase-js';

import { useAuthStore } from '@/features/auth/auth-store';

export interface SessionSyncConfig {
  url: string;
  publishableKey: string;
}

/**
 * Only what the main process needs to write completions as this user. No refresh token: this
 * window is the only one that refreshes the session, so two clients can never race on a rotating
 * refresh token and get the session revoked.
 */
export function toDesktopSession(session: Session | null, config: SessionSyncConfig): DesktopSession | null {
  if (session === null) return null;
  const expiresAt = session.expires_at ?? Math.floor(Date.now() / 1000) + session.expires_in;
  return {
    url: config.url,
    publishableKey: config.publishableKey,
    userId: session.user.id,
    accessToken: session.access_token,
    expiresAt,
  };
}

/**
 * Hands the signed-in session to the main process on launch, sign-in, token refresh and
 * sign-out. Returns the unsubscribe function.
 */
export function startSessionSync(bridge: Pick<DesktopApi, 'setSession'>, config: SessionSyncConfig): () => void {
  let latest = useAuthStore.getState();
  let lastPushed: Session | null | undefined;

  const push = (): void => {
    // 'loading' has no answer yet; pushing null then would sign main out on every launch.
    if (latest.status === 'loading' || latest.session === lastPushed) return;
    lastPushed = latest.session;
    bridge.setSession(toDesktopSession(latest.session, config)).catch((error: unknown) => {
      // Never log the session itself: the message of a rejected IPC call carries no token.
      console.warn('Could not hand the session to the desktop app:', error instanceof Error ? error.message : 'unknown');
    });
  };

  push();
  return useAuthStore.subscribe((state) => {
    latest = state;
    push();
  });
}
