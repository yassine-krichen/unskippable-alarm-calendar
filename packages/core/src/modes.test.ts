import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EXAM_MODE_DAYS_BEFORE,
  applyModesToInstants,
  buildModeTimeline,
  effectiveModeAt,
  effectiveModeSegments,
  examModeWindows,
  modeEffectOf,
} from './modes';
import type {
  BuiltinModeKey,
  EventRow,
  ModeActivationRow,
  ModeConfig,
  ModeRow,
  ModeRuleRow,
} from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const USER = '99999999-9999-4999-8999-999999999999';
const TZ = { timezone: 'UTC' };

const EXAM_MODE = '00000000-0000-4000-8000-0000000000e1';
const RAMADAN = '00000000-0000-4000-8000-0000000000e2';
const VACATION = '00000000-0000-4000-8000-0000000000e3';
const SICK = '00000000-0000-4000-8000-0000000000e4';
const CUSTOM = '00000000-0000-4000-8000-0000000000e5';

function mode(id: string, builtin: BuiltinModeKey | null, overrides: Partial<ModeRow> = {}): ModeRow {
  return {
    id,
    user_id: USER,
    name: builtin ?? 'Custom',
    kind: builtin === null ? 'custom' : 'builtin',
    builtin_key: builtin,
    default_behavior: 'keep',
    active: true,
    ...overrides,
  };
}

const MODES: ModeRow[] = [
  mode(EXAM_MODE, 'exam'),
  mode(RAMADAN, 'ramadan'),
  mode(VACATION, 'vacation', { default_behavior: 'skip' }),
  mode(SICK, 'sick', { default_behavior: 'skip' }),
  mode(CUSTOM, null),
];

let activationCounter = 0;
function activation(
  modeId: string,
  startsAt: string,
  endsAt: string | null,
  source: ModeActivationRow['source']
): ModeActivationRow {
  activationCounter += 1;
  return {
    id: `a0000000-0000-4000-8000-${String(activationCounter).padStart(12, '0')}`,
    user_id: USER,
    mode_id: modeId,
    starts_at: startsAt,
    ends_at: endsAt,
    source,
  };
}

function config(overrides: Partial<ModeConfig> = {}): ModeConfig {
  return { modes: MODES, rules: [], activations: [], exams: [], ...overrides };
}

function event(overrides: Partial<EventRow> & { id: string }): EventRow {
  return {
    user_id: USER,
    title: 'Habit',
    notes: null,
    start_at: '2026-03-01T09:00:00.000Z',
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
    updated_at: '2026-03-01T09:00:00.000Z',
    ...overrides,
  };
}

const GYM = '11111111-1111-4111-8111-111111111111';
const MEDS = '22222222-2222-4222-8222-222222222222';

function rule(modeId: string, eventId: string, overrides: Partial<ModeRuleRow>): ModeRuleRow {
  return {
    id: `b0000000-0000-4000-8000-${modeId.slice(-6)}${eventId.slice(0, 6)}`,
    user_id: USER,
    mode_id: modeId,
    event_id: eventId,
    behavior: 'keep',
    shift_minutes: null,
    duration_min: null,
    ...overrides,
  };
}

const NOON = Date.parse('2026-03-10T12:00:00.000Z');
const modeAt = (c: ModeConfig, at: number, settings: { timezone: string; exam_mode_days_before?: number } = TZ) =>
  effectiveModeAt(new Date(at), c, settings)?.mode.builtin_key ?? effectiveModeAt(new Date(at), c, settings)?.mode.name ?? null;

