import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { emptyCache, loadCache, persistWithRetry, saveCache } from './cache';

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
    });
    saveCache(file, cache);
    expect(loadCache(file, log)).toEqual(cache);
  });

  it('leaves no temp file behind after a save and replaces the old content', () => {
    saveCache(file, emptyCache());
    const next = emptyCache();
    next.cheatDays = ['2026-03-09'];
    saveCache(file, next);

    expect(readdirSync(join(dir, 'nested'))).toEqual(['cache.json']);
    expect(JSON.parse(readFileSync(file, 'utf8')).cheatDays).toEqual(['2026-03-09']);
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
