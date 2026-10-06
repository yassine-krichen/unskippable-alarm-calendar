import {
  handleCheatDayChange,
  handleCompletionChange,
  handleEventChange,
  handleExamChange,
  handleSettingsChange,
  type ChangePayload,
} from './realtime-handlers';

/** The slice of a Supabase channel this module uses, so a fake can stand in for it in tests. */
export interface ChannelLike {
  on(
    type: 'postgres_changes',
    filter: { event: '*'; schema: 'public'; table: string },
    callback: (payload: ChangePayload) => void
  ): ChannelLike;
  subscribe(callback: (status: string) => void): unknown;
}

export interface RealtimeClientLike {
  channel(name: string): ChannelLike;
  removeChannel(channel: ChannelLike): unknown;
}

/**
 * Subscribes to changes of the user's events, exams, cheat days, settings and completions (RLS limits
 * what arrives to their own rows). Whenever the channel (re)subscribes, `onSubscribed` runs so
 * the caller can refetch whatever changed while the socket was down or before it was up.
 * Returns the unsubscribe function.
 */
export function startRealtime(
  client: RealtimeClientLike,
  userId: string,
  onSubscribed: () => void
): () => void {
  const table = (name: string) => ({ event: '*' as const, schema: 'public' as const, table: name });
  const channel = client
    .channel(`app-data-${userId}`)
    .on('postgres_changes', table('events'), handleEventChange)
    .on('postgres_changes', table('exams'), handleExamChange)
    .on('postgres_changes', table('cheat_days'), handleCheatDayChange)
    .on('postgres_changes', table('settings'), handleSettingsChange)
    .on('postgres_changes', table('completions'), handleCompletionChange);
  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') onSubscribed();
  });
  return () => {
    void client.removeChannel(channel);
  };
}
