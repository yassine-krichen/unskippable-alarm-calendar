import { afterEach, describe, expect, it, vi } from 'vitest';

// holidays.ts picks its Hijri formatter once, so each case stubs Intl first and loads a fresh copy of the module.
const RealDateTimeFormat = Intl.DateTimeFormat;

type Behaviour = 'real' | 'gregorian' | 'throws';

function stubIntl(calendars: Record<string, Behaviour>): void {
  class FakeDateTimeFormat {
    private readonly real: Intl.DateTimeFormat;
    private readonly behaviour: Behaviour;

    constructor(locale?: string | string[], options?: Intl.DateTimeFormatOptions) {
      const tag = String(locale);
      const calendar = Object.keys(calendars).find((name) => tag.includes(`ca-${name}`));
      this.behaviour = calendar === undefined ? 'real' : (calendars[calendar] as Behaviour);
      if (this.behaviour === 'throws') throw new RangeError(`Unsupported calendar in ${tag}`);
      this.real = new RealDateTimeFormat(locale, options);
    }

    // date-fns-tz, loaded by time-zone.ts, formats through this too.
    format(date?: Date | number): string {
      return this.real.format(date);
    }

    formatToParts(date: Date): Intl.DateTimeFormatPart[] {
      return this.real.formatToParts(date);
    }

    resolvedOptions(): Intl.ResolvedDateTimeFormatOptions {
      const resolved = this.real.resolvedOptions();
      // A runtime without the calendar silently formats with the Gregorian one and says so here.
      return this.behaviour === 'gregorian' ? { ...resolved, calendar: 'gregory' } : resolved;
    }
  }
  vi.stubGlobal('Intl', { ...Intl, DateTimeFormat: FakeDateTimeFormat });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('a runtime without the Umm al-Qura calendar', { timeout: 30_000 }, () => {
  it('falls back to the tabular Islamic civil calendar', async () => {
    stubIntl({ 'islamic-umalqura': 'gregorian' });
    const holidays = await import('./holidays');

    expect(holidays.hijriCalendarAvailable()).toBe(true);
    // The civil calendar starts 1448 AH on 17 June 2026 (Umm al-Qura: the 16th); this proves the fallback is in use.
    expect(holidays.hijriDateOfDay('2026-06-16')).toEqual({ year: 1447, month: 12, day: 30 });
    expect(holidays.hijriDateOfDay('2026-06-17')).toEqual({ year: 1448, month: 1, day: 1 });
    const found = holidays.islamicHolidaysBetween('2026-06-10', '2026-06-30', 0);
    expect(found.find((entry) => entry.id === 'islamic-new-year')?.day).toBe('2026-06-17');
  });

  it('also falls back when the calendar is rejected outright', async () => {
    stubIntl({ 'islamic-umalqura': 'throws' });
    const holidays = await import('./holidays');

    expect(holidays.hijriCalendarAvailable()).toBe(true);
    expect(holidays.hijriDateOfDay('2026-06-17')).toEqual({ year: 1448, month: 1, day: 1 });
  });
});

describe('a runtime with no Hijri calendar at all', { timeout: 30_000 }, () => {
  it.each<[string, Record<string, Behaviour>]>([
    ['both calendars format as Gregorian', { 'islamic-umalqura': 'gregorian', 'islamic-civil': 'gregorian' }],
    ['both calendars are rejected', { 'islamic-umalqura': 'throws', 'islamic-civil': 'throws' }],
  ])('reports it and returns no Islamic holidays when %s', async (_label, calendars) => {
    stubIntl(calendars);
    const holidays = await import('./holidays');

    expect(holidays.hijriCalendarAvailable()).toBe(false);
    expect(holidays.islamicHolidaysBetween('2026-01-01', '2027-12-31', 0)).toEqual([]);
    expect(holidays.hijriDateOfDay('2026-06-16')).toBeNull();
    expect(holidays.ramadanOnOrAfter('2026-10-12', 0)).toBeNull();
  });

  it('still merges the country holidays, unshifted by a Hijri date it cannot compute', async () => {
    stubIntl({ 'islamic-umalqura': 'gregorian', 'islamic-civil': 'gregorian' });
    const holidays = await import('./holidays');

    const merged = holidays.mergeHolidays({
      publicHolidays: [{ name: 'Labour Day', day: '2026-05-01', endDay: '2026-05-01', hijri: null }],
      islamic: holidays.islamicHolidaysBetween('2026-01-01', '2026-12-31', 0),
      offsetDays: 1,
    });
    expect(merged.map((entry) => entry.name)).toEqual(['Labour Day']);
  });
});
