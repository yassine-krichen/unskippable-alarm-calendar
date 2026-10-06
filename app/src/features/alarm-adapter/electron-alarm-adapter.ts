import type {
  AlarmAdapter,
  CompletionRow,
  DesktopApi,
  PermissionStatus,
  ScheduleDropped,
  SchedulePayload,
} from '@alarm-calendar/core';

// A desktop has no runtime permissions to grant: nothing for the permissions panel to show.
const ALL_GRANTED: PermissionStatus = {
  exactAlarm: true,
  fullScreenIntent: true,
  notifications: true,
  batteryOptimizationExempt: true,
};

/**
 * AlarmAdapter over the Electron preload bridge (`window.desktopApi`). The bridge validates
 * and persists everything in the main process, which owns the scheduler.
 */
export class ElectronAlarmAdapter implements AlarmAdapter {
  constructor(
    private readonly bridge: Pick<DesktopApi, 'setSchedule' | 'drainCompletions' | 'getPendingDoneOccurrences'>,
    /** Called when main refused rows of a schedule it otherwise accepted. */
    private readonly onRowsDropped: (dropped: ScheduleDropped) => void = () => undefined
  ) {}

  async setSchedule(payload: SchedulePayload): Promise<void> {
    const { dropped } = await this.bridge.setSchedule(payload);
    if (dropped.occurrences + dropped.events + dropped.cheatDays + dropped.completions > 0) {
      this.onRowsDropped(dropped);
    }
  }

  /**
   * Always empty on desktop: the main process flushes completions to Supabase itself (see
   * electron/src/completion-flusher.ts), so handing them out here as well would write twice.
   * Kept because the interface is shared with Android, where the app does the upsert.
   */
  drainCompletions(): Promise<CompletionRow[]> {
    return this.bridge.drainCompletions();
  }

  getPendingDoneOccurrences(): Promise<string[]> {
    return this.bridge.getPendingDoneOccurrences();
  }

  getPermissionStatus(): Promise<PermissionStatus> {
    return Promise.resolve(ALL_GRANTED);
  }

  openPermissionSettings(): Promise<void> {
    return Promise.resolve();
  }
}