describe('effectiveModeAt: which mode is in effect', () => {
  it('is Normal (null) with no activation', () => {
    expect(effectiveModeAt(new Date(NOON), config(), TZ)).toBeNull();
    expect(effectiveModeAt(new Date(NOON), null, TZ)).toBeNull();
  });

  it('an open-ended manual activation holds until it is ended, however long', () => {
    const c = config({ activations: [activation(SICK, '2026-03-10T08:00:00.000Z', null, 'manual')] });
    expect(modeAt(c, NOON - 5 * HOUR)).toBeNull();
    expect(modeAt(c, NOON)).toBe('sick');
    expect(modeAt(c, NOON + 400 * DAY)).toBe('sick');
  });

  it('switching back ends the manual mode at that instant (end exclusive)', () => {
    const c = config({ activations: [activation(SICK, '2026-03-10T08:00:00.000Z', '2026-03-10T14:00:00.000Z', 'manual')] });
    expect(modeAt(c, Date.parse('2026-03-10T13:59:59.999Z'))).toBe('sick');
    expect(modeAt(c, Date.parse('2026-03-10T14:00:00.000Z'))).toBeNull();
  });

  it('manual beats range, and range beats the exam window', () => {
    const exams = [{ id: 'x1', exam_at: '2026-03-12T09:00:00.000Z', active: true }];
    const range = activation(VACATION, '2026-03-09T00:00:00.000Z', '2026-03-20T00:00:00.000Z', 'range');
    const manual = activation(SICK, '2026-03-10T08:00:00.000Z', null, 'manual');
    expect(modeAt(config({ exams }), NOON)).toBe('exam');
    expect(modeAt(config({ exams, activations: [range] }), NOON)).toBe('vacation');
    expect(modeAt(config({ exams, activations: [range, manual] }), NOON)).toBe('sick');
    // Before the manual switch the range still applies; after it ends the range comes back.
    expect(modeAt(config({ exams, activations: [range, manual] }), Date.parse('2026-03-10T07:00:00.000Z'))).toBe('vacation');
    const ended = { ...manual, ends_at: '2026-03-11T00:00:00.000Z' };
    expect(modeAt(config({ exams, activations: [range, ended] }), Date.parse('2026-03-11T01:00:00.000Z'))).toBe('vacation');
  });

  it('exactly one mode at any instant: of two overlapping manual switches the later wins', () => {
    const c = config({
      activations: [
        activation(SICK, '2026-03-10T08:00:00.000Z', null, 'manual'),
        activation(RAMADAN, '2026-03-10T10:00:00.000Z', null, 'manual'),
      ],
    });
    expect(modeAt(c, NOON)).toBe('ramadan');
    expect(modeAt(c, Date.parse('2026-03-10T09:00:00.000Z'))).toBe('sick');
  });

  it('ignores a mode that is off, and an activation with reversed or unreadable times', () => {
    const off = MODES.map((m) => (m.id === SICK ? { ...m, active: false } : m));
    const c = config({
      modes: off,
      activations: [
        activation(SICK, '2026-03-10T08:00:00.000Z', null, 'manual'),
        activation(CUSTOM, '2026-03-11T08:00:00.000Z', '2026-03-10T08:00:00.000Z', 'range'),
        activation(CUSTOM, 'garbage', null, 'manual'),
      ],
    });
    expect(modeAt(c, NOON)).toBeNull();
  });

  it('reads Postgres-style timestamps (space separator, short offset)', () => {
    const c = config({ activations: [activation(SICK, '2026-03-10 08:00:00.123456+00', null, 'manual')] });
    expect(modeAt(c, NOON)).toBe('sick');
  });
});

