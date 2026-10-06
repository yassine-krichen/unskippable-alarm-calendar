import { describe, expect, it } from 'vitest';

import vectorFile from '../test-vectors/habits.json';
import {
  classifyOccurrence,
  computeHabitsReport,
  displayScore,
  doneCredit,
  habitWindowDays,
  indexCompletions,
  instantMs,
  isHabit,
  nominalPeriodDays,
  recencyWeight,
  tierForScore,
} from './habits';
import type { HabitCompletion, HabitEvent, HabitSettings, HabitTier, OccurrenceOutcome } from './habits';

interface ExpectedHabit {
  event_id: string;
  window_days: number;
  done: number;
  missed: number;
  excused: number;
  pending: number;
  score: number | null;
  tier: HabitTier;
  current_streak: number;
  best_streak: number;
  outcomes: OccurrenceOutcome[];
}

interface Vector {
  name: string;
  now: string;
  settings: HabitSettings;
  cheat_days: string[];
  events: HabitEvent[];
  completions: HabitCompletion[];
  expected: { habits: ExpectedHabit[]; overall_score: number | null; overall_tier: HabitTier };
}

const file = vectorFile as unknown as {
  windows: {
    repeat_unit: HabitEvent['repeat_unit'];
    repeat_interval: number;
    repeat_weekdays: number[] | null;
    nominal_period_days: number;
    window_days: number;
  }[];
  tiers: { score: number | null; tier: HabitTier }[];
  weights: { days_ago: number; weight: number }[];
  credits: { snoozes: number; credit: number }[];
  vectors: Vector[];
};

const PRECISION = 6;

describe('shared habit vectors', () => {
  for (const vector of file.vectors) {
    it(vector.name, () => {
      const report = computeHabitsReport(
        vector.events,
        vector.completions,
        vector.cheat_days,
        vector.settings,
        new Date(vector.now)
      );

      expect(report.habits.map((habit) => habit.eventId)).toEqual(
        vector.expected.habits.map((habit) => habit.event_id)
      );
      vector.expected.habits.forEach((expected, i) => {
        const habit = report.habits[i];
        if (habit === undefined) throw new Error('missing habit');
        expect(habit.occurrences.map((occurrence) => occurrence.outcome)).toEqual(expected.outcomes);
        expect({
          windowDays: habit.windowDays,
          done: habit.done,
          missed: habit.missed,
          excused: habit.excused,
          pending: habit.pending,
          tier: habit.tier,
          currentStreak: habit.currentStreak,
          bestStreak: habit.bestStreak,
        }).toEqual({
          windowDays: expected.window_days,
          done: expected.done,
          missed: expected.missed,
          excused: expected.excused,
          pending: expected.pending,
          tier: expected.tier,
          currentStreak: expected.current_streak,
          bestStreak: expected.best_streak,
        });
        if (expected.score === null) expect(habit.score).toBeNull();
        else expect(habit.score).toBeCloseTo(expected.score, PRECISION);
      });

      expect(report.overallTier).toBe(vector.expected.overall_tier);
      if (vector.expected.overall_score === null) expect(report.overallScore).toBeNull();
      else expect(report.overallScore).toBeCloseTo(vector.expected.overall_score, PRECISION);
    });
  }

  for (const row of file.windows) {
    const name = `${row.repeat_unit} x${row.repeat_interval} ${JSON.stringify(row.repeat_weekdays)}`;
    it(`window of ${name} is ${row.window_days} days (period ${row.nominal_period_days})`, () => {
      expect(nominalPeriodDays(row)).toBeCloseTo(row.nominal_period_days, 8);
      expect(habitWindowDays(row)).toBeCloseTo(row.window_days, 8);
    });
  }

  for (const row of file.tiers) {
    it(`tier of ${row.score === null ? 'no score' : row.score} is ${row.tier}`, () => {
      expect(tierForScore(row.score)).toBe(row.tier);
    });
  }

  for (const row of file.weights) {
    it(`recency weight ${row.days_ago} days ago is ${row.weight}`, () => {
      expect(recencyWeight(row.days_ago)).toBeCloseTo(row.weight, 8);
    });
  }

  for (const row of file.credits) {
    it(`credit after ${row.snoozes} snoozes is ${row.credit}`, () => {
      expect(doneCredit(row.snoozes)).toBeCloseTo(row.credit, 10);
    });
  }
});

