import type { Session } from '@supabase/supabase-js';
import { create } from 'zustand';

import { supabase } from '@/lib/supabase';

type AuthStatus = 'loading' | 'signed-out' | 'signed-in';

interface AuthState {
  status: AuthStatus;
  session: Session | null;
}

// The session is genuinely shared: every feature needs to know who is signed in.
export const useAuthStore = create<AuthState>(() => ({ status: 'loading', session: null }));

function applySession(session: Session | null): void {
  useAuthStore.setState({ status: session ? 'signed-in' : 'signed-out', session });
}

/** Restores the persisted session, then follows sign-in, sign-out and token refresh. */
export function startAuthListener(): () => void {
  void supabase.auth.getSession().then(({ data }) => applySession(data.session));

  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    // Token refreshes arrive here too; only update when the user actually changed
    // so a refresh does not re-run the sign-in bootstrap.
    const current = useAuthStore.getState().session;
    if (current?.user.id === session?.user.id && current !== null && session !== null) {
      useAuthStore.setState({ session });
      return;
    }
    applySession(session);
  });
  return () => data.subscription.unsubscribe();
}
