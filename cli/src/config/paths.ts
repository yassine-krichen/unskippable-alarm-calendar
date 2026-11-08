import { join } from 'node:path';

export interface ConfigPaths {
  dir: string;
  config: string;
  session: string;
  journal: string;
  lock: string;
  journalLock: string;
}

/**
 * Where the tool keeps its own files. `ALARM_CAL_CONFIG_DIR` wins (tests and scratch runs); otherwise
 * %APPDATA%\alarm-calendar-cli on Windows and ~/.config/alarm-calendar-cli elsewhere.
 */
export function resolveConfigPaths(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  home: string
): ConfigPaths {
  const override = env['ALARM_CAL_CONFIG_DIR'];
  let dir: string;
  if (override !== undefined && override !== '') {
    dir = override;
  } else if (platform === 'win32') {
    dir = join(env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'alarm-calendar-cli');
  } else {
    dir = join(env['XDG_CONFIG_HOME'] ?? join(home, '.config'), 'alarm-calendar-cli');
  }
  return {
    dir,
    config: join(dir, 'config.json'),
    session: join(dir, 'session.json'),
    journal: join(dir, 'journal.json'),
    lock: join(dir, 'auth.lock'),
    journalLock: join(dir, 'journal.lock'),
  };
}
