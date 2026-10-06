import type { EventRow, ExamRow } from '@alarm-calendar/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fake, type FakeResponse } from '@/test/fake-supabase';

vi.mock('@/lib/supabase', async () => {
  const { fakeClient } = await import('@/test/fake-supabase');
  return { supabase: fakeClient };
});

import { resetGroupIdColumnProbe } from '@/features/events/events-api';
import { useEventsStore } from '@/features/events/events-store';

import { addExam, editExam, removeExam } from './exam-actions';
import { planExam, type ExamFormValues } from './exam-plan';
import { resetExams, useExamsStore } from './exams-store';

const TZ = 'Europe/Paris';
const NOW = new Date('2026-03-01T09:00:00.000Z');
const EXAM_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const VALUES: ExamFormValues = {
  title: 'Maths',
  notes: '',
  examDate: '2026-03-20',
  examTime: '09:00',
  difficulty: 2,
  sessionTime: '18:00',
  sessionMinutes: 45,
  leadMinutes: 60,
  showInCalendar: true,
};

function examRow(overrides: Partial<ExamRow> = {}): ExamRow {
  return {
    id: EXAM_ID,
    user_id: 'u1',
    title: 'Maths',
    exam_at: '2026-03-20T08:00:00.000Z',
    difficulty: 2,
    notes: null,
    active: true,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function eventRow(overrides: Partial<EventRow> & { id: string; start_at: string }): EventRow {
  return {
    user_id: 'u1',
    title: 'x',
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
    updated_at: NOW.toISOString(),
    exam_id: EXAM_ID,
    exam_role: 'session',
    ...overrides,
  };
}

/** The alarms an exam of VALUES has right after it was created at NOW, as rows. */
function existingAlarms(): EventRow[] {
  const plan = planExam(VALUES, TZ, NOW);
  const pick = (input: { title: string; notes: string | null; start_at: string; duration_min: number }) => ({
    title: input.title,
    notes: input.notes,
    start_at: input.start_at,
    duration_min: input.duration_min,
  });
  return [
    eventRow({ id: 'alarm', exam_role: 'exam', passable: false, ...pick(plan.examAlarm) }),
    ...plan.sessions.map((session, index) => eventRow({ id: `s${index}`, ...pick(session.input) })),
  ];
}

const resolved = (response: FakeResponse): Promise<FakeResponse> => Promise.resolve(response);

beforeEach(() => {
  fake.reset();
  resetGroupIdColumnProbe();
  resetExams();
  useEventsStore.setState({ events: [], status: 'ready', error: null });
});

describe('addExam', () => {
  it('writes the exam, then the exam alarm and every session in one insert, all linked to the exam', async () => {
    fake.responses['insert:exams'] = { data: examRow(), error: null };
    fake.responses['insert:events'] = { data: existingAlarms(), error: null };

    const result = await addExam(VALUES, TZ, NOW);

    expect(result.error).toBeNull();
    expect(fake.names()).toEqual(['insert:exams', 'insert:events']);
    expect(fake.payloadOf('insert:exams')).toEqual({
      title: 'Maths',
      exam_at: '2026-03-20T08:00:00.000Z',
      difficulty: 2,
      notes: null,
    });
    const alarms = fake.payloadOf('insert:events') as Array<Record<string, unknown>>;
    expect(alarms).toHaveLength(4);
    expect(alarms.every((alarm) => alarm['exam_id'] === EXAM_ID && alarm['repeat_unit'] === 'none')).toBe(true);
    expect(alarms.map((alarm) => alarm['exam_role'])).toEqual(['exam', 'session', 'session', 'session']);
    expect(useExamsStore.getState().exams.map((exam) => exam.id)).toEqual([EXAM_ID]);
    expect(useEventsStore.getState().events).toHaveLength(4);
  });

  it('skips an exam alarm that would already be in the past', async () => {
    fake.responses['insert:exams'] = { data: examRow(), error: null };
    fake.responses['insert:events'] = { data: [], error: null };
    const soon = new Date('2026-03-20T07:30:00.000Z');

    await addExam({ ...VALUES, difficulty: 1 }, TZ, soon);

    // Every session is past too, so there is nothing to insert at all.
    expect(fake.names()).toEqual(['insert:exams']);
  });

  it('switches the exam off again when its alarms cannot be written, and reports the failure', async () => {
    fake.responses['insert:exams'] = { data: examRow(), error: null };
    fake.responses['insert:events'] = { data: null, error: { message: 'network' } };
    fake.responses['update:exams'] = { data: [{ id: EXAM_ID }], error: null };

    const result = await addExam(VALUES, TZ, NOW);

    expect(result.error).toBe('network');
    expect(fake.names()).toEqual(['insert:exams', 'insert:events', 'update:exams']);
    expect(fake.payloadOf('update:exams')).toEqual({ active: false });
    expect(useExamsStore.getState().exams).toEqual([]);
  });

  it('writes no alarms when the exam row itself is refused', async () => {
    fake.responses['insert:exams'] = { data: null, error: { message: 'rls' } };
    expect((await addExam(VALUES, TZ, NOW)).error).toBe('rls');
    expect(fake.names()).toEqual(['insert:exams']);
  });
});

describe('editExam', () => {
  beforeEach(() => {
    useEventsStore.setState({ events: existingAlarms() });
    useExamsStore.setState({ exams: [examRow()], status: 'ready' });
  });

  it('moving the exam regenerates the sessions to come and moves the exam alarm', async () => {
    const moved = { ...VALUES, examDate: '2026-03-27' };
    fake.responses['update:exams'] = { data: examRow({ exam_at: '2026-03-27T08:00:00.000Z' }), error: null };
    fake.responses['insert:events'] = { data: [eventRow({ id: 'n0', start_at: '2026-03-20T17:00:00.000Z' })], error: null };
    fake.queued['update:events'] = [
      resolved({ data: eventRow({ id: 'alarm', exam_role: 'exam', start_at: '2026-03-27T07:00:00.000Z' }), error: null }),
      resolved({ data: [{ id: 's0' }, { id: 's1' }, { id: 's2' }], error: null }),
    ];

    const result = await editExam(examRow(), moved, TZ, NOW);

    expect(result.error).toBeNull();
    expect(fake.names()).toEqual(['update:exams', 'insert:events', 'update:events', 'update:events']);
    expect(fake.payloadOf('insert:events')).toHaveLength(3);
    expect(fake.filters.at(-1)).toEqual({ op: 'in', args: ['id', expect.arrayContaining(['s0', 's1', 's2'])] });
    // The old sessions are off the calendar, the new one is on, the exam is in the new place.
    const ids = useEventsStore.getState().events.map((event) => event.id);
    expect(ids).not.toContain('s0');
    expect(ids).toContain('n0');
    expect(useExamsStore.getState().exams[0]?.exam_at).toBe('2026-03-27T08:00:00.000Z');
  });

  it('keeps a session that already happened', async () => {
    const later = new Date('2026-03-14T10:00:00.000Z');
    fake.responses['update:exams'] = { data: examRow({ exam_at: '2026-03-27T08:00:00.000Z' }), error: null };
    fake.responses['insert:events'] = { data: [], error: null };
    fake.queued['update:events'] = [
      resolved({ data: eventRow({ id: 'alarm', exam_role: 'exam', start_at: '2026-03-27T07:00:00.000Z' }), error: null }),
      resolved({ data: [{ id: 's1' }, { id: 's2' }], error: null }),
    ];

    await editExam(examRow(), { ...VALUES, examDate: '2026-03-27' }, TZ, later);

    // s0 (13 March 18:00) is behind us: it is not among the ones switched off.
    const switchedOff = fake.filters.at(-1)?.args[1] as string[];
    expect(switchedOff).not.toContain('s0');
    expect(useEventsStore.getState().events.map((event) => event.id)).toContain('s0');
  });

  it('a title-only edit renames the alarms in place and creates or removes nothing', async () => {
    fake.responses['update:exams'] = { data: examRow({ title: 'Algebra' }), error: null };
    fake.responses['update:events'] = { data: eventRow({ id: 'x', start_at: '2026-03-13T17:00:00.000Z' }), error: null };

    const result = await editExam(examRow(), { ...VALUES, title: 'Algebra' }, TZ, NOW);

    expect(result.error).toBeNull();
    expect(fake.names()).toEqual(['update:exams', 'update:events', 'update:events', 'update:events', 'update:events']);
    expect(fake.names()).not.toContain('insert:events');
  });

  it('stops at the first failed write and reports it; saving again repairs the rest', async () => {
    fake.responses['update:exams'] = { data: examRow({ exam_at: '2026-03-27T08:00:00.000Z' }), error: null };
    fake.responses['insert:events'] = { data: null, error: { message: 'network' } };

    const result = await editExam(examRow(), { ...VALUES, examDate: '2026-03-27' }, TZ, NOW);

    expect(result.error).toBe('network');
    expect(fake.names()).toEqual(['update:exams', 'insert:events']);
    // The exam moved but the alarms did not: the diff of the next save is against what exists, so it heals.
    expect(useEventsStore.getState().events.map((event) => event.id)).toEqual(['alarm', 's0', 's1', 's2']);
  });
});

describe('removeExam', () => {
  it('switches off every alarm of the exam first, then the exam', async () => {
    useEventsStore.setState({
      events: [
        ...existingAlarms(),
        eventRow({ id: 'plain', start_at: '2026-03-12T10:00:00.000Z', exam_id: null, exam_role: null }),
      ],
    });
    useExamsStore.setState({ exams: [examRow()], status: 'ready' });
    fake.responses['update:events'] = { data: [{ id: 'alarm' }], error: null };
    fake.responses['update:exams'] = { data: [{ id: EXAM_ID }], error: null };

    const result = await removeExam(examRow());

    expect(result.error).toBeNull();
    expect(fake.names()).toEqual(['update:events', 'update:exams']);
    expect(fake.filters[0]).toEqual({ op: 'in', args: ['id', ['alarm', 's0', 's1', 's2']] });
    expect(useEventsStore.getState().events.map((event) => event.id)).toEqual(['plain']);
    expect(useExamsStore.getState().exams).toEqual([]);
  });

  it('leaves the exam in place when its alarms could not be switched off, so nothing is orphaned', async () => {
    useEventsStore.setState({ events: existingAlarms() });
    useExamsStore.setState({ exams: [examRow()], status: 'ready' });
    fake.responses['update:events'] = { data: null, error: { message: 'network' } };

    const result = await removeExam(examRow());

    expect(result.error).toBe('network');
    expect(fake.names()).toEqual(['update:events']);
    expect(useExamsStore.getState().exams).toHaveLength(1);
  });
});
