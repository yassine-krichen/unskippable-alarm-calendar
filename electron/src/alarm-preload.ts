import { contextBridge, ipcRenderer } from 'electron';
import type { CustomSoundData } from '@alarm-calendar/core';

import { ALARM_CHANNELS } from './alarm-ipc';
import type { ActionResult, AlarmApi, AlarmView } from './alarm-ipc';

// Narrow on purpose: six named calls, never ipcRenderer itself. Main validates
// every payload again and only honours the window that owns the occurrence.
const alarmApi: AlarmApi = {
  getAlarm: (occurrenceId) =>
    ipcRenderer.invoke(ALARM_CHANNELS.get, occurrenceId) as Promise<AlarmView | null>,
  done: (occurrenceId) =>
    ipcRenderer.invoke(ALARM_CHANNELS.done, occurrenceId) as Promise<ActionResult>,
  snooze: (occurrenceId) =>
    ipcRenderer.invoke(ALARM_CHANNELS.snooze, occurrenceId) as Promise<ActionResult>,
  later: (occurrenceId, minutes) =>
    ipcRenderer.invoke(ALARM_CHANNELS.later, { occurrenceId, minutes }) as Promise<ActionResult>,
  cantNow: (occurrenceId, shown) =>
    ipcRenderer.invoke(ALARM_CHANNELS.cantNow, { occurrenceId, shown }) as Promise<ActionResult>,
  readCustomSound: (occurrenceId) =>
    ipcRenderer.invoke(ALARM_CHANNELS.customSound, occurrenceId) as Promise<CustomSoundData | null>,
};

contextBridge.exposeInMainWorld('alarmApi', alarmApi);
