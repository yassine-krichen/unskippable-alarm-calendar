import { describe, expect, it } from 'vitest';

import { AUTO_CHECK_INTERVAL_MS, FAILURE_RETRY_INTERVAL_MS, isAutoCheckDue, type CheckRecord } from './check-record';

const record = (checkedAt: number | null, lastFailureAt: number | null = null): CheckRecord => ({
  checkedAt,
  etag: null,
  release: null,
  lastFailureAt,
});
const NOW = 1_800_000_000_000;

describe('isAutoCheckDue', () => {
  it('is due when this device never checked', () => {
    expect(isAutoCheckDue(null, NOW)).toBe(true);
    expect(isAutoCheckDue(record(null), NOW)).toBe(true);
  });

  it('waits a full 24 hours after the last good check', () => {
    expect(isAutoCheckDue(record(NOW - 60_000), NOW)).toBe(false);
    expect(isAutoCheckDue(record(NOW - AUTO_CHECK_INTERVAL_MS + 1), NOW)).toBe(false);
    expect(isAutoCheckDue(record(NOW - AUTO_CHECK_INTERVAL_MS), NOW)).toBe(true);
    expect(isAutoCheckDue(record(NOW - 3 * AUTO_CHECK_INTERVAL_MS), NOW)).toBe(true);
  });

  it('is due when the last check is in the future, so a clock set back cannot silence checks', () => {
    expect(isAutoCheckDue(record(NOW + 60_000), NOW)).toBe(true);
  });

  it('backs off for an hour after a failed check, even when the last good one is old or never happened', () => {
    expect(isAutoCheckDue(record(null, NOW - 60_000), NOW)).toBe(false);
    expect(isAutoCheckDue(record(NOW - 3 * AUTO_CHECK_INTERVAL_MS, NOW - FAILURE_RETRY_INTERVAL_MS + 1), NOW)).toBe(false);
    expect(isAutoCheckDue(record(NOW - 3 * AUTO_CHECK_INTERVAL_MS, NOW - FAILURE_RETRY_INTERVAL_MS), NOW)).toBe(true);
  });

  it('still waits for the 24 hours when a failure is old but the last good check is recent', () => {
    expect(isAutoCheckDue(record(NOW - 60_000, NOW - 2 * FAILURE_RETRY_INTERVAL_MS), NOW)).toBe(false);
  });

  it('ignores a failure time in the future', () => {
    expect(isAutoCheckDue(record(null, NOW + 60_000), NOW)).toBe(true);
  });
});
