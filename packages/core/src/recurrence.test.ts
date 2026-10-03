import { describe, expect, it } from 'vitest';

import vectorFile from '../test-vectors/recurrence.json';
import { nextOccurrence, occurrencesBetween } from './recurrence';
import type { RecurrenceEvent } from './recurrence';

interface Vector {
  name: string;
  tz: string;
  event: RecurrenceEvent;
  from: string;
  to: string;
  expected: string[];
  next?: { after: string; expected: string | null }[];
}

// Instants in the JSON have no milliseconds; toISOString always has them.
const iso = (date: Date): string => date.toISOString().replace('.000Z', 'Z');
const vectors = vectorFile.vectors as Vector[];

describe('shared recurrence vectors', () => {
  for (const vector of vectors) {
    it(`occurrencesBetween: ${vector.name}`, () => {
      const result = occurrencesBetween(
        vector.event,
        new Date(vector.from),
        new Date(vector.to),
        vector.tz
      );
      expect(result.map(iso)).toEqual(vector.expected);
    });

    for (const check of vector.next ?? []) {
      it(`nextOccurrence after ${check.after}: ${vector.name}`, () => {
        const result = nextOccurrence(vector.event, new Date(check.after), vector.tz);
        expect(result === null ? null : iso(result)).toBe(check.expected);
      });
    }
  }
});

describe('recurrence behavior beyond the vectors', () => {
  const daily: RecurrenceEvent = {
    start_at: '2026-06-10T12:00:00Z',
    repeat_unit: 'day',
    repeat_interval: 1,
    repeat_weekdays: null,
    ends_at: null,
    active: true,
  };

  it('ignores the time zone of the machine running it for wall-clock math', () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'Pacific/Auckland';
      const paris: RecurrenceEvent = { ...daily, start_at: '2026-03-27T07:00:00Z' };
      const result = occurrencesBetween(
        paris,
        new Date('2026-03-28T00:00:00Z'),
        new Date('2026-03-31T00:00:00Z'),
        'Europe/Paris'
      );
      expect(result.map(iso)).toEqual([
        '2026-03-28T07:00:00Z',
        '2026-03-29T06:00:00Z',
        '2026-03-30T06:00:00Z',
      ]);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('includes an occurrence that falls exactly on the range start', () => {
    const result = occurrencesBetween(
      daily,
      new Date('2026-06-12T12:00:00Z'),
      new Date('2026-06-13T12:00:00Z'),
      'UTC'
    );
    expect(result.map(iso)).toEqual(['2026-06-12T12:00:00Z']);
  });

  it('answers an hourly query decades after the start without walking the series', () => {
    const hourly: RecurrenceEvent = { ...daily, repeat_unit: 'hour', repeat_interval: 1 };
    const result = occurrencesBetween(
      hourly,
      new Date('2060-01-01T00:00:00Z'),
      new Date('2060-01-01T03:00:00Z'),
      'UTC'
    );
    expect(result.map(iso)).toEqual([
      '2060-01-01T00:00:00Z',
      '2060-01-01T01:00:00Z',
      '2060-01-01T02:00:00Z',
    ]);
  });

  it('keeps the start instant as the first occurrence when it falls in the repeated autumn hour', () => {
    // 02:30 CET, the second of the two 02:30s on 2026-10-25 in Paris.
    const secondPass: RecurrenceEvent = { ...daily, start_at: '2026-10-25T01:30:00Z' };
    const result = occurrencesBetween(
      secondPass,
      new Date('2026-10-25T00:00:00Z'),
      new Date('2026-10-27T00:00:00Z'),
      'Europe/Paris'
    );
    expect(result.map(iso)).toEqual(['2026-10-25T01:30:00Z', '2026-10-26T01:30:00Z']);
  });

  it('rejects a repeat interval below 1', () => {
    expect(() =>
      nextOccurrence({ ...daily, repeat_interval: 0 }, new Date('2026-06-10T00:00:00Z'), 'UTC')
    ).toThrow(RangeError);
  });

  it('rejects a weekday outside 0 to 6', () => {
    const weekly: RecurrenceEvent = { ...daily, repeat_unit: 'week', repeat_weekdays: [7] };
    expect(() => nextOccurrence(weekly, new Date('2026-06-10T00:00:00Z'), 'UTC')).toThrow(
      RangeError
    );
  });

  it('rejects an unknown time zone', () => {
    expect(() => nextOccurrence(daily, new Date('2026-06-10T00:00:00Z'), 'Mars/Olympus')).toThrow(
      RangeError
    );
  });
});
