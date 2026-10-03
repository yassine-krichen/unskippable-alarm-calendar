import { describe, expect, it } from 'vitest';

import {
  REPEAT_PRESETS,
  describeRepeat,
  repeatFormFromRule,
  repeatRuleFromForm,
  usesWeekdays,
  type RepeatPreset,
} from './repeat-presets';

const fill = (repeatPreset: RepeatPreset) => ({ repeatPreset, customInterval: 7, customUnit: 'week' as const });

describe('repeat presets', () => {
  it.each([
    ['none', 'none', 1],
    ['every-12-hours', 'hour', 12],
    ['daily', 'day', 1],
    ['every-2-days', 'day', 2],
    ['every-3-days', 'day', 3],
    ['weekly', 'week', 1],
    ['monthly', 'month', 1],
  ] as const)('%s fills repeat_unit %s and repeat_interval %i', (preset, unit, interval) => {
    expect(repeatRuleFromForm(fill(preset))).toEqual({ unit, interval });
  });

  it('reads the "Every N unit" row for custom', () => {
    expect(repeatRuleFromForm({ repeatPreset: 'custom', customInterval: 5, customUnit: 'hour' })).toEqual({
      unit: 'hour',
      interval: 5,
    });
  });

  it('maps every stored preset rule back to the same preset', () => {
    for (const preset of REPEAT_PRESETS.filter((candidate) => candidate !== 'custom')) {
      const rule = repeatRuleFromForm(fill(preset));
      expect(repeatFormFromRule(rule).repeatPreset).toBe(preset);
    }
  });

  it('shows a rule no preset produces as custom with its own interval and unit', () => {
    expect(repeatFormFromRule({ unit: 'week', interval: 2 })).toEqual({
      repeatPreset: 'custom',
      customInterval: 2,
      customUnit: 'week',
    });
    expect(repeatFormFromRule({ unit: 'hour', interval: 5 })).toMatchObject({
      repeatPreset: 'custom',
      customInterval: 5,
      customUnit: 'hour',
    });
  });

  it('offers weekday chips only for weekly rules, including custom weeks', () => {
    expect(usesWeekdays(fill('weekly'))).toBe(true);
    expect(usesWeekdays({ repeatPreset: 'custom', customInterval: 2, customUnit: 'week' })).toBe(true);
    expect(usesWeekdays({ repeatPreset: 'custom', customInterval: 2, customUnit: 'day' })).toBe(false);
    expect(usesWeekdays(fill('daily'))).toBe(false);
  });

  it('describes a rule for list rows', () => {
    expect(describeRepeat({ unit: 'none', interval: 1 })).toBe('Does not repeat');
    expect(describeRepeat({ unit: 'day', interval: 1 })).toBe('Every day');
    expect(describeRepeat({ unit: 'week', interval: 2 })).toBe('Every 2 weeks');
  });
});
