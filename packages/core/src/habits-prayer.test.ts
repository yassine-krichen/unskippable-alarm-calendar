import { describe, expect, it } from 'vitest';

import { computeHabitsReport, isHabit, type HabitCompletion, type HabitEvent, type HabitSettings } from './habits';
import { DEFAULT_PRAYER_SETTINGS, PRAYER_NAMES, prayerTimesOnDay, resolvePrayerConfig } from './prayer-times';
import { dayNumberFromDateString } from './time-zone';
import type { PrayerName } from './types';

const DAY = 86_400_000;
const NOW = new Date('2026-10-20T20:30:00.000Z');
const ENABLED = '2026-10-01T00:00:00.000Z';

const SETTINGS: HabitSettings = {
  timezone: 'Africa/Tunis',
  grace_minutes: 30,
  ...DEFAULT_PRAYER_SETTINGS,
  prayers_enabled: true,
  prayers_enabled_since: ENABLED,
};

const config = resolvePrayerConfig(SETTINGS)!;

function prayer(name: PrayerName, overrides: Partial<HabitEvent> = {}): HabitEvent {
  return {
    id: `0000000a-0000-4000-8000-00000000000${PRAYER_NAMES.indexOf(name)}`,
    title: name,
    start_at: '2026-10-01T00:00:00.000Z',
    repeat_unit: 'day',
    repeat_interval: 1,
    repeat_weekdays: null,
    ends_at: null,
    active: true,
    passable: false,
    color: null,
    created_at: ENABLED,
    kind: 'prayer',
    prayer: name,
    ...overrides,
  };
}

/** A done completion for `name` on each listed date. */
function prayed(name: PrayerName, dates: string[]): HabitCompletion[] {
  return dates.map((date) => ({
    event_id: prayer(name).id,
    occurrence_at: prayerTimesOnDay(config, dayNumberFromDateString(date))[name].toISOString(),
    status: 'done',
    snoozes_used: 0,
  }));
}

/** 2026-10-01 to 2026-10-20: every prayer of these days is over by NOW (21:30 in Tunis, past the grace window). */
const DATES = Array.from({ length: 20 }, (_, i) => new Date(Date.UTC(2026, 9, 1) + i * DAY).toISOString().slice(0, 10));

describe('isHabit', () => {
  it('counts each prayer, never a pre-prayer reminder', () => {
    expect(isHabit({ active: true, repeat_unit: 'none', kind: 'prayer' })).toBe(true);
    expect(isHabit({ active: true, repeat_unit: 'day', kind: 'pre_prayer' })).toBe(false);
    expect(isHabit({ active: false, repeat_unit: 'day', kind: 'prayer' })).toBe(false);
    expect(isHabit({ active: true, repeat_unit: 'day' })).toBe(true);
    expect(isHabit({ active: true, repeat_unit: 'none' })).toBe(false);
  });
});

describe('prayers as habits', () => {
  it('scores every prayer from its own times: all prayed is a full score, none is a miss each day', () => {
    const events = PRAYER_NAMES.map((name) => prayer(name));
    const completions = PRAYER_NAMES.filter((name) => name !== 'fajr').flatMap((name) => prayed(name, DATES));
    const report = computeHabitsReport(events, completions, [], SETTINGS, NOW);
    const byTitle = Object.fromEntries(report.habits.map((habit) => [habit.title, habit]));

    expect(byTitle['dhuhr']).toMatchObject({ done: 20, missed: 0, score: 100, tier: 'diamond', windowDays: 28 });
    expect(byTitle['isha']).toMatchObject({ done: 20, missed: 0 });
    expect(byTitle['fajr']).toMatchObject({ done: 0, missed: 20, score: 0, tier: 'bronze' });
  });

  it('is not excused by a cheat day, while a passable alarm would be', () => {
    const cheatDay = '2026-10-10';
    const missedThatDay = DATES.filter((date) => date !== cheatDay);
    const events = [prayer('dhuhr'), prayer('asr', { passable: true })];
    // Passable is true on the Asr row but it is a prayer: the cheat day must still not excuse it.
    const completions = [...prayed('dhuhr', missedThatDay), ...prayed('asr', missedThatDay)];
    const report = computeHabitsReport(events, completions, [cheatDay], SETTINGS, NOW);
    for (const habit of report.habits) {
      expect(habit.excused, habit.title).toBe(0);
      expect(habit.missed, habit.title).toBe(1);
    }
  });

  it('does not score prayers from before they were switched on', () => {
    const switchedOn = '2026-10-15T00:00:00.000Z';
    const settings: HabitSettings = { ...SETTINGS, prayers_enabled_since: switchedOn };
    // created_at is old (October 1); only the switch-on time keeps the first two weeks out of it.
    const report = computeHabitsReport([prayer('dhuhr')], prayed('dhuhr', DATES.slice(-6)), [], settings, NOW);
    expect(report.habits[0]).toMatchObject({ done: 6, missed: 0 });
    expect(report.habits[0]?.scored).toBe(6);
  });

  it('has nothing to score while prayers are off', () => {
    const report = computeHabitsReport([prayer('dhuhr')], [], [], { ...SETTINGS, prayers_enabled: false }, NOW);
    expect(report.habits[0]).toMatchObject({ done: 0, missed: 0, pending: 0, score: null, tier: 'unranked' });
  });

  it('leaves the pre-prayer reminders out of the report', () => {
    const report = computeHabitsReport(
      [prayer('dhuhr'), prayer('dhuhr', { id: 'ffffffff-0000-4000-8000-000000000001', kind: 'pre_prayer' })],
      [],
      [],
      SETTINGS,
      NOW
    );
    expect(report.habits).toHaveLength(1);
  });
});
