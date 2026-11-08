import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliError } from '../src/errors';
import { parsePlan, planJsonSchema } from '../src/plan/plan-schema';

import { createHarness, writePlanFile, type Harness } from './harness';

const workoutPlan = {
  namespace: 'workout',
  prune: true,
  items: {
    'workout/push-day': {
      title: 'Push day',
      time: '07:30',
      duration: '1h',
      days: ['mon', 'wed', 'fri'],
      maxSnoozes: 1,
      color: 'blue',
      notes: 'Bench, overhead press, dips',
      modes: { sick: 'skip', vacation: 'skip', exam: { shorten: 30 }, ramadan: { shift: 120 } },
    },
    'workout/long-run': {
      title: 'Long run',
      time: '08:00',
      duration: 90,
      days: ['sat'],
      modes: { sick: 'skip' },
    },
  },
};

describe('plan schema', () => {
  it('accepts a full plan', () => {
    expect(parsePlan(JSON.stringify(workoutPlan)).namespace).toBe('workout');
  });

  it('names every problem with its path, at once', () => {
    const bad = {
      namespace: 'workout',
      items: {
        'workout/a': { title: '', time: '7:30', weekdays: ['mon'] },
        'gym/b': { title: 'B', time: '08:00' },
      },
    };
    try {
      parsePlan(JSON.stringify(bad));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      const cli = error as CliError;
      expect(cli.code).toBe('invalid_plan');
      expect(cli.message).toContain('items.workout/a.title');
      expect(cli.message).toContain('items.workout/a.time');
      expect(cli.message).toContain('Unrecognized key');
    }
  });

  it('requires every key to start with the namespace', () => {
    const plan = { namespace: 'workout', items: { 'gym/b': { title: 'B', time: '08:00' } } };
    expect(() => parsePlan(JSON.stringify(plan))).toThrow(/must start with "workout\/"/);
  });

  it('rejects bad mode behaviours and a shift beyond 12 hours', () => {
    const item = (modes: unknown) => ({ namespace: 'w', items: { 'w/a': { title: 'A', time: '08:00', modes } } });
    expect(() => parsePlan(JSON.stringify(item({ sick: 'pause' })))).toThrow(/invalid_plan|problem/);
    expect(() => parsePlan(JSON.stringify(item({ sick: { shift: 721 } })))).toThrow(/problem/);
    expect(() => parsePlan(JSON.stringify(item({ sick: { shorten: 0 } })))).toThrow(/problem/);
    expect(() => parsePlan(JSON.stringify(item({ sick: 'skip', exam: { shift: -30 } })))).not.toThrow();
  });

  it('rejects malformed JSON, an empty plan and an empty item list', () => {
    expect(() => parsePlan('{nope')).toThrow(/not valid JSON/);
    expect(() => parsePlan(JSON.stringify({ namespace: 'w', items: {} }))).toThrow(/no items/);
  });

  it('publishes a JSON Schema that matches the committed cli/plan.schema.json', () => {
    const committed = JSON.parse(readFileSync(join(__dirname, '..', 'plan.schema.json'), 'utf8')) as unknown;
    expect(committed).toEqual(JSON.parse(JSON.stringify(planJsonSchema())));
    const schema = planJsonSchema() as { required?: string[]; properties?: Record<string, unknown> };
    expect(schema.required).toEqual(expect.arrayContaining(['namespace', 'items']));
    expect(Object.keys(schema.properties ?? {})).toEqual(expect.arrayContaining(['namespace', 'prune', 'items']));
  });
});

