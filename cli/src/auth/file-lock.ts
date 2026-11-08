import { randomUUID } from 'node:crypto';
import { closeSync, linkSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';

import type { LockFunc } from '@supabase/supabase-js';

/** A lock file older than this is treated as abandoned. Must stay below the shortest acquire deadline. */
export const STALE_AFTER_MS = 8_000;
/** How long a caller waits for the lock, at least; auth-js asks for less than that by default. */
export const MIN_ACQUIRE_MS = 10_000;
const POLL_MS = 50;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Removes an abandoned lock without racing the next owner: the file is first renamed to a name only this
 * process uses (rename is atomic, so one remover wins), and only then is its age checked again. If it turns
 * out to be fresh, a live owner's lock was caught by mistake and is linked back when the path is still free.
 */
function reclaimStale(lockPath: string): void {
  const seen = mtimeOf(lockPath);
  if (seen === null || Date.now() - seen <= STALE_AFTER_MS) return;
  const temp = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lockPath, temp);
  } catch {
    return; // someone else removed or replaced it first
  }
  const age = mtimeOf(temp);
  if (age !== null && Date.now() - age <= STALE_AFTER_MS) {
    try {
      linkSync(temp, lockPath);
    } catch {
      // The path was taken meanwhile; the fresh lock we moved cannot be put back.
    }
  }
  rmSync(temp, { force: true });
}

/**
 * A cross-process lock backed by a file. Used for the token refresh (the refresh token rotates, so two commands
 * refreshing at once would revoke each other's session; the second waits and then reuses the first result) and
 * for the undo journal. The file holds a random token and is removed on release only if it is still ours.
 */
export function createFileLock(lockPath: string, ensureDir: () => void): LockFunc {
  return async <R>(_name: string, acquireTimeout: number, fn: () => Promise<R>): Promise<R> => {
    ensureDir();
    const deadline = Date.now() + Math.max(acquireTimeout, MIN_ACQUIRE_MS);
    const token = randomUUID();
    for (;;) {
      try {
        const fd = openSync(lockPath, 'wx');
        writeSync(fd, token);
        closeSync(fd);
        break;
      } catch {
        reclaimStale(lockPath);
        if (Date.now() > deadline) throw new Error('Timed out waiting for another alarm-cal command to finish.');
        await sleep(POLL_MS);
      }
    }
    try {
      return await fn();
    } finally {
      try {
        if (readFileSync(lockPath, 'utf8') === token) rmSync(lockPath, { force: true });
      } catch {
        // Already gone (reclaimed as stale): nothing of ours left to remove.
      }
    }
  };
}
