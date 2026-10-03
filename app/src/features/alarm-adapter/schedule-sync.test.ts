import type { AlarmAdapter, AlarmSettings, CompletionRow, EventRow, Settings } from '@alarm-calendar/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', async () => {
  const { fakeClient } = await import('@/test/fake-supabase');
  return { supabase: fakeClient };
});

import { useCompletionsStore } from '@/features/completions/completions-store';
import { useEventsStore } from '@/features/events/events-store';
import { usePassesStore } from '@/features/passes/passes-store';
import { useSettingsStore } from '@/features/settings/settings-store';
import { resetSoundIdForTests, setSoundId } from '@/features/settings/sound-preference';

import { startScheduleSync } from './schedule-sync';

const SETTINGS: Settings = {
  user_id: 'u1',
  timezone: 'UTC',
  week_starts_on: 0,
  refire_seconds: 120,
  pass_cap: 2,
  grace_minutes: 30,
};

const event = (id: string): EventRow => ({ id, title: id }) as EventRow;

interface Push {
  events: EventRow[];
  cheatDays: string[];
  settings: AlarmSettings;
  completions: CompletionRow[] | undefined;
}

function fakeAdapter() {
  const pushes: Push[] = [];
  const adapter: AlarmAdapter = {
    setSchedule: (events, cheatDays, settings, completions) => {
      pushes.push({ events, cheatDays, settings, completions });
      return Promise.resolve();
    },
    drainCompletions: () => Promise.resolve([]),
    getPermissionStatus: () => Promise.reject(new Error('unused')),
    openPermissionSettings: () => Promise.resolve(),
  };
  return { adapter, pushes };
}

function loadedStores(): void {
  useSettingsStore.setState({ settings: SETTINGS });
  useEventsStore.setState({ events: [event('a')], status: 'ready', error: null });
  usePassesStore.setState({ cheatDays: ['2026-03-04'] });
  useCompletionsStore.setState({ completions: [] });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetSoundIdForTests();
  loadedStores();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startScheduleSync', () => {
  it('pushes the loaded schedule at once, with the device sound added to the settings', () => {
    const { adapter, pushes } = fakeAdapter();
    startScheduleSync({ adapter });

    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.events.map((e) => e.id)).toEqual(['a']);
    expect(pushes[0]?.cheatDays).toEqual(['2026-03-04']);
    expect(pushes[0]?.settings).toEqual({ ...SETTINGS, sound: 'bell' });
    expect(pushes[0]?.completions).toEqual([]);
  });

  it('does not push before the first load finished', () => {
    useEventsStore.setState({ events: [], status: 'loading', error: null });
    const { adapter, pushes } = fakeAdapter();
    startScheduleSync({ adapter });
    expect(pushes).toHaveLength(0);

    useEventsStore.setState({ events: [event('a')], status: 'ready' });
    vi.advanceTimersByTime(300);
    expect(pushes).toHaveLength(1);
  });

  it('does not push without settings, which would leave the engine without a time zone', () => {
    useSettingsStore.setState({ settings: null });
    const { adapter, pushes } = fakeAdapter();
    startScheduleSync({ adapter });
    expect(pushes).toHaveLength(0);
  });

  it('pushes again after an event change', () => {
    const { adapter, pushes } = fakeAdapter();
    startScheduleSync({ adapter });
    useEventsStore.setState({ events: [event('a'), event('b')] });
    vi.advanceTimersByTime(300);

    expect(pushes).toHaveLength(2);
    expect(pushes[1]?.events.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('pushes the new cheat days after a pass is spent or refunded', () => {
    const { adapter, pushes } = fakeAdapter();
    startScheduleSync({ adapter });
    usePassesStore.setState({ cheatDays: ['2026-03-04', '2026-03-06'] });
    vi.advanceTimersByTime(300);
    expect(pushes.at(-1)?.cheatDays).toEqual(['2026-03-04', '2026-03-06']);
  });

  it('pushes after a settings change and after a different sound is chosen', () => {
    const { adapter, pushes } = fakeAdapter();
    startScheduleSync({ adapter });

    useSettingsStore.setState({ settings: { ...SETTINGS, grace_minutes: 60 } });
    vi.advanceTimersByTime(300);
    expect(pushes.at(-1)?.settings.grace_minutes).toBe(60);

    setSoundId('chime');
    vi.advanceTimersByTime(300);
    expect(pushes.at(-1)?.settings.sound).toBe('chime');
  });

  it('includes synced completions so a done occurrence is not rung again', () => {
    const { adapter, pushes } = fakeAdapter();
    startScheduleSync({ adapter });
    const done = { id: 'c1', event_id: 'a' } as CompletionRow;
    useCompletionsStore.setState({ completions: [done] });
    vi.advanceTimersByTime(300);
    expect(pushes.at(-1)?.completions).toEqual([done]);
  });

  it('turns a burst of changes into one push', () => {
    const { adapter, pushes } = fakeAdapter();
    startScheduleSync({ adapter });
    useEventsStore.setState({ events: [event('a'), event('b')] });
    usePassesStore.setState({ cheatDays: [] });
    useSettingsStore.setState({ settings: { ...SETTINGS, refire_seconds: 60 } });
    vi.advanceTimersByTime(300);
    expect(pushes).toHaveLength(2);
  });

  it('ignores store changes that are not part of the schedule, such as the wallet', () => {
    const { adapter, pushes } = fakeAdapter();
    startScheduleSync({ adapter });
    usePassesStore.setState({ wallet: { balance: 1 } as never });
    vi.advanceTimersByTime(300);
    expect(pushes).toHaveLength(1);
  });

  it('stops pushing once stopped, including a push that was waiting', () => {
    const { adapter, pushes } = fakeAdapter();
    const stop = startScheduleSync({ adapter });
    useEventsStore.setState({ events: [] });
    stop();
    vi.advanceTimersByTime(1000);
    useEventsStore.setState({ events: [event('z')] });
    vi.advanceTimersByTime(1000);
    expect(pushes).toHaveLength(1);
  });

  it('reports a rejected push instead of throwing, and keeps syncing', async () => {
    const errors: unknown[] = [];
    let attempts = 0;
    const adapter: AlarmAdapter = {
      setSchedule: () => {
        attempts++;
        return attempts === 1 ? Promise.reject(new Error('bridge down')) : Promise.resolve();
      },
      drainCompletions: () => Promise.resolve([]),
      getPermissionStatus: () => Promise.reject(new Error('unused')),
      openPermissionSettings: () => Promise.resolve(),
    };
    startScheduleSync({ adapter, onError: (error) => errors.push(error) });
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveLength(1);

    useEventsStore.setState({ events: [] });
    await vi.advanceTimersByTimeAsync(300);
    expect(attempts).toBe(2);
  });
});