describe('recencyWeight', () => {
  it('halves every half-life, which is half the habit window', () => {
    expect(recencyWeight(17.5, 17.5)).toBeCloseTo(0.5, 10);
    expect(recencyWeight(150, 75)).toBeCloseTo(0.25, 10);
  });
});

describe('instantMs', () => {
  it('reads Z, +00:00, microsecond and short-offset forms as the same instant', () => {
    const expected = Date.parse('2026-03-28T07:00:00Z');
    for (const text of [
      '2026-03-28T07:00:00Z',
      '2026-03-28T07:00:00+00:00',
      '2026-03-28T07:00:00.000000+00:00',
      '2026-03-28 07:00:00+00',
      '2026-03-28T09:00:00+02:00',
    ]) {
      expect(instantMs(text)).toBe(expected);
    }
  });

  it('returns NaN for garbage', () => {
    expect(instantMs('not a date')).toBeNaN();
  });
});

describe('classifyOccurrence', () => {
  const base = {
    passable: true,
    at: new Date('2026-03-10T08:00:00Z'),
    completion: undefined,
    cheatDays: new Set<string>(),
    timezone: 'UTC',
    graceMinutes: 30,
  };

  it('is pending before the occurrence is due', () => {
    expect(classifyOccurrence({ ...base, now: new Date('2026-03-10T07:00:00Z') })).toBe('pending');
  });

  it('lets a done completion win over a cheat day', () => {
    expect(
      classifyOccurrence({
        ...base,
        now: new Date('2026-03-10T12:00:00Z'),
        completion: { status: 'done' },
        cheatDays: new Set(['2026-03-10']),
      })
    ).toBe('done');
  });

  it('treats a skipped_cheat completion as excused for a passable event', () => {
    expect(
      classifyOccurrence({ ...base, now: new Date('2026-03-10T12:00:00Z'), completion: { status: 'skipped_cheat' } })
    ).toBe('excused');
  });

  it('does not excuse a non-passable event by a skipped_cheat completion', () => {
    expect(
      classifyOccurrence({
        ...base,
        passable: false,
        now: new Date('2026-03-10T12:00:00Z'),
        completion: { status: 'skipped_cheat' },
      })
    ).toBe('missed');
  });
});

describe('indexCompletions', () => {
  it('keeps the done row when a skipped_cheat row exists for the same occurrence', () => {
    const rows: HabitCompletion[] = [
      { event_id: 'e', occurrence_at: '2026-03-10T08:00:00Z', status: 'skipped_cheat', snoozes_used: 0 },
      { event_id: 'e', occurrence_at: '2026-03-10T08:00:00+00:00', status: 'done', snoozes_used: 1 },
    ];
    const index = indexCompletions(rows);
    expect(index.size).toBe(1);
    expect([...index.values()][0]?.status).toBe('done');
  });
});

describe('isHabit', () => {
  it('is true only for active recurring events', () => {
    expect(isHabit({ repeat_unit: 'none', active: true })).toBe(false);
    expect(isHabit({ repeat_unit: 'day', active: false })).toBe(false);
    expect(isHabit({ repeat_unit: 'hour', active: true })).toBe(true);
  });
});

describe('displayScore', () => {
  it('floors, so the shown number never crosses a tier boundary the tier did not', () => {
    expect(displayScore(59.9)).toBe(59);
    expect(tierForScore(59.9)).toBe('silver');
    expect(displayScore(100)).toBe(100);
  });
});
