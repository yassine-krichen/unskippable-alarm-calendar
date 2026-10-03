import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fake } from '@/test/fake-supabase';

vi.mock('@/lib/supabase', async () => {
  const { fakeClient } = await import('@/test/fake-supabase');
  return { supabase: fakeClient };
});

import { deactivateEvent } from './events-api';

beforeEach(() => fake.reset());

describe('deactivateEvent', () => {
  it('soft-deletes by setting active to false', async () => {
    fake.responses['update:events'] = { data: [{ id: 'e1' }], error: null };

    const result = await deactivateEvent('e1');

    expect(result.error).toBeNull();
    expect(fake.payloadOf('update:events')).toEqual({ active: false });
  });

  it('reports an error when no row was updated, instead of a silent success', async () => {
    fake.responses['update:events'] = { data: [], error: null };
    const result = await deactivateEvent('gone');
    expect(result.error).toMatch(/no longer exists/i);
  });

  it('passes a database error through', async () => {
    fake.responses['update:events'] = { data: null, error: { message: 'rls' } };
    expect((await deactivateEvent('e1')).error).toBe('rls');
  });
});
