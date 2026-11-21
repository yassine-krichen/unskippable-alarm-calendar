import { describe, expect, it } from 'vitest';

import { MORE_CHILD_PATHS, TAB_ITEMS, showsTabBar, tabOfPath } from './nav-items';

describe('tabOfPath', () => {
  it('maps each tab root, and treats / as Today', () => {
    expect(tabOfPath('/')).toBe('today');
    expect(tabOfPath('/today')).toBe('today');
    expect(tabOfPath('/calendar')).toBe('calendar');
    expect(tabOfPath('/stats')).toBe('habits');
    expect(tabOfPath('/more')).toBe('more');
  });

  it('has no tab for a screen pushed from More', () => {
    for (const path of MORE_CHILD_PATHS) expect(tabOfPath(path)).toBeNull();
  });
});

describe('showsTabBar', () => {
  it('shows on the tab roots only', () => {
    for (const tab of TAB_ITEMS) expect(showsTabBar(tab.path)).toBe(true);
    expect(showsTabBar('/settings')).toBe(false);
    expect(showsTabBar('/exams')).toBe(false);
  });
});
