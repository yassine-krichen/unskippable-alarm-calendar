import type { EventRow, ModeActivationRow, ModeRow, ModeRuleRow } from '@alarm-calendar/core';

// Fixtures shared by the mode tests (not shipped: only the .test.ts files import it).

export const SICK_ID = '00000000-0000-4000-8000-0000000000e4';
export const EXAM_MODE_ID = '00000000-0000-4000-8000-0000000000e1';
export const RAMADAN_ID = '00000000-0000-4000-8000-0000000000e2';
export const VACATION_ID = '00000000-0000-4000-8000-0000000000e3';
export const CUSTOM_ID = '00000000-0000-4000-8000-0000000000e5';

export function modeRow(id: string, key: ModeRow['builtin_key'], overrides: Partial<ModeRow> = {}): ModeRow {
  return {
    id,
    user_id: 'u1',
    name: key === null ? 'Hackathon' : key.charAt(0).toUpperCase() + key.slice(1),
    kind: key === null ? 'custom' : 'builtin',
    builtin_key: key,
    default_behavior: key === 'sick' || key === 'vacation' ? 'skip' : 'keep',
    active: true,
    updated_at: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

export const BUILTIN_MODES: ModeRow[] = [
  modeRow(EXAM_MODE_ID, 'exam'),
  modeRow(RAMADAN_ID, 'ramadan'),
  modeRow(VACATION_ID, 'vacation'),
  modeRow(SICK_ID, 'sick'),
];

let activationCounter = 0;
export function activationRow(
  modeId: string,
  startsAt: string,
  endsAt: string | null,
  source: ModeActivationRow['source'] = 'manual'
): ModeActivationRow {
  activationCounter += 1;
  return {
    id: `a0000000-0000-4000-8000-${String(activationCounter).padStart(12, '0')}`,
    user_id: 'u1',
    mode_id: modeId,
    starts_at: startsAt,
    ends_at: endsAt,
    source,
    updated_at: '2026-03-01T00:00:00.000Z',
  };
}

export function ruleRow(modeId: string, eventId: string, overrides: Partial<ModeRuleRow> = {}): ModeRuleRow {
  return {
    id: `b0000000-0000-4000-8000-${modeId.slice(-4)}${eventId.padStart(8, '0').slice(-8)}`,
    user_id: 'u1',
    mode_id: modeId,
    event_id: eventId,
    behavior: 'keep',
    shift_minutes: null,
    duration_min: null,
    updated_at: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

export function eventRow(overrides: Partial<EventRow> & { id: string }): EventRow {
  return {
    user_id: 'u1',
    title: 'Gym',
    notes: null,
    start_at: '2026-10-05T08:00:00.000Z',
    duration_min: 30,
    repeat_unit: 'day',
    repeat_interval: 1,
    repeat_weekdays: null,
    ends_at: null,
    max_snoozes: 3,
    snooze_minutes: 5,
    passable: true,
    color: null,
    active: true,
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}
