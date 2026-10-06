import { describe, expect, it } from 'vitest';

import { BUILTIN_MODES, EXAM_MODE_ID, RAMADAN_ID, SICK_ID, eventRow, ruleRow } from './mode-fixtures';
import { describeShift, implicitBehavior, ruleCandidates, ruleChanges, ruleRowsFor } from './rules-editor';

const sick = BUILTIN_MODES.find((mode) => mode.id === SICK_ID)!;
const exam = BUILTIN_MODES.find((mode) => mode.id === EXAM_MODE_ID)!;
const ramadan = BUILTIN_MODES.find((mode) => mode.id === RAMADAN_ID)!;

const gym = eventRow({ id: 'e1', title: 'Gym' });
const meds = eventRow({ id: 'e2', title: 'Meds', passable: false });
const reading = eventRow({ id: 'e3', title: 'Reading', duration_min: 20 });
const oneOff = eventRow({ id: 'e4', title: 'Dentist', repeat_unit: 'none' });
const fajr = eventRow({ id: 'e5', title: 'Fajr', kind: 'prayer', prayer: 'fajr', passable: false });
const gone = eventRow({ id: 'e6', title: 'Old', active: false });
const events = [reading, gym, meds, oneOff, fajr, gone];

describe('ruleCandidates', () => {
  it('lists the active repeating ordinary alarms by title, never prayers, one-offs or switched-off ones', () => {
    expect(ruleCandidates(events).map((event) => event.title)).toEqual(['Gym', 'Meds', 'Reading']);
  });
});

describe('ruleRowsFor: the lines of a mode', () => {
  it('Sick comes pre-filled: every passable alarm is paused, the one that always rings is kept', () => {
    const rows = ruleRowsFor(sick, events, []);
    expect(rows.map((row) => [row.title, row.behavior, row.alwaysRings])).toEqual([
      ['Gym', 'skip', false],
      ['Meds', 'keep', true],
      ['Reading', 'skip', false],
    ]);
  });

  it('a mode that keeps by default shows keep for everything', () => {
    expect(ruleRowsFor(exam, events, []).map((row) => row.behavior)).toEqual(['keep', 'keep', 'keep']);
  });

  it('shows the stored rule instead of the default, with its value', () => {
    const rules = [
      ruleRow(RAMADAN_ID, 'e1', { behavior: 'shift', shift_minutes: -90 }),
      ruleRow(RAMADAN_ID, 'e3', { behavior: 'shorten', duration_min: 7 }),
      ruleRow(SICK_ID, 'e1', { behavior: 'keep' }),
    ];
    const rows = ruleRowsFor(ramadan, events, rules);
    expect(rows[0]).toMatchObject({ title: 'Gym', behavior: 'shift', shiftMinutes: -90 });
    expect(rows[2]).toMatchObject({ title: 'Reading', behavior: 'shorten', durationMin: 7 });
    // The Sick rule on the same alarm is not this mode's.
    expect(ruleRowsFor(sick, events, rules)[0]).toMatchObject({ title: 'Gym', behavior: 'keep' });
  });

  it('shows a skip rule on an alarm that always rings as what it does: keep', () => {
    const rows = ruleRowsFor(exam, events, [ruleRow(EXAM_MODE_ID, 'e2', { behavior: 'skip' })]);
    expect(rows[1]).toMatchObject({ title: 'Meds', behavior: 'keep', alwaysRings: true });
  });

  it('starts a new shift at an hour and a new shorten at half the alarm', () => {
    const [row] = ruleRowsFor(exam, [reading], []);
    expect(row).toMatchObject({ shiftMinutes: 60, durationMin: 10 });
  });
});

describe('implicitBehavior', () => {
  it('only a passable alarm is paused by a skipping default', () => {
    expect(implicitBehavior(sick, false)).toBe('skip');
    expect(implicitBehavior(sick, true)).toBe('keep');
    expect(implicitBehavior(exam, false)).toBe('keep');
  });
});

