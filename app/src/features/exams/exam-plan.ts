import {
  CATCH_UP_END_BUFFER_MS,
  REVISION_DAYS_BEFORE,
  examAlarmOf,
  planRevisionSessions,
  sessionsOfExam,
  type EventRow,
  type ExamDifficulty,
  type ExamRow,
} from '@alarm-calendar/core';

import { DEFAULT_MAX_SNOOZES, DEFAULT_SNOOZE_MINUTES, type EventWriteInput } from '@/features/events/event-form';
import { instantFromZoned } from '@/lib/zoned-time';

import type { ExamWriteInput } from './exams-api';

/**
 * What an exam turns into, and how an edit changes the alarms it already made. Everything here is pure; the
 * writes live in exam-actions.ts.
 *
 * An exam owns ordinary one-off alarms (kind 'normal', no repeat) linked by events.exam_id:
 *  - the exam alarm (exam_role 'exam'), `leadMinutes` before the exam starts. It is not passable: a cheat
 *    day never silences it. Its block on the calendar runs from the alarm to the start of the exam.
 *  - one revision session per planRevisionSessions slot (exam_role 'session'), passable like a plain alarm:
 *    a cheat day silences a session, and a session on a cheat day is left alone rather than caught up.
 *  - catch-ups (exam_role 'session', catch_up_of set), created by catch-up-sync.ts.
 * They stay plain alarms so recurrence, the schedule, the calendar and the engines need no new code path.
 */

export const DEFAULT_SESSION_MINUTES = 45;
export const DEFAULT_EXAM_LEAD_MINUTES = 60;
/** A calendar block for an exam alarm that rings exactly at the start of the exam. */
const EXAM_ALARM_MIN_BLOCK_MINUTES = 15;

/** What the exam form edits. Dates and times are wall-clock values in settings.timezone. */
export interface ExamFormValues {
  title: string;
  notes: string;
  /** 'yyyy-MM-dd' */
  examDate: string;
  /** 'HH:mm' */
  examTime: string;
  difficulty: ExamDifficulty;
  /** 'HH:mm', when each revision session rings. */
  sessionTime: string;
  sessionMinutes: number;
  /** Minutes before the exam that its own alarm rings; 0 rings at the start of the exam. */
  leadMinutes: number;
  /** False keeps the exam alarm and every revision session off the calendar (they still ring). */
  showInCalendar: boolean;
}

export const DIFFICULTY_LABELS: Record<ExamDifficulty, string> = { 1: 'Easy', 2: 'Normal', 3: 'Hard' };

export function sessionTitle(examTitle: string, daysBefore: number): string {
  return `Revise ${examTitle}, ${daysBefore} ${daysBefore === 1 ? 'day' : 'days'} to go`;
}

export function examAlarmTitle(examTitle: string): string {
  return `Exam: ${examTitle}`;
}

export function catchUpTitle(examTitle: string): string {
  return `Catch-up: revise ${examTitle}`;
}

export interface PlannedSession {
  daysBefore: number;
  input: EventWriteInput;
}

export interface ExamPlan {
  exam: ExamWriteInput;
  /** The alarm before the exam; its time may already be past (an exam that starts within the lead). */
  examAlarm: EventWriteInput;
  /** Sessions still to come, ascending. */
  sessions: PlannedSession[];
  /** Sessions the schedule has but that are already in the past, so they are not planned. */
  skippedSessions: number;
}

function alarmColumns(): Pick<
  EventWriteInput,
  'repeat_unit' | 'repeat_interval' | 'repeat_weekdays' | 'ends_at' | 'max_snoozes' | 'snooze_minutes' | 'color' | 'group_id'
> {
  return {
    repeat_unit: 'none',
    repeat_interval: 1,
    repeat_weekdays: null,
    ends_at: null,
    max_snoozes: DEFAULT_MAX_SNOOZES,
    snooze_minutes: DEFAULT_SNOOZE_MINUTES,
    color: null,
    group_id: null,
  };
}

/** The exam row and the alarms its form values describe, as of `now`. */
export function planExam(values: ExamFormValues, tz: string, now: Date): ExamPlan {
  const title = values.title.trim();
  const notes = values.notes.trim() === '' ? null : values.notes.trim();
  const examAt = instantFromZoned(values.examDate, values.examTime, tz);
  const sessions = planRevisionSessions(
    { exam_at: examAt.toISOString(), difficulty: values.difficulty },
    { timezone: tz },
    now,
    values.sessionTime
  );

  return {
    exam: { title, exam_at: examAt.toISOString(), difficulty: values.difficulty, notes },
    examAlarm: {
      ...alarmColumns(),
      title: examAlarmTitle(title),
      notes,
      start_at: new Date(examAt.getTime() - values.leadMinutes * 60_000).toISOString(),
      duration_min: Math.max(values.leadMinutes, EXAM_ALARM_MIN_BLOCK_MINUTES),
      passable: false,
      show_in_calendar: values.showInCalendar,
      exam_role: 'exam',
      catch_up_of: null,
    },
    sessions: sessions.map((session) => ({
      daysBefore: session.daysBefore,
      input: {
        ...alarmColumns(),
        title: sessionTitle(title, session.daysBefore),
        notes,
        start_at: session.at.toISOString(),
        duration_min: values.sessionMinutes,
        passable: true,
        show_in_calendar: values.showInCalendar,
        exam_role: 'session',
        catch_up_of: null,
      },
    })),
    skippedSessions: REVISION_DAYS_BEFORE[values.difficulty].length - sessions.length,
  };
}

