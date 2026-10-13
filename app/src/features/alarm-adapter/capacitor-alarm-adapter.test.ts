import { buildSchedulePayload } from '@alarm-calendar/core';
import type { CompletionRow, SchedulePayload } from '@alarm-calendar/core';
import { describe, expect, it, vi } from 'vitest';

import type { AlarmEnginePlugin, EnginePermissionStatus } from './alarm-engine-plugin';
import { CapacitorAlarmAdapter } from './capacitor-alarm-adapter';

const SETTINGS = {
  user_id: 'u1',
  timezone: 'UTC',
  week_starts_on: 0,
  refire_seconds: 120,
  pass_cap: 2,
  grace_minutes: 30,
  sound: 'bell',
};

const PAYLOAD: SchedulePayload = buildSchedulePayload({
  events: [],
  cheatDays: ['2026-03-04'],
  settings: SETTINGS,
  completions: [],
  now: new Date('2026-03-02T09:00:00.000Z'),
});

const PERMISSIONS: EnginePermissionStatus = {
  exactAlarm: true,
  fullScreenIntent: false,
  notifications: true,
  batteryOptimizationExempt: false,
  details: {
    manufacturer: 'Xiaomi',
    sdk: 36,
    xiaomi: true,
    autostart: 'unknown',
    lockScreen: 'granted',
    backgroundPopup: 'denied',
    runtimeNotificationPermission: true,
  },
};

function fakePlugin(overrides: Partial<AlarmEnginePlugin> = {}) {
  const calls: Array<{ method: string; args: unknown }> = [];
  const record =
    <T>(method: string, result: T) =>
    (args?: unknown): Promise<T> => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };
  const engine: AlarmEnginePlugin = {
    setSchedule: record('setSchedule', { accepted: true, dropped: { occurrences: 0, eventInfo: 0 } }),
    peekCompletions: record('peekCompletions', { completions: [] as CompletionRow[] }),
    ackCompletions: record('ackCompletions', { acked: 0 }),
    getPendingDoneOccurrences: record('getPendingDoneOccurrences', { ids: [] as string[] }),
    getPermissionStatus: record('getPermissionStatus', PERMISSIONS),
    openPermissionSettings: record('openPermissionSettings', { opened: 'x', fallback: false }),
    ...overrides,
  };
  return { engine, calls };
}

describe('CapacitorAlarmAdapter', () => {
  it('hands the engine the precomputed schedule, without the desktop-only refill source', async () => {
    const { engine, calls } = fakePlugin();
    await new CapacitorAlarmAdapter(engine).setSchedule(PAYLOAD);

    const sent = calls[0]?.args as { payload: Record<string, unknown> };
    expect(calls[0]?.method).toBe('setSchedule');
    expect(sent.payload).not.toHaveProperty('refillSource');
    expect(sent.payload).toMatchObject({
      version: 2,
      generatedAt: PAYLOAD.generatedAt,
      horizonEnd: PAYLOAD.horizonEnd,
      occurrences: PAYLOAD.occurrences,
      eventInfo: PAYLOAD.eventInfo,
    });
  });

  it('reports rows the engine dropped, and stays quiet when it kept everything', async () => {
    const onRowsDropped = vi.fn();
    const dropping = fakePlugin({
      setSchedule: () => Promise.resolve({ accepted: true, dropped: { occurrences: 2, eventInfo: 1 } }),
    });
    await new CapacitorAlarmAdapter(dropping.engine, onRowsDropped).setSchedule(PAYLOAD);
    expect(onRowsDropped).toHaveBeenCalledWith({ occurrences: 2, events: 1, cheatDays: 0, completions: 0 });

    onRowsDropped.mockClear();
    await new CapacitorAlarmAdapter(fakePlugin().engine, onRowsDropped).setSchedule(PAYLOAD);
    expect(onRowsDropped).not.toHaveBeenCalled();
  });

  it('passes an engine rejection on to the caller', async () => {
    const { engine } = fakePlugin({ setSchedule: () => Promise.reject(new Error('payload is required')) });
    await expect(new CapacitorAlarmAdapter(engine).setSchedule(PAYLOAD)).rejects.toThrow('payload is required');
  });

  it('unwraps the completions and the pending Done ids the engine returns', async () => {
    const row = { id: 'c1' } as CompletionRow;
    const { engine } = fakePlugin({
      peekCompletions: () => Promise.resolve({ completions: [row] }),
      getPendingDoneOccurrences: () => Promise.resolve({ ids: ['e1@2026-03-02T10:00:00.000Z'] }),
    });
    const adapter = new CapacitorAlarmAdapter(engine);
    expect(await adapter.peekCompletions()).toEqual([row]);
    expect(await adapter.getPendingDoneOccurrences()).toEqual(['e1@2026-03-02T10:00:00.000Z']);
  });

  it('acknowledges by row id, and does not call the engine for an empty list', async () => {
    const { engine, calls } = fakePlugin();
    const adapter = new CapacitorAlarmAdapter(engine);
    await adapter.ackCompletions([]);
    expect(calls).toEqual([]);
    await adapter.ackCompletions(['c1', 'c2']);
    expect(calls).toEqual([{ method: 'ackCompletions', args: { ids: ['c1', 'c2'] } }]);
  });

  it('reports the four permission flags of core and leaves the Xiaomi details to the permissions panel', async () => {
    const { engine } = fakePlugin();
    expect(await new CapacitorAlarmAdapter(engine).getPermissionStatus()).toEqual({
      exactAlarm: true,
      fullScreenIntent: false,
      notifications: true,
      batteryOptimizationExempt: false,
    });
  });

  it('opens the screen it is asked for, and the app page when asked for none', async () => {
    const { engine, calls } = fakePlugin();
    const adapter = new CapacitorAlarmAdapter(engine);
    await adapter.openPermissionSettings();
    await adapter.openPermissionSettings('fullScreenIntent');
    expect(calls.map((call) => call.args)).toEqual([{ kind: 'appDetails' }, { kind: 'fullScreenIntent' }]);
  });
});
