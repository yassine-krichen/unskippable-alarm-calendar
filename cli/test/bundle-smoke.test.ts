import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const bundle = join(root, 'dist', 'alarm-cal.cjs');
let scratch: string;

// Runs the real bundle in a child process with a scratch config directory and no credentials.
function run(args: string[]) {
  const result = spawnSync(process.execPath, [bundle, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ALARM_CAL_CONFIG_DIR: scratch, ALARM_CAL_NO_ACL: '1', ALARM_CAL_APP_ENV: '', ALARM_CAL_SUPABASE_URL: '', ALARM_CAL_SUPABASE_KEY: '', VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: '' },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'alarm-cal-bundle-'));
  execFileSync(process.execPath, [join(root, 'build.mjs')], { cwd: root, stdio: 'pipe' });
}, 60_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('the bundled binary', () => {
  it('is a single file', () => {
    expect(existsSync(bundle)).toBe(true);
    expect(readFileSync(bundle, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('prints help --json: commands, exit codes and the plan schema', () => {
    const result = run(['help', '--json']);
    expect(result.code).toBe(0);
    const spec = JSON.parse(result.stdout) as { ok: boolean; commands: Array<{ command: string }>; plan_schema: { properties: object }; exit_codes: object };
    expect(spec.ok).toBe(true);
    expect(spec.commands.map((command) => command.command)).toContain('plan apply');
    expect(Object.keys(spec.plan_schema.properties)).toContain('namespace');
    expect(Object.keys(spec.exit_codes)).toContain('3');
  });

  it('keeps cli/plan.schema.json in step with the bundle', () => {
    const fromBundle = JSON.parse(run(['schema', 'plan']).stdout) as unknown;
    const committed = JSON.parse(readFileSync(join(root, 'plan.schema.json'), 'utf8')) as unknown;
    expect(committed).toEqual(fromBundle);
  });

  it('fails cleanly without a session: exit 3 and a JSON error', () => {
    const result = run(['events', 'list', '--json']);
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: 'not_logged_in' } });
  });

  it('checks a plan file offline (structure only, no sign-in needed)', () => {
    const plan = join(scratch, 'plan.json');
    execFileSync(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(plan)}, JSON.stringify({namespace:'workout',items:{'workout/a':{title:'A',time:'07:30',repeat:'daily'}}}))`]);
    const result = run(['plan', 'check', plan, '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ valid: true, checked_against_data: false });
  });

  it('reports the version', () => {
    expect(run(['--version']).stdout).toMatch(/^alarm-cal \d+\.\d+\.\d+/);
  });
});
