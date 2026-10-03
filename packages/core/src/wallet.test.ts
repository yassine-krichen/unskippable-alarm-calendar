import { describe, expect, it } from 'vitest';

import type { PassWallet } from './types';
import {
  createInitialWallet,
  refundPass,
  syncWallet,
  passToday,
  usePass,
  weekStart,
} from './wallet';

const MONDAY_START = 0;
const CAP = 2;
/** An anchored wallet whose snapshot is UTC with a Monday week start unless given. */
const wallet = (
  balance: number,
  lastGranted: string,
  timezone = 'UTC',
  weekStartsOn = MONDAY_START
): PassWallet => ({
  user_id: 'u1',
  balance,
  last_granted_week_start: lastGranted,
  timezone,
  week_starts_on: weekStartsOn,
  anchored_at: '2026-01-01T00:00:00.000Z',
});

describe('weekStart', () => {
  it('returns the Monday of the week for a Monday-start week', () => {
    // 2026-03-04 is a Wednesday.
    expect(weekStart(new Date('2026-03-04T12:00:00Z'), 'UTC', MONDAY_START)).toBe('2026-03-02');
  });

  it('returns the same day when the date is already the first day of the week', () => {
    expect(weekStart(new Date('2026-03-02T00:00:00Z'), 'UTC', MONDAY_START)).toBe('2026-03-02');
  });

  it('puts Sunday at the end of a Monday-start week', () => {
    expect(weekStart(new Date('2026-03-08T23:00:00Z'), 'UTC', MONDAY_START)).toBe('2026-03-02');
  });

  it('honours a Sunday week start (6)', () => {
    expect(weekStart(new Date('2026-03-04T12:00:00Z'), 'UTC', 6)).toBe('2026-03-01');
  });

  it('uses the local date in the user time zone to decide the week', () => {
    // Sunday 23:30 UTC is already Monday 00:30 in Paris.
    const instant = new Date('2026-03-08T23:30:00Z');
    expect(weekStart(instant, 'UTC', MONDAY_START)).toBe('2026-03-02');
    expect(weekStart(instant, 'Europe/Paris', MONDAY_START)).toBe('2026-03-09');
  });

  it('rejects a week start outside 0 to 6', () => {
    expect(() => weekStart(new Date('2026-03-04T12:00:00Z'), 'UTC', 7)).toThrow(RangeError);
  });
});

describe('new wallet', () => {
  it('starts with one pass granted for the current week, not yet anchored', () => {
    expect(createInitialWallet('u1', new Date('2026-03-04T12:00:00Z'), 'UTC', MONDAY_START)).toEqual({
      ...wallet(1, '2026-03-02'),
      anchored_at: null,
    });
  });
});

describe('weekly grant (spec section 7 table)', () => {
  const tz = 'Europe/Paris';
  const sync = (w: PassWallet, instant: string): PassWallet =>
    syncWallet(w, new Date(instant), tz, MONDAY_START, CAP);

  it('follows weeks 1 to 4: 1 pass, grant to 2, capped grant then spend, grant then spend', () => {
    // Week 1 (starts Mon 2026-03-02): new account, nothing granted yet.
    let state = createInitialWallet('u1', new Date('2026-03-04T10:00:00Z'), tz, MONDAY_START);
    state = sync(state, '2026-03-05T10:00:00Z');
    expect(state.balance).toBe(1);

    // Week 2: +1 reaches the cap, nothing spent.
    state = sync(state, '2026-03-09T08:00:00Z');
    expect(state.balance).toBe(2);

    // Week 3: the grant is lost at the cap, then a pass is spent.
    state = sync(state, '2026-03-16T08:00:00Z');
    expect(state.balance).toBe(2);
    const week3 = usePass(state, [], '2026-03-18', '2026-03-16');
    if (!week3.ok) throw new Error('week 3 spend should succeed');
    state = week3.wallet;
    expect(state.balance).toBe(1);

    // Week 4: +1 brings it back to 2, then a pass is spent.
    state = sync(state, '2026-03-23T08:00:00Z');
    expect(state.balance).toBe(2);
    const week4 = usePass(state, week3.cheatDays, '2026-03-25', '2026-03-23');
    if (!week4.ok) throw new Error('week 4 spend should succeed');
    expect(week4.wallet.balance).toBe(1);
  });

  it('does not grant again on a second sync in the same week', () => {
    const once = sync(wallet(0, '2026-03-02'), '2026-03-10T08:00:00Z');
    const twice = sync(once, '2026-03-12T08:00:00Z');
    expect(twice).toEqual(once);
    expect(once.balance).toBe(1);
  });

  it('grants at the local Monday start, not the UTC one', () => {
    // Sunday 23:30 UTC is Monday 00:30 in Paris, so the new week has begun there.
    expect(sync(wallet(0, '2026-03-02', tz), '2026-03-08T23:30:00Z').balance).toBe(1);
    expect(
      syncWallet(wallet(0, '2026-03-02'), new Date('2026-03-08T23:30:00Z'), 'UTC', MONDAY_START, CAP)
        .balance
    ).toBe(0);
  });
});

