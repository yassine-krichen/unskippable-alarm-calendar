import { describe, expect, it } from 'vitest';

import vectorFile from '../test-vectors/habits.json';
import {
  PRAYER_HABIT_ID,
  computeHabitsReport,
  prayerCredit,
  prayerDayOutcome,
  prayerLog,
  prayerTimingOf,
  type HabitCompletion,
  type HabitEvent,
  type HabitSettings,
  type HabitStats,
  type PrayerTiming,
} from './habits';
import { DEFAULT_PRAYER_SETTINGS, PRAYER_NAMES, prayerTimesOnDay, prayerWindowEnd, resolvePrayerConfig } from './prayer-times';
import { dayNumberFromDateString } from './time-zone';
import type { PrayerName } from './types';

const MINUTE = 60_000;
const DAY = 86_400_000;

interface PrayerVector {
  now: string;
  settings: HabitSettings;
  events: HabitEvent[];
  credits: Array<{ timing: PrayerTiming; credit: number }>;
  timing_boundaries: Array<{ relative_to: 'at' | 'window_end'; seconds: number; timing: PrayerTiming }>;
  days: Array<{
    date: string;
    prayers: Array<{ prayer: PrayerName; at: string; window_end: string; result: string; done_at: string | null }>;
  }>;
  expected: {
    score: number;
    tier: string;
    done: number;
    missed: number;
    scored_days: number;
    current_streak: number;
    best_streak: number;
    timings: { on_time: number; late: number; qada: number; open_qada: number };
  };
}

const vector = (vectorFile as unknown as { prayer: PrayerVector }).prayer;

function pooled(report: ReturnType<typeof computeHabitsReport>): HabitStats {
  const habit = report.habits.find((candidate) => candidate.pooled === 'prayer');
  if (habit === undefined) throw new Error('no pooled prayer habit in the report');
  return habit;
}

describe('the shared prayer vector', () => {
  const completions: HabitCompletion[] = vector.days.flatMap((day) =>
    day.prayers.flatMap((prayer) =>
      prayer.done_at === null
        ? []
        : [
            {
              event_id: `prayer-${prayer.prayer}`,
              occurrence_at: prayer.at,
              status: 'done' as const,
              snoozes_used: 0,
              done_at: prayer.done_at,
            },
          ]
    )
  );
  const report = computeHabitsReport(vector.events, completions, [], vector.settings, new Date(vector.now));
  const habit = pooled(report);

  it('has the prayer times and windows the app computes', () => {
    const config = resolvePrayerConfig(vector.settings)!;
    for (const day of vector.days) {
      const times = prayerTimesOnDay(config, dayNumberFromDateString(day.date));
      for (const prayer of day.prayers) {
        expect(prayer.at, `${day.date} ${prayer.prayer}`).toBe(times[prayer.prayer].toISOString());
        expect(prayerWindowEnd(config, prayer.prayer, times[prayer.prayer], vector.settings.timezone)?.toISOString()).toBe(
          prayer.window_end
        );
      }
    }
  });

  it('scores the days the way the formula says', () => {
    expect(habit.score).toBeCloseTo(vector.expected.score, 6);
    expect(habit.tier).toBe(vector.expected.tier);
    expect(habit).toMatchObject({
      done: vector.expected.done,
      missed: vector.expected.missed,
      scoredDays: vector.expected.scored_days,
      currentStreak: vector.expected.current_streak,
      bestStreak: vector.expected.best_streak,
    });
  });

  it('counts the timings', () => {
    expect(habit.prayerTimings).toEqual({
      onTime: vector.expected.timings.on_time,
      late: vector.expected.timings.late,
      qada: vector.expected.timings.qada,
      openQada: vector.expected.timings.open_qada,
    });
  });

  it('tells each prayer its timing', () => {
    const wanted = vector.days.flatMap((day) => day.prayers.map((prayer) => prayer.result));
    const got = habit.occurrences.map((occurrence) => occurrence.timing ?? 'missed');
    expect(got).toEqual(wanted);
  });

  for (const row of vector.credits) {
    it(`gives ${row.timing} a credit of ${row.credit}`, () => {
      expect(prayerCredit(row.timing)).toBe(row.credit);
    });
  }

  for (const row of vector.timing_boundaries) {
    it(`calls a prayer done ${row.seconds} s from ${row.relative_to} ${row.timing}`, () => {
      const prayer = vector.days[0]!.prayers[1]!;
      const base = Date.parse(row.relative_to === 'at' ? prayer.at : prayer.window_end);
      const doneAt = new Date(base + row.seconds * 1000).toISOString();
      expect(prayerTimingOf(new Date(prayer.at), new Date(prayer.window_end), doneAt)).toBe(row.timing);
    });
  }
});

