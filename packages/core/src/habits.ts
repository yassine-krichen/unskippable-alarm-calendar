import { occurrencesBetween } from './recurrence';
import { localDateString } from './time-zone';
import type { CompletionRow, EventRow, Settings } from './types';

// Formula and tiers are fixed in docs/roadmap-v2.md, phase 1. Keep the Kotlin mirror identical.

/** The shortest scoring window: this many days before `now`. */
export const HABIT_WINDOW_DAYS = 28;
/** The longest scoring window, reached by very slow habits. */
export const HABIT_MAX_WINDOW_DAYS = 180;
/** A habit's window is at least this many of its own repeat periods, so slow habits can be ranked. */
export const HABIT_WINDOW_PERIODS = 5;
/** A miss weighs this much in the score's denominator. */
export const HABIT_MISS_WEIGHT = 2;
/** Fewer scored occurrences (done + missed) than this means "Unranked". */
export const HABIT_MIN_SCORED = 5;
/** Credit of a done occurrence never drops below this, however many snoozes it used. */
export const HABIT_MIN_CREDIT = 0.5;
const CREDIT_LOST_PER_SNOOZE = 0.1;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

export type OccurrenceOutcome = 'done' | 'missed' | 'excused' | 'pending';

export type HabitTier = 'unranked' | 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';

export type HabitEvent = Pick<
  EventRow,
  | 'id'
  | 'title'
  | 'start_at'
  | 'repeat_unit'
  | 'repeat_interval'
  | 'repeat_weekdays'
  | 'ends_at'
  | 'active'
  | 'passable'
  | 'color'
  | 'created_at'
>;

export type HabitCompletion = Pick<CompletionRow, 'event_id' | 'occurrence_at' | 'status' | 'snoozes_used'>;

export type HabitSettings = Pick<Settings, 'timezone' | 'grace_minutes'>;

export interface HabitOccurrence {
  /** Scheduled instant of the occurrence. */
  at: Date;
  outcome: OccurrenceOutcome;
  /** Snoozes the completion used; 0 when there is none. */
  snoozesUsed: number;
}

export interface HabitStats {
  eventId: string;
  title: string;
  color: string | null;
  done: number;
  missed: number;
  excused: number;
  pending: number;
  /** done + missed: the occurrences that count towards the score. */
  scored: number;
  /** The scoring window of this habit in days (28 to 180); streaks use it too. */
  windowDays: number;
  /** 0 to 100, or null when the habit is unranked. Not rounded. */
  score: number | null;
  /** Sum of w * credit over scored occurrences: the score's numerator, before the 100. */
  weightedEarned: number;
  /** Sum of w * (done ? 1 : 2): the score's denominator. */
  weightedPossible: number;
  tier: HabitTier;
  /** Run of done occurrences ending at the latest settled one; excused ones keep it alive without adding. */
  currentStreak: number;
  bestStreak: number;
  /** Oldest first, every occurrence in the window up to `now`. */
  occurrences: HabitOccurrence[];
}

export interface HabitsReport {
  /** Recurring, active events only, in the order given. */
  habits: HabitStats[];
  /** Pooled over ranked habits: 100 * sum(earned) / sum(possible); null when none is ranked. */
  overallScore: number | null;
  overallTier: HabitTier;
}

/**
 * Epoch milliseconds of a timestamp string, or NaN. Completions come back from Postgres as
 * '+00:00' with optional microseconds, from the desktop flusher as 'Z', and events may differ
 * again, so occurrences are matched by instant, never by string.
 */
export function instantMs(timestamp: string): number {
  // Postgres text output can use a space and a short offset ('+00'); both are valid ISO once fixed.
  const iso = timestamp
    .replace(' ', 'T')
    .replace(/(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)([+-]\d{2})$/, '$1$2:00');
  return Date.parse(iso);
}

/** Credit of one done occurrence: 1 minus 0.1 per snooze, never below 0.5. */
export function doneCredit(snoozesUsed: number): number {
  return Math.max(HABIT_MIN_CREDIT, 1 - CREDIT_LOST_PER_SNOOZE * Math.max(0, snoozesUsed));
}

/**
 * Recency weight of an occurrence `daysAgo` days before now: 1 now, 0.5 one half-life ago,
 * 0.25 two half-lives ago. The half-life is half the habit's window (14 days for 28).
 */
