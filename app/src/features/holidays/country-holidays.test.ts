import { islamicHolidaysBetween, mergeHolidays } from '@alarm-calendar/core';
import { describe, expect, it } from 'vitest';

import { holidayLengthDays, listHolidayCountries, publicHolidaysFor } from './country-holidays';

describe('holidayLengthDays', () => {
  it.each([
    ['1 Shawwal', 1],
    ['01-01', 1],
    ['1 Shawwal P3D', 3],
    ['10 Dhu al-Hijjah P4D', 4],
    ['10 Dhu al-Hijjah P2DT0H0M', 2],
    ['1 Shawwal PT90H', 4],
    ['1 Shawwal and if sunday then next monday', 1],
  ])('%s lasts %i day(s)', (rule, days) => {
    expect(holidayLengthDays(rule)).toBe(days);
  });
});

describe('listHolidayCountries', () => {
  it('lists Tunisia among the supported countries, by name, sorted', async () => {
    const countries = await listHolidayCountries();
    expect(countries.length).toBeGreaterThan(150);
    expect(countries).toContainEqual({ code: 'TN', name: 'Tunisia' });
    const names = countries.map((country) => country.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

describe('publicHolidaysFor', () => {
  it("returns Tunisia's nationwide public holidays for 2026, offline, with French names for the national ones", async () => {
    const holidays = await publicHolidaysFor('TN', [2026]);
    const byName = new Map(holidays.map((holiday) => [holiday.name, holiday]));
    expect(byName.get("Fête de l'indépendance")?.day).toBe('2026-03-20');
    expect(byName.get('Journée des Martyrs')?.day).toBe('2026-04-09');
    expect(byName.get("New Year's Day")?.day).toBe('2026-01-01');
    expect(holidays.map((holiday) => holiday.day)).toEqual(holidays.map((holiday) => holiday.day).sort());
  });

  it('tags the Hijri-dated holidays so the adjustment can move them, and only those', async () => {
    const holidays = await publicHolidaysFor('TN', [2026]);
    const hijri = holidays.filter((holiday) => holiday.hijri !== null).map((holiday) => holiday.hijri);
    expect(hijri).toEqual(
      expect.arrayContaining([
        { month: 10, day: 1 },
        { month: 12, day: 10 },
        { month: 1, day: 1 },
        { month: 3, day: 12 },
      ])
    );
    expect(hijri).toHaveLength(4);
    expect(holidays.find((holiday) => holiday.name === "New Year's Day")?.hijri).toBeNull();
  });

  it('leaves out observances and optional days a country does not give off', async () => {
    const germany = await publicHolidaysFor('DE', [2026]);
    expect(germany.map((holiday) => holiday.name)).not.toContain("Valentine's Day");
    expect(germany.map((holiday) => holiday.name)).toContain('Labour Day');
  });

  it('gives a multi-day holiday its whole length', async () => {
    const emirates = await publicHolidaysFor('AE', [2026]);
    const eid = emirates.find((holiday) => holiday.hijri?.month === 10 && holiday.hijri.day === 1);
    expect(eid).toMatchObject({ day: '2026-03-20', endDay: '2026-03-22' });
  });

  it('answers for several years at once', async () => {
    const holidays = await publicHolidaysFor('TN', [2026, 2027]);
    expect(holidays.some((holiday) => holiday.day.startsWith('2027-'))).toBe(true);
    expect(holidays.some((holiday) => holiday.day.startsWith('2026-'))).toBe(true);
  });
});

describe('the library and the runtime agree on the Hijri calendar, so a merge is one entry', () => {
  // The library has its own Umm al-Qura table; core uses the runtime's. They match from 2024 to 2029 (checked when this
  // was written); a later divergence would show as a second chip, which mergeHolidays tolerates up to two days.
  it('merges every Hijri-dated Tunisian holiday of 2024 to 2029 into one entry on the same day', async () => {
    for (let year = 2024; year <= 2029; year++) {
      const publicHolidays = await publicHolidaysFor('TN', [year]);
      const islamic = islamicHolidaysBetween(`${year}-01-01`, `${year}-12-31`, 0);
      const merged = mergeHolidays({ publicHolidays, islamic, offsetDays: 0 });
      for (const holiday of publicHolidays.filter((entry) => entry.hijri !== null)) {
        const entry = merged.find((candidate) => candidate.day === holiday.day && candidate.publicHoliday && candidate.kind === 'religious');
        expect(entry, `${holiday.name} ${holiday.day}`).toBeDefined();
      }
    }
  });
});
