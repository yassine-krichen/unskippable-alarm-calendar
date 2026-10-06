import { describe, expect, it } from 'vitest';

import { examProgress, planCatchUps, sessionStateOf } from './exams';
import { buildModeTimeline } from './modes';
import type { EventRow, ExamRow, ModeActivationRow, ModeConfig, ModeRow } from './types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const USER = '99999999-9999-4999-8999-999999999999';
const SICK = '00000000-0000-4000-8000-0000000000e4';
const EXAM_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-03-10T12:00:00.000Z');
const SETTINGS = { timezone: 'UTC', grace_minutes: 30 };

const exam: ExamRow = {
  id: EXAM_ID,
  user_id: USER,
  title: 'Maths',
  exam_at: new Date(NOW.getTime() + 5 * DAY).toISOString(),
  difficulty: 2,
  notes: null,
  active: true,
  created_at: '2026-03-01T00:00:00.000Z',
  updated_at: '2026-03-01T00:00:00.000Z',
};

function session(id: string, startAt: string, overrides: Partial<EventRow> = {}): EventRow {
  return {
    id,
    user_id: USER,
    title: 'Revision',
    notes: null,
    start_at: startAt,
    duration_min: 60,
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

const SICK_MODE: ModeRow = { id: SICK, user_id: USER, name: 'Sick', kind: 'builtin', builtin_key: 'sick', default_behavior: 'skip', active: true };
const sickFrom = (startsAt: string): ModeActivationRow => ({ id: 'a0000000-0000-4000-8000-000000000001', user_id: USER, mode_id: SICK, starts_at: startsAt, ends_at: null, source: 'manual' });
const modes: ModeConfig = { modes: [SICK_MODE], rules: [], activations: [sickFrom('2026-03-09T00:00:00.000Z')], exams: [] };

// Rang yesterday at 18:00 while sick, long past its grace window.
const missed = session('44444444-4444-4444-8444-444444444444', '2026-03-09T18:00:00.000Z');

describe('revision sessions and modes', () => {
  it('a session a mode pauses is skipped, not missed', () => {
    expect(sessionStateOf(missed, [], new Set(), SETTINGS, NOW)).toBe('missed');
    expect(sessionStateOf(missed, [], new Set(), SETTINGS, NOW, buildModeTimeline(modes, SETTINGS))).toBe('skipped');
  });

  it('gets no catch-up while sick, but does once the mode is not covering it', () => {
    const scan = { exams: [exam], events: [missed], completions: [], cheatDays: [], settings: SETTINGS, now: NOW };
    expect(planCatchUps(scan)).toHaveLength(1);
    expect(planCatchUps({ ...scan, modes })).toEqual([]);
    const afterwards: ModeConfig = { ...modes, activations: [sickFrom('2026-03-10T00:00:00.000Z')] };
    expect(planCatchUps({ ...scan, modes: afterwards })).toHaveLength(1);
  });

  it('counts a paused session as skipped in the exam progress', () => {
    const upcoming = session('55555555-5555-4555-8555-555555555555', '2026-03-12T18:00:00.000Z');
    const progress = examProgress({ examId: EXAM_ID, events: [missed, upcoming], completions: [], cheatDays: [], settings: SETTINGS, now: NOW, modes });
    expect(progress).toMatchObject({ total: 2, skipped: 2, missed: 0, remaining: 0 });
  });

  it('never pauses the exam alarm itself (it is not passable)', () => {
    const alarm = session('66666666-6666-4666-8666-666666666666', '2026-03-15T08:00:00.000Z', { exam_role: 'exam', passable: false });
    const later = new Date('2026-03-15T08:10:00.000Z');
    expect(sessionStateOf(alarm, [], new Set(), SETTINGS, later, buildModeTimeline(modes, SETTINGS))).toBe('due');
  });

  it('a done session stays done under a mode', () => {
    expect(sessionStateOf(missed, [{ event_id: missed.id, status: 'done' }], new Set(), SETTINGS, NOW, buildModeTimeline(modes, SETTINGS))).toBe('done');
  });
});
