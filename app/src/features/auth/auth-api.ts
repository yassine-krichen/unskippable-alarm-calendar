import type { Session } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';
import { fail, ok, type Result } from '@/lib/result';

export async function requestSignInCode(email: string): Promise<Result<null>> {
  const { error } = await supabase.auth.signInWithOtp({ email });
  return error ? fail(error.message) : ok(null);
}

export async function verifySignInCode(email: string, code: string): Promise<Result<Session>> {
  const { data, error } = await supabase.auth.verifyOtp({ email, token: code, type: 'email' });
  if (error) return fail(error.message);
  if (!data.session) return fail('Sign-in did not return a session. Request a new code.');
  return ok(data.session);
}

export async function signOut(): Promise<Result<null>> {
  const { error } = await supabase.auth.signOut();
  return error ? fail(error.message) : ok(null);
}
