import { prayerDeferralChoices, type PrayerChoices } from '@alarm-calendar/core';
import { describe, expect, it } from 'vitest';

import { nextChoiceChangeMs } from './choice-changes';

const MINUTE = 60_000;
const AT = Date.parse('2026-11-02T12:00:00.000Z');
const END = AT + 180 * MINUTE;

function choicesAt(nowMs: number): PrayerChoices {
  return {
    ...prayerDeferralChoices(AT, END, nowMs, false),
    windowEnd: new Date(END).toISOString(),
    lastCallAt: new Date(END - 20 * MINUTE).toISOString(),
  };
}

describe('nextChoiceChangeMs', () => {
  it('is when the first Later option stops fitting, while that comes before the last call', () => {
    // 100 minutes left: +60 fits until 70 minutes are left (30 minutes from now); the give-up button is 79 minutes away.
    const now = END - 100 * MINUTE;
    expect(nextChoiceChangeMs(choicesAt(now), now)).toBe(END - 70 * MINUTE + 1);
  });

  it("is a minute before the last call once no Later option is left, and that is when Can't now turns", () => {
    const now = END - 25 * MINUTE;
    const next = nextChoiceChangeMs(choicesAt(now), now)!;
    expect(next).toBe(END - 21 * MINUTE);
    // At that instant the engine says give_up, which is what the redraw will show.
    expect(prayerDeferralChoices(AT, END, next, false).cantNow).toBe('give_up');
    expect(prayerDeferralChoices(AT, END, next - 1, false).cantNow).toBe('until_last_call');
  });

  it('is the instant an option stops fitting, to the millisecond', () => {
    const now = END - 100 * MINUTE;
    const next = nextChoiceChangeMs(choicesAt(now), now)!;
    expect(prayerDeferralChoices(AT, END, next - 1, false).laterMinutes).toContain(60);
    expect(prayerDeferralChoices(AT, END, next, false).laterMinutes).not.toContain(60);
  });

  it('is null when nothing is left to change (the give-up button and no Later option)', () => {
    const now = END - 15 * MINUTE;
    expect(nextChoiceChangeMs(choicesAt(now), now)).toBeNull();
  });
});