describe('prayerTimingOf', () => {
  const at = new Date('2026-10-06T11:07:00.000Z');
  const end = new Date('2026-10-06T14:00:00.000Z');

  it('takes a completion without done_at, or with an unreadable one, as on time', () => {
    expect(prayerTimingOf(at, end, undefined)).toBe('on_time');
    expect(prayerTimingOf(at, end, 'not a date')).toBe('on_time');
  });

  it('is on time at 15:00 and late at 15:01', () => {
    expect(prayerTimingOf(at, end, new Date(at.getTime() + 15 * MINUTE).toISOString())).toBe('on_time');
    expect(prayerTimingOf(at, end, new Date(at.getTime() + 15 * MINUTE + 1000).toISOString())).toBe('late');
  });

  it('allows two minutes after the window end before it is a qada', () => {
    expect(prayerTimingOf(at, end, new Date(end.getTime() + 2 * MINUTE).toISOString())).toBe('late');
    expect(prayerTimingOf(at, end, new Date(end.getTime() + 2 * MINUTE + 1000).toISOString())).toBe('qada');
  });
});

describe('prayerDayOutcome with a made-up prayer', () => {
  it('is neutral for a day whose only shortfall is a qada', () => {
    expect(prayerDayOutcome(['done', 'qada', 'done'])).toBe('excused');
    expect(prayerDayOutcome(['qada'])).toBe('excused');
  });

  it('still lets a miss or a pending prayer decide the day', () => {
    expect(prayerDayOutcome(['qada', 'missed'])).toBe('missed');
    expect(prayerDayOutcome(['qada', 'pending'])).toBe('pending');
  });
});

