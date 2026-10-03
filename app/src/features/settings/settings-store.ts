import type { Settings } from '@alarm-calendar/core';
import { create } from 'zustand';

import { createLatestRequestGuard } from '@/lib/latest-request';
import type { Result } from '@/lib/result';

import { createSettings, fetchSettings, updateSettings, type SettingsPatch } from './settings-api';

interface SettingsState {
  settings: Settings | null;
  setSettings: (settings: Settings) => void;
}

// A save by the user makes an in-flight load stale. Realtime changes deliberately do not: they
// can arrive while the catch-up load after a reconnect is in flight, and that load must land.
const loadGuard = createLatestRequestGuard();

// Settings feed the calendar, the event form and the pass logic, so they are shared state.
export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  setSettings: (settings) => set({ settings }),
}));

export async function loadSettings(): Promise<Result<Settings | null>> {
  const isLatest = loadGuard.begin();
  const result = await fetchSettings();
  if (result.data && isLatest()) useSettingsStore.getState().setSettings(result.data);
  return result;
}

export async function saveSettings(userId: string, patch: SettingsPatch): Promise<Result<Settings>> {
  const result = await updateSettings(userId, patch);
  if (result.data) loadGuard.invalidate();
  if (result.data) useSettingsStore.getState().setSettings(result.data);
  return result;
}

export async function createMissingSettings(userId: string, timezone: string): Promise<Result<Settings>> {
  const result = await createSettings(userId, timezone);
  if (result.data) useSettingsStore.getState().setSettings(result.data);
  return result;
}
