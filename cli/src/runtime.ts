import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

import { AuthService } from './auth/auth-service';
import { resolveConfigPaths, type ConfigPaths } from './config/paths';
import { CliError } from './errors';
import { Journal } from './journal/journal';
import type { Store } from './store/store';

/**
 * Everything a command touches outside its own arguments, so tests can run a command against an in-memory
 * store, a fixed clock and a scratch config directory.
 */
export interface Runtime {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  cwd: string;
  /** Directory of the running bundle (cli/dist); used to find the repository's app/.env. */
  scriptDir: string;
  paths: ConfigPaths;
  now(): Date;
  /** Standard output. Only the command's result goes here, so `--json` output is always parseable. */
  out(text: string): void;
  /** Standard error: progress and warnings. */
  err(text: string): void;
  readonly interactive: boolean;
  prompt(question: string): Promise<string>;
  /** Reads a text file; refuses one larger than `maxBytes` before reading it. */
  readTextFile(path: string, maxBytes: number): string;
  /** Reads standard input; refuses more than `maxBytes`. */
  readStdin(maxBytes: number): Promise<string>;
  /** The command as typed, recorded in the undo journal. */
  commandLine: string;
  auth(): AuthService;
  openStore(): Promise<Store>;
  journal(): Journal;
}

export interface RuntimeOptions {
  argv: readonly string[];
  scriptDir: string;
}

function readAllStdin(maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    process.stdin.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new CliError('invalid_input', `Standard input is larger than ${maxBytes} bytes.`));
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

export function createRuntime(options: RuntimeOptions): Runtime {
  const env = process.env as Record<string, string | undefined>;
  const platform = process.platform;
  const paths = resolveConfigPaths(env, platform, homedir());
  let auth: AuthService | undefined;
  let journal: Journal | undefined;

  const runtime: Runtime = {
    env,
    platform,
    cwd: process.cwd(),
    scriptDir: options.scriptDir,
    paths,
    now: () => new Date(),
    out: (text) => {
      process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    },
    err: (text) => {
      process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
    },
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    prompt: (question) =>
      new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        rl.question(question, (answer) => {
          rl.close();
          resolve(answer.trim());
        });
      }),
    readTextFile: (path, maxBytes) => {
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        throw new CliError('invalid_input', `Cannot read ${path}.`);
      }
      if (size > maxBytes) throw new CliError('invalid_input', `${path} is larger than ${maxBytes} bytes.`);
      try {
        return readFileSync(path, 'utf8');
      } catch {
        throw new CliError('invalid_input', `Cannot read ${path}.`);
      }
    },
    readStdin: readAllStdin,
    commandLine: ['alarm-cal', ...options.argv].join(' '),
    auth: () => {
      auth ??= new AuthService({
        env,
        platform,
        cwd: runtime.cwd,
        scriptDir: options.scriptDir,
        paths,
      });
      return auth;
    },
    openStore: () => runtime.auth().openStore(),
    journal: () => {
      journal ??= new Journal(paths, env, platform);
      return journal;
    },
  };
  return runtime;
}
