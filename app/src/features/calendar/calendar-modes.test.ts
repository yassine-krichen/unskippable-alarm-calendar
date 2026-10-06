import { buildModeTimeline, type ModeConfig } from '@alarm-calendar/core';
import { describe, expect, it } from 'vitest';

import { BUILTIN_MODES, RAMADAN_ID, SICK_ID, activationRow, eventRow, ruleRow } from '@/features/modes/mode-fixtures';

import { PAUSED_CLASS, dayImpact, expandOccurrences, toCalendarEvent } from './calendar-events';

const UTC = { timezone: 'UTC' };
const range = { from: new Date('2026-10-05T00:00:00Z'), to: new Date('2026-10-08T00:00:00Z') };

function timeline(overrides: Partial<ModeConfig>) {
  return buildModeTimeline({ modes: BUILTIN_MODES, rules: [], activations: [], exams: [], ...overrides }, UTC);
}

// Sick from 6 October 00:00 until 7 October 00:00: only the 6th is under the mode.
const sickOnTheSixth = timeline({ activations: [activationRow(SICK_ID, '2026-10-06T00:00:00.000Z', '2026-10-07T00:00:00.000Z')] });

describe('expandOccurrences with modes', () => {
  it('keeps a paused occurrence in the list, flagged with its mode, and the others untouched', () => {
    const result = expandOccurrences([eventRow({ id: 'e1' })], range, UTC, [], undefined, sickOnTheSixth);
    expect(result.map((o) => [o.start.toISOString().slice(0, 10), o.paused, o.modeName])).toEqual([
      ['2026-10-05', false, null],
      ['2026-10-06', true, 'Sick'],
      ['2026-10-07', false, null],
    ]);
  });

  it('never pauses an alarm that always rings, and shows it as a normal occurrence', () => {
    const result = expandOccurrences([eventRow({ id: 'e2', passable: false })], range, UTC, [], undefined, sickOnTheSixth);
    expect(result.every((o) => !o.paused)).toBe(true);
  });

  it('a paused occurrence on a cheat day is not also "silenced": the mode is the reason it is grey', () => {
    const result = expandOccurrences([eventRow({ id: 'e1' })], range, UTC, ['2026-10-06', '2026-10-07'], undefined, sickOnTheSixth);
    expect(result.map((o) => [o.paused, o.silenced])).toEqual([
      [false, false],
      [true, false],
      [false, true],
    ]);
  });

  it('shows a shifted occurrence where it rings, under the id of that time', () => {
    const t = timeline({
      activations: [activationRow(RAMADAN_ID, '2026-10-01T00:00:00.000Z', null)],
      rules: [ruleRow(RAMADAN_ID, 'e1', { behavior: 'shift', shift_minutes: 150 })],
    });
    const [first] = expandOccurrences([eventRow({ id: 'e1' })], range, UTC, [], undefined, t);
    expect(first).toMatchObject({ key: 'e1@2026-10-05T10:30:00.000Z', shifted: true, modeName: 'Ramadan', paused: false });
    expect(first!.start.toISOString()).toBe('2026-10-05T10:30:00.000Z');
  });

  it('finds an occurrence shifted into the range from just outside it', () => {
    const t = timeline({
      activations: [activationRow(RAMADAN_ID, '2026-10-01T00:00:00.000Z', null)],
      rules: [ruleRow(RAMADAN_ID, 'e1', { behavior: 'shift', shift_minutes: 720 })],
    });
    // 4 October 20:00 shifted +12 h rings at 08:00 on the 5th, inside the range, while its original is before it.
    const late = eventRow({ id: 'e1', start_at: '2026-10-04T20:00:00.000Z' });
    const result = expandOccurrences([late], range, UTC, [], undefined, t);
    expect(result[0]!.start.toISOString()).toBe('2026-10-05T08:00:00.000Z');
    // And one shifted out of the range at the other end is not listed.
    expect(result.every((o) => o.start.getTime() < range.to.getTime())).toBe(true);
  });

  it('a shorten rule changes the calendar block only', () => {
    const t = timeline({
      activations: [activationRow(RAMADAN_ID, '2026-10-01T00:00:00.000Z', null)],
      rules: [ruleRow(RAMADAN_ID, 'e1', { behavior: 'shorten', duration_min: 10 })],
    });
    const [first] = expandOccurrences([eventRow({ id: 'e1' })], range, UTC, [], undefined, t);
    expect(first!.end.getTime() - first!.start.getTime()).toBe(10 * 60_000);
    expect(first!.paused).toBe(false);
  });

  it('is exactly what it was without modes when none is passed', () => {
    const events = [eventRow({ id: 'e1' })];
    expect(expandOccurrences(events, range, UTC, [])).toEqual(expandOccurrences(events, range, UTC, [], undefined, timeline({})));
  });
});

describe('toCalendarEvent for a paused occurrence', () => {
  it('carries the paused class and the mode name for the grid', () => {
    const [, paused] = expandOccurrences([eventRow({ id: 'e1' })], range, UTC, [], undefined, sickOnTheSixth);
    const calendarEvent = toCalendarEvent(paused!);
    expect(calendarEvent.className).toBe(PAUSED_CLASS);
    expect(calendarEvent.extendedProps).toMatchObject({ paused: true, modeName: 'Sick' });
  });
});

describe('dayImpact with modes', () => {
  it('does not count alarms a mode already pauses as something a pass would silence', () => {
    const events = [eventRow({ id: 'e1' }), eventRow({ id: 'e2', passable: false })];
    const now = new Date('2026-10-05T00:00:00Z');
    expect(dayImpact(events, '2026-10-06', UTC, now)).toEqual({ silenced: 1, stillRing: 1 });
    expect(dayImpact(events, '2026-10-06', UTC, now, sickOnTheSixth)).toEqual({ silenced: 0, stillRing: 1 });
  });
});
