import { catchUpsToCancel, planCatchUps } from '@alarm-calendar/core';

import { getAlarmAdapter } from '@/features/alarm-adapter/create-alarm-adapter';
import { addEventsToStore, removeEventGroup, useEventsStore } from '@/features/events/events-store';
import { insertCatchUps } from '@/features/events/events-api';
import { useModesStore } from '@/features/modes/modes-store';
import { usePassesStore } from '@/features/passes/passes-store';
import { useSettingsStore } from '@/features/settings/settings-store';

import { catchUpWriteInput } from './exam-plan';
import { fetchCompletionsOfEvents } from './exams-api';
import { useExamsStore } from './exams-store';

const DEBOUNCE_MS = 1000;
// Time passing is what turns a session into a missed one, and nothing in a store changes when it does.
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

// Missed sessions this app instance has already dealt with (a catch-up written, or one that turned out to
// exist or not to be needed), so the 5 minute check does not ask the database about them again. The unique
// index on events.catch_up_of, not this set, is what keeps a second device from adding another.
const handled = new Set<string>();
let running = false;
// A trigger that arrives while a run is in progress: that run has already read the stores, so it may have
// missed what the trigger is about. It is not dropped; one more run follows the current one.
let pending = false;

/** Forgets what the catch-up writer has done; for a different account signing in, and for tests. */
export function resetCatchUps(): void {
  handled.clear();
  running = false;
  pending = false;
}

export interface CatchUpDeps {
  /**
   * Occurrence ids (`<event id>@<instant>`) marked Done on this device that the server has not got yet. The
   * desktop app keeps a Done offline until it can flush it; without this check a session done offline would
   * look missed to the database. Defaults to the platform adapter.
   */
  pendingDoneOccurrences?: () => Promise<readonly string[]>;
}

function eventIdOfOccurrence(occurrenceId: string): string {
  const separator = occurrenceId.indexOf('@');
  return separator < 0 ? occurrenceId : occurrenceId.slice(0, separator);
}

/**
 * Switches off a catch-up that is still to come when the session it replaces has meanwhile got a completion
 * (done late, or on another device). Uses the exam completions the store holds, which realtime keeps current.
 */
async function cancelResolvedCatchUps(now: Date): Promise<void> {
  const cancelled = catchUpsToCancel({
    events: useEventsStore.getState().events,
    completions: useExamsStore.getState().completions,
    now,
  });
  if (cancelled.length === 0) return;
  const removed = await removeEventGroup(cancelled.map((event) => event.id));
  if (removed.error !== null) console.warn('Could not switch off a catch-up that is no longer needed:', removed.error);
}

async function createCatchUps(now: Date, deps: CatchUpDeps): Promise<number> {
  const settings = useSettingsStore.getState().settings;
  const events = useEventsStore.getState();
  const exams = useExamsStore.getState();
  if (settings === null) return 0;
  const modeState = useModesStore.getState();
  const modeConfig =
    modeState.modes.length === 0
      ? undefined
      : { modes: modeState.modes, rules: modeState.rules, activations: modeState.activations, exams: exams.exams };

  const plans = planCatchUps({
    exams: exams.exams,
    events: events.events,
    completions: exams.completions,
    cheatDays: usePassesStore.getState().cheatDays,
    settings,
    now,
    // A session a mode paused (Sick, Vacation ...) is skipped, not missed: it gets no catch-up.
    ...(modeConfig === undefined ? {} : { modes: modeConfig }),
    skip: handled,
  });
  if (plans.length === 0) return 0;

  const fresh = await fetchCompletionsOfEvents(plans.map((plan) => plan.missed.id));
  if (fresh.data === null) {
    console.warn('Could not check the missed revision sessions:', fresh.error);
    return 0;
  }
  let unflushed: readonly string[];
  try {
    unflushed = await (deps.pendingDoneOccurrences ?? (() => getAlarmAdapter().getPendingDoneOccurrences()))();
  } catch (error) {
    // Fail closed: a Done pressed offline on this device may be among them, and a spare catch-up is worse than a late one.
    console.warn('Could not read the Done presses still waiting to be saved:', error);
    return 0;
  }
  const answered = new Set([...fresh.data.map((completion) => completion.event_id), ...unflushed.map(eventIdOfOccurrence)]);
  for (const id of answered) handled.add(id);
  const needed = plans.filter((plan) => !answered.has(plan.missed.id));
  if (needed.length === 0) return 0;

  const inserted = await insertCatchUps(needed.map((plan) => catchUpWriteInput(plan.exam, plan.missed, plan.at)));
  if (inserted.data === null) {
    console.warn('Could not add the catch-up revision sessions:', inserted.error);
    return 0;
  }
  for (const plan of needed) handled.add(plan.missed.id);
  addEventsToStore(inserted.data);
  return inserted.data.length;
}

