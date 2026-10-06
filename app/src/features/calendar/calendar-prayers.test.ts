import { DEFAULT_PRAYER_SETTINGS, type EventRow, type PrayerName, type Settings } from '@alarm-calendar/core';
import { describe, expect, it } from 'vitest';

import { dayImpact, expandOccurrences, PRAYER_CLASS, toCalendarEvent } from './calendar-events';

const SETTINGS: Settings = {
  user_id: 'u1',
  timezone: 'Africa/Tunis',
  week_starts_on: 0,
  refire_seconds: 120,
  pass_cap: 2,
  grace_minutes: 30,
  ...DEFAULT_PRAYER_SETTINGS,
  prayers_enabled: true,
};

function prayerRow(kind: 'prayer' | 'pre_prayer', prayer: PrayerName, overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: `${kind}-${prayer}`,
    user_id: 'u1',
    title: kind === 'prayer' ? prayer : `Before ${prayer}`,
    notes: null,
    start_at: '2026-10-01T00:00:00.000Z',
    duration_min: 15,
    repeat_unit: 'day',
    repeat_interval: 1,
    repeat_weekdays: null,
    ends_at: null,
    max_snoozes: 0,
    snooze_minutes: 5,
    passable: false,
    color: null,
    active: true,
    updated_at: '2026-10-01T00:00:00Z',
    kind,
    prayer,
    ...overrides,
  };
}

const ROWS: EventRow[] = (['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const).flatMap((prayer) => [
  prayerRow('prayer', prayer),
  prayerRow('pre_prayer', prayer),
]);

const range = { from: new Date('2026-10-05T23:00:00Z'), to: new Date('2026-10-07T23:00:00Z') };

describe('prayers in the calendar', () => {
  it('shows five prayers a day from the prayer times, and no reminders', () => {
    const occurrences = expandOccurrences(ROWS, range, SETTINGS, []);
    expect(occurrences).toHaveLength(10);
    expect(occurrences.every((occurrence) => occurrence.kind === 'prayer')).toBe(true);
    const oct6 = occurrences.filter((occurrence) => occurrence.day === '2026-10-06').map((occurrence) => occurrence.title);
    expect(oct6).toEqual(['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']);
  });

  it('never greys a prayer out on a cheat day', () => {
    const occurrences = expandOccurrences(ROWS, range, SETTINGS, ['2026-10-06']);
    expect(occurrences.every((occurrence) => !occurrence.silenced && !occurrence.passable)).toBe(true);
  });

  it('shows nothing while prayers are off', () => {
    expect(expandOccurrences(ROWS, range, { ...SETTINGS, prayers_enabled: false }, [])).toEqual([]);
  });

  it('marks a prayer for the calendar grid so it is drawn apart', () => {
    const [first] = expandOccurrences(ROWS, range, SETTINGS, []);
    const calendarEvent = toCalendarEvent(first!);
    expect(calendarEvent.className).toContain(PRAYER_CLASS);
    expect(calendarEvent.extendedProps.prayer).toBe(true);
  });

  it('counts the five prayers among the alarms that ring through a cheat day', () => {
    const normal = prayerRow('prayer', 'fajr', { id: 'n1', kind: 'normal', prayer: null, passable: true, title: 'Meds' });
    const impact = dayImpact([...ROWS, normal], '2026-10-08', SETTINGS, new Date('2026-10-01T00:00:00Z'));
    expect(impact).toEqual({ silenced: 1, stillRing: 5 });
  });

  it('skips the prayers and tells the caller when the prayer settings cannot be used, keeping the other alarms', () => {
    const normal = prayerRow('prayer', 'fajr', { id: 'n1', kind: 'normal', prayer: null, passable: true, title: 'Meds' });
    const failed: string[] = [];
    // A corrupt row: a latitude where there are no prayer times.
    const occurrences = expandOccurrences([...ROWS, normal], range, { ...SETTINGS, latitude: 80 }, [], (event) =>
      failed.push(event.id)
    );
    expect(occurrences.length).toBeGreaterThan(0);
    expect(occurrences.every((occurrence) => occurrence.eventId === 'n1')).toBe(true);
    expect(failed).toHaveLength(5);
    // The cheat day dialog's count must not throw either.
    expect(dayImpact([...ROWS, normal], '2026-10-08', { ...SETTINGS, latitude: 80 }, new Date('2026-10-01T00:00:00Z'))).toEqual({
      silenced: 1,
      stillRing: 0,
    });
  });
});
