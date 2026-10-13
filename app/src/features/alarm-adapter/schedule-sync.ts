import { buildSchedulePayload } from '@alarm-calendar/core';
import type {
  AlarmAdapter,
  CompletionRow,
  EventRow,
  ExamRow,
  ModeActivationRow,
  ModeConfig,
  ModeRow,
  ModeRuleRow,
  SchedulePayload,
  Settings,
} from '@alarm-calendar/core';

import { useCompletionsStore } from '@/features/completions/completions-store';
import { useEventsStore } from '@/features/events/events-store';
import { useExamsStore } from '@/features/exams/exams-store';
import { useModesStore } from '@/features/modes/modes-store';
import { usePassesStore } from '@/features/passes/passes-store';
import { subscribeAppResume } from '@/lib/app-resume';
import { reportScheduleProblem } from './schedule-problem';
import { getPrayerSoundId, getSoundId, subscribeSoundId } from '@/features/settings/sound-preference';
import { useSettingsStore } from '@/features/settings/settings-store';

const PUSH_DEBOUNCE_MS = 300;
// The list is computed for a fixed horizon from the moment of the push, so it is renewed daily even
// when nothing changed; the desktop main process also extends it on its own (see its scheduler).
const REPUSH_INTERVAL_MS = 24 * 60 * 60 * 1000;
// A focus that finds the inputs unchanged and a list younger than this has nothing new to say.
const FOCUS_REPUSH_MIN_AGE_MS = 60 * 60 * 1000;

/** What the expansion depends on, compared by identity: the stores replace a value when it changes. */
interface ScheduleInputs {
  events: EventRow[];
  cheatDays: string[];
  settings: Settings;
  completions: CompletionRow[];
  /** The modes and what Exam mode's window is derived from: replaced as a whole by their stores. */
  modes: ModeRow[];
  rules: ModeRuleRow[];
  activations: ModeActivationRow[];
  exams: ExamRow[];
  sound: string;
  /** The prayer alarms' own sound on this device, or null when they use `sound`. */
  prayerSound: string | null;
}

function modeConfigOf(inputs: ScheduleInputs): ModeConfig {
  return { modes: inputs.modes, rules: inputs.rules, activations: inputs.activations, exams: inputs.exams };
}

function sameInputs(a: ScheduleInputs, b: ScheduleInputs): boolean {
  return (
    a.events === b.events &&
    a.cheatDays === b.cheatDays &&
    a.settings === b.settings &&
    a.completions === b.completions &&
    a.modes === b.modes &&
    a.rules === b.rules &&
    a.activations === b.activations &&
    a.exams === b.exams &&
    a.sound === b.sound &&
    a.prayerSound === b.prayerSound
  );
}

export interface ScheduleSyncOptions {
  adapter: AlarmAdapter;
  debounceMs?: number;
  /** Clock for the expansion; injectable for tests. */
  now?: () => Date;
  /** Where focus events come from; the window unless a test supplies one (there is none in node). */
  focusTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  /**
   * Where "the Android app came back to the front" comes from (a window focus is not reliable in the
   * WebView). The app-level subscription unless a test supplies one; returns the unsubscribe function.
   */
  resumeSource?: (callback: () => void) => () => void;
  onError?: (error: unknown) => void;
}

/**
 * Keeps the platform alarm engine in step with the app's data: expands the schedule (core's
 * buildSchedulePayload: the concrete occurrences of the next 60 days) and pushes it once now, then
 * after any change to events, cheat days, settings, completions (which covers pass changes and
 * every realtime update, since those land in the same stores), modes, exams or the sound choice, whenever the
 * window gains focus or the Android app resumes, and once a day. Debounced so a burst, such as the loads after a window focus,
 * becomes one push. Expansion is memoized on the identity of its inputs for an hour, and a focus
 * with unchanged inputs inside that hour pushes nothing. Returns the stop function.
 *
 * Call it only once the first load finished: a half-loaded store (no cheat days yet) would tell
 * the engine to ring on a day that is silenced.
 */
