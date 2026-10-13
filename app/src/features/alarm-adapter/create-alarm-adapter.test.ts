import type { DesktopApi } from '@alarm-calendar/core';
import { describe, expect, it, vi } from 'vitest';

import type { AlarmEnginePlugin } from './alarm-engine-plugin';
import { CapacitorAlarmAdapter } from './capacitor-alarm-adapter';
import { createAlarmAdapter } from './create-alarm-adapter';
import { ElectronAlarmAdapter } from './electron-alarm-adapter';
import { NoopAlarmAdapter } from './noop-alarm-adapter';

const ENGINE = {} as AlarmEnginePlugin;
const BRIDGE = {} as DesktopApi;

describe('createAlarmAdapter', () => {
  it('uses the AlarmEngine plugin in the Android app', () => {
    const adapter = createAlarmAdapter({ platform: 'android', bridge: undefined, nativePlatform: true, engine: ENGINE });
    expect(adapter).toBeInstanceOf(CapacitorAlarmAdapter);
  });

  it('does not touch the plugin when the page only looks like Android (no Capacitor shell around it)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const adapter = createAlarmAdapter({ platform: 'android', bridge: undefined, nativePlatform: false, engine: ENGINE });
    expect(adapter).toBeInstanceOf(NoopAlarmAdapter);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps the desktop on the Electron bridge, whatever else is around', () => {
    const adapter = createAlarmAdapter({ platform: 'electron', bridge: BRIDGE, nativePlatform: true, engine: ENGINE });
    expect(adapter).toBeInstanceOf(ElectronAlarmAdapter);
  });

  it('gives a plain browser the no-op adapter', () => {
    expect(createAlarmAdapter({ platform: 'web', bridge: undefined, nativePlatform: true, engine: ENGINE })).toBeInstanceOf(
      NoopAlarmAdapter
    );
  });
});