describe('weekly grant catch-up after being away', () => {
  const sync = (w: PassWallet, instant: string, cap = CAP): PassWallet =>
    syncWallet(w, new Date(instant), 'UTC', MONDAY_START, cap);

  it('grants one pass per week missed', () => {
    const result = sync(wallet(0, '2026-03-02'), '2026-03-18T08:00:00Z', 5);
    expect(result.balance).toBe(2);
    expect(result.last_granted_week_start).toBe('2026-03-16');
  });

  it('stops at the cap however many weeks were missed', () => {
    const result = sync(wallet(0, '2026-03-02'), '2026-06-01T08:00:00Z');
    expect(result).toEqual(wallet(2, '2026-06-01'));
  });

  it('keeps a balance already at the cap when weeks were missed', () => {
    expect(sync(wallet(2, '2026-03-02'), '2026-04-01T08:00:00Z').balance).toBe(2);
  });

  it('respects a different cap from settings', () => {
    expect(sync(wallet(0, '2026-03-02'), '2026-06-01T08:00:00Z', 3).balance).toBe(3);
  });

  it('ignores a week start setting changed mid-week until the wallet reaches its own boundary', () => {
    // Sunday 2026-03-08 would be a new week under a Sunday start, but the wallet still counts Mondays.
    const unchanged = wallet(0, '2026-03-02');
    expect(syncWallet(unchanged, new Date('2026-03-08T12:00:00Z'), 'UTC', 6, CAP)).toBe(unchanged);
  });
});

