import { describe, expect, it } from 'vitest';

import {
  PRAYER_HABIT_ID,
  computeHabitStats,
  computeHabitsReport,
  indexCompletions,
  isHabit,
  prayerDayOutcome,
  type HabitCompletion,
  type HabitEvent,
  type HabitSettings,
} from './habits';
import { DEFAULT_PRAYER_SETTINGS, PRAYER_NAMES, prayerTimesOnDay, resolvePrayerConfig } from './prayer-times';
import { dayNumberFromDateString, localDateString } from './time-zone';
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

/** Every prayer of every listed date, prayed. */
function allPrayed(dates: string[], except: ReadonlyArray<[PrayerName, string]> = []): HabitCompletion[] {
  return PRAYER_NAMES.flatMap((name) =>
    prayed(
      name,
      dates.filter((date) => !except.some(([skippedName, skippedDate]) => skippedName === name && skippedDate === date))
    )
  );
}

const ALL_PRAYERS = PRAYER_NAMES.map((name) => prayer(name));

function pooled(report: ReturnType<typeof computeHabitsReport>) {
  const habit = report.habits.find((candidate) => candidate.pooled === 'prayer');
  if (habit === undefined) throw new Error('no pooled prayer habit in the report');
  return habit;
}

describe('isHabit', () => {
  it('counts each prayer, never a pre-prayer reminder', () => {
    expect(isHabit({ active: true, repeat_unit: 'none', kind: 'prayer' })).toBe(true);
    expect(isHabit({ active: true, repeat_unit: 'day', kind: 'pre_prayer' })).toBe(false);
    expect(isHabit({ active: false, repeat_unit: 'day', kind: 'prayer' })).toBe(false);
    expect(isHabit({ active: true, repeat_unit: 'day' })).toBe(true);
    expect(isHabit({ active: true, repeat_unit: 'none' })).toBe(false);
  });

  it('never counts a yearly alarm or an alarm made by the birthday template', () => {
    expect(isHabit({ active: true, repeat_unit: 'year' })).toBe(false);
    expect(isHabit({ active: true, repeat_unit: 'day', group_id: '11111111-1111-4111-8111-111111111111' })).toBe(false);
    expect(isHabit({ active: true, repeat_unit: 'day', group_id: null })).toBe(true);
  });
});

describe('birthday alarms are not habits', () => {
  it('leaves the pair out of the report and out of the overall score, however long they ran', () => {
    const group = '22222222-2222-4222-8222-222222222222';
    const birthday = (id: string, title: string): HabitEvent => ({
      id,
      title,
      start_at: '2024-10-13T08:00:00.000Z',
      repeat_unit: 'year',
      repeat_interval: 1,
      repeat_weekdays: null,
      ends_at: null,
      active: true,
      passable: true,
      color: null,
      created_at: '2024-10-01T00:00:00.000Z',
      group_id: group,
    });
    const report = computeHabitsReport(
      [
        birthday('bd000000-0000-4000-8000-000000000001', "Prep for Sam's birthday"),
        birthday('bd000000-0000-4000-8000-000000000002', 'Wish Sam a happy birthday'),
      ],
      [],
      [],
      SETTINGS,
      NOW
    );
    expect(report.habits).toEqual([]);
    expect(report.overallScore).toBeNull();
  });
});

