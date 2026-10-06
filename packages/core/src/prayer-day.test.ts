import { describe, expect, it } from 'vitest';

import { computeHabitsReport, type HabitCompletion, type HabitEvent, type HabitSettings } from './habits';
import { prayerDayKey } from './occurrences';
import { DEFAULT_PRAYER_SETTINGS, PRAYER_NAMES, prayerTimesOnDay, resolvePrayerConfig } from './prayer-times';
import { expandSchedule } from './schedule';
import { dayNumberFromDateString } from './time-zone';
import type { AlarmSettings, EventKind, EventRow, PrayerName, PrayerSettings } from './types';

const MINUTE = 60_000;
const USER = '99999999-9999-4999-8999-999999999999';

const SETTINGS: AlarmSettings = {
  user_id: USER,
  timezone: 'Africa/Tunis',
  week_starts_on: 0,
  refire_seconds: 120,
  pass_cap: 2,
  grace_minutes: 30,
  ...DEFAULT_PRAYER_SETTINGS,
  prayers_enabled: true,
  prayers_enabled_since: '2026-09-01T00:00:00.000Z',
};

function row(kind: Exclude<EventKind, 'normal'>, prayer: PrayerName): EventRow {
  return {
    id: `0000000${kind === 'prayer' ? 1 : 2}-0000-4000-8000-00000000000${PRAYER_NAMES.indexOf(prayer)}`,
    user_id: USER,
    title: prayer,
    notes: null,
    start_at: '2026-09-01T00:00:00.000Z',
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
    updated_at: '2026-09-01T00:00:00.000Z',
    kind,
    prayer,
  };
}

function instant(settings: Partial<PrayerSettings> & { timezone?: string }, prayer: PrayerName, day: string): Date {
  const config = resolvePrayerConfig({ ...SETTINGS, ...settings })!;
  return prayerTimesOnDay(config, dayNumberFromDateString(day))[prayer];
}

describe('prayerDayKey', () => {
  const fajr = row('prayer', 'fajr');

  it('is the same for the old and the new alarm time after an offset change', () => {
    const before = instant({}, 'fajr', '2026-10-06');
    const after = instant({ fajr_offset_min: 2 }, 'fajr', '2026-10-06');
    expect(after.getTime() - before.getTime()).toBe(2 * MINUTE);
    expect(prayerDayKey(fajr, before, { ...SETTINGS, fajr_offset_min: 2 })).toBe(
      prayerDayKey(fajr, after, { ...SETTINGS, fajr_offset_min: 2 })
    );
  });

  it('is the same after a location change and different for another day or another event', () => {
    const settings = { ...SETTINGS, latitude: 36.4, longitude: 9.9 };
    const old = instant({}, 'fajr', '2026-10-06');
    expect(prayerDayKey(fajr, old, settings)).toBe(prayerDayKey(fajr, instant(settings, 'fajr', '2026-10-06'), settings));
    expect(prayerDayKey(fajr, old, settings)).not.toBe(prayerDayKey(fajr, instant({}, 'fajr', '2026-10-07'), settings));
    expect(prayerDayKey(fajr, old, settings)).not.toBe(prayerDayKey(row('prayer', 'dhuhr'), old, settings));
  });

  it('does not drift across midnight: a late Isha pushed past 00:00 keeps its day', () => {
    // Isha is 18:21 UTC; in a +5:30 zone that is 23:51 local, and 10 minutes later it is 00:01 of the next date.
    const settings = { ...SETTINGS, timezone: 'Asia/Kolkata', isha_offset_min: 10 };
    const isha = row('prayer', 'isha');
    const old = instant({ timezone: 'Asia/Kolkata' }, 'isha', '2026-10-06');
    const moved = instant(settings, 'isha', '2026-10-06');
    expect(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(old)).toBe('2026-10-06');
    expect(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(moved)).toBe('2026-10-07');
    expect(prayerDayKey(isha, old, settings)).toBe(prayerDayKey(isha, moved, settings));
    // The next evening's Isha is another day.
    expect(prayerDayKey(isha, instant(settings, 'isha', '2026-10-07'), settings)).not.toBe(prayerDayKey(isha, moved, settings));
  });

  it('follows the reminder lead for a pre-prayer alarm', () => {
    const pre = row('pre_prayer', 'asr');
    const oldLead = new Date(instant({}, 'asr', '2026-10-06').getTime() - 15 * MINUTE);
    const settings = { ...SETTINGS, pre_prayer_minutes: 30 };
    const newLead = new Date(instant({}, 'asr', '2026-10-06').getTime() - 30 * MINUTE);
    expect(prayerDayKey(pre, oldLead, settings)).toBe(prayerDayKey(pre, newLead, settings));
  });

  it('is null for a normal alarm and while prayers are off', () => {
    const normal = { ...fajr, kind: 'normal' as const, prayer: null };
    expect(prayerDayKey(normal, new Date(), SETTINGS)).toBeNull();
    expect(prayerDayKey(fajr, new Date(), { ...SETTINGS, prayers_enabled: false })).toBeNull();
  });
});