describe('wallet snapshot of timezone and week start', () => {
  const sync = (w: PassWallet, instant: string, tz: string, weekStartsOn: number, cap = CAP) =>
    syncWallet(w, new Date(instant), tz, weekStartsOn, cap);

  it('re-anchors a new account on its first sync without granting a pass', () => {
    // Signup at Sunday 23:00 UTC with default UTC settings: week of 2026-03-02.
    const signedUp = createInitialWallet('u1', new Date('2026-03-08T23:00:00Z'), 'UTC', MONDAY_START);
    // The client then set Pacific/Kiritimati, where it is already Monday. Anchoring to the
    // settings must not read that as a new week.
    const result = sync(signedUp, '2026-03-08T23:30:00Z', 'Pacific/Kiritimati', MONDAY_START);
    expect(result).toEqual({
      ...signedUp,
      balance: 1,
      last_granted_week_start: '2026-03-09',
      timezone: 'Pacific/Kiritimati',
      week_starts_on: MONDAY_START,
      anchored_at: '2026-03-08T23:30:00.000Z',
    });
  });

  it('anchors only once: later settings changes wait for a grant boundary', () => {
    const signedUp = createInitialWallet('u1', new Date('2026-03-04T10:00:00Z'), 'UTC', MONDAY_START);
    const anchored = sync(signedUp, '2026-03-04T11:00:00Z', 'UTC', MONDAY_START);
    expect(sync(anchored, '2026-03-05T11:00:00Z', 'Asia/Tokyo', 6)).toBe(anchored);
  });

  it('adopts new settings at a grant boundary, after granting under the old snapshot', () => {
    // Monday 2026-03-09 12:00 UTC is Monday 21:00 in Tokyo: same week start in both zones.
    const result = sync(wallet(0, '2026-03-02'), '2026-03-09T12:00:00Z', 'Asia/Tokyo', MONDAY_START);
    expect(result).toEqual(wallet(1, '2026-03-09', 'Asia/Tokyo', MONDAY_START));
  });

  it('pushes the next boundary out when the adopted week start would fall earlier', () => {
    // A Sunday-start week containing Monday 03-09 began on 03-08, before the boundary just
    // granted for, so Sunday 03-15 would grant again six days later. 03-15 counts as already
    // granted instead.
    const result = sync(wallet(0, '2026-03-02'), '2026-03-09T12:00:00Z', 'UTC', 6);
    expect(result).toEqual(wallet(1, '2026-03-15', 'UTC', 6));
    expect(sync(result, '2026-03-15T12:00:00Z', 'UTC', 6)).toBe(result);
    expect(sync(result, '2026-03-22T12:00:00Z', 'UTC', 6).balance).toBe(2);
  });

  const gaps = (days: number[]): number[] => days.slice(1).map((day, i) => day - (days[i] ?? day));

  it('cannot farm passes by cycling week_starts_on every day', () => {
    const cap = 100;
    const grantDays: number[] = [];
    let cycling = wallet(0, '2026-06-01');
    let steady = wallet(0, '2026-06-01');
    const firstDay = Date.UTC(2026, 5, 2);
    for (let i = 0; i < 70; i += 1) {
      const instant = new Date(firstDay + i * 86_400_000 + 12 * 3_600_000);
      const next = syncWallet(cycling, instant, 'UTC', i % 7, cap);
      if (next.balance > cycling.balance) grantDays.push(i);
      cycling = next;
      steady = syncWallet(steady, instant, 'UTC', MONDAY_START, cap);
    }
    expect(grantDays.length).toBeGreaterThan(0);
    expect(Math.min(...gaps(grantDays))).toBeGreaterThanOrEqual(7);
    expect(cycling.balance).toBeLessThanOrEqual(steady.balance);
  });

  it('cannot farm passes by cycling the time zone either', () => {
    const cap = 100;
    const zones = ['Pacific/Kiritimati', 'Etc/GMT+12', 'UTC', 'America/Los_Angeles'];
    const grantDays: number[] = [];
    let cycling = wallet(0, '2026-06-01');
    const firstDay = Date.UTC(2026, 5, 2);
    for (let i = 0; i < 70; i += 1) {
      const instant = new Date(firstDay + i * 86_400_000 + 12 * 3_600_000);
      const next = syncWallet(cycling, instant, zones[i % zones.length] ?? 'UTC', MONDAY_START, cap);
      if (next.balance > cycling.balance) grantDays.push(i);
      cycling = next;
    }
    // A zone change can shift a boundary by about a day, never by a week.
    expect(Math.min(...gaps(grantDays))).toBeGreaterThanOrEqual(6);
  });

  it("cannot refund today's cheat day by switching to a zone where today has not started", () => {
    // 2026-03-04 05:00 UTC: Wednesday in UTC, still Tuesday evening in Pago Pago.
    const now = new Date('2026-03-04T05:00:00Z');
    const before = wallet(1, '2026-03-02');
    const synced = syncWallet(before, now, 'Pacific/Pago_Pago', MONDAY_START, CAP);
    const today = passToday(before, synced, now, 'Pacific/Pago_Pago');
    expect(today).toBe('2026-03-04');
    expect(refundPass(synced, ['2026-03-04'], '2026-03-04', today, CAP)).toEqual({
      ok: false,
      error: 'day_not_in_future',
    });
  });

  it('cannot spend a pass on yesterday by switching to a zone where today has not started', () => {
    const now = new Date('2026-03-04T05:00:00Z');
    const before = wallet(1, '2026-03-02');
    const synced = syncWallet(before, now, 'Pacific/Pago_Pago', MONDAY_START, CAP);
    expect(usePass(synced, [], '2026-03-03', passToday(before, synced, now, 'Pacific/Pago_Pago'))).toEqual({
      ok: false,
      error: 'day_in_past',
    });
  });

  describe('timezone switch timed at a grant boundary', () => {
    // 2026-04-12T12:00Z is already Monday 2026-04-13 02:00 in Kiritimati (+14) and still
    // Sunday 2026-04-12 01:00 in Pago Pago (-11).
    const boundary = new Date('2026-04-12T12:00:00Z');
    const before = wallet(0, '2026-04-06', 'Pacific/Kiritimati');

    it('cannot refund a cheat day that has started in the previous zone', () => {
      const synced = syncWallet(before, boundary, 'Pacific/Pago_Pago', MONDAY_START, CAP);
      // The sync crossed the boundary and adopted the new zone, where today is still the 12th.
      expect(synced.timezone).toBe('Pacific/Pago_Pago');
      expect(synced.balance).toBe(1);
      const today = passToday(before, synced, boundary, 'Pacific/Pago_Pago');
      expect(today).toBe('2026-04-13');
      expect(refundPass(synced, ['2026-04-13'], '2026-04-13', today, CAP)).toEqual({
        ok: false,
        error: 'day_not_in_future',
      });
    });

    it('cannot spend a pass on a real yesterday after switching back mid-week', () => {
      const synced = syncWallet(before, boundary, 'Pacific/Pago_Pago', MONDAY_START, CAP);
      // The snapshot stays Pago Pago all week, but the user's settings are Kiritimati again.
      // Thursday 2026-04-16 12:00 UTC is Friday 2026-04-17 02:00 there; the 16th is yesterday.
      const thursday = new Date('2026-04-16T12:00:00Z');
      const sameWeek = syncWallet(synced, thursday, 'Pacific/Kiritimati', MONDAY_START, CAP);
      expect(sameWeek).toBe(synced);
      const today = passToday(synced, sameWeek, thursday, 'Pacific/Kiritimati');
      expect(today).toBe('2026-04-17');
      expect(usePass(sameWeek, [], '2026-04-16', today)).toEqual({ ok: false, error: 'day_in_past' });
    });
  });

  it('keeps the wallet zone as today when settings are behind it', () => {
    const now = new Date('2026-03-09T12:00:00Z');
    const before = wallet(0, '2026-03-02');
    const synced = syncWallet(before, now, 'Pacific/Kiritimati', MONDAY_START, CAP);
    expect(passToday(before, synced, now, 'Pacific/Kiritimati')).toBe('2026-03-10');
    expect(passToday(synced, synced, now, 'UTC')).toBe('2026-03-10');
  });
});