describe('worked examples over 20 days of five prayers', () => {
  const ENABLED = '2026-10-01T00:00:00.000Z';
  const NOW = new Date('2026-10-21T02:00:00.000Z');
  const SETTINGS: HabitSettings = {
    timezone: 'Africa/Tunis',
    grace_minutes: 30,
    ...DEFAULT_PRAYER_SETTINGS,
    prayers_enabled: true,
    prayers_enabled_since: ENABLED,
  };
  const config = resolvePrayerConfig(SETTINGS)!;
  const DATES = Array.from({ length: 20 }, (_, i) => new Date(Date.UTC(2026, 9, 1) + i * DAY).toISOString().slice(0, 10));
  const EVENTS: HabitEvent[] = PRAYER_NAMES.map((name) => ({
    id: `0000000a-0000-4000-8000-00000000000${PRAYER_NAMES.indexOf(name)}`,
    title: name,
    start_at: ENABLED,
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
  }));
  const eventOf = (name: PrayerName): HabitEvent => EVENTS[PRAYER_NAMES.indexOf(name)]!;

  /** What a day looks like for one prayer: on time, late, qada or never prayed. */
  type Result = PrayerTiming | 'missed';

  function completionFor(name: PrayerName, date: string, result: Result): HabitCompletion[] {
    if (result === 'missed') return [];
    const at = prayerTimesOnDay(config, dayNumberFromDateString(date))[name];
    const end = prayerWindowEnd(config, name, at, SETTINGS.timezone)!;
    const doneAt =
      result === 'on_time'
        ? new Date(at.getTime() + 5 * MINUTE)
        : result === 'late'
          ? new Date(at.getTime() + 30 * MINUTE)
          : new Date(end.getTime() + 10 * MINUTE);
    return [
      { event_id: eventOf(name).id, occurrence_at: at.toISOString(), status: 'done', snoozes_used: 0, done_at: doneAt.toISOString() },
    ];
  }

  /** Every prayer on time, except `special` on the dates `when` says. */
  function run(special: Result, when: (date: string, index: number) => boolean = () => true, which: PrayerName = 'dhuhr'): HabitStats {
    const completions = DATES.flatMap((date, index) =>
      PRAYER_NAMES.flatMap((name) => completionFor(name, date, name === which && when(date, index) ? special : 'on_time'))
    );
    return pooled(computeHabitsReport(EVENTS, completions, [], SETTINGS, NOW));
  }

  it('scores 100 when everything is on time', () => {
    expect(run('on_time')).toMatchObject({ score: 100, tier: 'diamond', currentStreak: 20 });
  });

  it('scores 96 with one late prayer a day', () => {
    expect(run('late').score).toBeCloseTo(96, 0);
    expect(run('late')).toMatchObject({ tier: 'diamond', currentStreak: 20 });
  });

  it('scores 90 with one qada a day, and the streak does not grow', () => {
    const habit = run('qada');
    expect(habit.score).toBeCloseTo(90, 0);
    expect(habit.tier).toBe('diamond');
    expect(habit).toMatchObject({ currentStreak: 0, bestStreak: 0, scoredDays: 20 });
  });

  it('scores about 67 with one unmade prayer a day', () => {
    const habit = run('missed');
    expect(habit.score).toBeCloseTo((100 * 4) / 6, 0);
    expect(habit.tier).toBe('gold');
    expect(habit).toMatchObject({ missed: 20, currentStreak: 0 });
  });

  it('ignores the snoozes of a prayer', () => {
    const completions = DATES.flatMap((date) =>
      PRAYER_NAMES.flatMap((name) => completionFor(name, date, 'on_time').map((row) => ({ ...row, snoozes_used: 5 })))
    );
    expect(pooled(computeHabitsReport(EVENTS, completions, [], SETTINGS, NOW)).score).toBe(100);
  });

  it('keeps the streak alive through a qada day, but a miss ends it', () => {
    const qadaDay = DATES[13]!;
    const withQada = run('qada', (date) => date === qadaDay);
    // Days 1 to 13 and 15 to 20 add, the qada day does not reset.
    expect(withQada).toMatchObject({ currentStreak: 19, bestStreak: 19 });
    const withMiss = run('missed', (date) => date === qadaDay);
    expect(withMiss).toMatchObject({ currentStreak: 6, bestStreak: 13 });
  });

  it('lets a prayer made up later repair the streak the miss had broken', () => {
    // The same miss, once with no completion and once made up a day later (done_at after the window).
    const broken = run('missed', (date) => date === DATES[13]);
    const repaired = run('qada', (date) => date === DATES[13]);
    expect(broken.currentStreak).toBe(6);
    expect(repaired.currentStreak).toBe(19);
  });

  it('leaves a prayer pending until its window ends, not after the grace window', () => {
    const times = prayerTimesOnDay(config, dayNumberFromDateString('2026-10-20'));
    const completions = [
      ...DATES.slice(0, 19).flatMap((date) => PRAYER_NAMES.flatMap((name) => completionFor(name, date, 'on_time'))),
      ...completionFor('fajr', '2026-10-20', 'on_time'),
    ];
    const at = (ms: number): HabitStats =>
      pooled(computeHabitsReport(EVENTS, completions, [], SETTINGS, new Date(ms)));
    // 2 hours after Dhuhr: well past the grace window, still inside Dhuhr's window.
    expect(at(times.dhuhr.getTime() + 120 * MINUTE)).toMatchObject({ pending: 1, missed: 0 });
    // A minute after Asr starts, Dhuhr's window is behind it.
    expect(at(times.asr.getTime() + MINUTE)).toMatchObject({ pending: 1, missed: 1 });
  });
});

