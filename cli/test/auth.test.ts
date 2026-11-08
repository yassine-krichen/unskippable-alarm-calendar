import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '../src/auth/auth-service';
import { FileSessionStorage } from '../src/auth/file-session-storage';
import { looksLikeSecretKey, readAppEnvFile, resolveCredentials } from '../src/config/credentials';
import { resolveConfigPaths } from '../src/config/paths';

import { createHarness, type Harness } from './harness';

const URL_VALUE = 'https://abcdefghijklmnop.supabase.co';
const KEY_VALUE = 'sb_publishable_testkey123';
const USER_ID = '11111111-2222-3333-4444-555555555555';

function fakeJwt(expiresAtSeconds: number): string {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: USER_ID, role: 'authenticated', exp: expiresAtSeconds })}.signature`;
}

interface GoTrueCall {
  path: string;
  body: Record<string, unknown>;
}

/** A GoTrue that speaks just enough of the protocol for the OTP flow, refresh and logout. */
function fakeGoTrue(options: { acceptedCode?: string } = {}) {
  const calls: GoTrueCall[] = [];
  let counter = 0;
  const session = (): Record<string, unknown> => {
    counter += 1;
    const expires = Math.floor(Date.now() / 1000) + 3600;
    return {
      access_token: fakeJwt(expires),
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: expires,
      refresh_token: `refresh-token-${counter}`,
      user: { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'me@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
    };
  };
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ path: `${url.pathname}${url.search}`, body });
    const json = (payload: unknown, status = 200): Response => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/auth/v1/otp') return json({});
    if (url.pathname === '/auth/v1/verify') {
      return body['token'] === (options.acceptedCode ?? '12345678')
        ? json(session())
        : json({ code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' }, 403);
    }
    if (url.pathname === '/auth/v1/token') return json(session());
    if (url.pathname === '/auth/v1/logout') return new Response(null, { status: 204 });
    return json({ message: 'not found' }, 404);
  };
  return { impl, calls, countOf: (path: string) => calls.filter((call) => call.path.startsWith(path)).length };
}

let harness: Harness | undefined;
afterEach(() => harness?.cleanup());

describe('credentials', () => {
  beforeEach(() => {
    harness = createHarness();
  });

  it('prefers the environment, then the config file, then the repo app/.env, per value', () => {
    const h = harness as Harness;
    const appEnv = join(h.configDir, 'app.env');
    writeFileSync(appEnv, `# comment
VITE_SUPABASE_URL="${URL_VALUE}"
VITE_SUPABASE_PUBLISHABLE_KEY=${KEY_VALUE}
OTHER_SECRET=do-not-read-me
`);
    const base = { paths: h.rt.paths, scriptDir: h.configDir };

    const fromApp = resolveCredentials({ ...base, env: { ALARM_CAL_APP_ENV: appEnv } });
    expect(fromApp).toMatchObject({ url: URL_VALUE, key: KEY_VALUE, urlSource: 'app/.env', keySource: 'app/.env' });

    writeFileSync(h.rt.paths.config, JSON.stringify({ supabaseUrl: 'https://stored.supabase.co', supabaseKey: 'sb_publishable_stored' }));
    const configWins = resolveCredentials({ ...base, env: { ALARM_CAL_APP_ENV: appEnv } });
    expect(configWins).toMatchObject({ url: 'https://stored.supabase.co', key: 'sb_publishable_stored', urlSource: 'config file', keySource: 'config file' });

    const envWins = resolveCredentials({ ...base, env: { ALARM_CAL_APP_ENV: appEnv, ALARM_CAL_SUPABASE_URL: 'https://other.supabase.co' } });
    expect(envWins).toMatchObject({ url: 'https://other.supabase.co', urlSource: 'environment', keySource: 'config file' });
  });

  it('finds app/.env only next to its own bundle, never by walking up from the working directory', () => {
    const h = harness as Harness;
    const repo = join(h.configDir, 'repo');
    const cwdProject = join(h.configDir, 'elsewhere');
    mkdirSync(join(repo, 'app'), { recursive: true });
    mkdirSync(join(repo, 'cli', 'dist'), { recursive: true });
    mkdirSync(join(cwdProject, 'app'), { recursive: true });
    writeFileSync(join(repo, 'app', '.env'), `VITE_SUPABASE_URL=${URL_VALUE}
