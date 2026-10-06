import { contextBridge, ipcRenderer } from 'electron';
import type {
  ChooseCustomSoundResult,
  CompletionRow,
  CustomSoundData,
  CustomSoundInfo,
  DesktopApi,
  ScheduleResult,
} from '@alarm-calendar/core';

import { DESKTOP_CHANNELS } from './alarm-ipc';

// The main window's whole privileged surface. A separate preload from the alarm
// window's, so the alarm page cannot even see these calls. Main validates every
// payload and only accepts them from the main window's top frame.
const desktopApi: DesktopApi = {
  setSchedule: (payload) => ipcRenderer.invoke(DESKTOP_CHANNELS.setSchedule, payload) as Promise<ScheduleResult>,
  drainCompletions: () =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.drainCompletions) as Promise<CompletionRow[]>,
  getPendingDoneOccurrences: () =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.pendingDoneOccurrences) as Promise<string[]>,
  setSession: (session) => ipcRenderer.invoke(DESKTOP_CHANNELS.setSession, session) as Promise<void>,
  getAutostart: () => ipcRenderer.invoke(DESKTOP_CHANNELS.getAutostart) as Promise<boolean>,
  setAutostart: (enabled) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.setAutostart, enabled) as Promise<boolean>,
  getCustomSound: () => ipcRenderer.invoke(DESKTOP_CHANNELS.getCustomSound) as Promise<CustomSoundInfo | null>,
  chooseCustomSound: () =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.chooseCustomSound) as Promise<ChooseCustomSoundResult>,
  clearCustomSound: () => ipcRenderer.invoke(DESKTOP_CHANNELS.clearCustomSound) as Promise<void>,
  readCustomSound: () => ipcRenderer.invoke(DESKTOP_CHANNELS.readCustomSound) as Promise<CustomSoundData | null>,
};

contextBridge.exposeInMainWorld('desktopApi', desktopApi);