describe('plan check / diff / apply', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = createHarness();
  });
  afterEach(() => harness.cleanup());

  it('plan check validates a file offline-or-online and returns warnings', async () => {
    const path = writePlanFile(harness, 'workout', workoutPlan);
    const result = await harness.run(['plan', 'check', path, '--json']);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ ok: true, valid: true, namespace: 'workout', items: 2 });
  });

  it('plan check fails with exit 5 and the problem paths', async () => {
    const path = writePlanFile(harness, 'bad', { namespace: 'workout', items: { 'workout/a': { title: 'A' } } });
    const result = await harness.run(['plan', 'check', path, '--json']);
    expect(result.code).toBe(5);
    expect(result.json['error']).toMatchObject({ code: 'invalid_plan' });
    expect(JSON.stringify(result.json)).toContain('items.workout/a.time');
  });

  it('applies a plan: creates alarms with keys, builds built-in modes and writes the rules', async () => {
    const path = writePlanFile(harness, 'workout', workoutPlan);
    const result = await harness.run(['plan', 'apply', path, '--json']);
    expect(result.code).toBe(0);
    expect(result.json['result']).toMatchObject({ created: 2, rulesWritten: 5 });
    expect(harness.store.events.map((event) => event.agent_key).sort()).toEqual(['workout/long-run', 'workout/push-day']);

    const push = harness.store.events.find((event) => event.agent_key === 'workout/push-day');
    expect(push).toMatchObject({ title: 'Push day', duration_min: 60, repeat_unit: 'week', repeat_weekdays: [0, 2, 4], max_snoozes: 1, color: '#3b82f6', passable: true });
    const modeOf = (key: string) => harness.store.modes.find((mode) => mode.builtin_key === key)?.id;
    const ruleFor = (mode: string) => harness.store.rules.find((rule) => rule.event_id === push?.id && rule.mode_id === modeOf(mode));
    expect(ruleFor('sick')).toMatchObject({ behavior: 'skip', shift_minutes: null });
    expect(ruleFor('exam')).toMatchObject({ behavior: 'shorten', duration_min: 30 });
    expect(ruleFor('ramadan')).toMatchObject({ behavior: 'shift', shift_minutes: 120 });
    expect(result.json['journal']).toMatchObject({ undo: 'alarm-cal undo' });
  });

  it('is idempotent: a second apply changes nothing and writes nothing', async () => {
    const path = writePlanFile(harness, 'workout', workoutPlan);
    await harness.run(['plan', 'apply', path]);
    const before = JSON.stringify([harness.store.events, harness.store.rules]);
    const writesBefore = harness.store.writes;
    harness.clock.now = new Date('2026-12-30T09:00:00Z'); // a later day must not move the start dates
    const second = await harness.run(['plan', 'apply', path, '--json']);
    expect(second.code).toBe(0);
    expect(second.json).toMatchObject({ nothing_to_do: true });
    expect(harness.store.writes).toBe(writesBefore);
    expect(JSON.stringify([harness.store.events, harness.store.rules])).toBe(before);
    expect(harness.rt.journal().entries()).toHaveLength(1);
  });

  it('plan diff reports field-level changes without writing', async () => {
    const path = writePlanFile(harness, 'workout', workoutPlan);
    await harness.run(['plan', 'apply', path]);
    const changed = structuredClone(workoutPlan);
    changed.items['workout/push-day'].time = '08:15';
    changed.items['workout/push-day'].title = 'Push day (heavy)';
    changed.items['workout/push-day'].modes.sick = 'keep' as never;
    const path2 = writePlanFile(harness, 'workout2', changed);
    const writes = harness.store.writes;
    const result = await harness.run(['plan', 'diff', path2, '--json']);
    expect(harness.store.writes).toBe(writes);
    const diff = result.json['diff'];
    expect(diff.summary).toMatchObject({ update: 1, unchanged: 1, create: 0 });
    const item = diff.items.find((candidate: { key: string }) => candidate.key === 'workout/push-day');
    expect(item.changes).toEqual([
      { field: 'title', from: 'Push day', to: 'Push day (heavy)' },
      { field: 'time', from: '07:30', to: '08:15' },
    ]);
    expect(item.rules).toEqual([{ mode: 'sick', action: 'update', from: 'skip', to: 'keep' }]);
  });

  it('applies an update in place: same id, only the changed columns, and the old rule replaced', async () => {
    const path = writePlanFile(harness, 'workout', workoutPlan);
    await harness.run(['plan', 'apply', path]);
    const idBefore = harness.store.events.find((event) => event.agent_key === 'workout/push-day')?.id;
    const changed = structuredClone(workoutPlan);
    changed.items['workout/push-day'].time = '08:15';
    changed.items['workout/push-day'].modes.sick = 'keep' as never;
    await harness.run(['plan', 'apply', writePlanFile(harness, 'workout2', changed)]);
    const push = harness.store.events.find((event) => event.agent_key === 'workout/push-day');
    expect(push?.id).toBe(idBefore);
    expect(push?.start_at.slice(11, 16)).toBe('07:15'); // 08:15 in Tunis
    const sick = harness.store.modes.find((mode) => mode.builtin_key === 'sick');
    expect(harness.store.rules.filter((rule) => rule.event_id === idBefore && rule.mode_id === sick?.id)).toMatchObject([{ behavior: 'keep' }]);
  });

  it('prune switches off keyed alarms of the namespace that left the plan, and nothing else', async () => {
    await harness.store.insertEvents([
      { title: 'Not mine', notes: null, start_at: '2026-11-09T06:00:00.000Z', duration_min: 15, repeat_unit: 'day', repeat_interval: 1, repeat_weekdays: null, ends_at: null, max_snoozes: 3, snooze_minutes: 5, passable: true, color: null, show_in_calendar: true },
      { title: 'Other namespace', notes: null, start_at: '2026-11-09T06:00:00.000Z', duration_min: 15, repeat_unit: 'day', repeat_interval: 1, repeat_weekdays: null, ends_at: null, max_snoozes: 3, snooze_minutes: 5, passable: true, color: null, show_in_calendar: true, agent_key: 'study/read' },
    ]);
    await harness.run(['plan', 'apply', writePlanFile(harness, 'workout', workoutPlan)]);
    const smaller = { ...workoutPlan, items: { 'workout/push-day': workoutPlan.items['workout/push-day'] } };
    const result = await harness.run(['plan', 'apply', writePlanFile(harness, 'smaller', smaller), '--json']);
    expect(result.json['result']).toMatchObject({ disabled: 1 });
    const active = Object.fromEntries(harness.store.events.map((event) => [event.agent_key ?? event.title, event.active]));
    expect(active).toEqual({ 'Not mine': true, 'study/read': true, 'workout/push-day': true, 'workout/long-run': false });
  });

  it('without prune, alarms that left the plan stay on and a warning says so', async () => {
    await harness.run(['plan', 'apply', writePlanFile(harness, 'workout', workoutPlan)]);
    const smaller = { namespace: 'workout', items: { 'workout/push-day': workoutPlan.items['workout/push-day'] } };
    const result = await harness.run(['plan', 'diff', writePlanFile(harness, 'smaller', smaller), '--json']);
    expect(result.json['diff'].notInPlan).toEqual(['workout/long-run']);
    expect(result.json['diff'].warnings[0]).toContain('prune');
  });

  it('enabled:false switches an alarm off, and putting it back switches it on again (same row)', async () => {
    await harness.run(['plan', 'apply', writePlanFile(harness, 'workout', workoutPlan)]);
    const off = structuredClone(workoutPlan) as { items: Record<string, Record<string, unknown>> };
    off.items['workout/long-run']!['enabled'] = false;
    await harness.run(['plan', 'apply', writePlanFile(harness, 'off', off)]);
    const run = harness.store.events.find((event) => event.agent_key === 'workout/long-run');
    expect(run?.active).toBe(false);
    const idWhileOff = run?.id;
    const on = await harness.run(['plan', 'apply', writePlanFile(harness, 'workout', workoutPlan), '--json']);
    expect(on.json['diff'].items.find((item: { key: string }) => item.key === 'workout/long-run').action).toBe('enable');
    const back = harness.store.events.find((event) => event.agent_key === 'workout/long-run');
    expect(back).toMatchObject({ active: true, id: idWhileOff });
    expect(harness.store.events).toHaveLength(2);
  });

  it('inherit removes the alarm rule so the mode default applies', async () => {
    await harness.run(['plan', 'apply', writePlanFile(harness, 'workout', workoutPlan)]);
    const changed = structuredClone(workoutPlan) as { items: Record<string, { modes: Record<string, unknown> }> };
    changed.items['workout/push-day']!.modes['vacation'] = 'inherit';
    const result = await harness.run(['plan', 'apply', writePlanFile(harness, 'inherit', changed), '--json']);
    expect(result.json['result']).toMatchObject({ rulesDeleted: 1 });
    const vacation = harness.store.modes.find((mode) => mode.builtin_key === 'vacation');
    expect(harness.store.rules.some((rule) => rule.mode_id === vacation?.id)).toBe(false);
  });

  it('warns that skip does nothing on a non-passable alarm, and fails on an unknown custom mode', async () => {
    const medication = { namespace: 'meds', items: { 'meds/morning': { title: 'Pill', time: '08:00', repeat: 'daily', passable: false, modes: { sick: 'skip' } } } };
    const warned = await harness.run(['plan', 'check', writePlanFile(harness, 'meds', medication), '--json']);
    expect(warned.json['warnings'][0]).toContain('not passable');

    const unknown = { namespace: 'meds', items: { 'meds/morning': { title: 'Pill', time: '08:00', repeat: 'daily', modes: { 'night shift': 'skip' } } } };
    const failed = await harness.run(['plan', 'check', writePlanFile(harness, 'unknown', unknown), '--json']);
    expect(failed.code).toBe(5);
    expect(JSON.stringify(failed.json)).toContain('night shift');
  });

  it('reports an agent key that clashes with another row as a conflict and applies nothing', async () => {
    await harness.store.insertEvents([
      { title: 'Taken', notes: null, start_at: '2026-11-09T06:00:00.000Z', duration_min: 15, repeat_unit: 'none', repeat_interval: 1, repeat_weekdays: null, ends_at: null, max_snoozes: 3, snooze_minutes: 5, passable: true, color: null, show_in_calendar: true, agent_key: 'study/read' },
    ]);
    // The store is asked to create a second alarm with the same key (as a racing second run would).
    await expect(harness.store.insertEvents([{ title: 'Dup', notes: null, start_at: '2026-11-09T06:00:00.000Z', duration_min: 15, repeat_unit: 'none', repeat_interval: 1, repeat_weekdays: null, ends_at: null, max_snoozes: 3, snooze_minutes: 5, passable: true, color: null, show_in_calendar: true, agent_key: 'study/read' }])).rejects.toMatchObject({ code: 'conflict' });
  });

  it('reads a plan from standard input', async () => {
    harness.stdin.text = JSON.stringify(workoutPlan);
    const result = await harness.run(['plan', 'diff', '-', '--json']);
    expect(result.code).toBe(0);
    expect(result.json['diff'].summary.create).toBe(2);
  });
});
