import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppUpdatePlugin } from './app-update-plugin';
import { AUTO_CHECK_INTERVAL_MS, FAILURE_RETRY_INTERVAL_MS, readCheckRecord } from './check-record';
import type { ReleaseInfo } from './github-release';
import type { SourceCheck, UpdateSource } from './update-sources';
import {
  checkForUpdates,
  continueAfterPermission,
  dismissUpdateBanner,
  downloadUpdate,
  installErrorMessage,
  installUpdate,
  isBannerVisible,
  loadUpdateState,
  restoreDownloadedUpdate,
  runAutoUpdateCheck,
  useUpdateStore,
} from './update-store';

const HASH = 'ab'.repeat(32);
const NOW = 1_800_000_000_000;

const release = (version: string, withApk = true): ReleaseInfo => ({
  version,
  notes: 'Notes',
  htmlUrl: 'https://github.com/yassine-krichen/unskippable-alarm-calendar/releases/tag/v' + version,
  android: withApk
    ? {
        name: `Alarm-Calendar-${version}.apk`,
        url: `https://github.com/yassine-krichen/unskippable-alarm-calendar/releases/download/v${version}/Alarm-Calendar-${version}.apk`,
        sizeBytes: 5_000_000,
        sha256: HASH,
      }
    : null,
});

function source(installed: string, answers: SourceCheck[]): UpdateSource & { checks: number } {
  const state = { checks: 0 };
  return {
    platform: 'android',
    installedVersion: async () => installed,
    check: async () => {
      const answer = answers[Math.min(state.checks, answers.length - 1)];
      state.checks += 1;
      if (answer === undefined) throw new Error('no answer');
      return answer;
    },
    get checks() {
      return state.checks;
    },
  };
}

function fakePlugin(overrides: Partial<AppUpdatePlugin> = {}): AppUpdatePlugin & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    download: async (options) => {
      calls.push(`download ${options.versionName} ${options.sha256}`);
      return { versionName: options.versionName, sizeBytes: 1 };
    },
    downloaded: async (options) => {
      calls.push(`downloaded ${options.versionName} ${options.sha256}`);
      return { downloaded: true, sizeBytes: 1 };
    },
    canInstall: async () => ({ allowed: true }),
    openInstallPermission: async () => {
      calls.push('openInstallPermission');
    },
    install: async (options) => {
      calls.push(`install ${options.versionName}`);
      return { started: true };
    },
    addListener: async () => ({ remove: async () => undefined }),
    ...overrides,
  };
}

function stubStorage(): Map<string, string> {
  const data = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    },
  });
  return data;
}

