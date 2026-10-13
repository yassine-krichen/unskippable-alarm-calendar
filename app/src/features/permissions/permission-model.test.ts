import { describe, expect, it } from 'vitest';

import type { EnginePermissionStatus } from '@/features/alarm-adapter/alarm-engine-plugin';

import { buildPermissionRows, summarizePermissions } from './permission-model';
import { isDialogOpen } from './permissions-store';

const ALLOWED: EnginePermissionStatus = {
  exactAlarm: true,
  fullScreenIntent: true,
  notifications: true,
  batteryOptimizationExempt: true,
  details: {
    manufacturer: 'Google',
    sdk: 36,
    xiaomi: false,
    autostart: 'notApplicable',
    lockScreen: 'notApplicable',
    backgroundPopup: 'notApplicable',
    runtimeNotificationPermission: true,
  },
};

const HYPEROS: EnginePermissionStatus = {
  ...ALLOWED,
  details: {
    ...ALLOWED.details,
    manufacturer: 'Xiaomi',
    xiaomi: true,
    autostart: 'unknown',
    lockScreen: 'unknown',
    backgroundPopup: 'unknown',
  },
};

function stateOf(status: EnginePermissionStatus, kind: string): string | undefined {
  return buildPermissionRows(status).find((row) => row.kind === kind)?.state;
}

describe('buildPermissionRows', () => {
  it('lists only the four platform checks on a phone that is not Xiaomi', () => {
    expect(buildPermissionRows(ALLOWED).map((row) => row.kind)).toEqual([
      'notifications',
      'fullScreenIntent',
      'exactAlarm',
      'batteryOptimization',
    ]);
  });

  it('adds the three HyperOS switches on a Xiaomi phone', () => {
    expect(buildPermissionRows(HYPEROS).map((row) => row.kind)).toEqual([
      'notifications',
      'fullScreenIntent',
      'exactAlarm',
      'batteryOptimization',
      'autostart',
      'lockScreen',
      'backgroundPopup',
    ]);
  });

  it('shows a HyperOS switch the OS would not answer as "check", never as denied', () => {
    expect(stateOf(HYPEROS, 'autostart')).toBe('check');
    expect(stateOf({ ...HYPEROS, details: { ...HYPEROS.details, autostart: 'denied' } }, 'autostart')).toBe('denied');
    expect(stateOf({ ...HYPEROS, details: { ...HYPEROS.details, autostart: 'granted' } }, 'autostart')).toBe('granted');
  });

  it('maps the platform flags to granted and denied', () => {
    const status = { ...ALLOWED, exactAlarm: false, batteryOptimizationExempt: false };
    expect(stateOf(status, 'exactAlarm')).toBe('denied');
    expect(stateOf(status, 'batteryOptimization')).toBe('denied');
    expect(stateOf(status, 'notifications')).toBe('granted');
  });

  it('requires notifications and full-screen alarms, and nothing else', () => {
    const required = buildPermissionRows(HYPEROS)
      .filter((row) => row.required)
      .map((row) => row.kind);
    expect(required).toEqual(['notifications', 'fullScreenIntent']);
  });
});

describe('summarizePermissions', () => {
  it('has nothing to say when everything is allowed', () => {
    expect(summarizePermissions(ALLOWED)).toMatchObject({ blocking: false, needsAttention: false, deniedCount: 0 });
  });

  it('blocks while notifications or full-screen alarms are missing', () => {
    expect(summarizePermissions({ ...ALLOWED, notifications: false }).blocking).toBe(true);
    expect(summarizePermissions({ ...ALLOWED, fullScreenIntent: false }).blocking).toBe(true);
  });

  it('does not block, but still needs attention, when only an optional permission is missing', () => {
    expect(summarizePermissions({ ...ALLOWED, batteryOptimizationExempt: false })).toMatchObject({
      blocking: false,
      needsAttention: true,
      deniedCount: 1,
    });
  });

  it('does not nag about switches the phone would not report', () => {
    expect(summarizePermissions(HYPEROS)).toMatchObject({ blocking: false, needsAttention: false, deniedCount: 0 });
  });
});

describe('isDialogOpen', () => {
  const optionalOnly = summarizePermissions({ ...ALLOWED, exactAlarm: false });
  const required = summarizePermissions({ ...ALLOWED, notifications: false });

  it('stays closed until the first read, and when nothing is wrong', () => {
    expect(isDialogOpen({ summary: null, dismissedAt: null })).toBe(false);
    expect(isDialogOpen({ summary: summarizePermissions(ALLOWED), dismissedAt: null })).toBe(false);
  });

  it('can be put off ("Remind me later") when only optional permissions are missing', () => {
    expect(isDialogOpen({ summary: optionalOnly, dismissedAt: null })).toBe(true);
    expect(isDialogOpen({ summary: optionalOnly, dismissedAt: 1 })).toBe(false);
  });

  it('cannot be put off while a required permission is missing', () => {
    expect(isDialogOpen({ summary: required, dismissedAt: 1 })).toBe(true);
  });
});
