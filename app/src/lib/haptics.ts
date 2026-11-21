import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

import { detectPlatform } from './platform';

/**
 * A short tick on Android for the few moments that deserve one: a tab change, a saved alarm, a confirmed delete.
 * Nothing happens anywhere else (the web and desktop have no vibration motor worth buzzing). A failure is logged
 * and swallowed on purpose: a missing buzz must never break the action it accompanies.
 */
function run(effect: () => Promise<void>): void {
  if (detectPlatform() !== 'android') return;
  effect().catch((error: unknown) => console.warn('Haptic feedback failed:', error));
}

/** A tab or selection changed. */
export function hapticSelection(): void {
  run(() => Haptics.impact({ style: ImpactStyle.Light }));
}

/** Something was saved or completed. */
export function hapticSuccess(): void {
  run(() => Haptics.notification({ type: NotificationType.Success }));
}

/** Something was deleted. */
export function hapticWarning(): void {
  run(() => Haptics.notification({ type: NotificationType.Warning }));
}