describe('exam mode: automatic window before an exam', () => {
  const exam = { id: 'x1', exam_at: '2026-03-20T09:00:00.000Z', active: true };

  it('starts at local midnight 10 days before by default and ends when the day after the exam is over', () => {
    expect(DEFAULT_EXAM_MODE_DAYS_BEFORE).toBe(10);
    const [window] = examModeWindows([exam], MODES, TZ);
    expect(new Date(window!.startMs).toISOString()).toBe('2026-03-10T00:00:00.000Z');
    expect(new Date(window!.endMs).toISOString()).toBe('2026-03-22T00:00:00.000Z');
    const c = config({ exams: [exam] });
    expect(modeAt(c, Date.parse('2026-03-09T23:59:59.999Z'))).toBeNull();
    expect(modeAt(c, Date.parse('2026-03-10T00:00:00.000Z'))).toBe('exam');
    expect(modeAt(c, Date.parse('2026-03-21T23:59:59.999Z'))).toBe('exam');
    expect(modeAt(c, Date.parse('2026-03-22T00:00:00.000Z'))).toBeNull();
  });

  it('uses the local day in the settings zone, across a DST change', () => {
    // Paris springs forward on 2026-03-29; an exam on the 30th at 08:00 local, 3 days ahead.
    const paris = { timezone: 'Europe/Paris', exam_mode_days_before: 3 };
    const [window] = examModeWindows([{ id: 'x', exam_at: '2026-03-30T06:00:00.000Z', active: true }], MODES, paris);
    // 27 March 00:00 CET (UTC+1) and 1 April 00:00 CEST (UTC+2).
    expect(new Date(window!.startMs).toISOString()).toBe('2026-03-26T23:00:00.000Z');
    expect(new Date(window!.endMs).toISOString()).toBe('2026-03-31T22:00:00.000Z');
  });

  it('follows the setting, and 0 turns it off', () => {
    expect(examModeWindows([exam], MODES, { timezone: 'UTC', exam_mode_days_before: 3 })[0]!.startMs).toBe(
      Date.parse('2026-03-17T00:00:00.000Z')
    );
    expect(examModeWindows([exam], MODES, { timezone: 'UTC', exam_mode_days_before: 0 })).toEqual([]);
  });

  it('moves with an edit of the exam, vanishes when it is deleted, and needs the Exam mode to be on', () => {
    const before = config({ exams: [exam] });
    const moved = config({ exams: [{ ...exam, exam_at: '2026-03-30T09:00:00.000Z' }] });
    const at = Date.parse('2026-03-12T12:00:00.000Z');
    expect(modeAt(before, at)).toBe('exam');
    expect(modeAt(moved, at)).toBeNull();
    expect(modeAt(moved, Date.parse('2026-03-25T12:00:00.000Z'))).toBe('exam');
    expect(modeAt(config({ exams: [{ ...exam, active: false }] }), at)).toBeNull();
    const examOff = MODES.map((m) => (m.builtin_key === 'exam' ? { ...m, active: false } : m));
    expect(modeAt(config({ modes: examOff, exams: [exam] }), at)).toBeNull();
    expect(modeAt(config({ modes: MODES.filter((m) => m.builtin_key !== 'exam'), exams: [exam] }), at)).toBeNull();
  });

  it('two exams close together give one continuous stretch', () => {
    const second = { id: 'x2', exam_at: '2026-03-25T09:00:00.000Z', active: true };
    const [segment, ...rest] = effectiveModeSegments(
      new Date('2026-03-01T00:00:00.000Z'),
      new Date('2026-04-15T00:00:00.000Z'),
      config({ exams: [exam, second] }),
      TZ
    );
    expect(rest).toEqual([]);
    expect(new Date(segment!.startMs).toISOString()).toBe('2026-03-10T00:00:00.000Z');
    expect(new Date(segment!.endMs).toISOString()).toBe('2026-03-27T00:00:00.000Z');
  });
});

describe('effectiveModeSegments: the range variant', () => {
  it('lists each stretch with its mode, splitting where the precedence changes', () => {
    const c = config({
      activations: [
        activation(VACATION, '2026-03-10T00:00:00.000Z', '2026-03-20T00:00:00.000Z', 'range'),
        activation(SICK, '2026-03-12T00:00:00.000Z', '2026-03-14T00:00:00.000Z', 'manual'),
      ],
    });
    const segments = effectiveModeSegments(new Date('2026-03-05T00:00:00.000Z'), new Date('2026-03-25T00:00:00.000Z'), c, TZ);
    expect(segments.map((s) => [s.mode.builtin_key, new Date(s.startMs).toISOString().slice(0, 10), new Date(s.endMs).toISOString().slice(0, 10)])).toEqual([
      ['vacation', '2026-03-10', '2026-03-12'],
      ['sick', '2026-03-12', '2026-03-14'],
      ['vacation', '2026-03-14', '2026-03-20'],
    ]);
  });

  it('clips to the requested range and returns an open-ended mode up to its end', () => {
    const c = config({ activations: [activation(SICK, '2026-03-01T00:00:00.000Z', null, 'manual')] });
    const [segment] = effectiveModeSegments(new Date('2026-03-10T00:00:00.000Z'), new Date('2026-03-11T00:00:00.000Z'), c, TZ);
    expect(segment).toMatchObject({ startMs: Date.parse('2026-03-10T00:00:00.000Z'), endMs: Date.parse('2026-03-11T00:00:00.000Z') });
  });
});