/**
 * Looks for revision sessions that were missed (past their grace window with no completion) and gives each
 * one its catch-up session: halfway between now and the exam, in the daytime (planCatchUps in core). Also
 * switches off a future catch-up whose session has since been completed. Returns how many catch-ups this
 * call created.
 *
 * Idempotent across devices and runs: the insert is ON CONFLICT (catch_up_of) DO NOTHING, so two devices
 * that notice the same miss create one catch-up, and a catch-up is never itself caught up. Before writing,
 * it asks the database for the completions of the sessions it is about to act on and, on desktop, which Done
 * presses this device has not saved yet, so a stale local list cannot cause a catch-up nobody needed. Not
 * called from rendering: it runs on a debounce after any change, on focus and every few minutes. Runs do
 * not overlap; a call during a run makes one more run follow it.
 */
export async function runCatchUps(now?: Date, deps: CatchUpDeps = {}): Promise<number> {
  if (running) {
    pending = true;
    return 0;
  }
  const events = useEventsStore.getState();
  const exams = useExamsStore.getState();
  if (useSettingsStore.getState().settings === null || events.status !== 'ready' || exams.status !== 'ready') return 0;

  running = true;
  let created = 0;
  let again = false;
  try {
    const at = now ?? new Date();
    await cancelResolvedCatchUps(at);
    created = await createCatchUps(at, deps);
  } finally {
    running = false;
    again = pending;
    pending = false;
  }
  if (again) created += await runCatchUps(now, deps);
  return created;
}

export interface CatchUpSyncOptions {
  debounceMs?: number;
  intervalMs?: number;
  now?: () => Date;
  /** Where focus events come from; the window unless a test supplies one. */
  focusTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
}

/**
 * Runs the catch-up check after the first load, whenever events, exams, settings, cheat days or the exam
 * completions change (which covers realtime updates, since they land in the same stores), when the window
 * gains focus, and every 5 minutes. Debounced, so the loads after a focus become one check. Returns the
 * stop function. Call it only once the first load finished.
 */
export function startCatchUpSync({
  debounceMs = DEBOUNCE_MS,
  intervalMs = CHECK_INTERVAL_MS,
  now = () => new Date(),
  focusTarget = typeof window === 'undefined' ? undefined : window,
}: CatchUpSyncOptions = {}): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const check = (): void => {
    timer = null;
    void runCatchUps(now()).catch((error: unknown) => console.warn('Catch-up check failed:', error));
  };
  const checkSoon = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(check, debounceMs);
  };

  const stops = [
    useEventsStore.subscribe((state, previous) => {
      if (state.events !== previous.events || state.status !== previous.status) checkSoon();
    }),
    useExamsStore.subscribe((state, previous) => {
      if (state.exams !== previous.exams || state.completions !== previous.completions || state.status !== previous.status) {
        checkSoon();
      }
    }),
    usePassesStore.subscribe((state, previous) => {
      if (state.cheatDays !== previous.cheatDays) checkSoon();
    }),
    useSettingsStore.subscribe((state, previous) => {
      if (state.settings !== previous.settings) checkSoon();
    }),
    useModesStore.subscribe((state, previous) => {
      if (state.modes !== previous.modes || state.rules !== previous.rules || state.activations !== previous.activations) {
        checkSoon();
      }
    }),
  ];
  focusTarget?.addEventListener('focus', checkSoon);
  const interval = setInterval(checkSoon, intervalMs);
  checkSoon();

  return () => {
    if (timer !== null) clearTimeout(timer);
    clearInterval(interval);
    focusTarget?.removeEventListener('focus', checkSoon);
    stops.forEach((stop) => stop());
  };
}
