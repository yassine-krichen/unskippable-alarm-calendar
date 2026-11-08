import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

import { resolveCredentials, type Credentials } from '../config/credentials';
import type { ConfigPaths } from '../config/paths';
import { ensurePrivateDir } from '../config/private-files';
import { CliError } from '../errors';
import { SupabaseStore } from '../store/supabase-store';
import type { Store } from '../store/store';

import { createFileLock } from './file-lock';
import { FileSessionStorage } from './file-session-storage';

export interface AuthEnvironment {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  cwd: string;
  scriptDir: string;
  paths: ConfigPaths;
  /** Test seam: a fetch that stands in for the network. */
  fetchImpl?: typeof fetch;
}

export interface SessionInfo {
  userId: string;
  email: string | null;
  /** ISO instant the access token expires; the tool refreshes it by itself. */
  expiresAt: string | null;
}

const CODE_PATTERN = /^\d{6,10}$/;

export function assertEmail(email: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new CliError('invalid_input', `"${email}" is not an email address.`);
  }
}

export function assertCode(code: string): void {
  if (!CODE_PATTERN.test(code)) {
    throw new CliError('invalid_input', 'The code is the 6 to 10 digit number from the email.', 'Request a new one with `alarm-cal login --email <address>`.');
  }
}

function describeSession(session: Session): SessionInfo {
  return {
    userId: session.user.id,
    email: session.user.email ?? null,
    expiresAt: session.expires_at === undefined ? null : new Date(session.expires_at * 1000).toISOString(),
  };
}

/** Sign-in by emailed one-time code (the same flow as the app), session kept in the config directory. */
export class AuthService {
  private cachedClient: SupabaseClient | null = null;
  private readonly storage: FileSessionStorage;

  constructor(private readonly environment: AuthEnvironment) {
    this.storage = new FileSessionStorage(environment.paths, environment.env, environment.platform);
  }

  credentials(): Credentials {
    const { env, paths, scriptDir } = this.environment;
    return resolveCredentials({ env, paths, scriptDir });
  }

  private client(): SupabaseClient {
    if (this.cachedClient !== null) return this.cachedClient;
    const { url, key } = this.credentials();
    const { env, platform, paths, fetchImpl } = this.environment;
    this.cachedClient = createClient(url, key, {
      auth: {
        persistSession: true,
        // A command is short-lived: no background timer. getSession() still refreshes an expired token.
        autoRefreshToken: false,
        detectSessionInUrl: false,
        // One key per project, so pointing the tool at another project never reuses this session.
        storageKey: `alarm-cal-${new URL(url).hostname}`,
        storage: this.storage,
        lock: createFileLock(paths.lock, () => ensurePrivateDir(paths.dir, env, platform)),
      },
      ...(fetchImpl === undefined ? {} : { global: { fetch: fetchImpl } }),
    });
    return this.cachedClient;
  }

  async requestCode(email: string): Promise<void> {
    assertEmail(email);
    // Existing accounts only: the tool must never create a user by mistyping an address.
    const { error } = await this.client().auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    if (error) throw new CliError('invalid_input', `Could not send the code: ${error.message}`);
  }

  async verifyCode(email: string, code: string): Promise<SessionInfo> {
    assertEmail(email);
    assertCode(code);
    const { data, error } = await this.client().auth.verifyOtp({ email, token: code, type: 'email' });
    if (error) {
      throw new CliError('invalid_input', `The code was not accepted: ${error.message}`, 'Request a new code with `alarm-cal login --email <address>`.');
    }
    if (!data.session) throw new CliError('server', 'Sign-in did not return a session. Request a new code.');
    return describeSession(data.session);
  }

  /** The stored session, refreshed when it is about to expire; null when not signed in. */
  async session(): Promise<Session | null> {
    if (!this.storage.exists()) return null;
    const { data, error } = await this.client().auth.getSession();
    if (error) {
      throw new CliError('not_logged_in', 'The saved session could not be refreshed.', 'Sign in again with `alarm-cal login`.');
    }
    return data.session;
  }

  async sessionInfo(): Promise<SessionInfo | null> {
    const session = await this.session();
    return session === null ? null : describeSession(session);
  }

  async signOut(): Promise<boolean> {
    if (!this.storage.exists()) return false;
    try {
      // Revokes the refresh token on the server; the local file goes either way.
      await this.client().auth.signOut({ scope: 'local' });
    } catch {
      // Offline or already revoked: the local session is removed below regardless.
    }
    this.storage.removeItem(`alarm-cal-${new URL(this.credentials().url).hostname}`);
    return true;
  }

  /** The signed-in user's data, through the publishable key and RLS. */
  async openStore(): Promise<Store> {
    const session = await this.session();
    if (session === null) {
      throw new CliError('not_logged_in', 'Not signed in.', 'Run `alarm-cal login --email <address>`, then `alarm-cal login --email <address> --code <digits>`.');
    }
    return new SupabaseStore(this.client(), session.user.id);
  }
}
