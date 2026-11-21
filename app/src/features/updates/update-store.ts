import { isNewerVersion } from '@alarm-calendar/core';
import { create } from 'zustand';

import { AppUpdate, type AppUpdateErrorCode, type AppUpdatePlugin, type UpdateProgress } from './app-update-plugin';
import {
  isAutoCheckDue,
  readCheckRecord,
  readDismissedVersion,
  recordCheckFailure,
  writeCheckRecord,
  writeDismissedVersion,
} from './check-record';
import { requireSha256, type ReleaseInfo } from './github-release';
import type { UpdateSource } from './update-sources';

export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready';

interface UpdateState {
  phase: UpdatePhase;
  /** The version this build is; null until the shell has answered. */
  installedVersion: string | null;
  /** The newest published release, only while it is newer than the installed version. */
  latest: ReleaseInfo | null;
  /** When the last check finished (any outcome that reached GitHub), epoch ms. */
  checkedAt: number | null;
  /** True after a check that completed and found nothing newer; drives "You're up to date". */
  upToDate: boolean;
  progress: UpdateProgress | null;
  /** A message for the person, set by a failed check, download or install; cleared by the next action. */
  error: string | null;
  /** The install-unknown-apps switch was off when Install was pressed; the app continues when it comes back. */
  waitingForInstallPermission: boolean;
  /** The version whose banner was dismissed on this device. */
  dismissedVersion: string | null;
}

export const useUpdateStore = create<UpdateState>(() => ({
  phase: 'idle',
  installedVersion: null,
  latest: null,
  checkedAt: null,
  upToDate: false,
  progress: null,
  error: null,
  waitingForInstallPermission: false,
  dismissedVersion: null,
}));

/** True while there is a newer release the person has not been told about. Drives the dot and the banner. */
export function isBannerVisible(state: Pick<UpdateState, 'latest' | 'dismissedVersion'>): boolean {
  return state.latest !== null && state.latest.version !== state.dismissedVersion;
}

function newerOrNull(release: ReleaseInfo | null, installed: string | null): ReleaseInfo | null {
  return release !== null && installed !== null && isNewerVersion(release.version, installed) ? release : null;
}

/** Reads the installed version and what the last check left behind, so the banner survives a restart. */
export async function loadUpdateState(source: UpdateSource): Promise<void> {
  let installed: string;
  try {
    installed = await source.installedVersion();
  } catch {
    return;
  }
  const record = readCheckRecord();
  useUpdateStore.setState({
    installedVersion: installed,
    latest: newerOrNull(record?.release ?? null, installed),
    checkedAt: record?.checkedAt ?? null,
    dismissedVersion: readDismissedVersion(),
  });
}

/** The automatic check: runs only when 24 hours have passed since the last one. Returns whether it ran. */
export async function runAutoUpdateCheck(source: UpdateSource, now: number = Date.now()): Promise<boolean> {
  if (useUpdateStore.getState().phase !== 'idle' || !isAutoCheckDue(readCheckRecord(), now)) return false;
  await checkForUpdates(source, false);
  return true;
}

/**
 * Asks the source whether a newer release exists. `manual` is the "Check now" button: it reports problems and
 * "up to date" to the person, where an automatic check stays quiet about both.
 */
export async function checkForUpdates(source: UpdateSource, manual: boolean): Promise<void> {
  if (useUpdateStore.getState().phase !== 'idle') return;
  useUpdateStore.setState({ phase: 'checking', error: manual ? null : useUpdateStore.getState().error });
  try {
    let installed = useUpdateStore.getState().installedVersion;
    if (installed === null) {
      installed = await source.installedVersion();
      useUpdateStore.setState({ installedVersion: installed });
    }
    const prior = readCheckRecord();
    const result = await source.check(prior);
    if (result.kind === 'error') {
      // The failure is remembered so an automatic check does not retry at every resume (see isAutoCheckDue).
      recordCheckFailure(prior, Date.now());
      useUpdateStore.setState({ error: manual ? checkErrorMessage(result.reason) : null });
      return;
    }
    const now = Date.now();
    writeCheckRecord({ checkedAt: now, etag: result.etag, release: result.release, lastFailureAt: null });
    const latest = newerOrNull(result.release, installed);
    useUpdateStore.setState({ latest, checkedAt: now, upToDate: latest === null, error: null });
  } catch {
    recordCheckFailure(readCheckRecord(), Date.now());
    useUpdateStore.setState({ error: manual ? checkErrorMessage('offline') : null });
  } finally {
    useUpdateStore.setState({ phase: 'idle' });
  }
}

export function checkErrorMessage(reason: 'offline' | 'rate-limited' | 'invalid' | 'unsupported'): string {
  switch (reason) {
    case 'rate-limited':
      return 'GitHub is limiting checks from this network right now. Try again later.';
    case 'invalid':
      return "GitHub's answer could not be read. Try again later.";
    case 'unsupported':
      return 'Update checks only work in the installed app.';
    case 'offline':
      return "Couldn't reach GitHub. Check your connection and try again.";
  }
}

