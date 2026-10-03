import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  alarmPageUrl,
  buildCsp,
  isAppOrigin,
  resolveAppLocation,
  resolveInside,
} from './app-server';

const SUPABASE = 'https://example-ref.supabase.co';

describe('resolveAppLocation', () => {
  it('serves the bundle from the app:// origin when there is no dev server', () => {
    expect(resolveAppLocation(null)).toEqual({
      origin: 'app://alarm-calendar',
      url: 'app://alarm-calendar/index.html',
      dev: false,
    });
  });

  it('uses the Vite dev server when given', () => {
    expect(resolveAppLocation('http://localhost:3021')).toEqual({
      origin: 'http://localhost:3021',
      url: 'http://localhost:3021/',
      dev: true,
    });
  });

  it('refuses a dev url that is not a local http server', () => {
    expect(() => resolveAppLocation('https://evil.example.com')).toThrow();
    expect(() => resolveAppLocation('http://evil.example.com:3021')).toThrow();
  });
});

describe('isAppOrigin (the navigation allowlist)', () => {
  const bundle = resolveAppLocation(null);
  const dev = resolveAppLocation('http://localhost:3021');

  it('allows only the exact origin, whatever the path or hash', () => {
    expect(isAppOrigin('app://alarm-calendar/index.html#/settings', bundle)).toBe(true);
    expect(isAppOrigin('http://localhost:3021/#/alarm?occurrence=x', dev)).toBe(true);
  });

  it('blocks other origins, other ports, look-alike hosts and junk', () => {
    expect(isAppOrigin('https://example.com', bundle)).toBe(false);
    expect(isAppOrigin('app://alarm-calendar.evil.com/', bundle)).toBe(false);
    expect(isAppOrigin('http://localhost:3022/', dev)).toBe(false);
    expect(isAppOrigin('http://localhost:3021@evil.com/', dev)).toBe(false);
    expect(isAppOrigin('file:///C:/secret.txt', bundle)).toBe(false);
    expect(isAppOrigin('not a url', bundle)).toBe(false);
  });
});

describe('alarmPageUrl', () => {
  it('points the alarm window at the hash route with the occurrence encoded', () => {
    const url = alarmPageUrl(resolveAppLocation(null), '11111111-1111-4111-8111-111111111111@2026-03-02T09:01:00.000Z');
    expect(url.startsWith('app://alarm-calendar/index.html#/alarm?occurrence=')).toBe(true);
    const query = new URLSearchParams(url.split('?')[1]);
    expect(query.get('occurrence')).toBe('11111111-1111-4111-8111-111111111111@2026-03-02T09:01:00.000Z');
  });
});

describe('buildCsp', () => {
  it('allows Supabase over https and wss for the bundle, and no inline scripts', () => {
    const csp = buildCsp(SUPABASE, resolveAppLocation(null));
    expect(csp).toContain(`connect-src 'self' ${SUPABASE} wss://example-ref.supabase.co`);
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('adds only the dev server websocket and an inline script allowance in dev', () => {
    const csp = buildCsp(SUPABASE, resolveAppLocation('http://localhost:3021'));
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain('ws://localhost:3021');
  });

  it('allows no remote host at all when the build has no Supabase origin', () => {
    expect(buildCsp(null, resolveAppLocation(null))).toContain("connect-src 'self';");
  });
});

describe('resolveInside (path traversal guard for the app:// handler)', () => {
  const root = resolve('C:/app/dist');

  it('resolves normal files inside the root', () => {
    expect(resolveInside(root, '/index.html')).toBe(join(root, 'index.html'));
    expect(resolveInside(root, '/assets/app-abc.js')).toBe(join(root, 'assets', 'app-abc.js'));
  });

  it('refuses paths that climb out of the root, including encoded ones', () => {
    expect(resolveInside(root, '/../secret.txt')).toBeNull();
    expect(resolveInside(root, '/%2e%2e/secret.txt')).toBeNull();
    expect(resolveInside(root, '/assets/../../secret.txt')).toBeNull();
  });

  it('refuses the root itself and undecodable paths', () => {
    expect(resolveInside(root, '/')).toBeNull();
    expect(resolveInside(root, '/%E0%A4%A')).toBeNull();
  });
});
