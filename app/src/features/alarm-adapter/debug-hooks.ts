import type { EventRow, Settings } from '@alarm-calendar/core';

import { checkPermissions, usePermissionsStore } from '@/features/permissions/permissions-store';

import { AlarmEngine } from './alarm-engine-plugin';
import { flushCompletions } from './completion-flush';
import { uploadToSupabase } from './completion-sync';
import { getAlarmAdapter } from './create-alarm-adapter';

// The same ids the native DebugSeedReceiver uses, so an adb SEED and this fake backend describe one user.
const DEBUG_USER_ID = '00000000-0000-4000-8000-000000000001';
const ALARM_AT_KEY = 'debug-fake-alarm-at';

const SETTINGS: Settings = {
  user_id: DEBUG_USER_ID,
  timezone: 'Africa/Tunis',
  week_starts_on: 1,
  refire_seconds: 20,
  pass_cap: 2,
  grace_minutes: 30,
  exam_mode_days_before: 3,
};

function fakeEvent(): EventRow {
  const stored = localStorage.getItem(ALARM_AT_KEY);
  const startAt = stored ?? new Date(Math.ceil((Date.now() + 90_000) / 1000) * 1000).toISOString();
  localStorage.setItem(ALARM_AT_KEY, startAt);
  return {
    id: '00000000-0000-4000-8000-0000000000c1',
    user_id: DEBUG_USER_ID,
    title: 'App-seeded alarm',
    notes: 'From the fake backend',
    start_at: startAt,
    duration_min: 15,
    repeat_unit: 'none',
    repeat_interval: 1,
    repeat_weekdays: null,
    ends_at: null,
    max_snoozes: 1,
    snooze_minutes: 1,
    passable: true,
    color: null,
    active: true,
    updated_at: new Date().toISOString(),
  };
}

interface FakeBackendState {
  /** While true a completion upload answers 503, like a phone without network. */
  failCompletions: boolean;
  completionPosts: unknown[];
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * A stand-in for Supabase's REST API, answering from memory, so the whole signed-in app (bootstrap,
 * schedule sync, completion upload) runs on an emulator with a dummy URL. Also plants a signed-in
 * session in localStorage, where supabase-js looks for it.
 */
function installFakeBackend(state: FakeBackendState): void {
  const sessionKey = 'sb-example-auth-token';
  if (localStorage.getItem(sessionKey) === null) {
    localStorage.setItem(
      sessionKey,
      JSON.stringify({
        access_token: 'debug.access.token',
        refresh_token: 'debug-refresh',
        token_type: 'bearer',
        expires_in: 86_400,
        expires_at: Math.floor(Date.now() / 1000) + 86_400,
        user: { id: DEBUG_USER_ID, email: 'debug@example.com', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
      })
    );
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== 'example.supabase.co') return realFetch(input, init);

    const path = url.pathname;
    const wantsOne = (request.headers.get('Accept') ?? '').includes('vnd.pgrst.object');
    if (path.startsWith('/rest/v1/rpc/')) {
      return json({ balance: 1, last_granted_week_start: '2026-10-12', timezone: 'Africa/Tunis', week_starts_on: 1 });
    }
    const table = path.replace('/rest/v1/', '');
    if (request.method === 'POST' && table === 'completions') {
      state.completionPosts.push(await request.json());
      return state.failCompletions ? json({ message: 'debug: backend unavailable' }, 503) : new Response(null, { status: 201 });
    }
    if (request.method !== 'GET') return json([]);
    const rows: unknown[] =
      table === 'settings'
        ? [SETTINGS]
        : table === 'pass_wallet'
          ? [{ anchored_at: '2026-10-01T00:00:00Z' }]
          : table === 'events'
            ? [fakeEvent()]
            : [];
    return wantsOne ? json(rows[0] ?? null) : json(rows);
  };
}

/**
 * Verification aid, built only when the bundle is made with VITE_ALARM_DEBUG=1 (never in the
 * owner's build, where this whole module is absent). Installs the fake backend and exposes a few
 * handles on window.__alarmDebug for driving the real Android wiring over the WebView's DevTools
 * port.
 */
export function installAlarmDebugHooks(): void {
  const state: FakeBackendState = { failCompletions: true, completionPosts: [] };
  installFakeBackend(state);
  Reflect.set(window, '__alarmDebug', {
    state,
    /** One real flush: peek, upsert to the fake backend, ack what it answered for. */
    flush: () =>
      flushCompletions({
        adapter: getAlarmAdapter(),
        upload: uploadToSupabase,
        userId: () => DEBUG_USER_ID,
        log: (event, fields) => console.info(event, JSON.stringify(fields ?? {})),
      }),
    peek: () => AlarmEngine.peekCompletions(),
    pendingDone: () => AlarmEngine.getPendingDoneOccurrences(),
    permissions: () => AlarmEngine.getPermissionStatus(),
    checkPermissions: (reason: 'launch' | 'resume' | 'refresh' = 'launch') => checkPermissions(reason),
    permissionState: () => usePermissionsStore.getState(),
  });
}
