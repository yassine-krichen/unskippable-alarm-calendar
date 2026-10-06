import type { Settings } from '@alarm-calendar/core';
import { create } from 'zustand';

import { loadEvents } from '@/features/events/events-store';
import { createLatestRequestGuard } from '@/lib/latest-request';
import { fail, ok, type Result } from '@/lib/result';

import { createSettings, fetchSettings, setPrayersEnabled, updateSettings, type SettingsPatch } from './settings-api';

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

/**
 * Switches the prayer alarms on or off (one database call, see setPrayersEnabled), then reloads the
 * settings and the events so the app, and through it the alarm engine, sees the 10 prayer alarms
 * appear or go. The switch itself having worked while the reload failed is reported as an error that
 * says so: the toggle would otherwise look unchanged.
 */
export async function switchPrayers(enabled: boolean): Promise<Result<null>> {
  const switched = await setPrayersEnabled(enabled);
  if (switched.error !== null) return switched;
  loadGuard.invalidate();
  const [settings, events] = await Promise.all([loadSettings(), loadEvents()]);
  if (settings.error !== null || events.error !== null) {
    return fail('Prayer alarms were switched, but the app could not refresh. Reload to see them.');
  }
  return ok(null);
}

export async function createMissingSettings(userId: string, timezone: string): Promise<Result<Settings>> {
  const result = await createSettings(userId, timezone);
  if (result.data) useSettingsStore.getState().setSettings(result.data);
  return result;
}