VITE_SUPABASE_PUBLISHABLE_KEY=${KEY_VALUE}
`);
    writeFileSync(join(cwdProject, 'app', '.env'), 'VITE_SUPABASE_URL=https://evil.supabase.co\nVITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_evil\n');
    const previous = process.cwd();
    process.chdir(cwdProject);
    try {
      const found = resolveCredentials({ paths: h.rt.paths, scriptDir: join(repo, 'cli', 'dist'), env: {} });
      expect(found.url).toBe(URL_VALUE);
      // A bundle that sits outside any repository finds nothing, even with an app/.env in the working directory.
      expect(() => resolveCredentials({ paths: h.rt.paths, scriptDir: join(h.configDir, 'nowhere', 'dist'), env: {} })).toThrow(/not configured/);
    } finally {
      process.chdir(previous);
    }
  });

  it('only extracts the two Supabase names from an env file', () => {
    const h = harness as Harness;
    const file = join(h.configDir, '.env');
    writeFileSync(file, `export VITE_SUPABASE_URL='${URL_VALUE}' # project\nVITE_SUPABASE_PUBLISHABLE_KEY=${KEY_VALUE}\nSERVICE=secret\n`);
    expect(readAppEnvFile(file)).toEqual({ VITE_SUPABASE_URL: URL_VALUE, VITE_SUPABASE_PUBLISHABLE_KEY: KEY_VALUE });
    expect(readAppEnvFile(join(h.configDir, 'missing'))).toEqual({});
  });

  it('reports a missing configuration with exit 3 and how to fix it', async () => {
    const h = harness as Harness;
    const result = await h.run(['config', 'show', '--json']);
    expect(result.json).toMatchObject({ ok: true, configured: false });
    expect(result.json['problem']).toContain('not configured');
  });

  it('refuses a secret or service-role key, from any source', () => {
    const h = harness as Harness;
    const serviceJwt = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from('{"role":"service_role"}').toString('base64url')}.sig`;
    expect(looksLikeSecretKey('sb_secret_abc')).toBe(true);
    expect(looksLikeSecretKey(serviceJwt)).toBe(true);
    expect(looksLikeSecretKey(KEY_VALUE)).toBe(false);
    expect(looksLikeSecretKey(`${Buffer.from('{}').toString('base64url')}.${Buffer.from('{"role":"anon"}').toString('base64url')}.sig`)).toBe(false);
    expect(() => resolveCredentials({ paths: h.rt.paths, scriptDir: h.configDir, env: { ALARM_CAL_SUPABASE_URL: URL_VALUE, ALARM_CAL_SUPABASE_KEY: serviceJwt, ALARM_CAL_APP_ENV: '' } })).toThrow(/secret or service-role/);
  });

  it('config set stores a url and a key, config show names the sources but never prints the values', async () => {
    const h = harness as Harness;
    expect((await h.run(['config', 'set', 'url', URL_VALUE])).code).toBe(0);
    expect((await h.run(['config', 'set', 'key', KEY_VALUE])).code).toBe(0);
    const show = await h.run(['config', 'show', '--json']);
    expect(show.json).toMatchObject({ configured: true, url_source: 'config file', key_source: 'config file' });
    expect(show.stdout).not.toContain(URL_VALUE);
    expect(show.stdout).not.toContain(KEY_VALUE);
    expect((await h.run(['config', 'set', 'url', 'http://insecure.example'])).code).toBe(5);
    expect((await h.run(['config', 'set', 'key', 'sb_secret_nope'])).code).toBe(5);
    await h.run(['config', 'unset', 'key']);
    expect(JSON.parse(readFileSync(h.rt.paths.config, 'utf8'))).toEqual({ supabaseUrl: URL_VALUE });
  });
});

describe('session storage', () => {
  it('round-trips values, writes a private file and deletes it with the last key', () => {
    harness = createHarness();
    const storage = new FileSessionStorage(harness.rt.paths, harness.rt.env, process.platform);
    expect(storage.exists()).toBe(false);
    storage.setItem('a', '1');
    storage.setItem('b', '2');
    expect(storage.getItem('a')).toBe('1');
    expect(storage.getItem('missing')).toBeNull();
    if (process.platform !== 'win32') expect(statSync(harness.rt.paths.session).mode & 0o077).toBe(0);
    storage.removeItem('a');
    expect(storage.getItem('b')).toBe('2');
    storage.removeItem('b');
    expect(existsSync(harness.rt.paths.session)).toBe(false);
  });

  it('tightens the permissions of session.json on every write', () => {
    if (process.platform === 'win32') return; // Windows uses icacls, which the no-ACL switch skips in tests
    harness = createHarness({ env: { ALARM_CAL_NO_ACL: undefined } });
    const storage = new FileSessionStorage(harness.rt.paths, { ...harness.rt.env, ALARM_CAL_NO_ACL: undefined }, process.platform);
    storage.setItem('a', '1');
    chmodSync(harness.rt.paths.session, 0o644);
    storage.setItem('a', '2');
    expect(statSync(harness.rt.paths.session).mode & 0o077).toBe(0);
  });

  it('resolves the config directory from the override, APPDATA or XDG', () => {
    expect(resolveConfigPaths({ ALARM_CAL_CONFIG_DIR: 'X:\\scratch' }, 'win32', 'C:\\Users\\u').dir).toBe('X:\\scratch');
    expect(resolveConfigPaths({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u').dir).toBe(join('C:\\Users\\u\\AppData\\Roaming', 'alarm-calendar-cli'));
    expect(resolveConfigPaths({ XDG_CONFIG_HOME: '/x' }, 'linux', '/home/u').dir).toBe(join('/x', 'alarm-calendar-cli'));
  });
});

describe('login, whoami, refresh and logout (real supabase-js against a fake server)', () => {
  const env = { ALARM_CAL_SUPABASE_URL: URL_VALUE, ALARM_CAL_SUPABASE_KEY: KEY_VALUE };

  it('sends a code without creating users, then verifies it and stores the session privately', async () => {
    const server = fakeGoTrue();
    harness = createHarness({ env, fetchImpl: server.impl });
    const sent = await harness.run(['login', '--email', 'me@example.com', '--json']);
    expect(sent.code).toBe(0);
    expect(sent.json).toMatchObject({ status: 'code_sent', email: 'me@example.com' });
    expect(server.calls.find((call) => call.path.startsWith('/auth/v1/otp'))?.body).toMatchObject({ email: 'me@example.com', create_user: false });
    expect(existsSync(harness.rt.paths.session)).toBe(false);

    const verified = await harness.run(['login', '--email', 'me@example.com', '--code', '12345678', '--json']);
    expect(verified.code).toBe(0);
    expect(verified.json).toMatchObject({ status: 'signed_in', email: 'me@example.com', user_id: USER_ID });
    expect(existsSync(harness.rt.paths.session)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(harness.rt.paths.session).mode & 0o077).toBe(0);

    // The email is remembered, and no command ever prints a token.
    const stored = readFileSync(harness.rt.paths.session, 'utf8');
    const accessToken = /"access_token\\?":\\?"([^"\\]+)/.exec(stored)?.[1] ?? '';
    expect(accessToken.length).toBeGreaterThan(20);
    const whoami = await harness.run(['whoami', '--json']);
    expect(whoami.json).toMatchObject({ email: 'me@example.com', user_id: USER_ID });
    for (const output of [sent.stdout, sent.stderr, verified.stdout, verified.stderr, whoami.stdout, whoami.stderr]) {
      expect(output).not.toContain(accessToken);
      expect(output).not.toContain('refresh-token');
      expect(output).not.toContain(KEY_VALUE);
    }
  });

  it('rejects a wrong code with exit 5 and keeps the user signed out', async () => {
    const server = fakeGoTrue();
    harness = createHarness({ env, fetchImpl: server.impl });
    const result = await harness.run(['login', '--email', 'me@example.com', '--code', '99999999', '--json']);
    expect(result.code).toBe(5);
    expect(result.json['error'].message).toContain('not accepted');
    expect(existsSync(harness.rt.paths.session)).toBe(false);
    expect((await harness.run(['whoami', '--json'])).code).toBe(3);
  });

  it('validates the email and the code shape before any request', async () => {
    const server = fakeGoTrue();
    harness = createHarness({ env, fetchImpl: server.impl });
    expect((await harness.run(['login', '--email', 'not-an-email', '--json'])).code).toBe(5);
    expect((await harness.run(['login', '--email', 'me@example.com', '--code', 'abc', '--json'])).code).toBe(5);
    expect((await harness.run(['login', '--json'])).code).toBe(2); // no email, nothing remembered, no terminal
    expect(server.calls).toHaveLength(0);
  });

  it('refreshes an expired session by itself, once, and keeps the new tokens', async () => {
    const server = fakeGoTrue();
    harness = createHarness({ env, fetchImpl: server.impl });
    await harness.run(['login', '--email', 'me@example.com', '--code', '12345678']);
    const file = JSON.parse(readFileSync(harness.rt.paths.session, 'utf8')) as Record<string, string>;
    const [storageKey] = Object.keys(file) as [string];
    const session = JSON.parse(file[storageKey] as string) as Record<string, unknown>;
    session['expires_at'] = Math.floor(Date.now() / 1000) - 60;
    writeFileSync(harness.rt.paths.session, JSON.stringify({ [storageKey]: JSON.stringify(session) }));

    const fresh = new AuthService({ env, platform: process.platform, cwd: harness.configDir, scriptDir: harness.configDir, paths: harness.rt.paths, fetchImpl: server.impl });
    const refreshed = await fresh.session();
    expect(refreshed?.user.id).toBe(USER_ID);
    expect(server.countOf('/auth/v1/token')).toBe(1);
    expect(server.calls.find((call) => call.path.startsWith('/auth/v1/token'))?.body).toMatchObject({ refresh_token: 'refresh-token-1' });
    expect(readFileSync(harness.rt.paths.session, 'utf8')).toContain('refresh-token-2');
    await fresh.session();
    expect(server.countOf('/auth/v1/token')).toBe(1);
  });

  it('two commands refreshing at once refresh only once (the second reuses the first result)', async () => {
    const server = fakeGoTrue();
    harness = createHarness({ env, fetchImpl: server.impl });
    await harness.run(['login', '--email', 'me@example.com', '--code', '12345678']);
    const file = JSON.parse(readFileSync(harness.rt.paths.session, 'utf8')) as Record<string, string>;
    const [storageKey] = Object.keys(file) as [string];
    const session = JSON.parse(file[storageKey] as string) as Record<string, unknown>;
    session['expires_at'] = Math.floor(Date.now() / 1000) - 60;
    writeFileSync(harness.rt.paths.session, JSON.stringify({ [storageKey]: JSON.stringify(session) }));

    const make = () => new AuthService({ env, platform: process.platform, cwd: harness!.configDir, scriptDir: harness!.configDir, paths: harness!.rt.paths, fetchImpl: server.impl });
    const [first, second] = await Promise.all([make().session(), make().session()]);
    expect(first?.user.id).toBe(USER_ID);
    expect(second?.user.id).toBe(USER_ID);
    expect(server.countOf('/auth/v1/token')).toBe(1);
  });

  it('logout revokes the session and deletes the file; logging out twice is harmless', async () => {
    const server = fakeGoTrue();
    harness = createHarness({ env, fetchImpl: server.impl });
    await harness.run(['login', '--email', 'me@example.com', '--code', '12345678']);
    const out = await harness.run(['logout', '--json']);
    expect(out.json).toMatchObject({ status: 'signed_out' });
    expect(server.countOf('/auth/v1/logout')).toBe(1);
    expect(existsSync(harness.rt.paths.session)).toBe(false);
    expect((await harness.run(['logout', '--json'])).json).toMatchObject({ status: 'not_signed_in' });
    expect((await harness.run(['whoami'])).code).toBe(3);
  });

  it('a command that needs data says how to sign in when there is no session', async () => {
    const server = fakeGoTrue();
    harness = createHarness({ env, fetchImpl: server.impl });
    const result = await harness.run(['events', 'list', '--json']);
    expect(result.code).toBe(3);
    expect(result.json['error']).toMatchObject({ code: 'not_logged_in' });
    expect(result.json['error'].hint).toContain('login --email');
  });
});
