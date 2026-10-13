import { create } from 'zustand';

import { AlarmEngine, type EnginePermissionStatus, type PermissionKind } from '@/features/alarm-adapter/alarm-engine-plugin';
import { detectPlatform } from '@/lib/platform';

import { summarizePermissions, type PermissionSummary } from './permission-model';

interface PermissionsState {
  summary: PermissionSummary | null;
  /** When "Remind me later" was pressed; null when it was not. Only an optional-only dialog can be put off. */
  dismissedAt: number | null;
}

export const usePermissionsStore = create<PermissionsState>(() => ({ summary: null, dismissedAt: null }));

/**
 * How long "Remind me later" holds across resumes. A launch always asks again, and a missing required
 * permission always blocks; but the alarm screen's Done returns to the app, and asking about battery
 * settings after every alarm would be nagging.
 */
export const REMIND_LATER_MS = 60 * 60 * 1000;

export function isDialogOpen(state: PermissionsState): boolean {
  const { summary, dismissedAt } = state;
  if (summary === null || !summary.needsAttention) return false;
  return summary.blocking || dismissedAt === null;
}

/** 'launch' asks again at once, 'resume' once the reminder has aged, 'refresh' never changes the choice. */
export type PermissionCheckReason = 'launch' | 'resume' | 'refresh';

function keepDismissal(reason: PermissionCheckReason, dismissedAt: number | null, now: number): number | null {
  if (reason === 'launch') return null;
  if (reason === 'resume' && dismissedAt !== null && now - dismissedAt >= REMIND_LATER_MS) return null;
  return dismissedAt;
}

let latestRead = 0;

/** Reads the permissions from the engine. Android only; elsewhere nothing is shown. */
export async function checkPermissions(reason: PermissionCheckReason): Promise<void> {
  if (detectPlatform() !== 'android') return;
  const read = ++latestRead;
  let status: EnginePermissionStatus;
  try {
    status = await AlarmEngine.getPermissionStatus();
  } catch (error) {
    // Keep what was known; the next resume asks again.
    console.warn('Could not read the alarm permissions:', error instanceof Error ? error.message : 'unknown');
    return;
  }
  if (read !== latestRead) return;
  usePermissionsStore.setState((state) => ({
    summary: summarizePermissions(status),
    dismissedAt: keepDismissal(reason, state.dismissedAt, Date.now()),
  }));
}

export function dismissPermissionDialog(): void {
  usePermissionsStore.setState({ dismissedAt: Date.now() });
}

export function showPermissionDialog(): void {
  usePermissionsStore.setState({ dismissedAt: null });
}

/** Opens the system screen where `kind` is granted; the app re-checks when it comes back. */
export async function openPermissionScreen(kind: PermissionKind): Promise<string | null> {
  try {
    await AlarmEngine.openPermissionSettings({ kind });
    return null;
  } catch {
    return "Couldn't open that settings screen. Open this app's settings from your phone's Settings app.";
  }
}
