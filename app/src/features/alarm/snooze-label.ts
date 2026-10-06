// Core's label is "Snooze 5 min (2 left)". The panel is narrow, so it shows the shorter
// "Snooze 5 min · 2 left". Anything that does not match is shown unchanged.
const CORE_SNOOZE_LABEL = /^Snooze (\d+) min \((\d+) left\)$/;

export function shortSnoozeLabel(label: string): string {
  const match = CORE_SNOOZE_LABEL.exec(label);
  return match === null ? label : `Snooze ${match[1]} min · ${match[2]} left`;
}