beforeEach(() => {
  stubStorage();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  useUpdateStore.setState({
    phase: 'idle',
    installedVersion: null,
    latest: null,
    checkedAt: null,
    upToDate: false,
    progress: null,
    error: null,
    waitingForInstallPermission: false,
    dismissedVersion: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('checkForUpdates', () => {
  it('records a newer release as available and remembers the check', async () => {
    await checkForUpdates(source('0.2.0', [{ kind: 'checked', release: release('0.3.0'), etag: '"e"' }]), false);
    const state = useUpdateStore.getState();
    expect(state.latest?.version).toBe('0.3.0');
    expect(state.phase).toBe('idle');
    expect(readCheckRecord()?.etag).toBe('"e"');
    expect(readCheckRecord()?.checkedAt).toBe(NOW);
  });

  it('is up to date when the release is not newer, and says so', async () => {
    await checkForUpdates(source('0.2.0', [{ kind: 'checked', release: release('0.2.0'), etag: null }]), true);
    expect(useUpdateStore.getState().latest).toBeNull();
    expect(useUpdateStore.getState().upToDate).toBe(true);
  });

  it('stays quiet about a failed automatic check but reports a failed manual one', async () => {
    const failing = source('0.2.0', [{ kind: 'error', reason: 'offline' }]);
    await checkForUpdates(failing, false);
    expect(useUpdateStore.getState().error).toBeNull();
    await checkForUpdates(failing, true);
    expect(useUpdateStore.getState().error).toMatch(/Couldn't reach GitHub/);
    // only the failure is remembered: no good check happened
    expect(readCheckRecord()).toMatchObject({ checkedAt: null, release: null, lastFailureAt: NOW });
  });

  it('survives a source that throws', async () => {
    const throwing: UpdateSource = {
      platform: 'android',
      installedVersion: async () => '0.2.0',
      check: async () => {
        throw new Error('boom');
      },
    };
    await checkForUpdates(throwing, true);
    expect(useUpdateStore.getState().phase).toBe('idle');
    expect(useUpdateStore.getState().error).not.toBeNull();
  });
});

describe('runAutoUpdateCheck', () => {
  it('checks once, then not again for 24 hours', async () => {
    const found = source('0.2.0', [{ kind: 'checked', release: null, etag: null }]);
    expect(await runAutoUpdateCheck(found, NOW)).toBe(true);
    expect(await runAutoUpdateCheck(found, NOW + AUTO_CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(found.checks).toBe(1);
    expect(await runAutoUpdateCheck(found, NOW + AUTO_CHECK_INTERVAL_MS)).toBe(true);
    expect(found.checks).toBe(2);
  });

  it('does not start while another check or a download is running', async () => {
    useUpdateStore.setState({ phase: 'downloading' });
    const idle = source('0.2.0', [{ kind: 'checked', release: null, etag: null }]);
    expect(await runAutoUpdateCheck(idle, NOW)).toBe(false);
    expect(idle.checks).toBe(0);
  });

  it('a failed check does not use up the 24 hours, but is not retried for an hour', async () => {
    const failing = source('0.2.0', [{ kind: 'error', reason: 'offline' }]);
    expect(await runAutoUpdateCheck(failing, NOW)).toBe(true);
    expect(readCheckRecord()?.lastFailureAt).toBe(NOW);
    expect(readCheckRecord()?.checkedAt).toBeNull();
    expect(await runAutoUpdateCheck(failing, NOW + 60_000)).toBe(false);
    expect(await runAutoUpdateCheck(failing, NOW + FAILURE_RETRY_INTERVAL_MS - 1)).toBe(false);
    expect(failing.checks).toBe(1);
    expect(await runAutoUpdateCheck(failing, NOW + FAILURE_RETRY_INTERVAL_MS)).toBe(true);
    expect(failing.checks).toBe(2);
  });

  it('a failure after a good check keeps what that check found and its 24 hours', async () => {
    const answers: SourceCheck[] = [
      { kind: 'checked', release: release('0.3.0'), etag: '"e"' },
      { kind: 'error', reason: 'rate-limited' },
    ];
    const flaky = source('0.2.0', answers);
    await runAutoUpdateCheck(flaky, NOW);
    // a manual check (always allowed) fails
    await checkForUpdates(flaky, true);
    const kept = readCheckRecord();
    expect(kept?.release?.version).toBe('0.3.0');
    expect(kept?.etag).toBe('"e"');
    expect(kept?.checkedAt).toBe(NOW);
    expect(kept?.lastFailureAt).toBe(NOW);
  });

  it('Check now ignores the back-off and a success clears it', async () => {
    const answers: SourceCheck[] = [{ kind: 'error', reason: 'offline' }, { kind: 'checked', release: null, etag: null }];
    const flaky = source('0.2.0', answers);
    await runAutoUpdateCheck(flaky, NOW);
    expect(await runAutoUpdateCheck(flaky, NOW + 60_000)).toBe(false);
    await checkForUpdates(flaky, true);
    expect(flaky.checks).toBe(2);
    expect(useUpdateStore.getState().upToDate).toBe(true);
    expect(readCheckRecord()?.lastFailureAt).toBeNull();
  });

  it('applies to the desktop source the same way (its failures come back as error results)', async () => {
    const desktop: UpdateSource = {
      platform: 'electron',
      installedVersion: async () => '0.2.0',
      check: async () => ({ kind: 'error', reason: 'offline' }),
    };
    await runAutoUpdateCheck(desktop, NOW);
    expect(await runAutoUpdateCheck(desktop, NOW + 60_000)).toBe(false);
  });
});

describe('restoreDownloadedUpdate', () => {
  it('goes back to ready when the plugin still holds a verified copy of the newest release', async () => {
    useUpdateStore.setState({ latest: release('0.3.0') });
    const plugin = fakePlugin();
    await restoreDownloadedUpdate({ plugin });
    expect(useUpdateStore.getState().phase).toBe('ready');
    expect(plugin.calls).toEqual([`downloaded 0.3.0 ${HASH}`]);
  });

  it('stays idle when the cached copy is gone or failed its checks', async () => {
    useUpdateStore.setState({ latest: release('0.3.0') });
    await restoreDownloadedUpdate({ plugin: fakePlugin({ downloaded: async () => ({ downloaded: false, sizeBytes: 0 }) }) });
    expect(useUpdateStore.getState().phase).toBe('idle');
    await restoreDownloadedUpdate({
      plugin: fakePlugin({
        downloaded: async () => {
          throw new Error('boom');
        },
      }),
    });
    expect(useUpdateStore.getState().phase).toBe('idle');
  });

  it('does nothing without a newer release or without a digest to verify against', async () => {
    const plugin = fakePlugin();
    await restoreDownloadedUpdate({ plugin });
    const noHash = release('0.3.0');
    if (noHash.android !== null) noHash.android = { ...noHash.android, sha256: null };
    useUpdateStore.setState({ latest: noHash });
    await restoreDownloadedUpdate({ plugin });
    expect(plugin.calls).toEqual([]);
  });

  it('lets Install carry on after a restore (the app was killed on the permission screen)', async () => {
    useUpdateStore.setState({ latest: release('0.3.0') });
    const plugin = fakePlugin();
    await restoreDownloadedUpdate({ plugin });
    await installUpdate({ plugin });
    expect(plugin.calls).toContain('install 0.3.0');
  });
});

describe('loadUpdateState', () => {
  it('brings the banner back after a restart inside the 24 hours', async () => {
    await checkForUpdates(source('0.2.0', [{ kind: 'checked', release: release('0.3.0'), etag: null }]), false);
    useUpdateStore.setState({ latest: null, installedVersion: null });
    await loadUpdateState(source('0.2.0', []));
    expect(useUpdateStore.getState().latest?.version).toBe('0.3.0');
  });

  it('drops a remembered release once the app has been updated to it', async () => {
    await checkForUpdates(source('0.2.0', [{ kind: 'checked', release: release('0.3.0'), etag: null }]), false);
    await loadUpdateState(source('0.3.0', []));
    expect(useUpdateStore.getState().latest).toBeNull();
  });
});

describe('the banner', () => {
  it('stays hidden after dismissing for that version and returns for a newer one', async () => {
    await checkForUpdates(source('0.2.0', [{ kind: 'checked', release: release('0.3.0'), etag: null }]), false);
    expect(isBannerVisible(useUpdateStore.getState())).toBe(true);
    dismissUpdateBanner();
    expect(isBannerVisible(useUpdateStore.getState())).toBe(false);
    useUpdateStore.setState({ latest: release('0.3.1') });
    expect(isBannerVisible(useUpdateStore.getState())).toBe(true);
  });
});

describe('downloadUpdate and installUpdate', () => {
  it('downloads with the verified hash, ends ready, then installs that version', async () => {
    useUpdateStore.setState({ latest: release('0.3.0') });
    const plugin = fakePlugin();
    await downloadUpdate({ plugin });
    expect(plugin.calls).toEqual([`download 0.3.0 ${HASH}`]);
    expect(useUpdateStore.getState().phase).toBe('ready');

    await installUpdate({ plugin });
    expect(plugin.calls).toContain('install 0.3.0');
  });

  it('shows a readable message and returns to idle when the hash does not match', async () => {
    useUpdateStore.setState({ latest: release('0.3.0') });
    const plugin = fakePlugin({
      download: async () => {
        throw Object.assign(new Error('x'), { code: 'HASH_MISMATCH' });
      },
    });
    await downloadUpdate({ plugin });
    expect(useUpdateStore.getState().phase).toBe('idle');
    expect(useUpdateStore.getState().error).toMatch(/checksum/);
  });

  it('does not download a release without an Android file', async () => {
    useUpdateStore.setState({ latest: release('0.3.0', false) });
    const plugin = fakePlugin();
    await downloadUpdate({ plugin });
    expect(plugin.calls).toEqual([]);
    expect(useUpdateStore.getState().error).toMatch(/no Android download/);
  });

  it('does not download without a checksum', async () => {
    const noHash = release('0.3.0');
    if (noHash.android !== null) noHash.android = { ...noHash.android, sha256: null };
    useUpdateStore.setState({ latest: noHash });
    const plugin = fakePlugin();
    await downloadUpdate({ plugin });
    expect(plugin.calls).toEqual([]);
    expect(useUpdateStore.getState().error).toMatch(/no checksum/);
  });

  it('opens the unknown-apps screen first when installing is not allowed, and finishes when the app returns', async () => {
    useUpdateStore.setState({ latest: release('0.3.0'), phase: 'ready' });
    let allowed = false;
    const plugin = fakePlugin({ canInstall: async () => ({ allowed }) });

    await installUpdate({ plugin });
    expect(plugin.calls).toEqual(['openInstallPermission']);
    expect(useUpdateStore.getState().waitingForInstallPermission).toBe(true);

    // back from the screen without allowing: nothing installs, the wait ends
    await continueAfterPermission({ plugin });
    expect(plugin.calls).toEqual(['openInstallPermission']);
    expect(useUpdateStore.getState().waitingForInstallPermission).toBe(false);

    // again, this time allowed
    await installUpdate({ plugin });
    allowed = true;
    await continueAfterPermission({ plugin });
    expect(plugin.calls).toContain('install 0.3.0');
    expect(useUpdateStore.getState().waitingForInstallPermission).toBe(false);
  });

  it('reports a refused install while an alarm is active', async () => {
    useUpdateStore.setState({ latest: release('0.3.0'), phase: 'ready' });
    const plugin = fakePlugin({
      install: async () => {
        throw Object.assign(new Error('x'), { code: 'ALARM_ACTIVE' });
      },
    });
    await installUpdate({ plugin });
    expect(useUpdateStore.getState().error).toMatch(/alarm is ringing or snoozed/);
  });

  it('does nothing when continueAfterPermission was not waiting', async () => {
    const plugin = fakePlugin();
    await continueAfterPermission({ plugin });
    expect(plugin.calls).toEqual([]);
  });
});

describe('installErrorMessage', () => {
  it('has a plain sentence for every code and a fallback', () => {
    for (const code of ['ALARM_ACTIVE', 'HASH_MISMATCH', 'BAD_PACKAGE', 'URL_REFUSED', 'TOO_LARGE', 'BUSY', 'NETWORK']) {
      expect(installErrorMessage(code).length).toBeGreaterThan(10);
    }
    expect(installErrorMessage(null)).toMatch(/could not be installed/);
    expect(installErrorMessage('SOMETHING_NEW')).toMatch(/could not be installed/);
  });
});
