import type { EventRow, ExamRow, Settings } from '@alarm-calendar/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fake } from '@/test/fake-supabase';

vi.mock('@/lib/supabase', async () => {
  const { fakeClient } = await import('@/test/fake-supabase');
  return { supabase: fakeClient };
});

const bridge = vi.hoisted(() => ({ pendingDone: [] as string[], fails: false }));
vi.mock('@/features/alarm-adapter/create-alarm-adapter', () => ({
  getAlarmAdapter: () => ({
    getPendingDoneOccurrences: () => (bridge.fails ? Promise.reject(new Error('bridge')) : Promise.resolve(bridge.pendingDone)),
  }),
}));

import { resetGroupIdColumnProbe } from '@/features/events/events-api';
import { useEventsStore } from '@/features/events/events-store';
import { BUILTIN_MODES, SICK_ID, activationRow } from '@/features/modes/mode-fixtures';
import { useModesStore } from '@/features/modes/modes-store';
import { usePassesStore } from '@/features/passes/passes-store';
import { useSettingsStore } from '@/features/settings/settings-store';

import { resetCatchUps, runCatchUps, startCatchUpSync } from './catch-up-sync';
import { resetExams, useExamsStore } from './exams-store';

const EXAM_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SETTINGS: Settings = {
  user_id: 'u1',
  timezone: 'UTC',
  week_starts_on: 0,
  refire_seconds: 120,
  pass_cap: 2,
  grace_minutes: 30,
};

const exam: ExamRow = {
  id: EXAM_ID,
  user_id: 'u1',
  title: 'Maths',
  exam_at: '2026-03-20T09:00:00.000Z',
  difficulty: 2,
  notes: null,
  active: true,
  created_at: '2026-03-01T00:00:00.000Z',
  updated_at: '2026-03-01T00:00:00.000Z',
};

function session(overrides: Partial<EventRow> & { id: string; start_at: string }): EventRow {
  return {
    user_id: 'u1',
    title: 'Revise Maths',
    notes: null,
    duration_min: 45,
    repeat_unit: 'none',
    repeat_interval: 1,
    repeat_weekdays: null,
    ends_at: null,
    max_snoozes: 3,
    snooze_minutes: 5,
    passable: true,
    color: null,
    active: true,
    updated_at: '2026-03-01T00:00:00.000Z',
    exam_id: EXAM_ID,
    exam_role: 'session',
    ...overrides,
  };
}

const MISSED = session({ id: 's1', start_at: '2026-03-13T18:00:00.000Z' });
const LATER = session({ id: 's2', start_at: '2026-03-17T18:00:00.000Z' });
// 19:00 on the 13th: grace (30 min) and the settle time (10 min) are long over.
const NOW = new Date('2026-03-13T19:00:00.000Z');

/** What the database returns for the catch-up of `MISSED` created at NOW (halfway is 22:00 on the 16th, so 21:00). */
const CREATED = session({
  id: 'c1',
  start_at: '2026-03-16T21:00:00.000Z',
  catch_up_of: 's1',
  title: 'Catch-up: revise Maths',
});

function arrange(events: EventRow[] = [MISSED, LATER]): void {
  useSettingsStore.setState({ settings: SETTINGS });
  useEventsStore.setState({ events, status: 'ready', error: null });
  useExamsStore.setState({ exams: [exam], status: 'ready', completions: [], completionsStatus: 'ready' });
  usePassesStore.setState({ cheatDays: [] });
  fake.responses['select:completions'] = { data: [], error: null };
  fake.responses['upsert:events'] = { data: [CREATED], error: null };
}

beforeEach(() => {
  fake.reset();
  useModesStore.setState({ modes: [], rules: [], activations: [], status: 'idle', error: null });
  resetGroupIdColumnProbe();
  resetExams();
  resetCatchUps();
  bridge.pendingDone = [];
  bridge.fails = false;
});