describe('prayers pooled into one habit', () => {
  it('is one "Prayer" habit with the counts and the pooled score of the five', () => {
    const completions = PRAYER_NAMES.filter((name) => name !== 'fajr').flatMap((name) => prayed(name, DATES));
    const report = computeHabitsReport(ALL_PRAYERS, completions, [], SETTINGS, NOW);

    expect(report.habits).toHaveLength(1);
    const habit = pooled(report);
    expect(habit).toMatchObject({ eventId: PRAYER_HABIT_ID, title: 'Prayer', done: 80, missed: 20, scored: 100, windowDays: 28 });

    // The score is the sum of what each prayer earned over the sum of what it could, the overall score's rule.
    const index = indexCompletions(completions);
    const parts = ALL_PRAYERS.map((event) => computeHabitStats(event, index, new Set(), SETTINGS, NOW));
    const earned = parts.reduce((total, part) => total + part.weightedEarned, 0);
    const possible = parts.reduce((total, part) => total + part.weightedPossible, 0);
    expect(habit.score).toBeCloseTo((100 * earned) / possible, 9);
  });

  it('scores a full score and a day streak when everything was prayed', () => {
    const habit = pooled(computeHabitsReport(ALL_PRAYERS, allPrayed(DATES), [], SETTINGS, NOW));
    expect(habit).toMatchObject({ done: 100, missed: 0, score: 100, tier: 'diamond', scoredDays: 20, currentStreak: 20, bestStreak: 20 });
  });

  it('ends the streak on a day with one missed prayer and starts again after it', () => {
    const completions = allPrayed(DATES, [['asr', '2026-10-15']]);
    const habit = pooled(computeHabitsReport(ALL_PRAYERS, completions, [], SETTINGS, NOW));
    expect(habit.missed).toBe(1);
    // Oct 1 to 14 done (14), Oct 15 missed, Oct 16 to 20 done (5).
    expect(habit.bestStreak).toBe(14);
    expect(habit.currentStreak).toBe(5);
  });

  it('skips a day that is still in progress instead of breaking or extending the streak', () => {
    // 11:00 in Tunis on Oct 20: Fajr is prayed, the rest of the day is still to come.
    const morning = new Date('2026-10-20T10:00:00.000Z');
    const completions = [...allPrayed(DATES.slice(0, 19)), ...prayed('fajr', ['2026-10-20'])];
    const habit = pooled(computeHabitsReport(ALL_PRAYERS, completions, [], SETTINGS, morning));
    // Only Fajr has come today, so today is open: the streak stays at the 19 finished days and today is not scored yet.
    expect(habit.currentStreak).toBe(19);
    expect(habit.scoredDays).toBe(19);
    expect(habit.missed).toBe(0);
  });

  it('is unranked until five days are scored, however many prayers that is', () => {
    // Oct 1 to 3 is 15 prayers, past HABIT_MIN_SCORED as a count, but only three days.
    const threeDays = new Date('2026-10-03T20:30:00.000Z');
    const early = pooled(computeHabitsReport(ALL_PRAYERS, allPrayed(DATES.slice(0, 3)), [], SETTINGS, threeDays));
    expect(early).toMatchObject({ scored: 15, scoredDays: 3, score: null, tier: 'unranked' });

    const fiveDays = new Date('2026-10-05T20:30:00.000Z');
    const ranked = pooled(computeHabitsReport(ALL_PRAYERS, allPrayed(DATES.slice(0, 5)), [], SETTINGS, fiveDays));
    expect(ranked).toMatchObject({ scoredDays: 5, score: 100, tier: 'diamond' });
  });

  it('is not excused by a cheat day, while a passable alarm would be', () => {
    const cheatDay = '2026-10-10';
    const events = [prayer('dhuhr'), prayer('asr', { passable: true })];
    // Passable is true on the Asr row but it is a prayer: the cheat day must still not excuse it.
    const missedThatDay = DATES.filter((date) => date !== cheatDay);
    const completions = [...prayed('dhuhr', missedThatDay), ...prayed('asr', missedThatDay)];
    const habit = pooled(computeHabitsReport(events, completions, [cheatDay], SETTINGS, NOW));
    expect(habit.excused).toBe(0);
    expect(habit.missed).toBe(2);
  });

  it('counts the pooled Prayer once in the overall score, beside the other habits', () => {
    const daily: HabitEvent = {
      id: 'dddddddd-0000-4000-8000-000000000001',
      title: 'Read',
      start_at: '2026-10-01T06:00:00.000Z',
      repeat_unit: 'day',
      repeat_interval: 1,
      repeat_weekdays: null,
      ends_at: null,
      active: true,
      passable: true,
      color: null,
      created_at: ENABLED,
    };
    const readCompletions: HabitCompletion[] = DATES.slice(0, 10).map((date) => ({
      event_id: daily.id,
      occurrence_at: `${date}T06:00:00.000Z`,
      status: 'done',
      snoozes_used: 0,
    }));
    const report = computeHabitsReport([daily, ...ALL_PRAYERS], [...allPrayed(DATES), ...readCompletions], [], SETTINGS, NOW);

    expect(report.habits.map((habit) => habit.title).sort()).toEqual(['Prayer', 'Read']);
    const read = report.habits.find((habit) => habit.title === 'Read')!;
    const prayerHabit = pooled(report);
    expect(read.score).not.toBeNull();
    const expected =
      (100 * (read.weightedEarned + prayerHabit.weightedEarned)) / (read.weightedPossible + prayerHabit.weightedPossible);
    expect(report.overallScore).toBeCloseTo(expected, 9);
  });

  it('does not score prayers from before they were switched on', () => {
    const switchedOn = '2026-10-15T00:00:00.000Z';
    const settings: HabitSettings = { ...SETTINGS, prayers_enabled_since: switchedOn };
    // created_at is old (October 1); only the switch-on time keeps the first two weeks out of it.
    const habit = pooled(computeHabitsReport([prayer('dhuhr')], prayed('dhuhr', DATES.slice(-6)), [], settings, NOW));
    expect(habit).toMatchObject({ done: 6, missed: 0, scored: 6, scoredDays: 6 });
  });

  it('has nothing to score while prayers are off', () => {
    const habit = pooled(computeHabitsReport([prayer('dhuhr')], [], [], { ...SETTINGS, prayers_enabled: false }, NOW));
    expect(habit).toMatchObject({ done: 0, missed: 0, pending: 0, score: null, tier: 'unranked' });
  });

  it('has no Prayer habit when there are no prayer events', () => {
    expect(computeHabitsReport([], [], [], SETTINGS, NOW).habits).toEqual([]);
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
    expect(report.habits[0]?.pooled).toBe('prayer');
  });
});

