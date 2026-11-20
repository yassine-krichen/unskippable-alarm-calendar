import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fake } from '@/test/fake-supabase';

vi.mock('@/lib/supabase', async () => {
  const { fakeClient } = await import('@/test/fake-supabase');
  return { supabase: fakeClient };
});

import { insertQadaCompletion } from './completions-api';

const EVENT = '11111111-1111-4111-8111-111111111111';
const OCCURRENCE = '2026-10-06T11:07:00.000Z';
const NOW = new Date('2026-10-06T18:30:00.000Z');

beforeEach(() => {
  fake.reset();
});

describe('insertQadaCompletion', () => {
  it('writes a done completion with done_at = now, first write wins, and no user_id of its own', async () => {
    const row = { id: 'c1', user_id: 'u1', event_id: EVENT, occurrence_at: OCCURRENCE, status: 'done', snoozes_used: 0, done_at: NOW.toISOString() };
    fake.responses['upsert:completions'] = { data: [row], error: null };

    const result = await insertQadaCompletion(EVENT, OCCURRENCE, NOW);

    expect(result).toEqual({ data: row, error: null });
    expect(fake.payloadOf('upsert:completions')).toEqual({
      event_id: EVENT,
      occurrence_at: OCCURRENCE,
      status: 'done',
      snoozes_used: 0,
      done_at: NOW.toISOString(),
    });
    expect(fake.upsertOptions).toEqual([{ onConflict: 'event_id,occurrence_at', ignoreDuplicates: true }]);
  });

  it('answers null when a row was already there (nothing was written)', async () => {
    fake.responses['upsert:completions'] = { data: [], error: null };
    expect(await insertQadaCompletion(EVENT, OCCURRENCE, NOW)).toEqual({ data: null, error: null });
  });

  it('returns the error instead of throwing, so the screen can say it needs a connection', async () => {
    fake.responses['upsert:completions'] = { data: null, error: { message: 'Failed to fetch' } };
    expect(await insertQadaCompletion(EVENT, OCCURRENCE, NOW)).toEqual({ data: null, error: 'Failed to fetch' });
  });
});
