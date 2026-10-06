import { describe, expect, it } from 'vitest';

import { shortSnoozeLabel } from './snooze-label';

describe('shortSnoozeLabel', () => {
  it("shortens core's label to minutes and snoozes left", () => {
    expect(shortSnoozeLabel('Snooze 5 min (2 left)')).toBe('Snooze 5 min · 2 left');
    expect(shortSnoozeLabel('Snooze 10 min (1 left)')).toBe('Snooze 10 min · 1 left');
  });

  it('shows any other text unchanged', () => {
    expect(shortSnoozeLabel('Snooze')).toBe('Snooze');
    expect(shortSnoozeLabel('Snooze 5 min · 2 left')).toBe('Snooze 5 min · 2 left');
  });
});
