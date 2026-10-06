import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveConfig, resolveUserDataDir } from './config';

describe('resolveConfig', () => {
  it('enables autostart in packaged builds and not in dev', () => {
    expect(resolveConfig({}, true).autostart).toBe(true);
    expect(resolveConfig({}, false).autostart).toBe(false);
  });

  it('lets ALARM_AUTOSTART override the default either way', () => {
    expect(resolveConfig({ ALARM_AUTOSTART: '0' }, true).autostart).toBe(false);
    expect(resolveConfig({ ALARM_AUTOSTART: '1' }, false).autostart).toBe(true);
  });

  it('never seeds dev events unless ALARM_DEV_SEED is exactly 1', () => {
    expect(resolveConfig({}, true).devSeed).toBe(false);
    expect(resolveConfig({ ALARM_DEV_SEED: 'true' }, false).devSeed).toBe(false);
    expect(resolveConfig({ ALARM_DEV_SEED: '1' }, false).devSeed).toBe(true);
  });

  it('resets the dev cache only when ALARM_DEV_SEED_RESET is exactly 1', () => {
    expect(resolveConfig({}, false).devSeedReset).toBe(false);
    expect(resolveConfig({ ALARM_DEV_SEED_RESET: '1' }, false).devSeedReset).toBe(true);
  });

  it('honours ALARM_APP_URL only outside packaged builds', () => {
    const env = { ALARM_APP_URL: 'http://localhost:3021' };
    expect(resolveConfig(env, false).appUrl).toBe('http://localhost:3021');
    expect(resolveConfig(env, true).appUrl).toBeNull();
    expect(resolveConfig({}, false).appUrl).toBeNull();
  });

  it('honours ALARM_APP_DIST only outside packaged builds', () => {
    const env = { ALARM_APP_DIST: 'C:/other/dist' };
    expect(resolveConfig(env, false).appDist).toBe('C:/other/dist');
    expect(resolveConfig(env, true).appDist).toBeNull();
  });

  it('knows whether autostart was set explicitly, and whether the login item asked for a hidden start', () => {
    expect(resolveConfig({}, true).autostartForced).toBe(false);
    expect(resolveConfig({ ALARM_AUTOSTART: '0' }, true).autostartForced).toBe(true);
    expect(resolveConfig({}, true, ['electron.exe', '--hidden']).startHidden).toBe(true);
    expect(resolveConfig({}, true, ['electron.exe']).startHidden).toBe(false);
  });
});

describe('resolveUserDataDir', () => {
  const appData = resolve('appdata-root');
  const daily = join(appData, 'alarm-calendar-dev');
  const seed = join(appData, 'alarm-calendar-dev-seed');
  const scratch = resolve('scratch-user-data');

  it('uses the daily dev folder for a plain unpackaged run', () => {
    expect(resolveUserDataDir({}, false, appData)).toBe(daily);
  });

  it('uses the separate seed folder for ALARM_DEV_SEED=1', () => {
    expect(resolveUserDataDir({ ALARM_DEV_SEED: '1' }, false, appData)).toBe(seed);
  });

  it('uses the separate seed folder for ALARM_DEV_SEED_RESET=1, never the daily one', () => {
    expect(resolveUserDataDir({ ALARM_DEV_SEED_RESET: '1' }, false, appData)).toBe(seed);
    expect(
      resolveUserDataDir({ ALARM_DEV_SEED: '1', ALARM_DEV_SEED_RESET: '1' }, false, appData)
    ).toBe(seed);
  });

  it('uses ALARM_USER_DATA_DIR when set, with or without seeding', () => {
    expect(resolveUserDataDir({ ALARM_USER_DATA_DIR: scratch }, false, appData)).toBe(scratch);
    expect(
      resolveUserDataDir({ ALARM_USER_DATA_DIR: scratch, ALARM_DEV_SEED_RESET: '1' }, false, appData)
    ).toBe(scratch);
  });

  it('refuses to seed or reset an override that points at real app data', () => {
    for (const real of [daily, join(appData, 'alarm-calendar'), daily.toUpperCase()]) {
      expect(() =>
        resolveUserDataDir({ ALARM_USER_DATA_DIR: real, ALARM_DEV_SEED_RESET: '1' }, false, appData)
      ).toThrow(/real app data/);
    }
  });

  it('ignores every override and seed flag in packaged builds', () => {
    const env = {
      ALARM_USER_DATA_DIR: scratch,
      ALARM_DEV_SEED: '1',
      ALARM_DEV_SEED_RESET: '1',
    };
    expect(resolveUserDataDir(env, true, appData)).toBe(join(appData, 'alarm-calendar'));
  });
});
