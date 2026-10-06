import { describe, expect, it } from 'vitest';

import { PRAYER_HABIT_ID } from '@alarm-calendar/core';

import { isRankPending, unrankedProgress } from './habit-view';

describe('unrankedProgress', () => {
  it('counts scored alarms for an ordinary habit', () => {
    expect(unrankedProgress({ scored: 3 })).toBe('3 of 5 scored');
    expect(unrankedProgress({ scored: 40 })).toBe('5 of 5 scored');
  });

  it('counts scored days for the pooled Prayer habit, not the 15 prayers of three days', () => {
    expect(unrankedProgress({ scored: 15, scoredDays: 3 })).toBe('3 of 5 days scored');
  });
});

describe('isRankPending', () => {
  const pending = [{ id: 'asr-row', kind: 'prayer' as const }, { id: 'weekly-row', kind: 'normal' as const }];

  it('matches an ordinary habit by its own id', () => {
    expect(isRankPending('weekly-row', pending)).toBe(true);
    expect(isRankPending('other-row', pending)).toBe(false);
  });

  it('is pending for the pooled Prayer habit when any prayer event is, whichever prayer sheet asks', () => {
    expect(isRankPending(PRAYER_HABIT_ID, pending)).toBe(true);
    expect(isRankPending(PRAYER_HABIT_ID, [{ id: 'weekly-row', kind: 'normal' as const }])).toBe(false);
    expect(isRankPending(PRAYER_HABIT_ID, [])).toBe(false);
  });
});
