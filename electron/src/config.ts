export interface AppConfig {
  /** Seed hardcoded test events and use a separate dev data folder (ALARM_DEV_SEED=1). */
  devSeed: boolean;
  /** With devSeed, wipe the dev cache and re-seed (ALARM_DEV_SEED_RESET=1); otherwise seed only an empty cache. */
  devSeedReset: boolean;
  /** With devSeed, make today a cheat day to test silencing (ALARM_DEV_CHEAT_DAY=1). */
  devCheatDay: boolean;
  /** Register the app to start at login. */
  autostart: boolean;
}

/**
 * Autostart defaults to on in packaged builds and off in dev, so a dev
 * electron.exe never gets registered at login. ALARM_AUTOSTART=1/0 overrides.
 */
export function resolveConfig(env: NodeJS.ProcessEnv, isPackaged: boolean): AppConfig {
  const autostartOverride = env.ALARM_AUTOSTART;
  return {
    devSeed: env.ALARM_DEV_SEED === '1',
    devSeedReset: env.ALARM_DEV_SEED_RESET === '1',
    devCheatDay: env.ALARM_DEV_CHEAT_DAY === '1',
    autostart: autostartOverride === undefined ? isPackaged : autostartOverride === '1',
  };
}
