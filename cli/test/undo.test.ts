import { readFileSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliError } from '../src/errors';

import { createHarness, writePlanFile, type Harness } from './harness';

// The database moves updated_at on every write, so restored rows are compared without it.
const bare = (rows: ReadonlyArray<object | undefined>) => rows.map((row) => ({ ...row, updated_at: undefined }));

let harness: Harness;
beforeEach(() => {
  harness = createHarness();
});
afterEach(() => harness.cleanup());

const add = (title: string, key: string) =>
  harness.run(['events', 'add', '--title', title, '--time', '07:30', '--repeat', 'daily', '--key', key, '--json']);

describe('undo', () => {
  it('undoes a create by switching the alarm off', async () => {
    await add('Push day', 'workout/push-day');
    const result = await harness.run(['undo', '--json']);
    expect(result.code).toBe(0);
    expect(result.json['reverted'][0].summary).toContain('created "Push day"');
    expect(harness.store.events[0]?.active).toBe(false);
  });

  it('undoes an update by restoring every column it touched', async () => {
    await add('Push day', 'workout/push-day');
    const before = structuredClone(harness.store.events[0]);
    await harness.run(['events', 'update', 'workout/push-day', '--time', '09:00', '--title', 'Chest', '--duration', '90', '--days', 'mon', '--no-passable']);
    expect(harness.store.events[0]?.title).toBe('Chest');
    await harness.run(['undo']);
    const after = harness.store.events[0];
    for (const column of ['title', 'start_at', 'duration_min', 'repeat_unit', 'repeat_interval', 'repeat_weekdays', 'passable', 'agent_key', 'active'] as const) {
      expect(after?.[column], column).toEqual(before?.[column]);
    }
  });

  it('undoes disable and enable', async () => {
    await add('Push day', 'workout/push-day');
    await harness.run(['events', 'disable', 'workout/push-day']);
    await harness.run(['undo']);
    expect(harness.store.events[0]?.active).toBe(true);
    await harness.run(['events', 'disable', 'workout/push-day']);
    await harness.run(['events', 'enable', 'workout/push-day']);
    await harness.run(['undo']);
    expect(harness.store.events[0]?.active).toBe(false);
  });

  it('undoes a whole plan apply: new alarms off, new rules gone, replaced rules restored, removed rules back', async () => {
    const plan = (modes: Record<string, unknown>) => ({
      namespace: 'workout',
      items: { 'workout/push-day': { title: 'Push day', time: '07:30', repeat: 'daily', modes } },
    });
    await harness.run(['plan', 'apply', writePlanFile(harness, 'a', plan({ sick: 'skip', exam: { shorten: 20 } }))]);
    expect(harness.store.rules).toHaveLength(2);
    const snapshot = JSON.stringify(harness.store.rules.map(({ mode_id, event_id, behavior, shift_minutes, duration_min }) => ({ mode_id, event_id, behavior, shift_minutes, duration_min })));

    await harness.run(['plan', 'apply', writePlanFile(harness, 'b', plan({ sick: { shift: 60 }, exam: 'inherit' }))]);
    expect(harness.store.rules).toHaveLength(1);
    await harness.run(['undo']);
    const restored = JSON.stringify(harness.store.rules.map(({ mode_id, event_id, behavior, shift_minutes, duration_min }) => ({ mode_id, event_id, behavior, shift_minutes, duration_min })));
    expect(JSON.parse(restored)).toEqual(expect.arrayContaining(JSON.parse(snapshot)));
    expect(harness.store.rules).toHaveLength(2);

    await harness.run(['undo']);
    expect(harness.store.rules).toHaveLength(0);
    expect(harness.store.events[0]?.active).toBe(false);
  });

  it('undoes a mode switch including the activations it ended or removed', async () => {
    await harness.run(['modes', 'switch', 'sick', '--since', 'today']);
    const sickActivation = structuredClone(harness.store.activations[0]);
    harness.clock.now = new Date('2026-11-08T12:00:00Z');
    await harness.run(['modes', 'switch', 'vacation', '--until', '2026-11-15']);
    expect(harness.store.activations).toHaveLength(2);
    expect(harness.store.activations[0]?.ends_at).toBe('2026-11-08T12:00:00.000Z');

    await harness.run(['undo']);
    expect(bare(harness.store.activations)).toEqual(bare([sickActivation]));

    await harness.run(['modes', 'normal']);
    await harness.run(['undo']);
    expect(bare(harness.store.activations)).toEqual(bare([sickActivation]));
  });

  it('undoes a removed range, and settings, and the prayers switch', async () => {
    await harness.run(['modes', 'range', 'add', 'ramadan', '--from', '2027-02-08', '--to', '2027-03-09']);
    const range = structuredClone(harness.store.activations[0]);
    await harness.run(['modes', 'range', 'remove', range?.id as string]);
    expect(harness.store.activations).toHaveLength(0);
    await harness.run(['undo']);
    expect(bare(harness.store.activations)).toEqual(bare([range]));

    await harness.run(['settings', 'set', 'grace_minutes', '5', 'prayers_enabled', 'true']);
    expect(harness.store.settings).toMatchObject({ grace_minutes: 5, prayers_enabled: true });
    await harness.run(['undo']);
    expect(harness.store.settings).toMatchObject({ grace_minutes: 30, prayers_enabled: false });
    expect(harness.store.prayersCalls).toEqual([true, false]);
  });

  it('undoes an exam with all its alarms', async () => {
    await harness.run(['exams', 'add', '--title', 'Maths', '--date', '2026-12-10']);
    expect(harness.store.events.some((event) => event.active)).toBe(true);
    await harness.run(['undo']);
    expect(harness.store.exams[0]?.active).toBe(false);
    expect(harness.store.events.every((event) => !event.active)).toBe(true);
  });

  it('undoes several steps newest first, marks them in history and does not repeat them', async () => {
    await add('One', 'misc/one');
    await add('Two', 'misc/two');
    await add('Three', 'misc/three');
    const result = await harness.run(['undo', '--steps', '2', '--json']);
    expect(result.json['reverted'].map((item: { id: number }) => item.id)).toEqual([3, 2]);
    expect(harness.store.events.map((event) => event.active)).toEqual([true, false, false]);
    const history = await harness.run(['history', '--json']);
    expect(history.json['entries'].map((entry: { id: number; undone_at: string | null }) => [entry.id, entry.undone_at !== null])).toEqual([[3, true], [2, true], [1, false]]);
    await harness.run(['undo']);
    expect(harness.store.events.map((event) => event.active)).toEqual([false, false, false]);
    expect((await harness.run(['undo'])).stdout).toBe('Nothing to undo.');
  });

  it('records which command made each change, and shows it in the table', async () => {
    await add('One', 'misc/one');
    const history = await harness.run(['history', '--ops', '--json']);
    expect(history.json['entries'][0]).toMatchObject({ command: expect.stringContaining('events add --title One'), changes: 1 });
    expect(history.json['entries'][0].ops[0]).toMatchObject({ table: 'events', kind: 'insert' });
    const human = await harness.run(['history']);
    expect(human.stdout).toContain('created "One"');
  });

  it('writes nothing to the journal for a read or a no-op, and a failed command leaves no entry', async () => {
    await harness.run(['events', 'list']);
    await harness.run(['events', 'get', 'nope/none']);
    expect(harness.rt.journal().entries()).toHaveLength(0);
    await add('One', 'misc/one');
    expect(harness.rt.journal().entries()).toHaveLength(1);
    await add('One again', 'misc/one'); // key clash: rejected before anything is written
    expect(harness.rt.journal().entries()).toHaveLength(1);
  });

  it('journals what landed when a command fails part-way, and undo cleans it up', async () => {
    harness.store.upsertRule = async () => {
      throw new CliError('server', 'boom');
    };
    const plan = { namespace: 'workout', items: { 'workout/a': { title: 'A', time: '07:30', repeat: 'daily', modes: { sick: 'skip' } } } };
    const result = await harness.run(['plan', 'apply', writePlanFile(harness, 'p', plan), '--json']);
    expect(result.code).toBe(7);
    expect(result.json['error'].hint).toContain('alarm-cal undo');
    const entries = harness.rt.journal().entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.partial).toBe(true);
    expect(harness.store.events[0]?.active).toBe(true);
    await harness.run(['undo']);
    expect(harness.store.events[0]?.active).toBe(false);
  });

  it("does not undo another account's change", async () => {
    await add('One', 'misc/one');
    const file = harness.rt.paths.journal;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { entries: Array<{ userId: string }> };
    raw.entries[0]!.userId = 'someone-else';
    writeFileSync(file, JSON.stringify(raw));
    const result = await harness.run(['undo']);
    expect(result.stdout).toBe('Nothing to undo.');
    expect(harness.store.events[0]?.active).toBe(true);
  });
});
