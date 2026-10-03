import { describe, expect, it } from 'vitest';

import { parseCalendarView, shiftAnchor, startOfWeek, viewTitle, visibleDayRange } from './calendar-range';

describe('visibleDayRange', () => {
  it('covers the Monday-first week containing the anchor', () => {
    // 2026-10-08 is a Thursday.
    expect(visibleDayRange('week', '2026-10-08', 0)).toEqual({ start: '2026-10-05', end: '2026-10-12' });
  });

  it('follows the week start from settings', () => {
    expect(visibleDayRange('week', '2026-10-08', 6)).toEqual({ start: '2026-10-04', end: '2026-10-11' });
  });

  it('keeps a Sunday-first week from reaching into the previous one', () => {
    expect(startOfWeek('2026-10-04', 6)).toBe('2026-10-04');
    expect(startOfWeek('2026-10-04', 0)).toBe('2026-09-28');
  });

  it('covers six weeks from the grid start for the month view', () => {
    // October 1st 2026 is a Thursday, so a Monday-first grid starts September 28th.
    expect(visibleDayRange('month', '2026-10-17', 0)).toEqual({ start: '2026-09-28', end: '2026-11-09' });
  });

  it('lists two weeks starting at the anchor for the agenda, so today comes first', () => {
    expect(visibleDayRange('agenda', '2026-10-03', 0)).toEqual({ start: '2026-10-03', end: '2026-10-17' });
  });
});

describe('shiftAnchor', () => {
  it('moves a week, an agenda window, or a month at a time', () => {
    expect(shiftAnchor('week', '2026-10-08', 1)).toBe('2026-10-15');
    expect(shiftAnchor('week', '2026-10-08', -1)).toBe('2026-10-01');
    expect(shiftAnchor('agenda', '2026-10-03', 1)).toBe('2026-10-17');
    expect(shiftAnchor('month', '2026-10-08', 1)).toBe('2026-11-01');
    expect(shiftAnchor('month', '2026-10-08', -1)).toBe('2026-09-01');
  });

  it('rolls the year over for months', () => {
    expect(shiftAnchor('month', '2026-12-15', 1)).toBe('2027-01-01');
    expect(shiftAnchor('month', '2027-01-15', -1)).toBe('2026-12-01');
  });
});

describe('viewTitle', () => {
  it('names the visible period', () => {
    const week = viewTitle('week', '2026-10-08', 0);
    expect(week).toContain('2026');
    expect(week).toContain('–');
    expect(viewTitle('month', '2026-10-08', 0)).toContain('2026');
  });

  it('shows both years when a week straddles New Year', () => {
    const title = viewTitle('week', '2026-12-30', 0);
    expect(title).toContain('2026');
    expect(title).toContain('2027');
  });
});

describe('parseCalendarView', () => {
  it('accepts the three views and rejects anything else', () => {
    expect(parseCalendarView('week')).toBe('week');
    expect(parseCalendarView('month')).toBe('month');
    expect(parseCalendarView('agenda')).toBe('agenda');
    expect(parseCalendarView('year')).toBeNull();
    expect(parseCalendarView(null)).toBeNull();
  });
});
