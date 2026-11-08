import {
  DEFAULT_EXAM_LEAD_MINUTES,
  DEFAULT_SESSION_MINUTES,
  DEFAULT_SESSION_TIME,
  MAX_LEAD_MINUTES,
  diffExamAlarms,
  examToFormValues,
  instantFromZoned,
  isRealDate,
  planExam,
  type ExamDifficulty,
  type ExamFormValues,
  type ExamRow,
  type EventRow,
} from '@alarm-calendar/core';

import { booleanOption, numberOption, stringOption, type OptionSpec } from '../args';
import { CliError } from '../errors';
import { AGENT_KEY_PATTERN } from '../events/event-spec';
import { Recorder } from '../journal/recorder';
import { longLocal } from '../output/time-format';

import { defineCommand } from './command';
import { findExamRef, journalJson, journalled, openWorld, undoHint, type WriteOutcome } from './support';

const DEFAULT_EXAM_TIME = '09:00';
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const EXAM_FLAGS: readonly OptionSpec[] = [
  { name: 'title', type: 'string', description: 'Exam name (1 to 100 characters).' },
  { name: 'date', type: 'string', value: 'yyyy-MM-dd', description: 'Exam day in the settings timezone.' },
  { name: 'time', type: 'string', value: 'HH:mm', description: `Exam start time. Default ${DEFAULT_EXAM_TIME}.` },
  { name: 'difficulty', type: 'string', value: '1|2|3|easy|normal|hard', description: 'Hard exams get one more, earlier, revision session. Default normal.' },
  { name: 'session-time', type: 'string', value: 'HH:mm', description: `When each revision session rings. Default ${DEFAULT_SESSION_TIME}.` },
  { name: 'session-minutes', type: 'number', value: '5-480', description: `Revision session length. Default ${DEFAULT_SESSION_MINUTES}.` },
  { name: 'lead', type: 'number', value: '0-1440', description: `Minutes before the exam its own alarm rings. Default ${DEFAULT_EXAM_LEAD_MINUTES}.` },
  { name: 'notes', type: 'string', description: 'Notes copied onto the exam alarms.' },
  { name: 'show-in-calendar', type: 'boolean', description: 'Draw the exam alarms on the calendar (default true).' },
  { name: 'key', type: 'string', value: 'exams/maths-final', description: 'Agent key: a stable name to find this exam again.' },
];

function parseDifficulty(value: string): ExamDifficulty {
  const map: Record<string, ExamDifficulty> = { '1': 1, easy: 1, '2': 2, normal: 2, '3': 3, hard: 3 };
  const difficulty = map[value.toLowerCase()];
  if (difficulty === undefined) throw new CliError('invalid_input', `Difficulty must be 1, 2, 3, easy, normal or hard, got "${value}".`);
  return difficulty;
}

function valuesFromFlags(base: ExamFormValues, args: Parameters<typeof stringOption>[0]): ExamFormValues {
  const values = { ...base };
  const title = stringOption(args, 'title');
  if (title !== undefined) values.title = title;
  const notes = stringOption(args, 'notes');
  if (notes !== undefined) values.notes = notes;
  const date = stringOption(args, 'date');
  if (date !== undefined) values.examDate = date;
  const time = stringOption(args, 'time');
  if (time !== undefined) values.examTime = time;
  const difficulty = stringOption(args, 'difficulty');
  if (difficulty !== undefined) values.difficulty = parseDifficulty(difficulty);
  const sessionTime = stringOption(args, 'session-time');
  if (sessionTime !== undefined) values.sessionTime = sessionTime;
  const sessionMinutes = numberOption(args, 'session-minutes');
  if (sessionMinutes !== undefined) values.sessionMinutes = sessionMinutes;
  const lead = numberOption(args, 'lead');
  if (lead !== undefined) values.leadMinutes = lead;
  const show = booleanOption(args, 'show-in-calendar');
  if (show !== undefined) values.showInCalendar = show;
  return values;
}