describe('ruleChanges: from the edited lines to writes', () => {
  it('writes nothing for lines that do what the default does', () => {
    expect(ruleChanges(sick, ruleRowsFor(sick, events, []), [])).toEqual({ upserts: [], deletes: [], invalid: [] });
    expect(ruleChanges(exam, ruleRowsFor(exam, events, []), [])).toEqual({ upserts: [], deletes: [], invalid: [] });
  });

  it('writes an explicit rule when a line differs from the default, with only its own value', () => {
    const rows = ruleRowsFor(ramadan, events, []).map((row) =>
      row.title === 'Gym'
        ? { ...row, behavior: 'shift' as const, shiftMinutes: 120 }
        : row.title === 'Reading'
          ? { ...row, behavior: 'shorten' as const, durationMin: 12 }
          : row
    );
    expect(ruleChanges(ramadan, rows, []).upserts).toEqual([
      { mode_id: RAMADAN_ID, event_id: 'e1', behavior: 'shift', shift_minutes: 120, duration_min: null },
      { mode_id: RAMADAN_ID, event_id: 'e3', behavior: 'shorten', shift_minutes: null, duration_min: 12 },
    ]);
  });

  it('a skip under Ramadan and a keep under Sick are rules; the paused-by-default stays rule-free', () => {
    const skipGym = ruleRowsFor(ramadan, events, []).map((row) => (row.title === 'Gym' ? { ...row, behavior: 'skip' as const } : row));
    expect(ruleChanges(ramadan, skipGym, []).upserts).toEqual([
      { mode_id: RAMADAN_ID, event_id: 'e1', behavior: 'skip', shift_minutes: null, duration_min: null },
    ]);
    const keepGym = ruleRowsFor(sick, events, []).map((row) => (row.title === 'Gym' ? { ...row, behavior: 'keep' as const } : row));
    expect(ruleChanges(sick, keepGym, []).upserts).toEqual([
      { mode_id: SICK_ID, event_id: 'e1', behavior: 'keep', shift_minutes: null, duration_min: null },
    ]);
  });

  it('deletes the stored rule when the line goes back to the default, and leaves an unchanged rule alone', () => {
    const rules = [ruleRow(SICK_ID, 'e1', { behavior: 'keep' }), ruleRow(SICK_ID, 'e3', { behavior: 'shift', shift_minutes: 30 })];
    const rows = ruleRowsFor(sick, events, rules);
    expect(ruleChanges(sick, rows, rules)).toEqual({ upserts: [], deletes: [], invalid: [] });
    const reset = rows.map((row) => (row.title === 'Gym' ? { ...row, behavior: 'skip' as const } : row));
    expect(ruleChanges(sick, reset, rules).deletes).toEqual([rules[0]!.id]);
  });

  it('a rule that is only edited in its value is written again', () => {
    const rules = [ruleRow(RAMADAN_ID, 'e1', { behavior: 'shift', shift_minutes: 60 })];
    const rows = ruleRowsFor(ramadan, events, rules).map((row) => (row.title === 'Gym' ? { ...row, shiftMinutes: 75 } : row));
    expect(ruleChanges(ramadan, rows, rules).upserts).toEqual([
      { mode_id: RAMADAN_ID, event_id: 'e1', behavior: 'shift', shift_minutes: 75, duration_min: null },
    ]);
  });

  it('never writes a skip for an alarm that always rings', () => {
    const rows = ruleRowsFor(ramadan, events, []).map((row) => (row.title === 'Meds' ? { ...row, behavior: 'skip' as const } : row));
    expect(ruleChanges(ramadan, rows, [])).toEqual({ upserts: [], deletes: [], invalid: [] });
  });

  it('flags a shift of 0 or beyond 12 hours and a shorten of 0 instead of writing them', () => {
    const rows = ruleRowsFor(ramadan, events, []).map((row) =>
      row.title === 'Gym'
        ? { ...row, behavior: 'shift' as const, shiftMinutes: 0 }
        : row.title === 'Meds'
          ? { ...row, behavior: 'shift' as const, shiftMinutes: 721 }
          : { ...row, behavior: 'shorten' as const, durationMin: 0 }
    );
    expect(ruleChanges(ramadan, rows, [])).toEqual({ upserts: [], deletes: [], invalid: ['e1', 'e2', 'e3'] });
  });

  it('flipping the default moves the alarms that have no rule, without writing for them', () => {
    // Sick edited to keep by default: the untouched lines now show keep and need no rule.
    const draft = { ...sick, default_behavior: 'keep' as const };
    const rows = ruleRowsFor(draft, events, []);
    expect(rows.map((row) => row.behavior)).toEqual(['keep', 'keep', 'keep']);
    expect(ruleChanges(draft, rows, [])).toEqual({ upserts: [], deletes: [], invalid: [] });
    // An alarm with its own rule keeps it across the flip.
    const rules = [ruleRow(SICK_ID, 'e1', { behavior: 'skip' })];
    expect(ruleRowsFor(draft, events, rules)[0]).toMatchObject({ title: 'Gym', behavior: 'skip' });
  });
});

describe('describeShift', () => {
  it('reads as a person would', () => {
    expect(describeShift(60)).toBe('+1 h');
    expect(describeShift(-30)).toBe('-30 min');
    expect(describeShift(90)).toBe('+1 h 30 min');
    expect(describeShift(-720)).toBe('-12 h');
  });
});
