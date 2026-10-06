import type { EventRow } from '@alarm-calendar/core';
import { create } from 'zustand';

import { createLatestRequestGuard } from '@/lib/latest-request';
import type { Result } from '@/lib/result';

import type { EventWriteInput } from './event-form';
import {
  createEvent,
  createEvents,
  deactivateEvent,
  deactivateEvents,
  fetchActiveEvents,
  updateEvent,
} from './events-api';

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

interface EventsState {
  events: EventRow[];
  status: LoadStatus;
  error: string | null;
}

export const useEventsStore = create<EventsState>(() => ({ events: [], status: 'idle', error: null }));

const loadGuard = createLatestRequestGuard();

/**
 * Call after the user's own save or delete, so a fetch that started earlier and answers later
 * cannot put the older list back. Realtime changes do not call it: they may arrive while the
 * catch-up fetch after a reconnect is in flight, and that fetch must land.
 */
export function invalidateEventsLoad(): void {
  loadGuard.invalidate();
}

// Realtime changes that arrive while a fetch is in flight are replayed over its result, so a
// response the server produced before the change cannot put the older row back.
const realtimeChangesDuringLoad = new Map<string, EventRow | null>();
let loadsInFlight = 0;

/** Called by the realtime handler; `row` is null when the event left the active list. */
export function recordRealtimeEventChange(id: string, row: EventRow | null): void {
  if (loadsInFlight > 0) realtimeChangesDuringLoad.set(id, row);
}

function replayRealtimeChanges(fetched: EventRow[]): EventRow[] {
  const byId = new Map(fetched.map((event) => [event.id, event]));
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

export async function loadEvents(): Promise<Result<EventRow[]>> {
  // Keep stale events on screen during a refetch; only the first load shows a skeleton.
  if (useEventsStore.getState().status !== 'ready') useEventsStore.setState({ status: 'loading' });
  const isLatest = loadGuard.begin();
  loadsInFlight += 1;
  const result = await fetchActiveEvents();
  loadsInFlight -= 1;
  const latest = isLatest();
  const events = latest && result.data ? replayRealtimeChanges(result.data) : null;
  if (loadsInFlight === 0) realtimeChangesDuringLoad.clear();
  if (!latest) return result;
  if (events) {
    useEventsStore.setState({ events, status: 'ready', error: null });
  } else if (useEventsStore.getState().status !== 'ready') {
    useEventsStore.setState({ status: 'error', error: result.error });
  }
  return result;
}

export async function saveEvent(id: string | null, input: EventWriteInput): Promise<Result<EventRow>> {
  const result = id === null ? await createEvent(input) : await updateEvent(id, input);
  const saved = result.data;
  if (saved) {
    invalidateEventsLoad();
    useEventsStore.setState((state) => ({
      events:
        id === null
          ? [...state.events, saved]
          : state.events.map((event) => (event.id === saved.id ? saved : event)),
      status: 'ready',
    }));
  }
  return result;
}

export async function removeEvent(id: string): Promise<Result<null>> {
  const result = await deactivateEvent(id);
  if (result.error === null) {
    invalidateEventsLoad();
    useEventsStore.setState((state) => ({ events: state.events.filter((event) => event.id !== id) }));
  }
  return result;
}

/** Creates the alarms of a template in one write; they appear together or not at all. */
export async function saveNewEventGroup(inputs: EventWriteInput[]): Promise<Result<EventRow[]>> {
  const result = await createEvents(inputs);
  const saved = result.data;
  if (saved) {
    invalidateEventsLoad();
    useEventsStore.setState((state) => ({ events: [...state.events, ...saved], status: 'ready' }));
  }
  return result;
}

/**
 * Updates the two alarms of a template, one request each (a row's values differ, so one statement
 * cannot cover both). If the second write fails the first stays applied and the error is returned:
 * saving again writes both with the same values, so a retry repairs it.
 */
export async function saveEventGroup(
  updates: ReadonlyArray<{ id: string; input: EventWriteInput }>
): Promise<Result<EventRow[]>> {
  const saved: EventRow[] = [];
  for (const { id, input } of updates) {
    const result = await updateEvent(id, input);
    if (result.data === null) {
      applySavedEvents(saved);
      return { data: null, error: result.error };
    }
    saved.push(result.data);
  }
  applySavedEvents(saved);
  return { data: saved, error: null };
}

function applySavedEvents(saved: EventRow[]): void {
  if (saved.length === 0) return;
  invalidateEventsLoad();
  const byId = new Map(saved.map((event) => [event.id, event]));
  useEventsStore.setState((state) => ({
    events: state.events.map((event) => byId.get(event.id) ?? event),
    status: 'ready',
  }));
}

export async function removeEventGroup(ids: string[]): Promise<Result<null>> {
  const result = await deactivateEvents(ids);
  if (result.error === null) {
    invalidateEventsLoad();
    const gone = new Set(ids);
    useEventsStore.setState((state) => ({ events: state.events.filter((event) => !gone.has(event.id)) }));
  }
  return result;
}
