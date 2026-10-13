import type {
  AlarmAdapter,
  CompletionRow,
  EventRow,
  SchedulePayload,
  Settings,
} from '@alarm-calendar/core';
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

const NOW = new Date('2026-03-02T09:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// A one-off alarm an hour from NOW.
const event = (id: string): EventRow => ({
  id,
  user_id: 'u1',
  title: id,
  notes: null,
  start_at: '2026-03-02T10:00:00.000Z',
  duration_min: 15,
  repeat_unit: 'none',
  repeat_interval: 1,
  repeat_weekdays: null,
  ends_at: null,
  max_snoozes: 3,
  snooze_minutes: 5,
  passable: true,
  color: null,
  active: true,
  updated_at: '2026-03-01T10:00:00.000Z',
});

function fakeAdapter() {
  const pushes: SchedulePayload[] = [];
  const adapter: AlarmAdapter = {
    setSchedule: (payload) => {
      pushes.push(payload);
      return Promise.resolve();
    },
    peekCompletions: () => Promise.resolve([]),
    ackCompletions: () => Promise.resolve(),
    getPendingDoneOccurrences: () => Promise.resolve([]),
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
  vi.setSystemTime(NOW);
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
    expect(pushes[0]).toMatchObject({
      version: 2,
      generatedAt: NOW.toISOString(),
      settings: { ...SETTINGS, sound: 'bell' },
      eventInfo: { a: { title: 'a', soundId: 'bell' } },
    });
    expect(pushes[0]?.refillSource.events.map((e) => e.id)).toEqual(['a']);
    expect(pushes[0]?.refillSource.cheatDays).toEqual(['2026-03-04']);
  });

  it('pushes the concrete occurrences for the next 60 days, not the events', () => {
    const { adapter, pushes } = fakeAdapter();
    useEventsStore.setState({
      events: [{ ...event('a'), repeat_unit: 'day', title: 'Stretch' }],
      status: 'ready',
      error: null,
    });
    startScheduleSync({ adapter });

    const payload = pushes[0]!;
    expect(payload.occurrences).toHaveLength(60);
    expect(payload.occurrences[0]).toMatchObject({
      id: 'a@2026-03-02T10:00:00.000Z',
      silenced: false,
      completed: false,
    });
    expect(payload.eventInfo.a).toMatchObject({ title: 'Stretch', soundId: 'bell' });
    expect(payload.horizonEnd).toBe('2026-05-01T09:00:00.000Z');
  });

  it('marks an occurrence on a cheat day as silenced', () => {
    const { adapter, pushes } = fakeAdapter();
    usePassesStore.setState({ cheatDays: ['2026-03-02'] });
    startScheduleSync({ adapter });
    expect(pushes[0]?.occurrences.map((o) => o.silenced)).toEqual([true]);
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
    expect(Object.keys(pushes[1]?.eventInfo ?? {})).toEqual(['a', 'b']);
  });

  it('pushes the new cheat days after a pass is spent or refunded', () => {
    const { adapter, pushes } = fakeAdapter();
    startScheduleSync({ adapter });
    usePassesStore.setState({ cheatDays: ['2026-03-04', '2026-03-06'] });
    vi.advanceTimersByTime(300);
    expect(pushes.at(-1)?.refillSource.cheatDays).toEqual(['2026-03-04', '2026-03-06']);
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
    expect(pushes.at(-1)?.eventInfo.a?.soundId).toBe('chime');
  });

  it('folds synced completions into the list so a done occurrence is not rung again', () => {
    const { adapter, pushes } = fakeAdapter();
    startScheduleSync({ adapter });
    const done = { id: 'c1', event_id: 'a', occurrence_at: '2026-03-02T10:00:00+00:00' } as CompletionRow;
    useCompletionsStore.setState({ completions: [done] });
    vi.advanceTimersByTime(300);
    expect(pushes.at(-1)?.occurrences.map((o) => o.completed)).toEqual([true]);
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

  it('pushes again when the window gains focus, with a fresh expansion', () => {
    const { adapter, pushes } = fakeAdapter();
    const focusTarget = new EventTarget();
    startScheduleSync({ adapter, focusTarget });
    vi.setSystemTime(new Date(NOW.getTime() + 3 * HOUR_MS));
    focusTarget.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(300);

    expect(pushes).toHaveLength(2);
    expect(pushes[1]?.generatedAt).toBe('2026-03-02T12:00:00.300Z');
  });

  it('skips a focus push while the inputs are unchanged and the last push is under an hour old', () => {
    const { adapter, pushes } = fakeAdapter();
    const focusTarget = new EventTarget();
    startScheduleSync({ adapter, focusTarget });

    vi.setSystemTime(new Date(NOW.getTime() + 59 * 60 * 1000));
    focusTarget.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(300);
    expect(pushes).toHaveLength(1);

    // Past the hour the list is renewed even though nothing changed.
    vi.setSystemTime(new Date(NOW.getTime() + 61 * 60 * 1000));
    focusTarget.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(300);
    expect(pushes).toHaveLength(2);
    expect(pushes[1]?.generatedAt).not.toBe(pushes[0]?.generatedAt);
  });

  it('pushes on focus when an input changed since the last push, even inside the hour', () => {
    const { adapter, pushes } = fakeAdapter();
    const focusTarget = new EventTarget();
    startScheduleSync({ adapter, focusTarget });
    usePassesStore.setState({ cheatDays: ['2026-03-04', '2026-03-05'] });
    focusTarget.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(300);
    // The change and the focus share one debounced push.
    expect(pushes).toHaveLength(2);
    expect(pushes[1]?.refillSource.cheatDays).toEqual(['2026-03-04', '2026-03-05']);
  });

  it('expands again after a refused push instead of trusting the memo', async () => {
    let attempts = 0;
    const adapter: AlarmAdapter = {
      setSchedule: () => {
        attempts++;
        return attempts === 1 ? Promise.reject(new Error('bridge down')) : Promise.resolve();
      },
      peekCompletions: () => Promise.resolve([]),
      ackCompletions: () => Promise.resolve(),
      getPendingDoneOccurrences: () => Promise.resolve([]),
      getPermissionStatus: () => Promise.reject(new Error('unused')),
      openPermissionSettings: () => Promise.resolve(),
    };
    const focusTarget = new EventTarget();
    startScheduleSync({ adapter, focusTarget, onError: () => undefined });
    await vi.advanceTimersByTimeAsync(0);
    focusTarget.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(300);
    expect(attempts).toBe(2);
  });

  it('pushes once a day even when nothing changed, and stops doing so once stopped', () => {
    const { adapter, pushes } = fakeAdapter();
    const focusTarget = new EventTarget();
    const stop = startScheduleSync({ adapter, focusTarget });
    vi.advanceTimersByTime(DAY_MS + 300);
    expect(pushes).toHaveLength(2);
    expect(pushes[1]?.generatedAt).not.toBe(pushes[0]?.generatedAt);

    stop();
    vi.advanceTimersByTime(3 * DAY_MS);
    focusTarget.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(300);
    expect(pushes).toHaveLength(2);
  });

  it('still pushes the rest, and reports it, when one event cannot be expanded', () => {
    const errors: unknown[] = [];
    const { adapter, pushes } = fakeAdapter();
    useEventsStore.setState({
      events: [event('a'), { ...event('bad'), repeat_unit: 'day', repeat_interval: 0 }],
      status: 'ready',
      error: null,
    });
    startScheduleSync({ adapter, onError: (error) => errors.push(error) });
    expect(pushes[0]?.occurrences.map((o) => o.eventId)).toEqual(['a']);
    expect(String(errors[0])).toContain('bad');
  });

  it('reports an unusable time zone instead of throwing, and pushes nothing', () => {
    const errors: unknown[] = [];
    const { adapter, pushes } = fakeAdapter();
    useSettingsStore.setState({ settings: { ...SETTINGS, timezone: 'Mars/Base' } });
    startScheduleSync({ adapter, onError: (error) => errors.push(error) });
    expect(pushes).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it('reports a rejected push instead of throwing, and keeps syncing', async () => {
    const errors: unknown[] = [];
    let attempts = 0;
    const adapter: AlarmAdapter = {
      setSchedule: () => {
        attempts++;
        return attempts === 1 ? Promise.reject(new Error('bridge down')) : Promise.resolve();
      },
      peekCompletions: () => Promise.resolve([]),
      ackCompletions: () => Promise.resolve(),
      getPendingDoneOccurrences: () => Promise.resolve([]),
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
