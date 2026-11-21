import { describe, expect, it, vi } from 'vitest';

import {
  SWIPE_AFTERMATH_MS,
  SWIPE_MIN_DISTANCE,
  createSwipeTracker,
  decideSwipe,
  ignoreAfterSwipe,
  type SwipePointer,
} from './use-horizontal-swipe';

describe('decideSwipe', () => {
  it('reads a leftward swipe as forward in time and a rightward one as back', () => {
    expect(decideSwipe(-120, 10)).toBe('next');
    expect(decideSwipe(120, -10)).toBe('previous');
  });

  it('ignores a movement shorter than the minimum distance', () => {
    expect(decideSwipe(-(SWIPE_MIN_DISTANCE - 1), 0)).toBeNull();
    expect(decideSwipe(SWIPE_MIN_DISTANCE - 1, 0)).toBeNull();
    expect(decideSwipe(-SWIPE_MIN_DISTANCE, 0)).toBe('next');
  });

  it('ignores a mostly vertical gesture, which is a scroll', () => {
    expect(decideSwipe(-80, 90)).toBeNull();
    expect(decideSwipe(80, -70)).toBeNull();
  });

  it('accepts a swipe with some vertical drift', () => {
    expect(decideSwipe(-120, 60)).toBe('next');
  });

  it('ignores a tap', () => {
    expect(decideSwipe(0, 0)).toBeNull();
  });
});

const touch = (x: number, y: number, overrides: Partial<SwipePointer> = {}): SwipePointer => ({
  pointerType: 'touch',
  isPrimary: true,
  pointerId: 1,
  clientX: x,
  clientY: y,
  ...overrides,
});

describe('createSwipeTracker', () => {
  function setup() {
    let clock = 1_000;
    const onSwipe = vi.fn();
    const tracker = createSwipeTracker(onSwipe, () => clock);
    return { tracker, onSwipe, advance: (ms: number) => (clock += ms) };
  }

  it('reports a swipe on release and says it just happened', () => {
    const { tracker, onSwipe } = setup();
    tracker.down(touch(200, 400));
    tracker.up(touch(60, 405));
    expect(onSwipe).toHaveBeenCalledWith('next');
    expect(tracker.wasJustSwiped()).toBe(true);
  });

  it('notes the swipe while the finger is still moving, before any release', () => {
    // FullCalendar can report the tap before this tracker sees the release.
    const { tracker, onSwipe } = setup();
    tracker.down(touch(200, 400));
    expect(tracker.wasJustSwiped()).toBe(false);
    tracker.move(touch(100, 402));
    expect(tracker.wasJustSwiped()).toBe(true);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('stops saying so after the aftermath window', () => {
    const { tracker, advance } = setup();
    tracker.down(touch(200, 400));
    tracker.up(touch(60, 400));
    advance(SWIPE_AFTERMATH_MS + 1);
    expect(tracker.wasJustSwiped()).toBe(false);
  });

  it('does not treat a tap, a scroll or a mouse drag as a swipe', () => {
    const { tracker, onSwipe } = setup();
    tracker.down(touch(200, 400));
    tracker.up(touch(203, 401));
    tracker.down(touch(200, 400));
    tracker.move(touch(215, 600));
    tracker.up(touch(215, 600));
    tracker.down(touch(300, 400, { pointerType: 'mouse' }));
    tracker.move(touch(100, 400, { pointerType: 'mouse' }));
    tracker.up(touch(100, 400, { pointerType: 'mouse' }));
    expect(onSwipe).not.toHaveBeenCalled();
    expect(tracker.wasJustSwiped()).toBe(false);
  });

  it('forgets a gesture the browser cancelled (a vertical scroll took it over)', () => {
    const { tracker, onSwipe } = setup();
    tracker.down(touch(200, 400));
    tracker.cancel();
    tracker.up(touch(40, 400));
    expect(onSwipe).not.toHaveBeenCalled();
  });
});

describe('ignoreAfterSwipe', () => {
  it('does not run the tap callback (new alarm, open a day) for the tap that ends a swipe', () => {
    let clock = 5_000;
    const tracker = createSwipeTracker(() => undefined, () => clock);
    const onCreate = vi.fn();
    const onPickDay = vi.fn();
    const create = ignoreAfterSwipe(tracker, onCreate);
    const pickDay = ignoreAfterSwipe(tracker, onPickDay);

    tracker.down(touch(300, 400));
    tracker.up(touch(100, 410));
    create({ date: '2026-11-21', time: '09:00' });
    pickDay('2026-11-21');
    expect(onCreate).not.toHaveBeenCalled();
    expect(onPickDay).not.toHaveBeenCalled();

    // A real tap later goes through, with its arguments.
    clock += SWIPE_AFTERMATH_MS + 1;
    create({ date: '2026-11-21', time: '10:00' });
    pickDay('2026-11-22');
    expect(onCreate).toHaveBeenCalledWith({ date: '2026-11-21', time: '10:00' });
    expect(onPickDay).toHaveBeenCalledWith('2026-11-22');
  });
});
