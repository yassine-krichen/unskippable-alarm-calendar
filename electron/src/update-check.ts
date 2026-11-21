import { isNewerVersion, LATEST_RELEASE_API_URL, normalizeReleaseVersion, RELEASE_REPO } from '@alarm-calendar/core';
import type { DesktopUpdateCheck } from '@alarm-calendar/core';
import { z } from 'zod';

/** Release notes are shown as plain text in a sheet; a few KB is plenty and bounds what main hands the renderer. */
const MAX_NOTES_LENGTH = 4_000;
const REQUEST_TIMEOUT_MS = 10_000;

// Only the fields used; html_url must stay inside this repository's releases.
const releaseSchema = z.object({
  tag_name: z.string().min(1).max(64),
  body: z.string().nullish(),
  html_url: z.string().max(500).startsWith(`https://github.com/${RELEASE_REPO}/releases/`),
});

/** What the check needs from fetch, so a test can pass a fake. Electron's `net.fetch` fits. */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal }
) => Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

interface UpdateCheckDeps {
  fetch: FetchLike;
  /** `app.getVersion()` */
  currentVersion: string;
  /** Only an installed build checks; a dev run does not (and never touches the daily dev data). */
  isPackaged: boolean;
}

type LatestRelease = Extract<DesktopUpdateCheck, { status: 'available' }>;

/**
 * Builds the main-process update check. It remembers GitHub's ETag and the last answer, so a repeat check that gets
 * 304 Not Modified does not count against the 60 requests per hour an unauthenticated client may make.
 */
export function createUpdateCheck(deps: UpdateCheckDeps): () => Promise<DesktopUpdateCheck> {
  let etag: string | null = null;
  let known: { latestVersion: string; notes: string; htmlUrl: string } | null = null;

  const answer = (): DesktopUpdateCheck => {
    if (known === null || !isNewerVersion(known.latestVersion, deps.currentVersion)) return { status: 'current' };
    const available: LatestRelease = { status: 'available', ...known };
    return available;
  };

  return async () => {
    if (!deps.isPackaged) return { status: 'unavailable', reason: 'not-packaged' };

    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'AlarmCalendar-Desktop' };
    if (etag !== null) headers['If-None-Match'] = etag;

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await deps.fetch(LATEST_RELEASE_API_URL, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      return { status: 'unavailable', reason: 'offline' };
    }

    if (response.status === 304) return answer();
    // 404 means no release is published yet: nothing newer than this build.
    if (response.status === 404) return { status: 'current' };
    if (response.status === 403 || response.status === 429) return { status: 'unavailable', reason: 'rate-limited' };
    if (response.status !== 200) return { status: 'unavailable', reason: 'offline' };

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { status: 'unavailable', reason: 'invalid' };
    }
    const parsed = releaseSchema.safeParse(body);
    if (!parsed.success) return { status: 'unavailable', reason: 'invalid' };
    const latestVersion = normalizeReleaseVersion(parsed.data.tag_name);
    if (latestVersion === null) return { status: 'unavailable', reason: 'invalid' };

    etag = response.headers.get('etag');
    known = { latestVersion, notes: (parsed.data.body ?? '').slice(0, MAX_NOTES_LENGTH), htmlUrl: parsed.data.html_url };
    return answer();
  };
}