describe('runCatchUps', () => {
  it('gives a missed session one catch-up, written as an insert that does nothing on conflict', async () => {
    arrange();

    expect(await runCatchUps(NOW)).toBe(1);

    expect(fake.names()).toEqual(['select:completions', 'upsert:events']);
    expect(fake.upsertOptions).toEqual([{ onConflict: 'catch_up_of', ignoreDuplicates: true }]);
    const [row] = fake.payloadOf('upsert:events') as Array<Record<string, unknown>>;
    expect(row).toMatchObject({
      catch_up_of: 's1',
      exam_id: EXAM_ID,
      exam_role: 'session',
      repeat_unit: 'none',
      start_at: '2026-03-16T21:00:00.000Z',
    });
    expect(useEventsStore.getState().events.map((event) => event.id)).toContain('c1');
  });

  it('gives no catch-up for a session that Sick mode paused, and one once the mode no longer covers it', async () => {
    arrange();
    useModesStore.setState({
      modes: BUILTIN_MODES,
      rules: [],
      // Sick since the morning of the 13th, still on: the 18:00 session on the 13th was paused, not missed.
      activations: [activationRow(SICK_ID, '2026-03-13T06:00:00.000Z', null)],
      status: 'ready',
      error: null,
    });
    expect(await runCatchUps(NOW)).toBe(0);
    expect(fake.names()).toEqual([]);

    // Switched back to normal before the session: it was missed after all.
    useModesStore.setState({ activations: [activationRow(SICK_ID, '2026-03-13T06:00:00.000Z', '2026-03-13T12:00:00.000Z')] });
    expect(await runCatchUps(NOW)).toBe(1);
  });

  it('checks the missed session against the database first, so a Done not yet synced here makes no catch-up', async () => {
    arrange();
    fake.responses['select:completions'] = {
      data: [{ id: 'k1', user_id: 'u1', event_id: 's1', occurrence_at: MISSED.start_at, status: 'done', snoozes_used: 0, done_at: MISSED.start_at }],
      error: null,
    };

    expect(await runCatchUps(NOW)).toBe(0);
    expect(fake.names()).toEqual(['select:completions']);
    expect(fake.filters).toEqual([{ op: 'in', args: ['event_id', ['s1']] }]);

    // It is remembered: the next run does not ask again.
    fake.calls = [];
    expect(await runCatchUps(NOW)).toBe(0);
    expect(fake.names()).toEqual([]);
  });

  it('a Done pressed offline on this device (not yet saved) makes no catch-up, even though the database has no completion', async () => {
    arrange();
    bridge.pendingDone = [`${MISSED.id}@${MISSED.start_at}`];

    expect(await runCatchUps(NOW)).toBe(0);
    expect(fake.names()).toEqual(['select:completions']);

    fake.calls = [];
    expect(await runCatchUps(NOW)).toBe(0);
    expect(fake.names()).toEqual([]);
  });

  it('writes nothing, and tries again later, when the device cannot say which Done presses are waiting', async () => {
    arrange();
    bridge.fails = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await runCatchUps(NOW)).toBe(0);
    expect(fake.names()).toEqual(['select:completions']);

    bridge.fails = false;
    expect(await runCatchUps(NOW)).toBe(1);
    warn.mockRestore();
  });

  it('switches off a catch-up still to come when its session has since been completed', async () => {
    const catchUp = session({ id: 'c1', start_at: '2026-03-16T21:00:00.000Z', catch_up_of: 's1' });
    arrange([MISSED, LATER, catchUp]);
    useExamsStore.setState({
      completions: [
        { id: 'k1', user_id: 'u1', event_id: 's1', occurrence_at: MISSED.start_at, status: 'done', snoozes_used: 0, done_at: NOW.toISOString() },
      ],
    });
    fake.responses['update:events'] = { data: [{ id: 'c1' }], error: null };

    expect(await runCatchUps(NOW)).toBe(0);

    expect(fake.names()).toEqual(['update:events']);
    expect(fake.payloadOf('update:events')).toEqual({ active: false });
    expect(fake.filters).toEqual([{ op: 'in', args: ['id', ['c1']] }]);
    expect(useEventsStore.getState().events.map((event) => event.id)).toEqual(['s1', 's2']);
  });

  it('leaves a catch-up alone once its time has passed, completed session or not', async () => {
    const catchUp = session({ id: 'c1', start_at: '2026-03-16T21:00:00.000Z', catch_up_of: 's1' });
    arrange([MISSED, LATER, catchUp]);
    useExamsStore.setState({
      completions: [
        { id: 'k1', user_id: 'u1', event_id: 's1', occurrence_at: MISSED.start_at, status: 'done', snoozes_used: 0, done_at: NOW.toISOString() },
      ],
    });
    expect(await runCatchUps(new Date('2026-03-16T22:00:00.000Z'))).toBe(0);
    expect(fake.names()).toEqual([]);
  });

  it('a trigger during a run is not lost: one more run follows, and no run overlaps another', async () => {
    arrange();
    let answer: (value: { data: unknown; error: null }) => void = () => undefined;
    fake.queued['select:completions'] = [new Promise((resolve) => (answer = resolve))];

    const first = runCatchUps(NOW);
    // The run has read the stores and is waiting for the database; now another session turns out missed.
    await Promise.resolve();
    useEventsStore.setState({ events: [session({ id: 's0', start_at: '2026-03-13T12:00:00.000Z' }), MISSED, LATER] });
    expect(await runCatchUps(NOW)).toBe(0);
    expect(fake.names()).toEqual(['select:completions']);

    answer({ data: [], error: null });
    // The first run's catch-up (for s1) plus the follow-up run's (for s0).
    expect(await first).toBe(2);
    const written = fake.calls.filter((call) => call.name === 'upsert:events').map((call) => (call.payload as Array<{ catch_up_of: string }>)[0]?.catch_up_of);
    expect(written).toEqual(['s1', 's0']);
  });

  it('is idempotent: a second run, with the catch-up now in the list, writes nothing', async () => {
    arrange();
    await runCatchUps(NOW);
    fake.calls = [];

    expect(await runCatchUps(NOW)).toBe(0);
    expect(fake.names()).toEqual([]);
  });

  it('never makes a catch-up for a missed catch-up', async () => {
    arrange([MISSED, CREATED, LATER]);
    // The catch-up of the 16th at 21:00 is missed on the 17th.
    expect(await runCatchUps(new Date('2026-03-17T10:00:00.000Z'))).toBe(0);
    expect(fake.names()).toEqual([]);
  });

  it('two devices noticing the same miss end with one catch-up: the second insert conflicts and adds nothing', async () => {
    // Device one.
    arrange();
    await runCatchUps(NOW);
    const first = useEventsStore.getState().events.filter((event) => event.catch_up_of === 's1');
    expect(first).toHaveLength(1);

    // Device two has not seen the first catch-up yet (its list is from before) and runs the same check. The
    // database answers the conflicting insert with no row.
    resetCatchUps();
    arrange();
    fake.responses['upsert:events'] = { data: [], error: null };
    expect(await runCatchUps(new Date(NOW.getTime() + 60_000))).toBe(0);

    expect(fake.upsertOptions.at(-1)).toEqual({ onConflict: 'catch_up_of', ignoreDuplicates: true });
    expect(useEventsStore.getState().events.filter((event) => event.catch_up_of === 's1')).toHaveLength(0);
    // And it does not try again on the next tick.
    fake.calls = [];
    expect(await runCatchUps(new Date(NOW.getTime() + 120_000))).toBe(0);
    expect(fake.names()).toEqual([]);
  });

  it('does nothing while the session can still ring or is inside the settle time', async () => {
    arrange();
    expect(await runCatchUps(new Date('2026-03-13T18:35:00.000Z'))).toBe(0);
    expect(fake.names()).toEqual([]);
  });

  it('leaves a session silenced by a cheat day alone', async () => {
    arrange();
    usePassesStore.setState({ cheatDays: ['2026-03-13'] });
    expect(await runCatchUps(NOW)).toBe(0);
    expect(fake.names()).toEqual([]);
  });

  it('does nothing before the first load has finished', async () => {
    arrange();
    useExamsStore.setState({ status: 'loading' });
    expect(await runCatchUps(NOW)).toBe(0);
    useExamsStore.setState({ status: 'ready' });
    useEventsStore.setState({ status: 'loading' });
    expect(await runCatchUps(NOW)).toBe(0);
    expect(fake.names()).toEqual([]);
  });

  it('writes nothing when the check against the database fails, and tries again next time', async () => {
    arrange();
    fake.responses['select:completions'] = { data: null, error: { message: 'offline' } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await runCatchUps(NOW)).toBe(0);
    expect(fake.names()).toEqual(['select:completions']);

    fake.calls = [];
    fake.responses['select:completions'] = { data: [], error: null };
    expect(await runCatchUps(NOW)).toBe(1);
    expect(fake.names()).toEqual(['select:completions', 'upsert:events']);
    warn.mockRestore();
  });

  it('tries again later when the insert itself fails', async () => {
    arrange();
    fake.responses['upsert:events'] = { data: null, error: { message: 'offline' } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await runCatchUps(NOW)).toBe(0);
    expect(useEventsStore.getState().events.map((event) => event.id)).toEqual(['s1', 's2']);

    fake.responses['upsert:events'] = { data: [CREATED], error: null };
    expect(await runCatchUps(NOW)).toBe(1);
    warn.mockRestore();
  });
});

