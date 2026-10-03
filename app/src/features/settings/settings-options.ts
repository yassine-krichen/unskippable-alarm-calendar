import { z } from 'zod';

import { weekdayName } from '@/lib/zoned-time';

export interface Option {
  value: number;
  label: string;
}

export const WEEK_START_OPTIONS: readonly Option[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  value: weekday,
  label: weekdayName(weekday),
}));

export const REFIRE_OPTIONS: readonly Option[] = [
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 120, label: '2 minutes' },
  { value: 180, label: '3 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
];

export const GRACE_OPTIONS: readonly Option[] = [
  { value: 0, label: 'No grace, skip anything missed' },
  { value: 5, label: '5 minutes' },
  { value: 10, label: '10 minutes' },
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: 120, label: '2 hours' },
];

/** Adds the stored value when it is not one of the presets, so the picker never shows a blank. */
export function withCurrentOption(options: readonly Option[], current: number, unitLabel: (n: number) => string): Option[] {
  if (options.some((option) => option.value === current)) return [...options];
  return [...options, { value: current, label: unitLabel(current) }].sort((a, b) => a.value - b.value);
}

export function seconds(value: number): string {
  return `${value} seconds`;
}

export function minutes(value: number): string {
  return `${value} minutes`;
}

export interface SoundOption {
  id: string;
  label: string;
}

// Placeholder names: the three bundled alarm sounds arrive with the platform apps.
export const SOUND_OPTIONS: readonly SoundOption[] = [
  { id: 'bell', label: 'Classic bell' },
  { id: 'chime', label: 'Rising chime' },
  { id: 'pulse', label: 'Digital pulse' },
];

export const DEFAULT_SOUND_ID = SOUND_OPTIONS[0]?.id ?? 'bell';

/** Valid IANA zone names the browser knows, with UTC and the current value always present. */
export function listTimeZones(current: string): string[] {
  const zones = new Set<string>(['UTC', current]);
  try {
    for (const zone of Intl.supportedValuesOf('timeZone')) zones.add(zone);
  } catch {
    // Older engines lack supportedValuesOf; the two seeded names keep the picker usable.
  }
  return [...zones].sort((a, b) => a.localeCompare(b));
}

export const settingsFormSchema = z.object({
  timezone: z.string().min(1, 'Pick a time zone.'),
  weekStartsOn: z.number().int().min(0).max(6),
  refireSeconds: z.number().int().min(1, 'Must be at least 1 second.'),
  graceMinutes: z.number().int().min(0, 'Can not be negative.'),
});

export type SettingsFormValues = z.infer<typeof settingsFormSchema>;