export function recencyWeight(daysAgo: number, halfLifeDays: number = HABIT_WINDOW_DAYS / 2): number {
  return Math.pow(0.5, daysAgo / halfLifeDays);
}

/**
 * How often the habit nominally repeats, in days: hours / 24, days as is, weeks times 7 divided
 * by the number of chosen weekdays, months times 30, years times 365. Only a yardstick for the window.
 */
export function nominalPeriodDays(
  event: Pick<EventRow, 'repeat_unit' | 'repeat_interval' | 'repeat_weekdays'>
): number {
  const interval = event.repeat_interval;
  switch (event.repeat_unit) {
    case 'hour':
      return interval / 24;
    case 'day':
      return interval;
    case 'week': {
      const weekdays = new Set(event.repeat_weekdays ?? []).size;
      return (interval * 7) / Math.max(1, weekdays);
    }
    case 'month':
      return interval * 30;
    case 'year':
      return interval * 365;
    case 'none':
      return 0;
  }
}

/** max(28 days, 5 repeat periods), capped at 180 days. */
export function habitWindowDays(
  event: Pick<EventRow, 'repeat_unit' | 'repeat_interval' | 'repeat_weekdays'>
): number {
  return Math.min(
    HABIT_MAX_WINDOW_DAYS,
    Math.max(HABIT_WINDOW_DAYS, HABIT_WINDOW_PERIODS * nominalPeriodDays(event))
  );
}

/** Bronze below 40, Silver 40, Gold 60, Platinum 75, Diamond 90 and up; null is Unranked. */
export function tierForScore(score: number | null): HabitTier {
  if (score === null) return 'unranked';
  if (score >= 90) return 'diamond';
  if (score >= 75) return 'platinum';
  if (score >= 60) return 'gold';
  if (score >= 40) return 'silver';
  return 'bronze';
}

/** Whole-number score for display. Floors, so a displayed 60 is never a 59.6 sitting in Silver. */
export function displayScore(score: number): number {
  return Math.floor(score);
}

/** A habit is a recurring event; one-off events are not scored. */
export function isHabit(event: Pick<EventRow, 'repeat_unit' | 'active'>): boolean {
  return event.active && event.repeat_unit !== 'none';
}

export function completionKey(eventId: string, occurrenceMs: number): string {
  return `${eventId}|${occurrenceMs}`;
}

/**
 * Indexes completions by event and occurrence instant. A 'done' row beats a 'skipped_cheat' row
 * for the same occurrence, so a double write can never turn a done into an excuse.
 */
export function indexCompletions(
  completions: readonly HabitCompletion[]
): Map<string, HabitCompletion> {
  const index = new Map<string, HabitCompletion>();
  for (const completion of completions) {
    const ms = instantMs(completion.occurrence_at);
    if (Number.isNaN(ms)) continue;
    const key = completionKey(completion.event_id, ms);
    const existing = index.get(key);
    if (existing === undefined || (existing.status !== 'done' && completion.status === 'done')) {
      index.set(key, completion);
    }
  }
  return index;
}

export interface ClassifyInput {
  passable: boolean;
  at: Date;
  now: Date;
  completion: Pick<HabitCompletion, 'status'> | undefined;
  cheatDays: ReadonlySet<string>;
  timezone: string;
  graceMinutes: number;
}

/**
 * Outcome of one occurrence. A done completion always wins. Then a cheat day (local date in the
 * settings zone) or a skipped_cheat completion excuses it, but only for a passable event, since a
 * non-passable alarm rings through cheat days. Otherwise it is
 * pending until now is more than grace_minutes past it (exactly grace_minutes is still pending,
 * like shouldRingMissedOccurrence), then missed.
 */
export function classifyOccurrence(input: ClassifyInput): OccurrenceOutcome {
  if (input.completion?.status === 'done') return 'done';
  if (input.passable) {
    if (input.completion?.status === 'skipped_cheat') return 'excused';
    if (input.cheatDays.has(localDateString(input.at, input.timezone))) return 'excused';
  }
  const lateMs = input.now.getTime() - input.at.getTime();
  return lateMs > input.graceMinutes * MS_PER_MINUTE ? 'missed' : 'pending';
}

