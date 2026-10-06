import { describe, expect, it } from 'vitest';

import {
  CATCH_UP_SETTLE_MINUTES,
  catchUpsToCancel,
  classifySession,
  examAlarmOf,
  examProgress,
  planCatchUp,
  planCatchUps,
  planRevisionSessions,
  sessionsOfExam,
} from './exams';
import { isHabit } from './habits';
import { expandSchedule } from './schedule';
import type { EventRow, ExamRow } from './types';

const UTC = { timezone: 'UTC' };
const PARIS = { timezone: 'Europe/Paris' };
const USER = '99999999-9999-4999-8999-999999999999';
const EXAM_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const iso = (value: string): Date => new Date(value);
const isoList = (sessions: Array<{ at: Date }>): string[] => sessions.map((session) => session.at.toISOString());

describe('planRevisionSessions', () => {
  const now = iso('2026-03-01T08:00:00.000Z');

  it('plans 7, 3 and 1 days before for difficulty 1 and 2, at 18:00 by default', () => {
    for (const difficulty of [1, 2] as const) {
      const sessions = planRevisionSessions({ exam_at: '2026-03-20T09:00:00.000Z', difficulty }, UTC, now);
      expect(isoList(sessions)).toEqual([
        '2026-03-13T18:00:00.000Z',
        '2026-03-17T18:00:00.000Z',
        '2026-03-19T18:00:00.000Z',
      ]);
      expect(sessions.map((session) => session.daysBefore)).toEqual([7, 3, 1]);
    }
  });

  it('adds a session 14 days before for difficulty 3', () => {
    const sessions = planRevisionSessions({ exam_at: '2026-03-20T09:00:00.000Z', difficulty: 3 }, UTC, now);
    expect(isoList(sessions)).toEqual([
      '2026-03-06T18:00:00.000Z',
      '2026-03-13T18:00:00.000Z',
      '2026-03-17T18:00:00.000Z',
      '2026-03-19T18:00:00.000Z',
    ]);
    expect(sessions.map((session) => session.daysBefore)).toEqual([14, 7, 3, 1]);
  });

  it('skips sessions that are already in the past when the exam is created late', () => {
    const lateNow = iso('2026-03-14T08:00:00.000Z');
    const sessions = planRevisionSessions({ exam_at: '2026-03-20T09:00:00.000Z', difficulty: 3 }, UTC, lateNow);
    expect(isoList(sessions)).toEqual(['2026-03-17T18:00:00.000Z', '2026-03-19T18:00:00.000Z']);
  });

  it('skips a session whose time is exactly now, and plans nothing for an exam tomorrow morning at 18:00 passed', () => {
    const exactly = iso('2026-03-19T18:00:00.000Z');
    expect(isoList(planRevisionSessions({ exam_at: '2026-03-20T09:00:00.000Z', difficulty: 1 }, UTC, exactly))).toEqual([]);
    const afterJ1 = iso('2026-03-19T18:01:00.000Z');
    expect(planRevisionSessions({ exam_at: '2026-03-20T09:00:00.000Z', difficulty: 3 }, UTC, afterJ1)).toEqual([]);
  });

  it('returns nothing for an exam today', () => {
    expect(planRevisionSessions({ exam_at: '2026-03-01T15:00:00.000Z', difficulty: 3 }, UTC, now)).toEqual([]);
  });

  it('uses the chosen session time', () => {
    const sessions = planRevisionSessions({ exam_at: '2026-03-20T09:00:00.000Z', difficulty: 1 }, UTC, now, '07:30');
    expect(isoList(sessions)).toEqual([
      '2026-03-13T07:30:00.000Z',
      '2026-03-17T07:30:00.000Z',
      '2026-03-19T07:30:00.000Z',
    ]);
  });

  it('counts days in the settings zone, not in UTC', () => {
    // 2026-06-10T20:00Z is 08:00 on 11 June in Auckland (+12), so the exam day there is the 11th.
    const sessions = planRevisionSessions(
      { exam_at: '2026-06-10T20:00:00.000Z', difficulty: 1 },
      { timezone: 'Pacific/Auckland' },
      iso('2026-05-01T00:00:00.000Z')
    );
    expect(isoList(sessions)).toEqual([
      '2026-06-04T06:00:00.000Z', // 4 June 18:00 NZST
      '2026-06-08T06:00:00.000Z',
      '2026-06-10T06:00:00.000Z',
    ]);
  });

  it('keeps the wall-clock time across a DST change', () => {
    // Paris springs forward on 29 March 2026. Exam on 30 March: J-7 (23 March) and J-3 are CET, J-1 is CEST.
    const sessions = planRevisionSessions(
      { exam_at: '2026-03-30T07:00:00.000Z', difficulty: 1 },
      PARIS,
      iso('2026-03-01T00:00:00.000Z')
    );
    expect(isoList(sessions)).toEqual([
      '2026-03-23T17:00:00.000Z',
      '2026-03-27T17:00:00.000Z',
      '2026-03-29T16:00:00.000Z',
    ]);
  });

  it('moves a session time inside the spring-forward gap forward, like the recurrence rules', () => {
    // 02:30 does not exist on 29 March in Paris; it becomes 03:30 CEST = 01:30Z.
    const sessions = planRevisionSessions(
      { exam_at: '2026-03-30T07:00:00.000Z', difficulty: 1 },
      PARIS,
      iso('2026-03-01T00:00:00.000Z'),
      '02:30'
    );
    expect(sessions[2]?.at.toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });

  it('rejects a malformed session time, difficulty or exam time', () => {
    const exam = { exam_at: '2026-03-20T09:00:00.000Z', difficulty: 1 as const };
    expect(() => planRevisionSessions(exam, UTC, now, '25:00')).toThrow(RangeError);
    expect(() => planRevisionSessions(exam, UTC, now, '9:00')).toThrow(RangeError);
    expect(() => planRevisionSessions({ ...exam, difficulty: 4 as never }, UTC, now)).toThrow(RangeError);
    expect(() => planRevisionSessions({ ...exam, exam_at: 'soon' }, UTC, now)).toThrow(RangeError);
    expect(() => planRevisionSessions(exam, { timezone: 'Mars/Base' }, now)).toThrow();
  });
});

describe('planCatchUp', () => {
  const missed = { id: 'm1', start_at: '2026-03-10T08:00:00.000Z' };

  it('lands halfway between now and the exam', () => {
    const at = planCatchUp({ exam_at: '2026-03-12T10:00:00.000Z' }, missed, iso('2026-03-10T10:00:00.000Z'), UTC);
    expect(at?.toISOString()).toBe('2026-03-11T10:00:00.000Z');
  });

  it('rounds to a quarter hour', () => {
    // Halfway is 10:05 the next day.
    const at = planCatchUp({ exam_at: '2026-03-12T10:10:00.000Z' }, missed, iso('2026-03-10T10:00:00.000Z'), UTC);
    expect(at?.toISOString()).toBe('2026-03-11T10:00:00.000Z');
    const later = planCatchUp({ exam_at: '2026-03-12T10:30:00.000Z' }, missed, iso('2026-03-10T10:00:00.000Z'), UTC);
    expect(later?.toISOString()).toBe('2026-03-11T10:15:00.000Z');
  });

  it('moves a night-time halfway point to the nearest daytime slot (08:00 to 21:00 local)', () => {
    // Halfway is 04:00 on the 11th; 08:00 that morning is nearer than 21:00 the evening before (which is before now).
    const at = planCatchUp({ exam_at: '2026-03-11T10:00:00.000Z' }, missed, iso('2026-03-10T22:00:00.000Z'), UTC);
    expect(at?.toISOString()).toBe('2026-03-11T08:00:00.000Z');
  });

  it('prefers the evening before when that is nearer than the next morning', () => {
    // now 14:00, exam 10:00 two days later: halfway is 00:00 on the 12th. 21:00 on the 11th is 3h away, 08:00 on the 12th is 8h.
    const at = planCatchUp({ exam_at: '2026-03-13T10:00:00.000Z' }, missed, iso('2026-03-10T14:00:00.000Z'), UTC);
    expect(at?.toISOString()).toBe('2026-03-11T21:00:00.000Z');
  });

  it('never picks a time in the night in the settings zone', () => {
    // Tunis is UTC+1 all year. Halfway is 05:00Z = 06:00 local: night. Nearest daytime slot is 08:00 local = 07:00Z.
    const at = planCatchUp(
      { exam_at: '2026-03-11T14:00:00.000Z' },
      missed,
      iso('2026-03-10T20:00:00.000Z'),
      { timezone: 'Africa/Tunis' }
    );
    expect(at?.toISOString()).toBe('2026-03-11T07:00:00.000Z');
  });

  it('reads the daytime window across a DST change', () => {
    // Paris: halfway is 02:00 CEST on 30 March. 21:00 CEST on the 29th (19:00Z) is 5 h away; 08:00 CEST (06:00Z) is 6 h.
    const at = planCatchUp(
      { exam_at: '2026-03-31T12:00:00.000Z' },
      missed,
      iso('2026-03-28T12:00:00.000Z'),
      PARIS
    );
    expect(at?.toISOString()).toBe('2026-03-29T19:00:00.000Z');
  });

  it('is null when less than 3 hours remain, and works at exactly 3 hours', () => {
    expect(planCatchUp({ exam_at: '2026-03-10T12:59:00.000Z' }, missed, iso('2026-03-10T10:00:00.000Z'), UTC)).toBeNull();
    const at = planCatchUp({ exam_at: '2026-03-10T11:00:00.000Z' }, missed, iso('2026-03-10T08:00:00.000Z'), UTC);
    expect(at?.toISOString()).toBe('2026-03-10T09:30:00.000Z');
  });

  it('is null when the exam has passed', () => {
    expect(planCatchUp({ exam_at: '2026-03-09T10:00:00.000Z' }, missed, iso('2026-03-10T10:00:00.000Z'), UTC)).toBeNull();
  });

  it('is null when there is no daytime slot before the exam (the exam is early and the halfway point is at night)', () => {
    // Window is 22:30 to 03:00: all of it night.
    const at = planCatchUp({ exam_at: '2026-03-11T04:00:00.000Z' }, missed, iso('2026-03-10T22:00:00.000Z'), UTC);
    expect(at).toBeNull();
  });

  it('is at least 30 minutes after now and at least an hour before the exam', () => {
    // Window ends 09:00 for a 10:00 exam. Ideal 09:30 -> nearest slot inside the window is 09:00.
    const at = planCatchUp({ exam_at: '2026-03-10T10:00:00.000Z' }, missed, iso('2026-03-10T05:00:00.000Z'), UTC);
    // 05:00 + 30 min = 05:30 is night; the first daytime slot is 08:00 and ideal 07:30 is night, so 08:00.
    expect(at?.toISOString()).toBe('2026-03-10T08:00:00.000Z');
    const closeToExam = planCatchUp({ exam_at: '2026-03-10T13:00:00.000Z' }, missed, iso('2026-03-10T10:00:00.000Z'), UTC);
    expect(closeToExam?.toISOString()).toBe('2026-03-10T11:30:00.000Z');
  });

  it('is null when a catch-up for that session exists, or the session is itself a catch-up', () => {
    const exam = { exam_at: '2026-03-12T10:00:00.000Z' };
    const now = iso('2026-03-10T10:00:00.000Z');
    expect(planCatchUp(exam, missed, now, UTC, new Set(['m1']))).toBeNull();
    expect(planCatchUp(exam, missed, now, UTC, ['m1'])).toBeNull();
    expect(planCatchUp(exam, missed, now, UTC, new Set(['other']))).not.toBeNull();
    expect(planCatchUp(exam, { ...missed, catch_up_of: 'm0' }, now, UTC)).toBeNull();
  });

  it('keeps an hour away from the exam alarms already planned', () => {
    const exam = { exam_at: '2026-03-12T10:00:00.000Z' };
    const now = iso('2026-03-10T10:00:00.000Z');
    const free = planCatchUp(exam, missed, now, UTC);
    const stacked = planCatchUp(exam, missed, now, UTC, [], [free as Date]);
    expect(stacked?.toISOString()).toBe('2026-03-11T09:00:00.000Z');
    expect(Math.abs((stacked as Date).getTime() - (free as Date).getTime())).toBeGreaterThanOrEqual(3_600_000);
  });
});

describe('classifySession', () => {
  const at = iso('2026-03-10T18:00:00.000Z');
  const base = { at, completion: undefined, silenced: false, graceMinutes: 30 };

  it('is upcoming before the time, due inside the grace window, missed after it', () => {
    expect(classifySession({ ...base, now: iso('2026-03-10T17:59:00.000Z') })).toBe('upcoming');
    expect(classifySession({ ...base, now: iso('2026-03-10T18:00:00.000Z') })).toBe('due');
    expect(classifySession({ ...base, now: iso('2026-03-10T18:29:59.000Z') })).toBe('due');
    expect(classifySession({ ...base, now: iso('2026-03-10T18:30:00.000Z') })).toBe('missed');
  });

  it('is done or skipped when completed, whatever the time', () => {
    const late = iso('2026-03-12T00:00:00.000Z');
    expect(classifySession({ ...base, completion: { status: 'done' }, now: late })).toBe('done');
    expect(classifySession({ ...base, completion: { status: 'skipped_cheat' }, now: late })).toBe('skipped');
  });

  it('is skipped when a cheat day silenced it', () => {
    expect(classifySession({ ...base, silenced: true, now: iso('2026-03-12T00:00:00.000Z') })).toBe('skipped');
  });
});

function event(overrides: Partial<EventRow> & { id: string; start_at: string }): EventRow {
  return {
    user_id: USER,
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

function exam(overrides: Partial<ExamRow> = {}): ExamRow {
  return {
    id: EXAM_ID,
    user_id: USER,
    title: 'Maths',
    exam_at: '2026-03-20T09:00:00.000Z',
    difficulty: 2,
    notes: null,
    active: true,
    created_at: '2026-03-01T00:00:00.000Z',
    updated_at: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

const SETTINGS = { timezone: 'UTC', grace_minutes: 30 };

describe('planCatchUps', () => {
  const s1 = event({ id: 's1', start_at: '2026-03-13T18:00:00.000Z' });
  const s2 = event({ id: 's2', start_at: '2026-03-17T18:00:00.000Z' });
  const s3 = event({ id: 's3', start_at: '2026-03-19T18:00:00.000Z' });
  const alarm = event({ id: 'a', start_at: '2026-03-20T08:00:00.000Z', exam_role: 'exam', passable: false });
  const scan = (now: string, overrides: Partial<Parameters<typeof planCatchUps>[0]> = {}) =>
    planCatchUps({
      exams: [exam()],
      events: [s1, s2, s3, alarm],
      completions: [],
      cheatDays: [],
      settings: SETTINGS,
      now: iso(now),
      ...overrides,
    });

  it('creates one catch-up for a missed session, halfway to the exam', () => {
    const plans = scan('2026-03-13T19:00:00.000Z');
    expect(plans).toHaveLength(1);
    expect(plans[0]?.missed.id).toBe('s1');
    // Halfway between 19:00 on the 13th and 09:00 on the 20th is 22:00 on the 16th: night, so the nearest
    // daytime slot, 21:00 that evening.
    expect(plans[0]?.at.toISOString()).toBe('2026-03-16T21:00:00.000Z');
  });

  it('does nothing while the session can still ring (grace) or while its settle time runs', () => {
    expect(scan('2026-03-13T18:20:00.000Z')).toEqual([]);
    // Grace ended at 18:30, the settle time ends 10 minutes later.
    expect(scan(`2026-03-13T18:${30 + CATCH_UP_SETTLE_MINUTES - 1}:00.000Z`)).toEqual([]);
    expect(scan(`2026-03-13T18:${30 + CATCH_UP_SETTLE_MINUTES}:00.000Z`)).toHaveLength(1);
  });

  it('does nothing for a session that was completed, or silenced by a cheat day', () => {
    const now = '2026-03-13T19:00:00.000Z';
    expect(scan(now, { completions: [{ event_id: 's1', status: 'done' }] })).toEqual([]);
    expect(scan(now, { completions: [{ event_id: 's1', status: 'skipped_cheat' }] })).toEqual([]);
    expect(scan(now, { cheatDays: ['2026-03-13'] })).toEqual([]);
  });

  it('is idempotent: a session that already has a catch-up gets no second one', () => {
    const catchUp = event({ id: 'c1', start_at: '2026-03-16T21:00:00.000Z', catch_up_of: 's1' });
    expect(scan('2026-03-13T19:00:00.000Z', { events: [s1, s2, s3, alarm, catchUp] })).toEqual([]);
    expect(scan('2026-03-13T19:00:00.000Z', { skip: new Set(['s1']) })).toEqual([]);
  });

  it('never makes a catch-up for a missed catch-up', () => {
    const catchUp = event({ id: 'c1', start_at: '2026-03-14T10:00:00.000Z', catch_up_of: 's1' });
    // s1 has its catch-up; the catch-up itself is missed on the 14th.
    expect(scan('2026-03-14T11:00:00.000Z', { events: [s1, s2, s3, alarm, catchUp] })).toEqual([]);
  });

  it('plans nothing when too little time remains before the exam', () => {
    // Under 3 hours left.
    expect(scan('2026-03-20T07:00:00.000Z', { events: [s3] })).toEqual([]);
    // 5 hours left: the window is 04:30 to 08:00, the halfway point is at night and the only daytime slot is
    // 08:00, which the exam's own alarm (also 08:00) rules out; without that alarm it is allowed.
    expect(scan('2026-03-20T04:00:00.000Z', { events: [s3, alarm] })).toEqual([]);
    expect(scan('2026-03-20T04:00:00.000Z', { events: [s3] }).map((plan) => plan.at.toISOString())).toEqual([
      '2026-03-20T08:00:00.000Z',
    ]);
  });

  it('ignores inactive exams, inactive sessions and the exam alarm itself', () => {
    const now = '2026-03-13T19:00:00.000Z';
    expect(scan(now, { exams: [exam({ active: false })] })).toEqual([]);
    expect(scan(now, { events: [{ ...s1, active: false }] })).toEqual([]);
    expect(scan('2026-03-20T08:50:00.000Z', { events: [alarm] })).toEqual([]);
  });

  it('gives two missed sessions of one exam catch-ups that do not stack', () => {
    const plans = scan('2026-03-17T19:00:00.000Z');
    expect(plans.map((plan) => plan.missed.id)).toEqual(['s1', 's2']);
    const [first, second] = plans.map((plan) => plan.at.getTime());
    expect(Math.abs((first as number) - (second as number))).toBeGreaterThanOrEqual(3_600_000);
  });

  it('uses the local zone for cheat days', () => {
    // 2026-03-13T23:30Z is 14 March in Auckland, so a cheat day on the 14th silences it there.
    const late = event({ id: 'late', start_at: '2026-03-13T23:30:00.000Z' });
    const plans = planCatchUps({
      exams: [exam({ exam_at: '2026-03-25T09:00:00.000Z' })],
      events: [late],
      completions: [],
      cheatDays: ['2026-03-14'],
      settings: { timezone: 'Pacific/Auckland', grace_minutes: 30 },
      now: iso('2026-03-14T01:00:00.000Z'),
    });
    expect(plans).toEqual([]);
  });
});

describe('examProgress and lookups', () => {
  const sessions = [
    event({ id: 'a1', start_at: '2026-03-06T18:00:00.000Z' }),
    event({ id: 'a2', start_at: '2026-03-10T18:00:00.000Z' }),
    event({ id: 'a3', start_at: '2026-03-14T18:00:00.000Z' }),
    event({ id: 'a4', start_at: '2026-03-18T18:00:00.000Z' }),
    event({ id: 'a5', start_at: '2026-03-19T18:00:00.000Z', active: false }),
    event({ id: 'other', start_at: '2026-03-12T18:00:00.000Z', exam_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }),
  ];
  const alarm = event({ id: 'x', start_at: '2026-03-20T08:00:00.000Z', exam_role: 'exam' });

  it('counts done, missed, skipped and remaining sessions of one exam', () => {
    const progress = examProgress({
      examId: EXAM_ID,
      events: [...sessions, alarm],
      completions: [{ event_id: 'a1', status: 'done' }],
      cheatDays: ['2026-03-10'],
      settings: SETTINGS,
      now: iso('2026-03-14T18:10:00.000Z'),
    });
    // a1 done, a2 silenced by the cheat day, a3 due (inside grace), a4 upcoming; a5 is inactive, other is another exam.
    expect(progress).toEqual({ total: 4, done: 1, missed: 0, skipped: 1, remaining: 2 });
  });

  it('counts a past session with no completion as missed', () => {
    const progress = examProgress({
      examId: EXAM_ID,
      events: sessions,
      completions: [],
      cheatDays: [],
      settings: SETTINGS,
      now: iso('2026-03-15T00:00:00.000Z'),
    });
    expect(progress).toEqual({ total: 4, done: 0, missed: 3, skipped: 0, remaining: 1 });
  });

  it('finds the sessions and the alarm of an exam, oldest session first', () => {
    expect(sessionsOfExam(EXAM_ID, [...sessions, alarm]).map((e) => e.id)).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(examAlarmOf(EXAM_ID, [...sessions, alarm])?.id).toBe('x');
    expect(examAlarmOf(EXAM_ID, sessions)).toBeNull();
  });
});

describe('exam alarms in the schedule', () => {
  const settings = { ...SETTINGS, user_id: USER, week_starts_on: 0, refire_seconds: 120, pass_cap: 2 };
  const session = event({ id: 's1', start_at: '2026-03-17T18:00:00.000Z' });
  const alarm = event({ id: 'a', start_at: '2026-03-20T08:00:00.000Z', exam_role: 'exam', passable: false });

  it('rings them as ordinary one-off alarms; a cheat day silences a session but never the exam alarm', () => {
    const schedule = expandSchedule({
      events: [session, alarm],
      cheatDays: ['2026-03-17', '2026-03-20'],
      settings,
      completions: [],
      now: iso('2026-03-16T09:00:00.000Z'),
    });
    expect(schedule.occurrences.map((o) => [o.eventId, o.silenced])).toEqual([
      ['s1', true],
      ['a', false],
    ]);
  });

  it('does not score them as habits (they are one-off)', () => {
    expect(isHabit(session)).toBe(false);
    expect(isHabit(alarm)).toBe(false);
  });
});

describe('catchUpsToCancel', () => {
  const missed = event({ id: 's1', start_at: '2026-03-13T18:00:00.000Z' });
  const future = event({ id: 'c1', start_at: '2026-03-16T21:00:00.000Z', catch_up_of: 's1' });
  const now = iso('2026-03-14T10:00:00.000Z');

  it('cancels a catch-up still to come once its session has a completion, whatever its status', () => {
    for (const status of ['done', 'skipped_cheat'] as const) {
      const out = catchUpsToCancel({ events: [missed, future], completions: [{ event_id: 's1', status } as never], now });
      expect(out.map((e) => e.id)).toEqual(['c1']);
    }
  });

  it('leaves it when the session still has none, when its time has passed, or when it is inactive or not a catch-up', () => {
    const done = [{ event_id: 's1' }];
    expect(catchUpsToCancel({ events: [missed, future], completions: [], now })).toEqual([]);
    expect(catchUpsToCancel({ events: [future], completions: done, now: iso('2026-03-16T21:00:00.000Z') })).toEqual([]);
    expect(catchUpsToCancel({ events: [{ ...future, active: false }], completions: done, now })).toEqual([]);
    expect(catchUpsToCancel({ events: [missed], completions: done, now })).toEqual([]);
  });
});
