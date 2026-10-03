/** Passed by the login item so an autostarted app sits in the tray instead of opening a window. */
export const START_HIDDEN_ARG = '--hidden';

export interface AppConfig {
  /** Seed hardcoded test events and use a separate dev data folder (ALARM_DEV_SEED=1). */
  devSeed: boolean;
  /** With devSeed, wipe the dev cache and re-seed (ALARM_DEV_SEED_RESET=1); otherwise seed only an empty cache. */
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
