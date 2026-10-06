import { contextBridge, ipcRenderer } from 'electron';
import type { CustomSoundData } from '@alarm-calendar/core';

import { ALARM_CHANNELS } from './alarm-ipc';
import type { ActionResult, AlarmApi, AlarmView } from './alarm-ipc';

// Narrow on purpose: four named calls, never ipcRenderer itself. Main validates
// every payload again and only honours the window that owns the occurrence.
const alarmApi: AlarmApi = {
  getAlarm: (occurrenceId) =>
    ipcRenderer.invoke(ALARM_CHANNELS.get, occurrenceId) as Promise<AlarmView | null>,
  done: (occurrenceId) =>
    ipcRenderer.invoke(ALARM_CHANNELS.done, occurrenceId) as Promise<ActionResult>,
  snooze: (occurrenceId) =>
    ipcRenderer.invoke(ALARM_CHANNELS.snooze, occurrenceId) as Promise<ActionResult>,
  readCustomSound: (occurrenceId) =>
    ipcRenderer.invoke(ALARM_CHANNELS.customSound, occurrenceId) as Promise<CustomSoundData | null>,
};

contextBridge.exposeInMainWorld('alarmApi', alarmApi);
