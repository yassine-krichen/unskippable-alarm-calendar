import { describe, expect, it } from 'vitest';

import type { CompletionRow, DesktopSession } from '@alarm-calendar/core';

import { emptyCache } from './cache';
import type { CacheData } from './cache';
import { CompletionFlusher } from './completion-flusher';
import type { CompletionSink, UpsertOutcome } from './completion-flusher';
import { classifyUpsertFailure } from './supabase-sink';

const USER = '99999999-9999-4999-8999-999999999999';
const OTHER_USER = '88888888-8888-4888-8888-888888888888';
const EVENT = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-03-02T09:00:00.000Z');

function row(n: number, overrides: Partial<CompletionRow> = {}): CompletionRow {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    user_id: USER,
    event_id: EVENT,
    occurrence_at: new Date(NOW - n * 60_000).toISOString(),
    status: 'done',
    snoozes_used: 0,
    done_at: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function session(overrides: Partial<DesktopSession> = {}): DesktopSession {
  return {
    url: 'https://example-ref.supabase.co',
    publishableKey: 'sb_publishable_test',
    userId: USER,
    accessToken: 'aaa.bbb.ccc',
    expiresAt: NOW / 1000 + 3600,
    ...overrides,
  };
}

/** A fake server keyed like the real table: one row per (event_id, occurrence_at). */
class FakeServer implements CompletionSink {
  readonly table = new Map<string, CompletionRow>();
  calls = 0;
  clears = 0;
  outcomes: UpsertOutcome[] = [];
  /** Runs inside upsert, to simulate things happening while a request is in flight. */
  duringUpsert: (() => void) | null = null;

  clear(): void {
    this.clears++;
  }

  async upsert(_session: DesktopSession, completion: CompletionRow): Promise<UpsertOutcome> {
    this.calls++;
    this.duringUpsert?.();
    await Promise.resolve();
    const scripted = this.outcomes.shift();
    if (scripted !== undefined) return scripted;
    this.table.set(`${completion.event_id}@${completion.occurrence_at}`, completion);
    return { kind: 'ok' };
  }
}

function setup(cache: CacheData = emptyCache(), now = NOW) {
  const server = new FakeServer();
  const known: CompletionRow[] = [];
  const logs: string[] = [];
  let persisted = 0;
  const flusher = new CompletionFlusher({
    cache,
    persist: () => {
      persisted++;
    },
    sink: server,
    now: () => new Date(now),
    onFlushed: (completion) => known.push(completion),
    log: (event) => {
      logs.push(event);
    },
  });
  return {
    cache,
    server,
    known,
    logs,
    flusher,
    get persisted() {
      return persisted;
    },
  };
}

describe('CompletionFlusher', () => {
  it('lists the Done occurrences the server has not accepted yet, as ids only, and drops them once flushed', async () => {
    const cache = emptyCache();
    cache.pendingCompletions.push(row(1), row(2, { status: 'skipped_cheat' }));
    const h = setup(cache);
    expect(h.flusher.pendingDoneOccurrenceIds()).toEqual([`${EVENT}@${cache.pendingCompletions[0]?.occurrence_at}`]);

    h.flusher.setSession(session());
    await h.flusher.flush();
    expect(h.flusher.pendingDoneOccurrenceIds()).toEqual([]);
  });

  it('sends nothing without a session and keeps everything queued', async () => {
    const cache = emptyCache();
    cache.pendingCompletions.push(row(1));
    const h = setup(cache);
    await h.flusher.flush();
    expect(h.server.calls).toBe(0);
    expect(h.cache.pendingCompletions).toHaveLength(1);
  });

  it('flushes on sign-in, removes each row only after the server took it, and records it as known', async () => {
    const cache = emptyCache();
    cache.pendingCompletions.push(row(1), row(2));
    const h = setup(cache);
    h.flusher.setSession(session());
    await h.flusher.flush();

    expect(h.server.table.size).toBe(2);
    expect(h.cache.pendingCompletions).toEqual([]);
    expect(h.known).toHaveLength(2);
    expect(h.persisted).toBeGreaterThan(0);
  });

  it('is idempotent: flushing the same rows again changes nothing on the server', async () => {
    const cache = emptyCache();
    cache.pendingCompletions.push(row(1));
    const h = setup(cache);
    h.flusher.setSession(session());
    await h.flusher.flush();

    // The same completion queued again (a retry after a crash between send and removal).
    h.cache.pendingCompletions.push(row(1));
    await h.flusher.flush();

    expect(h.server.table.size).toBe(1);
    expect(h.cache.pendingCompletions).toEqual([]);
  });

  it('keeps every row queued while offline and delivers them in order once back online', async () => {
    const cache = emptyCache();
    cache.pendingCompletions.push(row(1), row(2), row(3));
    const h = setup(cache);
    h.server.outcomes = [{ kind: 'transient', reason: '0 TypeError: fetch failed' }];
    h.flusher.setSession(session());
    await h.flusher.flush();

    // Offline: the attempt stopped at the first row, the rest were not even tried.
    expect(h.server.calls).toBe(1);
    expect(h.cache.pendingCompletions).toHaveLength(3);
    expect(h.known).toHaveLength(0);

    await h.flusher.flush();
    expect(h.cache.pendingCompletions).toEqual([]);
    expect(h.server.table.size).toBe(3);
  });

  it('drops a row the server rejects for good so it cannot block the rows behind it', async () => {
    const cache = emptyCache();
    cache.pendingCompletions.push(row(1), row(2));
    const h = setup(cache);
    h.server.outcomes = [{ kind: 'rejected', reason: '409 event deleted' }];
    h.flusher.setSession(session());
    await h.flusher.flush();

    expect(h.cache.pendingCompletions).toEqual([]);
    expect(h.server.table.size).toBe(1);
    expect(h.known).toHaveLength(1);
    expect(h.logs).toContain('completions.rejected');
  });

  it('never calls the server with an expired access token', async () => {
    const cache = emptyCache();
    cache.pendingCompletions.push(row(1));
    const h = setup(cache);
    h.flusher.setSession(session({ expiresAt: NOW / 1000 - 1 }));
    await h.flusher.flush();
    expect(h.server.calls).toBe(0);
    expect(h.cache.pendingCompletions).toHaveLength(1);

    // The renderer refreshes the session and pushes a new token: the queue drains.
    h.flusher.setSession(session());
    await h.flusher.flush();
    expect(h.cache.pendingCompletions).toEqual([]);
  });

  it('leaves another account\'s completions queued instead of sending or dropping them', async () => {
    const cache = emptyCache();
    cache.pendingCompletions.push(row(1, { user_id: OTHER_USER }), row(2));
    const h = setup(cache);
    h.flusher.setSession(session());
    await h.flusher.flush();

    expect(h.server.table.size).toBe(1);
    expect(h.cache.pendingCompletions.map((c) => c.user_id)).toEqual([OTHER_USER]);
  });

  it('clears the sink (token and client) on sign-out, and not on sign-in', () => {
    const h = setup();
    h.flusher.setSession(session());
    expect(h.server.clears).toBe(0);
    h.flusher.setSession(null);
    expect(h.server.clears).toBe(1);
  });

  it('stops after sign-out even if a flush is already running', async () => {
    const cache = emptyCache();
    cache.pendingCompletions.push(row(1), row(2));
    const h = setup(cache);
    h.server.duringUpsert = () => {
      h.server.duringUpsert = null;
      h.flusher.setSession(null);
    };
    h.flusher.setSession(session());
    await h.flusher.flush();

    expect(h.server.calls).toBe(1);
    expect(h.cache.pendingCompletions).toHaveLength(1);
  });

  it('runs one flush at a time and picks up a completion that arrives mid-flush', async () => {
    const cache = emptyCache();
    cache.pendingCompletions.push(row(1));
    const h = setup(cache);
    let added = false;
    h.server.duringUpsert = () => {
      if (added) return;
      added = true;
      h.cache.pendingCompletions.push(row(2));
      void h.flusher.flush();
    };
    h.flusher.setSession(session());
    await h.flusher.flush();

    expect(h.server.calls).toBe(2);
    expect(h.server.table.size).toBe(2);
    expect(h.cache.pendingCompletions).toEqual([]);
  });

  it('does not remove a newer completion for the same occurrence that replaced the one in flight', async () => {
    const cache = emptyCache();
    const first = row(1);
    cache.pendingCompletions.push(first);
    const h = setup(cache);
    const replacement = { ...row(5), occurrence_at: first.occurrence_at };
    h.server.duringUpsert = () => {
      h.server.duringUpsert = null;
      h.cache.pendingCompletions = [replacement];
    };
    h.flusher.setSession(session());
    await h.flusher.flush();
    await h.flusher.flush();

    // The second pass sends the replacement; both end up as one server row.
    expect(h.cache.pendingCompletions).toEqual([]);
    expect(h.server.table.size).toBe(1);
  });
});

describe('classifyUpsertFailure', () => {
  it('treats network failure, expired token, throttling and server errors as retryable', () => {
    for (const status of [0, 401, 408, 429, 500, 503]) {
      expect(classifyUpsertFailure(status, 'x').kind).toBe('transient');
    }
  });

  it('treats policy and constraint failures as permanent', () => {
    for (const status of [400, 403, 404, 409]) {
      expect(classifyUpsertFailure(status, 'x').kind).toBe('rejected');
    }
  });
});
