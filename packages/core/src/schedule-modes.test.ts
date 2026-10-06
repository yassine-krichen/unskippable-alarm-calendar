import { describe, expect, it } from 'vitest';

import { DEFAULT_PRAYER_SETTINGS, PRAYER_NAMES } from './prayer-times';
import { buildSchedulePayload, expandSchedule, makeOccurrenceId } from './schedule';
import type { AlarmSettings, EventRow, ModeActivationRow, ModeConfig, ModeRow, ModeRuleRow } from './types';

const USER = '99999999-9999-4999-8999-999999999999';
const NOW = new Date('2026-03-02T09:00:00.000Z');
const SICK = '00000000-0000-4000-8000-0000000000e4';
const RAMADAN = '00000000-0000-4000-8000-0000000000e2';
const GYM = '11111111-1111-4111-8111-111111111111';
const MEDS = '22222222-2222-4222-8222-222222222222';

const SETTINGS: AlarmSettings = {
  user_id: USER,
  timezone: 'UTC',
  week_starts_on: 0,
  refire_seconds: 120,
  pass_cap: 2,
  grace_minutes: 30,
};

function mode(id: string, key: ModeRow['builtin_key'], defaultBehavior: ModeRow['default_behavior']): ModeRow {
  return { id, user_id: USER, name: key ?? 'x', kind: 'builtin', builtin_key: key, default_behavior: defaultBehavior, active: true };
}

const MODES = [mode(SICK, 'sick', 'skip'), mode(RAMADAN, 'ramadan', 'keep')];

function manual(modeId: string, startsAt: string, endsAt: string | null): ModeActivationRow {
  return { id: `a0000000-0000-4000-8000-${modeId.slice(-12)}`, user_id: USER, mode_id: modeId, starts_at: startsAt, ends_at: endsAt, source: 'manual' };
}

function rule(modeId: string, eventId: string, overrides: Partial<ModeRuleRow>): ModeRuleRow {
  return { id: `b0000000-0000-4000-8000-${eventId.slice(0, 12)}`, user_id: USER, mode_id: modeId, event_id: eventId, behavior: 'keep', shift_minutes: null, duration_min: null, ...overrides };
}

function config(overrides: Partial<ModeConfig>): ModeConfig {
  return { modes: MODES, rules: [], activations: [], exams: [], ...overrides };
}

