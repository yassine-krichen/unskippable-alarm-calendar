import type { DesktopSession } from '@alarm-calendar/core';
import type { Session } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', async () => {
  const { fakeClient } = await import('@/test/fake-supabase');
  return { supabase: fakeClient };
});

import { useAuthStore } from '@/features/auth/auth-store';

import { startSessionSync, toDesktopSession } from './session-sync';

const CONFIG = { url: 'https://example-ref.supabase.co', publishableKey: 'sb_publishable_test' };

function session(accessToken: string, expiresAt = 1_800_000_000): Session {
  return {
    access_token: accessToken,
    refresh_token: 'refresh-token-must-not-be-forwarded',
    expires_in: 3600,
    expires_at: expiresAt,
    token_type: 'bearer',
    user: { id: 'user-1' },
  } as Session;
}

function fakeBridge() {
  const calls: Array<DesktopSession | null> = [];
  return {
    calls,
    bridge: {
      setSession: (value: DesktopSession | null) => {
        calls.push(value);
        return Promise.resolve();
      },
    },
  };
}

beforeEach(() => {
  useAuthStore.setState({ status: 'loading', session: null });
});

describe('toDesktopSession', () => {
  it('forwards the access token and expiry but never the refresh token', () => {
    const forwarded = toDesktopSession(session('access-1'), CONFIG);
    expect(forwarded).toEqual({
      url: CONFIG.url,
      publishableKey: CONFIG.publishableKey,
      userId: 'user-1',
      accessToken: 'access-1',
      expiresAt: 1_800_000_000,
    });
    expect(JSON.stringify(forwarded)).not.toContain('refresh');
  });

  it('maps no session to null', () => {
    expect(toDesktopSession(null, CONFIG)).toBeNull();
  });
});

describe('startSessionSync', () => {
  it('stays quiet while the session is still loading, so a launch does not sign main out', () => {
    const { bridge, calls } = fakeBridge();
    startSessionSync(bridge, CONFIG);
    expect(calls).toEqual([]);
  });

  it('pushes on sign-in, on every token refresh and on sign-out', () => {
    const { bridge, calls } = fakeBridge();
    startSessionSync(bridge, CONFIG);

    useAuthStore.setState({ status: 'signed-in', session: session('access-1') });
    useAuthStore.setState({ status: 'signed-in', session: session('access-2') });
    useAuthStore.setState({ status: 'signed-out', session: null });

    expect(calls.map((call) => call?.accessToken ?? null)).toEqual(['access-1', 'access-2', null]);
  });

  it('pushes the restored session immediately when it was already known at start', () => {
    useAuthStore.setState({ status: 'signed-in', session: session('access-1') });
    const { bridge, calls } = fakeBridge();
    startSessionSync(bridge, CONFIG);
    expect(calls).toHaveLength(1);
  });

  it('does not push the same session twice', () => {
    const { bridge, calls } = fakeBridge();
    startSessionSync(bridge, CONFIG);
    const current = session('access-1');
    useAuthStore.setState({ status: 'signed-in', session: current });
    useAuthStore.setState({ status: 'signed-in', session: current });
    expect(calls).toHaveLength(1);
  });

  it('stops pushing after it is stopped', () => {
    const { bridge, calls } = fakeBridge();
    const stop = startSessionSync(bridge, CONFIG);
    stop();
    useAuthStore.setState({ status: 'signed-in', session: session('access-1') });
    expect(calls).toEqual([]);
  });

  it('survives a rejected bridge call without leaking the token into the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bridge = { setSession: () => Promise.reject(new Error('invalid session payload')) };
    startSessionSync(bridge, CONFIG);
    useAuthStore.setState({ status: 'signed-in', session: session('access-secret') });
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('access-secret');
    warn.mockRestore();
  });
});
