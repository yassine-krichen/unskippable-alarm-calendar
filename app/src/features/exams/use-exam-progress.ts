import { examProgress, type ExamProgress, type ExamRow } from '@alarm-calendar/core';
import { useMemo } from 'react';

import { useEventsStore } from '@/features/events/events-store';
import { usePassesStore } from '@/features/passes/passes-store';
import { useSettingsStore } from '@/features/settings/settings-store';
import { useNow } from '@/hooks/use-now';

import { examCompletionsCovered, useExamsStore } from './exams-store';

/**
 * What can be said about an exam's progress right now:
 *  - loading: the completions are on their way (every past session would look missed without them);
 *  - error: they could not be loaded;
 *  - archived: the exam ended too long ago for its completions to be loaded (see examCompletionsCovered);
 *  - ready: the counts.
 */
export type ExamProgressState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'archived' }
  | { status: 'ready'; progress: ExamProgress };

export function useExamProgress(exam: Pick<ExamRow, 'id' | 'exam_at'>): ExamProgressState {
  const settings = useSettingsStore((state) => state.settings);
  const events = useEventsStore((state) => state.events);
  const completions = useExamsStore((state) => state.completions);
  const completionsStatus = useExamsStore((state) => state.completionsStatus);
  const cheatDays = usePassesStore((state) => state.cheatDays);
  const now = useNow();

  return useMemo((): ExamProgressState => {
    if (!examCompletionsCovered(exam, now)) return { status: 'archived' };
    if (completionsStatus === 'error') return { status: 'error' };
    if (settings === null || completionsStatus !== 'ready') return { status: 'loading' };
    return {
      status: 'ready',
      progress: examProgress({ examId: exam.id, events, completions, cheatDays, settings, now }),
    };
  }, [exam, settings, events, completions, completionsStatus, cheatDays, now]);
}
