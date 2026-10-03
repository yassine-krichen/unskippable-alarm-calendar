import { describe, expect, it, vi } from 'vitest';

import { createScheduleProblemReporter } from './schedule-problem';

describe('createScheduleProblemReporter', () => {
  it('shows the message once however many pushes fail', () => {
    const notify = vi.fn();
    const report = createScheduleProblemReporter(notify);
    report();
    report();
    report();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("Some alarms couldn't be scheduled on this PC");
  });

  it('keeps separate reporters independent', () => {
    const first = vi.fn();
    const second = vi.fn();
    createScheduleProblemReporter(first)();
    createScheduleProblemReporter(second)();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
