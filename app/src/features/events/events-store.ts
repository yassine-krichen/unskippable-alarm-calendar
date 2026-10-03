import type { EventRow } from '@alarm-calendar/core';
import { create } from 'zustand';

import type { Result } from '@/lib/result';

import type { EventWriteInput } from './event-form';
import { createEvent, deactivateEvent, fetchActiveEvents, updateEvent } from './events-api';

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

interface EventsState {
  events: EventRow[];
  status: LoadStatus;
  error: string | null;
}

export const useEventsStore = create<EventsState>(() => ({ events: [], status: 'idle', error: null }));

export async function loadEvents(): Promise<Result<EventRow[]>> {
  // Keep stale events on screen during a refetch; only the first load shows a skeleton.
  if (useEventsStore.getState().status !== 'ready') useEventsStore.setState({ status: 'loading' });
  const result = await fetchActiveEvents();
  if (result.data) {
    useEventsStore.setState({ events: result.data, status: 'ready', error: null });
  } else if (useEventsStore.getState().status !== 'ready') {
    useEventsStore.setState({ status: 'error', error: result.error });
  }
  return result;
}

export async function saveEvent(id: string | null, input: EventWriteInput): Promise<Result<EventRow>> {
  const result = id === null ? await createEvent(input) : await updateEvent(id, input);
  const saved = result.data;
  if (saved) {
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
    useEventsStore.setState((state) => ({ events: state.events.filter((event) => event.id !== id) }));
  }
  return result;
}