describe('modeEffectOf: what a mode does to one alarm', () => {
  const sickNow = config({ activations: [activation(SICK, '2026-03-01T00:00:00.000Z', null, 'manual')] });
  const timeline = (c: ModeConfig) => buildModeTimeline(c, TZ);
  const at = NOON;

  it('Sick pauses every passable alarm by default', () => {
    expect(modeEffectOf(event({ id: GYM }), at, timeline(sickNow))).toMatchObject({ kind: 'paused' });
  });

  it('never pauses a non-passable alarm, by the default or by an explicit skip rule', () => {
    const meds = event({ id: MEDS, passable: false });
    expect(modeEffectOf(meds, at, timeline(sickNow))).toEqual({ kind: 'keep' });
    const explicit = config({
      activations: sickNow.activations as ModeActivationRow[],
      rules: [rule(SICK, MEDS, { behavior: 'skip' })],
    });
    expect(modeEffectOf(meds, at, timeline(explicit))).toEqual({ kind: 'keep' });
  });

  it('never affects a prayer or its reminder, whatever the rules say', () => {
    const rules = [rule(SICK, GYM, { behavior: 'shift', shift_minutes: 60 })];
    const c = config({ activations: sickNow.activations as ModeActivationRow[], rules });
    for (const kind of ['prayer', 'pre_prayer'] as const) {
      expect(modeEffectOf(event({ id: GYM, kind, prayer: 'asr' }), at, timeline(c))).toEqual({ kind: 'keep' });
    }
  });

  it('an explicit keep rule beats a skip default', () => {
    const c = config({ activations: sickNow.activations as ModeActivationRow[], rules: [rule(SICK, GYM, { behavior: 'keep' })] });
    expect(modeEffectOf(event({ id: GYM }), at, timeline(c))).toEqual({ kind: 'keep' });
  });

  it('shifts by the rule, also a non-passable alarm (the person picked its new time), and clamps to 12 hours', () => {
    const active = sickNow.activations as ModeActivationRow[];
    const shifted = config({ activations: active, rules: [rule(SICK, MEDS, { behavior: 'shift', shift_minutes: -90 })] });
    expect(modeEffectOf(event({ id: MEDS, passable: false }), at, timeline(shifted))).toMatchObject({ kind: 'shift', minutes: -90 });
    const wild = config({ activations: active, rules: [rule(SICK, GYM, { behavior: 'shift', shift_minutes: 5000 })] });
    expect(modeEffectOf(event({ id: GYM }), at, timeline(wild))).toMatchObject({ kind: 'shift', minutes: 720 });
    const zero = config({ activations: active, rules: [rule(SICK, GYM, { behavior: 'shift', shift_minutes: 0 })] });
    expect(modeEffectOf(event({ id: GYM }), at, timeline(zero))).toEqual({ kind: 'keep' });
  });

  it('shortens by the rule and keeps a rule with no value harmless', () => {
    const active = sickNow.activations as ModeActivationRow[];
    const shortened = config({ activations: active, rules: [rule(SICK, GYM, { behavior: 'shorten', duration_min: 10 })] });
    expect(modeEffectOf(event({ id: GYM }), at, timeline(shortened))).toMatchObject({ kind: 'shorten', durationMin: 10 });
    const broken = config({ activations: active, rules: [rule(SICK, GYM, { behavior: 'shorten', duration_min: null })] });
    expect(modeEffectOf(event({ id: GYM }), at, timeline(broken))).toEqual({ kind: 'keep' });
  });

  it('is chosen by the mode at the occurrence time, not at the time of asking', () => {
    const c = config({ activations: [activation(SICK, '2026-03-10T00:00:00.000Z', '2026-03-11T00:00:00.000Z', 'manual')] });
    const t = timeline(c);
    expect(modeEffectOf(event({ id: GYM }), Date.parse('2026-03-10T09:00:00.000Z'), t).kind).toBe('paused');
    expect(modeEffectOf(event({ id: GYM }), Date.parse('2026-03-11T09:00:00.000Z'), t).kind).toBe('keep');
  });

  it('applies the rules of the mode in effect only', () => {
    const c = config({
      activations: [
        activation(RAMADAN, '2026-03-01T00:00:00.000Z', null, 'manual'),
      ],
      rules: [rule(SICK, GYM, { behavior: 'skip' }), rule(RAMADAN, GYM, { behavior: 'shift', shift_minutes: 120 })],
    });
    expect(modeEffectOf(event({ id: GYM }), at, timeline(c))).toMatchObject({ kind: 'shift', minutes: 120 });
  });
});

