import { join, resolve } from 'node:path';

/** Passed by the login item so an autostarted app sits in the tray instead of opening a window. */
export const START_HIDDEN_ARG = '--hidden';

export interface AppConfig {
  /** Seed hardcoded test events into a separate seed data folder (ALARM_DEV_SEED=1). */
  devSeed: boolean;
  /** With devSeed, wipe the seed cache and re-seed (ALARM_DEV_SEED_RESET=1); otherwise seed only an empty cache. */
  devSeedReset: boolean;
  /** With devSeed, make today a cheat day to test silencing (ALARM_DEV_CHEAT_DAY=1). */
  devCheatDay: boolean;
  /** Register the app to start at login. */
  autostart: boolean;
  /** Whether ALARM_AUTOSTART was set explicitly (then it is applied on every launch, not just the first). */
  autostartForced: boolean;
  /** Vite dev server to load instead of the built app (ALARM_APP_URL); never honoured in packaged builds. */
  appUrl: string | null;
  /** Serve another app build from this folder (ALARM_APP_DIST); never honoured in packaged builds. */
  appDist: string | null;
  /** Start with every window hidden in the tray (the login item passes --hidden). */
  startHidden: boolean;
}

/**
 * Autostart defaults to on in packaged builds and off in dev, so a dev
 * electron.exe never gets registered at login. ALARM_AUTOSTART=1/0 overrides.
 */
export function resolveConfig(
  env: NodeJS.ProcessEnv,
  isPackaged: boolean,
  argv: readonly string[] = []
): AppConfig {
  const autostartOverride = env.ALARM_AUTOSTART;
  return {
    devSeed: env.ALARM_DEV_SEED === '1',
    devSeedReset: env.ALARM_DEV_SEED_RESET === '1',
    devCheatDay: env.ALARM_DEV_CHEAT_DAY === '1',
    autostart: autostartOverride === undefined ? isPackaged : autostartOverride === '1',
    autostartForced: autostartOverride !== undefined,
    appUrl: !isPackaged && env.ALARM_APP_URL ? env.ALARM_APP_URL : null,
    appDist: !isPackaged && env.ALARM_APP_DIST ? env.ALARM_APP_DIST : null,
    startHidden: argv.includes(START_HIDDEN_ARG),
  };
}

const PACKAGED_DIR_NAME = 'alarm-calendar';
const DAILY_DEV_DIR_NAME = 'alarm-calendar-dev';
const SEED_DIR_NAME = 'alarm-calendar-dev-seed';

/**
 * Where the app keeps its cache, log and single-instance lock (the lock is keyed by userData).
 *
 * - Packaged: the installed app's folder; every override is ignored.
 * - Unpackaged, ALARM_USER_DATA_DIR set: that folder (scratch runs for agents and tests).
 * - Unpackaged, ALARM_DEV_SEED=1 or ALARM_DEV_SEED_RESET=1: the seed folder, so a test run can
 *   never wipe or seed the owner's daily dev data and does not collide with a running daily instance.
 * - Otherwise: the daily dev folder.
 *
 * Throws when a seed flag is combined with an override that points at the daily dev or the
 * installed folder: a reset must only ever touch a throwaway folder.
 */
export function resolveUserDataDir(
  env: NodeJS.ProcessEnv,
  isPackaged: boolean,
  appDataDir: string
): string {
  if (isPackaged) return join(appDataDir, PACKAGED_DIR_NAME);
  const seeding = env.ALARM_DEV_SEED === '1' || env.ALARM_DEV_SEED_RESET === '1';
  const override = env.ALARM_USER_DATA_DIR;
  if (!override) return join(appDataDir, seeding ? SEED_DIR_NAME : DAILY_DEV_DIR_NAME);
  const dir = resolve(override);
  if (seeding) {
    // Windows paths are case-insensitive; comparing lower-cased is the conservative choice everywhere.
    const protectedDirs = [PACKAGED_DIR_NAME, DAILY_DEV_DIR_NAME].map((name) =>
      resolve(appDataDir, name).toLowerCase()
    );
    if (protectedDirs.includes(dir.toLowerCase())) {
      throw new Error('ALARM_USER_DATA_DIR points at real app data; refusing to seed or reset it');
    }
  }
  return dir;
}
