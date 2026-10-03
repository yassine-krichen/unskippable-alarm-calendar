import { describe, expect, it } from 'vitest';

import { createLatestRequestGuard } from './latest-request';

describe('createLatestRequestGuard', () => {
  it('only the newest ticket is current', () => {
    const guard = createLatestRequestGuard();
    const first = guard.begin();
    const second = guard.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it('invalidate makes every earlier ticket stale', () => {
    const guard = createLatestRequestGuard();
    const ticket = guard.begin();
    guard.invalidate();
    expect(ticket()).toBe(false);
  });

  it('a ticket taken after invalidate is current', () => {
    const guard = createLatestRequestGuard();
    guard.invalidate();
    expect(guard.begin()()).toBe(true);
  });
});
