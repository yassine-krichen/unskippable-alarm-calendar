import type { AlarmAdapter } from '@alarm-calendar/core';

import { useCompletionsStore } from '@/features/completions/completions-store';
import { useEventsStore } from '@/features/events/events-store';
import { usePassesStore } from '@/features/passes/passes-store';
import { reportScheduleProblem } from './schedule-problem';
import { getSoundId, subscribeSoundId } from '@/features/settings/sound-preference';
import { useSettingsStore } from '@/features/settings/settings-store';

const PUSH_DEBOUNCE_MS = 300;

export interface ScheduleSyncOptions {
  adapter: AlarmAdapter;
  debounceMs?: number;
  onError?: (error: unknown) => void;
}

/**
 * Keeps the platform alarm engine in step with the app's data: pushes the schedule once now, then
 * after any change to events, cheat days, settings, completions (which covers pass changes and
 * every realtime update, since those land in the same stores) or the sound choice. Debounced so a
 * burst, such as the loads after a window focus, becomes one push. Returns the stop function.
 *
 * Call it only once the first load finished: a half-loaded store (no cheat days yet) would tell
 * the engine to ring on a day that is silenced.
 */
export function startScheduleSync({
  adapter,
  debounceMs = PUSH_DEBOUNCE_MS,
  onError = (error) => {
    console.warn('Could not update the alarm schedule:', error);
    reportScheduleProblem();
  },
}: ScheduleSyncOptions): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const push = (): void => {
    timer = null;
    const settings = useSettingsStore.getState().settings;
    const events = useEventsStore.getState();
    if (settings === null || events.status !== 'ready') return;
    adapter
      .setSchedule(
        events.events,
        usePassesStore.getState().cheatDays,
        { ...settings, sound: getSoundId() },
        useCompletionsStore.getState().completions
      )
      .catch(onError);
  };

  const pushSoon = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(push, debounceMs);
  };

  const stops = [
    useEventsStore.subscribe((state, previous) => {
      if (state.events !== previous.events || state.status !== previous.status) pushSoon();
    }),
    usePassesStore.subscribe((state, previous) => {
      if (state.cheatDays !== previous.cheatDays) pushSoon();
    }),
    useSettingsStore.subscribe((state, previous) => {
      if (state.settings !== previous.settings) pushSoon();
    }),
    useCompletionsStore.subscribe((state, previous) => {
      if (state.completions !== previous.completions) pushSoon();
    }),
    subscribeSoundId(pushSoon),
  ];

  push();
  return () => {
    if (timer !== null) clearTimeout(timer);
    stops.forEach((stop) => stop());
  };
}
