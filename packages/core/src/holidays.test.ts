import { describe, expect, it } from 'vitest';

import vectors from '../test-vectors/islamic-holidays.json';
import {
  hijriDateOfDay,
  holidaysByDay,
  islamicHolidaysBetween,
  mergeHolidays,
  normalizeHijriOffset,
  parseHijriRule,
  ramadanOnOrAfter,
  stretchDays,
  type IslamicHolidayId,
  type PublicHoliday,
} from './holidays';

interface VectorHoliday {
  hijriYear: number;
  id: IslamicHolidayId;
  day: string;
  source: string;
}

const HOLIDAYS = vectors.holidays as VectorHoliday[];

describe('islamicHolidaysBetween against published Umm al-Qura dates (1446 to 1449 AH)', () => {
  it.each(HOLIDAYS.map((holiday) => [`${holiday.id} ${holiday.hijriYear} AH`, holiday] as const))(
    '%s falls on the published day',
    (_label, holiday) => {
      const found = islamicHolidaysBetween(holiday.day, holiday.day, 0);
      expect(found.map((entry) => entry.id)).toContain(holiday.id);
      expect(found.find((entry) => entry.id === holiday.id)?.hijriYear).toBe(holiday.hijriYear);
      // The day before and after are not it (for Ramadan that is the first day only; it runs on, but starts here).
      const starts = islamicHolidaysBetween('2024-01-01', '2028-12-31', 0)
        .filter((entry) => entry.id === holiday.id && entry.hijriYear === holiday.hijriYear)
        .map((entry) => entry.day);
      expect(starts).toEqual([holiday.day]);
    }
  );

  it('runs Ramadan for the whole month, 30 days in 1447 AH and 29 in 1448 AH', () => {
    for (const run of vectors.ramadanRuns) {
      const ramadan = islamicHolidaysBetween(run.start, run.end, 0).find((entry) => entry.id === 'ramadan');
      expect(ramadan).toMatchObject({ day: run.start, endDay: run.end, hijriYear: run.hijriYear });
    }
  });

  it('lists a Ramadan that began before the range and is still running', () => {
    const middle = islamicHolidaysBetween('2026-03-01', '2026-03-05', 0);
    expect(middle.map((entry) => entry.id)).toEqual(['ramadan']);
    expect(middle[0]).toMatchObject({ day: '2026-02-18', endDay: '2026-03-19' });
  });

  it('returns nothing for a range with no Islamic holiday, and for an inverted range', () => {
    expect(islamicHolidaysBetween('2026-10-01', '2026-10-31', 0)).toEqual([]);
    expect(islamicHolidaysBetween('2026-10-31', '2026-10-01', 0)).toEqual([]);
  });

  it('returns each holiday of a year once, in date order', () => {
    const year = islamicHolidaysBetween('2026-06-16', '2027-06-05', 0);
    expect(year.map((entry) => entry.id)).toEqual([
      'islamic-new-year',
      'ashura',
      'mawlid',
      'isra-miraj',
      'ramadan',
      'laylat-al-qadr',
      'eid-al-fitr',
      'arafah',
      'eid-al-adha',
    ]);
    expect(year.map((entry) => entry.day)).toEqual([...year.map((entry) => entry.day)].sort());
  });
});

describe('the Hijri adjustment', () => {
  it('moves every holiday by the offset, in either direction', () => {
    for (const offset of [-2, -1, 1, 2]) {
      for (const holiday of HOLIDAYS.filter((entry) => entry.source === 'van Gent')) {
        const [year, month, day] = holiday.day.split('-').map(Number) as [number, number, number];
        const shifted = new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10);
        const found = islamicHolidaysBetween(shifted, shifted, offset).find((entry) => entry.id === holiday.id);
        expect(found?.day, `${holiday.id} ${holiday.hijriYear} at ${offset}`).toBe(shifted);
      }
    }
  });

  it('shifts the whole of Ramadan, keeping its length', () => {
    const ramadan = islamicHolidaysBetween('2026-02-01', '2026-04-01', 1).find((entry) => entry.id === 'ramadan');
    expect(ramadan).toMatchObject({ day: '2026-02-19', endDay: '2026-03-20' });
  });

  it('clamps and rounds what it is given', () => {
    expect(normalizeHijriOffset(5)).toBe(2);
    expect(normalizeHijriOffset(-9)).toBe(-2);
    expect(normalizeHijriOffset(1.4)).toBe(1);
    expect(normalizeHijriOffset(undefined)).toBe(0);
    expect(normalizeHijriOffset(Number.NaN)).toBe(0);
  });

  it('reads the Hijri date of a civil day with the offset taken into account', () => {
    expect(hijriDateOfDay('2026-06-16')).toEqual({ year: 1448, month: 1, day: 1 });
    expect(hijriDateOfDay('2026-06-17', 1)).toEqual({ year: 1448, month: 1, day: 1 });
    expect(hijriDateOfDay('2026-06-15', -1)).toEqual({ year: 1448, month: 1, day: 1 });
  });
});

