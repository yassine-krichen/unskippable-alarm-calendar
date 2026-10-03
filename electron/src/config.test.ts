import { describe, expect, it } from 'vitest';

import { resolveConfig } from './config';

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
});
