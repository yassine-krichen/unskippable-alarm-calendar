import { describe, expect, it } from 'vitest';
import { nextOccurrence, occurrencesBetween, type EventRow } from '@alarm-calendar/core';

import {
  changedColumns,
  describeEventRow,
  diffFriendly,
  parseDays,
  parseDuration,
  resolveEventSpec,
  type EventSpec,
} from '../src/events/event-spec';

const NOW = new Date('2026-11-08T10:00:00.000Z'); // a Sunday

function spec(overrides: Partial<EventSpec> = {}): EventSpec {
  return { title: 'Push day', time: '07:30', ...overrides };
}

function asRow(input: ReturnType<typeof resolveEventSpec>['input']): EventRow {
  return { ...input, id: 'e1', user_id: 'u', active: true, updated_at: NOW.toISOString(), kind: 'normal' } as EventRow;
}

describe('resolveEventSpec: times and zones', () => {
  it('reads the time in the user zone (Tunis is UTC+1 all year)', () => {
    const { input } = resolveEventSpec(spec({ start: '2026-11-09' }), { tz: 'Africa/Tunis', now: NOW });
    expect(input.start_at).toBe('2026-11-09T06:30:00.000Z');
  });

  it('follows DST: 07:30 in Paris is 06:30Z in winter and 05:30Z in summer', () => {
    const winter = resolveEventSpec(spec({ start: '2026-11-09' }), { tz: 'Europe/Paris', now: NOW });
    const summer = resolveEventSpec(spec({ start: '2027-07-05' }), { tz: 'Europe/Paris', now: NOW });
    expect(winter.input.start_at).toBe('2026-11-09T06:30:00.000Z');
    expect(summer.input.start_at).toBe('2027-07-05T05:30:00.000Z');
  });

  it('keeps wall time across a DST change for a daily series', () => {
    const { input } = resolveEventSpec(spec({ start: '2027-03-27', repeat: 'daily' }), { tz: 'Europe/Paris', now: NOW });
    const rings = occurrencesBetween(asRow(input), new Date('2027-03-27T00:00:00Z'), new Date('2027-03-31T00:00:00Z'), 'Europe/Paris');
    expect(rings.map((at) => at.toISOString())).toEqual([
      '2027-03-27T06:30:00.000Z',
      '2027-03-28T05:30:00.000Z', // the clocks went forward in the night
      '2027-03-29T05:30:00.000Z',
      '2027-03-30T05:30:00.000Z',
    ]);
  });

  it('moves a time inside the spring-forward gap forward, like the app', () => {
    const { input } = resolveEventSpec(spec({ time: '02:30', start: '2027-03-28' }), { tz: 'Europe/Paris', now: NOW });
    expect(input.start_at).toBe('2027-03-28T01:30:00.000Z'); // 03:30 CEST
  });
});

describe('resolveEventSpec: weekdays and presets', () => {
  it('aligns the start to the first selected weekday and stores sorted weekdays', () => {
    // 2026-11-11 is a Wednesday; Monday and Friday are selected, so the series starts on Friday the 13th.
    const { input } = resolveEventSpec(spec({ start: '2026-11-11', days: ['fri', 'mon'] }), { tz: 'Africa/Tunis', now: NOW });
    expect(input.repeat_unit).toBe('week');
    expect(input.repeat_weekdays).toEqual([0, 4]);
    expect(input.start_at).toBe('2026-11-13T06:30:00.000Z');
  });

  it('defaults a repeating start to today and a one-time alarm to its next occurrence', () => {
    const repeating = resolveEventSpec(spec({ repeat: 'daily' }), { tz: 'Africa/Tunis', now: NOW });
    expect(repeating.input.start_at).toBe('2026-11-08T06:30:00.000Z');
    const oneTime = resolveEventSpec(spec(), { tz: 'Africa/Tunis', now: NOW });
    expect(oneTime.input.start_at).toBe('2026-11-09T06:30:00.000Z'); // 07:30 today (Tunis) is past
  });

  it('maps named presets and custom intervals to the columns the app writes', () => {
    const tz = 'Africa/Tunis';
    expect(resolveEventSpec(spec({ repeat: 'every-2-days' }), { tz, now: NOW }).input).toMatchObject({ repeat_unit: 'day', repeat_interval: 2 });
    expect(resolveEventSpec(spec({ repeat: 'every-12-hours' }), { tz, now: NOW }).input).toMatchObject({ repeat_unit: 'hour', repeat_interval: 12 });
    expect(resolveEventSpec(spec({ repeat: 'yearly', start: '2027-01-05' }), { tz, now: NOW }).input).toMatchObject({ repeat_unit: 'year', repeat_interval: 1 });
    expect(resolveEventSpec(spec({ repeat: { every: 3, unit: 'month' } }), { tz, now: NOW }).input).toMatchObject({ repeat_unit: 'month', repeat_interval: 3 });
    const fortnight = resolveEventSpec(spec({ repeat: { every: 2, unit: 'week' }, days: ['tue'] }), { tz, now: NOW }).input;
    expect(fortnight).toMatchObject({ repeat_unit: 'week', repeat_interval: 2, repeat_weekdays: [1] });
  });

  it('uses the app defaults for what the spec leaves out', () => {
    const { input } = resolveEventSpec(spec({ start: '2026-11-09' }), { tz: 'Africa/Tunis', now: NOW });
    expect(input).toMatchObject({ duration_min: 15, max_snoozes: 3, snooze_minutes: 5, passable: true, color: null, show_in_calendar: true, notes: null, ends_at: null });
  });

  it('makes the end date inclusive (23:59 local)', () => {
    const { input } = resolveEventSpec(spec({ repeat: 'daily', start: '2026-11-09', ends: '2026-11-20' }), { tz: 'Africa/Tunis', now: NOW });
    expect(input.ends_at).toBe('2026-11-20T22:59:00.000Z');
  });

  it('turns color names into palette values and rejects others', () => {
    expect(resolveEventSpec(spec({ start: '2026-11-09', color: 'blue' }), { tz: 'Africa/Tunis', now: NOW }).input.color).toBe('#3b82f6');
    expect(() => resolveEventSpec(spec({ start: '2026-11-09', color: 'teal' }), { tz: 'Africa/Tunis', now: NOW })).toThrow(/palette/);
  });
});

