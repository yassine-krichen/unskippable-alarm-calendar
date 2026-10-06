import { describe, expect, it } from 'vitest';

import { classifyOccurrence, computeHabitsReport, type HabitCompletion, type HabitEvent, type HabitSettings } from './habits';
import { DEFAULT_PRAYER_SETTINGS, PRAYER_NAMES, prayerTimesOnDay, resolvePrayerConfig } from './prayer-times';
import { dayNumberFromDateString } from './time-zone';
import type { ModeActivationRow, ModeConfig, ModeRow, ModeRuleRow } from './types';

const DAY = 86_400_000;
const USER = '99999999-9999-4999-8999-999999999999';
const NOW = new Date('2026-10-20T20:30:00.000Z');
const SICK = '00000000-0000-4000-8000-0000000000e4';
const RAMADAN = '00000000-0000-4000-8000-0000000000e2';
const GYM = '11111111-1111-4111-8111-111111111111';
const MEDS = '22222222-2222-4222-8222-222222222222';

const SETTINGS: HabitSettings = { timezone: 'UTC', grace_minutes: 30 };

const MODES: ModeRow[] = [
  { id: SICK, user_id: USER, name: 'Sick', kind: 'builtin', builtin_key: 'sick', default_behavior: 'skip', active: true },
  { id: RAMADAN, user_id: USER, name: 'Ramadan', kind: 'builtin', builtin_key: 'ramadan', default_behavior: 'keep', active: true },
];