describe('prayerLog', () => {
  const ENABLED = '2026-10-01T00:00:00.000Z';
  const SETTINGS: HabitSettings = {
    timezone: 'Africa/Tunis',
    grace_minutes: 30,
    ...DEFAULT_PRAYER_SETTINGS,
    prayers_enabled: true,
    prayers_enabled_since: ENABLED,
  };
  const config = resolvePrayerConfig(SETTINGS)!;
  const events: HabitEvent[] = PRAYER_NAMES.map((name) => ({
    id: `prayer-${name}`,
    title: name,
    start_at: ENABLED,
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
  }));
  const times = prayerTimesOnDay(config, dayNumberFromDateString('2026-10-20'));
  const row = (name: PrayerName, doneAt: Date): HabitCompletion => ({
    event_id: `prayer-${name}`,
    occurrence_at: times[name].toISOString(),
    status: 'done',
    snoozes_used: 0,
    done_at: doneAt.toISOString(),
  });
  const from = Date.parse('2026-10-20T00:00:00.000Z');
  // 21:30 in Tunis: Isha is still inside its window.
  const now = new Date('2026-10-20T20:30:00.000Z');

  it('names the tier of every prayer of the day, oldest first', () => {
    const asrEnd = prayerWindowEnd(config, 'asr', times.asr, SETTINGS.timezone)!;
    const log = prayerLog(
      events,
      [
        row('fajr', new Date(times.fajr.getTime() + 5 * MINUTE)),
        // Dhuhr is never prayed.
        row('asr', new Date(times.asr.getTime() + 40 * MINUTE)),
        row('maghrib', new Date(asrEnd.getTime() + 3 * 60 * MINUTE)),
      ],
      SETTINGS,
      now,
      from
    );
    expect(log.map((entry) => [entry.prayer, entry.tier])).toEqual([
      ['fajr', 'on_time'],
      ['dhuhr', 'missed'],
      ['asr', 'late'],
      ['maghrib', 'qada'],
      ['isha', 'pending'],
    ]);
    expect(log[1]!.windowEnd?.toISOString()).toBe(times.asr.toISOString());
  });

  it('names the prayer-day, which is the evening for an Isha pushed past local midnight', () => {
    // Ariana's Isha is 23:16 in India; an hour's offset puts it at 00:16 the next clock date.
    const india: HabitSettings = { ...SETTINGS, timezone: 'Asia/Kolkata', isha_offset_min: 60 };
    const indiaConfig = resolvePrayerConfig(india)!;
    const isha = prayerTimesOnDay(indiaConfig, dayNumberFromDateString('2026-10-20')).isha;
    const log = prayerLog(events, [], india, new Date('2026-10-21T20:00:00.000Z'), Date.parse('2026-10-20T00:00:00.000Z'));
    const entry = log.find((candidate) => candidate.prayer === 'isha' && candidate.at.getTime() === isha.getTime())!;
    expect(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(isha)).toBe('2026-10-21');
    expect(entry.day).toBe('2026-10-20');
    expect(log.filter((candidate) => candidate.day === '2026-10-20').map((candidate) => candidate.prayer)).toEqual(
      expect.arrayContaining(['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'])
    );
  });

  it('starts no earlier than prayers were switched on', () => {
    const settings: HabitSettings = { ...SETTINGS, prayers_enabled_since: times.asr.toISOString() };
    const log = prayerLog(events, [], settings, now, from);
    expect(log.map((entry) => entry.prayer)).toEqual(['asr', 'maghrib', 'isha']);
  });

  it('is empty while prayers are off', () => {
    expect(prayerLog(events, [], { ...SETTINGS, prayers_enabled: false }, now, from)).toEqual([]);
  });

  it('uses the earliest done_at when one prayer-day has two done rows, whatever order they come in', () => {
    // An offset change leaves one prayer-day with two instants: one done on time, one (the moved alarm) made up late.
    const onTime = row('dhuhr', new Date(times.dhuhr.getTime() + 5 * MINUTE));
    const moved: HabitCompletion = {
      ...row('dhuhr', new Date(times.asr.getTime() + 3 * 60 * MINUTE)),
      occurrence_at: new Date(times.dhuhr.getTime() + 2 * MINUTE).toISOString(),
    };
    for (const rows of [[onTime, moved], [moved, onTime]]) {
      const log = prayerLog(events, rows, SETTINGS, now, from);
      expect(log.find((entry) => entry.prayer === 'dhuhr')?.tier).toBe('on_time');
    }
    // The earlier done_at wins even when it belongs to the later instant: late beats qada in both orders.
    const late = { ...moved, done_at: new Date(times.dhuhr.getTime() + 40 * MINUTE).toISOString() };
    const qada = row('dhuhr', new Date(times.asr.getTime() + 3 * 60 * MINUTE));
    for (const rows of [[late, qada], [qada, late]]) {
      expect(prayerLog(events, rows, SETTINGS, now, from).find((entry) => entry.prayer === 'dhuhr')?.tier).toBe('late');
    }
  });

  it('reports the same missed count as the score and carries the pooled timings', () => {
    const report = computeHabitsReport(events, [], [], SETTINGS, now);
    const log = prayerLog(events, [], SETTINGS, now, now.getTime() - 28 * DAY);
    const habit = pooled(report);
    expect(log.filter((entry) => entry.tier === 'missed')).toHaveLength(habit.missed);
    expect(habit.prayerTimings?.openQada).toBe(habit.missed);
    expect(habit.eventId).toBe(PRAYER_HABIT_ID);
  });
});
