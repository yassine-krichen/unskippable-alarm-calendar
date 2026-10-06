import type { ExamRow } from '@alarm-calendar/core';

import { removeEventGroup, saveEventGroup, saveNewEventGroup, useEventsStore } from '@/features/events/events-store';
import { fail, ok, type Result } from '@/lib/result';

import { diffExamAlarms, planExam, type ExamFormValues } from './exam-plan';
import { createExam, deactivateExam, updateExam } from './exams-api';
import { dropExam, putExam } from './exams-store';

/**
 * Creates the exam and its alarms: the exam row first, then every alarm in one insert. If the alarms cannot
 * be written the exam is switched off again, so a failed save leaves nothing half-made (and the form still
 * holds the values for a retry).
 */
export async function addExam(values: ExamFormValues, tz: string, now: Date = new Date()): Promise<Result<ExamRow>> {
  const plan = planExam(values, tz, now);
  const created = await createExam(plan.exam);
  if (created.data === null) return fail(created.error);
  const exam = created.data;

  // An alarm that would ring in the past is not worth writing: it never rings.
  const alarms = [
    ...(Date.parse(plan.examAlarm.start_at) > now.getTime() ? [plan.examAlarm] : []),
    ...plan.sessions.map((session) => session.input),
  ].map((input) => ({ ...input, exam_id: exam.id }));

  if (alarms.length > 0) {
    const saved = await saveNewEventGroup(alarms);
    if (saved.data === null) {
      const undone = await deactivateExam(exam.id);
      if (undone.error !== null) console.warn('Could not undo the exam after its alarms failed:', undone.error);
      return fail(saved.error);
    }
  }
  putExam(exam);
  return ok(exam);
}

/**
 * Saves an edited exam. The exam row is updated, then its alarms are brought in line (see diffExamAlarms:
 * future unfinished sessions are regenerated, finished ones kept). These are several requests; if one fails
 * the earlier ones stay applied and saving again repairs the rest.
 */
export async function editExam(
  exam: ExamRow,
  values: ExamFormValues,
  tz: string,
  now: Date = new Date()
): Promise<Result<ExamRow>> {
  const plan = planExam(values, tz, now);
  const updated = await updateExam(exam.id, plan.exam);
  if (updated.data === null) return fail(updated.error);
  putExam(updated.data);

  const changes = diffExamAlarms(exam.id, plan, useEventsStore.getState().events, now);
  if (changes.insert.length > 0) {
    const inserted = await saveNewEventGroup(changes.insert);
    if (inserted.data === null) return fail(inserted.error);
  }
  if (changes.update.length > 0) {
    const saved = await saveEventGroup(changes.update);
    if (saved.data === null) return fail(saved.error);
  }
  if (changes.deactivate.length > 0) {
    const removed = await removeEventGroup(changes.deactivate);
    if (removed.error !== null) return fail(removed.error);
  }
  return ok(updated.data);
}

/**
 * Deletes an exam: every alarm it owns (sessions, catch-ups, its own alarm) is switched off first, so
 * nothing keeps ringing if the last step fails, then the exam itself. Completions and history stay.
 */
export async function removeExam(exam: ExamRow): Promise<Result<null>> {
  const ids = useEventsStore
    .getState()
    .events.filter((event) => event.exam_id === exam.id)
    .map((event) => event.id);
  if (ids.length > 0) {
    const removed = await removeEventGroup(ids);
    if (removed.error !== null) return removed;
  }
  const result = await deactivateExam(exam.id);
  if (result.error === null) dropExam(exam.id);
  return result;
}
