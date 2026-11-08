import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { CliError } from '../errors';

import type { ConfigPaths } from './paths';
import { ensurePrivateDir, readJsonFile, writeJsonFile } from './private-files';

const configSchema = z.object({
  supabaseUrl: z.string().optional(),
  supabaseKey: z.string().optional(),
  lastEmail: z.string().optional(),
});

export type StoredConfig = z.infer<typeof configSchema>;

export type CredentialSource = 'environment' | 'app/.env' | 'config file';

export interface Credentials {
  url: string;
  /** The publishable (anon) key. Never a secret or service-role key. */
  key: string;
  urlSource: CredentialSource;
  keySource: CredentialSource;
}

export function readStoredConfig(paths: ConfigPaths): StoredConfig {
  const parsed = configSchema.safeParse(readJsonFile(paths.config) ?? {});
  return parsed.success ? parsed.data : {};
}

export function writeStoredConfig(
  paths: ConfigPaths,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  patch: StoredConfig
): StoredConfig {
  ensurePrivateDir(paths.dir, env, platform);
  const next = { ...readStoredConfig(paths), ...patch };
  for (const key of Object.keys(next) as Array<keyof StoredConfig>) {
    if (next[key] === undefined) delete next[key];
  }
  writeJsonFile(paths.config, next);
  return next;
}

const WANTED_ENV_NAMES = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY'] as const;

/**
 * Reads the two Supabase names out of a dotenv-style file and nothing else: the rest of the file is never
 * parsed into memory beyond line splitting, never put in process.env and never printed.
 */
export function readAppEnvFile(path: string): Partial<Record<(typeof WANTED_ENV_NAMES)[number], string>> {
  if (!existsSync(path)) return {};
  const found: Partial<Record<(typeof WANTED_ENV_NAMES)[number], string>> = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    const name = match?.[1];
    if (name === undefined || !(WANTED_ENV_NAMES as readonly string[]).includes(name)) continue;
    let value = (match?.[2] ?? '').trim();
    const quoted = /^(['"])(.*?)\1/.exec(value);
    value = quoted === null ? value.replace(/\s+#.*$/, '') : (quoted[2] ?? '');
    if (value !== '') found[name as (typeof WANTED_ENV_NAMES)[number]] = value;
  }
  return found;
}

/**
 * The app/.env of the repository this bundle was built in (cli/dist/../../app/.env), found from the script's own
 * location. The working directory is never searched: a stray app/.env in whatever folder a command runs from must not
 * decide which project the tool talks to. ALARM_CAL_APP_ENV points at another file (or '' for none); it is an
 * environment variable like the others, which the user controls, and tests use it.
 */
export function findAppEnvFile(env: Record<string, string | undefined>, scriptDir: string): string | undefined {
  const override = env['ALARM_CAL_APP_ENV'];
  if (override !== undefined) return override === '' ? undefined : override;
  const own = join(scriptDir, '..', '..', 'app', '.env');
  return existsSync(own) ? own : undefined;
}

/** A new-style secret key (`sb_secret_...`) or a legacy JWT whose role claim is service_role. */
export function looksLikeSecretKey(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true;
  const payload = key.split('.')[1];
  if (key.split('.').length !== 3 || payload === undefined) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { role?: unknown };
    return claims.role === 'service_role';
  } catch {
    return false;
  }
}

export interface CredentialInputs {
  env: Record<string, string | undefined>;
  paths: ConfigPaths;
  scriptDir: string;
}

/**
 * The Supabase URL and publishable key, from the first place that has them: the environment
 * (ALARM_CAL_SUPABASE_URL / _KEY, or the app's VITE_ names), then the config file (`alarm-cal config set`, a
 * deliberate choice of the user), then the tool's own repository's app/.env. Resolved per value, so the URL can
 * come from one place and the key from another.
 */
export function resolveCredentials(inputs: CredentialInputs): Credentials {
  const { env } = inputs;
  const appEnvPath = findAppEnvFile(env, inputs.scriptDir);
  const appEnv = appEnvPath === undefined ? {} : readAppEnvFile(appEnvPath);
  const stored = readStoredConfig(inputs.paths);

  const pick = (
    fromEnv: Array<string | undefined>,
    fromConfig: string | undefined,
    fromApp: string | undefined
  ): { value: string; source: CredentialSource } | undefined => {
    const envValue = fromEnv.find((value) => value !== undefined && value !== '');
    if (envValue !== undefined) return { value: envValue, source: 'environment' };
    if (fromConfig !== undefined && fromConfig !== '') return { value: fromConfig, source: 'config file' };
    if (fromApp !== undefined) return { value: fromApp, source: 'app/.env' };
    return undefined;
  };

  const url = pick([env['ALARM_CAL_SUPABASE_URL'], env['VITE_SUPABASE_URL']], stored.supabaseUrl, appEnv.VITE_SUPABASE_URL);
  const key = pick(
    [env['ALARM_CAL_SUPABASE_KEY'], env['VITE_SUPABASE_PUBLISHABLE_KEY']],
    stored.supabaseKey,
    appEnv.VITE_SUPABASE_PUBLISHABLE_KEY
  );
  if (url === undefined || key === undefined) {
    throw new CliError(
      'config_missing',
      `The Supabase ${url === undefined ? 'URL' : 'publishable key'} is not configured.`,
      'Set ALARM_CAL_SUPABASE_URL and ALARM_CAL_SUPABASE_KEY, or run `alarm-cal config set url <url>` and `alarm-cal config set key <publishable key>`. The tool also reads the app/.env of its own repository when nothing else is set.'
    );
  }
  try {
    const parsed = new URL(url.value);
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      throw new Error('not https');
    }
  } catch {
    throw new CliError('config_missing', 'The Supabase URL is not a valid https URL.', 'Check the value with `alarm-cal config show`.');
  }
  if (looksLikeSecretKey(key.value)) {
    throw new CliError(
      'config_missing',
      'That looks like a secret or service-role key. This tool only ever uses the publishable key.',
      'Use the publishable (anon) key of the project.'
    );
  }
  return { url: url.value, key: key.value, urlSource: url.source, keySource: key.source };
}