/** The row to write for a catch-up of `missed`, `at` the instant planCatchUp chose. */
export function catchUpWriteInput(exam: ExamRow, missed: EventRow, at: Date): EventWriteInput {
  return {
    ...alarmColumns(),
    title: catchUpTitle(exam.title),
    notes: exam.notes,
    start_at: at.toISOString(),
    duration_min: missed.duration_min,
    max_snoozes: missed.max_snoozes,
    snooze_minutes: missed.snooze_minutes,
    passable: missed.passable,
    // A catch-up shows up the way the session it replaces did.
    show_in_calendar: missed.show_in_calendar ?? true,
    exam_id: exam.id,
    exam_role: 'session',
    catch_up_of: missed.id,
  };
}

function writeInputOf(row: EventRow): EventWriteInput {
  return {
    title: row.title,
    notes: row.notes,
    start_at: row.start_at,
    duration_min: row.duration_min,
    repeat_unit: row.repeat_unit,
    repeat_interval: row.repeat_interval,
    repeat_weekdays: row.repeat_weekdays,
    ends_at: row.ends_at,
    max_snoozes: row.max_snoozes,
    snooze_minutes: row.snooze_minutes,
    passable: row.passable,
    color: row.color,
    show_in_calendar: row.show_in_calendar ?? true,
    group_id: row.group_id ?? null,
    exam_id: row.exam_id ?? null,
    exam_role: row.exam_role ?? null,
    catch_up_of: row.catch_up_of ?? null,
  };
}

export interface ExamAlarmChanges {
  insert: EventWriteInput[];
  update: Array<{ id: string; input: EventWriteInput }>;
  /** Ids of alarms to switch off. */
  deactivate: string[];
}

function differs(row: EventRow, input: EventWriteInput): boolean {
  return (
    row.title !== input.title ||
    (row.notes ?? null) !== (input.notes ?? null) ||
    row.duration_min !== input.duration_min ||
    (row.show_in_calendar ?? true) !== (input.show_in_calendar ?? true) ||
    Date.parse(row.start_at) !== Date.parse(input.start_at)
  );
}

/**
 * What saving an edited exam does to the alarms it already has, as of `now`:
 *  - sessions that already happened (their time is past, done or missed) are kept as they are, history;
 *  - sessions still to come that match a planned one by time are updated in place (a new title, say), the
 *    rest are switched off and the planned ones that match nothing are created;
 *  - a catch-up still to come is kept while there is room before the (possibly moved) exam, else switched off;
 *  - the exam alarm is updated, or created when it is still to come and the exam had none.
 * Saving again after a failed write repairs a half-applied edit, because the diff is against what exists.
 */
export function diffExamAlarms(examId: string, plan: ExamPlan, events: readonly EventRow[], now: Date): ExamAlarmChanges {
  const changes: ExamAlarmChanges = { insert: [], update: [], deactivate: [] };
  const nowMs = now.getTime();
  const examAtMs = Date.parse(plan.exam.exam_at);

  const existingAlarm = examAlarmOf(examId, events);
  const alarm: EventWriteInput = { ...plan.examAlarm, exam_id: examId };
  if (existingAlarm !== null) {
    if (differs(existingAlarm, alarm)) changes.update.push({ id: existingAlarm.id, input: alarm });
  } else if (Date.parse(alarm.start_at) > nowMs) {
    changes.insert.push(alarm);
  }

  const plannedByTime = new Map(plan.sessions.map((session) => [Date.parse(session.input.start_at), session]));
  const matched = new Set<number>();
  for (const row of sessionsOfExam(examId, events)) {
    const startMs = Date.parse(row.start_at);
    if (startMs <= nowMs) continue;
    if (row.catch_up_of != null) {
      if (startMs >= examAtMs - CATCH_UP_END_BUFFER_MS) {
        changes.deactivate.push(row.id);
        continue;
      }
      const next: EventWriteInput = {
        ...writeInputOf(row),
        title: catchUpTitle(plan.exam.title),
        notes: plan.exam.notes,
        show_in_calendar: plan.examAlarm.show_in_calendar,
      };
      if (differs(row, next)) changes.update.push({ id: row.id, input: next });
      continue;
    }
    const planned = plannedByTime.get(startMs);
    if (planned === undefined) {
      changes.deactivate.push(row.id);
      continue;
    }
    matched.add(startMs);
    const next: EventWriteInput = { ...writeInputOf(row), ...planned.input, exam_id: examId };
    if (differs(row, next)) changes.update.push({ id: row.id, input: next });
  }

  for (const [startMs, planned] of plannedByTime) {
    if (!matched.has(startMs)) changes.insert.push({ ...planned.input, exam_id: examId });
  }
  return changes;
}
