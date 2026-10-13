/** Elements base-ui marks as open overlays: dialogs, sheets, drawers, popovers (dialog) and select / combobox lists. */
const OPEN_OVERLAY_SELECTOR = '[data-open][role="dialog"], [data-open][role="alertdialog"], [data-open][role="listbox"]';

export type BackAction = 'close-overlay' | 'nothing' | 'minimize' | 'previous-screen' | 'calendar';

export interface BackContext {
  overlayOpen: boolean;
  authStatus: 'loading' | 'signed-out' | 'signed-in';
  /** The first data load of a signed-in session; null while no signed-in screen exists. */
  bootStatus: 'loading' | 'ready' | 'error' | null;
  pathname: string;
  /** react-router's position in this session's history (0 = the first entry). */
  historyIndex: number | null;
}

/**
 * What the Android back button does, in order: close the topmost sheet, dialog or list (a dialog that
 * cannot be dismissed, like the permission dialog while something required is missing, swallows it);
 * on the sign-in screen move the app to the background; while the app is loading or showing its load
 * error do nothing, so a stray press never closes the activity under a half-started session; on the
 * app's screens go to the previous one, else (a screen opened directly, nothing before it) to the
 * calendar, and on the calendar itself move the app to the background. Never a blank page: there is
 * always an entry to land on.
 */
export function decideBackAction(context: BackContext): BackAction {
  const { overlayOpen, authStatus, bootStatus, pathname, historyIndex } = context;
  if (overlayOpen) return 'close-overlay';
  if (authStatus === 'loading') return 'nothing';
  if (authStatus === 'signed-out') return 'minimize';
  if (bootStatus !== 'ready') return 'nothing';
  if (pathname === '/') return 'minimize';
  return historyIndex !== null && historyIndex > 0 ? 'previous-screen' : 'calendar';
}

/** The route of the hash router, from the address (`#/settings?x=1` is `/settings`). */
export function hashPathname(hash: string): string {
  const path = hash.replace(/^#/, '').split('?')[0] ?? '';
  return path === '' ? '/' : path;
}

/** The topmost open overlay, which is the last one in the document (portals append). */
export function topOpenOverlay(root: ParentNode = document): Element | null {
  const all = root.querySelectorAll(OPEN_OVERLAY_SELECTOR);
  return all.item(all.length - 1);
}

/**
 * Asks an overlay to close the way a keyboard user would. The overlay decides: a dialog that must
 * not be dismissed (the permission dialog while something required is missing) ignores Escape, so
 * back does nothing there, by design.
 */
export function pressEscapeOn(overlay: Element): void {
  overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
}

/** react-router keeps the position in the history entry's state. */
export function historyIndexOf(state: unknown): number | null {
  if (typeof state !== 'object' || state === null) return null;
  const index: unknown = Reflect.get(state, 'idx');
  return typeof index === 'number' ? index : null;
}
