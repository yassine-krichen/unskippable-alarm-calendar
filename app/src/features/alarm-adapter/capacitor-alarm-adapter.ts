import type {
  AlarmAdapter,
  CompletionRow,
  PermissionStatus,
  ScheduleDropped,
  SchedulePayload,
} from '@alarm-calendar/core';

import type { AlarmEnginePlugin, PermissionKind } from './alarm-engine-plugin';

/**
 * AlarmAdapter over the AlarmEngine plugin (the Kotlin engine in android/). The engine stores the
 * schedule and owns every ring; the app only hands it the list and moves completions to Supabase
 * (see completion-sync.ts), which is why peek and ack are separate calls.
 */
export class CapacitorAlarmAdapter implements AlarmAdapter {
  constructor(
    private readonly engine: AlarmEnginePlugin,
    /** Called when the engine refused rows of a schedule it otherwise accepted. */
    private readonly onRowsDropped: (dropped: ScheduleDropped) => void = () => undefined
  ) {}

  async setSchedule(payload: SchedulePayload): Promise<void> {
    // refillSource (every event row) is for the desktop scheduler; the Kotlin engine ignores it, so it stays off the bridge.
    const { refillSource: _refillSource, ...forEngine } = payload;
    const { dropped } = await this.engine.setSchedule({ payload: forEngine });
    if (dropped.occurrences + dropped.eventInfo > 0) {
      this.onRowsDropped({ occurrences: dropped.occurrences, events: dropped.eventInfo, cheatDays: 0, completions: 0 });
    }
  }

  async peekCompletions(): Promise<CompletionRow[]> {
    return (await this.engine.peekCompletions()).completions;
  }

  async ackCompletions(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.engine.ackCompletions({ ids });
  }

  async getPendingDoneOccurrences(): Promise<string[]> {
    return (await this.engine.getPendingDoneOccurrences()).ids;
  }

  async getPermissionStatus(): Promise<PermissionStatus> {
    const status = await this.engine.getPermissionStatus();
    return {
      exactAlarm: status.exactAlarm,
      fullScreenIntent: status.fullScreenIntent,
      notifications: status.notifications,
      batteryOptimizationExempt: status.batteryOptimizationExempt,
    };
  }

  /** The interface takes no argument; the permissions panel passes the screen it wants, no argument opens the app's own page. */
  async openPermissionSettings(kind: PermissionKind = 'appDetails'): Promise<void> {
    await this.engine.openPermissionSettings({ kind });
  }
}
