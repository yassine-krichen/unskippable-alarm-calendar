import type { AlarmAdapter, EventRow, Settings } from '@alarm-calendar/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fake } from '@/test/fake-supabase';

vi.mock('@/lib/supabase', async () => {
  const { fakeClient } = await import('@/test/fake-supabase');
  return { supabase: fakeClient };
});

import { startScheduleSync } from '@/features/alarm-adapter/schedule-sync';
import { useCompletionsStore } from '@/features/completions/completions-store';
import { useEventsStore } from '@/features/events/events-store';
import { usePassesStore } from '@/features/passes/passes-store';
import { useSettingsStore } from '@/features/settings/settings-store';
import { resetSoundIdForTests } from '@/features/settings/sound-preference';

import { startRealtime } from './realtime';
import type { ChannelLike, RealtimeClientLike } from './realtime';
import type { ChangePayload } from './realtime-handlers';

const SETTINGS: Settings = {
  user_id: 'u1',
  timezone: 'UTC',
  week_starts_on: 0,
  refire_seconds: 120,
  pass_cap: 2,
  grace_minutes: 30,
};

const row = (overrides: Partial<EventRow> & { id: string }): EventRow =>
  ({
    title: 'Take medication',
    notes: null,
    start_at: '2026-03-02T09:01:00+00:00',
    repeat_unit: 'none',
    repeat_interval: 1,
    repeat_weekdays: null,
    ends_at: null,
    max_snoozes: 3,
    snooze_minutes: 5,
    passable: true,
    updated_at: '2026-03-01T10:00:00+00:00',
    active: true,
    ...overrides,
  }) as EventRow;

/** An event row as a realtime payload carries it: a plain record. */
const payload = (overrides: Partial<EventRow> & { id: string }): Record<string, unknown> => ({
  ...row(overrides),
});

/** Records what startRealtime subscribed to so a test can deliver a change by table. */
class FakeRealtime implements RealtimeClientLike {
  readonly handlers = new Map<string, (payload: ChangePayload) => void>();
  statusCallback: ((status: string) => void) | null = null;
  removed = 0;
  channelName = '';

  channel(name: string): ChannelLike {
    this.channelName = name;
    const channel: ChannelLike = {
      on: (_type, filter, callback) => {
        this.handlers.set(filter.table, callback);
        return channel;
      },
      subscribe: (callback) => {
        this.statusCallback = callback;
      },
    };
    return channel;
  }

  removeChannel(): void {
    this.removed++;
  }

  deliver(table: string, payload: Partial<ChangePayload> & Pick<ChangePayload, 'eventType'>): void {
    const handler = this.handlers.get(table);
    if (handler === undefined) throw new Error(`no subscription for ${table}`);
    handler({ new: {}, old: {}, ...payload });
  }
}

function fakeAdapter() {
  const pushes: Array<{ events: EventRow[]; cheatDays: string[]; completedIds: string[] }> = [];
  const adapter: AlarmAdapter = {
    setSchedule: (payload) => {
      pushes.push({
        events: payload.refillSource.events,
        cheatDays: payload.refillSource.cheatDays,
        completedIds: payload.occurrences.filter((o) => o.completed).map((o) => o.id),
      });
      return Promise.resolve();
    },
    drainCompletions: () => Promise.resolve([]),
    getPermissionStatus: () => Promise.reject(new Error('unused')),
    openPermissionSettings: () => Promise.resolve(),
  };
  return { adapter, pushes };
}