describe('spending a pass', () => {
  const today = '2026-03-16';

  it('turns a future day into a cheat day and takes one pass', () => {
    const result = usePass(wallet(2, '2026-03-16'), [], '2026-03-20', today);
    expect(result).toEqual({
      ok: true,
      wallet: wallet(1, '2026-03-16'),
      cheatDays: ['2026-03-20'],
    });
  });

  it('lets a pass be spent on today', () => {
    expect(usePass(wallet(1, '2026-03-16'), [], today, today).ok).toBe(true);
  });

  it('fails when the balance is 0', () => {
    expect(usePass(wallet(0, '2026-03-16'), [], '2026-03-20', today)).toEqual({
      ok: false,
      error: 'no_passes_left',
    });
  });

  it('fails for a day in the past', () => {
    expect(usePass(wallet(1, '2026-03-16'), [], '2026-03-15', today)).toEqual({
      ok: false,
      error: 'day_in_past',
    });
  });

  it('fails when the day is already a cheat day', () => {
    expect(usePass(wallet(2, '2026-03-16'), ['2026-03-20'], '2026-03-20', today)).toEqual({
      ok: false,
      error: 'already_cheat_day',
    });
  });

  it('keeps cheat days sorted', () => {
    const result = usePass(wallet(2, '2026-03-16'), ['2026-03-25'], '2026-03-20', today);
    expect(result.ok && result.cheatDays).toEqual(['2026-03-20', '2026-03-25']);
  });

  it('rejects a malformed day', () => {
    expect(() => usePass(wallet(1, '2026-03-16'), [], '2026-02-30', today)).toThrow(RangeError);
  });
});

describe('refunding a pass', () => {
  const today = '2026-03-16';

  it('removes a future cheat day and gives the pass back', () => {
    const result = refundPass(wallet(1, '2026-03-16'), ['2026-03-20'], '2026-03-20', today, CAP);
    expect(result).toEqual({ ok: true, wallet: wallet(2, '2026-03-16'), cheatDays: [] });
  });

  it('does not push the balance above the cap', () => {
    const result = refundPass(wallet(2, '2026-03-16'), ['2026-03-20'], '2026-03-20', today, CAP);
    expect(result.ok && result.wallet.balance).toBe(2);
  });

  it('does not refund today because the day has begun', () => {
    expect(refundPass(wallet(1, '2026-03-16'), [today], today, today, CAP)).toEqual({
      ok: false,
      error: 'day_not_in_future',
    });
  });

  it('does not refund a past cheat day', () => {
    expect(refundPass(wallet(1, '2026-03-16'), ['2026-03-10'], '2026-03-10', today, CAP)).toEqual({
      ok: false,
      error: 'day_not_in_future',
    });
  });

  it('fails when the day is not a cheat day', () => {
    expect(refundPass(wallet(1, '2026-03-16'), [], '2026-03-20', today, CAP)).toEqual({
      ok: false,
      error: 'not_a_cheat_day',
    });
  });
});
