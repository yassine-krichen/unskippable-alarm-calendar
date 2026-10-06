import type { CompletionRow, EventRow, ExamRow } from '@alarm-calendar/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fake } from '@/test/fake-supabase';

vi.mock('@/lib/supabase', async () => {
  const { fakeClient } = await import('@/test/fake-supabase');
  return { supabase: fakeClient };
});

import { useEventsStore } from '@/features/events/events-store';
import { handleCompletionChange, handleExamChange } from '@/features/realtime/realtime-handlers';

import {
  examCompletionsCovered,
  loadExamCompletions,
  loadExamData,
  loadExams,
  resetExams,
  useExamsStore,
} from './exams-store';

const exam = (overrides: Partial<ExamRow> & { id: string }): ExamRow => ({
  user_id: 'u1',
  title: 'Maths',
  exam_at: '2026-03-20T09:00:00.000Z',
  difficulty: 2,
  notes: null,
  active: true,
  created_at: '2026-03-01T00:00:00.000Z',
  updated_at: '2026-03-01T00:00:00.000Z',
  ...overrides,
});

const completion = (overrides: Partial<CompletionRow> & { id: string; event_id: string }): CompletionRow => ({
  user_id: 'u1',
  occurrence_at: '2026-03-13T18:00:00.000Z',
  status: 'done',
  snoozes_used: 0,
  done_at: '2026-03-13T18:01:00.000Z',
  ...overrides,
});

const sessionEvent = { id: 's1', exam_id: 'x1', exam_role: 'session' } as EventRow;
// exam() defaults to 20 March 2026.
const NOW = new Date('2026-03-10T00:00:00.000Z');

beforeEach(() => {
  fake.reset();
  resetExams();
  useEventsStore.setState({ events: [sessionEvent, { id: 'plain' } as EventRow], status: 'ready', error: null });
});

describe('loadExams', () => {
  it('fills the store, and a failed first load shows an error without a list', async () => {
    fake.responses['select:exams'] = { data: [exam({ id: 'x1' })], error: null };
    await loadExams();
    expect(useExamsStore.getState()).toMatchObject({ status: 'ready', exams: [{ id: 'x1' }] });

    resetExams();
    fake.responses['select:exams'] = { data: null, error: { message: 'boom' } };
    await loadExams();
    expect(useExamsStore.getState()).toMatchObject({ status: 'error', error: 'boom', exams: [] });
  });

  it('a failed refetch keeps the list that is already there', async () => {
    fake.responses['select:exams'] = { data: [exam({ id: 'x1' })], error: null };
    await loadExams();
    fake.responses['select:exams'] = { data: null, error: { message: 'offline' } };
    await loadExams();
    expect(useExamsStore.getState()).toMatchObject({ status: 'ready', exams: [{ id: 'x1' }] });
  });

  it('replays a realtime change that arrived while the fetch was in flight', async () => {
    let answer: (value: { data: unknown; error: null }) => void = () => undefined;
    fake.queued['select:exams'] = [new Promise((resolve) => (answer = resolve))];

    const loading = loadExams();
    handleExamChange({ eventType: 'UPDATE', new: { ...exam({ id: 'x1', title: 'Newer', updated_at: '2026-03-02T00:00:00.000Z' }) }, old: {} });
    answer({ data: [exam({ id: 'x1', title: 'Older' })], error: null });
    await loading;

    expect(useExamsStore.getState().exams[0]?.title).toBe('Newer');
  });
});

describe('handleExamChange', () => {
  const change = (eventType: 'INSERT' | 'UPDATE' | 'DELETE', row: Record<string, unknown>) =>
    handleExamChange(eventType === 'DELETE' ? { eventType, new: {}, old: row } : { eventType, new: row, old: {} });

  it('adds, updates and removes exams, and a soft-deleted exam leaves the list', () => {
    change('INSERT', { ...exam({ id: 'x1' }) });
    expect(useExamsStore.getState().exams.map((e) => e.id)).toEqual(['x1']);

    change('UPDATE', { ...exam({ id: 'x1', title: 'Renamed', updated_at: '2026-03-02T00:00:00.000Z' }) });
    expect(useExamsStore.getState().exams[0]?.title).toBe('Renamed');

    change('UPDATE', { ...exam({ id: 'x1', active: false, updated_at: '2026-03-03T00:00:00.000Z' }) });
    expect(useExamsStore.getState().exams).toEqual([]);

    change('INSERT', { ...exam({ id: 'x2' }) });
    change('DELETE', { id: 'x2' });
    expect(useExamsStore.getState().exams).toEqual([]);
  });

  it('ignores an older echo and a malformed payload', () => {
    change('INSERT', { ...exam({ id: 'x1', title: 'Newest', updated_at: '2026-03-05T00:00:00.000Z' }) });
    change('UPDATE', { ...exam({ id: 'x1', title: 'Stale', updated_at: '2026-03-02T00:00:00.000Z' }) });
    change('INSERT', { nope: true });
    expect(useExamsStore.getState().exams.map((e) => e.title)).toEqual(['Newest']);
  });
});

