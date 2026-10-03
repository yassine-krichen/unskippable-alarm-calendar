import type { CompletionRow, EventRow, Settings } from '@alarm-calendar/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fake } from '@/test/fake-supabase';
import type { FakeResponse } from '@/test/fake-supabase';

vi.mock('@/lib/supabase', async () => {
  const { fakeClient } = await import('@/test/fake-supabase');
  return { supabase: fakeClient };
});

import { COMPLETION_WINDOW_MS } from '@/features/completions/completions-api';
import {
  loadRecentCompletions,
  upsertCompletion,
  useCompletionsStore,
} from '@/features/completions/completions-store';
import { loadEvents, removeEvent, useEventsStore } from '@/features/events/events-store';
import {
  loadCheatDays,
  refundPassOnDay,
  spendPassOnDay,
  syncPassWallet,
  usePassesStore,
} from '@/features/passes/passes-store';
import { handleEventChange } from '@/features/realtime/realtime-handlers';
import { loadSettings, saveSettings, useSettingsStore } from '@/features/settings/settings-store';

/** A response the test settles itself, so it can decide which request answers first. */
function deferred() {
  let settle: (response: FakeResponse) => void = () => undefined;
  const promise = new Promise<FakeResponse>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (data: unknown) => settle({ data, error: null }) };
}

function queue(name: string, ...pending: Array<Promise<FakeResponse>>): void {
  fake.queued[name] = pending;
}

const event = (id: string, title = id): EventRow =>
  ({ id, title, start_at: '2026-03-02T09:00:00+00:00', updated_at: '2026-03-01T00:00:00+00:00', active: true }) as EventRow;

const settings = (grace: number): Settings => ({
  user_id: 'u1',
  timezone: 'UTC',
  week_starts_on: 0,
  refire_seconds: 120,
  pass_cap: 2,
  grace_minutes: grace,
});

const wallet = (balance: number) => ({
  balance,
  last_granted_week_start: '2026-03-02',
  timezone: 'UTC',
  week_starts_on: 0,
});

beforeEach(() => {
  fake.reset();
  useEventsStore.setState({ events: [], status: 'idle', error: null });
  usePassesStore.setState({ wallet: null, walletBeforeSync: null, cheatDays: [] });
  useSettingsStore.setState({ settings: null });
  useCompletionsStore.setState({ completions: [] });
});

