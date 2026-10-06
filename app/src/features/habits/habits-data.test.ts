import { computeHabitsReport, type EventRow } from '@alarm-calendar/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fake } from '@/test/fake-supabase';
import type { FakeResponse } from '@/test/fake-supabase';

vi.mock('@/lib/supabase', async () => {
  const { fakeClient } = await import('@/test/fake-supabase');
  return { supabase: fakeClient };
});

import { useCompletionsStore } from '@/features/completions/completions-store';
import { useEventsStore } from '@/features/events/events-store';
import { handleCompletionChange } from '@/features/realtime/realtime-handlers';

import { fetchHabitCompletions, type HabitCompletionRow } from './habits-api';
import {
  loadHabitCompletions,
  resetHabitCompletions,
  startHabitHistorySync,
  useHabitCompletionsStore,
} from './habits-store';
import {
  historySignature,
  longWindowHabits,
  partitionByCoverage,
  sortHabits,
  unrankedProgress,
  weeksLabel,
} from './habit-view';

const NOW = new Date('2026-03-10T12:00:00.000Z');

const march = (day: number): string => `2026-03-${String(day).padStart(2, '0')}T08:00:00Z`;

const row = (id: string, eventId: string, occurrenceAt: string, snoozes = 0): HabitCompletionRow => ({
  id,
  event_id: eventId,
  occurrence_at: occurrenceAt,
  status: 'done',
  snoozes_used: snoozes,
});

const dailyEvent = (id: string, start = march(5)): EventRow =>
  ({
    id,
    title: id,
    start_at: start,
    repeat_unit: 'day',
    repeat_interval: 1,
    repeat_weekdays: null,
    ends_at: null,
    active: true,
    passable: true,
    color: null,
  }) as EventRow;

function deferred() {
  let settle: (response: FakeResponse) => void = () => undefined;
  const promise = new Promise<FakeResponse>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (data: unknown) => settle({ data, error: null }) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  fake.reset();
  resetHabitCompletions();
  useCompletionsStore.setState({ completions: [] });
  useEventsStore.setState({ events: [], status: 'ready', error: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchHabitCompletions', () => {
  it('reads only the columns scoring needs', async () => {
    fake.responses['select:completions'] = { data: [], error: null };
    await fetchHabitCompletions(NOW);
    expect(fake.payloadOf('select:completions')).toBe('id, event_id, occurrence_at, status, snoozes_used');
  });

  it('keeps reading pages while they come back full and stops at the first short one', async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => row(`c${n}-${i}`, 'e', march(9)));
    fake.queued['select:completions'] = [
      Promise.resolve({ data: page(1000), error: null }),
      Promise.resolve({ data: page(3), error: null }),
    ];
    const result = await fetchHabitCompletions(NOW);
    expect(result.data).toHaveLength(1003);
    expect(fake.names().filter((name) => name === 'select:completions')).toHaveLength(2);
  });

  it('fails instead of returning a truncated list when the page cap is hit with a full last page', async () => {
    const full = () => Array.from({ length: 1000 }, (_, i) => row(`c${i}`, 'e', march(9)));
    fake.queued['select:completions'] = Array.from({ length: 5 }, () => Promise.resolve({ data: full(), error: null }));
    const result = await fetchHabitCompletions(NOW);
    expect(result.data).toBeNull();
    expect(result.error).toMatch(/too many completions/i);
  });

  it('accepts a fifth page that is short', async () => {
    const full = () => Array.from({ length: 1000 }, (_, i) => row(`c${i}`, 'e', march(9)));
    fake.queued['select:completions'] = [
      ...Array.from({ length: 4 }, () => Promise.resolve({ data: full(), error: null })),
      Promise.resolve({ data: [row('last', 'e', march(9))], error: null }),
    ];
    expect((await fetchHabitCompletions(NOW)).data).toHaveLength(4001);
  });

  it('reports a failure instead of returning a partial list', async () => {
    fake.responses['select:completions'] = { data: null, error: { message: 'boom' } };
    expect(await fetchHabitCompletions(NOW)).toEqual({ data: null, error: 'boom' });
  });
});