describe('exam completions', () => {
  beforeEach(() => useExamsStore.setState({ exams: [exam({ id: 'x1' })], status: 'ready' }));

  it('loads the completions of the alarms that belong to an exam', async () => {
    fake.responses['select:completions'] = { data: [completion({ id: 'c1', event_id: 's1' })], error: null };
    await loadExamCompletions(NOW);
    expect(fake.filters).toEqual([{ op: 'in', args: ['event_id', ['s1']] }]);
    expect(useExamsStore.getState()).toMatchObject({ completionsStatus: 'ready', completions: [{ id: 'c1' }] });
  });

  it('a failed load is an error, never an empty "ready" list', async () => {
    fake.responses['select:completions'] = { data: null, error: { message: 'offline' } };
    await loadExamCompletions(NOW);
    expect(useExamsStore.getState().completionsStatus).toBe('error');
  });

  it('only asks for exams that are still to come or ended less than 7 days ago', async () => {
    const day = 86_400_000;
    const now = new Date('2026-03-20T12:00:00.000Z');
    useExamsStore.setState({
      exams: [
        exam({ id: 'x1', exam_at: new Date(now.getTime() + 3 * day).toISOString() }),
        exam({ id: 'x2', exam_at: new Date(now.getTime() - 6 * day).toISOString() }),
        exam({ id: 'x3', exam_at: new Date(now.getTime() - 8 * day).toISOString() }),
      ],
    });
    useEventsStore.setState({
      events: [
        { id: 'a1', exam_id: 'x1' },
        { id: 'a2', exam_id: 'x2' },
        { id: 'a3', exam_id: 'x3' },
        { id: 'plain' },
      ] as EventRow[],
    });
    fake.responses['select:completions'] = { data: [], error: null };

    await loadExamCompletions(now);

    expect(fake.filters).toEqual([{ op: 'in', args: ['event_id', ['a1', 'a2']] }]);
    expect(examCompletionsCovered({ exam_at: new Date(now.getTime() - 7 * day).toISOString() }, now)).toBe(true);
    expect(examCompletionsCovered({ exam_at: new Date(now.getTime() - 7 * day - 1).toISOString() }, now)).toBe(false);
  });

  it('a realtime completion during the first load is merged, not discarded, and the status still ends ready', async () => {
    let answer: (value: { data: unknown; error: null }) => void = () => undefined;
    fake.queued['select:completions'] = [new Promise((resolve) => (answer = resolve))];

    const loading = loadExamCompletions(NOW);
    expect(useExamsStore.getState().completionsStatus).toBe('loading');
    handleCompletionChange({ eventType: 'INSERT', new: { ...completion({ id: 'live', event_id: 's1' }) }, old: {} });
    // The in-flight answer was produced before the change and does not have it.
    answer({ data: [], error: null });
    await loading;

    expect(useExamsStore.getState().completionsStatus).toBe('ready');
    expect(useExamsStore.getState().completions.map((c) => c.id)).toEqual(['live']);
  });

  it('a realtime removal during a load is replayed too', async () => {
    let answer: (value: { data: unknown; error: null }) => void = () => undefined;
    fake.queued['select:completions'] = [new Promise((resolve) => (answer = resolve))];

    const loading = loadExamCompletions(NOW);
    handleCompletionChange({ eventType: 'DELETE', new: {}, old: { id: 'gone' } });
    answer({ data: [completion({ id: 'gone', event_id: 's1' }), completion({ id: 'kept', event_id: 's1', occurrence_at: '2026-03-14T18:00:00.000Z' })], error: null });
    await loading;

    expect(useExamsStore.getState().completions.map((c) => c.id)).toEqual(['kept']);
  });

  it('loadExamData loads the exams, then their completions, without realtime', async () => {
    resetExams();
    useEventsStore.setState({ events: [sessionEvent] });
    const future = exam({ id: 'x1', exam_at: new Date(Date.now() + 5 * 86_400_000).toISOString() });
    fake.responses['select:exams'] = { data: [future], error: null };
    fake.responses['select:completions'] = { data: [completion({ id: 'c1', event_id: 's1' })], error: null };

    await loadExamData();

    expect(fake.names()).toEqual(['select:exams', 'select:completions']);
    expect(useExamsStore.getState()).toMatchObject({ status: 'ready', completionsStatus: 'ready' });
  });

  it('loadExamData leaves the error state when the exams cannot be read, so the screen can show it', async () => {
    resetExams();
    fake.responses['select:exams'] = { data: null, error: { message: 'offline' } };
    fake.responses['select:completions'] = { data: [], error: null };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await loadExamData();

    expect(useExamsStore.getState()).toMatchObject({ status: 'error', error: 'offline' });
    warn.mockRestore();
  });

  it('keeps a realtime completion of an exam alarm and drops one of any other alarm', () => {
    handleCompletionChange({ eventType: 'INSERT', new: { ...completion({ id: 'c1', event_id: 's1' }) }, old: {} });
    handleCompletionChange({ eventType: 'INSERT', new: { ...completion({ id: 'c2', event_id: 'plain' }) }, old: {} });
    expect(useExamsStore.getState().completions.map((c) => c.id)).toEqual(['c1']);

    handleCompletionChange({ eventType: 'DELETE', new: {}, old: { id: 'c1' } });
    expect(useExamsStore.getState().completions).toEqual([]);
  });
});
