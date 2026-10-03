import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CompletionRow, DesktopSession } from '@alarm-calendar/core';

import type { CompletionSink, UpsertOutcome } from './completion-flusher';

// 401 is an expired token (the renderer refreshes and pushes a new one); the rest are retryable by nature.
const TRANSIENT_STATUSES = new Set([401, 408, 425, 429]);

export function classifyUpsertFailure(status: number, message: string): UpsertOutcome {
  if (status === 0 || status >= 500 || TRANSIENT_STATUSES.has(status)) {
    return { kind: 'transient', reason: `${status} ${message}` };
  }
  return { kind: 'rejected', reason: `${status} ${message}` };
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
      return classifyUpsertFailure(status, error.message);
    } catch (error) {
      return { kind: 'transient', reason: String(error) };
    }
  }
}