describe('habit completions store', () => {
  it('goes loading, then ready with the rows', async () => {
    fake.responses['select:completions'] = { data: [row('c1', 'e', march(9))], error: null };
    const pending = loadHabitCompletions();
    expect(useHabitCompletionsStore.getState().status).toBe('loading');
    await pending;
    expect(useHabitCompletionsStore.getState()).toMatchObject({ status: 'ready', error: null });
    expect(useHabitCompletionsStore.getState().completions.map((c) => c.id)).toEqual(['c1']);
  });

  it('shows an error on a failed first load, but keeps good data when a refetch fails', async () => {
    fake.responses['select:completions'] = { data: null, error: { message: 'offline' } };
    await loadHabitCompletions();
    expect(useHabitCompletionsStore.getState()).toMatchObject({ status: 'error', error: 'offline' });

    fake.responses['select:completions'] = { data: [row('c1', 'e', march(9))], error: null };
    await loadHabitCompletions();
    fake.responses['select:completions'] = { data: null, error: { message: 'offline' } };
    await loadHabitCompletions();
    expect(useHabitCompletionsStore.getState().status).toBe('ready');
    expect(useHabitCompletionsStore.getState().completions).toHaveLength(1);
  });

  it('drops an older response that answers after a newer one', async () => {
    const older = deferred();
    const newer = deferred();
    fake.queued['select:completions'] = [older.promise, newer.promise];
    const first = loadHabitCompletions();
    const second = loadHabitCompletions();
    newer.resolve([row('new', 'e', march(9))]);
    await second;
    older.resolve([row('old', 'e', march(9))]);
    await first;
    expect(useHabitCompletionsStore.getState().completions.map((c) => c.id)).toEqual(['new']);
  });
});

const repeating = (id: string, unit: EventRow['repeat_unit'], interval = 1): EventRow =>
  ({ ...dailyEvent(id), repeat_unit: unit, repeat_interval: interval }) as EventRow;

