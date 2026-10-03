/** Turns a Supabase auth error message into something a person can act on. */
export function authErrorMessage(rawError: string): string {
  const text = rawError.toLowerCase();
  if (text.includes('rate limit') || text.includes('too many') || text.includes('security purposes')) {
    // The built-in Supabase email sender is heavily rate limited (spec section 2a).
    return 'Too many codes were requested. Wait a minute, then try again.';
  }
  if (text.includes('expired') || (text.includes('invalid') && text.includes('token'))) {
    return "That code didn't work or has expired. Check it, or send a new one.";
  }
  if (text.includes('invalid') && text.includes('email')) {
    return "That email address doesn't look right.";
  }
  if (text.includes('failed to fetch') || text.includes('network') || text.includes('load failed')) {
    return "Can't reach the server. Check your connection and try again.";
  }
  return 'Something went wrong. Try again in a moment.';
}
