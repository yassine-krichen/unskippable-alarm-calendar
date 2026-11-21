import { describe, expect, it } from 'vitest';

import {
  LATEST_RELEASE_API_URL,
  LATEST_RELEASE_PAGE_URL,
  RELEASE_ASSET_URL_PREFIX,
  isNewerVersion,
  normalizeReleaseVersion,
  parseReleaseVersion,
} from './releases';

describe('parseReleaseVersion', () => {
  it('reads a tag with or without the leading v', () => {
    expect(parseReleaseVersion('v0.2.1')).toEqual([0, 2, 1]);
    expect(parseReleaseVersion('1.10.0')).toEqual([1, 10, 0]);
  });

  it('ignores a prerelease or build suffix', () => {
    expect(parseReleaseVersion('v0.3.0-beta.1')).toEqual([0, 3, 0]);
    expect(parseReleaseVersion('0.3.0+build5')).toEqual([0, 3, 0]);
  });

  it('refuses text that is not a version', () => {
    expect(parseReleaseVersion('latest')).toBeNull();
    expect(parseReleaseVersion('1.2')).toBeNull();
    expect(parseReleaseVersion('1.2.3.4')).toBeNull();
    expect(parseReleaseVersion('')).toBeNull();
  });
});

describe('normalizeReleaseVersion', () => {
  it('drops the v and any suffix', () => {
    expect(normalizeReleaseVersion('v0.2.1-rc.1')).toBe('0.2.1');
    expect(normalizeReleaseVersion('nope')).toBeNull();
  });
});

describe('isNewerVersion', () => {
  it('compares numerically, not as text', () => {
    expect(isNewerVersion('0.10.0', '0.9.0')).toBe(true);
    expect(isNewerVersion('v1.0.0', '0.99.99')).toBe(true);
    expect(isNewerVersion('0.2.1', '0.2.0')).toBe(true);
  });

  it('is false for the same or an older version', () => {
    expect(isNewerVersion('0.2.0', '0.2.0')).toBe(false);
    expect(isNewerVersion('v0.2.0', '0.2.0')).toBe(false);
    expect(isNewerVersion('0.1.9', '0.2.0')).toBe(false);
  });

  it('treats a prerelease tag as its base version', () => {
    expect(isNewerVersion('0.2.0-beta.1', '0.2.0')).toBe(false);
    expect(isNewerVersion('0.3.0-beta.1', '0.2.0')).toBe(true);
  });

  it('is false when either side is not a version', () => {
    expect(isNewerVersion('latest', '0.2.0')).toBe(false);
    expect(isNewerVersion('0.3.0', 'dev')).toBe(false);
  });
});

describe('release addresses', () => {
  it('point at the one repository and nowhere else', () => {
    expect(LATEST_RELEASE_API_URL).toBe(
      'https://api.github.com/repos/yassine-krichen/unskippable-alarm-calendar/releases/latest'
    );
    expect(LATEST_RELEASE_PAGE_URL).toBe('https://github.com/yassine-krichen/unskippable-alarm-calendar/releases/latest');
    expect(RELEASE_ASSET_URL_PREFIX).toBe('https://github.com/yassine-krichen/unskippable-alarm-calendar/releases/download/');
  });
});
