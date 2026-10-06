import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fake } from '@/test/fake-supabase';

vi.mock('@/lib/supabase', async () => {
  const { fakeClient } = await import('@/test/fake-supabase');
  return { supabase: fakeClient };
});

import { useEventsStore } from '@/features/events/events-store';
import { handleSettingsChange } from '@/features/realtime/realtime-handlers';

import { setPrayersEnabled, updateSettings } from './settings-api';
import { switchPrayers, useSettingsStore } from './settings-store';

const row = {
  user_id: 'u1',
  timezone: 'Africa/Tunis',
  week_starts_on: 0,
  refire_seconds: 120,
  pass_cap: 2,
  grace_minutes: 30,
  prayers_enabled: true,
};

beforeEach(() => {
  fake.reset();
  useSettingsStore.setState({ settings: null });
  useEventsStore.setState({ events: [], status: 'idle', error: null });
});

describe('prayer settings writes', () => {
  it('sends the prayer columns with the normal ones, in one UPDATE', async () => {
    fake.responses['update:settings'] = { data: row, error: null };
    await updateSettings('u1', { timezone: 'Africa/Tunis', latitude: 36.8, longitude: 10.2, fajr_offset_min: -2, asr_factor: 2 });
    expect(fake.payloadOf('update:settings')).toEqual({
      timezone: 'Africa/Tunis',
      latitude: 36.8,
      longitude: 10.2,
      fajr_offset_min: -2,
      asr_factor: 2,
    });
  });

  it('never writes the prayer switch with a plain UPDATE: that goes through the RPC', async () => {
    fake.responses['update:settings'] = { data: row, error: null };
    await updateSettings('u1', { timezone: 'Africa/Tunis', prayers_enabled: true, prayers_enabled_since: '2026-01-01T00:00:00Z' } as never);
    expect(fake.payloadOf('update:settings')).toEqual({ timezone: 'Africa/Tunis' });
  });

  it('switches prayers with one RPC call', async () => {
    fake.responses['rpc:set_prayers_enabled'] = { data: null, error: null };
    expect((await setPrayersEnabled(true)).error).toBeNull();
    expect(fake.calls.find((call) => call.name === 'rpc:set_prayers_enabled')?.payload).toEqual({ p_enabled: true });
  });

  it('reports a failed switch', async () => {
    fake.responses['rpc:set_prayers_enabled'] = { data: null, error: { message: 'boom' } };
    expect((await setPrayersEnabled(false)).error).toBe('boom');
  });
});

describe('switchPrayers', () => {
  it('reloads settings and events after the switch so the 10 alarms appear', async () => {
    fake.responses['rpc:set_prayers_enabled'] = { data: null, error: null };
    fake.responses['select:settings'] = { data: row, error: null };
    fake.responses['select:events'] = {
      data: [
        { id: 'e1', user_id: 'u1', title: 'Fajr', kind: 'prayer', prayer: 'fajr', active: true },
      ],
      error: null,
    };
    const result = await switchPrayers(true);
    expect(result.error).toBeNull();
    expect(fake.names()).toEqual(expect.arrayContaining(['rpc:set_prayers_enabled', 'select:settings', 'select:events']));
    expect(useSettingsStore.getState().settings?.prayers_enabled).toBe(true);
    expect(useEventsStore.getState().events).toHaveLength(1);
  });

  it('does not reload anything when the switch itself failed', async () => {
    fake.responses['rpc:set_prayers_enabled'] = { data: null, error: { message: 'no' } };
    const result = await switchPrayers(true);
    expect(result.error).toBe('no');
    expect(fake.names()).toEqual(['rpc:set_prayers_enabled']);
  });

  it('says so when the switch worked but the refresh did not', async () => {
    fake.responses['rpc:set_prayers_enabled'] = { data: null, error: null };
    fake.responses['select:settings'] = { data: null, error: { message: 'offline' } };
    fake.responses['select:events'] = { data: [], error: null };
    const result = await switchPrayers(true);
    expect(result.error).toMatch(/switched/i);
  });
});

describe('a settings change from another device', () => {
  it('carries the prayer fields with their types', () => {
    handleSettingsChange({
      eventType: 'UPDATE',
      old: {},
      new: {
        ...row,
        prayers_enabled_since: '2026-10-06T08:00:00+00:00',
        latitude: 36.8625,
        longitude: '10.1956',
        location_label: 'Ariana, Tunisia',
        asr_factor: 2,
        dhuhr_offset_min: 3,
        pre_prayer_minutes: 20,
      },
    });
    expect(useSettingsStore.getState().settings).toMatchObject({
      prayers_enabled: true,
      prayers_enabled_since: '2026-10-06T08:00:00+00:00',
      latitude: 36.8625,
      longitude: 10.1956,
      location_label: 'Ariana, Tunisia',
      asr_factor: 2,
      dhuhr_offset_min: 3,
      pre_prayer_minutes: 20,
    });
  });

  it('leaves out prayer fields the row does not carry', () => {
    handleSettingsChange({ eventType: 'UPDATE', old: {}, new: { ...row, prayers_enabled: false } });
    const settings = useSettingsStore.getState().settings;
    expect(settings?.prayers_enabled).toBe(false);
    expect(settings).not.toHaveProperty('latitude');
  });
});
