import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MIN_ACQUIRE_MS, STALE_AFTER_MS, createFileLock } from '../src/auth/file-lock';
import { MAX_PLAN_BYTES, MAX_PLAN_ITEMS, parsePlan } from '../src/plan/plan-schema';

import { createHarness, type Harness } from './harness';

describe('file lock', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'alarm-cal-lock-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('goes stale before the acquire deadline, so a waiter can always outlive a dead owner', () => {
    expect(STALE_AFTER_MS).toBeLessThan(MIN_ACQUIRE_MS);
  });

  it('serialises critical sections', async () => {
    const lock = createFileLock(join(dir, 'x.lock'), () => undefined);
    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        lock('x', 5000, async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inside -= 1;
        })
      )
    );
    expect(maxInside).toBe(1);
    expect(existsSync(join(dir, 'x.lock'))).toBe(false);
  });

  it('reclaims an abandoned lock (older than the stale limit) and leaves no temp files', async () => {
    const path = join(dir, 'x.lock');
    writeFileSync(path, 'dead-owner');
    const old = new Date(Date.now() - STALE_AFTER_MS - 2000);
    utimesSync(path, old, old);
    const started = Date.now();
    const lock = createFileLock(path, () => undefined);
    await expect(lock('x', 1000, async () => 'ok')).resolves.toBe('ok');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('does not take a live lock, and does not delete a lock that is no longer its own', async () => {
    const path = join(dir, 'x.lock');
    const lock = createFileLock(path, () => undefined);
    await lock('x', 1000, async () => {
      // Someone replaced the file (the lock was reclaimed as stale while we ran): our release must leave theirs.
      writeFileSync(path, 'someone-elses-token');
    });
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).isFile()).toBe(true);
  });
});

describe('plan limits', () => {
  it('refuses a plan file over 1 MB before parsing it', () => {
    const huge = `{"namespace":"w","items":{},"pad":"${'x'.repeat(MAX_PLAN_BYTES)}"}`;
    expect(() => parsePlan(huge)).toThrow(/larger than 1 MB/);
  });

  it('bounds the number of items as part of the schema', () => {
    const items = Object.fromEntries(Array.from({ length: MAX_PLAN_ITEMS + 1 }, (_, n) => [`w/a${n}`, { title: 'A', time: '07:30' }]));
    expect(() => parsePlan(JSON.stringify({ namespace: 'w', items }))).toThrow(/at most 200 items/);
    const ok = Object.fromEntries(Array.from({ length: MAX_PLAN_ITEMS }, (_, n) => [`w/a${n}`, { title: 'A', time: '07:30' }]));
    expect(Object.keys(parsePlan(JSON.stringify({ namespace: 'w', items: ok })).items)).toHaveLength(MAX_PLAN_ITEMS);
  });
});

describe('empty --key-prefix', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = createHarness();
  });
  afterEach(() => harness.cleanup());

  it('is refused by list, disable, enable and occurrences, and writes nothing', async () => {
    await harness.run(['events', 'add', '--title', 'A', '--time', '07:30', '--repeat', 'daily', '--key', 'a/one']);
    const writes = harness.store.writes;
    for (const args of [['events', 'list'], ['events', 'disable'], ['events', 'enable'], ['occurrences']]) {
      const result = await harness.run([...args, '--key-prefix', '', '--json']);
      expect(result.code, args.join(' ')).toBe(5);
      expect(result.json['error'].message).toContain('--key-prefix must not be empty');
    }
    expect(harness.store.writes).toBe(writes);
    expect(harness.store.events[0]?.active).toBe(true);
  });
});
