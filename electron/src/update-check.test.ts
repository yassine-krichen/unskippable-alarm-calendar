import { describe, expect, it } from 'vitest';
import { LATEST_RELEASE_API_URL, LATEST_RELEASE_PAGE_URL } from '@alarm-calendar/core';

import { parseNoArguments } from './desktop-payloads';
import { createUpdateCheck } from './update-check';
import type { FetchLike } from './update-check';

const RELEASE_PAGE = 'https://github.com/yassine-krichen/unskippable-alarm-calendar/releases/tag/v0.3.0';

interface FakeAnswer {
  status: number;
  body?: unknown;
  etag?: string;
  badJson?: boolean;
}

/** A fetch that serves the given answers in order and records what it was asked. */
function fakeFetch(...answers: FakeAnswer[]): { fetch: FetchLike; calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let index = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    if (answer === undefined) throw new Error('no answer');
    if (answer.status === 0) throw new Error('offline');
    return {
      status: answer.status,
      headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? (answer.etag ?? null) : null) },
      json: async () => {
        if (answer.badJson) throw new Error('not json');
        return answer.body;
      },
    };
  };
  return { fetch, calls };
}

const release = (tag: string, body: string | null = 'Notes') => ({ tag_name: tag, body, html_url: RELEASE_PAGE });

function checker(current: string, isPackaged: boolean, ...answers: FakeAnswer[]) {
  const { fetch, calls } = fakeFetch(...answers);
  return { check: createUpdateCheck({ fetch, currentVersion: current, isPackaged }), calls };
}

describe('the desktop update check', () => {
  it('reports a newer release with its notes and page', async () => {
    const { check, calls } = checker('0.2.0', true, { status: 200, body: release('v0.3.0', 'Fixes'), etag: '"a"' });
    expect(await check()).toEqual({ status: 'available', latestVersion: '0.3.0', notes: 'Fixes', htmlUrl: RELEASE_PAGE });
    expect(calls[0]?.url).toBe(LATEST_RELEASE_API_URL);
  });

  it('says current when the release is the same or older', async () => {
    expect((await checker('0.2.0', true, { status: 200, body: release('v0.2.0') }).check()).status).toBe('current');
    expect((await checker('0.2.0', true, { status: 200, body: release('v0.1.0') }).check()).status).toBe('current');
  });

  it('says current when no release is published yet', async () => {
    expect(await checker('0.2.0', true, { status: 404 }).check()).toEqual({ status: 'current' });
  });

  it('does nothing and does not even ask GitHub when the app is not packaged', async () => {
    const { check, calls } = checker('0.2.0', false, { status: 200, body: release('v9.9.9') });
    expect(await check()).toEqual({ status: 'unavailable', reason: 'not-packaged' });
    expect(calls).toHaveLength(0);
  });

  it('sends the stored ETag next time, and a 304 reuses the last answer', async () => {
    const { check, calls } = checker('0.2.0', true, { status: 200, body: release('v0.3.0'), etag: '"abc"' }, { status: 304 });
    expect((await check()).status).toBe('available');
    const second = await check();
    expect(second.status).toBe('available');
    expect(calls[0]?.headers['If-None-Match']).toBeUndefined();
    expect(calls[1]?.headers['If-None-Match']).toBe('"abc"');
  });

  it('reports a rate limit, an outage and an unreadable answer without throwing', async () => {
    expect(await checker('0.2.0', true, { status: 403 }).check()).toEqual({ status: 'unavailable', reason: 'rate-limited' });
    expect(await checker('0.2.0', true, { status: 429 }).check()).toEqual({ status: 'unavailable', reason: 'rate-limited' });
    expect(await checker('0.2.0', true, { status: 500 }).check()).toEqual({ status: 'unavailable', reason: 'offline' });
    expect(await checker('0.2.0', true, { status: 0 }).check()).toEqual({ status: 'unavailable', reason: 'offline' });
    expect(await checker('0.2.0', true, { status: 200, badJson: true }).check()).toEqual({ status: 'unavailable', reason: 'invalid' });
    expect(await checker('0.2.0', true, { status: 200, body: { nope: 1 } }).check()).toEqual({ status: 'unavailable', reason: 'invalid' });
    expect(await checker('0.2.0', true, { status: 200, body: release('latest') }).check()).toEqual({ status: 'unavailable', reason: 'invalid' });
  });

  it('refuses a release page that is not inside this repository', async () => {
    const body = { tag_name: 'v0.3.0', body: '', html_url: 'https://evil.example/releases/tag/v0.3.0' };
    expect(await checker('0.2.0', true, { status: 200, body }).check()).toEqual({ status: 'unavailable', reason: 'invalid' });
  });

  it('cuts very long notes', async () => {
    const result = await checker('0.2.0', true, { status: 200, body: release('v0.3.0', 'x'.repeat(50_000)) }).check();
    expect(result.status === 'available' ? result.notes.length : -1).toBe(4_000);
  });

  it('does not report a prerelease-tagged build of the installed version as an update', async () => {
    expect((await checker('0.2.0', true, { status: 200, body: release('v0.2.0-beta.1') }).check()).status).toBe('current');
  });
});

describe('the release page channel', () => {
  it('opens one fixed address', () => {
    expect(LATEST_RELEASE_PAGE_URL).toBe('https://github.com/yassine-krichen/unskippable-alarm-calendar/releases/latest');
  });

  it('refuses any argument, so the renderer cannot name a URL', () => {
    expect(parseNoArguments([]).ok).toBe(true);
    expect(parseNoArguments(['https://evil.example']).ok).toBe(false);
  });
});
