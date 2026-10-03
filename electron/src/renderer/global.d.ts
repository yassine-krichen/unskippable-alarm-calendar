import type { AlarmApi } from '../alarm-ipc';

declare global {
  interface Window {
    /** Exposed by the preload script through contextBridge. */
    alarmApi: AlarmApi;
  }
}