/** The text for a failure code of the Android plugin. */
export function installErrorMessage(code: string | null): string {
  switch (code as AppUpdateErrorCode | null) {
    case 'ALARM_ACTIVE':
      return 'An alarm is ringing or snoozed. Finish it, then install the update.';
    case 'HASH_MISMATCH':
      return 'The download did not match its checksum, so it was deleted. Try again.';
    case 'BAD_PACKAGE':
      return "This file can't update the installed app (it is not newer, or is signed with a different key). See docs/releasing.md.";
    case 'URL_REFUSED':
    case 'TOO_LARGE':
      return 'The download was refused because it did not look safe.';
    case 'BUSY':
      return 'A download is already running.';
    case 'NETWORK':
      return 'The download failed. Check your connection and try again.';
    default:
      return 'The update could not be installed. Try again.';
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : null;
}

/** What the Android download and install need; the real plugin unless a test passes its own. */
export interface DownloadDeps {
  plugin: AppUpdatePlugin;
}

const realDeps = (): DownloadDeps => ({ plugin: AppUpdate });

/**
 * Android, on load: if a verified copy of the newest release is still in the cache (the app was killed after the
 * download, for instance while the "install unknown apps" screen was open), go straight back to `ready`. The plugin
 * hashes the file again against the release digest and re-runs its package and signer checks.
 */
export async function restoreDownloadedUpdate(deps: DownloadDeps = realDeps()): Promise<void> {
  const { latest, phase } = useUpdateStore.getState();
  const sha256 = latest?.android?.sha256 ?? null;
  if (phase !== 'idle' || latest === null || sha256 === null) return;
  try {
    const { downloaded } = await deps.plugin.downloaded({ versionName: latest.version, sha256 });
    // Anything that started meanwhile (a check, a new download) wins over a restore.
    if (downloaded && useUpdateStore.getState().phase === 'idle' && useUpdateStore.getState().latest === latest) {
      useUpdateStore.setState({ phase: 'ready' });
    }
  } catch {
    // Nothing usable cached: the person can download again.
  }
}

/** Android: downloads the newest release's APK (progress in the store) and verifies it. Ends in phase `ready`. */
export async function downloadUpdate(deps: DownloadDeps = realDeps()): Promise<void> {
  const { latest, phase } = useUpdateStore.getState();
  if (phase !== 'idle' || latest === null) return;
  const asset = latest.android;
  if (asset === null) {
    useUpdateStore.setState({ error: 'This release has no Android download.' });
    return;
  }
  useUpdateStore.setState({ phase: 'downloading', error: null, progress: { received: 0, total: asset.sizeBytes } });
  let listener: { remove(): Promise<void> } | null = null;
  try {
    const sha256 = requireSha256(asset);
    if (sha256.error !== null) {
      useUpdateStore.setState({ phase: 'idle', progress: null, error: sha256.error });
      return;
    }
    listener = await deps.plugin.addListener('updateProgress', (progress) => {
      useUpdateStore.setState({ progress: { received: progress.received, total: progress.total || asset.sizeBytes } });
    });
    await deps.plugin.download({ url: asset.url, sha256: sha256.data, versionName: latest.version });
    useUpdateStore.setState({ phase: 'ready', error: null });
  } catch (error) {
    useUpdateStore.setState({ phase: 'idle', progress: null, error: installErrorMessage(errorCode(error)) });
  } finally {
    void listener?.remove();
  }
}

/**
 * Android: hands the downloaded APK to the system installer, which asks the person to confirm. When the
 * "install unknown apps" switch is still off it opens that screen and waits; [continueAfterPermission] finishes
 * the job when the app comes back.
 */
export async function installUpdate(deps: Pick<DownloadDeps, 'plugin'> = realDeps()): Promise<void> {
  const { latest, phase } = useUpdateStore.getState();
  if (phase !== 'ready' || latest === null) return;
  try {
    const { allowed } = await deps.plugin.canInstall();
    if (!allowed) {
      useUpdateStore.setState({ waitingForInstallPermission: true, error: null });
      await deps.plugin.openInstallPermission();
      return;
    }
    useUpdateStore.setState({ waitingForInstallPermission: false, error: null });
    await deps.plugin.install({ versionName: latest.version });
  } catch (error) {
    useUpdateStore.setState({ waitingForInstallPermission: false, error: installErrorMessage(errorCode(error)) });
  }
}

/** Called when the app returns to the front: if Install was waiting on the permission screen, carry on. */
export async function continueAfterPermission(deps: Pick<DownloadDeps, 'plugin'> = realDeps()): Promise<void> {
  if (!useUpdateStore.getState().waitingForInstallPermission) return;
  const { allowed } = await deps.plugin.canInstall().catch(() => ({ allowed: false }));
  if (allowed) await installUpdate(deps);
  else useUpdateStore.setState({ waitingForInstallPermission: false });
}

/** Hides the banner for this version on this device; a newer version shows it again. */
export function dismissUpdateBanner(): void {
  const latest = useUpdateStore.getState().latest;
  if (latest === null) return;
  writeDismissedVersion(latest.version);
  useUpdateStore.setState({ dismissedVersion: latest.version });
}
