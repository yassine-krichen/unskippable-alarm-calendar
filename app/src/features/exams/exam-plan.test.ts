import type { EventRow, ExamRow } from '@alarm-calendar/core';
import { describe, expect, it } from 'vitest';

import { createExamFormSchema, defaultExamFormValues, examToFormValues } from './exam-form';
import {
  catchUpTitle,
  catchUpWriteInput,
  diffExamAlarms,
  examAlarmTitle,
  planExam,
  sessionTitle,
  type ExamFormValues,
} from './exam-plan';

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

describe('planExam', () => {
  it('plans the exam row, a non-passable alarm before it, and the sessions as passable one-off alarms', () => {
    const plan = planExam(VALUES, TZ, NOW);

    // 09:00 in Paris on 20 March is 08:00Z (CET).
    expect(plan.exam).toEqual({ title: 'Maths', exam_at: '2026-03-20T08:00:00.000Z', difficulty: 2, notes: null });
    expect(plan.examAlarm).toMatchObject({
      title: examAlarmTitle('Maths'),
      start_at: '2026-03-20T07:00:00.000Z',
      duration_min: 60,
      passable: false,
      repeat_unit: 'none',
      exam_role: 'exam',
    });
    expect(plan.sessions.map((s) => s.input.start_at)).toEqual([
      '2026-03-13T17:00:00.000Z',
      '2026-03-17T17:00:00.000Z',
      '2026-03-19T17:00:00.000Z',
    ]);
    expect(plan.sessions.map((s) => s.input.title)).toEqual([
      sessionTitle('Maths', 7),
      sessionTitle('Maths', 3),
      sessionTitle('Maths', 1),
    ]);
    for (const session of plan.sessions) {
      expect(session.input).toMatchObject({
        passable: true,
        repeat_unit: 'none',
        exam_role: 'session',
        catch_up_of: null,
        duration_min: 45,
      });
    }
    expect(plan.skippedSessions).toBe(0);
  });

  it('adds the 14 day session for a hard exam and reports the sessions already past', () => {
    const hard = planExam({ ...VALUES, difficulty: 3 }, TZ, new Date('2026-03-10T09:00:00.000Z'));
    expect(hard.sessions.map((s) => s.daysBefore)).toEqual([7, 3, 1]);
    // 14 days before is 6 March, already past on the 10th.
    expect(hard.skippedSessions).toBe(1);
  });

  it('trims the title and keeps notes on every alarm', () => {
    const plan = planExam({ ...VALUES, title: '  Maths  ', notes: ' ch. 1 to 4 ' }, TZ, NOW);
    expect(plan.exam).toMatchObject({ title: 'Maths', notes: 'ch. 1 to 4' });
    expect(plan.examAlarm.notes).toBe('ch. 1 to 4');
    expect(plan.sessions.every((s) => s.input.notes === 'ch. 1 to 4')).toBe(true);
  });

  it('rings the exam alarm at the exam time when the lead is 0, with a block the calendar can draw', () => {
    const plan = planExam({ ...VALUES, leadMinutes: 0 }, TZ, NOW);
    expect(plan.examAlarm.start_at).toBe(plan.exam.exam_at);
    expect(plan.examAlarm.duration_min).toBe(15);
  });

  it('puts the sessions at the chosen time in the settings zone across DST', () => {
    // Paris springs forward on 29 March; the exam is on the 30th at 09:00 CEST.
    const plan = planExam({ ...VALUES, examDate: '2026-03-30', sessionTime: '07:30' }, TZ, NOW);
    expect(plan.sessions.map((s) => s.input.start_at)).toEqual([
      '2026-03-23T06:30:00.000Z',
      '2026-03-27T06:30:00.000Z',
      '2026-03-29T05:30:00.000Z',
    ]);
  });
});

function row(overrides: Partial<EventRow> & { id: string; start_at: string }): EventRow {
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
    updated_at: '2026-03-01T00:00:00.000Z',
    exam_id: EXAM_ID,
    exam_role: 'session',
    ...overrides,
  };
}

/** The alarms the exam of VALUES would have right after it was created on NOW, as the database returns them. */
function existingAlarms(): EventRow[] {
  const plan = planExam(VALUES, TZ, NOW);
  return [
    row({ id: 'alarm', exam_role: 'exam', passable: false, ...pick(plan.examAlarm) }),
    ...plan.sessions.map((s, index) => row({ id: `s${index}`, ...pick(s.input) })),
  ];
}

function pick(input: { title: string; notes: string | null; start_at: string; duration_min: number }) {
  return { title: input.title, notes: input.notes, start_at: input.start_at, duration_min: input.duration_min };
}

