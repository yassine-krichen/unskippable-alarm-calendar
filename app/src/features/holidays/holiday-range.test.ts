import type { PublicHoliday, Settings } from '@alarm-calendar/core';
import { describe, expect, it } from 'vitest';

import { toHolidayCalendarEvents } from './holiday-events';
import { NO_HOLIDAYS, holidayPreferencesOf, holidaysInRange, yearsToLoad } from './holiday-range';

const TUNISIA: PublicHoliday[] = [
  { name: "New Year's Day", day: '2026-01-01', endDay: '2026-01-01', hijri: null },
  { name: 'End of Ramadan (Eid al-Fitr)', day: '2026-03-20', endDay: '2026-03-20', hijri: { month: 10, day: 1 } },
  { name: "Fête de l'indépendance", day: '2026-03-20', endDay: '2026-03-20', hijri: null },
];

describe('holidayPreferencesOf', () => {
  it('reads absent columns as no holidays', () => {
    expect(holidayPreferencesOf(null)).toEqual({ country: null, islamic: false, offsetDays: 0 });
    expect(holidayPreferencesOf({ user_id: 'u', timezone: 'UTC' } as Settings)).toEqual({
      country: null,
      islamic: false,
      offsetDays: 0,
    });
  });

  it('keeps what is stored and clamps a stray offset', () => {
    const settings = { holiday_country: 'TN', islamic_holidays: true, hijri_offset_days: 7 } as Settings;
    expect(holidayPreferencesOf(settings)).toEqual({ country: 'TN', islamic: true, offsetDays: 2 });
  });
});

describe('yearsToLoad', () => {
  it('covers the year a range touches and its neighbour when the range is near a year end', () => {
    expect(yearsToLoad('2026-03-01', '2026-04-12')).toEqual([2026]);
    expect(yearsToLoad('2026-12-28', '2027-02-08')).toEqual([2026, 2027]);
    expect(yearsToLoad('2026-01-01', '2026-01-08')).toEqual([2025, 2026]);
  });
});

describe('holidaysInRange', () => {
  const march = { start: '2026-03-01', end: '2026-04-12' };

  it('is empty with no country and the Islamic holidays off', () => {
    const result = holidaysInRange({ country: null, islamic: false, offsetDays: 0 }, TUNISIA, march.start, march.end);
    expect(result).toBe(NO_HOLIDAYS);
  });

  it('ignores a loaded list once the country is none', () => {
    const result = holidaysInRange({ country: null, islamic: true, offsetDays: 0 }, TUNISIA, march.start, march.end);
    expect(result.holidays.map((holiday) => holiday.name)).not.toContain("Fête de l'indépendance");
  });

  it('shows the country alone, with Eid as a plain public holiday when the Islamic holidays are off', () => {
    const { holidays } = holidaysInRange({ country: 'TN', islamic: false, offsetDays: 0 }, TUNISIA, march.start, march.end);
    expect(holidays.map((holiday) => [holiday.name, holiday.kind])).toEqual([
      ['End of Ramadan (Eid al-Fitr)', 'public'],
      ["Fête de l'indépendance", 'public'],
    ]);
  });

  it('adds the Islamic ones, merges Eid, and numbers the days of Ramadan', () => {
    const result = holidaysInRange({ country: 'TN', islamic: true, offsetDays: 0 }, TUNISIA, march.start, march.end);
    expect(result.holidays.map((holiday) => holiday.name)).toEqual([
      'Ramadan begins',
      'Laylat al-Qadr (likely)',
      // A day off the country marks comes before a purely religious entry on the same day.
      "Fête de l'indépendance",
      'Eid al-Fitr',
    ]);
    expect(result.byDay.get('2026-03-20')?.map((holiday) => holiday.name)).toEqual(["Fête de l'indépendance", 'Eid al-Fitr']);
    expect(result.stretches.get('2026-03-10')).toEqual({ name: 'Ramadan', dayNumber: 21, totalDays: 30 });
    // Ramadan is chipped on its first day only, which is before this range.
    expect([...result.byDay.values()].flat().map((holiday) => holiday.name)).not.toContain('Ramadan begins');
  });

  it('moves the Islamic holidays and the Hijri-dated country ones together by the adjustment', () => {
    const result = holidaysInRange({ country: 'TN', islamic: true, offsetDays: 1 }, TUNISIA, march.start, march.end);
    expect(result.holidays.find((holiday) => holiday.name === 'Eid al-Fitr')?.day).toBe('2026-03-21');
    expect(result.holidays.find((holiday) => holiday.name === "Fête de l'indépendance")?.day).toBe('2026-03-20');
  });
});

describe('toHolidayCalendarEvents', () => {
  const { holidays } = holidaysInRange(
    { country: 'TN', islamic: true, offsetDays: 0 },
    [{ name: 'Eid', day: '2026-03-20', endDay: '2026-03-22', hijri: { month: 10, day: 1 } }],
    '2026-02-01',
    '2026-04-01'
  );
  const events = toHolidayCalendarEvents(holidays);

  it('makes all-day events with an exclusive end, never editable', () => {
    const eid = events.find((event) => event.title === 'Eid al-Fitr');
    expect(eid).toMatchObject({ start: '2026-03-20', end: '2026-03-23', allDay: true, editable: false });
    expect(eid?.extendedProps).toEqual({ holiday: true, kind: 'religious', publicHoliday: true });
    expect(eid?.className).toBe('holiday-religious');
  });

  it('draws Ramadan as a chip on its first day only', () => {
    const ramadan = events.find((event) => event.title === 'Ramadan begins');
    expect(ramadan).toMatchObject({ start: '2026-02-18', end: '2026-02-19' });
  });
});
