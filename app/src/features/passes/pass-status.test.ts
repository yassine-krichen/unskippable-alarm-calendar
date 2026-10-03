import { describe, expect, it } from 'vitest';

import {
  nextPassDay,
  nextPassLabel,
  passChipLabel,
  passTodayFromSnapshots,
  walletSnapshotSchema,
  type WalletSnapshot,
} from './pass-status';

function wallet(overrides: Partial<WalletSnapshot> = {}): WalletSnapshot {
  return {
    balance: 1,
    // Monday
    last_granted_week_start: '2026-09-28',
    timezone: 'UTC',
    week_starts_on: 0,
    ...overrides,
  };
}

describe('pass chip', () => {
  it('reads "Pass 1/2"', () => {
    expect(passChipLabel(1, 2)).toBe('Pass 1/2');
    expect(passChipLabel(0, 2)).toBe('Pass 0/2');
  });

  it('names the weekday the next pass arrives', () => {
    expect(nextPassDay(wallet())).toBe('2026-10-05');
    expect(nextPassLabel(wallet(), 2)).toBe('Next pass: Monday');
    // A Sunday-first week grants on Sunday.
    expect(nextPassLabel(wallet({ last_granted_week_start: '2026-09-27', week_starts_on: 6 }), 2)).toBe(
      'Next pass: Sunday'
    );
  });

  it('says "At cap" instead of a weekday when the wallet is full', () => {
    expect(nextPassLabel(wallet({ balance: 2 }), 2)).toBe('At cap');
  });

  it('still shows a next pass at zero', () => {
    expect(nextPassLabel(wallet({ balance: 0 }), 2)).toBe('Next pass: Monday');
  });
});

describe('passTodayFromSnapshots', () => {
  const now = new Date('2026-10-03T12:00:00Z');

  it('uses the latest local date of the wallet zones and the settings zone', () => {
    // 12:00 UTC is already Oct 4 in Auckland (UTC+13), still Oct 3 in UTC and Oct 3 in New York.
    const utc = wallet({ timezone: 'UTC' });
    const auckland = wallet({ timezone: 'Pacific/Auckland' });
    expect(passTodayFromSnapshots(utc, utc, now, 'UTC', 'u1')).toBe('2026-10-03');
    expect(passTodayFromSnapshots(utc, utc, now, 'Pacific/Auckland', 'u1')).toBe('2026-10-04');
    expect(passTodayFromSnapshots(auckland, utc, now, 'America/New_York', 'u1')).toBe('2026-10-04');
    expect(passTodayFromSnapshots(utc, auckland, now, 'America/New_York', 'u1')).toBe('2026-10-04');
  });
});

describe('walletSnapshotSchema', () => {
  it('accepts the json the RPCs return', () => {
    expect(walletSnapshotSchema.safeParse(wallet()).success).toBe(true);
  });

  it('rejects a malformed response instead of trusting it', () => {
    expect(walletSnapshotSchema.safeParse({ balance: '1' }).success).toBe(false);
    expect(walletSnapshotSchema.safeParse({ ...wallet(), balance: -1 }).success).toBe(false);
    expect(walletSnapshotSchema.safeParse(null).success).toBe(false);
  });
});
