import { applyModesToInstants, buildModeTimeline, type ModeTimeline } from './modes';
import { isEventPassable } from './occurrences';
import { dayNumberFromDateString, fromWallClock, localDateString, toWallClock } from './time-zone';
import type { CompletionRow, EventRow, ExamDifficulty, ExamRow, ModeConfig, ModeSettings, Settings } from './types';

// Roadmap v2, phase 4. Exams and their revision sessions are planned here, as pure functions; the
// alarms themselves are ordinary one-off events (kind 'normal') that the app writes, so the schedule,
// the calendar and the engines need nothing new. Keep a Kotlin mirror identical if one is ever needed.

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

/** Days before the exam day (in the user's zone) of each revision session, by difficulty. */
export const REVISION_DAYS_BEFORE: Readonly<Record<ExamDifficulty, readonly number[]>> = {
  1: [7, 3, 1],
  2: [7, 3, 1],
  3: [14, 7, 3, 1],
};

/** Wall-clock time of day of a revision session unless the person picks another. */
export const DEFAULT_SESSION_TIME = '18:00';

/** A catch-up is only planned while at least this long remains before the exam. */
export const CATCH_UP_MIN_REMAINING_MS = 3 * MS_PER_HOUR;
/** A catch-up never rings sooner than this after the miss was noticed, so it is not an instant nag. */
export const CATCH_UP_MIN_LEAD_MS = 30 * MS_PER_MINUTE;
/** A catch-up is over at least this long before the exam, so the person is not revising at the door. */
export const CATCH_UP_END_BUFFER_MS = 60 * MS_PER_MINUTE;
/** A catch-up lands on a quarter hour. */
export const CATCH_UP_SLOT_MS = 15 * MS_PER_MINUTE;
/** Local daytime window of a catch-up (inclusive): not in the night. */
export const CATCH_UP_DAY_START_MINUTE = 8 * 60;
export const CATCH_UP_DAY_END_MINUTE = 21 * 60;
/** A catch-up keeps this far from the exam's other alarms, so two sessions never stack. */
export const CATCH_UP_MIN_GAP_MS = 60 * MS_PER_MINUTE;
/**
 * A session counts as missed for catch-up purposes only this long after its grace window ended. A Done
 * pressed on a device that was offline reaches the database when it reconnects; this gives it a head start
 * over the app deciding the session was missed.
 */