describe('a slow response never overwrites a newer one', () => {
  it('cheat days: the older request answering last is dropped', async () => {
    const older = deferred();
    const newer = deferred();
    queue('select:cheat_days', older.promise, newer.promise);

    const first = loadCheatDays();
    const second = loadCheatDays();
    newer.resolve([{ day: '2026-03-09' }]);
    await second;
    older.resolve([{ day: '2026-03-04' }]);
    await first;

    expect(usePassesStore.getState().cheatDays).toEqual(['2026-03-09']);
  });

  it('events: the older request answering last is dropped', async () => {
    const older = deferred();
    const newer = deferred();
    queue('select:events', older.promise, newer.promise);

    const first = loadEvents();
    const second = loadEvents();
    newer.resolve([event('new')]);
    await second;
    older.resolve([event('old')]);
    await first;

    expect(useEventsStore.getState().events.map((e) => e.id)).toEqual(['new']);
    expect(useEventsStore.getState().status).toBe('ready');
  });

  it('events: a delete the user made while a fetch was in flight is not undone by that fetch', async () => {
    useEventsStore.setState({ events: [event('a'), event('b')], status: 'ready' });
    const slowFetch = deferred();
    queue('select:events', slowFetch.promise);
    fake.responses['update:events'] = { data: [{ id: 'a' }], error: null };

    const load = loadEvents();
    await removeEvent('a');
    slowFetch.resolve([event('a'), event('b')]);
    await load;

    expect(useEventsStore.getState().events.map((e) => e.id)).toEqual(['b']);
  });

  it('events: a realtime change does not cancel the catch-up fetch that is in flight', async () => {
    const catchUp = deferred();
    queue('select:events', catchUp.promise);

    const load = loadEvents();
    handleEventChange({ eventType: 'INSERT', new: { ...event('live') }, old: {} });
    catchUp.resolve([event('live'), event('missed-while-offline')]);
    await load;

    expect(useEventsStore.getState().events.map((e) => e.id)).toEqual(['live', 'missed-while-offline']);
  });

  it('events: a realtime update during a fetch survives that fetch answering with the older row', async () => {
    useEventsStore.setState({ events: [event('a', 'old title')], status: 'ready' });
    const slowFetch = deferred();
    queue('select:events', slowFetch.promise);

    const load = loadEvents();
    handleEventChange({
      eventType: 'UPDATE',
      new: { ...event('a', 'new title'), updated_at: '2026-03-01T00:05:00+00:00' },
      old: {},
    });
    slowFetch.resolve([event('a', 'old title')]);
    await load;

    expect(useEventsStore.getState().events.map((e) => e.title)).toEqual(['new title']);
  });

  it('events: a realtime soft delete during a fetch is not undone by that fetch', async () => {
    useEventsStore.setState({ events: [event('a'), event('b')], status: 'ready' });
    const slowFetch = deferred();
    queue('select:events', slowFetch.promise);

    const load = loadEvents();
    handleEventChange({ eventType: 'UPDATE', new: { ...event('a'), active: false }, old: {} });
    slowFetch.resolve([event('a'), event('b')]);
    await load;

    expect(useEventsStore.getState().events.map((e) => e.id)).toEqual(['b']);
  });

  it('settings: the older request answering last is dropped', async () => {
    const older = deferred();
    const newer = deferred();
    queue('select:settings', older.promise, newer.promise);

    const first = loadSettings();
    const second = loadSettings();
    newer.resolve(settings(60));
    await second;
    older.resolve(settings(5));
    await first;

    expect(useSettingsStore.getState().settings?.grace_minutes).toBe(60);
  });

  it('settings: a save made while a load was in flight wins over that load', async () => {
    const slowLoad = deferred();
    queue('select:settings', slowLoad.promise);
    fake.responses['update:settings'] = { data: settings(90), error: null };

    const load = loadSettings();
    await saveSettings('u1', { grace_minutes: 90 });
    slowLoad.resolve(settings(30));
    await load;

    expect(useSettingsStore.getState().settings?.grace_minutes).toBe(90);
  });

  it('completions: the older request answering last is dropped', async () => {
    const older = deferred();
    const newer = deferred();
    queue('select:completions', older.promise, newer.promise);
    const row = (id: string): CompletionRow => ({ id }) as CompletionRow;

    const first = loadRecentCompletions();
    const second = loadRecentCompletions();
    newer.resolve([row('new')]);
    await second;
    older.resolve([row('old')]);
    await first;

    expect(useCompletionsStore.getState().completions.map((c) => c.id)).toEqual(['new']);
  });

  it('wallet: a sync that started before a spend cannot put the old balance back', async () => {
    const slowSync = deferred();
    queue('rpc:sync_wallet', slowSync.promise);
    fake.responses['rpc:use_pass'] = { data: wallet(0), error: null };
    fake.responses['select:cheat_days'] = { data: [{ day: '2026-03-04' }], error: null };

    const sync = syncPassWallet();
    await spendPassOnDay('2026-03-04');
    slowSync.resolve(wallet(1));
    await sync;

    expect(usePassesStore.getState().wallet?.balance).toBe(0);
  });

  it('wallet: the same holds after a refund', async () => {
    const slowSync = deferred();
    queue('rpc:sync_wallet', slowSync.promise);
    fake.responses['rpc:refund_pass'] = { data: wallet(2), error: null };
    fake.responses['select:cheat_days'] = { data: [], error: null };

    const sync = syncPassWallet();
    await refundPassOnDay('2026-03-04');
    slowSync.resolve(wallet(1));
    await sync;

    expect(usePassesStore.getState().wallet?.balance).toBe(2);
  });
});

describe('the completions list stays within the load window', () => {
  const now = Date.parse('2026-03-10T12:00:00.000Z');
  const completion = (id: string, occurrenceAt: string): CompletionRow =>
    ({ id, event_id: 'e1', occurrence_at: occurrenceAt }) as CompletionRow;

  it('drops entries that have aged out of the window when a new one arrives', () => {
    const old = new Date(now - COMPLETION_WINDOW_MS - 60_000).toISOString();
    const recent = new Date(now - 60_000).toISOString();
    useCompletionsStore.setState({ completions: [completion('old', old)] });

    upsertCompletion(completion('recent', recent), now);

    expect(useCompletionsStore.getState().completions.map((c) => c.id)).toEqual(['recent']);
  });

  it('does not keep an arriving completion that is already older than the window', () => {
    const old = new Date(now - COMPLETION_WINDOW_MS - 60_000).toISOString();
    upsertCompletion(completion('old', old), now);
    expect(useCompletionsStore.getState().completions).toEqual([]);
  });
});