describe('showing an exam in the calendar', () => {
  const EXAM_ROW: ExamRow = {
    id: EXAM_ID,
    user_id: 'u1',
    title: 'Maths',
    exam_at: '2026-03-20T08:00:00.000Z',
    difficulty: 2,
    notes: null,
    active: true,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };

  it('gives the exam alarm and every session the form switch', () => {
    const hidden = planExam({ ...VALUES, showInCalendar: false }, TZ, NOW);
    expect(hidden.examAlarm.show_in_calendar).toBe(false);
    expect(hidden.sessions.every((session) => session.input.show_in_calendar === false)).toBe(true);
    const shown = planExam(VALUES, TZ, NOW);
    expect(shown.examAlarm.show_in_calendar).toBe(true);
    expect(shown.sessions.every((session) => session.input.show_in_calendar === true)).toBe(true);
  });

  it('updates the alarms still to come in place when the switch changes, without moving them', () => {
    const plan = planExam({ ...VALUES, showInCalendar: false }, TZ, NOW);
    const changes = diffExamAlarms(EXAM_ID, plan, existingAlarms(), NOW);
    expect(changes.insert).toEqual([]);
    expect(changes.deactivate).toEqual([]);
    expect(changes.update.map((u) => u.id).sort()).toEqual(['alarm', 's0', 's1', 's2']);
    expect(changes.update.every((u) => u.input.show_in_calendar === false)).toBe(true);
  });

  it('carries the switch to a future catch-up and copies it from the missed session', () => {
    const missed = row({ id: 'missed', start_at: '2026-03-13T17:00:00.000Z', show_in_calendar: false });
    expect(catchUpWriteInput({ ...EXAM_ROW, title: 'Maths' }, missed, new Date('2026-03-12T17:00:00Z')).show_in_calendar).toBe(false);
    expect(catchUpWriteInput({ ...EXAM_ROW, title: 'Maths' }, row({ id: 'missed2', start_at: '2026-03-13T17:00:00.000Z' }), new Date('2026-03-12T17:00:00Z')).show_in_calendar).toBe(true);

    const catchUp = row({ id: 'c1', start_at: '2026-03-12T17:00:00.000Z', catch_up_of: 'old', show_in_calendar: true });
    const plan = planExam({ ...VALUES, showInCalendar: false }, TZ, NOW);
    const changes = diffExamAlarms(EXAM_ID, plan, [...existingAlarms(), catchUp], NOW);
    expect(changes.update.find((u) => u.id === 'c1')?.input.show_in_calendar).toBe(false);
  });

  it('reads the switch back from the exam alarm, defaulting to shown', () => {
    const exam = { ...EXAM_ROW, exam_at: '2026-03-20T08:00:00.000Z', difficulty: 2 as const };
    const hiddenAlarms = existingAlarms().map((alarm) => ({ ...alarm, show_in_calendar: false }));
    expect(examToFormValues(exam, hiddenAlarms, TZ).showInCalendar).toBe(false);
    expect(examToFormValues(exam, existingAlarms(), TZ).showInCalendar).toBe(true);
    expect(examToFormValues(exam, [], TZ).showInCalendar).toBe(true);
  });
});

