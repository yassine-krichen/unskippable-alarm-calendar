import {
  eventKindOf,
  eventOccurrencesBetween,
  isEventPassable,
  prayerDayKey,
  type OccurrenceSettings,
} from './occurrences';
import { instantMs } from './instant';
import { prayerDayOf, resolvePrayerConfig } from './prayer-times';
import {
  MAX_SHIFT_MS,
  applyModesToInstants,
  buildModeTimeline,
  type ModeTimeline,
  type ModeTimelineSettings,
} from './modes';
import { nominalPeriodDays } from './period';
import { dayNumberFromDateString, localDateString } from './time-zone';
import type { CompletionRow, EventRow, ModeConfig, Settings } from './types';

export { instantMs, nominalPeriodDays };

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

/**
 * 'paused' is an occurrence a mode skipped (roadmap v2, phase 5): it never rang and is left out of the score
 * and the counts that matter, exactly like 'excused'. A completion still wins over it (done anyway is done).
 */
export type OccurrenceOutcome = 'done' | 'missed' | 'excused' | 'paused' | 'pending';

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
  | 'kind'
  | 'prayer'
  | 'group_id'
>;

export type HabitCompletion = Pick<CompletionRow, 'event_id' | 'occurrence_at' | 'status' | 'snoozes_used'>;

/** The zone and grace window, plus the prayer fields (a prayer is scored from its times in them). */
export type HabitSettings = Pick<Settings, 'timezone' | 'grace_minutes'> & OccurrenceSettings & ModeTimelineSettings;

export interface HabitOccurrence {
  /** Scheduled instant of the occurrence. */
  at: Date;
  outcome: OccurrenceOutcome;
  /** Snoozes the completion used; 0 when there is none. */
  snoozesUsed: number;
}

/** The id of the one pooled "Prayer" habit in a report: it stands for all five prayer events. */
export const PRAYER_HABIT_ID = 'prayer';

export interface HabitStats {
  /** The event's id, or PRAYER_HABIT_ID for the pooled prayer habit. */
  eventId: string;
  title: string;
  color: string | null;
  done: number;
  missed: number;
  excused: number;
  /** Skipped by a mode: left out of the score like an excused one. */
  paused: number;
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
  /** 'prayer' for the habit that pools the five prayers (see pooledPrayerHabit); absent for an ordinary one. */
  pooled?: 'prayer';
  /**
   * Pooled prayer habit only: how many prayer-days were scored (a day with a done or missed prayer). It is what
   * the rank needs HABIT_MIN_SCORED of, so a single day of five prayers does not rank. Streaks count these days.
   */
  scoredDays?: number;
}

