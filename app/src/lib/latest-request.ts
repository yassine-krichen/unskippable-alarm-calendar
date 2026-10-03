/**
 * Guards a loader against out-of-order responses. Each request takes a ticket with begin();
 * its response may be applied only while isLatest() still says so. A newer request, or any
 * other write to the same state (invalidate), makes older tickets stale, so a slow response
 * can never overwrite fresher data.
 */
export interface LatestRequestGuard {
  begin(): () => boolean;
  invalidate(): void;
}

export function createLatestRequestGuard(): LatestRequestGuard {
  let latest = 0;
  return {
    begin() {
      const ticket = ++latest;
      return () => ticket === latest;
    },
    invalidate() {
      latest++;
    },
  };
}