describe('diffExamAlarms', () => {
  it('changes nothing when nothing changed', () => {
    const changes = diffExamAlarms(EXAM_ID, planExam(VALUES, TZ, NOW), existingAlarms(), NOW);
    expect(changes).toEqual({ insert: [], update: [], deactivate: [] });
  });

  it('only renames the alarms in place when just the title changes (ids and times stay)', () => {
    const plan = planExam({ ...VALUES, title: 'Algebra' }, TZ, NOW);
    const changes = diffExamAlarms(EXAM_ID, plan, existingAlarms(), NOW);
    expect(changes.insert).toEqual([]);
    expect(changes.deactivate).toEqual([]);
    expect(changes.update.map((u) => u.id).sort()).toEqual(['alarm', 's0', 's1', 's2']);
    expect(changes.update.find((u) => u.id === 's0')?.input.title).toBe(sessionTitle('Algebra', 7));
  });

  it('regenerates the future sessions when the exam moves, and moves the exam alarm', () => {
    const plan = planExam({ ...VALUES, examDate: '2026-03-27' }, TZ, NOW);
    const changes = diffExamAlarms(EXAM_ID, plan, existingAlarms(), NOW);

    expect(changes.deactivate.sort()).toEqual(['s0', 's1', 's2']);
    expect(changes.insert.map((i) => i.start_at)).toEqual([
      '2026-03-20T17:00:00.000Z',
      '2026-03-24T17:00:00.000Z',
      '2026-03-26T17:00:00.000Z',
    ]);
    expect(changes.insert.every((i) => i.exam_id === EXAM_ID && i.exam_role === 'session')).toBe(true);
    expect(changes.update.map((u) => u.id)).toEqual(['alarm']);
    expect(changes.update[0]?.input.start_at).toBe('2026-03-27T07:00:00.000Z');
  });

  it('keeps sessions that already happened (done or missed) and regenerates only the ones to come', () => {
    // Now is 14 March, after the 7-days-before session of 13 March.
    const later = new Date('2026-03-14T10:00:00.000Z');
    const plan = planExam({ ...VALUES, examDate: '2026-03-27' }, TZ, later);
    const changes = diffExamAlarms(EXAM_ID, plan, existingAlarms(), later);

    expect(changes.deactivate).not.toContain('s0');
    expect(changes.deactivate.sort()).toEqual(['s1', 's2']);
    // The new plan has J-7 (20 March), J-3 and J-1.
    expect(changes.insert).toHaveLength(3);
  });

  it('adds the 14 day session when the difficulty goes up, leaving the others alone', () => {
    const plan = planExam({ ...VALUES, difficulty: 3 }, TZ, NOW);
    const changes = diffExamAlarms(EXAM_ID, plan, existingAlarms(), NOW);
    expect(changes.insert.map((i) => i.start_at)).toEqual(['2026-03-06T17:00:00.000Z']);
    expect(changes.deactivate).toEqual([]);
    // Only the exam alarm and sessions whose text changed (their titles do not), so nothing else updates.
    expect(changes.update).toEqual([]);
  });

  it('switches the 14 day session off when the difficulty goes down', () => {
    const hard = planExam({ ...VALUES, difficulty: 3 }, TZ, NOW);
    const existing = [
      row({ id: 'alarm', exam_role: 'exam', passable: false, ...pick(hard.examAlarm) }),
      ...hard.sessions.map((s, index) => row({ id: `h${index}`, ...pick(s.input) })),
    ];
    const changes = diffExamAlarms(EXAM_ID, planExam({ ...VALUES, difficulty: 1 }, TZ, NOW), existing, NOW);
    expect(changes.deactivate).toEqual(['h0']);
    expect(changes.insert).toEqual([]);
  });

  it('keeps a future catch-up while it still has room before the exam, and drops one that no longer does', () => {
    const catchUp = row({ id: 'c1', start_at: '2026-03-16T14:00:00.000Z', catch_up_of: 's0' });
    const keep = diffExamAlarms(EXAM_ID, planExam(VALUES, TZ, NOW), [...existingAlarms(), catchUp], NOW);
    expect(keep.deactivate).not.toContain('c1');
    // Its title follows the exam's: the stored 'x' title differs, so it is updated, never recreated.
    expect(keep.update.some((u) => u.id === 'c1' && u.input.title === catchUpTitle('Maths'))).toBe(true);
    expect(keep.update.find((u) => u.id === 'c1')?.input.catch_up_of).toBe('s0');

    // The exam moves to 15 March: the catch-up of the 16th would be after it.
    const moved = diffExamAlarms(
      EXAM_ID,
      planExam({ ...VALUES, examDate: '2026-03-15' }, TZ, NOW),
      [...existingAlarms(), catchUp],
      NOW
    );
    expect(moved.deactivate).toContain('c1');
  });

  it('creates the exam alarm only when it is still to come and the exam had none', () => {
    const noAlarm = existingAlarms().filter((e) => e.exam_role !== 'exam');
    expect(diffExamAlarms(EXAM_ID, planExam(VALUES, TZ, NOW), noAlarm, NOW).insert).toHaveLength(1);

    const soon = new Date('2026-03-20T07:30:00.000Z');
    expect(diffExamAlarms(EXAM_ID, planExam(VALUES, TZ, soon), noAlarm, soon).insert).toEqual([]);
  });

  it('ignores other exams and inactive alarms', () => {
    const others = [
      row({ id: 'other', start_at: '2026-03-17T17:00:00.000Z', exam_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }),
      row({ id: 'off', start_at: '2026-03-18T17:00:00.000Z', active: false }),
    ];
    const changes = diffExamAlarms(EXAM_ID, planExam(VALUES, TZ, NOW), [...existingAlarms(), ...others], NOW);
    expect(changes).toEqual({ insert: [], update: [], deactivate: [] });
  });
});

