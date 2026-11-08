import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CliError } from '../errors';

/**
 * Creates the config directory with access limited to the current user where the platform allows it:
 * mode 0700 on POSIX; on Windows the inherited ACL is replaced by one for the current user (best effort,
 * it never fails the command). Skipped when ALARM_CAL_NO_ACL is set, which tests do.
 */
export function ensurePrivateDir(dir: string, env: Record<string, string | undefined>, platform: NodeJS.Platform): void {
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existed || env['ALARM_CAL_NO_ACL'] === '1') return;
  try {
    if (platform === 'win32') {
      const user = env['USERNAME'];
      if (user) {
        execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], { stdio: 'ignore' });
      }
    } else {
      chmodSync(dir, 0o700);
    }
  } catch {
    // The directory already lives under the user's profile; a failed tightening is not worth failing a command.
  }
}

/**
 * Limits one file to the current user, again. Called after every write of a file that holds a credential:
 * a rename can bring an inherited ACL back, and a file someone loosened by hand is tightened on the next write.
 */
export function restrictFile(path: string, env: Record<string, string | undefined>, platform: NodeJS.Platform): void {
  if (env['ALARM_CAL_NO_ACL'] === '1') return;
  try {
    if (platform === 'win32') {
      const user = env['USERNAME'];
      if (user) execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore' });
    } else {
      chmodSync(path, 0o600);
    }
  } catch {
    // Best effort, like the directory: the file lives under the user's profile either way.
  }
}

/** Reads a JSON file; a missing file is `undefined`, a damaged one is an error that names the file. */
export function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf8');
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CliError('config_missing', `${path} is not valid JSON.`, 'Delete the file and sign in again (alarm-cal login).');
  }
}

/** Temp file then rename, so a crash never leaves half a file behind. */
export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${Date.now()}-${process.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}
