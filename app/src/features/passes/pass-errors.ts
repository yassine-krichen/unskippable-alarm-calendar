// RPC failures raise P0001 with the code as the message (docs/decisions.md), so
// supabase-js hands the code back as error.message.
const PASS_ERROR_MESSAGES: Record<string, string> = {
  no_passes_left: 'You have no passes left. A new one arrives at the start of next week.',
  day_in_past: 'That day has already passed. Pick today or a later day.',
  already_cheat_day: 'That day is already a cheat day.',
  not_a_cheat_day: 'That day is not a cheat day, so there is nothing to undo.',
  day_not_in_future: "A cheat day can't be undone once the day has begun.",
  invalid_day: "That isn't a valid day. Pick one from the calendar.",
  not_authenticated: 'Your session expired. Sign in again.',
};

const NETWORK_MESSAGE = "Can't reach the server. Check your connection and try again.";
const FALLBACK_MESSAGE = 'Something went wrong. Try again in a moment.';

/** Friendly toast text for an RPC error code, a network failure, or anything unexpected. */
export function passErrorMessage(rawError: string): string {
  const known = PASS_ERROR_MESSAGES[rawError.trim()];
  if (known !== undefined) return known;
  if (/failed to fetch|network|load failed/i.test(rawError)) return NETWORK_MESSAGE;
  return FALLBACK_MESSAGE;
}