beforeEach(() => {
  vi.useFakeTimers();
  // The completions list only keeps recent rows, and the schedule list reaches back only by the
  // grace window, so the clock sits next to the test data.
  vi.setSystemTime(new Date('2026-03-02T09:10:00.000Z'));
  fake.reset();
  resetSoundIdForTests();
  useSettingsStore.setState({ settings: SETTINGS });
  useEventsStore.setState({ events: [row({ id: 'a' })], status: 'ready', error: null });
  usePassesStore.setState({ cheatDays: [] });
  useCompletionsStore.setState({ completions: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startRealtime', () => {
  it('subscribes to the four tables on one channel and removes it when stopped', () => {
    const client = new FakeRealtime();
    const stop = startRealtime(client, 'u1', () => undefined);
    expect([...client.handlers.keys()].sort()).toEqual(['cheat_days', 'completions', 'events', 'settings']);
    stop();
    expect(client.removed).toBe(1);
  });

  it('asks the caller to catch up every time the channel (re)subscribes, and not for other statuses', () => {
    const client = new FakeRealtime();
    const onSubscribed = vi.fn();
    startRealtime(client, 'u1', onSubscribed);

    client.statusCallback?.('CHANNEL_ERROR');
    expect(onSubscribed).not.toHaveBeenCalled();
    client.statusCallback?.('SUBSCRIBED');
    client.statusCallback?.('SUBSCRIBED');
    expect(onSubscribed).toHaveBeenCalledTimes(2);
  });
});

describe('realtime change reaches the alarm adapter', () => {
  function start() {
    const client = new FakeRealtime();
    const { adapter, pushes } = fakeAdapter();
    startScheduleSync({ adapter });
    startRealtime(client, 'u1', () => undefined);
    pushes.length = 0; // the initial push is not what these tests are about
    return { client, pushes };
  }

  it('an event inserted on another device is pushed to setSchedule', () => {
    const { client, pushes } = start();
    client.deliver('events', { eventType: 'INSERT', new: payload({ id: 'b', title: 'Stretch' }) });
    vi.advanceTimersByTime(300);

    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.events.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('an event edited elsewhere replaces the local copy', () => {
    const { client, pushes } = start();
    client.deliver('events', {
      eventType: 'UPDATE',
      new: payload({ id: 'a', title: 'Renamed', updated_at: '2026-03-02T08:00:00+00:00' }),
    });
    vi.advanceTimersByTime(300);
    expect(pushes[0]?.events[0]?.title).toBe('Renamed');
  });

  it('an older echo of an event does not overwrite a newer local version', () => {
    const { client, pushes } = start();
    useEventsStore.setState({
      events: [row({ id: 'a', title: 'Newest', updated_at: '2026-03-03T00:00:00+00:00' })],
    });
    vi.advanceTimersByTime(300);
    pushes.length = 0;

    client.deliver('events', {
      eventType: 'UPDATE',
      new: payload({ id: 'a', title: 'Stale', updated_at: '2026-03-02T00:00:00+00:00' }),
    });
    vi.advanceTimersByTime(300);
    expect(useEventsStore.getState().events[0]?.title).toBe('Newest');
  });

  it('a soft-deleted event (active false) leaves the schedule', () => {
    const { client, pushes } = start();
    client.deliver('events', {
      eventType: 'UPDATE',
      new: payload({ id: 'a', active: false, updated_at: '2026-03-02T08:00:00+00:00' }),
    });
    vi.advanceTimersByTime(300);
    expect(pushes[0]?.events).toEqual([]);
  });

  it('a hard-deleted event leaves the schedule too', () => {
    const { client, pushes } = start();
    client.deliver('events', { eventType: 'DELETE', old: { id: 'a' } });
    vi.advanceTimersByTime(300);
    expect(pushes[0]?.events).toEqual([]);
  });

  it('a cheat_days DELETE, which carries only the id, refetches the days and pushes them', async () => {
    const { client, pushes } = start();
    fake.responses['select:cheat_days'] = { data: [{ day: '2026-03-09' }], error: null };

    client.deliver('cheat_days', { eventType: 'DELETE', old: { id: 'only-the-primary-key' } });
    await vi.advanceTimersByTimeAsync(300);

    expect(fake.names()).toContain('select:cheat_days');
    expect(pushes.at(-1)?.cheatDays).toEqual(['2026-03-09']);
  });

  it('a cheat_days INSERT also refetches rather than trusting the payload', async () => {
    const { client } = start();
    fake.responses['select:cheat_days'] = { data: [{ day: '2026-03-05' }], error: null };
    client.deliver('cheat_days', { eventType: 'INSERT', new: { day: 'ignored' } });
    await vi.advanceTimersByTimeAsync(300);
    expect(usePassesStore.getState().cheatDays).toEqual(['2026-03-05']);
  });

  it('a settings update from another device is pushed, ignoring fields the app does not use', () => {
    const { client } = start();
    client.deliver('settings', {
      eventType: 'UPDATE',
      new: { ...SETTINGS, grace_minutes: 90, extra_column: 'x' },
    });
    expect(useSettingsStore.getState().settings).toEqual({ ...SETTINGS, grace_minutes: 90 });
  });

  it('a completion made on another device is pushed so this device will not ring it again', () => {
    const { client, pushes } = start();
    const done = {
      id: 'c1',
      user_id: 'u1',
      event_id: 'a',
      occurrence_at: '2026-03-02T09:01:00+00:00',
      status: 'done',
      snoozes_used: 1,
      done_at: '2026-03-02T09:02:00+00:00',
    };
    client.deliver('completions', { eventType: 'INSERT', new: done });
    vi.advanceTimersByTime(300);
    expect(pushes[0]?.completedIds).toEqual(['a@2026-03-02T09:01:00.000Z']);
  });

  it('a second upsert of the same occurrence replaces the first instead of listing it twice', () => {
    const { client } = start();
    const base = { user_id: 'u1', event_id: 'a', occurrence_at: '2026-03-02T09:01:00+00:00', status: 'done' };
    client.deliver('completions', { eventType: 'INSERT', new: { ...base, id: 'c1', snoozes_used: 0 } });
    client.deliver('completions', { eventType: 'UPDATE', new: { ...base, id: 'c2', snoozes_used: 2 } });
    expect(useCompletionsStore.getState().completions).toHaveLength(1);
    expect(useCompletionsStore.getState().completions[0]?.snoozes_used).toBe(2);
  });

  it('ignores a malformed payload instead of corrupting the store', () => {
    const { client } = start();
    client.deliver('events', { eventType: 'INSERT', new: { nope: true } });
    client.deliver('completions', { eventType: 'INSERT', new: { nope: true } });
    expect(useEventsStore.getState().events.map((e) => e.id)).toEqual(['a']);
    expect(useCompletionsStore.getState().completions).toEqual([]);
  });
});
