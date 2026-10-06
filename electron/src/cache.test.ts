import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createCachePersister,
  emptyCache,
  loadCache,
  persistWithRetry,
  saveCache,
  scheduleFilePath,
} from './cache';

let dir: string;
let file: string;
const logged: string[] = [];
const log = (event: string): void => {
  logged.push(event);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alarm-cache-'));
  file = join(dir, 'nested', 'cache.json');
  logged.length = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cache file', () => {
  it('returns an empty cache on first run without logging a problem', () => {
    expect(loadCache(file, log)).toEqual(emptyCache());
    expect(logged).toEqual([]);
  });

  it('saves and loads pending completions and snooze state', () => {
    const cache = emptyCache();
    cache.cheatDays = ['2026-03-02'];
    cache.occurrences.push({
      eventId: '11111111-1111-4111-8111-111111111111',
      occurrenceAt: '2026-03-02T09:01:00.000Z',
      snoozesUsed: 2,
      phase: 'snoozed',
      wakeAt: '2026-03-02T09:06:00.000Z',
      userId: '99999999-9999-4999-8999-999999999999',
      title: 'Take medication',
      notes: null,
      maxSnoozes: 3,
      snoozeMinutes: 5,
      soundId: null,
    });
    saveCache(file, cache);
    expect(loadCache(file, log)).toEqual(cache);
  });

  it('leaves no temp file behind after a save and replaces the old content', () => {
    saveCache(file, emptyCache());
    const next = emptyCache();
    next.cheatDays = ['2026-03-09'];
    saveCache(file, next);

    expect(readdirSync(join(dir, 'nested')).sort()).toEqual(['cache.json', 'schedule.json']);
    // The cheat days belong to the schedule part, not to the small state file.
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('cheatDays');
    expect(JSON.parse(readFileSync(scheduleFilePath(file), 'utf8')).cheatDays).toEqual(['2026-03-09']);
  });

  it('loads a cache written before knownCompletions and autostartInitialized existed', () => {
    const { knownCompletions: _known, autostartInitialized: _auto, ...older } = emptyCache();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(older));

    const loaded = loadCache(file, log);
    expect(loaded.knownCompletions).toEqual([]);
    expect(loaded.autostartInitialized).toBe(false);
    expect(logged).toEqual([]);
  });

  it('moves a corrupt file aside instead of overwriting it', () => {
    saveCache(file, emptyCache());
    writeFileSync(file, '{ not json');

    expect(loadCache(file, log)).toEqual(emptyCache());
    expect(logged).toContain('cache.parse_failed');
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(join(dir, 'nested')).some((name) => name.includes('.corrupt-'))).toBe(true);
  });

  it('treats valid JSON of the wrong shape as corrupt', () => {
    saveCache(file, emptyCache());
    writeFileSync(file, JSON.stringify({ version: 2 }));
    expect(loadCache(file, log)).toEqual(emptyCache());
    expect(logged).toContain('cache.invalid_shape');
  });
});