describe('a completion survives a change of prayer settings', () => {
  const NOW = new Date('2026-10-06T00:00:00.000Z');
  const events = PRAYER_NAMES.map((prayer) => row('prayer', prayer));

  function completedFlags(settings: AlarmSettings, doneAt: Date, prayer: PrayerName) {
    const result = expandSchedule({
      events,
      cheatDays: [],
      settings,
      completions: [{ event_id: row('prayer', prayer).id, occurrence_at: doneAt.toISOString().replace('Z', '+00:00') }],
      now: NOW,
      horizonDays: 3,
    });
    return result.occurrences.filter((occurrence) => occurrence.eventId === row('prayer', prayer).id);
  }

  it('does not ring again the 06:01-style occurrence that replaces a done 05:59 one', () => {
    // Prayed at the old Fajr time, then +2 minutes saved: today's Fajr is a new instant but the same prayer.
    const prayedAt = instant({}, 'fajr', '2026-10-06');
    const occurrences = completedFlags({ ...SETTINGS, fajr_offset_min: 2 }, prayedAt, 'fajr');
    const today = occurrences.find((occurrence) => occurrence.at === new Date(prayedAt.getTime() + 2 * MINUTE).toISOString());
    expect(today?.completed).toBe(true);
    // Only that day: tomorrow's Fajr still has to be prayed.
    expect(occurrences.filter((occurrence) => occurrence.completed)).toHaveLength(1);
  });

  it('does the same after a location change', () => {
    const settings = { ...SETTINGS, latitude: 35.7, longitude: 10.6 };
    const prayedAt = instant({}, 'dhuhr', '2026-10-06');
    const moved = instant(settings, 'dhuhr', '2026-10-06');
    expect(moved.getTime()).not.toBe(prayedAt.getTime());
    const occurrences = completedFlags(settings, prayedAt, 'dhuhr');
    expect(occurrences.find((occurrence) => occurrence.at === moved.toISOString())?.completed).toBe(true);
  });

  it('keeps matching a normal alarm by exact instant', () => {
    const normal: EventRow = { ...row('prayer', 'fajr'), id: '11111111-1111-4111-8111-111111111111', kind: 'normal', prayer: null, repeat_unit: 'day', start_at: '2026-10-06T08:00:00.000Z' };
    const near = expandSchedule({
      events: [normal],
      cheatDays: [],
      settings: SETTINGS,
      completions: [{ event_id: normal.id, occurrence_at: '2026-10-06T08:02:00.000Z' }],
      now: NOW,
      horizonDays: 2,
    });
    expect(near.occurrences.some((occurrence) => occurrence.completed)).toBe(false);
  });

  it('counts a prayer done before the change as done, not missed', () => {
    const habitSettings: HabitSettings = { ...SETTINGS };
    const days = Array.from({ length: 10 }, (_, i) => `2026-10-${String(10 + i).padStart(2, '0')}`);
    const completions: HabitCompletion[] = days.map((day) => ({
      event_id: events[0]!.id,
      occurrence_at: instant({}, 'fajr', day).toISOString(),
      status: 'done',
      snoozes_used: 0,
    }));
    // The report pools the prayers into one habit; with only Fajr in it, its counts are Fajr's.
    const habit = (settings: HabitSettings) =>
      computeHabitsReport([{ ...events[0]!, created_at: '2026-10-01T00:00:00.000Z' } as HabitEvent], completions, [], settings, new Date('2026-10-20T20:00:00.000Z')).habits.find(
        (candidate) => candidate.pooled === 'prayer'
      )!;

    const before = habit(habitSettings);
    // The offset is edited after the completions exist; the history keeps its score.
    const after = habit({ ...habitSettings, fajr_offset_min: 2 });
    expect(after.done).toBe(before.done);
    expect(after.missed).toBe(before.missed);
    expect(before.done).toBe(10);
    // Weights follow the alarm instants, which moved by two minutes: equal up to floating point.
    expect(after.score).toBeCloseTo(before.score!, 6);
    // Different location: same.
    const moved = habit({ ...habitSettings, latitude: 35.7, longitude: 10.6 });
    expect(moved.done).toBe(before.done);
    expect(moved.missed).toBe(before.missed);
  });
});

describe('unusable prayer settings do not take the report down', () => {
  it('leaves the prayer out of the report and keeps the other habits', () => {
    const fajr = { ...row('prayer', 'fajr'), created_at: '2026-10-01T00:00:00.000Z' } as HabitEvent;
    const normal = {
      ...fajr,
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'normal',
      prayer: null,
      start_at: '2026-10-01T08:00:00.000Z',
      passable: true,
    } as HabitEvent;
    // A corrupt row: a latitude where there are no prayer times.
    const report = computeHabitsReport([fajr, normal], [], [], { ...SETTINGS, latitude: 80 }, new Date('2026-10-20T20:00:00.000Z'));
    expect(report.failed.map((habit) => habit.id)).toEqual([fajr.id]);
    expect(report.habits.map((habit) => habit.eventId)).toEqual([normal.id]);
  });
});
