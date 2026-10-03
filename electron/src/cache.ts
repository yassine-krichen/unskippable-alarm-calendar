import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type { AlarmSettings, CompletionRow, EventRow } from '@alarm-calendar/core';

/**
 * 'ringing': the alarm is on screen, or its window was closed without a choice
 * and wakeAt is when it comes back. 'snoozed': wakeAt is when it rings again.
 */
export type OccurrencePhase = 'ringing' | 'snoozed';

/** Local state of one occurrence that has started ringing and is not Done yet. */
export interface OccurrenceState {
  eventId: string;
  /** ISO 8601 scheduled time; with eventId it identifies the occurrence. */
  occurrenceAt: string;
  snoozesUsed: number;
  phase: OccurrencePhase;
  /** ISO 8601, or null while the alarm window is open. */
  wakeAt: string | null;
}

/** Everything the main process needs to keep alarming with no internet. */
export interface CacheData {
  version: 1;
  events: EventRow[];
  /** 'yyyy-MM-dd' in the user's timezone. */
  cheatDays: string[];
  settings: AlarmSettings | null;
  occurrences: OccurrenceState[];
  /**
   * Per event, the latest occurrence (ISO) already rung, silenced or dropped.
   * Occurrences at or before it are never considered again.
   */
  handledThrough: Record<string, string>;
  /** Completions made on this device that are not yet upserted to Supabase. */
  pendingCompletions: CompletionRow[];
  /**
   * Occurrence ids (`<eventId>@<ISO>`) already completed according to the last
   * sync, on this or any other device. An occurrence in here never rings on
   * wake-up. Pruned to the last KNOWN_COMPLETION_RETENTION_MS.
   */
  knownCompletions: string[];
  /** Whether the install-time autostart default was applied once; after that the OS entry is the user's. */
  autostartInitialized: boolean;
}

export function emptyCache(): CacheData {
  return {
    version: 1,
    events: [],
    cheatDays: [],
    settings: null,
    occurrences: [],
    handledThrough: {},
    pendingCompletions: [],
    knownCompletions: [],
    autostartInitialized: false,
  };
}

/** Fields added after the first release default in, so an older cache.json stays valid. */
function withDefaults(cache: CacheData): CacheData {
  const candidate = cache as Partial<CacheData> & CacheData;
  if (!Array.isArray(candidate.knownCompletions)) candidate.knownCompletions = [];
  if (typeof candidate.autostartInitialized !== 'boolean') candidate.autostartInitialized = false;
  return candidate;
}

export type CacheLogger = (event: string, fields?: Record<string, unknown>) => void;

function isCacheData(value: unknown): value is CacheData {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    Array.isArray(candidate.events) &&
    Array.isArray(candidate.cheatDays) &&
    Array.isArray(candidate.occurrences) &&
    Array.isArray(candidate.pendingCompletions) &&
    typeof candidate.handledThrough === 'object' &&
    candidate.handledThrough !== null
  );
}

/**
 * Loads the cache. A missing file is a normal first run; an unreadable or
 * malformed one is moved aside (never silently overwritten) and replaced by an
 * empty cache so alarms keep working.
 */
export function loadCache(filePath: string, log: CacheLogger): CacheData {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log('cache.read_failed', { error: String(error) });
    }
    return emptyCache();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isCacheData(parsed)) return withDefaults(parsed);
    log('cache.invalid_shape');
  } catch (error) {
    log('cache.parse_failed', { error: String(error) });
  }
  try {
    renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
  } catch (error) {
    log('cache.quarantine_failed', { error: String(error) });
  }
  return emptyCache();
}

/**
 * Writes to a temp file in the same directory, fsyncs, then renames over the
 * target, so a crash or power cut leaves either the old or the new file intact.
 */
export function saveCache(filePath: string, data: CacheData): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  const fd = openSync(tempPath, 'w');
  try {
    writeSync(fd, JSON.stringify(data));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, filePath);
}

export interface RetryOptions {
  attempts?: number;
  delayMs?: number;
  /** Blocking wait; injectable so tests do not really sleep. */
  sleep?(ms: number): void;
}

function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs a save, retrying briefly: on Windows the rename can fail with EPERM or
 * EBUSY while antivirus or an indexer holds the file. Never throws, because a
 * failed write must not abort the scheduler mid-operation; the in-memory state
 * stays correct and the next change retries the write. Returns whether it saved.
 */
export function persistWithRetry(
  save: () => void,
  log: CacheLogger,
  { attempts = 3, delayMs = 50, sleep = blockingSleep }: RetryOptions = {}
): boolean {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      save();
      return true;
    } catch (error) {
      if (attempt === attempts) {
        log('cache.save_failed', { attempts, error: String(error) });
        return false;
      }
      sleep(delayMs);
    }
  }
  return false;
}