/** Dates from `from` to `to` inclusive, 'yyyy-MM-dd'. */
function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let day = dayNumberFromDateString(from); day <= dayNumberFromDateString(to); day++) {
    dates.push(new Date(day * DAY).toISOString().slice(0, 10));
  }
  return dates;
}

describe('the days of the Prayer habit', () => {
  it('keeps an Isha that an offset pushed past midnight with its own prayer-day', () => {
    // Prayer times are computed for the location (Tunis) but the zone is Tokyo, so Isha with a 60 minute offset
    // falls on the next local date, as does Maghrib.
    const settings: HabitSettings = { ...SETTINGS, timezone: 'Asia/Tokyo', isha_offset_min: 60 };
    const tokyoConfig = resolvePrayerConfig(settings)!;
    const ishaOct10 = prayerTimesOnDay(tokyoConfig, dayNumberFromDateString('2026-10-10')).isha;
    expect(localDateString(ishaOct10, 'Asia/Tokyo')).toBe('2026-10-11');

    const completions: HabitCompletion[] = PRAYER_NAMES.flatMap((name) =>
      DATES.map((date) => ({
        event_id: prayer(name).id,
        occurrence_at: prayerTimesOnDay(tokyoConfig, dayNumberFromDateString(date))[name].toISOString(),
        status: 'done' as const,
        snoozes_used: 0,
      }))
    );
    // 07:00 on Oct 21 in Tokyo: the prayer-day of Oct 20 is over, Oct 21's Fajr has not come.
    const habit = pooled(computeHabitsReport(ALL_PRAYERS, completions, [], settings, new Date('2026-10-20T22:00:00.000Z')));
    // Bucketed by local date every Tokyo day would hold a different mix of prayers and the first would look cut short.
    expect(habit).toMatchObject({ done: 100, missed: 0, scoredDays: 20, currentStreak: 20, bestStreak: 20, score: 100 });
  });

  it('leaves the day pending while a prayer is still inside its late window, then breaks it once the window closes', () => {
    const dhuhr = prayerTimesOnDay(config, dayNumberFromDateString('2026-10-20')).dhuhr;
    const completions = [...allPrayed(DATES.slice(0, 19)), ...prayed('fajr', ['2026-10-20'])];

    // 10 minutes after Dhuhr, grace is 30: not missed yet.
    const inWindow = pooled(
      computeHabitsReport(ALL_PRAYERS, completions, [], SETTINGS, new Date(dhuhr.getTime() + 10 * 60_000))
    );
    expect(inWindow).toMatchObject({ missed: 0, pending: 1, currentStreak: 19, scoredDays: 19 });

    // 40 minutes after: Dhuhr is missed, today is a missed day and the streak is over.
    const closed = pooled(
      computeHabitsReport(ALL_PRAYERS, completions, [], SETTINGS, new Date(dhuhr.getTime() + 40 * 60_000))
    );
    expect(closed).toMatchObject({ missed: 1, currentStreak: 0, bestStreak: 19, scoredDays: 20 });
  });

  it('counts a day of done prayers mixed with paused or excused ones as done, and a day of only those as a neutral day', () => {
    expect(prayerDayOutcome(['done', 'paused', 'done'])).toBe('done');
    expect(prayerDayOutcome(['done', 'excused'])).toBe('done');
    expect(prayerDayOutcome(['paused', 'paused'])).toBe('paused');
    expect(prayerDayOutcome(['excused', 'paused'])).toBe('excused');
    // A miss or a prayer to come still decides the day.
    expect(prayerDayOutcome(['done', 'paused', 'missed'])).toBe('missed');
    expect(prayerDayOutcome(['done', 'paused', 'pending'])).toBe('pending');
  });

  it('leaves the day the prayers were switched on part-way out of the days and the streak, but keeps its prayers in the counts', () => {
    // 14:00 in Tunis on Oct 15: Fajr and Dhuhr of that day are before it.
    const settings: HabitSettings = { ...SETTINGS, prayers_enabled_since: '2026-10-15T13:00:00.000Z' };
    const habit = pooled(computeHabitsReport(ALL_PRAYERS, allPrayed(DATES.slice(-6)), [], settings, NOW));
    // Oct 15 contributes Asr, Maghrib and Isha (3) to the counts; Oct 16 to 20 are five full days.
    expect(habit).toMatchObject({ done: 28, missed: 0, scored: 28, scoredDays: 5, currentStreak: 5, bestStreak: 5 });
  });

  it('leaves the cut-off first day of the window out of the days and the streak, even for a miss on it', () => {
    // No switch-on date and an old created_at: the window itself starts at 13:00 in Tunis on Sep 22, so that day
    // has only Asr, Maghrib and Isha in it.
    const settings: HabitSettings = { ...SETTINGS, prayers_enabled_since: null };
    const events = PRAYER_NAMES.map((name) => prayer(name, { created_at: '2026-08-01T00:00:00.000Z' }));
    const now = new Date('2026-10-20T12:00:00.000Z');
    const dates = datesBetween('2026-09-22', '2026-10-20');
    const completions = allPrayed(dates, [['maghrib', '2026-09-22']]);
    const habit = pooled(computeHabitsReport(events, completions, [], settings, now));

    // The missed Maghrib on the cut-off day is in the counts and the score, not in the days or the streak.
    expect(habit.missed).toBe(1);
    // Sep 23 to Oct 19 are 27 full days; Oct 20 has only Fajr and Dhuhr so far, so it is still open.
    expect(habit).toMatchObject({ scoredDays: 27, currentStreak: 27, bestStreak: 27 });
  });
});