describe('ramadanOnOrAfter', () => {
  it('finds the Ramadan running on the day, or the next one', () => {
    expect(ramadanOnOrAfter('2026-03-01', 0)).toEqual({ start: '2026-02-18', end: '2026-03-19', hijriYear: 1447 });
    expect(ramadanOnOrAfter('2026-10-12', 0)).toEqual({ start: '2027-02-08', end: '2027-03-08', hijriYear: 1448 });
  });

  it('applies the adjustment', () => {
    expect(ramadanOnOrAfter('2026-10-12', -1)).toEqual({ start: '2027-02-07', end: '2027-03-07', hijriYear: 1448 });
  });
});

describe('parseHijriRule', () => {
  it.each([
    ['10 Dhu al-Hijjah', { month: 12, day: 10 }],
    ['1 Shawwal P3D', { month: 10, day: 1 }],
    ['1 Shawwal and if sunday then next monday', { month: 10, day: 1 }],
    ['12 Rabi al-awwal', { month: 3, day: 12 }],
    ['1 Muharram', { month: 1, day: 1 }],
    ['27 Rajab', { month: 7, day: 27 }],
    ['10 Dhu al-Hijjah PT114H', { month: 12, day: 10 }],
  ])('reads %s', (rule, expected) => {
    expect(parseHijriRule(rule)).toEqual(expected);
  });

  it.each(['01-01', '03-20', 'easter 1', '1 Octember', 'third monday in january', ''])('leaves %s alone', (rule) => {
    expect(parseHijriRule(rule)).toBeNull();
  });
});

