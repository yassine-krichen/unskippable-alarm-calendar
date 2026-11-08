import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parsePlan } from '../src/plan/plan-schema';

import { createHarness, type Harness } from './harness';

const skillDir = join(__dirname, '..', '..', '.claude', 'skills', 'alarm-calendar');
const planFiles = readdirSync(join(skillDir, 'references')).filter((name) => name.endsWith('.plan.json'));

let harness: Harness;
beforeEach(() => {
  harness = createHarness();
});
afterEach(() => harness.cleanup());

describe('the skill', () => {
  it('has the frontmatter Claude Code needs', () => {
    const text = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    expect(text).toMatch(/^---\nname: alarm-calendar\ndescription: .{80,}\n---\n/);
  });

  it('ships plan examples for workout, medication, study and birthdays', () => {
    expect(planFiles.sort()).toEqual(['birthdays.plan.json', 'medication.plan.json', 'study.plan.json', 'workout.plan.json']);
  });

  it('only mentions commands that exist', async () => {
    const spec = (await harness.run(['help', '--json'])).json['commands'] as Array<{ command: string }>;
    const known = new Set(spec.map((entry) => entry.command));
    const firstWords = new Set(spec.map((entry) => entry.command.split(' ')[0]));
    const text = ['SKILL.md', 'references/commands.md'].map((file) => readFileSync(join(skillDir, file), 'utf8')).join('\n');
    const mentioned = [...text.matchAll(/`alarm-cal ([a-z]+(?: [a-z]+){0,2})/g)].map((match) => (match[1] ?? '').split(' '));
    expect(mentioned.length).toBeGreaterThan(15);
    for (const words of mentioned) {
      expect(firstWords.has(words[0]), `unknown command in the skill docs: alarm-cal ${words.join(' ')}`).toBe(true);
      // A two-word command must exist when its second word is not an argument-looking word.
      const two = words.slice(0, 2).join(' ');
      if (['events', 'modes', 'exams', 'plan', 'settings', 'config'].includes(words[0] ?? '') && words[1] !== undefined) {
        const sub = [...known].some((command) => command.startsWith(`${words[0]} ${words[1]}`));
        expect(sub, `unknown subcommand in the skill docs: alarm-cal ${two}`).toBe(true);
      }
    }
  });
});

describe.each(planFiles)('example plan %s', (file) => {
  const text = readFileSync(join(skillDir, 'references', file), 'utf8');

  it('passes plan check', async () => {
    expect(() => parsePlan(text)).not.toThrow();
    harness.files.set('/plan.json', text);
    const result = await harness.run(['plan', 'check', '/plan.json', '--json']);
    expect(result.code, result.stdout).toBe(0);
  });

  it('applies cleanly to an empty calendar, then is a no-op', async () => {
    harness.files.set('/plan.json', text);
    const applied = await harness.run(['plan', 'apply', '/plan.json', '--json']);
    expect(applied.code, applied.stdout).toBe(0);
    expect(harness.store.events.length).toBe(Object.keys(parsePlan(text).items).length);
    const again = await harness.run(['plan', 'apply', '/plan.json', '--json']);
    expect(again.json['nothing_to_do']).toBe(true);
  });
});

describe('the medication example', () => {
  it('rings through every mode: non-passable alarms are never paused', async () => {
    harness.files.set('/plan.json', readFileSync(join(skillDir, 'references', 'medication.plan.json'), 'utf8'));
    await harness.run(['plan', 'apply', '/plan.json']);
    await harness.run(['modes', 'switch', 'sick', '--since', 'today']);
    const result = await harness.run(['occurrences', '--from', '2026-11-09', '--to', '2026-11-09', '--json']);
    const rings = result.json['occurrences'] as Array<{ paused: boolean; rings: boolean }>;
    expect(rings.length).toBe(2);
    expect(rings.every((ring) => !ring.paused && ring.rings)).toBe(true);
  });
});
