import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CompletionRow, DesktopSession } from '@alarm-calendar/core';

import type { CompletionSink, UpsertOutcome } from './completion-flusher';

// Only these mean the server will never take this row: 42501 insufficient privilege (RLS), 23503 foreign key
// violation (the event is gone), 23505 unique violation. A 409 is the same family. Everything else, any 4xx
// included (a 400, PGRST204 after schema drift, an expired token), may pass after an update or a new session, so
// the row stays queued: losing a completion is worse than retrying one.
const PERMANENT_CODES = new Set(['42501', '23503', '23505']);

export function classifyUpsertFailure(status: number, message: string, code = ''): UpsertOutcome {
  const reason = `${status} ${code} ${message}`.replace(/\s+/g, ' ');
  if (status === 409 || PERMANENT_CODES.has(code)) return { kind: 'rejected', reason };
  return { kind: 'transient', reason };
}

/**
 * Writes completions with a supabase-js client built from the signed-in user's
 * access token. Publishable key only; the client never refreshes a token (that
 * is the renderer's job), so it cannot race the renderer's refresh-token
 * rotation. The token is read through a getter at request time and never logged.
 */
export class SupabaseCompletionSink implements CompletionSink {
  private client: SupabaseClient | null = null;
  private clientKey = '';
  private accessToken = '';

  /** On sign-out: drop the token and the client that reads it. */
  clear(): void {
    this.accessToken = '';
    this.clientKey = '';
    this.client = null;
  }

  async upsert(session: DesktopSession, row: CompletionRow): Promise<UpsertOutcome> {
    this.accessToken = session.accessToken;
    const key = `${session.url}|${session.publishableKey}`;
    if (this.client === null || this.clientKey !== key) {
      this.client = createClient(session.url, session.publishableKey, {
        accessToken: () => Promise.resolve(this.accessToken),
      });
      this.clientKey = key;
    }
    try {
      const { error, status } = await this.client
        .from('completions')
        // First completion wins (decisions.md): ON CONFLICT DO NOTHING. A duplicate is a success.
        .upsert(row, { onConflict: 'event_id,occurrence_at', ignoreDuplicates: true });
      if (error === null) return { kind: 'ok' };
      return classifyUpsertFailure(status, error.message, error.code);
    } catch (error) {
      return { kind: 'transient', reason: String(error) };
    }
  }
}