describe('cache version 2 (precomputed schedule)', () => {
  const EVENT = '11111111-1111-4111-8111-111111111111';
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const USER = '99999999-9999-4999-8999-999999999999';

  function event(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      user_id: USER,
      title: 'Take medication',
      notes: 'with water',
      start_at: '2026-03-02T09:01:00.000Z',
      duration_min: 15,
      repeat_unit: 'day',
      repeat_interval: 1,
      repeat_weekdays: null,
      ends_at: null,
      max_snoozes: 2,
      snooze_minutes: 7,
      passable: true,
      color: null,
      active: true,
      updated_at: '2026-03-01T10:00:00.000Z',
      ...overrides,
    };
  }

  function writeVersion1(occurrences: unknown[]): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        events: [event(EVENT)],
        cheatDays: ['2026-03-04'],
        settings: {
          user_id: USER,
          timezone: 'UTC',
          week_starts_on: 0,
          refire_seconds: 120,
          pass_cap: 2,
          grace_minutes: 30,
          sound: 'chime',
        },
        occurrences,
        handledThrough: { [EVENT]: '2026-03-02T09:01:00.000Z' },
        pendingCompletions: [],
        knownCompletions: [`${EVENT}@2026-03-01T09:01:00.000Z`],
        autostartInitialized: true,
      })
    );
  }

  it('migrates a version 1 file: keeps everything, leaves the list empty for the scheduler to fill', () => {
    writeVersion1([]);
    const loaded = loadCache(file, log);
    expect(loaded.version).toBe(2);
    expect(loaded.schedule).toBeNull();
    expect(loaded.events).toHaveLength(1);
    expect(loaded.cheatDays).toEqual(['2026-03-04']);
    expect(loaded.settings?.timezone).toBe('UTC');
    expect(loaded.handledThrough).toEqual({ [EVENT]: '2026-03-02T09:01:00.000Z' });
    expect(loaded.knownCompletions).toEqual([`${EVENT}@2026-03-01T09:01:00.000Z`]);
    expect(loaded.autostartInitialized).toBe(true);
    expect(logged).toEqual(['cache.migrated']);
    // The version 1 file is not quarantined: the next save simply rewrites it as version 2.
    expect(readdirSync(join(dir, 'nested'))).toEqual(['cache.json']);
  });

  it('fills a ringing or snoozed state with its alarm text and snooze rules from its event', () => {
    writeVersion1([
      {
        eventId: EVENT,
        occurrenceAt: '2026-03-02T09:01:00.000Z',
        snoozesUsed: 1,
        phase: 'snoozed',
        wakeAt: '2026-03-02T09:08:00.000Z',
      },
    ]);
    expect(loadCache(file, log).occurrences).toEqual([
      {
        eventId: EVENT,
        occurrenceAt: '2026-03-02T09:01:00.000Z',
        snoozesUsed: 1,
        phase: 'snoozed',
        wakeAt: '2026-03-02T09:08:00.000Z',
        userId: USER,
        title: 'Take medication',
        notes: 'with water',
        maxSnoozes: 2,
        snoozeMinutes: 7,
        soundId: 'chime',
      },
    ]);
  });

  it('drops a state whose event is no longer in the cache and says so', () => {
    writeVersion1([
      { eventId: OTHER, occurrenceAt: '2026-03-02T09:01:00.000Z', snoozesUsed: 0, phase: 'ringing', wakeAt: null },
    ]);
    expect(loadCache(file, log).occurrences).toEqual([]);
    expect(logged).toContain('cache.migration_dropped_state');
  });

  const SCHEDULE = {
    generatedAt: '2026-03-02T09:00:00.000Z',
    horizonEnd: '2026-05-01T09:00:00.000Z',
    truncated: false,
    eventInfo: {
      [EVENT]: { title: 'Take medication', notes: null, maxSnoozes: 3, snoozeMinutes: 5, soundId: null },
    },
    occurrences: [
      {
        id: `${EVENT}@2026-03-02T09:01:00.000Z`,
        eventId: EVENT,
        at: '2026-03-02T09:01:00.000Z',
        silenced: false,
        completed: false,
      },
    ],
  };

  function cacheWithSchedule() {
    const cache = emptyCache();
    cache.schedule = SCHEDULE;
    cache.events = [event(EVENT)] as never;
    cache.cheatDays = ['2026-03-04'];
    return cache;
  }

  it('saves and loads a version 2 cache with its schedule list unchanged', () => {
    const cache = cacheWithSchedule();
    cache.handledThrough = { [EVENT]: '2026-03-02T09:01:00.000Z' };
    saveCache(file, cache);
    expect(loadCache(file, log)).toEqual(cache);
    expect(logged).toEqual([]);
  });

  it('keeps the ringing state and loses only the schedule when schedule.json is unusable', () => {
    const cache = cacheWithSchedule();
    cache.handledThrough = { [EVENT]: '2026-03-02T09:01:00.000Z' };
    saveCache(file, cache);
    writeFileSync(scheduleFilePath(file), JSON.stringify({ version: 1, events: [], schedule: { generatedAt: 'x' } }));

    const loaded = loadCache(file, log);
    expect(loaded.schedule).toBeNull();
    expect(loaded.events).toEqual([]);
    expect(loaded.handledThrough).toEqual({ [EVENT]: '2026-03-02T09:01:00.000Z' });
    expect(logged).toContain('schedule.invalid_shape');
    expect(readdirSync(join(dir, 'nested')).some((name) => name.startsWith('schedule.json.corrupt-'))).toBe(true);
  });

  it('survives a missing schedule.json (a crash cannot produce one, but a deleted file can)', () => {
    saveCache(file, cacheWithSchedule());
    rmSync(scheduleFilePath(file));
    const loaded = loadCache(file, log);
    expect(loaded.schedule).toBeNull();
    expect(logged).toEqual([]);
  });

  it('does not trust a schedule kept inline in the state file by a development build', () => {
    mkdirSync(dirname(file), { recursive: true });
    const inline = { ...emptyCache(), events: [event(EVENT)], schedule: { ...SCHEDULE, eventInfo: undefined, activeEventIds: [EVENT] } };
    writeFileSync(file, JSON.stringify(inline));
    const loaded = loadCache(file, log);
    expect(loaded.schedule).toBeNull();
    expect(loaded.events).toEqual([]);
  });

  describe('createCachePersister', () => {
    it('rewrites the schedule file only when a push or a refill replaced the schedule part', () => {
      const cache = cacheWithSchedule();
      const persist = createCachePersister(file);
      persist(cache);
      expect(existsSync(scheduleFilePath(file))).toBe(true);

      // A ring, snooze or Done changes only the state: the big file must not be touched.
      rmSync(scheduleFilePath(file));
      cache.occurrences.push({
        eventId: EVENT,
        occurrenceAt: '2026-03-02T09:01:00.000Z',
        snoozesUsed: 0,
        phase: 'ringing',
        wakeAt: null,
        userId: USER,
        title: 'Take medication',
        notes: null,
        maxSnoozes: 3,
        snoozeMinutes: 5,
        soundId: null,
      });
      cache.handledThrough[EVENT] = '2026-03-02T09:01:00.000Z';
      persist(cache);
      expect(existsSync(scheduleFilePath(file))).toBe(false);
      expect(JSON.parse(readFileSync(file, 'utf8')).occurrences).toHaveLength(1);

      // A refill replaces the schedule object: now it is written again.
      cache.schedule = { ...SCHEDULE, generatedAt: '2026-03-03T09:00:00.000Z' };
      persist(cache);
      expect(JSON.parse(readFileSync(scheduleFilePath(file), 'utf8')).schedule.generatedAt).toBe(
        '2026-03-03T09:00:00.000Z'
      );
    });

    it('keeps the state file a small fraction of the schedule file', () => {
      const cache = cacheWithSchedule();
      cache.schedule = {
        ...SCHEDULE,
        occurrences: Array.from({ length: 1200 }, (_, n) => {
          const at = new Date(Date.UTC(2026, 2, 2, 9, 1) + n * 3_600_000).toISOString();
          return { id: `${EVENT}@${at}`, eventId: EVENT, at, silenced: false, completed: false };
        }),
      };
      createCachePersister(file)(cache);
      const state = readFileSync(file, 'utf8').length;
      const schedule = readFileSync(scheduleFilePath(file), 'utf8').length;
      expect(state).toBeLessThan(500);
      expect(schedule).toBeGreaterThan(100_000);
    });

    it('retries the schedule write on the next save when it failed', () => {
      const cache = cacheWithSchedule();
      const persist = createCachePersister(join(dir, 'missing', 'nested', 'cache.json'));
      // A directory where the file should go makes the write fail; remove it and save again.
      const blocker = join(dir, 'missing', 'nested', 'schedule.json');
      mkdirSync(blocker, { recursive: true });
      expect(() => persist(cache)).toThrow();
      rmSync(blocker, { recursive: true });
      persist(cache);
      expect(existsSync(blocker)).toBe(true);
    });
  });

  it('treats a version from the future as corrupt rather than guessing', () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...emptyCache(), version: 3 }));
    expect(loadCache(file, log)).toEqual(emptyCache());
    expect(logged).toContain('cache.invalid_shape');
  });
});

describe('persistWithRetry', () => {
  const noSleep = { sleep: () => undefined };

  it('succeeds after transient failures such as EBUSY on rename', () => {
    let calls = 0;
    const saved = persistWithRetry(
      () => {
        if (++calls < 3) throw new Error('EBUSY');
      },
      log,
      noSleep
    );
    expect(saved).toBe(true);
    expect(calls).toBe(3);
    expect(logged).toEqual([]);
  });

  it('never throws: logs and returns false once the attempts are used up', () => {
    let calls = 0;
    const saved = persistWithRetry(
      () => {
        calls++;
        throw new Error('EPERM');
      },
      log,
      noSleep
    );
    expect(saved).toBe(false);
    expect(calls).toBe(3);
    expect(logged).toEqual(['cache.save_failed']);
  });

  it('waits between attempts', () => {
    const waits: number[] = [];
    persistWithRetry(
      () => {
        throw new Error('EBUSY');
      },
      log,
      { sleep: (ms) => waits.push(ms) }
    );
    expect(waits).toEqual([50, 50]);
  });
});
