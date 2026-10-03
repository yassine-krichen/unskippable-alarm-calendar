import { describe, expect, it } from 'vitest';

import { nextFullHour, slotFromClick } from './new-event-slot';

const NOW = new Date('2026-10-03T10:20:00Z');

describe('slotFromClick', () => {
  it('keeps the clicked time of a week-view slot, read in the settings zone', () => {
    // 07:30 UTC is 09:30 in Berlin (CEST).
    const slot = slotFromClick({ instant: new Date('2026-10-05T07:30:00Z'), allDay: false }, 'Europe/Berlin', NOW);
    expect(slot).toEqual({ date: '2026-10-05', time: '09:30' });
  });

  it('uses 09:00 for a month-view cell on another day', () => {
    const slot = slotFromClick({ instant: new Date('2026-10-07T00:00:00Z'), allDay: true }, 'UTC', NOW);
    expect(slot).toEqual({ date: '2026-10-07', time: '09:00' });
  });

  it('uses the next full hour for a month-view cell that is today', () => {
    const slot = slotFromClick({ instant: new Date('2026-10-03T00:00:00Z'), allDay: true }, 'UTC', NOW);
    expect(slot).toEqual({ date: '2026-10-03', time: '11:00' });
  });
});

describe('nextFullHour', () => {
  it('rounds up and never passes midnight', () => {
    expect(nextFullHour('08:15')).toBe('09:00');
    expect(nextFullHour('22:59')).toBe('23:00');
    expect(nextFullHour('23:10')).toBe('23:59');
  });
});
