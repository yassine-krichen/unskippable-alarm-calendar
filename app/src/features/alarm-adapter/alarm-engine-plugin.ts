import { registerPlugin } from '@capacitor/core';
import type { CompletionRow, SchedulePayload } from '@alarm-calendar/core';

/** The screens `openPermissionSettings` can open (AlarmEnginePlugin.kt); anything else opens the app's own page. */
export type PermissionKind =
  | 'notifications'
  | 'fullScreenIntent'
  | 'exactAlarm'
  | 'batteryOptimization'
  | 'autostart'
  | 'lockScreen'
  | 'backgroundPopup'
  | 'appDetails';

/** What a Xiaomi / HyperOS switch reports: 'unknown' when the OS does not answer, which is not the same as denied. */
export type DetailState = 'granted' | 'denied' | 'unknown' | 'notApplicable';

export interface EnginePermissionDetails {
  manufacturer: string;
  sdk: number;
  xiaomi: boolean;
  autostart: DetailState;
  lockScreen: DetailState;
  backgroundPopup: DetailState;
  runtimeNotificationPermission: boolean;
}

/** core's PermissionStatus plus what only the Android engine can see. */
export interface EnginePermissionStatus {
  exactAlarm: boolean;
  fullScreenIntent: boolean;
  notifications: boolean;
  batteryOptimizationExempt: boolean;
  details: EnginePermissionDetails;
}

/** The JSON contract of the local Kotlin plugin (docs/spec.md section 10, "As built"). */
export interface AlarmEnginePlugin {
  setSchedule(options: {
    payload: Omit<SchedulePayload, 'refillSource'>;
  }): Promise<{ accepted: boolean; dropped: { occurrences: number; eventInfo: number } }>;
  peekCompletions(): Promise<{ completions: CompletionRow[] }>;
  ackCompletions(options: { ids: string[] }): Promise<{ acked: number }>;
  getPendingDoneOccurrences(): Promise<{ ids: string[] }>;
  getPermissionStatus(): Promise<EnginePermissionStatus>;
  openPermissionSettings(options: { kind: PermissionKind }): Promise<{ opened: string; fallback: boolean }>;
}

/** Only call it inside the Android app: there is no web implementation, so any call rejects elsewhere. */
export const AlarmEngine = registerPlugin<AlarmEnginePlugin>('AlarmEngine');
