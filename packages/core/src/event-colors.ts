export interface EventColor {
  value: string;
  label: string;
  /** Text color that stays readable on top of value. */
  contrast: string;
}

// Event tags are the only place the app uses hue; the chrome stays on the b0 black and white tokens.
export const EVENT_COLORS: readonly EventColor[] = [
  { value: '#ef4444', label: 'Red', contrast: '#ffffff' },
  { value: '#f97316', label: 'Orange', contrast: '#000000' },
  { value: '#eab308', label: 'Yellow', contrast: '#000000' },
  { value: '#22c55e', label: 'Green', contrast: '#000000' },
  { value: '#3b82f6', label: 'Blue', contrast: '#ffffff' },
  { value: '#8b5cf6', label: 'Violet', contrast: '#ffffff' },
  { value: '#ec4899', label: 'Pink', contrast: '#ffffff' },
];

const EVENT_COLOR_VALUES: ReadonlySet<string> = new Set(EVENT_COLORS.map((color) => color.value));

export function isEventColor(value: string): boolean {
  return EVENT_COLOR_VALUES.has(value);
}

export function contrastFor(value: string | null): string | undefined {
  if (value === null) return undefined;
  return EVENT_COLORS.find((color) => color.value === value)?.contrast;
}