describe('extended history for slow habits', () => {
  it('asks for older rows of the weekly and monthly habits only, never of fast ones', async () => {
    useEventsStore.setState({
      events: [repeating('hourly', 'hour'), repeating('daily', 'day'), repeating('weekly', 'week'), repeating('monthly', 'month')],
    });
    fake.responses['select:completions'] = { data: [], error: null };

    await loadHabitCompletions();

    const inFilters = fake.filters.filter((filter) => filter.op === 'in');
    expect(inFilters).toHaveLength(1);
    expect(inFilters[0]?.args).toEqual(['event_id', ['weekly', 'monthly']]);
    // The longest window here is the monthly 150 days, so the extra read goes back 151 days.
    const since = fake.filters.filter((filter) => filter.op === 'gte').map((filter) => filter.args[1]);
    expect(since).toContain(new Date(NOW.getTime() - 151 * 86_400_000).toISOString());
    expect(fake.names().filter((name) => name === 'select:completions')).toHaveLength(2);
  });

  it('makes no extra request when every habit fits the 28-day bulk read', async () => {
    useEventsStore.setState({ events: [repeating('hourly', 'hour', 12), repeating('daily', 'day', 3)] });
    fake.responses['select:completions'] = { data: [], error: null };
    await loadHabitCompletions();
    expect(fake.filters.some((filter) => filter.op === 'in')).toBe(false);
    expect(fake.names().filter((name) => name === 'select:completions')).toHaveLength(1);
  });

  it('merges both reads, and a failed extended read fails the whole load', async () => {
    useEventsStore.setState({ events: [repeating('weekly', 'week')] });
    fake.queued['select:completions'] = [
      Promise.resolve({ data: [row('recent', 'weekly', march(9))], error: null }),
      Promise.resolve({ data: [row('older', 'weekly', '2026-02-05T08:00:00Z')], error: null }),
    ];
    await loadHabitCompletions();
    expect(useHabitCompletionsStore.getState().completions.map((c) => c.id)).toEqual(['recent', 'older']);

    useHabitCompletionsStore.setState({ completions: [], status: 'idle', error: null });
    fake.queued['select:completions'] = [
      Promise.resolve({ data: [], error: null }),
      Promise.resolve({ data: null, error: { message: 'boom' } }),
    ];
    expect(await loadHabitCompletions()).toEqual({ data: null, error: 'boom' });
    expect(useHabitCompletionsStore.getState().status).toBe('error');
  });

  it('reloads when a slow habit is added after the first load, but not for a fast one', async () => {
    fake.responses['select:completions'] = { data: [], error: null };
    await loadHabitCompletions();
    const stop = startHabitHistorySync();
    const reads = () => fake.names().filter((name) => name === 'select:completions').length;
    const before = reads();

    useEventsStore.setState({ events: [repeating('daily', 'day')] });
    await Promise.resolve();
    expect(reads()).toBe(before);

    useEventsStore.setState({ events: [repeating('daily', 'day'), repeating('weekly', 'week')] });
    await vi.waitFor(() => expect(reads()).toBe(before + 2));
    stop();
  });

  it('loads the history when the app becomes ready, not before: nothing is fetched until the sync starts', async () => {
    fake.responses['select:completions'] = { data: [], error: null };
    expect(fake.names()).not.toContain('select:completions');
    const stop = startHabitHistorySync();
    await vi.waitFor(() => expect(useHabitCompletionsStore.getState().status).toBe('ready'));
    stop();
  });

  it('records what the history covers, per slow habit', async () => {
    useEventsStore.setState({ events: [repeating('weekly', 'week'), repeating('daily', 'day')] });
    fake.responses['select:completions'] = { data: [], error: null };
    await loadHabitCompletions();
    expect(useHabitCompletionsStore.getState().coverage).toEqual({ weekly: 35 });
  });
});

describe('a habit whose window is not covered is never scored', () => {
  const settings = { timezone: 'UTC', grace_minutes: 30 };

  it('a failed reload after a window change leaves the habit pending, so it shows no misses', async () => {
    // Loaded as a weekly habit (35 days) with its history.
    const habit = repeating('h', 'week');
    useEventsStore.setState({ events: [habit] });
    fake.responses['select:completions'] = { data: [], error: null };
    await loadHabitCompletions();
    expect(useHabitCompletionsStore.getState().coverage).toEqual({ h: 35 });

    // The user makes it monthly (150 days); the reload for that fails.
    const monthly = repeating('h', 'month');
    useEventsStore.setState({ events: [monthly] });
    fake.responses['select:completions'] = { data: null, error: { message: 'offline' } };
    await loadHabitCompletions();

    const { status, coverage, completions } = useHabitCompletionsStore.getState();
    expect(status).toBe('ready');
    expect(coverage).toEqual({ h: 35 });
    const { covered, pending } = partitionByCoverage([monthly], coverage);
    expect(pending.map((event) => event.id)).toEqual(['h']);
    // Scoring only what is covered: no habit, so no misses and no overall score either.
    const report = computeHabitsReport(covered, completions, [], settings, NOW);
    expect(report.habits).toEqual([]);
    expect(report.overallScore).toBeNull();

    // Scoring it anyway would have charged every month before the loaded range as missed.
    const wrong = computeHabitsReport([monthly], completions, [], settings, NOW);
    expect(wrong.habits[0]?.missed).toBeGreaterThan(0);
  });

  it('a habit added since the last load is pending until its history arrives', () => {
    const { covered, pending } = partitionByCoverage([repeating('new-weekly', 'week'), repeating('daily', 'day')], {});
    expect(pending.map((event) => event.id)).toEqual(['new-weekly']);
    expect(covered.map((event) => event.id)).toEqual(['daily']);
  });
});

