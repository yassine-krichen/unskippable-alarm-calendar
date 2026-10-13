import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnginePermissionStatus } from '@/features/alarm-adapter/alarm-engine-plugin';

const status: { current: EnginePermissionStatus } = {
  current: {
    exactAlarm: true,
    fullScreenIntent: true,
    notifications: true,
    batteryOptimizationExempt: false,
    details: {
      manufacturer: 'Google',
      sdk: 36,
      xiaomi: false,
      autostart: 'notApplicable',
      lockScreen: 'notApplicable',
      backgroundPopup: 'notApplicable',
      runtimeNotificationPermission: true,
    },
  },
};

vi.mock('@/features/alarm-adapter/alarm-engine-plugin', () => ({
  AlarmEngine: { getPermissionStatus: () => Promise.resolve(status.current), openPermissionSettings: vi.fn() },
}));
vi.mock('@/lib/platform', () => ({ detectPlatform: () => 'android' }));

import {
  REMIND_LATER_MS,
  checkPermissions,
  dismissPermissionDialog,
  isDialogOpen,
  usePermissionsStore,
} from './permissions-store';

const open = (): boolean => isDialogOpen(usePermissionsStore.getState());

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-13T08:00:00Z'));
  usePermissionsStore.setState({ summary: null, dismissedAt: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the optional-permission reminder', () => {
  it('opens on launch, closes on "Remind me later", and stays closed for a resume soon after', async () => {
    await checkPermissions('launch');
    expect(open()).toBe(true);

    dismissPermissionDialog();
    expect(open()).toBe(false);

    vi.advanceTimersByTime(5 * 60 * 1000);
    await checkPermissions('resume');
    expect(open()).toBe(false);
    // The warning chip is driven by the summary, which still says something is missing.
    expect(usePermissionsStore.getState().summary?.needsAttention).toBe(true);
  });

  it('asks again on a resume once the reminder has aged, and on the next launch', async () => {
    await checkPermissions('launch');
    dismissPermissionDialog();

    vi.advanceTimersByTime(REMIND_LATER_MS);
    await checkPermissions('resume');
    expect(open()).toBe(true);

    dismissPermissionDialog();
    await checkPermissions('launch');
    expect(open()).toBe(true);
  });

  it('does not change the choice when the panel only refreshes the status', async () => {
    await checkPermissions('launch');
    dismissPermissionDialog();
    vi.advanceTimersByTime(2 * REMIND_LATER_MS);
    await checkPermissions('refresh');
    expect(open()).toBe(false);
  });

  it('cannot be put off while a required permission is missing, even right after dismissing', async () => {
    status.current = { ...status.current, notifications: false };
    await checkPermissions('launch');
    dismissPermissionDialog();
    await checkPermissions('resume');
    expect(open()).toBe(true);

    // Granting it closes the dialog, because the only thing left is optional and was put off.
    status.current = { ...status.current, notifications: true };
    await checkPermissions('refresh');
    expect(open()).toBe(false);
  });
});
