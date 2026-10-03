import type { EventRow } from '@alarm-calendar/core';
import { describe, expect, it } from 'vitest';

import {
  alignStartDate,
  createEventFormSchema,
  defaultEventFormValues,
  eventFormToWriteInput,
  eventToFormValues,
  firstAlarmDate,
  type EventFormValues,
} from './event-form';

const NOW = new Date('2026-10-03T10:00:00Z');

function values(overrides: Partial<EventFormValues> = {}): EventFormValues {
  return { ...defaultEventFormValues('2026-10-05', '09:30'), title: 'Take medication', ...overrides };
}

function schemaFor(options: { tz?: string; isNew?: boolean } = {}) {
  return createEventFormSchema({ tz: options.tz ?? 'UTC', now: () => NOW, isNew: options.isNew ?? true });
}

function issuePaths(input: EventFormValues, options?: { tz?: string; isNew?: boolean }): string[] {
  const result = schemaFor(options).safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('eventFormToWriteInput', () => {
  it('stores the time entered in the settings zone as UTC', () => {
    // Berlin is UTC+2 in October (CEST) and UTC+1 in December (CET): 09:30 wall time stays 09:30.
    expect(eventFormToWriteInput(values(), 'Europe/Berlin').start_at).toBe('2026-10-05T07:30:00.000Z');
    expect(eventFormToWriteInput(values({ startDate: '2026-12-07' }), 'Europe/Berlin').start_at).toBe(
      '2026-12-07T08:30:00.000Z'
    );
  });

  it('maps the repeat preset to unit and interval and clears weekdays for non-weekly rules', () => {
    const input = eventFormToWriteInput(values({ repeatPreset: 'every-3-days', weekdays: [1, 2] }), 'UTC');
    expect(input).toMatchObject({ repeat_unit: 'day', repeat_interval: 3, repeat_weekdays: null });
  });

  it('writes the custom "Every N unit" row', () => {
    const input = eventFormToWriteInput(
      values({ repeatPreset: 'custom', customInterval: 5, customUnit: 'hour' }),
      'UTC'
    );
    expect(input).toMatchObject({ repeat_unit: 'hour', repeat_interval: 5 });
  });

  it('sorts weekly weekdays and moves a start date that is not one of them to the first one that is', () => {
    // 2026-10-07 is a Wednesday; Monday (0) and Thursday (3) are chosen, so the series starts Thursday.
    const input = eventFormToWriteInput(
      values({ repeatPreset: 'weekly', startDate: '2026-10-07', weekdays: [3, 0] }),
      'UTC'
    );
    expect(input.repeat_weekdays).toEqual([0, 3]);
    expect(input.start_at).toBe('2026-10-08T09:30:00.000Z');
  });

  it('ends the series at the last minute of the end date in the settings zone', () => {
    const input = eventFormToWriteInput(
      values({ repeatPreset: 'daily', endsDate: '2026-11-01' }),
      'Europe/Berlin'
    );
    // 2026-11-01 23:59 CET is 22:59 UTC.
    expect(input.ends_at).toBe('2026-11-01T22:59:00.000Z');
  });

  it('ignores an end date on a one-time alarm', () => {
    expect(eventFormToWriteInput(values({ endsDate: '2026-11-01' }), 'UTC').ends_at).toBeNull();
  });

  it('trims the title and turns blank notes into null', () => {
    const input = eventFormToWriteInput(values({ title: '  Stretch  ', notes: '   ' }), 'UTC');
    expect(input.title).toBe('Stretch');
    expect(input.notes).toBeNull();
  });

  it('passes snooze, passable and color through', () => {
    const input = eventFormToWriteInput(
      values({ maxSnoozes: 0, snoozeMinutes: 10, passable: false, color: '#3b82f6' }),
      'UTC'
    );
    expect(input).toMatchObject({ max_snoozes: 0, snooze_minutes: 10, passable: false, color: '#3b82f6' });
  });
});

describe('eventFormToWriteInput around DST changes', () => {
  it('moves a wall time inside the spring-forward gap forward by the gap', () => {
    // New York, 2026-03-08: clocks jump 02:00 to 03:00, so 02:30 does not exist. It becomes 03:30 EDT.
    const input = eventFormToWriteInput(values({ startDate: '2026-03-08', startTime: '02:30' }), 'America/New_York');
    expect(input.start_at).toBe('2026-03-08T07:30:00.000Z');
  });

  it('takes the earlier instant for a wall time that happens twice in autumn', () => {
    // New York, 2026-11-01: 01:30 happens in EDT (05:30Z) and again in EST (06:30Z). The first one wins.
    const input = eventFormToWriteInput(values({ startDate: '2026-11-01', startTime: '01:30' }), 'America/New_York');
    expect(input.start_at).toBe('2026-11-01T05:30:00.000Z');
  });

  it('ends a series at 23:59 local on a transition day', () => {
    const input = eventFormToWriteInput(
      values({ repeatPreset: 'daily', startDate: '2026-03-01', endsDate: '2026-03-08' }),
      'America/New_York'
    );
    // 23:59 on the 8th is EDT (UTC-4), so 03:59 UTC on the 9th.
    expect(input.ends_at).toBe('2026-03-09T03:59:00.000Z');
  });
});

describe('eventToFormValues', () => {
  const row: EventRow = {
    id: 'e1',
    user_id: 'u1',
    title: 'Standup',
    notes: null,
    start_at: '2026-10-05T07:30:00.000Z',
    duration_min: 20,
    repeat_unit: 'week',
    repeat_interval: 2,
    repeat_weekdays: [0, 3],
    ends_at: '2026-11-01T22:59:00.000Z',
    max_snoozes: 2,
    snooze_minutes: 7,
    passable: false,
    color: '#22c55e',
    active: true,
    updated_at: '2026-10-01T00:00:00Z',
  };

  it('shows UTC columns as wall-clock values in the settings zone', () => {
    const form = eventToFormValues(row, 'Europe/Berlin');
    expect(form).toMatchObject({ startDate: '2026-10-05', startTime: '09:30', endsDate: '2026-11-01' });
    expect(form).toMatchObject({ repeatPreset: 'custom', customInterval: 2, customUnit: 'week', weekdays: [0, 3] });
  });

  it('round-trips an event through the form unchanged', () => {
    const written = eventFormToWriteInput(eventToFormValues(row, 'Europe/Berlin'), 'Europe/Berlin');
    const { id: _id, user_id: _user, active: _active, updated_at: _updated, ...columns } = row;
    expect(written).toEqual(columns);
  });

  it('uses the weekday of the start date when repeat_weekdays is null', () => {
    const form = eventToFormValues({ ...row, repeat_weekdays: null }, 'UTC');
    expect(form.weekdays).toEqual([0]);
  });
});

describe('alignStartDate', () => {
  it('keeps a start date whose weekday is selected', () => {
    expect(alignStartDate('2026-10-05', [0, 3])).toBe('2026-10-05');
  });

  it('moves forward to the next selected weekday, across a week boundary', () => {
    expect(alignStartDate('2026-10-09', [0, 3])).toBe('2026-10-12');
  });

  it('reports the date the series will really start on', () => {
    expect(firstAlarmDate(values({ repeatPreset: 'weekly', startDate: '2026-10-07', weekdays: [3] }))).toBe(
      '2026-10-08'
    );
    expect(firstAlarmDate(values({ repeatPreset: 'daily', startDate: '2026-10-07', weekdays: [3] }))).toBe(
      '2026-10-07'
    );
  });
});

describe('event form schema', () => {
  it('accepts a complete one-time alarm in the future', () => {
    expect(issuePaths(values())).toEqual([]);
  });

  it('rejects a blank title', () => {
    expect(issuePaths(values({ title: '   ' }))).toContain('title');
  });

  it('rejects a weekly rule with no weekday', () => {
    expect(issuePaths(values({ repeatPreset: 'weekly', weekdays: [] }))).toContain('weekdays');
    expect(issuePaths(values({ repeatPreset: 'daily', weekdays: [] }))).not.toContain('weekdays');
  });

  it('rejects an end date before the first alarm, measured after weekday alignment', () => {
    expect(issuePaths(values({ repeatPreset: 'daily', endsDate: '2026-10-04' }))).toContain('endsDate');
    // Starts Wed the 7th but only Thursday is chosen, so the first alarm is the 8th.
    expect(
      issuePaths(values({ repeatPreset: 'weekly', startDate: '2026-10-07', weekdays: [3], endsDate: '2026-10-07' }))
    ).toContain('endsDate');
    expect(issuePaths(values({ repeatPreset: 'daily', endsDate: '2026-10-05' }))).toEqual([]);
  });

  it('refuses a new one-time alarm in the past, but not an edit or a recurring one', () => {
    const past = values({ startDate: '2026-10-03', startTime: '09:00' });
    expect(issuePaths(past)).toContain('startDate');
    expect(issuePaths(past, { isNew: false })).toEqual([]);
    expect(issuePaths({ ...past, repeatPreset: 'daily' })).toEqual([]);
  });

  it('judges "in the past" in the settings zone, not UTC', () => {
    // 09:00 on Oct 3 in Auckland is 20:00 UTC on Oct 2, long before NOW.
    expect(issuePaths(values({ startDate: '2026-10-03', startTime: '09:00' }), { tz: 'Pacific/Auckland' })).toContain(
      'startDate'
    );
    // 00:30 on Oct 4 in Auckland is 11:30 UTC on Oct 3, an hour and a half after NOW.
    expect(issuePaths(values({ startDate: '2026-10-04', startTime: '00:30' }), { tz: 'Pacific/Auckland' })).toEqual([]);
  });

  it('keeps the snooze limit between 0 and 10', () => {
    expect(issuePaths(values({ maxSnoozes: 0 }))).toEqual([]);
    expect(issuePaths(values({ maxSnoozes: 10 }))).toEqual([]);
    expect(issuePaths(values({ maxSnoozes: 11 }))).toContain('maxSnoozes');
    expect(issuePaths(values({ maxSnoozes: -1 }))).toContain('maxSnoozes');
  });

  it('requires intervals and durations of at least 1', () => {
    expect(issuePaths(values({ snoozeMinutes: 0 }))).toContain('snoozeMinutes');
    expect(issuePaths(values({ durationMin: 0 }))).toContain('durationMin');
    expect(issuePaths(values({ repeatPreset: 'custom', customInterval: 0 }))).toContain('customInterval');
  });

  it('rejects a time that is not HH:mm and a color outside the palette', () => {
    expect(issuePaths(values({ startTime: '9:5' }))).toContain('startTime');
    expect(issuePaths(values({ color: '#123456' }))).toContain('color');
    expect(issuePaths(values({ color: '#3b82f6' }))).toEqual([]);
  });
});
