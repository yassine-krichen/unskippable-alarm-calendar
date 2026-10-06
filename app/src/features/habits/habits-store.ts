import { HABIT_WINDOW_DAYS, instantMs } from '@alarm-calendar/core';
import { create } from 'zustand';

import { useEventsStore } from '@/features/events/events-store';
import { createLatestRequestGuard } from '@/lib/latest-request';
import { fail, ok, type Result } from '@/lib/result';

import { isHistoryCovered, longWindowHabits } from './habit-view';
import { fetchExtendedHabitCompletions, fetchHabitCompletions, type HabitCompletionRow } from './habits-api';

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

const MS_PER_DAY = 86_400_000;

interface HabitCompletionsState {
  /**
   * Completions from any device: the last 28 days for every habit, plus older history for the
   * habits with a longer scoring window. The Stats screen and event sheet score them.
   */
  completions: HabitCompletionRow[];
  /** 'ready' once a load has succeeded; a later failed refetch keeps the data and the status. */
  status: LoadStatus;
  error: string | null;
  /**
   * For each long-window habit, the window (days) the loaded history was fetched for. A habit
   * whose current window is larger than this is not fully covered and must not be scored,
   * otherwise the occurrences before the loaded range would all count as misses.
   */
  coverage: Record<string, number>;
  /** A load is in flight. */
  reloading: boolean;
}

export const useHabitCompletionsStore = create<HabitCompletionsState>(() => ({
  completions: [],
  status: 'idle',
  error: null,
  coverage: {},
  reloading: false,
}));

const loadGuard = createLatestRequestGuard();

/** The state a signed-out store returns to. */
export function resetHabitCompletions(): void {
  loadGuard.invalidate();
  useHabitCompletionsStore.setState({ completions: [], status: 'idle', error: null, coverage: {}, reloading: false });
}

type Change = { kind: 'upsert'; row: HabitCompletionRow } | { kind: 'remove'; id: string };

// Realtime changes that arrive while a fetch is in flight are replayed over its result, so a
// response the server produced before the change cannot take the change away again.
const changesDuringLoad: Change[] = [];
let loadsInFlight = 0;

function recordChange(change: Change): void {
  if (loadsInFlight > 0) changesDuringLoad.push(change);
}

/** How far back a row is kept: its habit's window plus a day (29 days for a fast or unknown habit). */
function cutoffMs(eventId: string, now: number, windows: ReadonlyMap<string, number>): number {
  return now - ((windows.get(eventId) ?? HABIT_WINDOW_DAYS) + 1) * MS_PER_DAY;
}

function pruneToWindows(rows: HabitCompletionRow[], now: number): HabitCompletionRow[] {
  const windows = new Map(longWindowHabits(useEventsStore.getState().events).map((habit) => [habit.id, habit.windowDays]));
  return rows.filter((row) => instantMs(row.occurrence_at) >= cutoffMs(row.event_id, now, windows));
}

function sameOccurrence(a: HabitCompletionRow, b: HabitCompletionRow): boolean {
  return a.event_id === b.event_id && instantMs(a.occurrence_at) === instantMs(b.occurrence_at);
}

function withUpsert(rows: HabitCompletionRow[], row: HabitCompletionRow): HabitCompletionRow[] {
  return [...rows.filter((existing) => !sameOccurrence(existing, row)), row];
}

function replay(rows: HabitCompletionRow[]): HabitCompletionRow[] {
  return changesDuringLoad.reduce(
    (current, change) =>
      change.kind === 'upsert' ? withUpsert(current, change.row) : current.filter((existing) => existing.id !== change.id),
    rows
  );
}

export async function loadHabitCompletions(): Promise<Result<HabitCompletionRow[]>> {
  // Keep the last numbers on screen during a refetch; only the first load shows a skeleton.
  if (useHabitCompletionsStore.getState().status !== 'ready') {
    useHabitCompletionsStore.setState({ status: 'loading' });
  }
  const isLatest = loadGuard.begin();
  loadsInFlight += 1;
  useHabitCompletionsStore.setState({ reloading: true });
  const longHabits = longWindowHabits(useEventsStore.getState().events);
  const [bulk, extended] = await Promise.all([fetchHabitCompletions(), fetchExtendedHabitCompletions(longHabits)]);
  loadsInFlight -= 1;

  // A partial history would misjudge the long habits, so either part failing is a failed load.
  const result: Result<HabitCompletionRow[]> =
    bulk.data && extended.data ? ok([...bulk.data, ...extended.data]) : fail(bulk.error ?? extended.error ?? 'Unknown error');
  const latest = isLatest();
  const rows = latest && result.data ? pruneToWindows(replay(result.data), Date.now()) : null;
  if (loadsInFlight === 0) changesDuringLoad.length = 0;
  useHabitCompletionsStore.setState({ reloading: loadsInFlight > 0 });
  if (!latest) return result;

  if (rows) {
    const coverage = Object.fromEntries(longHabits.map((habit) => [habit.id, habit.windowDays]));
    useHabitCompletionsStore.setState({ completions: rows, status: 'ready', error: null, coverage });
  } else if (useHabitCompletionsStore.getState().status !== 'ready') {
    useHabitCompletionsStore.setState({ status: 'error', error: result.error });
  }
  return result;
}

/**
 * Loads the history once the app is ready (not during sign-in, so startup and the alarm schedule
 * push never wait for it), and again whenever an edit adds a long-window habit or changes a
 * habit's window, since what is loaded would not cover it. Returns the stop function.
 */
export function startHabitHistorySync(): () => void {
  const check = (): void => {
    const { status, coverage } = useHabitCompletionsStore.getState();
    const uncovered = longWindowHabits(useEventsStore.getState().events).some(
      (habit) => !isHistoryCovered(habit, coverage)
    );
    if (status === 'idle' || uncovered) void loadHabitCompletions();
  };
  check();
  return useEventsStore.subscribe((state, previous) => {
    if (state.events !== previous.events) check();
  });
}

/** Insert or replace by occurrence, like the alarm engine's list; realtime keeps it live. */
export function upsertHabitCompletion(row: HabitCompletionRow, now: number = Date.now()): void {
  recordChange({ kind: 'upsert', row });
  useHabitCompletionsStore.setState((state) => ({
    completions: pruneToWindows(withUpsert(state.completions, row), now),
  }));
}

export function removeHabitCompletion(id: string): void {
  recordChange({ kind: 'remove', id });
  useHabitCompletionsStore.setState((state) => ({
    completions: state.completions.filter((existing) => existing.id !== id),
  }));
}
