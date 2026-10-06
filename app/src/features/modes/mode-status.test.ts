import { buildModeTimeline, type ModeConfig } from '@alarm-calendar/core';
import { describe, expect, it } from 'vitest';

import { BUILTIN_MODES, EXAM_MODE_ID, SICK_ID, VACATION_ID, activationRow } from './mode-fixtures';
import { currentMode, modesByDay, plannedModeAt, upcomingModes } from './mode-status';

const TZ = 'Africa/Tunis';
const NOW = new Date('2026-10-07T14:30:00.000Z');

function timeline(overrides: Partial<ModeConfig>, lead?: number) {
  return buildModeTimeline({ modes: BUILTIN_MODES, rules: [], activations: [], exams: [], ...overrides }, { timezone: TZ, ...(lead === undefined ? {} : { exam_mode_days_before: lead }) });
}

describe('currentMode', () => {
  it('is null for Normal', () => {
    expect(currentMode(timeline({}), NOW, TZ)).toBeNull();
  });

  it('an open-ended manual mode has no last day, and says when it began', () => {
    const t = timeline({ activations: [activationRow(SICK_ID, '2026-10-07T07:00:00.000Z', null)] });
    const current = currentMode(t, NOW, TZ)!;
    expect(current).toMatchObject({ source: 'manual', lastDay: null, examId: null });
    expect(current.mode.builtin_key).toBe('sick');
    expect(current.startedAt.toISOString()).toBe('2026-10-07T07:00:00.000Z');
  });

  it('a range has the last day it covers, not the day after', () => {
    const t = timeline({ activations: [activationRow(VACATION_ID, '2026-10-05T23:00:00.000Z', '2026-10-09T23:00:00.000Z', 'range')] });
    expect(currentMode(t, NOW, TZ)).toMatchObject({ source: 'range', lastDay: '2026-10-09' });
  });

  it('an exam window names its exam and ends the day after it', () => {
    const t = timeline({ exams: [{ id: 'x1', exam_at: '2026-10-12T07:00:00.000Z', active: true }] });
    expect(currentMode(t, NOW, TZ)).toMatchObject({ source: 'exam', examId: 'x1', lastDay: '2026-10-13' });
  });
});

describe('upcomingModes', () => {
  it('lists planned modes that have not started, soonest first, without manual or running ones', () => {
    const t = timeline({
      activations: [
        activationRow(VACATION_ID, '2026-10-20T23:00:00.000Z', '2026-10-25T23:00:00.000Z', 'range'),
        activationRow(SICK_ID, '2026-10-07T07:00:00.000Z', null),
      ],
      exams: [{ id: 'x1', exam_at: '2026-10-30T07:00:00.000Z', active: true }],
    });
    const upcoming = upcomingModes(t, BUILTIN_MODES, NOW, TZ, 5);
    expect(upcoming.map((item) => [item.mode.builtin_key, item.source, item.startDay, item.lastDay])).toEqual([
      ['vacation', 'range', '2026-10-21', '2026-10-25'],
      ['exam', 'exam', '2026-10-20', '2026-10-31'],
    ].sort((a, b) => String(a[2]).localeCompare(String(b[2]))));
    expect(upcoming[1]?.examId).toBeNull();
    expect(upcoming.find((item) => item.source === 'exam')?.examId).toBe('x1');
  });

  it('honours the limit', () => {
    const t = timeline({
      activations: [
        activationRow(VACATION_ID, '2026-10-20T23:00:00.000Z', '2026-10-21T23:00:00.000Z', 'range'),
        activationRow(VACATION_ID, '2026-11-20T23:00:00.000Z', '2026-11-21T23:00:00.000Z', 'range'),
      ],
    });
    expect(upcomingModes(t, BUILTIN_MODES, NOW, TZ, 1)).toHaveLength(1);
  });
});

describe('plannedModeAt: what a manual switch would go back to', () => {
  it('is the range (over the exam window) that is running underneath, or null', () => {
    const exams = [{ id: 'x1', exam_at: '2026-10-12T07:00:00.000Z', active: true }];
    expect(plannedModeAt(timeline({}), BUILTIN_MODES, NOW)).toBeNull();
    expect(plannedModeAt(timeline({ exams }), BUILTIN_MODES, NOW)).toMatchObject({ source: 'exam' });
    const withRange = timeline({
      exams,
      activations: [
        activationRow(VACATION_ID, '2026-10-05T23:00:00.000Z', '2026-10-09T23:00:00.000Z', 'range'),
        activationRow(SICK_ID, '2026-10-07T07:00:00.000Z', null),
      ],
    });
    const planned = plannedModeAt(withRange, BUILTIN_MODES, NOW)!;
    expect(planned.source).toBe('range');
    expect(planned.mode.id).toBe(VACATION_ID);
  });
});

describe('modesByDay: the calendar marking', () => {
  it('marks the days a mode covers, by the local day, and leaves Normal days out', () => {
    const t = timeline({ activations: [activationRow(VACATION_ID, '2026-10-07T23:00:00.000Z', '2026-10-09T23:00:00.000Z', 'range')] });
    const days = modesByDay(t, '2026-10-05', '2026-10-12', TZ);
    expect([...days.keys()]).toEqual(['2026-10-08', '2026-10-09']);
    expect(days.get('2026-10-08')?.builtin_key).toBe('vacation');
  });

  it('a day split between two modes shows the one that covers more of it', () => {
    // Sick from 18:00 local on the 8th over a vacation range: the 8th is mostly vacation, the 9th mostly sick.
    const t = timeline({
      activations: [
        activationRow(VACATION_ID, '2026-10-07T23:00:00.000Z', '2026-10-10T23:00:00.000Z', 'range'),
        activationRow(SICK_ID, '2026-10-08T17:00:00.000Z', '2026-10-09T23:00:00.000Z'),
      ],
    });
    const days = modesByDay(t, '2026-10-08', '2026-10-10', TZ);
    expect(days.get('2026-10-08')?.builtin_key).toBe('vacation');
    expect(days.get('2026-10-09')?.builtin_key).toBe('sick');
  });

  it('is empty when no mode can take effect', () => {
    expect(modesByDay(timeline({}), '2026-10-05', '2026-10-12', TZ).size).toBe(0);
  });

  it('marks the exam window days with the Exam mode', () => {
    const t = timeline({ exams: [{ id: 'x1', exam_at: '2026-10-12T07:00:00.000Z', active: true }] }, 2);
    const days = modesByDay(t, '2026-10-08', '2026-10-16', TZ);
    expect([...days.keys()]).toEqual(['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13']);
    expect(days.get('2026-10-10')?.id).toBe(EXAM_MODE_ID);
  });
});
