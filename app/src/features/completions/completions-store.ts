import type { CompletionRow } from '@alarm-calendar/core';
import { create } from 'zustand';

import { createLatestRequestGuard } from '@/lib/latest-request';
import type { Result } from '@/lib/result';

import { COMPLETION_WINDOW_MS, fetchRecentCompletions } from './completions-api';

interface CompletionsState {
  /** Recent completions from any device; the alarm engine uses them to not re-ring done occurrences. */
  completions: CompletionRow[];
}

export const useCompletionsStore = create<CompletionsState>(() => ({ completions: [] }));

const loadGuard = createLatestRequestGuard();

export async function loadRecentCompletions(): Promise<Result<CompletionRow[]>> {
  const isLatest = loadGuard.begin();
  const result = await fetchRecentCompletions();
  if (result.data && isLatest()) useCompletionsStore.setState({ completions: result.data });
  return result;
}

/** Realtime keeps appending for as long as the app runs; the list stays within the load window. */
function withinWindow(row: CompletionRow, now: number): boolean {
  return Date.parse(row.occurrence_at) >= now - COMPLETION_WINDOW_MS;
}

function sameOccurrence(a: CompletionRow, b: CompletionRow): boolean {
  return a.event_id === b.event_id && Date.parse(a.occurrence_at) === Date.parse(b.occurrence_at);
}

/** Insert or replace by occurrence: an upsert from another device may carry a new row id. */
export function upsertCompletion(row: CompletionRow, now: number = Date.now()): void {
  useCompletionsStore.setState((state) => ({
    completions: [...state.completions.filter((existing) => !sameOccurrence(existing, row)), row].filter(
      (kept) => withinWindow(kept, now)
    ),
  }));
}

export function removeCompletion(id: string): void {
  useCompletionsStore.setState((state) => ({
    completions: state.completions.filter((existing) => existing.id !== id),
  }));
}
