import { describe, expect, it } from 'vitest';

import { describeRepeatRule, describeSnooze, describeWhen } from './event-details';

describe('describeRepeatRule', () => {
  it('says so when an alarm does not repeat', () => {
    expect(describeRepeatRule({ repeat_unit: 'none', repeat_interval: 1, repeat_weekdays: null })).toBe(
      'Does not repeat'
    );
  });

  it('lists the weekdays of a weekly alarm in week order', () => {
    const text = describeRepeatRule({ repeat_unit: 'week', repeat_interval: 1, repeat_weekdays: [4, 0, 2] });
    expect(text.startsWith('Every week on ')).toBe(true);
    const names = text.replace('Every week on ', '').split(', ');
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
  });

  it('does not name all seven days of a week', () => {
    expect(describeRepeatRule({ repeat_unit: 'week', repeat_interval: 1, repeat_weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe(
      'Every week'
    );
  });

  it('reads an interval', () => {
    expect(describeRepeatRule({ repeat_unit: 'day', repeat_interval: 2, repeat_weekdays: null })).toBe('Every 2 days');
  });
});

describe('describeSnooze', () => {
  it('explains a zero limit as no snooze', () => {
    expect(describeSnooze(0, 5)).toContain('No snooze');
  });

  it('counts the snoozes and gives their length', () => {
    expect(describeSnooze(1, 5)).toBe('1 snooze, 5 min each');
    expect(describeSnooze(3, 10)).toBe('3 snoozes, 10 min each');
  });
});

describe('describeWhen', () => {
  const start = new Date('2026-11-20T09:00:00Z');

  it('says Today for the current day in the zone, with the time and length', () => {
    expect(describeWhen(start, 45, 'UTC', '2026-11-20')).toBe('Today 09:00 · 45 min');
  });

  it('names another day, using the zone for the day boundary', () => {
    const text = describeWhen(start, 30, 'Pacific/Auckland', '2026-11-20');
    // 09:00 UTC is 22:00 the same day in Auckland (UTC+13 in November).
    expect(text).toContain('22:00');
    expect(text.startsWith('Today')).toBe(true);
    expect(describeWhen(start, 30, 'UTC', '2026-11-19')).not.toContain('Today');
  });
});
