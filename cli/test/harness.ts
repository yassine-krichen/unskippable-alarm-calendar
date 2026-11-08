import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuthService } from '../src/auth/auth-service';
import { resolveConfigPaths } from '../src/config/paths';
import { Journal } from '../src/journal/journal';
import { main } from '../src/main';
import type { Runtime } from '../src/runtime';

import { MemoryStore } from './memory-store';

export const NOW = new Date('2026-11-08T10:00:00.000Z');

export interface Harness {
  rt: Runtime;
  store: MemoryStore;
  configDir: string;
  stdout: string[];
  stderr: string[];
  /** Mutable clock. */
  clock: { now: Date };
  files: Map<string, string>;
  stdin: { text: string };
  run(args: string[]): Promise<CliRun>;
  cleanup(): void;
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  /** Parsed stdout when it is JSON. */
  json: Record<string, any>;
}

export interface HarnessOptions {
  timezone?: string;
  now?: Date;
  env?: Record<string, string | undefined>;
  /** Stands in for the network when the real AuthService is used. */
  fetchImpl?: typeof fetch;
}

/** A runtime on a scratch config directory, a fixed clock and an in-memory store; never touches %APPDATA% or the network. */
export function createHarness(options: HarnessOptions = {}): Harness {
  const configDir = mkdtempSync(join(tmpdir(), 'alarm-cal-test-'));
  const clock = { now: options.now ?? NOW };
  const store = new MemoryStore(() => clock.now, options.timezone ?? 'Africa/Tunis');
  const env: Record<string, string | undefined> = { ALARM_CAL_CONFIG_DIR: configDir, ALARM_CAL_NO_ACL: '1', ALARM_CAL_APP_ENV: '', ...options.env };
  const paths = resolveConfigPaths(env, process.platform, configDir);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const files = new Map<string, string>();
  const stdin = { text: '' };
  let journal: Journal | undefined;
  let auth: AuthService | undefined;

  const rt: Runtime = {
    env,
    platform: process.platform,
    cwd: configDir,
    scriptDir: configDir,
    paths,
    now: () => clock.now,
    out: (text) => void stdout.push(text),
    err: (text) => void stderr.push(text),
    interactive: false,
    prompt: async () => '',
    readTextFile: (path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error(`no such test file ${path}`);
      return text;
    },
    readStdin: async () => stdin.text,
    commandLine: 'alarm-cal',
    auth: () => {
      auth ??= new AuthService({ env, platform: process.platform, cwd: configDir, scriptDir: configDir, paths, ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }) });
      return auth;
    },
    openStore: async () => (options.fetchImpl === undefined ? store : rt.auth().openStore()),
    journal: () => {
      journal ??= new Journal(paths, env, process.platform);
      return journal;
    },
  };

  const harness: Harness = {
    rt,
    store,
    configDir,
    stdout,
    stderr,
    clock,
    files,
    stdin,
    async run(args) {
      stdout.length = 0;
      stderr.length = 0;
      rt.commandLine = ['alarm-cal', ...args].join(' ');
      const code = await main(args, rt);
      const out = stdout.join('\n');
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(out) as Record<string, unknown>;
      } catch {
        // human output
      }
      return { code, stdout: out, stderr: stderr.join('\n'), json };
    },
    cleanup() {
      rmSync(configDir, { recursive: true, force: true });
    },
  };
  return harness;
}

export function writePlanFile(harness: Harness, name: string, plan: unknown): string {
  const path = `/plans/${name}.json`;
  harness.files.set(path, JSON.stringify(plan));
  return path;
}

export { writeFileSync };
