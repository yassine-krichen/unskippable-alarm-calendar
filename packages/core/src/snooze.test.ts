import { describe, expect, it } from 'vitest';

import {
  applySnooze,
  canSnooze,
  isSilencedByCheatDay,
  refireAfterDismissal,
  shouldRingMissedOccurrence,
  snoozesLeft,
  snoozeUi,
} from './snooze';

const threeSnoozes = { max_snoozes: 3, snooze_minutes: 5 };
const noSnooze = { max_snoozes: 0, snooze_minutes: 5 };

describe('snooze limit', () => {
  it('allows exactly max_snoozes snoozes and then refuses', () => {
    expect([0, 1, 2, 3].map((used) => canSnooze(threeSnoozes, used))).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('never allows a snooze when max_snoozes is 0', () => {
    expect(canSnooze(noSnooze, 0)).toBe(false);
  });

  it('reports zero snoozes left rather than a negative number when over the limit', () => {
    expect(snoozesLeft(threeSnoozes, 5)).toBe(0);
  });
});

describe('snooze button text', () => {
  it('shows the snooze length and how many snoozes remain', () => {
    expect(snoozeUi(threeSnoozes, 1)).toEqual({ label: 'Snooze 5 min (2 left)', notice: null });
  });

  it('shows 1 left on the last available snooze', () => {
    expect(snoozeUi({ max_snoozes: 3, snooze_minutes: 10 }, 2).label).toBe(
      'Snooze 10 min (1 left)'
    );
  });

  it('hides the button and tells the user to act once the limit is used up', () => {
    expect(snoozeUi(threeSnoozes, 3)).toEqual({
      label: null,
      notice: 'No snoozes left, do it now',
    });
  });

  it('shows neither button nor notice when snoozing was never offered', () => {
    expect(snoozeUi(noSnooze, 0)).toEqual({ label: null, notice: null });
  });
});

describe('applying a snooze', () => {
  const now = new Date('2026-06-10T08:00:00Z');

  it('counts the snooze and re-rings after snooze_minutes', () => {
    const result = applySnooze(threeSnoozes, 0, now);
    expect(result.snoozesUsed).toBe(1);
    expect(result.refireAt.toISOString()).toBe('2026-06-10T08:05:00.000Z');
  });

  it('refuses to snooze once the limit is reached', () => {
    expect(() => applySnooze(threeSnoozes, 3, now)).toThrow(RangeError);
  });

  it('refuses to snooze when max_snoozes is 0', () => {
    expect(() => applySnooze(noSnooze, 0, now)).toThrow(RangeError);
  });

  it('lets a user snooze three times and no more', () => {
    let used = 0;
    for (let i = 0; i < 3; i++) used = applySnooze(threeSnoozes, used, now).snoozesUsed;
    expect(used).toBe(3);
    expect(canSnooze(threeSnoozes, used)).toBe(false);
  });
});

describe('re-ring after the alarm is dismissed without a choice', () => {
  it('re-rings after refire_seconds', () => {
    const result = refireAfterDismissal({ refire_seconds: 120 }, new Date('2026-06-10T08:00:00Z'));
    expect(result.toISOString()).toBe('2026-06-10T08:02:00.000Z');
  });
});

describe('grace window for missed occurrences', () => {
  const occurrence = new Date('2026-06-10T08:00:00Z');
  const minutesAfter = (minutes: number): Date => new Date(occurrence.getTime() + minutes * 60_000);

  it('rings immediately when the device wakes inside the grace window', () => {
    expect(shouldRingMissedOccurrence(occurrence, minutesAfter(10), 30, false)).toBe(true);
  });

  it('still rings at exactly the grace limit', () => {
    expect(shouldRingMissedOccurrence(occurrence, minutesAfter(30), 30, false)).toBe(true);
  });

  it('ignores an occurrence older than the grace window', () => {
    expect(shouldRingMissedOccurrence(occurrence, minutesAfter(31), 30, false)).toBe(false);
  });

  it('does not ring for an occurrence that was already completed', () => {
    expect(shouldRingMissedOccurrence(occurrence, minutesAfter(5), 30, true)).toBe(false);
  });

  it('does not treat an occurrence that has not come due yet as missed', () => {
    expect(shouldRingMissedOccurrence(occurrence, minutesAfter(-1), 30, false)).toBe(false);
  });

  it('rings only for an occurrence due exactly now when the grace window is 0', () => {
    expect(shouldRingMissedOccurrence(occurrence, occurrence, 0, false)).toBe(true);
    expect(shouldRingMissedOccurrence(occurrence, minutesAfter(1), 0, false)).toBe(false);
  });
});

describe('cheat day silencing', () => {
  const cheatDays = ['2026-06-10'];

  it('silences a passable event on a cheat day', () => {
    const occurrence = new Date('2026-06-10T08:00:00Z');
    expect(isSilencedByCheatDay({ passable: true }, occurrence, cheatDays, 'UTC')).toBe(true);
  });

  it('keeps a non-passable event ringing on a cheat day', () => {
    const occurrence = new Date('2026-06-10T08:00:00Z');
    expect(isSilencedByCheatDay({ passable: false }, occurrence, cheatDays, 'UTC')).toBe(false);
  });

  it('does not silence a passable event on a day that is not a cheat day', () => {
    const occurrence = new Date('2026-06-11T08:00:00Z');
    expect(isSilencedByCheatDay({ passable: true }, occurrence, cheatDays, 'UTC')).toBe(false);
  });

  it('judges the cheat day by the local date in the user time zone, not the UTC date', () => {
    // 23:30 UTC on 06-09 is already 06-10 in Tokyo, but still 06-09 in Los Angeles.
    const occurrence = new Date('2026-06-09T23:30:00Z');
    expect(isSilencedByCheatDay({ passable: true }, occurrence, cheatDays, 'Asia/Tokyo')).toBe(
      true
    );
    expect(
      isSilencedByCheatDay({ passable: true }, occurrence, cheatDays, 'America/Los_Angeles')
    ).toBe(false);
  });
});
