import type { AlarmAdapter, CompletionRow } from '@alarm-calendar/core';

export type UploadOutcome =
  | { kind: 'ok' }
  /** No network, expired token, throttled, server error: keep the row and try again later. */
  | { kind: 'transient'; reason: string }
  /** The server refused the row for good (RLS, a deleted event): retrying forever would only repeat that. */
  | { kind: 'rejected'; reason: string };

// Only these mean the server will never take this row: 42501 insufficient privilege (RLS), 23503 foreign key
// violation (the event is gone), 23505 unique violation; a 409 is the same family. Anything else, every other
// 4xx included (a 400, PGRST204 after schema drift, an expired token), may pass after an update or a new
// session, so the row stays in the engine: losing a completion is worse than retrying one.
// Same rule as the desktop flusher (electron/src/supabase-sink.ts).
const PERMANENT_CODES = new Set(['42501', '23503', '23505']);

export function classifyUploadFailure(status: number, message: string, code = ''): UploadOutcome {
  const reason = `${status} ${code} ${message}`.replace(/\s+/g, ' ');
  if (status === 409 || PERMANENT_CODES.has(code)) return { kind: 'rejected', reason };
  return { kind: 'transient', reason };
}

export interface CompletionSyncDeps {
  adapter: Pick<AlarmAdapter, 'peekCompletions' | 'ackCompletions'>;
  /** Writes one completion; first completion wins, so a row the server already has is a success. */
  upload(row: CompletionRow): Promise<UploadOutcome>;
  /** Who is signed in; the rows of another user stay in the engine for them. */
  userId(): string | null;
  /** At least one row reached the server. */
  onUploaded?(): void;
  /** A row was refused for good and forgotten; the app tells the person once per session. */
  onRejected?(): void;
  log?(event: string, fields?: Record<string, unknown>): void;
}

export interface FlushResult {
  uploaded: number;
  /** Kept in the engine for the next attempt. */
  deferred: number;
  /** Refused for good and forgotten. */
  rejected: number;
}

/**
 * Moves the completions made on this phone (the engine keeps them from the moment of Done, also
 * while the app is closed) to Supabase. The order is the contract: peek, upload, and only the rows
 * the server answered for are acknowledged, so a failed or interrupted upload loses nothing and the
 * next call hands out the same rows again.
 */
export async function flushCompletions(deps: CompletionSyncDeps): Promise<FlushResult> {
  const result: FlushResult = { uploaded: 0, deferred: 0, rejected: 0 };
  const userId = deps.userId();
  if (userId === null) return result;

  const rows = await deps.adapter.peekCompletions();
  const acked: string[] = [];
  let foreign = 0;
  for (const row of rows) {
    // RLS would refuse another user's row; it stays in the engine for that user.
    if (row.user_id !== userId) {
      foreign += 1;
      continue;
    }
    // Signed out or switched account while an earlier row was in flight: the rest waits for the next run.
    if (deps.userId() !== userId) break;
    const outcome = await deps.upload(row);
    if (outcome.kind === 'transient') {
      deps.log?.('completions.flush_deferred', { reason: outcome.reason });
      break;
    }
    if (outcome.kind === 'rejected') {
      deps.log?.('completions.rejected', { eventId: row.event_id, reason: outcome.reason });
      result.rejected += 1;
      deps.onRejected?.();
    } else {
      result.uploaded += 1;
    }
    acked.push(row.id);
  }
  if (foreign > 0) deps.log?.('completions.other_user_rows_kept', { count: foreign });
  // Also after a transient stop: what the server answered for before it must not be uploaded again.
  if (acked.length > 0) await deps.adapter.ackCompletions(acked);
  result.deferred = rows.length - result.uploaded - result.rejected;
  if (result.uploaded > 0) deps.onUploaded?.();
  return result;
}
