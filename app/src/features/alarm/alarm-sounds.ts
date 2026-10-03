export interface SoundOption {
  id: string;
  label: string;
}

// Placeholder names: the three bundled alarm sounds arrive with the platform apps.
export const SOUND_OPTIONS: readonly SoundOption[] = [
  { id: 'bell', label: 'Classic bell' },
  { id: 'chime', label: 'Rising chime' },
  { id: 'pulse', label: 'Digital pulse' },
];

export const DEFAULT_SOUND_ID = SOUND_OPTIONS[0]?.id ?? 'bell';

// All three options map to the one placeholder tone until real sounds are bundled
// (see electron/scripts/generate-assets.mjs).
const PLACEHOLDER_SOUND = '/sounds/alarm.wav';
const SOUND_URLS: Readonly<Record<string, string>> = {
  bell: PLACEHOLDER_SOUND,
  chime: PLACEHOLDER_SOUND,
  pulse: PLACEHOLDER_SOUND,
};

export function soundUrl(soundId: string | null): string {
  return SOUND_URLS[soundId ?? DEFAULT_SOUND_ID] ?? PLACEHOLDER_SOUND;
}
