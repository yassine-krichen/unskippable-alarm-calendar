import type { CompletionRow } from '@alarm-calendar/core';
import { describe, expect, it, vi } from 'vitest';

import {
  classifyUploadFailure,
  flushCompletions,
  type CompletionSyncDeps,
  type UploadOutcome,
} from './completion-flush';

const row = (id: string, userId = 'u1'): CompletionRow => ({
  id,
  user_id: userId,
  event_id: `e-${id}`,
  occurrence_at: '2026-03-02T10:00:00.000Z',
  status: 'done',
  snoozes_used: 0,
  done_at: '2026-03-02T10:00:05.000Z',
});

/** An engine that keeps rows until they are acknowledged, like the Kotlin one, and logs the order of calls. */
function fakeEngine(initial: CompletionRow[]) {
  const held = [...initial];
  const calls: string[] = [];
  const adapter: CompletionSyncDeps['adapter'] = {
    peekCompletions: () => {
      calls.push('peek');
      return Promise.resolve([...held]);
    },
    ackCompletions: (ids: string[]) => {
      calls.push(`ack:${ids.join(',')}`);
      for (const id of ids) {
        const index = held.findIndex((candidate) => candidate.id === id);
        if (index >= 0) held.splice(index, 1);
      }
      return Promise.resolve();
    },
  };
  return { held, calls, adapter };
}

function deps(
  engine: ReturnType<typeof fakeEngine>,
  upload: (row: CompletionRow) => Promise<UploadOutcome>,
  userId: string | null = 'u1'
): CompletionSyncDeps {
  return {
    adapter: engine.adapter,
    upload: (completion) => {
      engine.calls.push(`upload:${completion.id}`);
      return upload(completion);
    },
    userId: () => userId,
  };
}

const OK: UploadOutcome = { kind: 'ok' };
const OFFLINE: UploadOutcome = { kind: 'transient', reason: '0 TypeError: Failed to fetch' };

describe('flushCompletions', () => {
  it('peeks, uploads each row, and only then acknowledges them', async () => {
    const engine = fakeEngine([row('c1'), row('c2')]);
    const result = await flushCompletions(deps(engine, () => Promise.resolve(OK)));

    expect(engine.calls).toEqual(['peek', 'upload:c1', 'upload:c2', 'ack:c1,c2']);
    expect(result).toEqual({ uploaded: 2, deferred: 0, rejected: 0 });
    expect(engine.held).toEqual([]);
  });

  it('does not acknowledge a row whose upload failed, and the next flush offers it again', async () => {
    const engine = fakeEngine([row('c1')]);
    const first = await flushCompletions(deps(engine, () => Promise.resolve(OFFLINE)));

    expect(first).toEqual({ uploaded: 0, deferred: 1, rejected: 0 });
    expect(engine.calls).toEqual(['peek', 'upload:c1']);
    expect(engine.held).toHaveLength(1);

    const retry = await flushCompletions(deps(engine, () => Promise.resolve(OK)));
    expect(retry).toEqual({ uploaded: 1, deferred: 0, rejected: 0 });
    expect(engine.calls.slice(2)).toEqual(['peek', 'upload:c1', 'ack:c1']);
    expect(engine.held).toEqual([]);
  });

  it('stops at the first transient failure but acknowledges what was accepted before it', async () => {
    const engine = fakeEngine([row('c1'), row('c2'), row('c3')]);
    const upload = vi
      .fn<(completion: CompletionRow) => Promise<UploadOutcome>>()
      .mockResolvedValueOnce(OK)
      .mockResolvedValueOnce(OFFLINE);
    const result = await flushCompletions(deps(engine, upload));

    expect(upload).toHaveBeenCalledTimes(2);
    expect(engine.calls.at(-1)).toBe('ack:c1');
    expect(result).toEqual({ uploaded: 1, deferred: 2, rejected: 0 });
    expect(engine.held.map((held) => held.id)).toEqual(['c2', 'c3']);
  });

  it('forgets a row the server refused for good, so it cannot block the ones behind it', async () => {
    const engine = fakeEngine([row('bad'), row('good')]);
    const log = vi.fn();
    const result = await flushCompletions({
      ...deps(engine, (completion) =>
        Promise.resolve(completion.id === 'bad' ? { kind: 'rejected', reason: '403 RLS' } : OK)
      ),
      log,
    });

    expect(result).toEqual({ uploaded: 1, deferred: 0, rejected: 1 });
    expect(engine.held).toEqual([]);
    expect(log).toHaveBeenCalledWith('completions.rejected', { eventId: 'e-bad', reason: '403 RLS' });
  });

  it('leaves the rows of another user in the engine for them', async () => {
    const engine = fakeEngine([row('mine'), row('theirs', 'u2')]);
    const upload = vi.fn<(completion: CompletionRow) => Promise<UploadOutcome>>().mockResolvedValue(OK);
    const result = await flushCompletions(deps(engine, upload));

    expect(upload).toHaveBeenCalledTimes(1);
    expect(engine.held.map((held) => held.id)).toEqual(['theirs']);
    expect(result).toEqual({ uploaded: 1, deferred: 1, rejected: 0 });
  });

  it('does nothing, not even a peek, while nobody is signed in', async () => {
    const engine = fakeEngine([row('c1')]);
    await flushCompletions(deps(engine, () => Promise.resolve(OK), null));
    expect(engine.calls).toEqual([]);
  });

  it('keeps the row when the acknowledgement itself fails, so the upload is repeated and stays idempotent', async () => {
    const engine = fakeEngine([row('c1')]);
    engine.adapter.ackCompletions = () => Promise.reject(new Error('bridge gone'));
    await expect(flushCompletions(deps(engine, () => Promise.resolve(OK)))).rejects.toThrow('bridge gone');
    expect(engine.held).toHaveLength(1);
  });

  it('tells the app when something reached the server, and not otherwise', async () => {
    const onUploaded = vi.fn();
    await flushCompletions({ ...deps(fakeEngine([row('c1')]), () => Promise.resolve(OK)), onUploaded });
    expect(onUploaded).toHaveBeenCalledTimes(1);

    onUploaded.mockClear();
    await flushCompletions({ ...deps(fakeEngine([row('c1')]), () => Promise.resolve(OFFLINE)), onUploaded });
    expect(onUploaded).not.toHaveBeenCalled();
  });
});

