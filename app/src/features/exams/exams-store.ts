import type { CompletionRow, ExamRow } from '@alarm-calendar/core';
import { create } from 'zustand';

import { useEventsStore } from '@/features/events/events-store';
import { createLatestRequestGuard } from '@/lib/latest-request';
import { fail, type Result } from '@/lib/result';

import { fetchActiveExams, fetchCompletionsOfEvents } from './exams-api';

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

interface ExamsState {
  exams: ExamRow[];
  status: LoadStatus;
  error: string | null;
  /** Completions of the exam alarms, for the progress shown on the Exams screen. */
  completions: CompletionRow[];
  completionsStatus: LoadStatus;
}

const INITIAL: ExamsState = { exams: [], status: 'idle', error: null, completions: [], completionsStatus: 'idle' };

export const useExamsStore = create<ExamsState>(() => INITIAL);

/**
 * Completions are loaded for exams that are still to come or ended less than this many days ago. An older
 * exam has no sessions left to act on, and its history is not worth a read on every launch; its progress
 * is shown as unavailable rather than computed from a list that leaves its completions out.
 */
export const EXAM_COMPLETION_HORIZON_DAYS = 7;

/** Whether the completions of this exam's sessions are loaded (see EXAM_COMPLETION_HORIZON_DAYS). */
export function examCompletionsCovered(exam: Pick<ExamRow, 'exam_at'>, now: Date): boolean {
  return Date.parse(exam.exam_at) >= now.getTime() - EXAM_COMPLETION_HORIZON_DAYS * 86_400_000;
}

const examsGuard = createLatestRequestGuard();
const completionsGuard = createLatestRequestGuard();

/** The state a signed-out store returns to. */
export function resetExams(): void {
  examsGuard.invalidate();
  completionsGuard.invalidate();
  useExamsStore.setState(INITIAL);
}

/** Call after the person's own save or delete, so an older fetch that answers late cannot undo it. */
export function invalidateExamsLoad(): void {
  examsGuard.invalidate();
}

// Realtime changes that arrive while a fetch is in flight are replayed over its result.
const realtimeChangesDuringLoad = new Map<string, ExamRow | null>();
let loadsInFlight = 0;

/** Called by the realtime handler; `row` is null when the exam left the active list. */
export function recordRealtimeExamChange(id: string, row: ExamRow | null): void {
  if (loadsInFlight > 0) realtimeChangesDuringLoad.set(id, row);
}

function replayRealtimeChanges(fetched: ExamRow[]): ExamRow[] {
  const byId = new Map(fetched.map((exam) => [exam.id, exam]));
  for (const [id, row] of realtimeChangesDuringLoad) {
    const current = byId.get(id);
    if (row === null || !row.active) {
      byId.delete(id);
    } else if (current === undefined || Date.parse(row.updated_at) >= Date.parse(current.updated_at)) {
      byId.set(id, row);
    }
  }
  return [...byId.values()];
}

export async function loadExams(): Promise<Result<ExamRow[]>> {
  if (useExamsStore.getState().status !== 'ready') useExamsStore.setState({ status: 'loading' });
  const isLatest = examsGuard.begin();
  loadsInFlight += 1;
  const result = await fetchActiveExams();
  loadsInFlight -= 1;
  const latest = isLatest();
  const exams = latest && result.data ? replayRealtimeChanges(result.data) : null;
  if (loadsInFlight === 0) realtimeChangesDuringLoad.clear();
  if (!latest) return result;
  if (exams) {
    useExamsStore.setState({ exams, status: 'ready', error: null });
  } else if (useExamsStore.getState().status !== 'ready') {
    useExamsStore.setState({ status: 'error', error: result.error });
  }
  return result;
}

/** The ids of the active alarms of the exams whose completions are loaded: sessions (catch-ups included) and the exam alarm. */
function examEventIds(now: Date): string[] {
  const covered = new Set(
    useExamsStore
      .getState()
      .exams.filter((exam) => examCompletionsCovered(exam, now))
      .map((exam) => exam.id)
  );
  return useEventsStore
    .getState()
    .events.filter((event) => event.exam_id != null && covered.has(event.exam_id))
    .map((event) => event.id);
}

type CompletionChange = { kind: 'upsert'; row: CompletionRow } | { kind: 'remove'; id: string };

