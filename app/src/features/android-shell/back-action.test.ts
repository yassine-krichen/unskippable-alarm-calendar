import { describe, expect, it } from 'vitest';

import { decideBackAction, hashPathname, historyIndexOf, homePath, type BackContext } from './back-action';

const READY: BackContext = {
  overlayOpen: false,
  authStatus: 'signed-in',
  bootStatus: 'ready',
  pathname: '/',
  historyIndex: 0,
  phoneLayout: false,
};

const on = (overrides: Partial<BackContext>): BackContext => ({ ...READY, ...overrides });

describe('decideBackAction in the app', () => {
  it('closes an open sheet or dialog before anything else, on any screen', () => {
    expect(decideBackAction(on({ overlayOpen: true }))).toBe('close-overlay');
    expect(decideBackAction(on({ overlayOpen: true, pathname: '/settings', historyIndex: 3 }))).toBe('close-overlay');
  });

  it('goes back one screen when there is an entry to go back to', () => {
    expect(decideBackAction(on({ pathname: '/settings', historyIndex: 1 }))).toBe('previous-screen');
  });

  it('lands on home, never on a blank page, when a screen was the first entry', () => {
    expect(decideBackAction(on({ pathname: '/exams', historyIndex: 0 }))).toBe('home');
    expect(decideBackAction(on({ pathname: '/exams', historyIndex: null }))).toBe('home');
  });

  it('treats the desktop layout pages as pushed screens, including /stats', () => {
    expect(decideBackAction(on({ pathname: '/stats', historyIndex: 1 }))).toBe('previous-screen');
    expect(decideBackAction(on({ pathname: '/stats', historyIndex: 0 }))).toBe('home');
    expect(decideBackAction(on({ pathname: '/more', historyIndex: 0 }))).toBe('home');
  });

  it('moves the app to the background from the calendar', () => {
    expect(decideBackAction(on({ pathname: '/', historyIndex: 4 }))).toBe('minimize');
  });
});

describe('decideBackAction in the phone layout', () => {
  const phone = (overrides: Partial<BackContext>): BackContext => on({ phoneLayout: true, ...overrides });

  it('moves the app to the background from Today, whichever address it has', () => {
    expect(decideBackAction(phone({ pathname: '/today', historyIndex: 0 }))).toBe('minimize');
    expect(decideBackAction(phone({ pathname: '/', historyIndex: 0 }))).toBe('minimize');
  });

  it('goes to Today from the other tab roots, even when the history has an entry before them', () => {
    for (const pathname of ['/calendar', '/stats', '/more']) {
      expect(decideBackAction(phone({ pathname, historyIndex: 0 }))).toBe('home');
      expect(decideBackAction(phone({ pathname, historyIndex: 3 }))).toBe('home');
    }
  });

  it('goes to the previous screen from a pushed screen under More, else home', () => {
    for (const pathname of ['/exams', '/modes', '/settings', '/about']) {
      expect(decideBackAction(phone({ pathname, historyIndex: 1 }))).toBe('previous-screen');
      expect(decideBackAction(phone({ pathname, historyIndex: 0 }))).toBe('home');
    }
  });

  it('walks the whole matrix: More, Settings, back, back, back', () => {
    // Today (idx 0) -> More replaces it (idx 0) -> Settings is pushed (idx 1).
    expect(decideBackAction(phone({ pathname: '/settings', historyIndex: 1 }))).toBe('previous-screen');
    expect(decideBackAction(phone({ pathname: '/more', historyIndex: 0 }))).toBe('home');
    expect(decideBackAction(phone({ pathname: '/today', historyIndex: 0 }))).toBe('minimize');
  });

  it('closes an open sheet first, on any tab', () => {
    expect(decideBackAction(phone({ pathname: '/calendar', overlayOpen: true }))).toBe('close-overlay');
  });

  it('does nothing while loading, like the desktop layout', () => {
    expect(decideBackAction(phone({ pathname: '/more', bootStatus: 'loading' }))).toBe('nothing');
  });
});

describe('homePath', () => {
  it('is Today on the phone layout and the calendar on the desktop layout', () => {
    expect(homePath(true)).toBe('/today');
    expect(homePath(false)).toBe('/');
  });
});

describe('decideBackAction before the app is ready', () => {
  it('does nothing while the session is still being restored', () => {
    expect(decideBackAction(on({ authStatus: 'loading', bootStatus: null }))).toBe('nothing');
  });

  it('does nothing while the signed-in app loads its data, and on its load error', () => {
    expect(decideBackAction(on({ bootStatus: 'loading' }))).toBe('nothing');
    expect(decideBackAction(on({ bootStatus: 'error', pathname: '/settings', historyIndex: 2 }))).toBe('nothing');
  });

  it('moves the app to the background from the sign-in screen', () => {
    expect(decideBackAction(on({ authStatus: 'signed-out', bootStatus: null }))).toBe('minimize');
  });

  it('still lets an open dialog take the press first, on the sign-in screen too', () => {
    expect(decideBackAction(on({ authStatus: 'signed-out', bootStatus: null, overlayOpen: true }))).toBe(
      'close-overlay'
    );
  });

  it('swallows the press while a dialog that cannot be dismissed is open: the overlay takes it and ignores it', () => {
    // The blocking permission dialog is an open overlay; it refuses Escape, so nothing closes and nothing exits.
    expect(decideBackAction(on({ overlayOpen: true, bootStatus: 'loading' }))).toBe('close-overlay');
  });
});

describe('hashPathname', () => {
  it('reads the route out of the address', () => {
    expect(hashPathname('')).toBe('/');
    expect(hashPathname('#/')).toBe('/');
    expect(hashPathname('#/settings')).toBe('/settings');
    expect(hashPathname('#/?view=month')).toBe('/');
  });
});

describe('historyIndexOf', () => {
  it('reads the position react-router keeps and ignores anything else', () => {
    expect(historyIndexOf({ idx: 2, key: 'k', usr: null })).toBe(2);
    expect(historyIndexOf(null)).toBeNull();
    expect(historyIndexOf({ idx: 'x' })).toBeNull();
  });
});