describe('catchUpWriteInput', () => {
  it('writes a one-off session linked to the exam and to the missed session', () => {
    const exam: ExamRow = {
      id: EXAM_ID,
      user_id: 'u1',
      title: 'Maths',
      exam_at: '2026-03-20T08:00:00.000Z',
      difficulty: 2,
      notes: 'ch. 1',
      active: true,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
    const missed = row({ id: 'm1', start_at: '2026-03-13T17:00:00.000Z', duration_min: 30, max_snoozes: 1 });
    const input = catchUpWriteInput(exam, missed, new Date('2026-03-16T14:00:00.000Z'));
    expect(input).toMatchObject({
      title: catchUpTitle('Maths'),
      notes: 'ch. 1',
      start_at: '2026-03-16T14:00:00.000Z',
      duration_min: 30,
      max_snoozes: 1,
      repeat_unit: 'none',
      exam_id: EXAM_ID,
      exam_role: 'session',
      catch_up_of: 'm1',
    });
  });
});

describe('examToFormValues', () => {
  const exam: ExamRow = {
    id: EXAM_ID,
    user_id: 'u1',
    title: 'Maths',
    exam_at: '2026-03-20T08:00:00.000Z',
    difficulty: 3,
    notes: null,
    active: true,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };

  it('reads the session time, length and lead back from the alarms the exam made', () => {
    const values = examToFormValues(
      exam,
      planFor({ ...VALUES, sessionTime: '07:15', sessionMinutes: 90, leadMinutes: 30 }),
      TZ
    );
    expect(values).toMatchObject({
      title: 'Maths',
      examDate: '2026-03-20',
      examTime: '09:00',
      difficulty: 3,
      sessionTime: '07:15',
      sessionMinutes: 90,
      leadMinutes: 30,
    });
  });

  it('takes the session time from the latest planned session, not from an older one kept from before an edit', () => {
    const events = [
      row({ id: 'old', start_at: '2026-03-06T06:00:00.000Z', duration_min: 30 }),
      row({ id: 'new', start_at: '2026-03-17T17:00:00.000Z', duration_min: 45 }),
      row({ id: 'catch', start_at: '2026-03-18T12:00:00.000Z', catch_up_of: 'old' }),
    ];
    expect(examToFormValues(exam, events, TZ)).toMatchObject({ sessionTime: '18:00', sessionMinutes: 45 });
  });

  it('falls back to the defaults for an exam with no alarms', () => {
    const values = examToFormValues(exam, [], TZ);
    expect(values).toMatchObject({ sessionTime: '18:00', sessionMinutes: 45, leadMinutes: 60 });
  });

  function planFor(overrides: ExamFormValues): EventRow[] {
    const plan = planExam(overrides, TZ, NOW);
    return [
      row({ id: 'alarm', exam_role: 'exam', ...pick(plan.examAlarm) }),
      ...plan.sessions.map((s, index) => row({ id: `s${index}`, ...pick(s.input) })),
    ];
  }
});

describe('createExamFormSchema', () => {
  const schema = (isNew: boolean) => createExamFormSchema({ tz: TZ, now: () => NOW, isNew });

  it('accepts the defaults filled in with a title and a future date', () => {
    expect(schema(true).safeParse({ ...defaultExamFormValues('2026-03-20', TZ, NOW), title: 'Maths' }).success).toBe(true);
  });

  it('defaults a new exam to the next day when 09:00 on the clicked day has passed', () => {
    expect(defaultExamFormValues('2026-03-01', TZ, new Date('2026-03-01T09:00:00.000Z')).examDate).toBe('2026-03-02');
    expect(defaultExamFormValues('2026-03-01', TZ, new Date('2026-03-01T06:00:00.000Z')).examDate).toBe('2026-03-01');
    expect(defaultExamFormValues('2026-03-05', TZ, NOW).examDate).toBe('2026-03-05');
  });

  it('refuses a new exam in the past but allows editing one', () => {
    const past = { ...VALUES, examDate: '2026-02-01' };
    const refused = schema(true).safeParse(past);
    expect(refused.success).toBe(false);
    expect(schema(false).safeParse(past).success).toBe(true);
  });

  it('refuses a blank title, a bad difficulty and out-of-range lengths', () => {
    expect(schema(true).safeParse({ ...VALUES, title: '  ' }).success).toBe(false);
    expect(schema(true).safeParse({ ...VALUES, difficulty: 4 }).success).toBe(false);
    expect(schema(true).safeParse({ ...VALUES, sessionMinutes: 2 }).success).toBe(false);
    expect(schema(true).safeParse({ ...VALUES, leadMinutes: -1 }).success).toBe(false);
    expect(schema(true).safeParse({ ...VALUES, sessionTime: '7pm' }).success).toBe(false);
  });
});