function habit(overrides: Partial<HabitEvent> = {}): HabitEvent {
  return {
    id: GYM,
    title: 'Gym',
    // Daily at 10:00 UTC from 1 October.
    start_at: '2026-10-01T10:00:00.000Z',
    repeat_unit: 'day',
    repeat_interval: 1,
    repeat_weekdays: null,
    ends_at: null,
    active: true,
    passable: true,
    color: null,
    created_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

const DATES = Array.from({ length: 20 }, (_, i) => new Date(Date.UTC(2026, 9, 1) + i * DAY).toISOString().slice(0, 10));

function doneOn(dates: string[], eventId = GYM, time = '10:00:00.000Z'): HabitCompletion[] {
  return dates.map((date) => ({ event_id: eventId, occurrence_at: `${date}T${time}`, status: 'done', snoozes_used: 0 }));
}

function activation(modeId: string, startsAt: string, endsAt: string | null): ModeActivationRow {
  return { id: `a0000000-0000-4000-8000-${modeId.slice(-12)}`, user_id: USER, mode_id: modeId, starts_at: startsAt, ends_at: endsAt, source: 'manual' };
}

function rule(modeId: string, eventId: string, overrides: Partial<ModeRuleRow>): ModeRuleRow {
  return { id: `b0000000-0000-4000-8000-${eventId.slice(0, 12)}`, user_id: USER, mode_id: modeId, event_id: eventId, behavior: 'keep', shift_minutes: null, duration_min: null, ...overrides };
}

const config = (overrides: Partial<ModeConfig>): ModeConfig => ({ modes: MODES, rules: [], activations: [], exams: [], ...overrides });

describe('classifyOccurrence with a paused occurrence', () => {
  const base = { passable: true, at: new Date('2026-10-10T10:00:00.000Z'), now: NOW, cheatDays: new Set<string>(), timezone: 'UTC', graceMinutes: 30 };

  it('is paused, not missed, and a completion still wins', () => {
    expect(classifyOccurrence({ ...base, completion: undefined, paused: true })).toBe('paused');
    expect(classifyOccurrence({ ...base, completion: { status: 'done' }, paused: true })).toBe('done');
    expect(classifyOccurrence({ ...base, completion: undefined })).toBe('missed');
  });
});

describe('habit scoring with modes', () => {
  it('leaves paused occurrences out of the score like excused ones, and out of the missed count', () => {
    // Done 1 to 9 October; sick (everything paused) 10 to 14 October; done 15 to 20 October.
    const completions = doneOn([...DATES.slice(0, 9), ...DATES.slice(14)]);
    const sick = config({ activations: [activation(SICK, '2026-10-10T00:00:00.000Z', '2026-10-15T00:00:00.000Z')] });
    const without = computeHabitsReport([habit()], completions, [], SETTINGS, NOW).habits[0]!;
    const withMode = computeHabitsReport([habit()], completions, [], SETTINGS, NOW, sick).habits[0]!;
    expect(without).toMatchObject({ missed: 5, paused: 0 });
    expect(withMode).toMatchObject({ done: 15, missed: 0, paused: 5, excused: 0, score: 100, tier: 'diamond' });
    expect(withMode.occurrences.filter((o) => o.outcome === 'paused')).toHaveLength(5);
  });

  it('a paused stretch neither breaks nor extends a streak', () => {
    const completions = doneOn([...DATES.slice(0, 9), ...DATES.slice(14)]);
    const sick = config({ activations: [activation(SICK, '2026-10-10T00:00:00.000Z', '2026-10-15T00:00:00.000Z')] });
    const stats = computeHabitsReport([habit()], completions, [], SETTINGS, NOW, sick).habits[0]!;
    expect(stats.currentStreak).toBe(15);
    expect(stats.bestStreak).toBe(15);
  });

  it('an open-ended manual Sick pauses every passable habit from its start, and a non-passable one is still scored', () => {
    const meds = habit({ id: MEDS, title: 'Meds', passable: false });
    const sick = config({ activations: [activation(SICK, '2026-10-17T00:00:00.000Z', null)] });
    const report = computeHabitsReport([habit(), meds], doneOn(DATES.slice(0, 16)), [], SETTINGS, NOW, sick);
    const [gym, medication] = report.habits;
    expect(gym).toMatchObject({ done: 16, missed: 0, paused: 4 });
    // 17 to 20 October: the medication was not paused, so with no completion it counts as missed.
    expect(medication).toMatchObject({ done: 0, missed: 20, paused: 0 });
  });

  it('a Done on a paused occurrence still counts as done', () => {
    const sick = config({ activations: [activation(SICK, '2026-10-17T00:00:00.000Z', null)] });
    const stats = computeHabitsReport([habit()], doneOn(DATES), [], SETTINGS, NOW, sick).habits[0]!;
    expect(stats).toMatchObject({ done: 20, paused: 0, missed: 0 });
  });

  it('scores a shifted occurrence where it rang: done at the new time, missed when nothing was done', () => {
    const ramadan = config({
      activations: [activation(RAMADAN, '2026-10-15T00:00:00.000Z', null)],
      rules: [rule(RAMADAN, GYM, { behavior: 'shift', shift_minutes: 600 })],
    });
    // 15 to 19 October rang at 20:00; 20 October's rings at 20:00 too, which is before NOW (20:30) and inside the grace window... 30 minutes: still pending.
    const completions = [...doneOn(DATES.slice(0, 14)), ...doneOn(DATES.slice(14, 17), GYM, '20:00:00.000Z')];
    const stats = computeHabitsReport([habit()], completions, [], SETTINGS, NOW, ramadan).habits[0]!;
    expect(stats).toMatchObject({ done: 17, missed: 2, pending: 1 });
    expect(stats.occurrences.slice(-1)[0]!.at.toISOString()).toBe('2026-10-20T20:00:00.000Z');
  });

  it('also accepts a Done recorded at the original time of a shifted occurrence', () => {
    const ramadan = config({
      activations: [activation(RAMADAN, '2026-10-15T00:00:00.000Z', null)],
      rules: [rule(RAMADAN, GYM, { behavior: 'shift', shift_minutes: 600 })],
    });
    const stats = computeHabitsReport([habit()], doneOn(DATES.slice(0, 18)), [], SETTINGS, NOW, ramadan).habits[0]!;
    expect(stats).toMatchObject({ done: 18, missed: 1 });
  });

  it('does not score an occurrence that was shifted ahead of now yet (pending, not missed)', () => {
    // 20 October 10:00 shifted +12 h rings at 22:00, after NOW (20:30): not yet due.
    const ramadan = config({
      activations: [activation(RAMADAN, '2026-10-15T00:00:00.000Z', null)],
      rules: [rule(RAMADAN, GYM, { behavior: 'shift', shift_minutes: 720 })],
    });
    const stats = computeHabitsReport([habit()], doneOn(DATES.slice(0, 19)), [], SETTINGS, NOW, ramadan).habits[0]!;
    // 15 to 19 October rang at 22:00 and have no completion at that time; the Done at 10:00 covers the original.
    expect(stats.missed).toBe(0);
    expect(stats.occurrences.every((o) => o.at.getTime() <= NOW.getTime())).toBe(true);
    expect(stats.occurrences.some((o) => o.at.toISOString() === '2026-10-20T22:00:00.000Z')).toBe(false);
  });

  it('a shorten rule changes nothing in scoring', () => {
    const ramadan = config({
      activations: [activation(RAMADAN, '2026-10-01T00:00:00.000Z', null)],
      rules: [rule(RAMADAN, GYM, { behavior: 'shorten', duration_min: 5 })],
    });
    const completions = doneOn(DATES.slice(0, 19));
    expect(computeHabitsReport([habit()], completions, [], SETTINGS, NOW, ramadan).habits[0]).toEqual(
      computeHabitsReport([habit()], completions, [], SETTINGS, NOW).habits[0]
    );
  });

  it('never pauses a prayer, even in Sick, and keeps it scored from its own times', () => {
    const settings: HabitSettings = {
      ...SETTINGS,
      timezone: 'Africa/Tunis',
      ...DEFAULT_PRAYER_SETTINGS,
      prayers_enabled: true,
      prayers_enabled_since: '2026-10-01T00:00:00.000Z',
    };
    const prayerConfig = resolvePrayerConfig(settings)!;
    const dhuhr = habit({
      id: '0000000a-0000-4000-8000-000000000001',
      title: 'dhuhr',
      kind: 'prayer',
      prayer: 'dhuhr',
      passable: false,
      start_at: '2026-10-01T00:00:00.000Z',
    });
    expect(PRAYER_NAMES).toContain('dhuhr');
    const prayed = DATES.map((date) => ({
      event_id: dhuhr.id,
      occurrence_at: prayerTimesOnDay(prayerConfig, dayNumberFromDateString(date)).dhuhr.toISOString(),
      status: 'done' as const,
      snoozes_used: 0,
    }));
    const sick = config({ activations: [activation(SICK, '2026-10-01T00:00:00.000Z', null)], rules: [rule(SICK, dhuhr.id, { behavior: 'skip' })] });
    const stats = computeHabitsReport([dhuhr], prayed.slice(0, 15), [], settings, NOW, sick).habits[0]!;
    expect(stats).toMatchObject({ paused: 0, done: 15, missed: 5 });
  });

  it('is identical to no modes when none is in effect', () => {
    const completions = doneOn(DATES.slice(0, 18));
    const idle = config({ activations: [activation(SICK, '2026-12-01T00:00:00.000Z', null)] });
    expect(computeHabitsReport([habit()], completions, [], SETTINGS, NOW, idle)).toEqual(
      computeHabitsReport([habit()], completions, [], SETTINGS, NOW)
    );
  });

  it('pauses an exam-mode window derived from the exams', () => {
    const examMode: ModeRow = { id: '00000000-0000-4000-8000-0000000000e1', user_id: USER, name: 'Exam', kind: 'builtin', builtin_key: 'exam', default_behavior: 'skip', active: true };
    const modes = config({ modes: [examMode], exams: [{ id: 'x1', exam_at: '2026-10-12T09:00:00.000Z', active: true }] });
    // Window with 3 days lead: 9 October to the end of the 13th, the day after the exam.
    const stats = computeHabitsReport([habit()], doneOn([...DATES.slice(0, 8), ...DATES.slice(13)]), [], { ...SETTINGS, exam_mode_days_before: 3 }, NOW, modes).habits[0]!;
    expect(stats).toMatchObject({ paused: 5, missed: 0, done: 15 });
  });
});

describe('habit scoring: a Done at a shifted time after the mode ended', () => {
  it('counts the day it was done at 09:30 (shifted by -30) although the mode ended at 09:35 and the occurrence is back at 10:00', () => {
    const ramadan = config({
      activations: [activation(RAMADAN, '2026-10-01T00:00:00.000Z', '2026-10-20T09:35:00.000Z')],
      rules: [rule(RAMADAN, GYM, { behavior: 'shift', shift_minutes: -30 })],
    });
    const completions = doneOn(DATES, GYM, '09:30:00.000Z');
    const stats = computeHabitsReport([habit()], completions, [], SETTINGS, NOW, ramadan).habits[0]!;
    expect(stats).toMatchObject({ done: 20, missed: 0 });
  });

  it('without the shift rule the 09:30 Dones are not a match for 10:00', () => {
    const ended = config({ activations: [activation(RAMADAN, '2026-10-01T00:00:00.000Z', '2026-10-20T09:35:00.000Z')] });
    const stats = computeHabitsReport([habit()], doneOn(DATES, GYM, '09:30:00.000Z'), [], SETTINGS, NOW, ended).habits[0]!;
    expect(stats.done).toBe(0);
  });
});
