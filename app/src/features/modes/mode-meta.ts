import type { ModeRow } from '@alarm-calendar/core';

/** One sentence on what a mode does to an alarm that has no rule of its own. */
export function defaultBehaviorSummary(mode: Pick<ModeRow, 'default_behavior'>): string {
  return mode.default_behavior === 'skip'
    ? 'Pauses every alarm that can be paused. Alarms that always ring, like medication and prayers, keep ringing.'
    : 'Alarms keep ringing as usual, except the ones you set a rule for.';
}

/** What the mode is for, shown on the Modes screen under its name. */
export function modePurpose(mode: Pick<ModeRow, 'builtin_key' | 'kind'>): string {
  switch (mode.builtin_key) {
    case 'exam':
      return 'For the stretch around an exam. Switches on by itself before each exam.';
    case 'ramadan':
      return 'For Ramadan: move or shorten alarms around fasting hours.';
    case 'vacation':
      return 'For a trip: pause the routine without losing your ranks.';
    case 'sick':
      return 'For a sick day or a sick week: pause everything that can wait.';
    default:
      return 'Your own mode.';
  }
}

/** The label of a mode in the lists; "Normal" is the absence of a mode. */
export const NORMAL_LABEL = 'Normal';

/** The built-ins first in a fixed order, then custom modes by name; a deleted custom mode is hidden. */
export function listableModes(modes: readonly ModeRow[]): ModeRow[] {
  const order = ['exam', 'ramadan', 'vacation', 'sick'];
  return modes
    .filter((mode) => mode.kind === 'builtin' || mode.active)
    .sort((a, b) => {
      if ((a.builtin_key === null) !== (b.builtin_key === null)) return a.builtin_key === null ? 1 : -1;
      if (a.builtin_key !== null && b.builtin_key !== null) return order.indexOf(a.builtin_key) - order.indexOf(b.builtin_key);
      return a.name.localeCompare(b.name);
    });
}

/** Modes the header switch can pick: the ones that are on. */
export function switchableModes(modes: readonly ModeRow[]): ModeRow[] {
  return listableModes(modes).filter((mode) => mode.active);
}
