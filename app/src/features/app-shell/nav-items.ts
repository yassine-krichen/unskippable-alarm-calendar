import { AlarmClockIcon, CalendarDaysIcon, ChartNoAxesColumnIcon, EllipsisIcon, type LucideIcon } from 'lucide-react';

export type TabId = 'today' | 'calendar' | 'habits' | 'more';

export interface TabItem {
  id: TabId;
  label: string;
  /** The route a tap goes to. */
  path: string;
  icon: LucideIcon;
}

/** The phone layout's bottom tabs, in order. Habits keeps the `/stats` route it always had. */
export const TAB_ITEMS: readonly TabItem[] = [
  { id: 'today', label: 'Today', path: '/today', icon: AlarmClockIcon },
  { id: 'calendar', label: 'Calendar', path: '/calendar', icon: CalendarDaysIcon },
  { id: 'habits', label: 'Habits', path: '/stats', icon: ChartNoAxesColumnIcon },
  { id: 'more', label: 'More', path: '/more', icon: EllipsisIcon },
];

/** The screens that open from More, one level below it. The tab bar is not shown on them. */
export const MORE_CHILD_PATHS: readonly string[] = ['/exams', '/modes', '/settings', '/about'];

/** The tab whose root screen this is, or null on any other route (a pushed screen has no tab bar). */
export function tabOfPath(pathname: string): TabId | null {
  if (pathname === '/' || pathname === '/today') return 'today';
  return TAB_ITEMS.find((tab) => tab.path === pathname)?.id ?? null;
}

/** Whether the phone layout shows the tab bar here: on the four tab roots only. */
export function showsTabBar(pathname: string): boolean {
  return tabOfPath(pathname) !== null;
}
