import { describe, expect, it } from 'vitest';

import type { Occurrence } from '@/features/calendar/calendar-events';

import { findNextOccurrence, formatCountdown } from './next-alarm';

function occurrence(key: string, start: string, overrides: Partial<Occurrence> = {}): Occurrence {
  const startDate = new Date(start);
  return {
    key,
    eventId: key,
    title: key,
    start: startDate,
    end: new Date(startDate.getTime() + 30 * 60_000),
    day: start.slice(0, 10),
    color: null,
    passable: true,
    silenced: false,
    kind: 'normal',
    prayer: null,
    examRole: null,
    paused: false,
    shifted: false,
    modeName: null,
    category: null,
    hidden: false,
    ...overrides,
  };
}

const NOW = new Date('2026-11-20T10:00:00Z');

describe('findNextOccurrence', () => {
  it('picks the earliest ring after now, whatever the order of the list', () => {
    const list = [
      occurrence('late', '2026-11-20T15:00:00Z'),
      occurrence('soon', '2026-11-20T11:00:00Z'),
      occurrence('past', '2026-11-20T09:00:00Z'),
    ];
    expect(findNextOccurrence(list, NOW)?.key).toBe('soon');
  });

  it('skips a ring a cheat day silenced and one a mode paused, because neither will ring', () => {
    const list = [
      occurrence('silenced', '2026-11-20T10:30:00Z', { silenced: true }),
      occurrence('paused', '2026-11-20T10:40:00Z', { paused: true }),
      occurrence('real', '2026-11-20T12:00:00Z'),
    ];
    expect(findNextOccurrence(list, NOW)?.key).toBe('real');
  });

  it('counts an alarm hidden from the calendar, since it still rings', () => {
    expect(findNextOccurrence([occurrence('hidden', '2026-11-20T10:30:00Z', { hidden: true })], NOW)?.key).toBe(
      'hidden'
    );
  });

  it('does not count a ring starting exactly now, and returns null when nothing is ahead', () => {
    expect(findNextOccurrence([occurrence('now', '2026-11-20T10:00:00Z')], NOW)).toBeNull();
    expect(findNextOccurrence([], NOW)).toBeNull();
  });
});

describe('formatCountdown', () => {
  const minute = 60_000;

  it('reads minutes under an hour, rounded up', () => {
    expect(formatCountdown(45 * minute)).toBe('in 45m');
    expect(formatCountdown(30_000)).toBe('in 1m');
  });

  it('reads hours with the remaining minutes', () => {
    expect(formatCountdown(130 * minute)).toBe('in 2h 10m');
    expect(formatCountdown(120 * minute)).toBe('in 2h');
  });

  it('reads whole days past a day', () => {
    expect(formatCountdown(24 * 60 * minute)).toBe('in 1 day');
    expect(formatCountdown(3 * 24 * 60 * minute + 5 * minute)).toBe('in 3 days');
  });

  it('says now for zero or negative', () => {
    expect(formatCountdown(0)).toBe('now');
    expect(formatCountdown(-5_000)).toBe('now');
  });
});
