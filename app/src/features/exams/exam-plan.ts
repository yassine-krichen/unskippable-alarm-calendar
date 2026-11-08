// Moved to core so the agent CLI plans an exam exactly as the app does.
export {
  DEFAULT_EXAM_LEAD_MINUTES,
  DEFAULT_SESSION_MINUTES,
  DIFFICULTY_LABELS,
  catchUpTitle,
  catchUpWriteInput,
  diffExamAlarms,
  examAlarmTitle,
  planExam,
  sessionTitle,
} from '@alarm-calendar/core';
export type { ExamAlarmChanges, ExamFormValues, ExamPlan, PlannedSession } from '@alarm-calendar/core';