describe('realtime completion changes', () => {
  const payload = (id: string, occurrenceAt: string, snoozes = 0) => ({
    id,
    user_id: 'u1',
    event_id: 'e',
    occurrence_at: occurrenceAt,
    status: 'done',
    snoozes_used: snoozes,
    done_at: occurrenceAt,
  });

  it('reaches the 28-day list and the alarm engine list alike', () => {
    handleCompletionChange({ eventType: 'INSERT', new: payload('c1', '2026-03-10T08:00:00+00:00'), old: {} });
    expect(useHabitCompletionsStore.getState().completions.map((c) => c.id)).toEqual(['c1']);
    expect(useCompletionsStore.getState().completions.map((c) => c.id)).toEqual(['c1']);
  });

  it('keeps a completion from 20 days ago in the habit list only', () => {
    handleCompletionChange({ eventType: 'INSERT', new: payload('old', '2026-02-18T08:00:00Z'), old: {} });
    expect(useHabitCompletionsStore.getState().completions.map((c) => c.id)).toEqual(['old']);
    expect(useCompletionsStore.getState().completions).toEqual([]);
  });

  it('prunes a row by its own habit window: 29 days for a fast or unknown habit, window + 1 for a slow one', () => {
    useEventsStore.setState({ events: [repeating('weekly', 'week')] });
    const thirtyDaysAgo = new Date(NOW.getTime() - 30 * 86_400_000).toISOString();
    const fn = (id: string, eventId: string) => ({ ...payload(id, thirtyDaysAgo), event_id: eventId });
    handleCompletionChange({ eventType: 'INSERT', new: fn('weekly-30', 'weekly'), old: {} });
    handleCompletionChange({ eventType: 'INSERT', new: fn('unknown-30', 'unknown'), old: {} });
    expect(useHabitCompletionsStore.getState().completions.map((c) => c.id)).toEqual(['weekly-30']);

    const day = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
    handleCompletionChange({ eventType: 'INSERT', new: { ...payload('weekly-34', day(34)), event_id: 'weekly' }, old: {} });
    handleCompletionChange({ eventType: 'INSERT', new: { ...payload('weekly-40', day(40)), event_id: 'weekly' }, old: {} });
    expect(useHabitCompletionsStore.getState().completions.map((c) => c.id)).toEqual(['weekly-30', 'weekly-34']);
  });

  it('keeps older history for slow habits when a new completion arrives', () => {
    useEventsStore.setState({ events: [{ ...repeating('e', 'month') }] });
    const hundredDaysAgo = new Date(NOW.getTime() - 100 * 86_400_000).toISOString();
    useHabitCompletionsStore.setState({ completions: [row('monthly-old', 'e', hundredDaysAgo)] });
    handleCompletionChange({ eventType: 'INSERT', new: payload('c1', march(10)), old: {} });
    expect(useHabitCompletionsStore.getState().completions.map((c) => c.id).sort()).toEqual(['c1', 'monthly-old']);
  });

  it('matches an occurrence by instant, whatever the timestamp format', () => {
    handleCompletionChange({ eventType: 'INSERT', new: payload('c1', '2026-03-10T08:00:00Z'), old: {} });
    handleCompletionChange({ eventType: 'UPDATE', new: payload('c2', '2026-03-10 08:00:00+00', 2), old: {} });
    const rows = useHabitCompletionsStore.getState().completions;
    expect(rows.map((c) => c.id)).toEqual(['c2']);
  });

  it('a change that arrives while a load is in flight is not lost to that load', async () => {
    const slow = deferred();
    fake.queued['select:completions'] = [slow.promise];
    const load = loadHabitCompletions();

    handleCompletionChange({ eventType: 'INSERT', new: payload('live', march(10)), old: {} });
    handleCompletionChange({ eventType: 'DELETE', new: {}, old: { id: 'gone' } });
    // The server answered before it saw either change: it lacks 'live' and still lists 'gone'.
    slow.resolve([row('gone', 'e', march(9)), row('kept', 'e', march(8))]);
    await load;

    expect(useHabitCompletionsStore.getState().completions.map((c) => c.id).sort()).toEqual(['kept', 'live']);
  });

  it('removes by id on DELETE, which carries only the primary key', () => {
    handleCompletionChange({ eventType: 'INSERT', new: payload('c1', march(10)), old: {} });
    handleCompletionChange({ eventType: 'DELETE', new: {}, old: { id: 'c1' } });
    expect(useHabitCompletionsStore.getState().completions).toEqual([]);
  });

  it('moves the score when a Done arrives from another device', () => {
    const settings = { timezone: 'UTC', grace_minutes: 30 };
    for (const day of [5, 6, 7, 8, 9]) {
      handleCompletionChange({ eventType: 'INSERT', new: payload(`c${day}`, march(day)), old: {} });
    }
    const events = [dailyEvent('e')];
    const before = computeHabitsReport(events, useHabitCompletionsStore.getState().completions, [], settings, NOW);
    expect(before.habits[0]).toMatchObject({ done: 5, missed: 1, tier: 'gold' });

    // Mar 10 08:00 was missed; a late Done synced from the phone turns it into a done.
    handleCompletionChange({ eventType: 'INSERT', new: payload('c10', '2026-03-10T08:00:00+00:00'), old: {} });
    const after = computeHabitsReport(events, useHabitCompletionsStore.getState().completions, [], settings, NOW);
    expect(after.habits[0]).toMatchObject({ done: 6, missed: 0, tier: 'diamond', score: 100 });
  });
});

