import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliError } from '../src/errors';
import { Journal } from '../src/journal/journal';

import { createHarness, writePlanFile, type Harness } from './harness';

let harness: Harness;
beforeEach(() => {
  harness = createHarness();
});
afterEach(() => harness.cleanup());

const add = (title: string, key: string) =>
  harness.run(['events', 'add', '--title', title, '--time', '07:30', '--repeat', 'daily', '--key', key, '--json']);

describe('undo refuses when the rows moved on', () => {
  it('exits 6 with the changed rows named, writes nothing, and --force overrides', async () => {
    await add('Push day', 'workout/push-day');
    // The owner edits the alarm in the app afterwards: updated_at moves.
    harness.clock.now = new Date('2026-11-08T11:00:00Z');
    await harness.store.updateEvent(harness.store.events[0]?.id as string, { title: 'Push day (app edit)' });
    const writes = harness.store.writes;

    const refused = await harness.run(['undo', '--json']);
    expect(refused.code).toBe(6);
    expect(refused.json['error'].code).toBe('conflict');
    expect(refused.json['error'].message).toContain('Push day');
    expect(refused.json['error'].hint).toContain('--force');
    expect(harness.store.writes).toBe(writes);
    expect(harness.store.events[0]?.active).toBe(true);
    expect(harness.rt.journal().entries()[0]?.undoneAt).toBeUndefined();

    const forced = await harness.run(['undo', '--force', '--json']);
    expect(forced.code).toBe(0);
    expect(harness.store.events[0]?.active).toBe(false);
  });

  it('checks settings by the columns that were written', async () => {
    await harness.run(['settings', 'set', 'grace_minutes', '5']);
    await harness.store.updateSettings({ grace_minutes: 20 });
    expect((await harness.run(['undo', '--json'])).code).toBe(6);
    await harness.store.updateSettings({ grace_minutes: 5 });
    expect((await harness.run(['undo', '--json'])).code).toBe(0);
    expect(harness.store.settings['grace_minutes']).toBe(30);
  });

  it('detects a removed rule whose slot was taken again', async () => {
    await add('Push day', 'workout/push-day');
    await harness.run(['modes', 'rule', 'set', 'sick', 'workout/push-day', 'skip']);
    await harness.run(['modes', 'rule', 'set', 'sick', 'workout/push-day', 'inherit']);
    harness.clock.now = new Date('2026-11-08T11:00:00Z');
    await harness.store.upsertRule(harness.store.modes.find((mode) => mode.builtin_key === 'sick')?.id as string, harness.store.events[0]?.id as string, { behavior: 'keep', shift_minutes: null, duration_min: null });
    expect((await harness.run(['undo', '--json'])).code).toBe(6);
  });

  it('does not report a conflict for rows a newer entry of the same undo also touched', async () => {
    await add('Push day', 'workout/push-day');
    harness.clock.now = new Date('2026-11-08T10:05:00Z');
    await harness.run(['events', 'update', 'workout/push-day', '--time', '09:00']);
    harness.clock.now = new Date('2026-11-08T10:10:00Z');
    await harness.run(['events', 'update', 'workout/push-day', '--time', '10:00']);
    harness.clock.now = new Date('2026-11-08T10:15:00Z');
    const result = await harness.run(['undo', '--steps', '3', '--json']);
    expect(result.code, result.stdout).toBe(0);
    expect(harness.store.events[0]?.active).toBe(false);
  });
});

describe('undo can be resumed', () => {
  const plan = {
    namespace: 'workout',
    items: { 'workout/a': { title: 'A', time: '07:30', repeat: 'daily', modes: { sick: 'skip', exam: { shorten: 20 } } } },
  };

  it('continues where a failed undo stopped, without redoing finished steps', async () => {
    await harness.run(['plan', 'apply', writePlanFile(harness, 'a', plan)]);
    expect(harness.store.rules).toHaveLength(2);

    // Steps run newest first: rule, rule, then the alarm itself. Make the last one fail once.
    const original = harness.store.updateEvent.bind(harness.store);
    let failures = 1;
    harness.store.updateEvent = async (id, patch) => {
      if (failures-- > 0) throw new CliError('server', 'network dropped');
      return original(id, patch);
    };
    const failed = await harness.run(['undo', '--json']);
    expect(failed.code).toBe(6);
    expect(failed.json['error'].message).toContain('2 of 3 steps were reverted');
    expect(failed.json['error'].hint).toContain('continues where this stopped');
    expect(harness.store.rules).toHaveLength(0);
    const entry = harness.rt.journal().entries()[0];
    expect(entry?.undoneAt).toBeUndefined();
    expect(entry?.revertedSteps?.length).toBe(2);

    const deletes = harness.store.writes;
    const retried = await harness.run(['undo', '--json']);
    expect(retried.code, retried.stdout).toBe(0);
    expect(harness.store.events[0]?.active).toBe(false);
    expect(harness.store.writes - deletes).toBe(1); // only the alarm step ran again
    expect(harness.rt.journal().entries()[0]?.undoneAt).toBeDefined();
  });

  it('treats a duplicate on a restore-insert as already restored', async () => {
    await add('Push day', 'workout/push-day');
    await harness.run(['modes', 'rule', 'set', 'sick', 'workout/push-day', 'skip']);
    await harness.run(['modes', 'rule', 'set', 'sick', 'workout/push-day', 'inherit']);
    // Simulate an earlier undo that re-inserted the rule but died before it could record the step.
    const removed = harness.rt.journal().entries()[2]?.ops[0]?.before;
    harness.store.rules.push(structuredClone(removed) as never);
    const result = await harness.run(['undo', '--force', '--json']);
    expect(result.code, result.stdout).toBe(0);
    expect(result.json['reverted'][0].steps).toEqual(['rule was already restored']);
    expect(harness.store.rules).toHaveLength(1);
  });
});

describe('the journal under concurrency', () => {
  it('parallel appends from several journal handles lose nothing and never repeat a number', async () => {
    const handles = [0, 1, 2].map(() => new Journal(harness.rt.paths, harness.rt.env, process.platform));
    const entry = (n: number) => ({ at: '2026-11-08T10:00:00.000Z', userId: 'u', command: `cmd ${n}`, summary: `entry ${n}`, ops: [] });
    const saved = await Promise.all(Array.from({ length: 24 }, (_, n) => handles[n % 3]!.append(entry(n))));
    expect(new Set(saved.map((item) => item.id)).size).toBe(24);
    const all = handles[0]!.entries();
    expect(all).toHaveLength(24);
    expect(all.map((item) => item.summary).sort()).toEqual(Array.from({ length: 24 }, (_, n) => `entry ${n}`).sort());
    expect(all.map((item) => item.id).sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, n) => n + 1));
  });

  it('markUndone racing with appends keeps both', async () => {
    const journal = harness.rt.journal();
    const first = await journal.append({ at: 'x', userId: 'u', command: 'a', summary: 'a', ops: [] });
    await Promise.all([journal.markUndone(first.id, 'now'), journal.append({ at: 'x', userId: 'u', command: 'b', summary: 'b', ops: [] }), journal.markStepReverted(first.id, 0)]);
    const entries = journal.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ undoneAt: 'now', revertedSteps: [0] });
  });
});
