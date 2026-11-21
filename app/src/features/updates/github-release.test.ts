import { describe, expect, it } from 'vitest';

import {
  fetchLatestRelease,
  parseRelease,
  requireSha256,
  type AndroidAsset,
  type FetchLike,
} from './github-release';

const REPO_RELEASES = 'https://github.com/yassine-krichen/unskippable-alarm-calendar/releases';
const HASH = 'ab'.repeat(32);

interface Asset {
  name: string;
  browser_download_url: string;
  size: number;
  digest?: string | null;
}

function release(overrides: Record<string, unknown> = {}, assets?: Asset[]) {
  return {
    tag_name: 'v0.3.0',
    body: 'Notes here',
    html_url: `${REPO_RELEASES}/tag/v0.3.0`,
    assets: assets ?? [
      {
        name: 'Alarm-Calendar-0.3.0.apk',
        browser_download_url: `${REPO_RELEASES}/download/v0.3.0/Alarm-Calendar-0.3.0.apk`,
        size: 5_000_000,
        digest: `sha256:${HASH}`,
      },
      {
        name: 'SHA256SUMS.txt',
        browser_download_url: `${REPO_RELEASES}/download/v0.3.0/SHA256SUMS.txt`,
        size: 200,
        digest: null,
      },
    ],
    ...overrides,
  };
}

interface Answer {
  status: number;
  body?: unknown;
  etag?: string;
  throws?: boolean;
}

function fakeFetch(answer: Answer): { fetch: FetchLike; calls: { url: string; headers?: Record<string, string> }[] } {
  const calls: { url: string; headers?: Record<string, string> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers });
    if (answer.throws) throw new Error('offline');
    return {
      status: answer.status,
      headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? (answer.etag ?? null) : null) },
      json: async () => answer.body,
    };
  };
  return { fetch, calls };
}

describe('parseRelease', () => {
  it('reads the version, notes, page and the APK with its digest', () => {
    const parsed = parseRelease(release());
    expect(parsed).toEqual({
      version: '0.3.0',
      notes: 'Notes here',
      htmlUrl: `${REPO_RELEASES}/tag/v0.3.0`,
      android: {
        name: 'Alarm-Calendar-0.3.0.apk',
        url: `${REPO_RELEASES}/download/v0.3.0/Alarm-Calendar-0.3.0.apk`,
        sizeBytes: 5_000_000,
        sha256: HASH,
      },
    });
  });

  it('has no Android download when the release carries no APK', () => {
    const parsed = parseRelease(release({}, [{ name: 'Alarm-Calendar-Setup-0.3.0.exe', browser_download_url: `${REPO_RELEASES}/download/v0.3.0/x.exe`, size: 1 }]));
    expect(parsed?.android).toBeNull();
    expect(parsed?.version).toBe('0.3.0');
  });

  it('ignores an APK named for a different version than the tag', () => {
    const parsed = parseRelease(
      release({}, [{ name: 'Alarm-Calendar-0.2.0.apk', browser_download_url: `${REPO_RELEASES}/download/v0.3.0/Alarm-Calendar-0.2.0.apk`, size: 1 }])
    );
    expect(parsed?.android).toBeNull();
  });

  it('has no checksum (so the app will not download it) when the digest is missing or malformed', () => {
    for (const digest of [undefined, null, 'md5:abc', `sha256:${HASH.slice(2)}`, `sha1:${HASH}`]) {
      const apk: Asset = { name: 'Alarm-Calendar-0.3.0.apk', browser_download_url: `${REPO_RELEASES}/download/v0.3.0/Alarm-Calendar-0.3.0.apk`, size: 1, digest };
      expect(parseRelease(release({}, [apk]))?.android?.sha256).toBeNull();
    }
  });

  it('lowercases an upper-case digest', () => {
    const apk: Asset = {
      name: 'Alarm-Calendar-0.3.0.apk',
      browser_download_url: `${REPO_RELEASES}/download/v0.3.0/Alarm-Calendar-0.3.0.apk`,
      size: 1,
      digest: `sha256:${HASH.toUpperCase()}`,
    };
    expect(parseRelease(release({}, [apk]))?.android?.sha256).toBe(HASH);
  });

  it('refuses an APK served from anywhere but this repository releases', () => {
    const apk: Asset = {
      name: 'Alarm-Calendar-0.3.0.apk',
      browser_download_url: 'https://evil.example/yassine-krichen/unskippable-alarm-calendar/releases/download/v0.3.0/Alarm-Calendar-0.3.0.apk',
      size: 1,
      digest: `sha256:${HASH}`,
    };
    expect(parseRelease(release({}, [apk]))?.android).toBeNull();
    const otherRepo: Asset = { ...apk, browser_download_url: 'https://github.com/someone/else/releases/download/v0.3.0/Alarm-Calendar-0.3.0.apk' };
    expect(parseRelease(release({}, [otherRepo]))?.android).toBeNull();
  });

  it('is null for something that is not a release of this project', () => {
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease({ tag_name: 'v1' })).toBeNull();
    expect(parseRelease(release({ tag_name: 'nightly' }))).toBeNull();
    expect(parseRelease(release({ html_url: 'https://evil.example/releases/tag/v0.3.0' }))).toBeNull();
  });

  it('cuts very long notes', () => {
    expect(parseRelease(release({ body: 'x'.repeat(50_000) }))?.notes.length).toBe(4_000);
    expect(parseRelease(release({ body: null }))?.notes).toBe('');
  });
});

