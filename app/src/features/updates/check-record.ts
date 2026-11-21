import { z } from 'zod';

import { readDevicePreference, writeDevicePreference } from '@/lib/device-preference';

import type { ReleaseInfo } from './github-release';

/** Automatic checks run at most this often. A manual "Check now" ignores it. */
export const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const RECORD_KEY = 'alarm-calendar-update-check';

const recordSchema = z.object({
  checkedAt: z.number().finite().nullable(),
  etag: z.string().max(200).nullable(),
  /** The newest release seen, so a restart inside the 24 hours still shows the banner. */
  release: z
    .object({
      version: z.string().max(30),
      notes: z.string().max(5_000),
      htmlUrl: z.string().max(500),
      android: z
        .object({
          name: z.string().max(200),
          url: z.string().max(500),
          sizeBytes: z.number().finite(),
          sha256: z.string().max(64).nullable(),
        })
        .nullable(),
    })
    .nullable(),
  /** When the last automatic or manual check failed (offline, rate limit); cleared by a success. */
  lastFailureAt: z.number().finite().nullable().default(null),
});

/** What the last checks left behind, per device. */
export interface CheckRecord {
  /** The last check that reached GitHub and read an answer; null when none ever did. */
  checkedAt: number | null;
  etag: string | null;
  release: ReleaseInfo | null;
  /** The last failed check, so a failing network is not retried at every resume. */
  lastFailureAt: number | null;
}

/** After a failed automatic check, the next one waits at least this long. A manual "Check now" ignores it. */
export const FAILURE_RETRY_INTERVAL_MS = 60 * 60 * 1000;

/** Reads the record; storage that is blocked, empty or damaged means "never checked". */
export function readCheckRecord(): CheckRecord | null {
  const raw = readDevicePreference(RECORD_KEY);
  if (raw === null) return null;
  try {
    const parsed = recordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeCheckRecord(record: CheckRecord): void {
  writeDevicePreference(RECORD_KEY, JSON.stringify(record));
}

/** Keeps what the last good check found and notes that a check just failed. */
export function recordCheckFailure(previous: CheckRecord | null, now: number): void {
  writeCheckRecord({
    checkedAt: previous?.checkedAt ?? null,
    etag: previous?.etag ?? null,
    release: previous?.release ?? null,
    lastFailureAt: now,
  });
}

/** True when `at` is a plausible past moment at most `window` ms ago; a time in the future (clock set back) is not. */
function within(at: number | null, now: number, window: number): boolean {
  if (at === null) return false;
  const elapsed = now - at;
  return elapsed >= 0 && elapsed < window;
}

/**
 * Whether an automatic check is due: 24 hours since the last good one (or never), and, after a failed check,
 * at least an hour since the failure. A time in the future (the clock was set back) never silences checks.
 */
export function isAutoCheckDue(record: CheckRecord | null, now: number): boolean {
  if (record === null) return true;
  if (within(record.lastFailureAt, now, FAILURE_RETRY_INTERVAL_MS)) return false;
  return !within(record.checkedAt, now, AUTO_CHECK_INTERVAL_MS);
}

/** Per device: the version whose banner the person dismissed. A newer version shows the banner again. */
const DISMISSED_KEY = 'alarm-calendar-update-dismissed';

export function readDismissedVersion(): string | null {
  return readDevicePreference(DISMISSED_KEY);
}

export function writeDismissedVersion(version: string): void {
  writeDevicePreference(DISMISSED_KEY, version);
}