// Realtime completions that arrive while a load is in flight are replayed over its result, so an answer
// the server produced before the change cannot take the change away again.
const completionChangesDuringLoad: CompletionChange[] = [];
let completionLoadsInFlight = 0;

function recordCompletionChange(change: CompletionChange): void {
  if (completionLoadsInFlight > 0) completionChangesDuringLoad.push(change);
}

function withUpsert(rows: CompletionRow[], row: CompletionRow): CompletionRow[] {
  return [...rows.filter((existing) => !sameOccurrence(existing, row)), row];
}

function replayCompletionChanges(rows: CompletionRow[]): CompletionRow[] {
  return completionChangesDuringLoad.reduce(
    (current, change) =>
      change.kind === 'upsert' ? withUpsert(current, change.row) : current.filter((existing) => existing.id !== change.id),
    rows
  );
}

/**
 * Loads the completions of the exam alarms in the events store, so call it after the events are loaded.
 * It is best effort: until it has succeeded the Exams screen shows no progress rather than a wrong one,
 * and the catch-up writer asks the database again about every session it is about to act on.
 */
export async function loadExamCompletions(now: Date = new Date()): Promise<Result<CompletionRow[]>> {
  const isLatest = completionsGuard.begin();
  if (useExamsStore.getState().completionsStatus !== 'ready') useExamsStore.setState({ completionsStatus: 'loading' });
  completionLoadsInFlight += 1;
  const result = await fetchCompletionsOfEvents(examEventIds(now));
  completionLoadsInFlight -= 1;
  const rows = isLatest() && result.data ? replayCompletionChanges(result.data) : null;
  if (completionLoadsInFlight === 0) completionChangesDuringLoad.length = 0;
  // A newer load owns the status now; this answer is stale.
  if (!isLatest()) return result;
  if (rows) {
    useExamsStore.setState({ completions: rows, completionsStatus: 'ready' });
  } else if (useExamsStore.getState().completionsStatus !== 'ready') {
    useExamsStore.setState({ completionsStatus: 'error' });
  }
  return result.data ? result : fail(result.error ?? 'Unknown error');
}

/**
 * The first load of the exam data, started once the app is up and independent of realtime: the exams, then
 * the completions of their sessions (which need the exams, to know which are recent enough). Never blocks
 * startup; a failure leaves the store in its error state for the Exams screen to show with a retry.
 */
export async function loadExamData(): Promise<void> {
  const exams = await loadExams();
  if (exams.error !== null) console.warn('Could not load exams:', exams.error);
  const completions = await loadExamCompletions();
  if (completions.error !== null) console.warn('Could not load exam completions:', completions.error);
}

function sameOccurrence(a: CompletionRow, b: CompletionRow): boolean {
  return a.event_id === b.event_id && Date.parse(a.occurrence_at) === Date.parse(b.occurrence_at);
}

/** A realtime completion of one of the exam alarms; completions of any other alarm are not kept here. */
export function upsertExamCompletion(row: CompletionRow): void {
  const isExamEvent = useEventsStore.getState().events.some((event) => event.id === row.event_id && event.exam_id != null);
  if (!isExamEvent) return;
  // Merged in place, not by invalidating the load in flight: that load would then be discarded, and the
  // status it was about to set would stay "loading". A load already in flight replays this over its result.
  recordCompletionChange({ kind: 'upsert', row });
  useExamsStore.setState((state) => ({ completions: withUpsert(state.completions, row) }));
}

export function removeExamCompletion(id: string): void {
  recordCompletionChange({ kind: 'remove', id });
  useExamsStore.setState((state) => ({ completions: state.completions.filter((existing) => existing.id !== id) }));
}

/** Keeps the store in step with the person's own save. */
export function putExam(exam: ExamRow): void {
  invalidateExamsLoad();
  useExamsStore.setState((state) => ({
    exams: state.exams.some((existing) => existing.id === exam.id)
      ? state.exams.map((existing) => (existing.id === exam.id ? exam : existing))
      : [...state.exams, exam],
    status: 'ready',
  }));
}

export function dropExam(id: string): void {
  invalidateExamsLoad();
  useExamsStore.setState((state) => ({ exams: state.exams.filter((exam) => exam.id !== id) }));
}