export function startScheduleSync({
  adapter,
  debounceMs = PUSH_DEBOUNCE_MS,
  now = () => new Date(),
  focusTarget = typeof window === 'undefined' ? undefined : window,
  resumeSource = typeof window === 'undefined' ? () => () => undefined : subscribeAppResume,
  onError = (error) => {
    console.warn('Could not update the alarm schedule:', error);
    reportScheduleProblem();
  },
}: ScheduleSyncOptions): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The last expansion that was handed to the adapter; cleared when the adapter refuses it.
  let last: { inputs: ScheduleInputs; payload: SchedulePayload; atMs: number } | null = null;

  const currentInputs = (): ScheduleInputs | null => {
    const settings = useSettingsStore.getState().settings;
    const events = useEventsStore.getState();
    if (settings === null || events.status !== 'ready') return null;
    return {
      events: events.events,
      cheatDays: usePassesStore.getState().cheatDays,
      settings,
      completions: useCompletionsStore.getState().completions,
      modes: useModesStore.getState().modes,
      rules: useModesStore.getState().rules,
      activations: useModesStore.getState().activations,
      exams: useExamsStore.getState().exams,
      sound: getSoundId(),
      prayerSound: getPrayerSoundId(),
    };
  };

  const isFresh = (inputs: ScheduleInputs, nowMs: number): boolean =>
    last !== null && sameInputs(last.inputs, inputs) && nowMs - last.atMs < FOCUS_REPUSH_MIN_AGE_MS;

  function onPushFailed(error: unknown): void {
    last = null;
    onError(error);
  }

  const push = (): void => {
    timer = null;
    const inputs = currentInputs();
    if (inputs === null) return;
    const at = now();

    // Same inputs and a list under an hour old: the expansion would come out the same.
    if (last !== null && isFresh(inputs, at.getTime())) {
      adapter.setSchedule(last.payload).catch(onPushFailed);
      return;
    }

    const failedEventIds: string[] = [];
    let payload: SchedulePayload;
    try {
      payload = buildSchedulePayload({
        events: inputs.events,
        cheatDays: inputs.cheatDays,
        settings: {
          ...inputs.settings,
          sound: inputs.sound,
          ...(inputs.prayerSound === null ? {} : { prayerSound: inputs.prayerSound }),
        },
        completions: inputs.completions,
        // No modes at all: no `modes` key, so the payload is what it was before modes existed.
        ...(inputs.modes.length === 0 ? {} : { modes: modeConfigOf(inputs) }),
        now: at,
        onEventFailed: (eventId) => failedEventIds.push(eventId),
      });
    } catch (error) {
      // An unusable time zone: there is nothing to schedule from.
      onError(error);
      return;
    }
    if (payload.truncated) {
      console.warn('The alarm schedule was cut at its size cap; it ends at', payload.horizonEnd);
    }
    last = { inputs, payload, atMs: at.getTime() };
    adapter.setSchedule(payload).catch(onPushFailed);
    // The rest of the schedule is pushed regardless; the user is told that one alarm will not ring.
    if (failedEventIds.length > 0) {
      onError(new Error(`Could not schedule ${failedEventIds.length} alarm(s): ${failedEventIds.join(', ')}`));
    }
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
    useModesStore.subscribe((state, previous) => {
      if (state.modes !== previous.modes || state.rules !== previous.rules || state.activations !== previous.activations) {
        pushSoon();
      }
    }),
    // Exam mode's window is derived from the exams, so moving an exam moves the paused alarms.
    useExamsStore.subscribe((state, previous) => {
      if (state.exams !== previous.exams) pushSoon();
    }),
    subscribeSoundId(pushSoon),
  ];

  // A window coming to the front is when a long-hidden app is most likely to be stale.
  const onFocus = (): void => {
    const inputs = currentInputs();
    if (inputs !== null && isFresh(inputs, now().getTime())) return;
    pushSoon();
  };
  focusTarget?.addEventListener('focus', onFocus);
  const stopResume = resumeSource(onFocus);
  const dailyTimer = setInterval(pushSoon, REPUSH_INTERVAL_MS);

  push();
  return () => {
    if (timer !== null) clearTimeout(timer);
    clearInterval(dailyTimer);
    focusTarget?.removeEventListener('focus', onFocus);
    stopResume();
    stops.forEach((stop) => stop());
  };
}
