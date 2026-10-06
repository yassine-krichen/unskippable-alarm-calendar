import { buildModeTimeline, type ModeConfig, type ModeTimeline } from '@alarm-calendar/core';
import { useMemo } from 'react';

import { useExamsStore } from '@/features/exams/exams-store';
import { useSettingsStore } from '@/features/settings/settings-store';

import { useModesStore } from './modes-store';

/**
 * What the mode rules read, from the stores: undefined while there is no mode at all, so the consumers take
 * their no-modes path (and a payload for an engine carries no `modes` key). Exams are included because Exam
 * mode's automatic window is derived from them.
 */
export function useModeConfig(): ModeConfig | undefined {
  const modes = useModesStore((state) => state.modes);
  const rules = useModesStore((state) => state.rules);
  const activations = useModesStore((state) => state.activations);
  const exams = useExamsStore((state) => state.exams);
  return useMemo(() => (modes.length === 0 ? undefined : { modes, rules, activations, exams }), [modes, rules, activations, exams]);
}

/** The resolved modes (see buildModeTimeline); inert until settings and modes are loaded. */
export function useModeTimeline(): ModeTimeline {
  const config = useModeConfig();
  const settings = useSettingsStore((state) => state.settings);
  return useMemo(() => buildModeTimeline(config, settings ?? { timezone: 'UTC' }), [config, settings]);
}