function validate(values: ExamFormValues, tz: string, now: Date, isNew: boolean): void {
  const problems: string[] = [];
  if (values.title.trim() === '' || values.title.trim().length > 100) problems.push('the title must be 1 to 100 characters');
  if (values.notes.length > 2000) problems.push('notes are at most 2000 characters');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.examDate) || !isRealDate(values.examDate)) problems.push('--date must be a real date like 2026-12-10');
  if (!TIME.test(values.examTime)) problems.push('--time must look like 09:00');
  if (!TIME.test(values.sessionTime)) problems.push('--session-time must look like 18:00');
  if (!Number.isInteger(values.sessionMinutes) || values.sessionMinutes < 5 || values.sessionMinutes > 480) problems.push('--session-minutes must be a whole number from 5 to 480');
  if (!Number.isInteger(values.leadMinutes) || values.leadMinutes < 0 || values.leadMinutes > MAX_LEAD_MINUTES) problems.push(`--lead must be a whole number from 0 to ${MAX_LEAD_MINUTES}`);
  if (problems.length === 0 && isNew && instantFromZoned(values.examDate, values.examTime, tz).getTime() <= now.getTime()) {
    problems.push('that exam time has already passed');
  }
  if (problems.length > 0) throw new CliError('invalid_input', problems.join('; '));
}

function assertKey(key: string): void {
  if (!AGENT_KEY_PATTERN.test(key)) {
    throw new CliError('invalid_input', `The key "${key}" is not valid.`, 'Use lowercase letters, digits and / _ . - (max 100 characters).');
  }
}

async function writeNewAlarms(recorder: Recorder, exam: ExamRow, alarms: Array<Parameters<Recorder['createEvents']>[0][number]>): Promise<EventRow[]> {
  if (alarms.length === 0) return [];
  try {
    return await recorder.createEvents(alarms.map((alarm) => ({ ...alarm, exam_id: exam.id })));
  } catch (error) {
    // Leave nothing half-made: an exam with no alarms would sit in the list doing nothing.
    await recorder.updateExam(exam, { active: false }).catch(() => undefined);
    throw error;
  }
}

export const examsAdd = defineCommand({
  path: ['exams', 'add'],
  summary: 'Create an exam with its alarm and revision sessions, planned the way the app plans them.',
  options: EXAM_FLAGS,
  writes: true,
  needsLogin: true,
  examples: ['alarm-cal exams add --title "Maths final" --date 2026-12-10 --time 09:00 --difficulty hard --key exams/maths-final'],
  async run({ rt, args }) {
    const { store, tz, now } = await openWorld(rt);
    const base: ExamFormValues = {
      title: '',
      notes: '',
      examDate: '',
      examTime: DEFAULT_EXAM_TIME,
      difficulty: 2,
      sessionTime: DEFAULT_SESSION_TIME,
      sessionMinutes: DEFAULT_SESSION_MINUTES,
      leadMinutes: DEFAULT_EXAM_LEAD_MINUTES,
      showInCalendar: true,
    };
    const values = valuesFromFlags(base, args);
    validate(values, tz, now, true);
    const key = stringOption(args, 'key');
    if (key !== undefined) {
      assertKey(key);
      if ((await store.listExams()).some((exam) => exam.agent_key === key)) throw new CliError('conflict', `The key "${key}" is already used by an exam.`);
    }
    const plan = planExam(values, tz, now);
    const result = await journalled(rt, store, async (recorder): Promise<WriteOutcome<{ exam: ExamRow; alarms: EventRow[] }>> => {
      const exam = await recorder.createExam({ ...plan.exam, ...(key === undefined ? {} : { agent_key: key }) });
      const planned = [...(Date.parse(plan.examAlarm.start_at) > now.getTime() ? [plan.examAlarm] : []), ...plan.sessions.map((session) => session.input)];
      const alarms = await writeNewAlarms(recorder, exam, planned);
      return {
        value: { exam, alarms },
        changes: [`created exam "${exam.title}" on ${longLocal(exam.exam_at, tz)} with ${alarms.length} alarm(s) (${plan.sessions.length} revision session(s)${plan.skippedSessions > 0 ? `, ${plan.skippedSessions} already past and skipped` : ''})`],
      };
    });
    return {
      data: { timezone: tz, exam_id: result.value.exam.id, agent_key: key ?? null, alarms: result.value.alarms.length, sessions: plan.sessions.length, skipped_sessions: plan.skippedSessions, changes: result.changes, ...journalJson(result.entry) },
      text: `${result.changes.join('\n')}\nid ${result.value.exam.id}${undoHint(result.entry)}`,
    };
  },
});

