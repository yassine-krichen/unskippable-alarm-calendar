import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type {
  AlarmSettings,
  CompletionRow,
  EventRow,
  ScheduleEventInfo,
  ScheduleOccurrence,
} from '@alarm-calendar/core';

/**
 * 'ringing': the alarm is on screen, or its window was closed without a choice
 * and wakeAt is when it comes back. 'snoozed': wakeAt is when it rings again.
 */
export type OccurrencePhase = 'ringing' | 'snoozed';

/**
 * Local state of one occurrence that has started ringing and is not Done yet. It carries a copy of
 * what the alarm screen and the snooze rules need, taken from the event info when it started to
 * ring: the schedule list moves on (an occurrence older than the grace window leaves it) while a
 * snoozed or unclosed alarm keeps going.
 */
export interface OccurrenceState {
  eventId: string;
  /** ISO 8601 scheduled time; with eventId it identifies the occurrence. */
  occurrenceAt: string;
  snoozesUsed: number;
  phase: OccurrencePhase;
  /** ISO 8601, or null while the alarm window is open. */
  wakeAt: string | null;
  /** Owner of the event; the completion is written under it. */
  userId: string;
  title: string;
  notes: string | null;
  maxSnoozes: number;
  snoozeMinutes: number;
  soundId: string | null;
}

/** The last precomputed schedule main holds (see SchedulePayload in core). */
export interface StoredSchedule {
  /** ISO 8601 UTC. */
  generatedAt: string;
  /** The list is complete up to here. */
  horizonEnd: string;
  truncated: boolean;
  /** Ascending by `at`; the scheduler binary-searches it. */
  occurrences: ScheduleOccurrence[];
  /** Per active event; an event missing here is gone, and its ringing alarm is dismissed. */
  eventInfo: Record<string, ScheduleEventInfo>;
}

/**
 * Everything the main process needs to keep alarming with no internet. In memory it is one object;
 * on disk it is two files so the big part is not rewritten on every ring, snooze or Done (see
 * createCachePersister):
 * - `schedule.json`: events, cheatDays, settings and schedule. Replaced only by a push or a refill.
 * - `cache.json`: everything else, small, rewritten on every state change.
 */
export interface CacheData {
  /** 2 since phase 3 (precomputed schedule). Version 1 caches are migrated on load. */
  version: 2;
  /**
   * With cheatDays and settings, the inputs the schedule was expanded from. Main re-expands from
   * them (see AlarmScheduler.refillIfStale) so alarms continue while the app window is closed.
   * These four fields are only ever replaced, never edited in place: the persister tells whether
   * they changed by identity.
   */
  events: EventRow[];
  /** 'yyyy-MM-dd' in the user's timezone. */
  cheatDays: string[];
  settings: AlarmSettings | null;
  /** Null until the first push, and right after a version 1 migration (the scheduler then refills). */
  schedule: StoredSchedule | null;
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

/** The part of the cache that is replaced as a whole by a push or a refill. */
interface ScheduleFile {
  version: 1;
  events: EventRow[];
  cheatDays: string[];
  settings: AlarmSettings | null;
  schedule: StoredSchedule | null;
}

export function emptyCache(): CacheData {
  return {
    version: 2,
    events: [],
    cheatDays: [],
    settings: null,
    schedule: null,
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

export function scheduleFilePath(cacheFilePath: string): string {
  return join(dirname(cacheFilePath), 'schedule.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The small state shared by version 1 and version 2 files. */
function hasStateShape(candidate: Record<string, unknown>): boolean {
  return (
    Array.isArray(candidate.occurrences) &&
    Array.isArray(candidate.pendingCompletions) &&
    isRecord(candidate.handledThrough)
  );
}

function hasScheduleShape(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value.generatedAt === 'string' &&
    typeof value.horizonEnd === 'string' &&
    Array.isArray(value.occurrences) &&
    isRecord(value.eventInfo)
  );
}

function isScheduleFile(value: unknown): value is ScheduleFile {
  return (
    isRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.events) &&
    Array.isArray(value.cheatDays) &&
    (value.settings === null || isRecord(value.settings)) &&
    hasScheduleShape(value.schedule)
  );
}

/**
 * Version 1 kept everything in one file, with only events: no schedule list, and ringing states
 * without their own copy of the alarm's text and snooze rules. The list is left null (the
 * scheduler expands it from the events on its first evaluation); each state is filled from its
 * event, and a state whose event is gone is dropped, as the next schedule push would have
 * dismissed it anyway.
 */
function migrateFromVersion1(cache: Record<string, unknown>, log: CacheLogger): CacheData {
  const events = cache.events as EventRow[];
  const settings = (cache.settings ?? null) as AlarmSettings | null;
  const old = cache.occurrences as Array<Partial<OccurrenceState> & Pick<OccurrenceState, 'eventId'>>;
  const occurrences: OccurrenceState[] = [];
  for (const state of old) {
    const event = events.find((candidate) => candidate.id === state.eventId);
    if (event === undefined) {
      log('cache.migration_dropped_state', { eventId: state.eventId });
      continue;
    }
    occurrences.push({
      eventId: state.eventId,
      occurrenceAt: state.occurrenceAt as string,
      snoozesUsed: state.snoozesUsed as number,
      phase: state.phase as OccurrencePhase,
      wakeAt: state.wakeAt ?? null,
      userId: event.user_id,
      title: event.title,
      notes: event.notes,
      maxSnoozes: event.max_snoozes,
      snoozeMinutes: event.snooze_minutes,
      soundId: settings?.sound ?? null,
    });
  }
  log('cache.migrated', { from: 1, to: 2, events: events.length, states: occurrences.length });
  return {
    ...(cache as unknown as CacheData),
    version: 2,
    schedule: null,
    occurrences,
  };
}

function quarantine(filePath: string, log: CacheLogger): void {
  try {
    renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
  } catch (error) {
    log('cache.quarantine_failed', { error: String(error) });
  }
}

/** Reads and parses a file; null when it does not exist, `undefined` when it is unreadable or malformed. */
function readJson(filePath: string, log: CacheLogger, what: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`${what}.read_failed`, { error: String(error) });
      return undefined;
    }
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    log(`${what}.parse_failed`, { error: String(error) });
    return undefined;
  }
}

