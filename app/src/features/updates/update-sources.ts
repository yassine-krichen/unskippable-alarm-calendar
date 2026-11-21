import { App } from '@capacitor/app';

import { detectPlatform } from '@/lib/platform';

import type { CheckRecord } from './check-record';
import { fetchLatestRelease, type FetchLike, type ReleaseInfo } from './github-release';

/** What a check found. `release` is the newest published release, or null when there is none to report. */
export type SourceCheck =
  | { kind: 'checked'; release: ReleaseInfo | null; etag: string | null }
  | { kind: 'error'; reason: 'offline' | 'rate-limited' | 'invalid' | 'unsupported' };

/** Where this build learns about updates. The two shells ask differently; the rest of the feature does not care. */
export interface UpdateSource {
  platform: 'android' | 'electron';
  /** The version this build is. */
  installedVersion(): Promise<string>;
  /** `prior` is the last stored record, used for the ETag. */
  check(prior: CheckRecord | null): Promise<SourceCheck>;
}

/**
 * Android: the renderer asks GitHub itself (api.github.com answers any origin, and the Android build sets no CSP).
 * The installed version is the native one, so it is the truth even if the web bundle is out of step.
 */
export function createAndroidSource(fetchFn: FetchLike = (url, init) => fetch(url, init)): UpdateSource {
  return {
    platform: 'android',
    installedVersion: async () => (await App.getInfo()).version,
    check: async (prior) => {
      // An ETag is only worth sending when the release it describes is at hand to reuse on a 304.
      const etag = prior?.release ? prior.etag : null;
      const outcome = await fetchLatestRelease(fetchFn, etag);
      if (outcome.kind === 'error') return outcome;
      if (outcome.kind === 'not-modified') return { kind: 'checked', release: prior?.release ?? null, etag };
      if (outcome.kind === 'none') return { kind: 'checked', release: null, etag: null };
      return { kind: 'checked', release: outcome.release, etag: outcome.etag };
    },
  };
}

/** Desktop: the check runs in the Electron main process (the renderer's CSP does not allow GitHub). */
export function createDesktopSource(api: NonNullable<Window['desktopApi']>): UpdateSource {
  return {
    platform: 'electron',
    installedVersion: () => api.getAppVersion(),
    check: async () => {
      let result: Awaited<ReturnType<typeof api.checkForUpdate>>;
      try {
        result = await api.checkForUpdate();
      } catch {
        return { kind: 'error', reason: 'offline' };
      }
      if (result.status === 'current') return { kind: 'checked', release: null, etag: null };
      if (result.status === 'unavailable') {
        return { kind: 'error', reason: result.reason === 'not-packaged' ? 'unsupported' : result.reason };
      }
      return {
        kind: 'checked',
        release: { version: result.latestVersion, notes: result.notes, htmlUrl: result.htmlUrl, android: null },
        etag: null,
      };
    },
  };
}

/** The source for this shell, or null where updates do not apply (the browser). */
export function updateSourceForPlatform(): UpdateSource | null {
  const platform = detectPlatform();
  if (platform === 'android') return createAndroidSource();
  if (platform === 'electron' && window.desktopApi !== undefined) return createDesktopSource(window.desktopApi);
  return null;
}
