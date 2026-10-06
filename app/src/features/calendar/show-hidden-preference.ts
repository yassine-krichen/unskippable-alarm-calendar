import { create } from 'zustand';

import { readDevicePreference, writeDevicePreference } from '@/lib/device-preference';

const SHOW_HIDDEN_KEY = 'alarm-calendar-show-hidden';

interface ShowHiddenState {
  /** Whether the calendar draws alarms the person hid from it (faded). Per device, like the alarm sound. */
  showHidden: boolean;
  setShowHidden: (next: boolean) => void;
}

/** Off unless this device turned it on; unreadable storage means off. */
export function readShowHidden(): boolean {
  return readDevicePreference(SHOW_HIDDEN_KEY) === '1';
}

// Kept in memory too, so a choice the browser refused to store still holds for this session.
export const useShowHiddenStore = create<ShowHiddenState>((set) => ({
  showHidden: readShowHidden(),
  setShowHidden: (next) => {
    writeDevicePreference(SHOW_HIDDEN_KEY, next ? '1' : '0');
    set({ showHidden: next });
  },
}));
