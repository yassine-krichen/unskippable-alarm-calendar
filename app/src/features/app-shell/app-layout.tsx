import { useState, type CSSProperties } from 'react';
import { Outlet, useLocation } from 'react-router';

import { useIsPhoneLayout } from '@/hooks/use-media-query';

import { BottomTabBar } from './bottom-tab-bar';
import { showsTabBar } from './nav-items';

/**
 * The frame around every signed-in screen. On the desktop layout it is just the screen. On the phone layout a
 * tab root also gets the bottom tab bar, and `--tab-bar-h` (the bar plus the gesture-bar inset) tells the
 * screens how much room it takes, so a full-height page such as the calendar ends above it.
 */
export function AppLayout() {
  const phone = useIsPhoneLayout();
  const { pathname } = useLocation();
  const tabs = phone && showsTabBar(pathname);
  // The measured height of the bar once it is on screen; until then the default below.
  const [barHeight, setBarHeight] = useState<number | null>(null);

  return (
    <div
      className={tabs ? '[--tab-bar-h:calc(3.5rem+env(safe-area-inset-bottom))] pb-(--tab-bar-h)' : undefined}
      style={tabs && barHeight !== null ? ({ '--tab-bar-h': `${barHeight}px` } as CSSProperties) : undefined}
    >
      <Outlet />
      {tabs ? <BottomTabBar onHeightChange={setBarHeight} /> : null}
    </div>
  );
}