describe('fetchLatestRelease', () => {
  it('asks the releases/latest address of this repository', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: release(), etag: '"v1"' });
    const outcome = await fetchLatestRelease(fetch, null);
    expect(calls[0]?.url).toBe('https://api.github.com/repos/yassine-krichen/unskippable-alarm-calendar/releases/latest');
    expect(calls[0]?.headers?.['If-None-Match']).toBeUndefined();
    expect(outcome.kind === 'release' ? outcome.etag : null).toBe('"v1"');
  });

  it('sends the ETag it was given', async () => {
    const { fetch, calls } = fakeFetch({ status: 304 });
    expect(await fetchLatestRelease(fetch, '"v1"')).toEqual({ kind: 'not-modified' });
    expect(calls[0]?.headers?.['If-None-Match']).toBe('"v1"');
  });

  it('maps no release, a rate limit, an outage and bad data to outcomes without throwing', async () => {
    expect(await fetchLatestRelease(fakeFetch({ status: 404 }).fetch, null)).toEqual({ kind: 'none' });
    expect(await fetchLatestRelease(fakeFetch({ status: 403 }).fetch, null)).toEqual({ kind: 'error', reason: 'rate-limited' });
    expect(await fetchLatestRelease(fakeFetch({ status: 429 }).fetch, null)).toEqual({ kind: 'error', reason: 'rate-limited' });
    expect(await fetchLatestRelease(fakeFetch({ status: 502 }).fetch, null)).toEqual({ kind: 'error', reason: 'offline' });
    expect(await fetchLatestRelease(fakeFetch({ status: 0, throws: true }).fetch, null)).toEqual({ kind: 'error', reason: 'offline' });
    expect(await fetchLatestRelease(fakeFetch({ status: 200, body: { nope: true } }).fetch, null)).toEqual({ kind: 'error', reason: 'invalid' });
  });
});

describe('requireSha256', () => {
  const asset = (sha256: string | null): AndroidAsset => ({
    name: 'Alarm-Calendar-0.3.0.apk',
    url: `${REPO_RELEASES}/download/v0.3.0/Alarm-Calendar-0.3.0.apk`,
    sizeBytes: 1,
    sha256,
  });

  it('uses the asset digest', () => {
    expect(requireSha256(asset(HASH))).toEqual({ data: HASH, error: null });
  });

  it('fails closed with a clear message when GitHub gave no digest, and never goes looking elsewhere', () => {
    const result = requireSha256(asset(null));
    expect(result.data).toBeNull();
    expect(result.error).toMatch(/no checksum/);
    expect(result.error).toMatch(/release page/);
  });
});
