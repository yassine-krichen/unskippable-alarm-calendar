import type { EventRow } from '@alarm-calendar/core';

/**
 * The alarms whose colour is fixed by what they are, not chosen by the person (owner feedback, 2026-10-06):
 * the birthday / anniversary template's two alarms, the exam alarm, revision sessions and their catch-ups. The
 * colours are CSS tokens in index.css (`--cat-*`, light and dark), deliberately outside the event colour
 * picker's palette in event-colors.ts.
 */
export type AlarmCategory = 'birthday' | 'exam' | 'revision' | 'catch-up';

export const CATEGORY_LABELS: Record<AlarmCategory, string> = {
  birthday: 'Birthday or anniversary',
  exam: 'Exam',
  revision: 'Revision',
  'catch-up': 'Catch-up',
};

/** Class for the calendar's event chip (a tinted chip, or the solid exam alarm); see `.cat-*` in index.css. */
export const CATEGORY_CHIP_CLASS: Record<AlarmCategory, string> = {
  birthday: 'cat-birthday',
  exam: 'cat-exam',
  revision: 'cat-revision',
  'catch-up': 'cat-catch-up',
};

/** The colour tokens of a category, for FullCalendar's per-event colour (the month view's dot, the week's edge). */
export const CATEGORY_COLORS: Record<AlarmCategory, { color: string; contrast: string }> = {
  birthday: { color: 'var(--cat-birthday-accent)', contrast: 'var(--cat-birthday-ink)' },
  exam: { color: 'var(--cat-exam-solid)', contrast: 'var(--cat-exam-on-solid)' },
  revision: { color: 'var(--cat-revision-accent)', contrast: 'var(--cat-revision-ink)' },
  'catch-up': { color: 'var(--cat-revision-accent)', contrast: 'var(--cat-revision-ink)' },
};

type CategoryFields = Pick<EventRow, 'group_id' | 'exam_role' | 'catch_up_of' | 'kind'>;

/**
 * Which category an alarm belongs to, or null for an ordinary alarm (which keeps the colour its owner picked) and
 * for the prayers (outlined, see index.css). `group_id` is only ever written by the birthday / anniversary
 * template, which is also why a half-broken pair keeps its colour.
 */
export function alarmCategoryOf(event: CategoryFields): AlarmCategory | null {
  if ((event.kind ?? 'normal') !== 'normal') return null;
  if (event.exam_role === 'exam') return 'exam';
  if (event.exam_role === 'session') return event.catch_up_of == null ? 'revision' : 'catch-up';
  if (event.group_id != null) return 'birthday';
  return null;
}
