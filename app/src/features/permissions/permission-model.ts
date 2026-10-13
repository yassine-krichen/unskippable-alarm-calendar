import type { EnginePermissionStatus, PermissionKind } from '@/features/alarm-adapter/alarm-engine-plugin';

/**
 * 'check' is a HyperOS switch the OS would not tell us about ("unknown"). It is never shown as
 * denied and never nags on its own: the person is asked to look, not told they are wrong.
 */
export type PermissionState = 'granted' | 'denied' | 'check';

export type PermissionRowKind = Exclude<PermissionKind, 'appDetails'>;

export interface PermissionRow {
  kind: PermissionRowKind;
  state: PermissionState;
  /** Without it an alarm can fail to appear. The dialog cannot be closed while one of these is not granted. */
  required: boolean;
  title: string;
  /** One short line, in terms of what the person gets. */
  why: string;
}

interface RowCopy {
  title: string;
  why: string;
}

const COPY: Record<PermissionRowKind, RowCopy> = {
  notifications: {
    title: 'Notifications',
    why: 'So an alarm can reach you when the app is closed.',
  },
  fullScreenIntent: {
    title: 'Full-screen alarms',
    why: 'So the alarm can appear over your lock screen.',
  },
  exactAlarm: {
    title: 'Exact alarms',
    why: 'So alarms ring at the minute you set, not later.',
  },
  batteryOptimization: {
    title: 'Unrestricted battery',
    why: "So the system doesn't put the app to sleep before an alarm.",
  },
  autostart: {
    title: 'Autostart',
    why: 'So alarms come back after the phone restarts.',
  },
  lockScreen: {
    title: 'Show on lock screen',
    why: 'So the alarm screen can open while the phone is locked.',
  },
  backgroundPopup: {
    title: 'Pop-ups while in the background',
    why: 'So the alarm screen can open while you use another app.',
  },
};

function fromFlag(granted: boolean): PermissionState {
  return granted ? 'granted' : 'denied';
}

function fromDetail(value: string): PermissionState | null {
  if (value === 'granted') return 'granted';
  if (value === 'denied') return 'denied';
  if (value === 'unknown') return 'check';
  // 'notApplicable' (not a Xiaomi phone), or anything a newer engine might say: nothing to show.
  return null;
}

function row(kind: PermissionRowKind, state: PermissionState, required: boolean): PermissionRow {
  return { kind, state, required, ...COPY[kind] };
}

/**
 * The rows for what the engine reported, required ones first. Notifications and full-screen alarms
 * are required (decisions.md: without notifications there is no full-screen intent, and on a phone
 * that blocks background starts the alarm screen then never comes up). The rest only make the
 * alarm more reliable. The three HyperOS switches exist only on a Xiaomi phone.
 */
export function buildPermissionRows(status: EnginePermissionStatus): PermissionRow[] {
  const rows: PermissionRow[] = [
    row('notifications', fromFlag(status.notifications), true),
    row('fullScreenIntent', fromFlag(status.fullScreenIntent), true),
    row('exactAlarm', fromFlag(status.exactAlarm), false),
    row('batteryOptimization', fromFlag(status.batteryOptimizationExempt), false),
  ];
  if (status.details.xiaomi) {
    for (const kind of ['autostart', 'lockScreen', 'backgroundPopup'] as const) {
      const state = fromDetail(status.details[kind]);
      if (state !== null) rows.push(row(kind, state, false));
    }
  }
  return rows;
}

export interface PermissionSummary {
  rows: PermissionRow[];
  /** A required permission is missing: the dialog stays until it is granted. */
  blocking: boolean;
  /** Something is definitely not allowed (required or not): the dialog opens and the warning chip shows. */
  needsAttention: boolean;
  /** Rows that are definitely denied, required first: what the chip counts. */
  deniedCount: number;
}

export function summarizePermissions(status: EnginePermissionStatus): PermissionSummary {
  const rows = buildPermissionRows(status);
  const denied = rows.filter((candidate) => candidate.state === 'denied');
  return {
    rows,
    blocking: denied.some((candidate) => candidate.required),
    needsAttention: denied.length > 0,
    deniedCount: denied.length,
  };
}