describe('mergeHolidays', () => {
  const tunisia: PublicHoliday[] = [
    { name: "New Year's Day", day: '2026-01-01', endDay: '2026-01-01', hijri: null },
    { name: 'End of Ramadan (Eid al-Fitr)', day: '2026-03-20', endDay: '2026-03-20', hijri: { month: 10, day: 1 } },
    { name: 'Feast of the Sacrifice (Eid al-Adha)', day: '2026-05-27', endDay: '2026-05-27', hijri: { month: 12, day: 10 } },
    { name: 'Islamic New Year', day: '2026-06-16', endDay: '2026-06-16', hijri: { month: 1, day: 1 } },
  ];
  const islamic = islamicHolidaysBetween('2026-01-01', '2026-12-31', 0);

  it('makes one religious entry, tagged as a public holiday, where both lists have the same holiday', () => {
    const merged = mergeHolidays({ publicHolidays: tunisia, islamic, offsetDays: 0 });
    const eid = merged.filter((entry) => entry.day === '2026-03-20');
    expect(eid).toHaveLength(1);
    expect(eid[0]).toMatchObject({ name: 'Eid al-Fitr', kind: 'religious', publicHoliday: true });
    expect(merged.filter((entry) => entry.day === '2026-05-27')).toHaveLength(1);
    expect(merged.filter((entry) => entry.day === '2026-06-16')).toHaveLength(1);
  });

  it('keeps an Islamic holiday the country does not mark as religious only, and a plain public holiday as public', () => {
    const merged = mergeHolidays({ publicHolidays: tunisia, islamic, offsetDays: 0 });
    expect(merged.find((entry) => entry.name === 'Ashura')).toMatchObject({ kind: 'religious', publicHoliday: false });
    expect(merged.find((entry) => entry.name === "New Year's Day")).toMatchObject({ kind: 'public', publicHoliday: true });
  });

  it('shows the country Hijri holidays alone, shifted, when the Islamic holidays are off', () => {
    const merged = mergeHolidays({ publicHolidays: tunisia, islamic: [], offsetDays: 1 });
    expect(merged.map((entry) => [entry.name, entry.day])).toEqual([
      ["New Year's Day", '2026-01-01'],
      ['End of Ramadan (Eid al-Fitr)', '2026-03-21'],
      ['Feast of the Sacrifice (Eid al-Adha)', '2026-05-28'],
      ['Islamic New Year', '2026-06-17'],
    ]);
    expect(merged.every((entry) => entry.kind === 'public')).toBe(true);
  });

  it('merges after shifting both, and never moves a fixed-date holiday', () => {
    const shifted = islamicHolidaysBetween('2026-01-01', '2026-12-31', 1);
    const merged = mergeHolidays({ publicHolidays: tunisia, islamic: shifted, offsetDays: 1 });
    expect(merged.filter((entry) => entry.day === '2026-03-21')).toMatchObject([{ name: 'Eid al-Fitr', publicHoliday: true }]);
    expect(merged.find((entry) => entry.name === "New Year's Day")?.day).toBe('2026-01-01');
  });

  it('keeps the length of a multi-day public holiday on the merged entry', () => {
    const emirates: PublicHoliday[] = [
      { name: 'End of Ramadan (Eid al-Fitr)', day: '2026-03-20', endDay: '2026-03-22', hijri: { month: 10, day: 1 } },
    ];
    const merged = mergeHolidays({ publicHolidays: emirates, islamic, offsetDays: 0 });
    const eid = merged.find((entry) => entry.name === 'Eid al-Fitr');
    expect(eid).toMatchObject({ day: '2026-03-20', endDay: '2026-03-22', publicHoliday: true });
  });

  it('does not merge a country day that is not within two days of the computed one', () => {
    const far: PublicHoliday[] = [
      { name: 'Eid al-Fitr', day: '2026-03-25', endDay: '2026-03-25', hijri: { month: 10, day: 1 } },
    ];
    const merged = mergeHolidays({ publicHolidays: far, islamic, offsetDays: 0 });
    expect(merged.filter((entry) => entry.name.includes('Eid al-Fitr'))).toHaveLength(2);
  });

  it('merges a one-day disagreement between the library table and the runtime one into a single entry', () => {
    const off: PublicHoliday[] = [
      { name: 'Eid al-Fitr', day: '2026-03-21', endDay: '2026-03-21', hijri: { month: 10, day: 1 } },
    ];
    const merged = mergeHolidays({ publicHolidays: off, islamic, offsetDays: 0 });
    expect(merged.filter((entry) => entry.name === 'Eid al-Fitr')).toHaveLength(1);
    expect(merged.find((entry) => entry.name === 'Eid al-Fitr')?.day).toBe('2026-03-20');
  });
});

describe('holidaysByDay and stretchDays', () => {
  const merged = mergeHolidays({
    publicHolidays: [
      { name: 'Eid', day: '2026-03-20', endDay: '2026-03-22', hijri: { month: 10, day: 1 } },
      { name: 'Labour Day', day: '2026-05-01', endDay: '2026-05-01', hijri: null },
    ],
    islamic: islamicHolidaysBetween('2026-02-01', '2026-05-31', 0),
    offsetDays: 0,
  });

  it('lists a multi-day holiday on each of its days and Ramadan on its first day only', () => {
    const byDay = holidaysByDay(merged, '2026-02-15', '2026-03-31');
    expect([...byDay.keys()].filter((day) => byDay.get(day)?.some((entry) => entry.rangeName !== null))).toEqual(['2026-02-18']);
    expect(byDay.get('2026-03-21')?.map((entry) => entry.name)).toEqual(['Eid al-Fitr']);
    expect(byDay.get('2026-03-22')?.map((entry) => entry.name)).toEqual(['Eid al-Fitr']);
    expect(byDay.has('2026-03-23')).toBe(false);
  });

  it('clips to the range', () => {
    const byDay = holidaysByDay(merged, '2026-03-21', '2026-03-21');
    expect([...byDay.keys()]).toEqual(['2026-03-21']);
  });

  it('numbers the days of Ramadan, including those before the range starts', () => {
    const days = stretchDays(merged, '2026-03-01', '2026-03-31');
    expect(days.get('2026-03-01')).toEqual({ name: 'Ramadan', dayNumber: 12, totalDays: 30 });
    expect(days.get('2026-03-19')).toEqual({ name: 'Ramadan', dayNumber: 30, totalDays: 30 });
    expect(days.has('2026-03-20')).toBe(false);
  });
});
