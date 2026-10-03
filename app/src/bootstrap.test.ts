import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fake } from '@/test/fake-supabase';

vi.mock('@/lib/supabase', async () => {
  const { fakeClient } = await import('@/test/fake-supabase');
  return { supabase: fakeClient };
});

const device = vi.hoisted(() => ({ timeZone: 'Africa/Tunis' as string | null }));
vi.mock('@/lib/zoned-time', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/zoned-time')>()),
  detectDeviceTimeZone: () => device.timeZone,
}));

import { bootstrap } from './bootstrap';

const settingsRow = (timezone: string) => ({
  user_id: 'u1',
  timezone,
  week_starts_on: 0,
  refire_seconds: 120,
  pass_cap: 2,
  grace_minutes: 30,
});

const walletJson = {
  balance: 1,
  last_granted_week_start: '2026-09-28',
  timezone: 'Africa/Tunis',
  week_starts_on: 0,
};

function arrange(options: { settings: ReturnType<typeof settingsRow> | null; anchored: boolean }): void {
  fake.reset();
  device.timeZone = 'Africa/Tunis';
  fake.responses['select:settings'] = { data: options.settings, error: null };
  fake.responses['select:pass_wallet'] = {
    data: { anchored_at: options.anchored ? '2026-09-20T00:00:00Z' : null },
    error: null,
  };
  fake.responses['update:settings'] = { data: settingsRow('Africa/Tunis'), error: null };
  fake.responses['insert:settings'] = { data: settingsRow('Africa/Tunis'), error: null };
  fake.responses['rpc:sync_wallet'] = { data: walletJson, error: null };
  fake.responses['select:cheat_days'] = { data: [], error: null };
  fake.responses['select:events'] = { data: [], error: null };
}

beforeEach(() => fake.reset());

describe('bootstrap', () => {
  it('on a fresh account reads the wallet anchor, then UPDATEs the device zone, then syncs the wallet', async () => {
    arrange({ settings: settingsRow('UTC'), anchored: false });

    expect(await bootstrap('u1')).toBeNull();

    const names = fake.names();
    expect(names.slice(0, 4)).toEqual(['select:settings', 'select:pass_wallet', 'update:settings', 'rpc:sync_wallet']);
    expect(fake.payloadOf('select:pass_wallet')).toBe('anchored_at');
    expect(fake.payloadOf('update:settings')).toEqual({ timezone: 'Africa/Tunis' });
    expect(names).not.toContain('upsert:settings');
    expect(names).toEqual(expect.arrayContaining(['select:cheat_days', 'select:events']));
  });

  it('does not overwrite a deliberate UTC choice once the wallet is anchored', async () => {
    arrange({ settings: settingsRow('UTC'), anchored: true });

    expect(await bootstrap('u1')).toBeNull();

    expect(fake.names()).not.toContain('update:settings');
    expect(fake.names()).toContain('rpc:sync_wallet');
  });

  it('leaves a zone the person already picked alone', async () => {
    arrange({ settings: settingsRow('Europe/Berlin'), anchored: false });

    await bootstrap('u1');

    expect(fake.names()).not.toContain('update:settings');
  });

  it('does nothing about the zone when the device is on UTC', async () => {
    arrange({ settings: settingsRow('UTC'), anchored: false });
    device.timeZone = 'UTC';

    await bootstrap('u1');

    expect(fake.names()).not.toContain('update:settings');
  });

  it('creates a missing settings row with the device zone before the first sync', async () => {
    arrange({ settings: null, anchored: false });

    expect(await bootstrap('u1')).toBeNull();

    const names = fake.names();
    expect(names.indexOf('insert:settings')).toBeGreaterThan(-1);
    expect(names.indexOf('insert:settings')).toBeLessThan(names.indexOf('rpc:sync_wallet'));
    expect(fake.payloadOf('insert:settings')).toEqual({ user_id: 'u1', timezone: 'Africa/Tunis' });
    expect(names).not.toContain('upsert:settings');
    expect(names).not.toContain('update:settings');
  });

  it('stops before syncing when the wallet anchor cannot be read', async () => {
    arrange({ settings: settingsRow('UTC'), anchored: false });
    fake.responses['select:pass_wallet'] = { data: null, error: { message: 'boom' } };

    expect(await bootstrap('u1')).toBe('boom');
    expect(fake.names()).not.toContain('rpc:sync_wallet');
  });

  it('stops before syncing when the zone cannot be saved, so the wallet never anchors in UTC', async () => {
    arrange({ settings: settingsRow('UTC'), anchored: false });
    fake.responses['update:settings'] = { data: null, error: { message: 'nope' } };

    expect(await bootstrap('u1')).toMatch(/Could not save your time zone/);
    expect(fake.names()).not.toContain('rpc:sync_wallet');
  });
});