describe('startCatchUpSync', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs the check after a short delay, again when a store changes, and stops when told to', async () => {
    vi.setSystemTime(NOW);
    arrange();
    const focusTarget = { addEventListener: vi.fn(), removeEventListener: vi.fn() };

    const stop = startCatchUpSync({ debounceMs: 1000, intervalMs: 300_000, focusTarget });
    expect(fake.names()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.names()).toEqual(['select:completions', 'upsert:events']);
    expect(focusTarget.addEventListener).toHaveBeenCalledWith('focus', expect.any(Function));

    // A realtime change lands in a store: the check runs again (and finds nothing left to do).
    fake.calls = [];
    useEventsStore.setState({ events: [...useEventsStore.getState().events] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.names()).toEqual([]);

    stop();
    expect(focusTarget.removeEventListener).toHaveBeenCalledWith('focus', expect.any(Function));
    resetCatchUps();
    fake.calls = [];
    useEventsStore.setState({ events: [MISSED, LATER] });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.names()).toEqual([]);
  });

  it('notices a session turning missed with the passing of time, without any store change', async () => {
    // Not yet past the settle time when the check starts.
    vi.setSystemTime(new Date('2026-03-13T18:35:00.000Z'));
    arrange();
    const focusTarget = { addEventListener: vi.fn(), removeEventListener: vi.fn() };

    const stop = startCatchUpSync({ debounceMs: 1000, intervalMs: 300_000, focusTarget });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.names()).toEqual([]);

    await vi.advanceTimersByTimeAsync(300_000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.names()).toEqual(['select:completions', 'upsert:events']);
    stop();
  });
});