/**
 * Loads the cache. A missing file is a normal first run; an unreadable or
 * malformed one is moved aside (never silently overwritten) and replaced by an
 * empty one so alarms keep working. The two files fail independently: a bad
 * schedule.json costs the schedule (the next push or refill rebuilds it) but not the
 * ringing state or pending completions.
 */
export function loadCache(filePath: string, log: CacheLogger): CacheData {
  const parsed = readJson(filePath, log, 'cache');
  if (parsed === null) return emptyCache();
  if (parsed === undefined || !isRecord(parsed) || !hasStateShape(parsed)) {
    if (parsed !== undefined) log('cache.invalid_shape');
    quarantine(filePath, log);
    return emptyCache();
  }

  if (parsed.version === 1 && Array.isArray(parsed.events) && Array.isArray(parsed.cheatDays)) {
    return withDefaults(migrateFromVersion1(parsed, log));
  }
  if (parsed.version !== 2) {
    log('cache.invalid_shape');
    quarantine(filePath, log);
    return emptyCache();
  }

  const cache = withDefaults({ ...emptyCache(), ...(parsed as unknown as Partial<CacheData>), version: 2 });
  // A state file written by a development build that still kept the schedule inline is not trusted
  // for it: whatever is not the current shape is rebuilt by the scheduler.
  if (!Array.isArray(cache.events) || !Array.isArray(cache.cheatDays) || !hasScheduleShape(cache.schedule)) {
    cache.events = [];
    cache.cheatDays = [];
    cache.settings = null;
    cache.schedule = null;
  }
  const schedulePath = scheduleFilePath(filePath);
  const scheduleParsed = readJson(schedulePath, log, 'schedule');
  if (scheduleParsed === null) return cache;
  if (isScheduleFile(scheduleParsed)) {
    cache.events = scheduleParsed.events;
    cache.cheatDays = scheduleParsed.cheatDays;
    cache.settings = scheduleParsed.settings;
    cache.schedule = scheduleParsed.schedule;
  } else {
    if (scheduleParsed !== undefined) log('schedule.invalid_shape');
    quarantine(schedulePath, log);
  }
  return cache;
}

/**
 * Writes to a temp file in the same directory, fsyncs, then renames over the
 * target, so a crash or power cut leaves either the old or the new file intact.
 */
function writeFileAtomic(filePath: string, text: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  const fd = openSync(tempPath, 'w');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, filePath);
}

/**
 * Returns the function that saves the cache. The state file is written every time; the schedule
 * file only when events, cheat days, settings or the schedule are a different object than at the
 * last save, i.e. after a push or a refill. A ring, snooze or Done therefore writes a few hundred
 * bytes, not the whole list. The schedule goes first: after a crash between the two writes the
 * state is one step behind a newer schedule, which is harmless (watermarks protect against re-rings),
 * while the other order could pair new state with an older schedule.
 */
export function createCachePersister(filePath: string): (data: CacheData) => void {
  let saved: Pick<CacheData, 'events' | 'cheatDays' | 'settings' | 'schedule'> | null = null;
  return (data) => {
    const unchanged =
      saved !== null &&
      saved.events === data.events &&
      saved.cheatDays === data.cheatDays &&
      saved.settings === data.settings &&
      saved.schedule === data.schedule;
    if (!unchanged) {
      const file: ScheduleFile = {
        version: 1,
        events: data.events,
        cheatDays: data.cheatDays,
        settings: data.settings,
        schedule: data.schedule,
      };
      writeFileAtomic(scheduleFilePath(filePath), JSON.stringify(file));
      saved = {
        events: data.events,
        cheatDays: data.cheatDays,
        settings: data.settings,
        schedule: data.schedule,
      };
    }
    const {
      events: _events,
      cheatDays: _cheatDays,
      settings: _settings,
      schedule: _schedule,
      ...state
    } = data;
    writeFileAtomic(filePath, JSON.stringify(state));
  };
}

/** Writes both files. For one-off saves and tests; the app keeps a persister so it can skip the big one. */
export function saveCache(filePath: string, data: CacheData): void {
  createCachePersister(filePath)(data);
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
