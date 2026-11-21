import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react';

/** How far a finger must travel sideways to count as a swipe, in CSS pixels. */
export const SWIPE_MIN_DISTANCE = 56;
/** The sideways travel must beat the vertical travel by this factor, so a scroll with a wobble is not a swipe. */
export const SWIPE_DOMINANCE = 1.5;

export type SwipeDirection = 'previous' | 'next';

/**
 * Whether a gesture from (0, 0) to (dx, dy) is a horizontal swipe, and which way. Swiping left (negative dx)
 * moves forward in time, like turning a page; right moves back.
 */
export function decideSwipe(dx: number, dy: number): SwipeDirection | null {
  if (Math.abs(dx) < SWIPE_MIN_DISTANCE) return null;
  if (Math.abs(dx) < Math.abs(dy) * SWIPE_DOMINANCE) return null;
  return dx < 0 ? 'next' : 'previous';
}

/** The parts of a pointer event the tracker reads, so it can be driven without a browser. */
export interface SwipePointer {
  pointerType: string;
  isPrimary: boolean;
  pointerId: number;
  clientX: number;
  clientY: number;
}

/** How long after a swipe a tap-like callback (FullCalendar's dateClick, a click) is still treated as part of it. */
export const SWIPE_AFTERMATH_MS = 400;

export interface SwipeTracker {
  down: (event: SwipePointer) => void;
  move: (event: SwipePointer) => void;
  up: (event: SwipePointer) => void;
  cancel: () => void;
  /**
   * True while a swipe is under way and for a moment after it. FullCalendar reports a tap (dateClick) at the end of
   * the same touch that made the swipe, and not as a click, so the page asks this before acting on a tap.
   */
  wasJustSwiped: () => boolean;
}

/**
 * The swipe logic without React: touch or pen only (a mouse drag never changes the period), one pointer at a time.
 * `now` is injectable for tests. The swipe is noted as soon as the movement qualifies, not only at the release,
 * because the tap callback of the calendar can run before this tracker sees the release.
 */
export function createSwipeTracker(onSwipe: (direction: SwipeDirection) => void, now: () => number = Date.now): SwipeTracker {
  let start: { x: number; y: number; id: number } | null = null;
  let swipedAt = Number.NEGATIVE_INFINITY;

  return {
    down(event) {
      if (event.pointerType === 'mouse' || !event.isPrimary) return;
      start = { x: event.clientX, y: event.clientY, id: event.pointerId };
    },
    move(event) {
      if (start === null || start.id !== event.pointerId) return;
      if (decideSwipe(event.clientX - start.x, event.clientY - start.y) !== null) swipedAt = now();
    },
    up(event) {
      const origin = start;
      start = null;
      if (origin === null || origin.id !== event.pointerId) return;
      const direction = decideSwipe(event.clientX - origin.x, event.clientY - origin.y);
      if (direction === null) return;
      swipedAt = now();
      onSwipe(direction);
    },
    cancel() {
      start = null;
    },
    wasJustSwiped() {
      return now() - swipedAt < SWIPE_AFTERMATH_MS;
    },
  };
}

/** Wraps a tap callback so it does nothing when the tap is the end of a swipe. */
export function ignoreAfterSwipe<Args extends unknown[]>(
  tracker: Pick<SwipeTracker, 'wasJustSwiped'>,
  callback: (...args: Args) => void
): (...args: Args) => void {
  return (...args) => {
    if (tracker.wasJustSwiped()) return;
    callback(...args);
  };
}

interface SwipeHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
  /** Swallows the click a finished swipe would otherwise send to whatever is under the finger. */
  onClickCapture: (event: { preventDefault: () => void; stopPropagation: () => void }) => void;
}

/**
 * Horizontal swipe on touch or pen, built on pointer events (no dependency). The element should set
 * `touch-action: pan-y` so the browser keeps the vertical scroll and leaves the horizontal movement to this hook.
 * `tracker.wasJustSwiped` is for the callbacks the swipe must not trigger (see {@link ignoreAfterSwipe}).
 */
export function useHorizontalSwipe(onSwipe: (direction: SwipeDirection) => void): { handlers: SwipeHandlers; tracker: SwipeTracker } {
  // One tracker for the life of the screen, so a re-render in the middle of a gesture does not lose it; it calls
  // whatever onSwipe is current.
  const latest = useRef(onSwipe);
  useEffect(() => {
    latest.current = onSwipe;
  });
  return useMemo(() => {
    const tracker = createSwipeTracker((direction) => latest.current(direction));
    const handlers: SwipeHandlers = {
      onPointerDown: (event) => tracker.down(event),
      onPointerMove: (event) => tracker.move(event),
      onPointerUp: (event) => tracker.up(event),
      onPointerCancel: () => tracker.cancel(),
      onClickCapture: (event) => {
        if (tracker.wasJustSwiped()) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
    };
    return { handlers, tracker };
  }, []);
}
