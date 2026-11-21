import {
  LATEST_RELEASE_API_URL,
  RELEASE_ASSET_URL_PREFIX,
  RELEASE_REPO,
  normalizeReleaseVersion,
} from '@alarm-calendar/core';
import { z } from 'zod';

import { fail, ok, type Result } from '@/lib/result';

/** What the release carries for the Android app. The download address is always inside this repository's releases. */
export interface AndroidAsset {
  name: string;
  url: string;
  sizeBytes: number;
  /**
   * Lowercase hex from the asset's own `digest` in GitHub's API. Null when GitHub gave none (or a malformed one): the
   * update is then not downloaded in the app. SHA256SUMS.txt stays on the release for people, but the app never fetches
   * it (a WebView fetch of a release asset is a cross-origin redirect it cannot rely on).
   */
  sha256: string | null;
}

/** A published release, reduced to what the app shows and uses. */
export interface ReleaseInfo {
  version: string;
  /** Plain text. Never rendered as markdown or HTML. */
  notes: string;
  htmlUrl: string;
  android: AndroidAsset | null;
}

export type ReleaseFetchOutcome =
  | { kind: 'release'; release: ReleaseInfo; etag: string | null }
  | { kind: 'not-modified' }
  /** No release is published yet. */
  | { kind: 'none' }
  | { kind: 'error'; reason: 'offline' | 'rate-limited' | 'invalid' };

/** The part of fetch this module uses, so a test can pass a fake. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

const MAX_NOTES_LENGTH = 4_000;
const REQUEST_TIMEOUT_MS = 10_000;
const DIGEST_PATTERN = /^sha256:([0-9a-fA-F]{64})$/;

const releaseSchema = z.object({
  tag_name: z.string().min(1).max(64),
  body: z.string().nullish(),
  html_url: z.string().max(500).startsWith(`https://github.com/${RELEASE_REPO}/releases/`),
  assets: z
    .array(
      z.object({
        name: z.string().max(200),
        browser_download_url: z.string().max(500),
        size: z.number().int().nonnegative(),
        digest: z.string().max(100).nullish(),
      })
    )
    .max(100),
});

/**
 * Reads `releases/latest` (published releases only: GitHub skips drafts and prereleases there). The repository is a
 * constant. Never throws: a network or format problem comes back as an `error` outcome. `etag` makes an unchanged
 * answer a 304, which does not count against GitHub's 60 requests per hour for unauthenticated clients.
 */
export async function fetchLatestRelease(fetchFn: FetchLike, etag: string | null): Promise<ReleaseFetchOutcome> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (etag !== null) headers['If-None-Match'] = etag;

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchFn(LATEST_RELEASE_API_URL, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    return { kind: 'error', reason: 'offline' };
  }
  if (response.status === 304) return { kind: 'not-modified' };
  if (response.status === 404) return { kind: 'none' };
  if (response.status === 403 || response.status === 429) return { kind: 'error', reason: 'rate-limited' };
  if (response.status !== 200) return { kind: 'error', reason: 'offline' };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: 'error', reason: 'invalid' };
  }
  const release = parseRelease(body);
  if (release === null) return { kind: 'error', reason: 'invalid' };
  return { kind: 'release', release, etag: response.headers.get('etag') };
}

/** Reduces GitHub's release JSON to a [ReleaseInfo], or null when it is not a usable release of this project. */
export function parseRelease(raw: unknown): ReleaseInfo | null {
  const parsed = releaseSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { tag_name: tag, body, html_url: htmlUrl, assets } = parsed.data;
  const version = normalizeReleaseVersion(tag);
  if (version === null) return null;

  const apkName = `Alarm-Calendar-${version}.apk`;
  const apk = assets.find((asset) => asset.name === apkName);
  const inRepository = (url: string): boolean => url.startsWith(RELEASE_ASSET_URL_PREFIX);

  let android: AndroidAsset | null = null;
  // An APK served from anywhere but this repository's releases is not offered at all.
  if (apk !== undefined && inRepository(apk.browser_download_url)) {
    const digest = DIGEST_PATTERN.exec(apk.digest ?? '');
    android = {
      name: apk.name,
      url: apk.browser_download_url,
      sizeBytes: apk.size,
      sha256: digest?.[1]?.toLowerCase() ?? null,
    };
  }
  return { version, notes: (body ?? '').slice(0, MAX_NOTES_LENGTH), htmlUrl, android };
}

/**
 * The SHA-256 the download must match: the asset's own digest from GitHub's API. No digest means no download (fail
 * closed): an APK is never installed unverified, and the person is told where to get it instead.
 */
export function requireSha256(asset: AndroidAsset): Result<string> {
  if (asset.sha256 !== null) return ok(asset.sha256);
  return fail('GitHub gave no checksum for this update, so it was not downloaded. Install it from the release page instead.');
}
