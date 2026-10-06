import type { AlarmAdapter, EventRow, ExamRow, SchedulePayload, Settings } from '@alarm-calendar/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', async () => {
  const { fakeClient } = await import('@/test/fake-supabase');
  return { supabase: fakeClient };
});

import { useCompletionsStore } from '@/features/completions/completions-store';
import { useEventsStore } from '@/features/events/events-store';
import { useExamsStore } from '@/features/exams/exams-store';
import { BUILTIN_MODES, EXAM_MODE_ID, SICK_ID, activationRow, ruleRow } from '@/features/modes/mode-fixtures';
import { useModesStore } from '@/features/modes/modes-store';
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
  exam_mode_days_before: 3,
};

const NOW = new Date('2026-03-02T09:00:00.000Z');
const DEBOUNCE = 300;

const daily = (id: string, overrides: Partial<EventRow> = {}): EventRow => ({
  id,
  user_id: 'u1',
  title: id,
  notes: null,
  start_at: '2026-03-02T10:00:00.000Z',
  duration_min: 15,
  repeat_unit: 'day',
  repeat_interval: 1,
  repeat_weekdays: null,
  ends_at: null,
  max_snoozes: 3,
  snooze_minutes: 5,
  passable: true,
  color: null,
  active: true,
  updated_at: '2026-03-01T10:00:00.000Z',
  ...overrides,
});

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

const ringsOf = (payload: SchedulePayload | undefined, eventId: string): number =>
  payload?.occurrences.filter((o) => o.eventId === eventId).length ?? 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetSoundIdForTests();
  useSettingsStore.setState({ settings: SETTINGS });
  useEventsStore.setState({ events: [daily('gym'), daily('meds', { passable: false })], status: 'ready', error: null });
  usePassesStore.setState({ cheatDays: [] });
  useCompletionsStore.setState({ completions: [] });
  useExamsStore.setState({ exams: [], status: 'ready' });
  useModesStore.setState({ modes: [], rules: [], activations: [], status: 'ready', error: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the schedule push and modes', () => {
  it('with no mode at all, pushes a payload with no modes key (as before modes existed)', () => {
    const { adapter, pushes } = fakeAdapter();
    startScheduleSync({ adapter });
    expect('modes' in (pushes[0]?.refillSource ?? {})).toBe(false);
    expect(ringsOf(pushes[0], 'gym')).toBeGreaterThan(55);
  });

  it('a manual switch to Sick pauses the passable alarm in the next push, and leaves the medication ringing', () => {
    const { adapter, pushes } = fakeAdapter();
    startScheduleSync({ adapter });
    useModesStore.setState({ modes: BUILTIN_MODES, activations: [activationRow(SICK_ID, '2026-03-02T08:00:00.000Z', null)] });
    vi.advanceTimersByTime(DEBOUNCE);
    expect(pushes).toHaveLength(2);
    const last = pushes[1]!;
    expect(ringsOf(last, 'gym')).toBe(0);
    expect(ringsOf(last, 'meds')).toBeGreaterThan(55);
    // The alarm is still known (eventInfo), so a ringing one is not dismissed as deleted, and main can refill.
    expect(Object.keys(last.eventInfo).sort()).toEqual(['gym', 'meds']);
    expect(last.refillSource.modes?.activations).toHaveLength(1);
  });

  it('switching back to normal (the activation gets an end) brings the alarm back', () => {
    const { adapter, pushes } = fakeAdapter();
    const open = activationRow(SICK_ID, '2026-03-02T08:00:00.000Z', null);
    useModesStore.setState({ modes: BUILTIN_MODES, activations: [open] });
    startScheduleSync({ adapter });
    expect(ringsOf(pushes[0], 'gym')).toBe(0);
    useModesStore.setState({ activations: [{ ...open, ends_at: '2026-03-02T09:00:00.000Z' }] });
    vi.advanceTimersByTime(DEBOUNCE);
    expect(ringsOf(pushes[1], 'gym')).toBeGreaterThan(55);
  });

  it('a rule change re-pushes: a shifted alarm rings at its new time', () => {
    const { adapter, pushes } = fakeAdapter();
    useModesStore.setState({ modes: BUILTIN_MODES, activations: [activationRow(SICK_ID, '2026-03-02T08:00:00.000Z', null)] });
    startScheduleSync({ adapter });
    useModesStore.setState({ rules: [ruleRow(SICK_ID, 'gym', { behavior: 'shift', shift_minutes: 90 })] });
    vi.advanceTimersByTime(DEBOUNCE);
    expect(pushes[1]?.occurrences.find((o) => o.eventId === 'gym')?.at).toBe('2026-03-02T11:30:00.000Z');
  });

  it('moving an exam moves Exam mode\'s automatic window, and the alarms it pauses, with a new push', () => {
    const { adapter, pushes } = fakeAdapter();
    const examMode = BUILTIN_MODES.map((m) => (m.id === EXAM_MODE_ID ? { ...m, default_behavior: 'skip' as const } : m));
    useModesStore.setState({ modes: examMode });
    const exam = (examAt: string): ExamRow => ({
      id: 'x1',
      user_id: 'u1',
      title: 'Maths',
      exam_at: examAt,
      difficulty: 2,
      notes: null,
      active: true,
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:00:00.000Z',
    });
    // Exam on the 10th, 3 days lead: the window is the 7th to the end of the 11th.
    useExamsStore.setState({ exams: [exam('2026-03-10T09:00:00.000Z')] });
    startScheduleSync({ adapter });
    const gymDays = (p: SchedulePayload | undefined) => p?.occurrences.filter((o) => o.eventId === 'gym').map((o) => o.at.slice(5, 10));
    expect(gymDays(pushes[0])).toContain('03-06');
    expect(gymDays(pushes[0])).not.toContain('03-09');
    useExamsStore.setState({ exams: [exam('2026-03-20T09:00:00.000Z')] });
    vi.advanceTimersByTime(DEBOUNCE);
    expect(gymDays(pushes[1])).toContain('03-09');
    expect(gymDays(pushes[1])).not.toContain('03-18');
  });

  it('changing the exam lead in the settings re-pushes', () => {
    const { adapter, pushes } = fakeAdapter();
    useModesStore.setState({ modes: BUILTIN_MODES.map((m) => (m.id === EXAM_MODE_ID ? { ...m, default_behavior: 'skip' as const } : m)) });
    useExamsStore.setState({ exams: [{ id: 'x1', title: 'Maths', exam_at: '2026-03-10T09:00:00.000Z', active: true } as ExamRow] });
    startScheduleSync({ adapter });
    expect(pushes[0]?.occurrences.some((o) => o.eventId === 'gym' && o.at.startsWith('2026-03-06'))).toBe(true);
    useSettingsStore.setState({ settings: { ...SETTINGS, exam_mode_days_before: 10 } });
    vi.advanceTimersByTime(DEBOUNCE);
    expect(pushes[1]?.occurrences.some((o) => o.eventId === 'gym' && o.at.startsWith('2026-03-06'))).toBe(false);
  });
});
