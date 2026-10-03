import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompletionRow, DesktopSession } from '@alarm-calendar/core';

const created = vi.hoisted(() => ({
  clients: [] as Array<{ accessToken: () => Promise<string | null> }>,
  upserts: [] as Array<{ table: string; row: unknown; options: unknown }>,
  result: { error: null, status: 201 } as { error: { message: string } | null; status: number },
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, _key: string, options: { accessToken: () => Promise<string | null> }) => {
    created.clients.push(options);
    return {
      from: (table: string) => ({
        upsert: (row: unknown, upsertOptions: unknown) => {
          created.upserts.push({ table, row, options: upsertOptions });
          return Promise.resolve(created.result);
        },
      }),
    };
  },
}));

import { SupabaseCompletionSink } from './supabase-sink';

const row = { id: 'c1', event_id: 'e1', occurrence_at: '2026-03-02T09:01:00.000Z' } as CompletionRow;

function session(accessToken: string): DesktopSession {
  return {
    url: 'https://example-ref.supabase.co',
    publishableKey: 'sb_publishable_test',
    userId: 'u1',
    accessToken,
    expiresAt: 1_900_000_000,
  };
}

beforeEach(() => {
  created.clients.length = 0;
  created.upserts.length = 0;
  created.result = { error: null, status: 201 };
});

describe('SupabaseCompletionSink', () => {
  it('writes to completions with first-completion-wins semantics', async () => {
    const outcome = await new SupabaseCompletionSink().upsert(session('aaa.bbb.ccc'), row);

    expect(outcome).toEqual({ kind: 'ok' });
    expect(created.upserts).toEqual([
      {
        table: 'completions',
        row,
        options: { onConflict: 'event_id,occurrence_at', ignoreDuplicates: true },
      },
    ]);
  });

  it('hands the client the latest access token, so a refreshed token is used without a new client', async () => {
    const sink = new SupabaseCompletionSink();
    await sink.upsert(session('first.token.aaa'), row);
    await sink.upsert(session('second.token.bbb'), row);

    expect(created.clients).toHaveLength(1);
    expect(await created.clients[0]?.accessToken()).toBe('second.token.bbb');
  });

  it('forgets the token and builds a new client after clear()', async () => {
    const sink = new SupabaseCompletionSink();
    await sink.upsert(session('first.token.aaa'), row);
    const first = created.clients[0];

    sink.clear();
    expect(await first?.accessToken()).toBe('');

    await sink.upsert(session('next.token.ccc'), row);
    expect(created.clients).toHaveLength(2);
    expect(await created.clients[1]?.accessToken()).toBe('next.token.ccc');
  });

  it('classifies a refused write instead of throwing', async () => {
    created.result = { error: { message: 'new row violates row-level security policy' }, status: 403 };
    const outcome = await new SupabaseCompletionSink().upsert(session('aaa.bbb.ccc'), row);
    expect(outcome.kind).toBe('rejected');
  });
});