export interface HabitsReport {
  /**
   * Recurring, active events in the order given, except that the five prayers are one entry (pooled, last):
   * one "Prayer" habit instead of five.
   */
  habits: HabitStats[];
  /** Pooled over ranked habits: 100 * sum(earned) / sum(possible); null when none is ranked. */
  overallScore: number | null;
  overallTier: HabitTier;
  /**
   * Habits left out because their occurrences could not be computed (malformed prayer settings, such as a
   * location with no prayer times). The rest of the report is unaffected.
   */
  failed: HabitEvent[];
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

/**
 * A habit is a recurring event; one-off events are not scored. Each of the five prayers is scored (Done means
 * prayed) and the report pools them into one "Prayer" habit; the pre-prayer reminders are not, they are only a
 * nudge towards it. Yearly alarms are not habits (a rank needs 5 occurrences, so 5 years) and neither is
 * anything made by the birthday / anniversary template (`group_id`): a missed birthday wish is not a lapse.
 */
export function isHabit(event: Pick<EventRow, 'repeat_unit' | 'active' | 'kind' | 'group_id'>): boolean {
  if (!event.active) return false;
  const kind = eventKindOf(event);
  if (kind === 'prayer') return true;
  if (kind !== 'normal' || event.repeat_unit === 'none' || event.repeat_unit === 'year') return false;
  return event.group_id == null;
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
  /** Whether a cheat day can excuse it; use isEventPassable, which is false for every prayer. */
  passable: boolean;
  at: Date;
  now: Date;
  completion: Pick<HabitCompletion, 'status'> | undefined;
  cheatDays: ReadonlySet<string>;
  timezone: string;
  graceMinutes: number;
  /** A mode skipped it (see applyModesToInstants): it never rang. */
  paused?: boolean;
}

/**
 * Outcome of one occurrence. A done completion always wins. Then a paused one (a mode skipped it) is
 * 'paused', whatever else is true. Then a cheat day (local date in the
 * settings zone) or a skipped_cheat completion excuses it, but only for a passable event, since a
 * non-passable alarm rings through cheat days. Otherwise it is
 * pending until now is more than grace_minutes past it (exactly grace_minutes is still pending,
 * like shouldRingMissedOccurrence), then missed.
 */
export function classifyOccurrence(input: ClassifyInput): OccurrenceOutcome {
  if (input.completion?.status === 'done') return 'done';
  if (input.paused === true) return 'paused';
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

/** The event's completions keyed by prayer-day; a done row beats a skipped one on the same day. */
function completionsByPrayerDay(
  event: HabitEvent,
  completions: ReadonlyMap<string, HabitCompletion>,
  settings: HabitSettings
): Map<string, HabitCompletion> {
  const byDay = new Map<string, HabitCompletion>();
  for (const completion of completions.values()) {
    if (completion.event_id !== event.id) continue;
    const ms = instantMs(completion.occurrence_at);
    if (Number.isNaN(ms)) continue;
    const key = prayerDayKey(event, new Date(ms), settings);
    if (key === null) continue;
    const existing = byDay.get(key);
    if (existing === undefined || (existing.status !== 'done' && completion.status === 'done')) byDay.set(key, completion);
  }
  return byDay;
}

/**
 * The completion of a normal alarm's occurrence: at its own instant, at its original instant if a mode moved it,
 * or at the instant a shift rule of the alarm would put it (ModeTimeline.matchInstants), so a Done pressed at a
 * shifted time still counts once the mode is over. A done row wins over a skipped one.
 */
function completionNear(
  event: HabitEvent,
  completions: ReadonlyMap<string, HabitCompletion>,
  atMs: number,
  originalMs: number,
  timeline: ModeTimeline
): HabitCompletion | undefined {
  const instants = new Set([...timeline.matchInstants(event, atMs), originalMs]);
  let found: HabitCompletion | undefined;
  for (const ms of instants) {
    const completion = completions.get(completionKey(event.id, ms));
    if (completion?.status === 'done') return completion;
    found ??= completion;
  }
  return found;
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
  now: Date,
  /** The modes in effect over the window; paused occurrences are left out of the score, shifted ones are scored where they rang. */
  modes: ModeTimeline | undefined = undefined
): HabitStats {
  const windowDays = habitWindowDays(event);
  const windowStartMs = now.getTime() - windowDays * MS_PER_DAY;
  const createdMs = event.created_at === undefined ? Number.NaN : instantMs(event.created_at);
  // Prayers also start no earlier than the moment the user switched them on, so a stretch with
  // prayers off is not scored as missed when they come back.
  const enabledMs =
    eventKindOf(event) === 'normal' || !settings.prayers_enabled_since
      ? Number.NaN
      : instantMs(settings.prayers_enabled_since);
  const floorMs = Math.max(windowStartMs, Number.isNaN(createdMs) ? -Infinity : createdMs, Number.isNaN(enabledMs) ? -Infinity : enabledMs);
  const from = new Date(floorMs);
  const endMs = now.getTime() + 1;
  const timeline = modes ?? buildModeTimeline(undefined, settings);
  // A shift moves an occurrence up to 12 hours, so ask for that much more on both sides and keep what
  // rings inside the range. Without modes (or for a prayer) nothing moves and the range is exact.
  const slack = timeline.active && eventKindOf(event) === 'normal' ? MAX_SHIFT_MS : 0;
  // The range is half-open; +1 ms makes an occurrence exactly at `now` count.
  const moded = applyModesToInstants(
    event,
    eventOccurrencesBetween(event, new Date(floorMs - slack), new Date(endMs + slack), settings),
    timeline
  ).filter((m) => m.at.getTime() >= floorMs && m.at.getTime() < endMs);

  // A prayer's completion is matched by prayer-day, not exact instant: an offset or location change after
  // "prayed" moves the alarm by minutes and must not turn that prayer into a miss.
  const prayerCompletions = eventKindOf(event) === 'normal' ? null : completionsByPrayerDay(event, completions, settings);
  const counts = { done: 0, missed: 0, excused: 0, paused: 0, pending: 0 };
  const occurrences: HabitOccurrence[] = [];
  let earned = 0;
  let possible = 0;

  for (const { at, original, paused } of moded) {
    // A shifted occurrence is matched where it rang, or, for a Done pressed before the shift took effect,
    // by its original instant.
    const completion =
      prayerCompletions === null
        ? completionNear(event, completions, at.getTime(), original.getTime(), timeline)
        : prayerCompletions.get(prayerDayKey(event, at, settings) ?? '');
    const outcome = classifyOccurrence({
      passable: isEventPassable(event),
      at,
      now,
      completion,
      cheatDays,
      timezone: settings.timezone,
      graceMinutes: settings.grace_minutes,
      paused,
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
 * One prayer-day's outcome from its prayers' outcomes: a miss anywhere breaks it, a prayer still to come (or
 * inside its late window) leaves it open, and it is done once every prayer of that day is done. A day with
 * only excused or paused prayers keeps a streak alive without adding to it.
 */
export function prayerDayOutcome(outcomes: readonly OccurrenceOutcome[]): OccurrenceOutcome {
  if (outcomes.includes('missed')) return 'missed';
  if (outcomes.includes('pending')) return 'pending';
  if (outcomes.includes('done')) return 'done';
  return outcomes.includes('excused') ? 'excused' : 'paused';
}

/**
 * Pools the stats of the prayer events into the single "Prayer" habit. Counts, weighted credit and weighted
 * possible are summed, so the score is the pooled one (100 * sum earned / sum possible, like the overall score).
 * The streak runs over prayer-days, oldest first. A prayer-day is the day a prayer was computed for (`prayerDayOf`,
 * the same day completions are matched by), not the local date of its instant, so an Isha pushed past midnight by an
 * offset stays with its own day. A day is done only when every prayer of that day was prayed, one miss makes it missed
 * and resets the streak, and a day with a prayer still to come or inside its late window is skipped (pending). Two
 * days can be incomplete without being the person's doing, and are left out of the days and the streak altogether:
 * the first day, when the scoring window (or the moment the prayers were switched on, or the alarms created) starts
 * part-way through it, and the last day while its later prayers have not come yet, so a streak does not grow at Fajr.
 * The per-prayer counts and the score still include the prayers that fall inside the window. It is ranked from
 * HABIT_MIN_SCORED scored days, the same "five days of evidence" each prayer needed on its own.
 */
function pooledPrayerHabit(
  prayers: ReadonlyArray<{ event: HabitEvent; stats: HabitStats }>,
  settings: HabitSettings
): HabitStats {
  const parts = prayers.map(({ stats }) => stats);
  const config = resolvePrayerConfig(settings);
  const tagged = prayers
    .flatMap(({ event, stats }) => stats.occurrences.map((occurrence) => ({ event, occurrence })))
    .sort((a, b) => a.occurrence.at.getTime() - b.occurrence.at.getTime());
  const occurrences = tagged.map(({ occurrence }) => occurrence);
  const days = new Map<number, OccurrenceOutcome[]>();
  for (const { event, occurrence } of tagged) {
    const day =
      config !== null && event.prayer != null
        ? prayerDayOf(config, event.prayer, occurrence.at, settings.timezone)
        : dayNumberFromDateString(localDateString(occurrence.at, settings.timezone));
    days.set(day, [...(days.get(day) ?? []), occurrence.outcome]);
  }
  const ordered = [...days].sort(([a], [b]) => a - b);
  const dayOutcomes = ordered
    .filter(([, outcomes], index) => !(index === 0 && outcomes.length < parts.length))
    .map(([, outcomes], index, kept) => {
      const outcome = prayerDayOutcome(outcomes);
      const lastDayOpen = index === kept.length - 1 && outcomes.length < parts.length;
      return lastDayOpen && outcome !== 'missed' ? 'pending' : outcome;
    });
  const scoredDays = dayOutcomes.filter((outcome) => outcome === 'done' || outcome === 'missed').length;
  const sum = (pick: (part: HabitStats) => number): number => parts.reduce((total, part) => total + pick(part), 0);
  const earned = sum((part) => part.weightedEarned);
  const possible = sum((part) => part.weightedPossible);
  const score = scoredDays >= HABIT_MIN_SCORED && possible > 0 ? (100 * earned) / possible : null;
  const run = streaks(dayOutcomes);
  const done = sum((part) => part.done);
  const missed = sum((part) => part.missed);

  return {
    eventId: PRAYER_HABIT_ID,
    title: 'Prayer',
    color: null,
    done,
    missed,
    excused: sum((part) => part.excused),
    paused: sum((part) => part.paused),
    pending: sum((part) => part.pending),
    scored: done + missed,
    windowDays: Math.max(HABIT_WINDOW_DAYS, ...parts.map((part) => part.windowDays)),
    score,
    weightedEarned: earned,
    weightedPossible: possible,
    tier: tierForScore(score),
    currentStreak: run.current,
    bestStreak: run.best,
    occurrences,
    pooled: 'prayer',
    scoredDays,
  };
}

/**
 * Stats for every recurring active event (the five prayers pooled into one "Prayer" habit), plus the overall score pooled over the ranked habits:
 * 100 * sum(earned) / sum(possible), each habit using its own per-occurrence weights, so a
 * habit with more recent scored occurrences counts for more. Unranked habits do not enter it.
 */
export function computeHabitsReport(
  events: readonly HabitEvent[],
  completions: readonly HabitCompletion[],
  cheatDays: readonly string[],
  settings: HabitSettings,
  now: Date,
  /** The modes: paused occurrences are left out of every habit's score (roadmap v2, phase 5). */
  modes?: ModeConfig
): HabitsReport {
  const index = indexCompletions(completions);
  const timeline = buildModeTimeline(modes, settings);
  const cheatDaySet = new Set(cheatDays);
  const habits: HabitStats[] = [];
  const prayers: Array<{ event: HabitEvent; stats: HabitStats }> = [];
  const failed: HabitEvent[] = [];
  for (const event of events.filter(isHabit)) {
    try {
      const stats = computeHabitStats(event, index, cheatDaySet, settings, now, timeline);
      if (eventKindOf(event) === 'prayer') prayers.push({ event, stats });
      else habits.push(stats);
    } catch {
      // One unusable event must not take the whole Stats screen down.
      failed.push(event);
    }
  }

  if (prayers.length > 0) habits.push(pooledPrayerHabit(prayers, settings));

  // The pooled prayer habit enters once, with its own summed numerator and denominator.
  let earned = 0;
  let possible = 0;
  for (const habit of habits) {
    if (habit.score === null) continue;
    earned += habit.weightedEarned;
    possible += habit.weightedPossible;
  }
  const overallScore = possible > 0 ? (100 * earned) / possible : null;
  return { habits, overallScore, overallTier: tierForScore(overallScore), failed };
}
