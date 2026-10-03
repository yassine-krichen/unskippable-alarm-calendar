import type { PassWallet } from './types';
import {
  dateStringFromDayNumber,
  dayNumberFromDateString,
  localDateString,
  toWallClock,
  weekdayOfDayNumber,
} from './time-zone';

export const INITIAL_PASS_BALANCE = 1;

export type UsePassError = 'no_passes_left' | 'day_in_past' | 'already_cheat_day';
export type RefundPassError = 'not_a_cheat_day' | 'day_not_in_future';

export type UsePassResult =
  | { ok: true; wallet: PassWallet; cheatDays: string[] }
  | { ok: false; error: UsePassError };

export type RefundPassResult =
  | { ok: true; wallet: PassWallet; cheatDays: string[] }
  | { ok: false; error: RefundPassError };

/**
 * Local start-of-week date ('yyyy-MM-dd') of the week containing date.
 * weekStartsOn uses Monday = 0, like repeat_weekdays and settings.week_starts_on.
 */
export function weekStart(date: Date, tz: string, weekStartsOn: number): string {
  if (!Number.isInteger(weekStartsOn) || weekStartsOn < 0 || weekStartsOn > 6) {
    throw new RangeError(`weekStartsOn must be an integer 0 to 6, got ${weekStartsOn}`);
  }
  const { dayNumber } = toWallClock(date, tz);
  const daysSinceWeekStart = (weekdayOfDayNumber(dayNumber) - weekStartsOn + 7) % 7;
  return dateStringFromDayNumber(dayNumber - daysSinceWeekStart);
}

/**
 * A new account's wallet, as created at signup. It is un-anchored: the first
 * syncWallet copies the user's real settings without granting (the signup
 * settings are defaults, so a grant computed from them would be bogus).
 */
export function createInitialWallet(
  userId: string,
  now: Date,
  tz: string,
  weekStartsOn: number
): PassWallet {
  return {
    user_id: userId,
    balance: INITIAL_PASS_BALANCE,
    last_granted_week_start: weekStart(now, tz, weekStartsOn),
    timezone: tz,
    week_starts_on: weekStartsOn,
    anchored_at: null,
  };
}

/**
 * The local date that pass decisions (usePass, refundPass) treat as today:
 * the latest of the local date in the wallet's zone before the sync, in the
 * wallet's zone after it, and in the current settings zone. A zone switch,
 * including one adopted by syncWallet at a grant boundary, can only make the
 * decision stricter, never move today backwards. Mirrors private.pass_today.
 */
export function passToday(
  walletBeforeSync: PassWallet,
  walletAfterSync: PassWallet,
  now: Date,
  settingsTz: string
): string {
  // 'yyyy-MM-dd' strings sort chronologically.
  return [walletBeforeSync.timezone, walletAfterSync.timezone, settingsTz]
    .map((tz) => localDateString(now, tz))
    .reduce((latest, day) => (day > latest ? day : latest));
}

/**
 * Weekly grants, mirroring private.sync_wallet.
 *
 * tz and weekStartsOn are the current settings. The wallet works on its own
 * snapshot of them, and only takes the settings over in two cases:
 *  - first sync (anchored_at null): copy them and set last_granted_week_start
 *    to the current week start without granting.
 *  - at a grant boundary: apply the grants under the old snapshot, then adopt
 *    the settings. If their week start would land before the one just granted
 *    for, it moves forward by whole weeks, so the next grant is never earlier
 *    than 7 days after this one however often the settings are changed.
 * Grants are whole weeks between two week starts of the same snapshot, capped.
 */
export function syncWallet(
  wallet: PassWallet,
  now: Date,
  tz: string,
  weekStartsOn: number,
  passCap: number
): PassWallet {
  if (wallet.anchored_at === null) {
    return {
      ...wallet,
      timezone: tz,
      week_starts_on: weekStartsOn,
      last_granted_week_start: weekStart(now, tz, weekStartsOn),
      anchored_at: now.toISOString(),
    };
  }

  const currentWeekStart = dayNumberFromDateString(
    weekStart(now, wallet.timezone, wallet.week_starts_on)
  );
  const grants = Math.trunc(
    (currentWeekStart - dayNumberFromDateString(wallet.last_granted_week_start)) / 7
  );
  if (grants <= 0) return wallet;

  let newWeekStart = dayNumberFromDateString(weekStart(now, tz, weekStartsOn));
  while (newWeekStart < currentWeekStart) newWeekStart += 7;

  return {
    ...wallet,
    balance: Math.min(wallet.balance + grants, passCap),
    last_granted_week_start: dateStringFromDayNumber(newWeekStart),
    timezone: tz,
    week_starts_on: weekStartsOn,
  };
}

/** Checks run in the same order as the SQL RPC: balance, past day, duplicate. */
export function usePass(
  wallet: PassWallet,
  cheatDays: readonly string[],
  day: string,
  today: string
): UsePassResult {
  dayNumberFromDateString(day);
  if (wallet.balance <= 0) return { ok: false, error: 'no_passes_left' };
  if (day < today) return { ok: false, error: 'day_in_past' };
  if (cheatDays.includes(day)) return { ok: false, error: 'already_cheat_day' };
  return {
    ok: true,
    wallet: { ...wallet, balance: wallet.balance - 1 },
    cheatDays: [...cheatDays, day].sort(),
  };
}

/** Only strictly future days refund; today's cheat day cannot be undone. */
export function refundPass(
  wallet: PassWallet,
  cheatDays: readonly string[],
  day: string,
  today: string,
  passCap: number
): RefundPassResult {
  dayNumberFromDateString(day);
  if (!cheatDays.includes(day)) return { ok: false, error: 'not_a_cheat_day' };
  if (day <= today) return { ok: false, error: 'day_not_in_future' };
  return {
    ok: true,
    wallet: { ...wallet, balance: Math.min(wallet.balance + 1, passCap) },
    cheatDays: cheatDays.filter((d) => d !== day),
  };
}