/**
 * Longest and trailing runs of done occurrences. Pending ones are skipped and excused ones keep
 * a run alive without lengthening it, so cheat days cannot inflate a streak; a miss resets it.
 */
function streaks(outcomes: readonly OccurrenceOutcome[]): { current: number; best: number } {
  let run = 0;
  let best = 0;
  for (const outcome of outcomes) {
    if (outcome === 'missed') run = 0;
    else if (outcome === 'done') run += 1;
    best = Math.max(best, run);
  }
  return { current: run, best };
}

/**
 * Stats of one recurring event over its window (28 days or more, see habitWindowDays) up to `now`,
 * but never before the event was created: occurrences earlier than created_at are not scored.
 * score = 100 * sum(w * credit) / sum(w * (done ? 1 : 2)), over done and missed occurrences only.
 */
export function computeHabitStats(
  event: HabitEvent,
  completions: ReadonlyMap<string, HabitCompletion>,
  cheatDays: ReadonlySet<string>,
  settings: HabitSettings,
  now: Date
): HabitStats {
  const windowDays = habitWindowDays(event);
  const windowStartMs = now.getTime() - windowDays * MS_PER_DAY;
  const createdMs = event.created_at === undefined ? Number.NaN : instantMs(event.created_at);
  const from = new Date(Number.isNaN(createdMs) ? windowStartMs : Math.max(windowStartMs, createdMs));
  // occurrencesBetween is half-open; +1 ms makes an occurrence exactly at `now` count.
  const instants = occurrencesBetween(
    event,
    from,
    new Date(now.getTime() + 1),
    settings.timezone
  );

  const counts = { done: 0, missed: 0, excused: 0, pending: 0 };
  const occurrences: HabitOccurrence[] = [];
  let earned = 0;
  let possible = 0;

  for (const at of instants) {
    const completion = completions.get(completionKey(event.id, at.getTime()));
    const outcome = classifyOccurrence({
      passable: event.passable,
      at,
      now,
      completion,
      cheatDays,
      timezone: settings.timezone,
      graceMinutes: settings.grace_minutes,
    });
    const snoozesUsed = outcome === 'done' ? (completion?.snoozes_used ?? 0) : 0;
    counts[outcome] += 1;
    occurrences.push({ at, outcome, snoozesUsed });

    const weight = recencyWeight((now.getTime() - at.getTime()) / MS_PER_DAY, windowDays / 2);
    if (outcome === 'done') {
      earned += weight * doneCredit(snoozesUsed);
      possible += weight;
    } else if (outcome === 'missed') {
      possible += weight * HABIT_MISS_WEIGHT;
    }
  }

  const scored = counts.done + counts.missed;
  const score = scored >= HABIT_MIN_SCORED ? (100 * earned) / possible : null;
  const run = streaks(occurrences.map((occurrence) => occurrence.outcome));

  return {
    eventId: event.id,
    title: event.title,
    color: event.color,
    ...counts,
    scored,
    windowDays,
    score,
    weightedEarned: earned,
    weightedPossible: possible,
    tier: tierForScore(score),
    currentStreak: run.current,
    bestStreak: run.best,
    occurrences,
  };
}

/**
 * Stats for every recurring active event, plus the overall score pooled over the ranked habits:
 * 100 * sum(earned) / sum(possible), each habit using its own per-occurrence weights, so a
 * habit with more recent scored occurrences counts for more. Unranked habits do not enter it.
 */
export function computeHabitsReport(
  events: readonly HabitEvent[],
  completions: readonly HabitCompletion[],
  cheatDays: readonly string[],
  settings: HabitSettings,
  now: Date
): HabitsReport {
  const index = indexCompletions(completions);
  const cheatDaySet = new Set(cheatDays);
  const habits = events
    .filter(isHabit)
    .map((event) => computeHabitStats(event, index, cheatDaySet, settings, now));

  let earned = 0;
  let possible = 0;
  for (const habit of habits) {
    if (habit.score === null) continue;
    earned += habit.weightedEarned;
    possible += habit.weightedPossible;
  }
  const overallScore = possible > 0 ? (100 * earned) / possible : null;
  return { habits, overallScore, overallTier: tierForScore(overallScore) };
}
