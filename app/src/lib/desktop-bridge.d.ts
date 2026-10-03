import type { AlarmApi, DesktopApi } from '@alarm-calendar/core';

declare global {
  interface Window {
    /** Alarm window only; exposed by electron/src/alarm-preload.ts. */
    alarmApi?: AlarmApi;
    /** Main window only; exposed by electron/src/main-preload.ts. */
    desktopApi?: DesktopApi;
  }
}