describe('resolveEventSpec: validation', () => {
  const ctx = { tz: 'Africa/Tunis', now: NOW };

  it('refuses days together with a non-weekly repeat', () => {
    expect(() => resolveEventSpec(spec({ repeat: 'daily', days: ['mon'] }), ctx)).toThrow(/weekly/);
  });

  it('refuses an end before the first ring and a one-time alarm in the past', () => {
    expect(() => resolveEventSpec(spec({ repeat: 'daily', start: '2026-11-09', ends: '2026-11-01' }), ctx)).toThrow(/before the first alarm/);
    expect(() => resolveEventSpec(spec({ start: '2026-11-01' }), ctx)).toThrow(/already in the past/);
  });

  it('allows a past start for a repeating alarm and for an alarm that already exists', () => {
    expect(() => resolveEventSpec(spec({ repeat: 'daily', start: '2026-10-01' }), ctx)).not.toThrow();
    const existing = asRow(resolveEventSpec(spec({ repeat: 'daily', start: '2026-10-01' }), ctx).input);
    expect(() => resolveEventSpec(spec({ start: '2026-10-01' }), { ...ctx, existing })).not.toThrow();
  });

  it('warns that ends is ignored on a one-time alarm', () => {
    const resolved = resolveEventSpec(spec({ start: '2026-11-09', ends: '2026-12-01' }), ctx);
    expect(resolved.warnings[0]).toMatch(/ignored/);
    expect(resolved.input.ends_at).toBeNull();
  });
});

describe('re-resolving an existing alarm is stable', () => {
  const tz = 'Europe/Paris';

  it('keeps the start date of the stored alarm, so a later run produces no change', () => {
    const first = resolveEventSpec(spec({ repeat: 'daily' }), { tz, now: NOW });
    const existing = asRow(first.input);
    const later = new Date('2026-12-20T09:00:00Z');
    const again = resolveEventSpec(spec({ repeat: 'daily' }), { tz, now: later, existing });
    expect(changedColumns(existing, again.input, tz)).toEqual({});
    expect(diffFriendly(describeEventRow(existing, tz), describeEventRow(again.input, tz))).toEqual([]);
  });

  it('reports only the columns that differ', () => {
    const existing = asRow(resolveEventSpec(spec({ repeat: 'daily', start: '2026-11-09' }), { tz, now: NOW }).input);
    const next = resolveEventSpec(spec({ repeat: 'daily', time: '08:00', duration: '45m' }), { tz, now: NOW, existing });
    expect(Object.keys(changedColumns(existing, next.input, tz)).sort()).toEqual(['duration_min', 'start_at']);
    expect(diffFriendly(describeEventRow(existing, tz), describeEventRow(next.input, tz)).map((change) => change.field)).toEqual(['time', 'duration']);
  });

  it('treats weekday sets as equal regardless of order, and a null stored list as the start weekday', () => {
    const base = resolveEventSpec(spec({ start: '2026-11-09', days: ['mon', 'wed'] }), { tz, now: NOW });
    const existing = asRow(base.input);
    const reordered = resolveEventSpec(spec({ start: '2026-11-09', days: ['wed', 'mon'] }), { tz, now: NOW, existing });
    expect(changedColumns(existing, reordered.input, tz)).toEqual({});

    // The app stores null for "the weekday of start_at".
    const fromApp = { ...existing, repeat_weekdays: null } as EventRow;
    const mondayOnly = resolveEventSpec(spec({ start: '2026-11-09', days: ['mon'] }), { tz, now: NOW, existing: fromApp });
    expect(changedColumns(fromApp, mondayOnly.input, tz)).toEqual({});
    const mondayWednesday = resolveEventSpec(spec({ start: '2026-11-09', days: ['mon', 'wed'] }), { tz, now: NOW, existing: fromApp });
    expect(changedColumns(fromApp, mondayWednesday.input, tz)).toEqual({ repeat_weekdays: [0, 2] });
    expect(nextOccurrence(asRow(mondayWednesday.input), NOW, tz)?.toISOString()).toBe('2026-11-09T06:30:00.000Z');
  });
});

describe('small parsers', () => {
  it('parses durations', () => {
    expect(parseDuration(45)).toBe(45);
    expect(parseDuration('1h30m')).toBe(90);
    expect(parseDuration('2h')).toBe(120);
    expect(parseDuration('45m')).toBe(45);
    expect(parseDuration('90')).toBe(90);
    expect(() => parseDuration('2000m')).toThrow();
    expect(() => parseDuration('soon')).toThrow();
  });

  it('parses weekday lists and shorthands', () => {
    expect(parseDays(['fri', 'mon'])).toEqual([0, 4]);
    expect(parseDays('weekdays')).toEqual([0, 1, 2, 3, 4]);
    expect(parseDays('weekends')).toEqual([5, 6]);
    expect(parseDays('Monday,wed')).toEqual([0, 2]);
    expect(() => parseDays(['funday'])).toThrow(/not a weekday/);
  });
});
