import type { AlarmAdapter, DesktopApi } from '@alarm-calendar/core';

import { detectPlatform, type Platform } from '@/lib/platform';

import { ElectronAlarmAdapter } from './electron-alarm-adapter';
import { NoopAlarmAdapter } from './noop-alarm-adapter';
import { reportScheduleProblem } from './schedule-problem';

/**
 * Picks the AlarmAdapter for the shell the app runs in. The Android case is where
 * CapacitorAlarmAdapter (the AlarmEngine plugin) slots in once the native project exists; until
 * then Android, like the browser, gets the no-op adapter.
 */
export function createAlarmAdapter(options: { platform?: Platform; bridge?: DesktopApi } = {}): AlarmAdapter {
  const platform = options.platform ?? detectPlatform();
  const bridge = 'bridge' in options ? options.bridge : window.desktopApi;
  if (platform === 'electron') {
    if (bridge !== undefined) return new ElectronAlarmAdapter(bridge, reportScheduleProblem);
    console.warn('Electron shell without the desktop bridge: alarms will not be scheduled.');
  }
  return new NoopAlarmAdapter();
}

let shared: AlarmAdapter | null = null;

export function getAlarmAdapter(): AlarmAdapter {
  shared ??= createAlarmAdapter();
  return shared;
}
