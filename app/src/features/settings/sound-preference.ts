import { readDevicePreference, writeDevicePreference } from '@/lib/device-preference';

import { DEFAULT_SOUND_ID, SOUND_OPTIONS } from './settings-options';

const SOUND_KEY = 'alarm-calendar-sound';

// Kept in memory too, so a choice the browser refused to store still reaches the alarm
// engine for this session.
let current: string | null = null;
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

/** Lets the schedule sync push the new sound to the alarm engine. */
export function subscribeSoundId(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: forget the in-memory choice. */
export function resetSoundIdForTests(): void {
  current = null;
  listeners.clear();
}
