import type { AlarmAdapter, PermissionStatus } from '@alarm-calendar/core';

const NOTHING_TO_GRANT: PermissionStatus = {
  exactAlarm: true,
  fullScreenIntent: true,
  notifications: true,
  batteryOptimizationExempt: true,
};

/**
 * For the plain browser, where nothing can ring: the app still runs and syncs, the schedule is
 * simply dropped. Also the safe fallback on a platform whose native adapter is not available.
 */
export class NoopAlarmAdapter implements AlarmAdapter {
  setSchedule(): Promise<void> {
    return Promise.resolve();
  }

  peekCompletions(): Promise<[]> {
    return Promise.resolve([]);
  }

  ackCompletions(): Promise<void> {
    return Promise.resolve();
  }

  getPendingDoneOccurrences(): Promise<[]> {
    return Promise.resolve([]);
  }

  getPermissionStatus(): Promise<PermissionStatus> {
    return Promise.resolve(NOTHING_TO_GRANT);
  }

  openPermissionSettings(): Promise<void> {
    return Promise.resolve();
  }
}
