import { contextBridge, ipcRenderer } from 'electron';
import type { CompletionRow, DesktopApi, ScheduleResult } from '@alarm-calendar/core';

import { DESKTOP_CHANNELS } from './alarm-ipc';

// The main window's whole privileged surface. A separate preload from the alarm
// window's, so the alarm page cannot even see these calls. Main validates every
// payload and only accepts them from the main window's top frame.
const desktopApi: DesktopApi = {
  setSchedule: (payload) => ipcRenderer.invoke(DESKTOP_CHANNELS.setSchedule, payload) as Promise<ScheduleResult>,
  drainCompletions: () =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.drainCompletions) as Promise<CompletionRow[]>,
  setSession: (session) => ipcRenderer.invoke(DESKTOP_CHANNELS.setSession, session) as Promise<void>,
  getAutostart: () => ipcRenderer.invoke(DESKTOP_CHANNELS.getAutostart) as Promise<boolean>,
  setAutostart: (enabled) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.setAutostart, enabled) as Promise<boolean>,
};

contextBridge.exposeInMainWorld('desktopApi', desktopApi);
