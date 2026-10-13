import type { AlarmAdapter, EventRow, SchedulePayload, Settings } from '@alarm-calendar/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', async () => {
  const { fakeClient } = await import('@/test/fake-supabase');
  return { supabase: fakeClient };
});

import { useCompletionsStore } from '@/features/completions/completions-store';
import { useEventsStore } from '@/features/events/events-store';
import { usePassesStore } from '@/features/passes/passes-store';
import { useSettingsStore } from '@/features/settings/settings-store';
import { resetSoundIdForTests } from '@/features/settings/sound-preference';

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

const EVENT: EventRow = {
  id: 'a',
  user_id: 'u1',
  title: 'a',
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
};

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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetSoundIdForTests();
  useSettingsStore.setState({ settings: SETTINGS });
  useEventsStore.setState({ events: [EVENT], status: 'ready', error: null });
  usePassesStore.setState({ cheatDays: [] });
  useCompletionsStore.setState({ completions: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startScheduleSync on Android resume', () => {
  it('pushes a fresh expansion when the app comes back after a while away', () => {
    const { adapter, pushes } = fakeAdapter();
    let resume: () => void = () => undefined;
    startScheduleSync({
      adapter,
      focusTarget: new EventTarget(),
      resumeSource: (callback) => {
        resume = callback;
        return () => undefined;
      },
    });

    vi.setSystemTime(new Date(NOW.getTime() + 5 * HOUR_MS));
    resume();
    vi.advanceTimersByTime(300);

    expect(pushes).toHaveLength(2);
    expect(pushes[1]?.generatedAt).toBe('2026-03-02T14:00:00.300Z');
  });

  it('does not push again for a resume right after a push with nothing changed', () => {
    const { adapter, pushes } = fakeAdapter();
    let resume: () => void = () => undefined;
    startScheduleSync({
      adapter,
      focusTarget: new EventTarget(),
      resumeSource: (callback) => {
        resume = callback;
        return () => undefined;
      },
    });

    resume();
    vi.advanceTimersByTime(300);
    expect(pushes).toHaveLength(1);
  });

  it('stops listening for resumes once stopped', () => {
    const { adapter } = fakeAdapter();
    const unsubscribe = vi.fn();
    const stop = startScheduleSync({
      adapter,
      focusTarget: new EventTarget(),
      resumeSource: () => unsubscribe,
    });

    expect(unsubscribe).not.toHaveBeenCalled();
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
