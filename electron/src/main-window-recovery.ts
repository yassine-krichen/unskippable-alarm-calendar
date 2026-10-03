/**
 * Backoff for a main window whose page failed to load or whose renderer died. The window is
 * hidden most of the time, and it is what syncs the schedule, so nobody would notice it dead.
 */

export const RELOAD_DELAYS_MS = [1_000, 5_000, 30_000, 300_000] as const;

export type RecoveryStep =
  | { action: 'reload'; delayMs: number }
  /** Reloading keeps failing: throw the window away and build a fresh one. */
  | { action: 'recreate'; delayMs: number };

/**
 * `failures` counts consecutive failures including the one just seen (1 on the first). Reloads
 * back off 1 s, 5 s, 30 s, 5 min; after that the window is recreated, again after the 5 min
 * maximum so a permanently broken page cannot spin.
 */
export function nextRecoveryStep(failures: number): RecoveryStep {
  const maxDelayMs = RELOAD_DELAYS_MS[RELOAD_DELAYS_MS.length - 1] ?? 300_000;
  if (failures > RELOAD_DELAYS_MS.length) return { action: 'recreate', delayMs: maxDelayMs };
  const delayMs = RELOAD_DELAYS_MS[Math.max(failures, 1) - 1] ?? maxDelayMs;
  return { action: 'reload', delayMs };
}
