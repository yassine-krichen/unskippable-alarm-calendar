import type { EventRow } from '@alarm-calendar/core';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { expandOccurrences, toCalendarEvent } from '@/features/calendar/calendar-events';

import {
  CATEGORY_CHIP_CLASS,
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  alarmCategoryOf,
  type AlarmCategory,
} from './category-colors';
import { EVENT_COLORS } from './event-colors';

const GROUP = '22222222-2222-4222-8222-222222222222';

function eventRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: 'e1',
    user_id: 'u1',
    title: 'Alarm',
    notes: null,
    start_at: '2026-10-05T08:00:00.000Z',
    duration_min: 15,
    repeat_unit: 'none',
    repeat_interval: 1,
    repeat_weekdays: null,
    ends_at: null,
    max_snoozes: 3,
    snooze_minutes: 5,
    passable: true,
    color: null,
    active: true,
    updated_at: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

describe('alarmCategoryOf', () => {
  it('maps the birthday template, the exam alarm, revision sessions and catch-ups to their category', () => {
    expect(alarmCategoryOf(eventRow({ group_id: GROUP, repeat_unit: 'year' }))).toBe('birthday');
    expect(alarmCategoryOf(eventRow({ exam_id: 'x1', exam_role: 'exam' }))).toBe('exam');
    expect(alarmCategoryOf(eventRow({ exam_id: 'x1', exam_role: 'session' }))).toBe('revision');
    expect(alarmCategoryOf(eventRow({ exam_id: 'x1', exam_role: 'session', catch_up_of: 's1' }))).toBe('catch-up');
  });

  it('leaves ordinary alarms and the prayers without one', () => {
    expect(alarmCategoryOf(eventRow())).toBeNull();
    expect(alarmCategoryOf(eventRow({ color: '#ef4444', group_id: null, exam_role: null }))).toBeNull();
    expect(alarmCategoryOf(eventRow({ kind: 'prayer', prayer: 'fajr' }))).toBeNull();
    expect(alarmCategoryOf(eventRow({ kind: 'pre_prayer', prayer: 'fajr' }))).toBeNull();
  });
});

describe('category colors in the calendar', () => {
  const range = { from: new Date('2026-10-05T00:00:00Z'), to: new Date('2026-10-06T00:00:00Z') };
  const calendarEventOf = (event: EventRow) =>
    toCalendarEvent(expandOccurrences([event], range, { timezone: 'UTC' }, [])[0]!);

  it('gives a birthday alarm its category chip and fixed color even when the row carries a picked one', () => {
    const calendarEvent = calendarEventOf(
      eventRow({ group_id: GROUP, repeat_unit: 'year', color: '#ef4444', start_at: '2025-10-05T08:00:00.000Z' })
    );
    expect(calendarEvent.className).toContain(CATEGORY_CHIP_CLASS.birthday);
    expect(calendarEvent.color).toBe(CATEGORY_COLORS.birthday.color);
    expect(calendarEvent.contrastColor).toBe(CATEGORY_COLORS.birthday.contrast);
    expect(calendarEvent.extendedProps.category).toBe('birthday');
  });

  it('colors the exam alarm, revision sessions and catch-ups from the exam family', () => {
    const exam = calendarEventOf(eventRow({ exam_id: 'x1', exam_role: 'exam' }));
    const revision = calendarEventOf(eventRow({ exam_id: 'x1', exam_role: 'session' }));
    const catchUp = calendarEventOf(eventRow({ exam_id: 'x1', exam_role: 'session', catch_up_of: 's1' }));
    expect(exam.className).toBe('cat-exam');
    expect(revision.className).toBe('cat-revision');
    expect(catchUp.className).toBe('cat-catch-up');
    expect(exam.color).toBe('var(--cat-exam-solid)');
    expect(revision.color).toBe(catchUp.color);
  });

  it('keeps the picked color on an ordinary alarm', () => {
    const calendarEvent = calendarEventOf(eventRow({ color: '#3b82f6' }));
    expect(calendarEvent.color).toBe('#3b82f6');
    expect(calendarEvent.className).toBe('');
  });
});

describe('the fixed colors', () => {
  const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');
  const categories = Object.keys(CATEGORY_LABELS) as AlarmCategory[];

  it('are CSS tokens defined for the light theme and again for the dark one', () => {
    const light = css.slice(css.indexOf(':root {', css.indexOf('Fixed category colours')));
    const dark = css.slice(css.indexOf('.dark {', css.indexOf('Fixed category colours')));
    const tokens = new Set(
      categories.flatMap((category) =>
        [CATEGORY_COLORS[category].color, CATEGORY_COLORS[category].contrast].map((value) => /--[a-z-]+/.exec(value)![0])
      )
    );
    expect(tokens.size).toBeGreaterThanOrEqual(6);
    for (const token of tokens) {
      expect(light, `${token} in the light theme`).toContain(`${token}:`);
      expect(dark, `${token} in the dark theme`).toContain(`${token}:`);
    }
    for (const category of categories) expect(css).toContain(`.${CATEGORY_CHIP_CLASS[category]}`);
  });

  it('are not hex colors, so none of them can be a color the picker offers', () => {
    const picker = new Set(EVENT_COLORS.map((color) => color.value.toLowerCase()));
    for (const category of categories) {
      expect(picker.has(CATEGORY_COLORS[category].color.toLowerCase())).toBe(false);
      expect(CATEGORY_COLORS[category].color).toMatch(/^var\(--cat-/);
    }
  });

  it('use one hue per family: 8 (rose) for birthdays and 275 (indigo) for the exam family', () => {
    const hues = [...css.matchAll(/--cat-[a-z-]+:\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/g)].map((match) => Number(match[3]));
    expect(hues).toHaveLength(16);
    expect(new Set(hues)).toEqual(new Set([8, 275]));
  });
});
