import { describe, expect, it } from 'vitest';

import { nextRecoveryStep, RELOAD_DELAYS_MS } from './main-window-recovery';

describe('nextRecoveryStep', () => {
  it('reloads after 1 s, 5 s, 30 s and 5 min on the first four failures', () => {
    expect([1, 2, 3, 4].map((failures) => nextRecoveryStep(failures))).toEqual([
      { action: 'reload', delayMs: 1_000 },
      { action: 'reload', delayMs: 5_000 },
      { action: 'reload', delayMs: 30_000 },
      { action: 'reload', delayMs: 300_000 },
    ]);
  });

  it('recreates the window once reloading keeps failing, never faster than the maximum delay', () => {
    for (const failures of [5, 6, 50]) {
      expect(nextRecoveryStep(failures)).toEqual({ action: 'recreate', delayMs: 300_000 });
    }
  });

  it('never waits more than 5 minutes and never less than a second', () => {
    for (let failures = 0; failures < 20; failures++) {
      const { delayMs } = nextRecoveryStep(failures);
      expect(delayMs).toBeGreaterThanOrEqual(1_000);
      expect(delayMs).toBeLessThanOrEqual(300_000);
    }
  });

  it('delays only grow', () => {
    expect([...RELOAD_DELAYS_MS]).toEqual([...RELOAD_DELAYS_MS].sort((a, b) => a - b));
  });
});
