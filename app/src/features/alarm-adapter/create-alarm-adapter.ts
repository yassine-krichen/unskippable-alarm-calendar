import { Capacitor } from '@capacitor/core';
import type { AlarmAdapter, DesktopApi } from '@alarm-calendar/core';

import { detectPlatform, type Platform } from '@/lib/platform';

import { AlarmEngine, type AlarmEnginePlugin } from './alarm-engine-plugin';
import { CapacitorAlarmAdapter } from './capacitor-alarm-adapter';
import { ElectronAlarmAdapter } from './electron-alarm-adapter';
import { NoopAlarmAdapter } from './noop-alarm-adapter';
import { reportScheduleProblem } from './schedule-problem';

export interface CreateAlarmAdapterOptions {
  platform?: Platform;
  bridge?: DesktopApi;
  /** The AlarmEngine plugin; injectable for tests. */
  engine?: AlarmEnginePlugin;
  /** Whether the app runs inside the Capacitor shell (a browser page with Capacitor loaded is not); injectable for tests. */
  nativePlatform?: boolean;
}

/**
 * Picks the AlarmAdapter for the shell the app runs in: the Electron bridge on the desktop, the
 * AlarmEngine plugin in the Android app, and the no-op adapter in a plain browser.
 */
export function createAlarmAdapter(options: CreateAlarmAdapterOptions = {}): AlarmAdapter {
  const platform = options.platform ?? detectPlatform();
  const bridge = 'bridge' in options ? options.bridge : window.desktopApi;
  if (platform === 'electron') {
    if (bridge !== undefined) return new ElectronAlarmAdapter(bridge, reportScheduleProblem);
    console.warn('Electron shell without the desktop bridge: alarms will not be scheduled.');
  }
  if (platform === 'android') {
    if (options.nativePlatform ?? Capacitor.isNativePlatform()) {
      return new CapacitorAlarmAdapter(options.engine ?? AlarmEngine, reportScheduleProblem);
    }
    console.warn('Android platform outside the native shell: alarms will not be scheduled.');
  }
  return new NoopAlarmAdapter();
}

let shared: AlarmAdapter | null = null;

export function getAlarmAdapter(): AlarmAdapter {
  shared ??= createAlarmAdapter();
  return shared;
}