describe('classifyUploadFailure', () => {
  it.each([
    [0, ''],
    [401, ''],
    [408, ''],
    [429, ''],
    [500, ''],
    [503, ''],
    [400, ''],
    [400, 'PGRST204'],
    [403, ''],
    [404, ''],
  ])('keeps the row for status %i code "%s"', (status, code) => {
    expect(classifyUploadFailure(status, 'x', code).kind).toBe('transient');
  });

  it.each([
    [403, '42501'],
    [409, '23503'],
    [409, '23505'],
    [409, ''],
  ])('gives up on status %i code "%s"', (status, code) => {
    expect(classifyUploadFailure(status, 'x', code).kind).toBe('rejected');
  });
});

describe('flushCompletions with a changing account', () => {
  it('stops before the next upload when the signed-in user changed mid-flush, and acknowledges only what was sent', async () => {
    const engine = fakeEngine([row('c1'), row('c2'), row('c3')]);
    let user: string | null = 'u1';
    const upload = vi.fn((completion: CompletionRow): Promise<UploadOutcome> => {
      // Signing out (or switching) happens while the first upload is in flight.
      if (completion.id === 'c1') user = 'u2';
      return Promise.resolve(OK);
    });
    const result = await flushCompletions({ ...deps(engine, upload), userId: () => user });

    expect(upload).toHaveBeenCalledTimes(1);
    expect(engine.held.map((held) => held.id)).toEqual(['c2', 'c3']);
    expect(result).toEqual({ uploaded: 1, deferred: 2, rejected: 0 });
  });

  it('stops when the user signs out mid-flush', async () => {
    const engine = fakeEngine([row('c1'), row('c2')]);
    let user: string | null = 'u1';
    const upload = vi.fn((): Promise<UploadOutcome> => {
      user = null;
      return Promise.resolve(OK);
    });
    await flushCompletions({ ...deps(engine, upload), userId: () => user });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('logs the rows of another user it left alone, and tells the app about a refused row', async () => {
    const engine = fakeEngine([row('mine'), row('theirs', 'u2')]);
    const log = vi.fn();
    const onRejected = vi.fn();
    await flushCompletions({
      ...deps(engine, () => Promise.resolve({ kind: 'rejected', reason: '403 42501 x' })),
      log,
      onRejected,
    });
    expect(log).toHaveBeenCalledWith('completions.other_user_rows_kept', { count: 1 });
    expect(onRejected).toHaveBeenCalledTimes(1);
  });
});
