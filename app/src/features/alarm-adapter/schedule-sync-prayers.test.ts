import { DEFAULT_PRAYER_SETTINGS } from '@alarm-calendar/core';
import type { AlarmAdapter, EventRow, SchedulePayload, Settings } from '@alarm-calendar/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fake } from '@/test/fake-supabase';

vi.mock('@/lib/supabase', async () => {
  const { fakeClient } = await import('@/test/fake-supabase');
  return { supabase: fakeClient };
});

import { useCompletionsStore } from '@/features/completions/completions-store';
import { useEventsStore } from '@/features/events/events-store';
import { usePassesStore } from '@/features/passes/passes-store';
import { useSettingsStore } from '@/features/settings/settings-store';
import { resetSoundIdForTests, setPrayerSoundId } from '@/features/settings/sound-preference';

import { startScheduleSync } from './schedule-sync';

const SETTINGS: Settings = {
  user_id: 'u1',
  timezone: 'Africa/Tunis',
  week_starts_on: 0,
  refire_seconds: 120,
  pass_cap: 2,
  grace_minutes: 30,
  ...DEFAULT_PRAYER_SETTINGS,
  prayers_enabled: true,
  prayers_enabled_since: '2026-09-01T00:00:00.000Z',
};

const NOW = new Date('2026-10-06T09:00:00.000Z');

function prayerRow(kind: 'prayer' | 'pre_prayer', prayer: 'dhuhr' | 'asr'): EventRow {
  return {
    id: `${kind}-${prayer}`.replace('_', '-'),
    user_id: 'u1',
    title: prayer,
    notes: null,
    start_at: '2026-09-01T00:00:00.000Z',
    duration_min: 15,
    repeat_unit: 'day',
    repeat_interval: 1,
    repeat_weekdays: null,
    ends_at: null,
    max_snoozes: 0,
    snooze_minutes: 5,
    passable: false,
    color: null,
    active: true,
    updated_at: '2026-09-01T00:00:00.000Z',
    kind,
    prayer,
  };
}

function fakeAdapter() {
  const pushes: SchedulePayload[] = [];
  const adapter: AlarmAdapter = {
    setSchedule: (payload) => {
      pushes.push(payload);
      return Promise.resolve();
    },
    drainCompletions: () => Promise.resolve([]),
    getPendingDoneOccurrences: () => Promise.resolve([]),
    getPermissionStatus: () => Promise.reject(new Error('unused')),
    openPermissionSettings: () => Promise.resolve(),
  };
  return { adapter, pushes };
}

beforeEach(() => {
  fake.reset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetSoundIdForTests();
  useSettingsStore.setState({ settings: SETTINGS });
  useEventsStore.setState({
    events: [prayerRow('prayer', 'dhuhr'), prayerRow('pre_prayer', 'dhuhr')],
    status: 'ready',
    error: null,
  });
  usePassesStore.setState({ cheatDays: [] });
  useCompletionsStore.setState({ completions: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the schedule push with prayers', () => {
  it('carries the prayer alarms, the prayer settings and the prayer sound to the engine', () => {
    setPrayerSoundId('custom');
    const { adapter, pushes } = fakeAdapter();
    startScheduleSync({ adapter });
    const payload = pushes.at(-1)!;
    expect(payload.settings).toMatchObject({ prayers_enabled: true, latitude: 36.8625, prayerSound: 'custom' });
    expect(payload.eventInfo['prayer-dhuhr']).toMatchObject({ kind: 'prayer', prayer: 'dhuhr', soundId: 'custom' });
    expect(payload.occurrences.some((occurrence) => occurrence.eventId === 'prayer-dhuhr')).toBe(true);
    expect(payload.occurrences.some((occurrence) => occurrence.eventId === 'pre-prayer-dhuhr' && occurrence.label !== undefined)).toBe(true);
  });

  it('pushes again when the prayer sound changes', () => {
    const { adapter, pushes } = fakeAdapter();
    startScheduleSync({ adapter });
    expect(pushes.at(-1)?.settings.prayerSound).toBeUndefined();
    setPrayerSoundId('chime');
    vi.advanceTimersByTime(300);
    expect(pushes.at(-1)?.settings.prayerSound).toBe('chime');
  });

  it('pushes again when prayers are switched off, with the prayer alarms gone from the schedule', () => {
    const { adapter, pushes } = fakeAdapter();
    startScheduleSync({ adapter });
    useSettingsStore.setState({ settings: { ...SETTINGS, prayers_enabled: false } });
    vi.advanceTimersByTime(300);
    const payload = pushes.at(-1)!;
    expect(payload.occurrences).toEqual([]);
    expect(payload.eventInfo).toEqual({});
  });
});
