export type Platform = 'web' | 'electron' | 'android';

/**
 * Which shell the app runs in. Settings hides the Android permissions panel and the desktop
 * autostart toggle everywhere else.
 */
export function detectPlatform(): Platform {
  if (/Electron/i.test(navigator.userAgent)) return 'electron';
  const capacitor: unknown = Reflect.get(window, 'Capacitor');
  if (typeof capacitor === 'object' && capacitor !== null) {
    const getPlatform: unknown = Reflect.get(capacitor, 'getPlatform');
    if (typeof getPlatform === 'function' && getPlatform.call(capacitor) === 'android') return 'android';
  }
  return 'web';
}
