import type { RepeatUnit } from '@alarm-calendar/core';

export const REPEAT_PRESETS = [
  'none',
  'every-12-hours',
  'daily',
  'every-2-days',
  'every-3-days',
  'weekly',
  'monthly',
  'yearly',
  'custom',
] as const;

export type RepeatPreset = (typeof REPEAT_PRESETS)[number];

export type CustomRepeatUnit = Exclude<RepeatUnit, 'none'>;

export const CUSTOM_REPEAT_UNITS: readonly CustomRepeatUnit[] = ['hour', 'day', 'week', 'month', 'year'];

export interface RepeatRule {
  unit: RepeatUnit;
  interval: number;
}

export interface RepeatFormState {
  repeatPreset: RepeatPreset;
  customInterval: number;
  customUnit: CustomRepeatUnit;
}

export const REPEAT_PRESET_LABELS: Record<RepeatPreset, string> = {
  none: 'Does not repeat',
  'every-12-hours': 'Every 12 hours',
  daily: 'Every day',
  'every-2-days': 'Every 2 days',
  'every-3-days': 'Every 3 days',
  weekly: 'Every week',
  monthly: 'Every month',
  yearly: 'Every year',
  custom: 'Custom',
};

const PRESET_RULES: Record<Exclude<RepeatPreset, 'custom'>, RepeatRule> = {
  none: { unit: 'none', interval: 1 },
  'every-12-hours': { unit: 'hour', interval: 12 },
  daily: { unit: 'day', interval: 1 },
  'every-2-days': { unit: 'day', interval: 2 },
  'every-3-days': { unit: 'day', interval: 3 },
  weekly: { unit: 'week', interval: 1 },
  monthly: { unit: 'month', interval: 1 },
  yearly: { unit: 'year', interval: 1 },
};

/** Presets only fill repeat_unit and repeat_interval; custom reads the "Every N unit" row. */
export function repeatRuleFromForm(state: RepeatFormState): RepeatRule {
  if (state.repeatPreset === 'custom') {
    return { unit: state.customUnit, interval: state.customInterval };
  }
  return PRESET_RULES[state.repeatPreset];
}

/** Maps a stored rule back to the preset that produces it, or to custom when none does. */
export function repeatFormFromRule(rule: RepeatRule): RepeatFormState {
  for (const [preset, presetRule] of Object.entries(PRESET_RULES)) {
    if (presetRule.unit === rule.unit && presetRule.interval === rule.interval) {
      return { repeatPreset: preset as RepeatPreset, customInterval: 1, customUnit: 'day' };
    }
  }
  return {
    repeatPreset: 'custom',
    customInterval: rule.interval,
    customUnit: rule.unit === 'none' ? 'day' : rule.unit,
  };
}

/** Weekday chips only make sense for weekly rules. */
export function usesWeekdays(state: RepeatFormState): boolean {
  return repeatRuleFromForm(state).unit === 'week';
}

export function isRepeating(state: RepeatFormState): boolean {
  return repeatRuleFromForm(state).unit !== 'none';
}

const UNIT_LABELS: Record<CustomRepeatUnit, [singular: string, plural: string]> = {
  hour: ['hour', 'hours'],
  day: ['day', 'days'],
  week: ['week', 'weeks'],
  month: ['month', 'months'],
  year: ['year', 'years'],
};

export function repeatUnitLabel(unit: CustomRepeatUnit, interval: number): string {
  const [singular, plural] = UNIT_LABELS[unit];
  return interval === 1 ? singular : plural;
}

/** Short human summary for lists, e.g. 'Every 2 weeks'. */
export function describeRepeat(rule: RepeatRule): string {
  if (rule.unit === 'none') return 'Does not repeat';
  if (rule.interval === 1) return `Every ${repeatUnitLabel(rule.unit, 1)}`;
  return `Every ${rule.interval} ${repeatUnitLabel(rule.unit, rule.interval)}`;
}
