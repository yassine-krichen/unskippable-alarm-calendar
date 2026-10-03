import type { CompletionRow, DesktopSession } from '@alarm-calendar/core';

import type { CacheData } from './cache';

/**
 * Flush owner for completions on desktop: the main process, and only it. A
 * completion is written by the scheduler to cache.pendingCompletions the moment
 * Done is pressed; this class upserts those rows to Supabase, first completion
 * wins (keyed by event_id + occurrence_at, so a retry or a second device never
 * duplicates or overwrites) and
 * removes each one only after the server accepted it. The React app does not
 * upsert them (its adapter's drainCompletions returns nothing on desktop), so
 * there is exactly one writer.
 *
 * The session lives in memory only. After a restart the renderer (which holds
 * the persisted Supabase session) pushes a fresh one, and any completions
 * made offline are flushed then.
 */

export type UpsertOutcome =
  | { kind: 'ok' }
  /** Network down, token expired, throttled, server error: keep the row and retry. */
  | { kind: 'transient'; reason: string }
  /** The server refused the row for good (RLS, deleted event): keep retrying would block the queue. */
  | { kind: 'rejected'; reason: string };

export interface CompletionSink {
  /** First completion wins: a row for an occurrence the server already has counts as success. */
  upsert(session: DesktopSession, row: CompletionRow): Promise<UpsertOutcome>;
  /** Forget the token and any client built from it (sign-out). */
  clear(): void;
}

export interface CompletionFlusherDeps {
  cache: CacheData;
  persist(cache: CacheData): void;
  sink: CompletionSink;
  now(): Date;
  /** The server now has this completion; the scheduler records it as known. */
  onFlushed(row: CompletionRow): void;
  log(event: string, fields?: Record<string, unknown>): void;
}

// Do not send a token that is about to lapse mid-request.
const TOKEN_SKEW_MS = 10_000;

export class CompletionFlusher {
  private session: DesktopSession | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;

  constructor(private readonly deps: CompletionFlusherDeps) {}

  /** Sign-in, token refresh and sign-out (null). Triggers a flush when there is something to send. */
  setSession(session: DesktopSession | null): void {
    this.session = session;
    if (session === null) this.deps.sink.clear();
    this.deps.log('completions.session', { signedIn: session !== null });
    if (session !== null) void this.flush();
  }

  hasPending(): boolean {
    return this.deps.cache.pendingCompletions.length > 0;
  }

  /** Single-flight: a call during a flush schedules one more pass instead of a parallel one. */
  flush(): Promise<void> {
    if (this.running !== null) {
      this.rerun = true;
      return this.running;
    }
    // Started on a microtask so `running` is set before any of the work (and any re-entrant
    // flush() it triggers) can run.
    this.running = Promise.resolve()
      .then(() => this.runUntilIdle())
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async runUntilIdle(): Promise<void> {
    do {
      this.rerun = false;
      try {
        await this.flushOnce();
      } catch (error) {
        // Never let a flush bug take the alarm engine down; the rows stay queued.
        this.deps.log('completions.flush_failed', { error: String(error) });
      }
    } while (this.rerun);
  }

  private async flushOnce(): Promise<void> {
    const { cache } = this.deps;
    const startSession = this.session;
    if (startSession === null || cache.pendingCompletions.length === 0) return;

    for (const row of [...cache.pendingCompletions]) {
      const session = this.session;
      // Signed out or switched user mid-flush: stop; rows of another user stay queued for them.
      if (session === null || session.userId !== startSession.userId) return;
      if (session.expiresAt * 1000 - TOKEN_SKEW_MS <= this.deps.now().getTime()) {
        this.deps.log('completions.token_expired');
        return;
      }
      // RLS would refuse another user's row; leave it for that user instead of dropping it.
      if (row.user_id !== session.userId) continue;

      const outcome = await this.deps.sink.upsert(session, row);
      if (outcome.kind === 'transient') {
        this.deps.log('completions.flush_deferred', { reason: outcome.reason });
        return;
      }
      if (outcome.kind === 'rejected') {
        this.deps.log('completions.rejected', { eventId: row.event_id, reason: outcome.reason });
      } else {
        this.deps.onFlushed(row);
        this.deps.log('completions.flushed', { eventId: row.event_id });
      }
      // By id: a newer completion for the same occurrence has a new id and stays queued.
      cache.pendingCompletions = cache.pendingCompletions.filter((pending) => pending.id !== row.id);
      this.deps.persist(cache);
    }
  }
}