export const CATCH_UP_SETTLE_MINUTES = 10;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseTimeOfDay(time: string): number {
  const match = TIME_PATTERN.exec(time);
  if (!match) throw new RangeError(`Expected a 24-hour 'HH:mm' time, got: ${time}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function parseInstant(value: string | Date, what: string): Date {
  const instant = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(instant.getTime())) throw new RangeError(`Invalid ${what}: ${String(value)}`);
  return instant;
}

/** One planned revision session. */
export interface RevisionSession {
  /** The instant it rings. */
  at: Date;
  /** How many days before the exam day it falls, for its title ("7 days to go"). */
  daysBefore: number;
}

/**
 * The revision sessions of an exam: 7, 3 and 1 days before the exam day (and 14 for difficulty 3), each at
 * `sessionTime` wall-clock in the user's zone, ascending. A session that is already in the past at `now`
 * is left out, so an exam created 5 days ahead gets only its 3 and 1 day sessions. Throws RangeError for a
 * malformed exam time, difficulty, zone or session time.
 */
export function planRevisionSessions(
  exam: Pick<ExamRow, 'exam_at' | 'difficulty'>,
  settings: Pick<Settings, 'timezone'>,
  now: Date,
  sessionTime: string = DEFAULT_SESSION_TIME
): RevisionSession[] {
  const offsets = REVISION_DAYS_BEFORE[exam.difficulty];
  if (offsets === undefined) throw new RangeError(`Unknown exam difficulty: ${String(exam.difficulty)}`);
  const minuteOfDay = parseTimeOfDay(sessionTime);
  const examAt = parseInstant(exam.exam_at, 'exam time');
  const examDay = dayNumberFromDateString(localDateString(examAt, settings.timezone));

  return offsets
    .map((daysBefore) => ({
      daysBefore,
      at: fromWallClock(examDay - daysBefore, minuteOfDay * MS_PER_MINUTE, settings.timezone),
    }))
    .filter((session) => session.at.getTime() > now.getTime() && session.at.getTime() < examAt.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** What planCatchUp needs of the session that was missed. */
export type MissedSession = Pick<EventRow, 'id' | 'start_at'> & { catch_up_of?: string | null };

function isDaytime(instantMs: number, tz: string): boolean {
  const minute = Math.floor(toWallClock(new Date(instantMs), tz).msOfDay / MS_PER_MINUTE);
  return minute >= CATCH_UP_DAY_START_MINUTE && minute <= CATCH_UP_DAY_END_MINUTE;
}

/**
 * When to hold the one catch-up for a missed session, or null when there is none to plan. The ideal is
 * halfway between `now` and the exam; the result is the quarter hour nearest to that which is
 * inside the local daytime window (08:00 to 21:00), at least 30 minutes after `now`, at least an hour before
 * the exam, and at least an hour from every time in `avoid` (the exam's other alarms). Nearer an earlier slot
 * on a tie.
 *
 * Null when: the session was itself a catch-up (a catch-up never spawns another), a catch-up for it already
 * exists (`existingCatchUps` holds the missed session ids that have one), less than 3 hours remain before
 * the exam, or no slot fits (for instance when the exam is early tomorrow morning and the halfway point is
 * in the night: the nearest daytime slot would leave no time before the exam).
 */
export function planCatchUp(
  exam: Pick<ExamRow, 'exam_at'>,
  missedSession: MissedSession,
  now: Date,
  settings: Pick<Settings, 'timezone'>,
  existingCatchUps: ReadonlySet<string> | readonly string[] = [],
  avoid: readonly Date[] = []
): Date | null {
  if (missedSession.catch_up_of != null) return null;
  const existing = existingCatchUps instanceof Set ? existingCatchUps : new Set(existingCatchUps);
  if (existing.has(missedSession.id)) return null;

  const examMs = parseInstant(exam.exam_at, 'exam time').getTime();
  const nowMs = now.getTime();
  const remaining = examMs - nowMs;
  if (remaining < CATCH_UP_MIN_REMAINING_MS) return null;

  const first = Math.ceil((nowMs + CATCH_UP_MIN_LEAD_MS) / CATCH_UP_SLOT_MS);
  const last = Math.floor((examMs - CATCH_UP_END_BUFFER_MS) / CATCH_UP_SLOT_MS);
  const ideal = Math.round((nowMs + remaining / 2) / CATCH_UP_SLOT_MS);
  const avoidMs = avoid.map((instant) => instant.getTime());

  const fits = (slot: number): boolean => {
    if (slot < first || slot > last) return false;
    const at = slot * CATCH_UP_SLOT_MS;
    if (avoidMs.some((other) => Math.abs(other - at) < CATCH_UP_MIN_GAP_MS)) return false;
    return isDaytime(at, settings.timezone);
  };

  const reach = Math.max(ideal - first, last - ideal);
  for (let distance = 0; distance <= reach; distance++) {
    if (fits(ideal - distance)) return new Date((ideal - distance) * CATCH_UP_SLOT_MS);
    if (distance > 0 && fits(ideal + distance)) return new Date((ideal + distance) * CATCH_UP_SLOT_MS);
  }
  return null;
}

/**
 * Where a revision session stands.
 *  - done: completed (a Done on any device);
 *  - skipped: a cheat day silenced it, a mode paused it (Sick, Vacation ...), or it was completed as skipped_cheat;
 *  - upcoming: not due yet;
 *  - due: due, and still inside the grace window (it can still ring);
 *  - missed: past the grace window with no completion.
 */
export type SessionState = 'done' | 'skipped' | 'upcoming' | 'due' | 'missed';

export function classifySession(input: {
  /** When the session rings (the one-off event's start_at). */
  at: Date;
  /** The completion of its event, if any: a one-off alarm has at most one occurrence. */
  completion: Pick<CompletionRow, 'status'> | undefined;
  /** A cheat day silences it. */
  silenced: boolean;
  graceMinutes: number;
  now: Date;
}): SessionState {
  if (input.completion !== undefined) return input.completion.status === 'done' ? 'done' : 'skipped';
  if (input.silenced) return 'skipped';
  const atMs = input.at.getTime();
  const nowMs = input.now.getTime();
  if (atMs > nowMs) return 'upcoming';
  return nowMs < atMs + input.graceMinutes * MS_PER_MINUTE ? 'due' : 'missed';
}

/** The revision sessions among an exam's events (the exam's own alarm is not one), ascending. */
export function sessionsOfExam(examId: string, events: readonly EventRow[]): EventRow[] {
  return events
    .filter((event) => event.active && event.exam_id === examId && event.exam_role === 'session')
    .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at) || a.id.localeCompare(b.id));
}

/** The alarm that rings before the exam itself, if the exam has one. */
export function examAlarmOf(examId: string, events: readonly EventRow[]): EventRow | null {
  return events.find((event) => event.active && event.exam_id === examId && event.exam_role === 'exam') ?? null;
}

export interface ExamProgress {
  /** Every session of the exam, catch-ups included. */
  total: number;
  done: number;
  missed: number;
  skipped: number;
  /** Not done yet and not lost: upcoming plus due. */
  remaining: number;
}

export interface ExamProgressInput {
  examId: string;
  events: readonly EventRow[];
  completions: readonly Pick<CompletionRow, 'event_id' | 'status'>[];
  cheatDays: readonly string[];
  settings: Pick<Settings, 'timezone' | 'grace_minutes'> & Partial<ModeSettings>;
  now: Date;
  /** A session a mode pauses counts as skipped, not missed, so it never earns a catch-up. */
  modes?: ModeConfig;
}

/** The state of one session event against the completions and cheat days. */
export function sessionStateOf(
  session: EventRow,
  completions: readonly Pick<CompletionRow, 'event_id' | 'status'>[],
  cheatDays: ReadonlySet<string> | readonly string[],
  settings: Pick<Settings, 'timezone' | 'grace_minutes'> & Partial<ModeSettings>,
  now: Date,
  modes?: ModeTimeline
): SessionState {
  const planned = new Date(session.start_at);
  const days = cheatDays instanceof Set ? cheatDays : new Set(cheatDays);
  // A session is a one-off alarm, so a mode treats it like any other: it can be paused or moved.
  const moded = applyModesToInstants(session, [planned], modes ?? buildModeTimeline(undefined, settings))[0];
  const at = moded?.at ?? planned;
  const paused = moded?.paused === true;
  return classifySession({
    at,
    completion: completions.find((completion) => completion.event_id === session.id),
    silenced: paused || (isEventPassable(session) && days.has(localDateString(at, settings.timezone))),
    graceMinutes: settings.grace_minutes,
    now,
  });
}

/** How many of an exam's revision sessions are done, missed, skipped and still to come. */
export function examProgress(input: ExamProgressInput): ExamProgress {
  const days = new Set(input.cheatDays);
  const timeline = buildModeTimeline(input.modes, input.settings);
  const progress: ExamProgress = { total: 0, done: 0, missed: 0, skipped: 0, remaining: 0 };
  for (const session of sessionsOfExam(input.examId, input.events)) {
    const state = sessionStateOf(session, input.completions, days, input.settings, input.now, timeline);
    progress.total += 1;
    if (state === 'done') progress.done += 1;
    else if (state === 'missed') progress.missed += 1;
    else if (state === 'skipped') progress.skipped += 1;
    else progress.remaining += 1;
  }
  return progress;
}

/**
 * Catch-ups that are no longer needed: still to come, while the session they replace has since got a
 * completion (done on another device, or a late Done that only now arrived). Switch these off. A catch-up
 * whose time has passed is left alone: it is history, and may have been done itself.
 */
export function catchUpsToCancel(scan: {
  events: readonly EventRow[];
  completions: readonly Pick<CompletionRow, 'event_id'>[];
  now: Date;
}): EventRow[] {
  const completed = new Set(scan.completions.map((completion) => completion.event_id));
  return scan.events.filter(
    (event) =>
      event.active &&
      event.exam_role === 'session' &&
      event.catch_up_of != null &&
      completed.has(event.catch_up_of) &&
      Date.parse(event.start_at) > scan.now.getTime()
  );
}

export interface CatchUpPlan {
  exam: ExamRow;
  /** The session that was missed; the catch-up's `catch_up_of`. */
  missed: EventRow;
  /** When the catch-up rings. */
  at: Date;
}

export interface CatchUpScan {
  exams: readonly ExamRow[];
  /** Active events; a catch-up already in the list stops a second one for the same session. */
  events: readonly EventRow[];
  /**
   * Completions of the exams' session events. They must be fully loaded: with a session's completion
   * missing it would look missed and get a catch-up it did not need.
   */
  completions: readonly Pick<CompletionRow, 'event_id' | 'status'>[];
  cheatDays: readonly string[];
  settings: Pick<Settings, 'timezone' | 'grace_minutes'> & Partial<ModeSettings>;
  now: Date;
  /** The modes: a session one of them pauses is skipped, never missed, so it gets no catch-up. */
  modes?: ModeConfig;
  /** Missed session ids that already had a catch-up written this run of the app (or that do not need one). */
  skip?: ReadonlySet<string>;
}

/**
 * The catch-up sessions to create now: one for each revision session that is missed (past grace and the
 * settle time, no completion, not silenced by a cheat day), is not a catch-up itself, has none yet, and has
 * room before the exam (see planCatchUp). Two missed sessions of one exam get catch-ups that do not stack.
 * Pure: the app writes the result with INSERT ... ON CONFLICT (catch_up_of) DO NOTHING, which is what keeps
 * two devices from both creating one.
 */
export function planCatchUps(scan: CatchUpScan): CatchUpPlan[] {
  const settleMs = CATCH_UP_SETTLE_MINUTES * MS_PER_MINUTE;
  const settled = new Date(scan.now.getTime() - settleMs);
  const hasCatchUp = new Set(
    scan.events.filter((event) => event.catch_up_of != null).map((event) => event.catch_up_of as string)
  );
  for (const id of scan.skip ?? []) hasCatchUp.add(id);
  const cheatDays = new Set(scan.cheatDays);
  const timeline = buildModeTimeline(scan.modes, scan.settings);

  const plans: CatchUpPlan[] = [];
  for (const exam of scan.exams) {
    if (!exam.active) continue;
    const sessions = sessionsOfExam(exam.id, scan.events);
    // Alarms already behind us cannot collide with a slot that is in the future.
    const avoid = scan.events
      .filter((event) => event.active && event.exam_id === exam.id && Date.parse(event.start_at) >= scan.now.getTime())
      .map((event) => new Date(event.start_at));
    for (const session of sessions) {
      if (session.catch_up_of != null || hasCatchUp.has(session.id)) continue;
      if (sessionStateOf(session, scan.completions, cheatDays, scan.settings, settled, timeline) !== 'missed') continue;
      const at = planCatchUp(exam, session, scan.now, scan.settings, hasCatchUp, avoid);
      if (at === null) continue;
      plans.push({ exam, missed: session, at });
      avoid.push(at);
    }
  }
  return plans;
}
