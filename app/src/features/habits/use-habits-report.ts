import {
  computeHabitsReport,
  isHabit,
  type HabitEvent,
  type HabitsReport,
} from '@alarm-calendar/core';
import { useMemo } from 'react';

import { useEventsStore } from '@/features/events/events-store';
import { usePassesStore } from '@/features/passes/passes-store';
import { useSettingsStore } from '@/features/settings/settings-store';
import { useNow } from '@/hooks/use-now';

import { partitionByCoverage } from './habit-view';
import { useHabitCompletionsStore } from './habits-store';

export interface HabitsView {
  /** Scored habits only: those whose whole window the loaded history covers. */
  report: HabitsReport;
  /**
   * Habits that are not scored because the history for their window is not loaded (a slow habit
   * added or edited since the last load, or a reload that failed). They must be shown as
   * loading or unavailable, never as zeros: every occurrence outside the loaded range would
   * look missed.
   */
  pending: HabitEvent[];
  /** A history load is in flight, so a pending habit is about to be scored. */
  loading: boolean;
}

/**
 * Scores every recurring event from the stores. Null until settings exist. Any realtime change
 * to events, cheat days, settings or completions lands in a store and recomputes it.
 */
export function useHabitsReport(): HabitsView | null {
  const settings = useSettingsStore((state) => state.settings);
  const events = useEventsStore((state) => state.events);
  const cheatDays = usePassesStore((state) => state.cheatDays);
  const completions = useHabitCompletionsStore((state) => state.completions);
  const coverage = useHabitCompletionsStore((state) => state.coverage);
  const loading = useHabitCompletionsStore((state) => state.reloading);
  const now = useNow();

  return useMemo(() => {
    if (settings === null) return null;
    const { covered, pending } = partitionByCoverage(events.filter(isHabit), coverage);
    const report = computeHabitsReport(
      covered,
      completions,
      cheatDays,
      // The whole row: prayers are scored from the prayer times in it.
      settings,
      now
    );
    return { report, pending, loading };
  }, [settings, events, completions, coverage, cheatDays, loading, now]);
}