export const examsUpdate = defineCommand({
  path: ['exams', 'update'],
  summary: 'Change an exam; its alarms are regenerated by diff (finished sessions stay, future ones move).',
  positionals: [{ name: 'ref', description: 'Exam id (or prefix) or agent key.', required: true }],
  options: EXAM_FLAGS,
  writes: true,
  needsLogin: true,
  async run({ rt, args }) {
    const ref = args.positionals[0];
    if (ref === undefined) throw new CliError('usage', 'Give an exam id or agent key.');
    const { store, tz, now } = await openWorld(rt);
    const [exams, events] = await Promise.all([store.listExams(), store.listEvents()]);
    const exam = findExamRef(exams, ref);
    if (!exam.active) throw new CliError('invalid_input', 'That exam was removed.', 'Create a new one with `alarm-cal exams add`.');
    const key = stringOption(args, 'key');
    if (key !== undefined) {
      assertKey(key);
      if (exams.some((other) => other.agent_key === key && other.id !== exam.id)) throw new CliError('conflict', `The key "${key}" is already used by another exam.`);
    }
    const values = valuesFromFlags(examToFormValues(exam, events, tz), args);
    validate(values, tz, now, false);
    const plan = planExam(values, tz, now);
    const result = await journalled(rt, store, async (recorder) => {
      const examPatch = { ...plan.exam, ...(key === undefined ? {} : { agent_key: key }) };
      const updated = await recorder.updateExam(exam, examPatch);
      const changes = diffExamAlarms(exam.id, plan, events, now);
      const byId = new Map(events.map((event) => [event.id, event]));
      if (changes.insert.length > 0) await recorder.createEvents(changes.insert);
      for (const change of changes.update) {
        const row = byId.get(change.id);
        if (row !== undefined) await recorder.updateEvent(row, change.input);
      }
      for (const id of changes.deactivate) {
        const row = byId.get(id);
        if (row !== undefined) await recorder.updateEvent(row, { active: false });
      }
      return {
        value: updated,
        changes: [`updated exam "${updated.title}" on ${longLocal(updated.exam_at, tz)}: ${changes.insert.length} alarm(s) added, ${changes.update.length} updated, ${changes.deactivate.length} switched off`],
      };
    });
    return {
      data: { timezone: tz, exam_id: exam.id, changes: result.changes, ...journalJson(result.entry) },
      text: `${result.changes.join('\n')}${undoHint(result.entry)}`,
    };
  },
});

export const examsRemove = defineCommand({
  path: ['exams', 'remove'],
  summary: 'Remove an exam: switches off all its alarms, then the exam (history stays).',
  positionals: [{ name: 'ref', description: 'Exam id (or prefix) or agent key.', required: true }],
  writes: true,
  needsLogin: true,
  async run({ rt, args }) {
    const ref = args.positionals[0];
    if (ref === undefined) throw new CliError('usage', 'Give an exam id or agent key.');
    const { store, tz } = await openWorld(rt);
    const [exams, events] = await Promise.all([store.listExams(), store.listEvents()]);
    const exam = findExamRef(exams, ref);
    const alarms = events.filter((event) => event.exam_id === exam.id && event.active);
    const result = await journalled(rt, store, async (recorder) => {
      // Alarms first, so nothing keeps ringing if the last step fails.
      for (const alarm of alarms) await recorder.updateEvent(alarm, { active: false });
      if (exam.active) await recorder.updateExam(exam, { active: false });
      return { value: alarms.length, changes: [`removed exam "${exam.title}" and switched off ${alarms.length} alarm(s)`] };
    });
    return { data: { timezone: tz, exam_id: exam.id, alarms_switched_off: alarms.length, changes: result.changes, ...journalJson(result.entry) }, text: `${result.changes.join('\n')}${undoHint(result.entry)}` };
  },
});
