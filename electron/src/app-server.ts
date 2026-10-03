import { join, relative, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import { net, protocol } from 'electron';

/**
 * Where the React app is loaded from, and the web-security policy around it.
 *
 * Dev: the Vite server (ALARM_APP_URL, http://localhost:3021). Otherwise the
 * built app/dist served from the custom `app://alarm-calendar` origin rather
 * than file://, per Electron's security guidance: a real origin, no access to
 * arbitrary files, and root-relative asset URLs (/assets/..., /sounds/...) work.
 */

export const APP_SCHEME = 'app';
export const APP_HOST = 'alarm-calendar';

export interface AppLocation {
  /** `scheme://host[:port]` with no path; the only origin windows may show. */
  origin: string;
  /** Page URL of the app, no hash. */
  url: string;
  /** Vite dev server (relaxed CSP for HMR) rather than the built bundle. */
  dev: boolean;
}

/** Dev server URL when given, else the packaged-style custom protocol. */
export function resolveAppLocation(devUrl: string | null): AppLocation {
  if (devUrl !== null) {
    const parsed = new URL(devUrl);
    // Only a local dev server may stand in for the bundle.
    if (parsed.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
      throw new Error('ALARM_APP_URL must be an http://localhost URL');
    }
    return { origin: parsed.origin, url: `${parsed.origin}/`, dev: true };
  }
  const origin = `${APP_SCHEME}://${APP_HOST}`;
  return { origin, url: `${origin}/index.html`, dev: false };
}

/** The alarm window is the same app at a hash route (see app/src/alarm-entry.tsx). */
export function alarmPageUrl(location: AppLocation, occurrenceId: string): string {
  return `${location.url}#/alarm?occurrence=${encodeURIComponent(occurrenceId)}`;
}

export function isAppOrigin(url: string, location: AppLocation): boolean {
  try {
    const target = new URL(url);
    const app = new URL(location.origin);
    // Compared by parts: URL.origin is the string 'null' for a custom scheme like app://.
    return (
      target.protocol === app.protocol &&
      target.host === app.host &&
      target.username === '' &&
      target.password === ''
    );
  } catch {
    return false;
  }
}

/**
 * CSP for the app. Supabase REST over https, realtime over wss, nothing else.
 * Inline styles stay allowed because the UI libraries (FullCalendar, base-ui,
 * sonner) set style attributes and style tags at runtime; scripts do not.
 * The dev server additionally needs an inline script (react-refresh preamble)
 * and its HMR websocket.
 */
export function buildCsp(supabaseOrigin: string | null, location: AppLocation): string {
  const connect = ["'self'"];
  if (supabaseOrigin !== null) {
    connect.push(supabaseOrigin, supabaseOrigin.replace(/^https:/, 'wss:'));
  }
  const script = ["'self'"];
  if (location.dev) {
    script.push("'unsafe-inline'");
    connect.push(location.origin.replace(/^http:/, 'ws:'));
  }
  return [
    "default-src 'none'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    `connect-src ${connect.join(' ')}`,
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Must run before app ready. `stream` lets the looping alarm sound play from the scheme. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

/**
 * Resolves a request path inside `root`, or null when it escapes it. Pure so
 * the traversal guard is testable.
 */
export function resolveInside(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const target = resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? target : null;
}

/** Serves `distDir` on app://alarm-calendar/ with the CSP header. Call after app ready. */
export function serveAppFromDisk(distDir: string, csp: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const { host, pathname } = new URL(request.url);
    if (host !== APP_HOST) return new Response('not found', { status: 404 });
    const target = resolveInside(distDir, pathname === '/' ? '/index.html' : pathname);
    if (target === null) return new Response('bad request', { status: 400 });

    // Range is forwarded so the media element can stream and loop the alarm sound.
    const range = request.headers.get('range');
    const response = await net.fetch(pathToFileURL(target).toString(), {
      headers: range === null ? {} : { range },
    });
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', csp);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
}

export function defaultDistDir(electronDistDir: string, isPackaged: boolean): string {
  // Packaged builds ship the app bundle as the app-dist resource (electron-builder.yml, extraResources).
  return isPackaged ? join(process.resourcesPath, 'app-dist') : resolve(electronDistDir, '..', '..', 'app', 'dist');
}
