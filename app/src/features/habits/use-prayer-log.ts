import { HABIT_WINDOW_DAYS, prayerLog, type PrayerLogEntry } from '@alarm-calendar/core';
import { useMemo } from 'react';

import { useEventsStore } from '@/features/events/events-store';
import { useSettingsStore } from '@/features/settings/settings-store';
import { useNow } from '@/hooks/use-now';

import { useHabitCompletionsStore } from './habits-store';

const MS_PER_DAY = 86_400_000;

/**
 * Every prayer of the last 28 days with what became of it, oldest first (the Qada list is its 'missed' entries).
 * Null until settings and the completion history are loaded: without the history every prayer would look missed.
 */
export function usePrayerLog(): PrayerLogEntry[] | null {
  const settings = useSettingsStore((state) => state.settings);
  const events = useEventsStore((state) => state.events);
  const completions = useHabitCompletionsStore((state) => state.completions);
  const status = useHabitCompletionsStore((state) => state.status);
  const now = useNow();

  return useMemo(() => {
    if (settings === null || status !== 'ready') return null;
    return prayerLog(events, completions, settings, now, now.getTime() - HABIT_WINDOW_DAYS * MS_PER_DAY);
  }, [settings, events, completions, status, now]);
}

/** How many prayers can still be made up; null while it is not known. */
export function useOpenQadaCount(): number | null {
  const log = usePrayerLog();
  return useMemo(() => (log === null ? null : log.filter((entry) => entry.tier === 'missed').length), [log]);
}
