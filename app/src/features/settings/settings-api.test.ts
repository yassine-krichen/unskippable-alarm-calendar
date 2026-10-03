import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fake } from '@/test/fake-supabase';

vi.mock('@/lib/supabase', async () => {
  const { fakeClient } = await import('@/test/fake-supabase');
  return { supabase: fakeClient };
});

import { updateSettings, type SettingsPatch } from './settings-api';

const row = {
  user_id: 'u1',
  timezone: 'Europe/Berlin',
  week_starts_on: 0,
  refire_seconds: 120,
  pass_cap: 2,
  grace_minutes: 30,
};

beforeEach(() => {
  fake.reset();
  fake.responses['update:settings'] = { data: row, error: null };
});

describe('updateSettings', () => {
  it('sends an UPDATE with only the columns a client may write', async () => {
    const result = await updateSettings('u1', {
      timezone: 'Europe/Berlin',
      week_starts_on: 6,
      refire_seconds: 60,
      grace_minutes: 15,
    });

    expect(result.error).toBeNull();
    expect(fake.names()).toEqual(['update:settings']);
    expect(fake.payloadOf('update:settings')).toEqual({
      timezone: 'Europe/Berlin',
      week_starts_on: 6,
      refire_seconds: 60,
      grace_minutes: 15,
    });
  });

  it('drops pass_cap and user_id even if a caller smuggles them in, and never upserts', async () => {
    const sneaky = { timezone: 'Europe/Berlin', pass_cap: 99, user_id: 'someone-else' } as SettingsPatch;

    await updateSettings('u1', sneaky);

    expect(fake.payloadOf('update:settings')).toEqual({ timezone: 'Europe/Berlin' });
    expect(fake.names()).not.toContain('upsert:settings');
  });

  it('reports a missing row instead of pretending it saved', async () => {
    fake.responses['update:settings'] = { data: null, error: null };
    const result = await updateSettings('u1', { timezone: 'Europe/Berlin' });
    expect(result.error).toMatch(/could not be found/i);
  });
});
