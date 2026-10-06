import type { EventRow } from '@alarm-calendar/core';
import { describe, expect, it } from 'vitest';

import { dayImpact, expandOccurrences, groupByDay, toCalendarEvent } from './calendar-events';

function eventRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: 'e1',
    user_id: 'u1',
    title: 'Take medication',
    notes: null,
    start_at: '2026-10-05T08:00:00.000Z',
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
    updated_at: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

const UTC = { timezone: 'UTC' };
const AUCKLAND = { timezone: 'Pacific/Auckland' };

const range = { from: new Date('2026-10-05T00:00:00Z'), to: new Date('2026-10-08T00:00:00Z') };

describe('expandOccurrences', () => {
  it('expands a daily event into one occurrence per day of the range, in order', () => {
    const result = expandOccurrences([eventRow()], range, UTC, []);
    expect(result.map((o) => o.start.toISOString())).toEqual([
      '2026-10-05T08:00:00.000Z',
      '2026-10-06T08:00:00.000Z',
      '2026-10-07T08:00:00.000Z',
    ]);
    expect(result.map((o) => o.day)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07']);
  });

  it('gives each occurrence the event duration as its end', () => {
    const [first] = expandOccurrences([eventRow({ duration_min: 45 })], range, UTC, []);
    expect(first?.end.toISOString()).toBe('2026-10-05T08:45:00.000Z');
  });

  it('greys out a passable occurrence on a cheat day and leaves the other days alone', () => {
    const result = expandOccurrences([eventRow()], range, UTC, ['2026-10-06']);
    expect(result.map((o) => o.silenced)).toEqual([false, true, false]);
  });

  it('never silences an event that is not passable', () => {
    const result = expandOccurrences([eventRow({ passable: false })], range, UTC, ['2026-10-06']);
    expect(result.every((o) => !o.silenced)).toBe(true);
  });

  it('assigns the cheat day by the local date in the settings zone, not the UTC date', () => {
    // 20:00 UTC on Oct 5 is 09:00 on Oct 6 in Auckland (UTC+13 in October).
    const event = eventRow({ start_at: '2026-10-05T20:00:00.000Z', repeat_unit: 'none' });
    const [occurrence] = expandOccurrences([event], range, AUCKLAND, ['2026-10-06']);
    expect(occurrence?.day).toBe('2026-10-06');
    expect(occurrence?.silenced).toBe(true);
    const [utcView] = expandOccurrences([event], range, UTC, ['2026-10-06']);
    expect(utcView?.silenced).toBe(false);
  });

  it('skips inactive events', () => {
    expect(expandOccurrences([eventRow({ active: false })], range, UTC, [])).toEqual([]);
  });

  it('merges several events into one chronological list', () => {
    const late = eventRow({ id: 'e2', title: 'Evening', start_at: '2026-10-05T18:00:00.000Z', repeat_unit: 'none' });
    const early = eventRow({ id: 'e3', title: 'Morning', start_at: '2026-10-05T06:00:00.000Z', repeat_unit: 'none' });
    const result = expandOccurrences([late, early], range, UTC, []);
    expect(result.map((o) => o.title)).toEqual(['Morning', 'Evening']);
  });

  it('honours the end of a series', () => {
    const result = expandOccurrences([eventRow({ ends_at: '2026-10-06T23:59:00.000Z' })], range, UTC, []);
    expect(result).toHaveLength(2);
  });

  it('keeps an occurrence that began before the range but is still running', () => {
    const event = eventRow({ start_at: '2026-10-04T23:30:00.000Z', duration_min: 120, repeat_unit: 'none' });
    expect(expandOccurrences([event], range, UTC, [])).toHaveLength(1);
  });
});

describe('toCalendarEvent', () => {
  const [occurrence] = expandOccurrences([eventRow({ color: '#3b82f6' })], range, UTC, ['2026-10-05']);

  it('hands the calendar a plain event with UTC ISO times and the event color', () => {
    const calendarEvent = toCalendarEvent(occurrence!);
    expect(calendarEvent).toMatchObject({
      id: 'e1@2026-10-05T08:00:00.000Z',
      title: 'Take medication',
      start: '2026-10-05T08:00:00.000Z',
      end: '2026-10-05T08:15:00.000Z',
      color: '#3b82f6',
      contrastColor: '#ffffff',
    });
  });

  it('carries the exam role of an exam alarm and a revision session, so the grid can tag them', () => {
    const range1 = { from: new Date('2026-10-05T00:00:00Z'), to: new Date('2026-10-06T00:00:00Z') };
    const [session, alarm, plain] = expandOccurrences(
      [
        eventRow({ id: 's', repeat_unit: 'none', exam_id: 'x', exam_role: 'session' }),
        eventRow({ id: 'a', repeat_unit: 'none', exam_id: 'x', exam_role: 'exam', start_at: '2026-10-05T09:00:00.000Z' }),
        eventRow({ id: 'p', repeat_unit: 'none', start_at: '2026-10-05T10:00:00.000Z' }),
      ],
      range1,
      UTC,
      []
    );
    expect([session?.examRole, alarm?.examRole, plain?.examRole]).toEqual(['session', 'exam', null]);
    expect(toCalendarEvent(session!).extendedProps.examRole).toBe('session');
  });

  it('marks silenced occurrences so the grid can grey them', () => {
    expect(toCalendarEvent(occurrence!).className).toBe('occurrence-silenced');
    expect(toCalendarEvent(occurrence!).extendedProps).toEqual({
      eventId: 'e1',
      silenced: true,
      passable: true,
      prayer: false,
      examRole: null,
    });
  });

  it('adds no class and no color for a normal, uncolored occurrence', () => {
    const [plain] = expandOccurrences([eventRow()], range, UTC, []);
    const calendarEvent = toCalendarEvent(plain!);
    expect(calendarEvent.className).toBe('');
    expect(calendarEvent).not.toHaveProperty('color');
  });
});

describe('groupByDay', () => {
  it('groups consecutive occurrences by local day', () => {
    const twice = eventRow({ repeat_unit: 'hour', repeat_interval: 12 });
    const groups = groupByDay(expandOccurrences([twice], range, UTC, []));
    expect(groups.map((g) => [g.day, g.occurrences.length])).toEqual([
      ['2026-10-05', 2],
      ['2026-10-06', 2],
      ['2026-10-07', 2],
    ]);
  });
});

const LONG_BEFORE = new Date('2026-10-01T00:00:00Z');

describe('dayImpact', () => {
  it('counts what a cheat day silences and what rings anyway', () => {
    const events = [
      eventRow({ id: 'a' }),
      eventRow({ id: 'b', repeat_unit: 'hour', repeat_interval: 12 }),
      eventRow({ id: 'c', passable: false }),
      eventRow({ id: 'd', active: false }),
    ];
    // a: 1, b: 2 (08:00 and 20:00), c: 1 not passable.
    expect(dayImpact(events, '2026-10-06', UTC, LONG_BEFORE)).toEqual({ silenced: 3, stillRing: 1 });
  });

  it('is zero on a day nothing is scheduled', () => {
    expect(dayImpact([eventRow({ repeat_unit: 'none' })], '2026-10-06', UTC, LONG_BEFORE)).toEqual({ silenced: 0, stillRing: 0 });
  });

  it('counts by the local day in the settings zone', () => {
    const event = eventRow({ start_at: '2026-10-05T20:00:00.000Z', repeat_unit: 'none' });
    expect(dayImpact([event], '2026-10-06', AUCKLAND, LONG_BEFORE).silenced).toBe(1);
    expect(dayImpact([event], '2026-10-05', AUCKLAND, LONG_BEFORE).silenced).toBe(0);
  });

  it('counts only the alarms still to come when the day is today', () => {
    const events = [
      eventRow({ id: 'a' }),
      eventRow({ id: 'b', repeat_unit: 'hour', repeat_interval: 12 }),
      eventRow({ id: 'c', passable: false }),
    ];
    // 12:00 UTC on the 6th: a (08:00), c (08:00) and b's 08:00 occurrence already rang; b's 20:00 is left.
    const noon = new Date('2026-10-06T12:00:00Z');
    expect(dayImpact(events, '2026-10-06', UTC, noon)).toEqual({ silenced: 1, stillRing: 0 });
    // The same events asked about tomorrow count in full.
    expect(dayImpact(events, '2026-10-07', UTC, noon)).toEqual({ silenced: 3, stillRing: 1 });
  });
});
