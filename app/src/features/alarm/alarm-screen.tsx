import type { AlarmView } from '@alarm-calendar/core';
import { AlarmClockIcon, CheckIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

import { Button } from '@/components/ui/button';

import { CUSTOM_SOUND_ID, DEFAULT_SOUND_ID, soundUrl } from './alarm-sounds';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; view: AlarmView }
  | { kind: 'unavailable'; message: string };

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * The desktop alarm window (spec sections 6 and 9): what is ringing, when, and two ways out.
 * Done is the one primary action; Snooze is shown only while snoozes are left, and says how many.
 * There is deliberately no close control: the window is the alarm, and main re-opens it if it
 * goes away without a choice. Always black and white, whatever the app theme. Laid out for the centered, semi-transparent
 * panel main opens (about 560x440), not for a full screen.
 */
export function AlarmScreen() {
  const [params] = useSearchParams();
  const occurrenceId = params.get('occurrence');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Set while the user's own sound file is playing from a blob; released with the window.
  const objectUrlRef = useRef<string | null>(null);

  const startSound = useCallback(async (soundId: string | null, occurrence: string | null) => {
    let source = soundUrl(soundId);
    if (soundId === CUSTOM_SOUND_ID && occurrence !== null) {
      // The file belongs to the main process; this window only gets its bytes, never a path.
      try {
        const custom = await window.alarmApi?.readCustomSound(occurrence);
        if (custom) {
          objectUrlRef.current = URL.createObjectURL(new Blob([custom.data as BlobPart], { type: custom.mime }));
          source = objectUrlRef.current;
        }
      } catch {
        // Falls back to the bundled tone below: a silent prayer alarm is worse than the wrong sound.
      }
    }
    const audio = new Audio(source);
    audio.loop = true;
    audio.volume = 1;
    audioRef.current = audio;
    // A chosen file that will not decode must not leave the alarm silent.
    audio.addEventListener(
      'error',
      () => {
        if (audioRef.current !== audio) return;
        const fallback = new Audio(soundUrl(DEFAULT_SOUND_ID));
        fallback.loop = true;
        audioRef.current = fallback;
        fallback.play().catch(() => setProblem("The alarm sound couldn't start. The alarm is still active."));
      },
      { once: true }
    );
    audio.play().catch(() => {
      // The error listener handles an undecodable file; anything else is reported.
      if (audio.error === null) setProblem("The alarm sound couldn't start. The alarm is still active.");
    });
  }, []);

  useEffect(() => {
    const api = window.alarmApi;
    if (api === undefined || occurrenceId === null) {
      setState({
        kind: 'unavailable',
        message: 'Alarms ring in the desktop or Android app, not in the browser.',
      });
      return;
    }
    let cancelled = false;
    api
      .getAlarm(occurrenceId)
      .then((view) => {
        if (cancelled) return;
        // Sound starts whatever happens: a silent alarm is worse than an unstyled one.
        void startSound(view?.soundId ?? null, occurrenceId);
        setState(
          view === null
            ? { kind: 'unavailable', message: 'This alarm is no longer active.' }
            : { kind: 'ready', view }
        );
      })
      .catch(() => {
        if (cancelled) return;
        void startSound(null, null);
        setState({
          kind: 'unavailable',
          message: "Couldn't load this alarm. Reopen it from the tray.",
        });
      });
    return () => {
      cancelled = true;
      audioRef.current?.pause();
      if (objectUrlRef.current !== null) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, [occurrenceId, startSound]);

  async function choose(action: 'done' | 'snooze'): Promise<void> {
    const api = window.alarmApi;
    if (api === undefined || occurrenceId === null) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await api[action](occurrenceId);
      if (result.ok) {
        // Main closes this window right after; stop the sound first so it never lingers.
        audioRef.current?.pause();
        return;
      }
      // The state moved under us (for example the last snooze was just used): redraw from main.
      const view = await api.getAlarm(occurrenceId);
      if (view !== null) setState({ kind: 'ready', view });
    } catch {
      // This window is the only way out of the alarm: never leave its buttons dead.
      setProblem("That didn't work. Try again.");
    }
    setBusy(false);
  }

  return (
    <main className="dark flex h-dvh flex-col items-center justify-center gap-4 border border-white/20 bg-black px-8 py-6 text-center text-white">
      {state.kind === 'loading' ? (
        <p className="text-xl text-neutral-400" role="status">
          Loading alarm
        </p>
      ) : null}

      {state.kind === 'unavailable' ? (
        <p className="max-w-md text-2xl font-semibold" role="status">
          {state.message}
        </p>
      ) : null}

      {state.kind === 'ready' ? (
        <>
          <p className="text-7xl font-bold tabular-nums tracking-tight">
            {formatTime(state.view.occurrenceAt)}
          </p>
          <h1 className="line-clamp-2 max-w-full text-3xl font-semibold text-balance">
            {state.view.title}
          </h1>
          {state.view.notes ? (
            <p className="line-clamp-2 max-w-full text-base text-neutral-400">{state.view.notes}</p>
          ) : null}

          {/* Stacked, equal width: Done is the one primary action, Snooze the quieter way out. */}
          <div className="mt-2 flex w-full max-w-sm flex-col gap-3">
            <Button
              autoFocus
              size="lg"
              disabled={busy}
              onClick={() => void choose('done')}
              className="h-14 w-full gap-3 rounded-2xl text-xl font-semibold"
            >
              <CheckIcon className="size-6" />
              {state.view.kind === 'prayer' ? 'Prayed' : 'Done'}
            </Button>
            {state.view.snoozeLabel !== null ? (
              <Button
                size="lg"
                variant="outline"
                disabled={busy}
                onClick={() => void choose('snooze')}
                className="h-14 w-full gap-3 rounded-2xl text-lg font-semibold"
              >
                <AlarmClockIcon className="size-5" />
                {state.view.snoozeLabel}
              </Button>
            ) : null}
          </div>

          {state.view.snoozeNotice !== null ? (
            <p className="text-lg font-semibold">{state.view.snoozeNotice}</p>
          ) : null}
        </>
      ) : null}

      {problem !== null ? (
        <p className="text-base text-neutral-300" role="alert">
          {problem}
        </p>
      ) : null}
    </main>
  );
}