describe('applyModesToInstants', () => {
  const day = (n: number) => new Date(Date.parse('2026-03-10T09:00:00.000Z') + n * DAY);

  it('returns the instants unchanged without modes and for a prayer', () => {
    const instants = [day(0), day(1)];
    const none = applyModesToInstants(event({ id: GYM }), instants, buildModeTimeline(null, TZ));
    expect(none.map((m) => m.at)).toEqual(instants);
    expect(none.every((m) => !m.paused && m.mode === null && m.durationMin === null)).toBe(true);
    const sick = buildModeTimeline(config({ activations: [activation(SICK, '2026-03-01T00:00:00.000Z', null, 'manual')] }), TZ);
    expect(applyModesToInstants(event({ id: GYM, kind: 'prayer', prayer: 'fajr' }), instants, sick).some((m) => m.paused)).toBe(false);
  });

  it('flags paused ones, moves shifted ones, and sorts by the new time', () => {
    const c = config({
      activations: [activation(RAMADAN, '2026-03-10T00:00:00.000Z', '2026-03-11T12:00:00.000Z', 'manual')],
      rules: [rule(RAMADAN, GYM, { behavior: 'shift', shift_minutes: 600 })],
    });
    const out = applyModesToInstants(event({ id: GYM }), [day(0), day(1), day(2)], buildModeTimeline(c, TZ));
    // Days 0 and 1 are inside Ramadan (shifted +10 h), day 2 is after it.
    expect(out.map((m) => m.at.toISOString())).toEqual([
      '2026-03-10T19:00:00.000Z',
      '2026-03-11T19:00:00.000Z',
      '2026-03-12T09:00:00.000Z',
    ]);
    expect(out[0]!.original.toISOString()).toBe('2026-03-10T09:00:00.000Z');
  });

  it('keeps one occurrence when a shift lands on another, preferring the live one over a paused one', () => {
    // A mode that shifts by +24h is not allowed; use two hourly occurrences and a boundary instead.
    const hourly = [new Date('2026-03-10T10:00:00.000Z'), new Date('2026-03-10T11:00:00.000Z')];
    const c = config({
      // In effect only for the 10:00 occurrence, which it shifts onto 11:00.
      activations: [activation(RAMADAN, '2026-03-10T09:30:00.000Z', '2026-03-10T10:30:00.000Z', 'manual')],
      rules: [rule(RAMADAN, GYM, { behavior: 'shift', shift_minutes: 60 })],
    });
    const out = applyModesToInstants(event({ id: GYM }), hourly, buildModeTimeline(c, TZ));
    expect(out).toHaveLength(1);
    expect(out[0]!.at.toISOString()).toBe('2026-03-10T11:00:00.000Z');
  });
});