function event(overrides: Partial<EventRow> & { id: string }): EventRow {
  return {
    user_id: USER,
    title: 'Gym',
    notes: null,
    // Daily at 10:00 UTC.
    start_at: '2026-03-01T10:00:00.000Z',
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
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function expand(events: EventRow[], modes: ModeConfig | undefined, extra: Partial<Parameters<typeof expandSchedule>[0]> = {}) {
  return expandSchedule({ events, cheatDays: [], settings: SETTINGS, completions: [], now: NOW, ...(modes === undefined ? {} : { modes }), ...extra });
}

const days = (list: { at: string }[]) => list.map((o) => o.at.slice(0, 10));

describe('expandSchedule with modes', () => {
  it('is unchanged without modes, and with modes that are not in effect', () => {
    const plain = expand([event({ id: GYM })], undefined);
    const idle = expand([event({ id: GYM })], config({ activations: [manual(SICK, '2026-06-01T00:00:00.000Z', null)] }));
    expect(idle.occurrences).toEqual(plain.occurrences);
    expect(plain.occurrences.length).toBeGreaterThan(55);
  });

  it('leaves out what a skipping mode pauses, so the engine never sees it, and the rest rings as before', () => {
    // Sick from 4 March 00:00 to 7 March 00:00: the 10:00 occurrences on the 4th, 5th and 6th are paused.
    const sick = config({ activations: [manual(SICK, '2026-03-04T00:00:00.000Z', '2026-03-07T00:00:00.000Z')] });
    const { occurrences } = expand([event({ id: GYM })], sick);
    const listed = days(occurrences);
    expect(listed).toContain('2026-03-03');
    expect(listed).not.toContain('2026-03-04');
    expect(listed).not.toContain('2026-03-05');
    expect(listed).not.toContain('2026-03-06');
    expect(listed).toContain('2026-03-07');
  });

  it('an open-ended manual Sick pauses everything passable from now on, until it is ended', () => {
    const open = config({ activations: [manual(SICK, '2026-03-02T08:00:00.000Z', null)] });
    const paused = expand([event({ id: GYM })], open);
    expect(paused.occurrences).toEqual([]);
    // The alarm is still known to the engine (eventInfo), so a ringing one is not dismissed as deleted.
    expect(Object.keys(paused.eventInfo)).toEqual([GYM]);
    const ended = config({ activations: [manual(SICK, '2026-03-02T08:00:00.000Z', '2026-03-02T09:30:00.000Z')] });
    // Today's 10:00 comes after the switch back to Normal at 09:30, so it rings.
    expect(expand([event({ id: GYM })], ended).occurrences[0]!.at).toBe('2026-03-02T10:00:00.000Z');
  });

  it('keeps a non-passable alarm (medication) ringing through Sick, and never touches the prayers', () => {
    const open = config({ activations: [manual(SICK, '2026-03-02T08:00:00.000Z', null)] });
    const prayerSettings: AlarmSettings = { ...SETTINGS, ...DEFAULT_PRAYER_SETTINGS, timezone: 'Africa/Tunis', prayers_enabled: true, prayers_enabled_since: '2026-02-01T00:00:00.000Z' };
    const prayers: EventRow[] = PRAYER_NAMES.map((prayer, index) =>
      event({ id: `0000000${index}-0000-4000-8000-000000000001`, title: prayer, kind: 'prayer', prayer, passable: true })
    );
    const meds = event({ id: MEDS, title: 'Meds', passable: false });
    const withPrayers = expand([event({ id: GYM }), meds, ...prayers], open, { settings: prayerSettings });
    const without = expand([event({ id: GYM }), meds, ...prayers], undefined, { settings: prayerSettings });
    const kept = withPrayers.occurrences.filter((o) => o.eventId !== GYM);
    expect(kept).toEqual(without.occurrences.filter((o) => o.eventId !== GYM));
    expect(kept.some((o) => o.eventId === MEDS)).toBe(true);
    expect(kept.some((o) => prayers.some((p) => p.id === o.eventId))).toBe(true);
    expect(withPrayers.occurrences.some((o) => o.eventId === GYM)).toBe(false);
  });

  it('an explicit keep rule lets one alarm through a skipping mode', () => {
    const open = config({ activations: [manual(SICK, '2026-03-02T08:00:00.000Z', null)], rules: [rule(SICK, GYM, { behavior: 'keep' })] });
    expect(expand([event({ id: GYM })], open).occurrences.length).toBeGreaterThan(55);
  });

  it('lists a shifted occurrence at its new time, under the id of that time', () => {
    const ramadan = config({
      activations: [manual(RAMADAN, '2026-03-01T00:00:00.000Z', null)],
      rules: [rule(RAMADAN, GYM, { behavior: 'shift', shift_minutes: 90 })],
    });
    const { occurrences } = expand([event({ id: GYM })], ramadan);
    expect(occurrences[0]).toMatchObject({
      id: makeOccurrenceId(GYM, new Date('2026-03-02T11:30:00.000Z')),
      at: '2026-03-02T11:30:00.000Z',
      completed: false,
      silenced: false,
    });
    // Same count as unshifted: nothing is lost or doubled.
    expect(occurrences).toHaveLength(expand([event({ id: GYM })], undefined).occurrences.length);
  });

  it('finds an occurrence whose original time is just outside the window but whose shifted time is inside it', () => {
    // 10:00 today is already past at NOW (09:00)? No: it is ahead. Use an alarm at 22:00 yesterday shifted +12 h to 10:00
    // today, which is ahead of now, while its original instant is before the grace window.
    const late = event({ id: GYM, start_at: '2026-03-01T22:00:00.000Z' });
    const ramadan = config({
      activations: [manual(RAMADAN, '2026-02-01T00:00:00.000Z', null)],
      rules: [rule(RAMADAN, GYM, { behavior: 'shift', shift_minutes: 720 })],
    });
    expect(expand([late], ramadan).occurrences[0]!.at).toBe('2026-03-02T10:00:00.000Z');
    // And a negative shift pulls tomorrow's alarm in.
    const early = event({ id: GYM, start_at: '2026-03-03T01:00:00.000Z', repeat_unit: 'none' });
    const back = config({ activations: [manual(RAMADAN, '2026-02-01T00:00:00.000Z', null)], rules: [rule(RAMADAN, GYM, { behavior: 'shift', shift_minutes: -720 })] });
    expect(expand([early], back).occurrences.map((o) => o.at)).toEqual(['2026-03-02T13:00:00.000Z']);
  });

  it('marks a shifted occurrence completed by a completion at either its new or its original time', () => {
    const ramadan = config({
      activations: [manual(RAMADAN, '2026-03-01T00:00:00.000Z', null)],
      rules: [rule(RAMADAN, GYM, { behavior: 'shift', shift_minutes: 90 })],
    });
    const doneAtNew = expand([event({ id: GYM })], ramadan, { completions: [{ event_id: GYM, occurrence_at: '2026-03-02T11:30:00+00:00' }] });
    expect(doneAtNew.occurrences[0]!.completed).toBe(true);
    const doneAtOriginal = expand([event({ id: GYM })], ramadan, { completions: [{ event_id: GYM, occurrence_at: '2026-03-02T10:00:00.000Z' }] });
    expect(doneAtOriginal.occurrences[0]!.completed).toBe(true);
    expect(doneAtOriginal.occurrences[1]!.completed).toBe(false);
  });

  it('silences a shifted occurrence by the day it rings on', () => {
    const ramadan = config({
      activations: [manual(RAMADAN, '2026-03-01T00:00:00.000Z', null)],
      rules: [rule(RAMADAN, GYM, { behavior: 'shift', shift_minutes: 600 })],
    });
    const evening = event({ id: GYM, start_at: '2026-03-01T15:00:00.000Z' });
    const { occurrences } = expand([evening], ramadan, { cheatDays: ['2026-03-03'] });
    // The 2 March 15:00 occurrence rings at 01:00 on the 3rd, which is the cheat day; the next one rings on the 4th.
    expect(occurrences.find((o) => o.at === '2026-03-03T01:00:00.000Z')?.silenced).toBe(true);
    expect(occurrences.find((o) => o.at === '2026-03-04T01:00:00.000Z')?.silenced).toBe(false);
  });

  it('a shorten rule changes nothing in the list (the calendar block only)', () => {
    const ramadan = config({ activations: [manual(RAMADAN, '2026-03-01T00:00:00.000Z', null)], rules: [rule(RAMADAN, GYM, { behavior: 'shorten', duration_min: 5 })] });
    expect(expand([event({ id: GYM })], ramadan).occurrences).toEqual(expand([event({ id: GYM })], undefined).occurrences);
  });

  it('applies the exam mode window derived from the exams, and moves it when the exam moves', () => {
    const examMode = mode('00000000-0000-4000-8000-0000000000e1', 'exam', 'skip');
    const base = { modes: [examMode], exams: [{ id: 'x1', exam_at: '2026-03-12T09:00:00.000Z', active: true }] };
    const first = expand([event({ id: GYM })], config(base), { settings: { ...SETTINGS, exam_mode_days_before: 3 } });
    // Window: 9 March 00:00 to 14 March 00:00. Paused: the 9th to the 13th.
    expect(days(first.occurrences)).not.toContain('2026-03-09');
    expect(days(first.occurrences)).not.toContain('2026-03-13');
    expect(days(first.occurrences)).toContain('2026-03-08');
    expect(days(first.occurrences)).toContain('2026-03-14');
    const moved = expand([event({ id: GYM })], config({ ...base, exams: [{ id: 'x1', exam_at: '2026-03-20T09:00:00.000Z', active: true }] }), {
      settings: { ...SETTINGS, exam_mode_days_before: 3 },
    });
    expect(days(moved.occurrences)).toContain('2026-03-10');
    expect(days(moved.occurrences)).not.toContain('2026-03-18');
  });

  it('does not count paused occurrences against the per-event cap, so the horizon is not cut by them', () => {
    const hourly = event({ id: GYM, repeat_unit: 'hour', start_at: '2026-03-02T09:30:00.000Z' });
    const sick = config({ activations: [manual(SICK, '2026-03-02T00:00:00.000Z', '2026-03-10T00:00:00.000Z')] });
    const out = expand([hourly], sick);
    expect(out.truncated).toBe(false);
    expect(out.occurrences[0]!.at >= '2026-03-10T00:00:00.000Z').toBe(true);
  });
});

describe('buildSchedulePayload with modes', () => {
  it('carries the modes it used in refillSource, trimmed to what the rules read, so main can refill identically', () => {
    const c = config({
      activations: [manual(SICK, '2026-03-04T00:00:00.000Z', null)],
      exams: [{ id: 'x1', exam_at: '2026-03-12T09:00:00.000Z', active: true, extra: 'dropped' } as never],
    });
    const payload = buildSchedulePayload({ events: [event({ id: GYM })], cheatDays: [], settings: SETTINGS, completions: [], now: NOW, modes: c });
    expect(payload.refillSource.modes?.activations).toHaveLength(1);
    expect(payload.refillSource.modes?.exams).toEqual([{ id: 'x1', exam_at: '2026-03-12T09:00:00.000Z', active: true }]);
    // The same inputs through the refill path give the same list.
    const refilled = expandSchedule({
      events: payload.refillSource.events,
      cheatDays: payload.refillSource.cheatDays,
      settings: payload.settings,
      completions: [],
      now: NOW,
      ...(payload.refillSource.modes === undefined ? {} : { modes: payload.refillSource.modes }),
    });
    expect(refilled.occurrences).toEqual(payload.occurrences);
  });

  it('has no modes key when none were given, so older consumers see the same shape', () => {
    const payload = buildSchedulePayload({ events: [event({ id: GYM })], cheatDays: [], settings: SETTINGS, completions: [], now: NOW });
    expect('modes' in payload.refillSource).toBe(false);
  });
});


describe('a shift never makes an alarm vanish', () => {
  const meds = (overrides: Partial<EventRow> = {}) => event({ id: MEDS, title: 'Meds', passable: false, start_at: '2026-03-01T10:00:00.000Z', ...overrides });
  const shiftBy = (eventId: string, minutes: number) => [rule(RAMADAN, eventId, { behavior: 'shift', shift_minutes: minutes })];
  const firstAt = (events: EventRow[], c: ModeConfig, now: Date) => expand(events, c, { now }).occurrences.filter((o) => o.eventId === events[0]!.id)[0]?.at;

  it('a manual switch made just before a non-passable alarm with a -60 or -120 shift still rings it, at its own time', () => {
    const now = new Date('2026-03-02T09:45:00.000Z');
    for (const minutes of [-60, -120]) {
      // Switched on at 09:40; the 10:00 alarm would move to 09:00 or 08:00, before the mode began and before the grace window.
      const c = config({ activations: [manual(RAMADAN, '2026-03-02T09:40:00.000Z', null)], rules: shiftBy(MEDS, minutes) });
      expect(firstAt([meds()], c, now), `shift ${minutes}`).toBe('2026-03-02T10:00:00.000Z');
    }
  });

  it('is not moved to a time before the mode began, even when that time is still inside the grace window', () => {
    const now = new Date('2026-03-02T09:45:00.000Z');
    // Mode on since 09:40; the 10:00 alarm shifted by -25 would ring at 09:35, before the switch, as a late alarm.
    const c = config({ activations: [manual(RAMADAN, '2026-03-02T09:40:00.000Z', null)], rules: shiftBy(MEDS, -25) });
    expect(firstAt([meds()], c, now)).toBe('2026-03-02T10:00:00.000Z');
  });

  it('"since this morning" with a 00:30 alarm and a -60 shift keeps the alarm at 00:30 instead of moving it to the day before', () => {
    const now = new Date('2026-03-02T00:10:00.000Z');
    const c = config({ activations: [manual(RAMADAN, '2026-03-02T00:00:00.000Z', null)], rules: shiftBy(MEDS, -60) });
    const { occurrences } = expand([meds({ start_at: '2026-03-01T00:30:00.000Z' })], c, { now });
    expect(occurrences[0]).toMatchObject({ at: '2026-03-02T00:30:00.000Z', completed: false });
    expect(occurrences[0]!.originalAt).toBeUndefined();
    // The next day is inside the mode and is shifted as asked.
    expect(occurrences[1]!.at).toBe('2026-03-02T23:30:00.000Z');
  });

  it('a shift that would put a still-coming alarm before the grace window rings it at its own time, for any alarm', () => {
    // Now 09:00, grace 30: the window starts at 08:30. The 09:20 alarm shifted by -120 would be 07:20.
    const c = config({ activations: [manual(RAMADAN, '2026-03-01T00:00:00.000Z', null)], rules: shiftBy(GYM, -120) });
    for (const passable of [true, false]) {
      const alarm = event({ id: GYM, passable, start_at: '2026-03-01T09:20:00.000Z' });
      expect(firstAt([alarm], c, NOW), `passable ${passable}`).toBe('2026-03-02T09:20:00.000Z');
    }
  });

  it('a shifted alarm that stays inside the window is moved and says where it came from', () => {
    const c = config({ activations: [manual(RAMADAN, '2026-03-01T00:00:00.000Z', null)], rules: shiftBy(GYM, 90) });
    const [first] = expand([event({ id: GYM })], c).occurrences;
    expect(first).toMatchObject({ at: '2026-03-02T11:30:00.000Z', originalAt: '2026-03-02T10:00:00.000Z' });
  });
});

describe('a Done at a shifted time still counts once the mode is over', () => {
  const alarm = () => event({ id: GYM, start_at: '2026-03-01T09:00:00.000Z' });
  const shifted = (endsAt: string) =>
    config({ activations: [manual(RAMADAN, '2026-03-01T00:00:00.000Z', endsAt)], rules: [rule(RAMADAN, GYM, { behavior: 'shift', shift_minutes: -30 })] });

  it('Done at the shifted 08:30, mode ended at 08:35: the 09:00 occurrence is back and is not rung a second time', () => {
    const now = new Date('2026-03-02T08:40:00.000Z');
    const { occurrences } = expand([alarm()], shifted('2026-03-02T08:35:00.000Z'), {
      now,
      completions: [{ event_id: GYM, occurrence_at: '2026-03-02T08:30:00.000Z' }],
    });
    expect(occurrences[0]).toMatchObject({ at: '2026-03-02T09:00:00.000Z', completed: true });
    // Tomorrow is a different day: not covered by that Done.
    expect(occurrences[1]).toMatchObject({ at: '2026-03-03T09:00:00.000Z', completed: false });
  });

  it('with no shift rule left, a Done at the shifted time is not a match for the original (only rules that exist are known)', () => {
    const now = new Date('2026-03-02T08:40:00.000Z');
    const noRule = config({ activations: [manual(RAMADAN, '2026-03-01T00:00:00.000Z', '2026-03-02T08:35:00.000Z')] });
    const { occurrences } = expand([alarm()], noRule, { now, completions: [{ event_id: GYM, occurrence_at: '2026-03-02T08:30:00.000Z' }] });
    expect(occurrences[0]!.completed).toBe(false);
  });

  it('does not let a neighbouring occurrence of a fast alarm count: a shift as long as the repeat period is ignored', () => {
    const hourly = event({ id: GYM, repeat_unit: 'hour', start_at: '2026-03-02T00:30:00.000Z' });
    const c = config({ activations: [manual(RAMADAN, '2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z')], rules: [rule(RAMADAN, GYM, { behavior: 'shift', shift_minutes: 60 })] });
    const { occurrences } = expand([hourly], c, { completions: [{ event_id: GYM, occurrence_at: '2026-03-02T10:30:00.000Z' }] });
    expect(occurrences.find((o) => o.at === '2026-03-02T10:30:00.000Z')!.completed).toBe(true);
    // 09:30 would be "done" through the +60 offset if the period guard did not ignore it.
    expect(occurrences.find((o) => o.at === '2026-03-02T09:30:00.000Z')?.completed ?? false).toBe(false);
  });
});