describe('habit view helpers', () => {
  it('finds the habits whose window is longer than 28 days', () => {
    const events = [
      repeating('hourly', 'hour'),
      repeating('weekly', 'week'),
      repeating('every-10-days', 'day', 10),
      repeating('monthly', 'month'),
      { ...repeating('inactive', 'month'), active: false },
      { ...repeating('once', 'none') },
    ];
    expect(longWindowHabits(events)).toEqual([
      { id: 'weekly', windowDays: 35 },
      { id: 'every-10-days', windowDays: 50 },
      { id: 'monthly', windowDays: 150 },
    ]);
    expect(historySignature(longWindowHabits(events))).toBe('every-10-days:50,monthly:150,weekly:35');
  });

  it('labels a window in whole weeks', () => {
    expect(weeksLabel(28)).toBe('4 weeks');
    expect(weeksLabel(35)).toBe('5 weeks');
    expect(weeksLabel(180)).toBe('26 weeks');
    expect(weeksLabel(7)).toBe('1 week');
  });

  const settings = { timezone: 'UTC', grace_minutes: 30 };

  it('sorts ranked habits by score, then unranked by how close they are, then by title', () => {
    const doneOn = (id: string, days: number[]) => days.map((day) => row(`${id}${day}`, id, march(day)));
    const young = (id: string) => dailyEvent(id, march(8));

    const report = computeHabitsReport(
      [young('b-new-1'), dailyEvent('low'), young('a-new-3'), dailyEvent('top')],
      [
        ...doneOn('top', [5, 6, 7, 8, 9, 10]),
        ...doneOn('b-new-1', [10]),
        ...doneOn('a-new-3', [8, 9, 10]),
      ],
      [],
      settings,
      NOW
    );
    expect(sortHabits(report.habits).map((habit) => habit.eventId)).toEqual(['top', 'low', 'a-new-3', 'b-new-1']);
  });

  it('describes how close an unranked habit is to a rank', () => {
    expect(unrankedProgress({ scored: 3 })).toBe('3 of 5 scored');
    expect(unrankedProgress({ scored: 9 })).toBe('5 of 5 scored');
  });
});
