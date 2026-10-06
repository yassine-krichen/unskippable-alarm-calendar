import { CUSTOM_SOUND_ID } from '@/features/alarm/alarm-sounds';
import { readDevicePreference, writeDevicePreference } from '@/lib/device-preference';

import { DEFAULT_SOUND_ID, SOUND_OPTIONS } from './settings-options';

const SOUND_KEY = 'alarm-calendar-sound';
const PRAYER_SOUND_KEY = 'alarm-calendar-prayer-sound';

export { CUSTOM_SOUND_ID };

/** Stored value for "the prayer alarms use the alarm sound". */
const SAME_AS_ALARM = 'same';

// Kept in memory too, so a choice the browser refused to store still reaches the alarm
// engine for this session.
let current: string | null = null;
let currentPrayer: string | null = null;
const listeners = new Set<() => void>();

function isKnownSound(id: string | null): id is string {
  return id !== null && SOUND_OPTIONS.some((option) => option.id === id);
}

/** The alarm sound chosen on this device (per-device by design, spec section 8). */
export function getSoundId(): string {
  if (current !== null) return current;
  const stored = readDevicePreference(SOUND_KEY);
  return isKnownSound(stored) ? stored : DEFAULT_SOUND_ID;
}

/** Returns false when storage refused the value; the choice still applies until restart. */
export function setSoundId(id: string): boolean {
  current = id;
  const stored = writeDevicePreference(SOUND_KEY, id);
  listeners.forEach((listener) => listener());
  return stored;
}

/**
 * The sound of the prayer alarms on this device: a bundled sound id, 'custom' for the user's own
 * file, or null for "same as the alarm sound". Per device like the alarm sound, because the file
 * lives on this computer.
 */
export function getPrayerSoundId(): string | null {
  const value = currentPrayer ?? readDevicePreference(PRAYER_SOUND_KEY);
  if (value === CUSTOM_SOUND_ID || isKnownSound(value)) return value;
  return null;
}

/** Returns false when storage refused the value; the choice still applies until restart. */
export function setPrayerSoundId(id: string | null): boolean {
  const value = id ?? SAME_AS_ALARM;
  currentPrayer = value;
  const stored = writeDevicePreference(PRAYER_SOUND_KEY, value);
  listeners.forEach((listener) => listener());
  return stored;
}

/** Lets the schedule sync push a new sound choice (alarm or prayer) to the alarm engine. */
export function subscribeSoundId(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: forget the in-memory choices. */
export function resetSoundIdForTests(): void {
  current = null;
  currentPrayer = null;
  listeners.clear();
}
