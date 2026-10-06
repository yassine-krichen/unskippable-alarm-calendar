import {
  HABIT_MIN_SCORED,
  HABIT_WINDOW_DAYS,
  habitWindowDays,
  isHabit,
  type EventRow,
  type HabitStats,
} from '@alarm-calendar/core';

import type { LongWindowHabit } from './habits-api';

/**
 * Ranked habits first, best score at the top; unranked ones after, those closest to a rank
 * first. Ties fall back to the title so the order never shuffles between renders.
 */
export function sortHabits(habits: readonly HabitStats[]): HabitStats[] {
  return [...habits].sort((a, b) => {
    if ((a.score === null) !== (b.score === null)) return a.score === null ? 1 : -1;
    if (a.score !== null && b.score !== null && a.score !== b.score) return b.score - a.score;
    if (a.score === null && a.scored !== b.scored) return b.scored - a.scored;
    return a.title.localeCompare(b.title);
  });
}

/** "3 of 5 scored" for a habit that is still unranked. */
export function unrankedProgress(habit: Pick<HabitStats, 'scored'>): string {
  return `${Math.min(habit.scored, HABIT_MIN_SCORED)} of ${HABIT_MIN_SCORED} scored`;
}

/** The habit's window in whole weeks: 4 for the 28-day default, about 26 for the 180-day cap. */
export function windowWeeks(windowDays: number): number {
  return Math.round(windowDays / 7);
}

/** "4 weeks", "1 week". */
export function weeksLabel(windowDays: number): string {
  const weeks = windowWeeks(windowDays);
  return `${weeks} ${weeks === 1 ? 'week' : 'weeks'}`;
}

/** Active habits whose window reaches past the 28 days every habit is loaded for. */
export function longWindowHabits(events: readonly EventRow[]): LongWindowHabit[] {
  return events
    .filter(isHabit)
    .map((event) => ({ id: event.id, windowDays: habitWindowDays(event) }))
    .filter((habit) => habit.windowDays > HABIT_WINDOW_DAYS);
}

/** Changes whenever the set of long-window habits, or one's window, changes. */
export function historySignature(habits: readonly LongWindowHabit[]): string {
  return habits
    .map((habit) => `${habit.id}:${habit.windowDays}`)
    .sort()
    .join(',');
}

/**
 * Whether the loaded history reaches back far enough to score a habit with this window. Every
 * habit is covered up to 28 days by the bulk read; a longer window needs the extended read to
 * have run for that event with at least that window.
 */
export function isHistoryCovered(
  habit: { id: string; windowDays: number },
  coverage: Readonly<Record<string, number>>
): boolean {
  return habit.windowDays <= HABIT_WINDOW_DAYS || (coverage[habit.id] ?? 0) >= habit.windowDays;
}

/** Splits habit events into those the loaded history covers (scorable) and those it does not. */
export function partitionByCoverage<T extends Pick<EventRow, 'id' | 'repeat_unit' | 'repeat_interval' | 'repeat_weekdays'>>(
  habits: readonly T[],
  coverage: Readonly<Record<string, number>>
): { covered: T[]; pending: T[] } {
  const covered: T[] = [];
  const pending: T[] = [];
  for (const habit of habits) {
    const target = isHistoryCovered({ id: habit.id, windowDays: habitWindowDays(habit) }, coverage) ? covered : pending;
    target.push(habit);
  }
  return { covered, pending };
}
