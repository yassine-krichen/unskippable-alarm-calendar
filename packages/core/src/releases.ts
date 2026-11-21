/**
 * Where releases live and how versions compare. Shared by the app (the Android updater) and the Electron main
 * process (the desktop update check), so neither builds a URL from anything it was given.
 */

/** The repository releases are published to. */
export const RELEASE_REPO = 'yassine-krichen/unskippable-alarm-calendar';

/** GitHub's API answer for the newest published (not draft, not prerelease) release. */
export const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;

/** The page the desktop app opens; the only address main ever hands to the browser. */
export const LATEST_RELEASE_PAGE_URL = `https://github.com/${RELEASE_REPO}/releases/latest`;

/** Where this repository's release assets are served from (the first hop of a download). */
export const RELEASE_ASSET_URL_PREFIX = `https://github.com/${RELEASE_REPO}/releases/download/`;

const VERSION_PATTERN = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:[-+][0-9A-Za-z.+-]*)?$/;

/** `[major, minor, patch]` of a tag such as `v0.2.1`; a prerelease or build suffix is ignored. Null when it is not a version. */
export function parseReleaseVersion(text: string): [number, number, number] | null {
  const match = VERSION_PATTERN.exec(text.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** The plain `x.y.z` of a tag (leading `v` and any suffix dropped), or null. */
export function normalizeReleaseVersion(text: string): string | null {
  const parts = parseReleaseVersion(text);
  return parts === null ? null : parts.join('.');
}

/** True only when `candidate` is a strictly higher version than `installed`. Anything unreadable is not newer. */
export function isNewerVersion(candidate: string, installed: string): boolean {
  const next = parseReleaseVersion(candidate);
  const current = parseReleaseVersion(installed);
  if (next === null || current === null) return false;
  for (let index = 0; index < 3; index += 1) {
    const a = next[index] ?? 0;
    const b = current[index] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}
