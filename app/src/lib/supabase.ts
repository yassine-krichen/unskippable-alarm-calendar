import { createClient } from '@supabase/supabase-js';

import { parseEnv } from '@/lib/env';

const env = parseEnv(import.meta.env);

// Publishable key only: RLS does the enforcement, no secret key belongs in this bundle.
export const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Sign-in is by emailed code, never a redirect link.
    detectSessionInUrl: false,
  },
});
