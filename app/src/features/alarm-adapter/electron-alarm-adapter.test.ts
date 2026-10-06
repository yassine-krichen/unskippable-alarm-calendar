import { buildSchedulePayload } from '@alarm-calendar/core';
import type { CompletionRow, DesktopApi, ScheduleDropped, SchedulePayload } from '@alarm-calendar/core';
import { describe, expect, it, vi } from 'vitest';

import { createAlarmAdapter } from './create-alarm-adapter';
import { ElectronAlarmAdapter } from './electron-alarm-adapter';
import { NoopAlarmAdapter } from './noop-alarm-adapter';

const SETTINGS = {
  user_id: 'u1',
  timezone: 'UTC',
  week_starts_on: 0,
  refire_seconds: 120,
  pass_cap: 2,
  grace_minutes: 30,
  sound: 'bell',
};

const NOTHING_DROPPED: ScheduleDropped = { occurrences: 0, events: 0, cheatDays: 0, completions: 0 };

const PAYLOAD: SchedulePayload = buildSchedulePayload({
  events: [],
  cheatDays: ['2026-03-04'],
  settings: SETTINGS,
  completions: [],
  now: new Date('2026-03-02T09:00:00.000Z'),
});

function fakeBridge(drained: CompletionRow[] = [], dropped: ScheduleDropped = NOTHING_DROPPED) {
  const received: SchedulePayload[] = [];
  const bridge: Pick<DesktopApi, 'setSchedule' | 'drainCompletions'> = {
    setSchedule: (payload) => {
      received.push(payload);
      return Promise.resolve({ dropped: dropped });
    },
    drainCompletions: () => Promise.resolve(drained),
  };
  return { bridge, received };
}

describe('ElectronAlarmAdapter', () => {
  it('sends the precomputed schedule to the bridge unchanged', async () => {
    const { bridge, received } = fakeBridge();
    await new ElectronAlarmAdapter(bridge).setSchedule(PAYLOAD);
    expect(received).toEqual([PAYLOAD]);
  });

  it('reports rows main had to drop, once per push, and stays quiet when nothing was dropped', async () => {
    const dropped = { occurrences: 3, events: 1, cheatDays: 0, completions: 2 };
    const onRowsDropped = vi.fn();

    await new ElectronAlarmAdapter(fakeBridge([], dropped).bridge, onRowsDropped).setSchedule(PAYLOAD);
    expect(onRowsDropped).toHaveBeenCalledWith(dropped);

    onRowsDropped.mockClear();
    await new ElectronAlarmAdapter(fakeBridge().bridge, onRowsDropped).setSchedule(PAYLOAD);
    expect(onRowsDropped).not.toHaveBeenCalled();
  });

  it('passes a bridge failure on to the caller', async () => {
    const bridge = {
      setSchedule: () => Promise.reject(new Error('invalid schedule payload')),
      drainCompletions: () => Promise.resolve([]),
    };
    await expect(new ElectronAlarmAdapter(bridge).setSchedule(PAYLOAD)).rejects.toThrow(
      'invalid schedule payload'
    );
  });

  it('drains whatever the bridge hands back', async () => {
    const row = { id: 'c1' } as CompletionRow;
    const { bridge } = fakeBridge([row]);
    expect(await new ElectronAlarmAdapter(bridge).drainCompletions()).toEqual([row]);
  });

  it('reports every permission as granted on desktop and has nothing to open', async () => {
    const adapter = new ElectronAlarmAdapter(fakeBridge().bridge);
    expect(await adapter.getPermissionStatus()).toEqual({
      exactAlarm: true,
      fullScreenIntent: true,
      notifications: true,
      batteryOptimizationExempt: true,
    });
    await expect(adapter.openPermissionSettings()).resolves.toBeUndefined();
  });
});

describe('createAlarmAdapter', () => {
  const bridge = fakeBridge().bridge as DesktopApi;

  it('picks the Electron adapter when the shell is Electron and the bridge exists', () => {
    expect(createAlarmAdapter({ platform: 'electron', bridge })).toBeInstanceOf(ElectronAlarmAdapter);
  });

  it('falls back to the no-op adapter in the browser', () => {
    expect(createAlarmAdapter({ platform: 'web', bridge: undefined })).toBeInstanceOf(NoopAlarmAdapter);
  });

  it('uses the no-op adapter on Android until the Capacitor adapter exists', () => {
    expect(createAlarmAdapter({ platform: 'android', bridge: undefined })).toBeInstanceOf(NoopAlarmAdapter);
  });

  it('warns and falls back when the Electron shell lost its bridge', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(createAlarmAdapter({ platform: 'electron', bridge: undefined })).toBeInstanceOf(NoopAlarmAdapter);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('NoopAlarmAdapter', () => {
  it('accepts a schedule and drains nothing', async () => {
    const adapter = new NoopAlarmAdapter();
    await expect(adapter.setSchedule()).resolves.toBeUndefined();
    expect(await adapter.drainCompletions()).toEqual([]);
  });
});
