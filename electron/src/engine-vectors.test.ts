import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { AlarmSettings, ScheduleEventInfo, ScheduleOccurrence, SchedulePayload } from '@alarm-calendar/core';

import { makeOccurrenceId } from './alarm-ipc';
import { emptyCache } from './cache';
import { FakeClock } from './fake-clock';
import { AlarmScheduler } from './scheduler';

/**
 * The alarm engine scenarios in packages/core/test-vectors/alarm-engine.json are shared with the Android engine
 * (android/app/src/test/.../SharedVectorsTest.kt), which ports this scheduler. Running them here keeps the vectors
 * honest: they describe what the reference engine does, and the Kotlin one must do the same.
 */

interface VectorOccurrence {
  event: string;
  at: string;
  silenced?: boolean;
  completed?: boolean;
  originalAt?: string;
  label?: string;
  labelIfUnlogged?: { id: string; label: string };
  windowEnd?: string;
}

interface VectorList {
  info: Record<string, { title: string; maxSnoozes: number; snoozeMinutes: number }>;
  occurrences: VectorOccurrence[];
}

interface ExpectedRing {
  event: string;
  at: string;
  title: string;
  snoozesLeft: number;
  snoozeLabel: string | null;
  noticeShown: boolean;
  /** Only checked when the row has it; null means the view carries no prayer choices. */
  laterMinutes?: number[] | null;
  cantNow?: 'until_last_call' | 'give_up' | null;
}

interface VectorStep {
  at: string;
  push?: VectorList;
  action?: 'done' | 'snooze' | 'close' | 'later' | 'cantNow';
  event?: string;
  minutes?: number;
  /** For cantNow: the variant the person saw on the button; absent means whatever the view shows right now. */
  variant?: 'until_last_call' | 'give_up';
  ringing?: ExpectedRing[];
  pending?: { event: string; at: string; snoozesUsed: number; doneAt?: string }[];
}

interface Scenario extends VectorList {
  name: string;
  start: string;
  settings: { grace_minutes: number; refire_seconds: number };
  steps: VectorStep[];
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../packages/core/test-vectors/alarm-engine.json', import.meta.url)), 'utf8')
) as { events: Record<string, string>; scenarios: Scenario[] };

const USER_ID = '99999999-9999-4999-8999-999999999999';

function idOf(key: string): string {
  const id = vectors.events[key];
  if (id === undefined) throw new Error(`unknown event key ${key}`);
  return id;
}

function keyOf(eventId: string): string {
  const entry = Object.entries(vectors.events).find(([, id]) => id === eventId);
  if (entry === undefined) throw new Error(`unknown event id ${eventId}`);
  return entry[0];
}

function toPayload(list: VectorList, settings: Scenario['settings'], now: Date): SchedulePayload {
  const occurrences: ScheduleOccurrence[] = list.occurrences.map((o) => ({
    id: makeOccurrenceId(idOf(o.event), new Date(o.at)),
    eventId: idOf(o.event),
    at: o.at,
    silenced: o.silenced ?? false,
    completed: o.completed ?? false,
    ...(o.originalAt === undefined ? {} : { originalAt: o.originalAt }),
    ...(o.label === undefined ? {} : { label: o.label }),
    ...(o.windowEnd === undefined ? {} : { windowEnd: o.windowEnd }),
    ...(o.labelIfUnlogged === undefined
      ? {}
      : {
          labelIfUnlogged: {
            id: idOf(o.labelIfUnlogged.id.split('@')[0]!) + '@' + o.labelIfUnlogged.id.split('@')[1]!,
            label: o.labelIfUnlogged.label,
          },
        }),
  }));
  occurrences.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.eventId < b.eventId ? -1 : 1));
  const eventInfo: Record<string, ScheduleEventInfo> = {};
  for (const [key, info] of Object.entries(list.info)) {
    eventInfo[idOf(key)] = { title: info.title, notes: null, maxSnoozes: info.maxSnoozes, snoozeMinutes: info.snoozeMinutes, soundId: null };
  }
  const alarmSettings: AlarmSettings = {
    user_id: USER_ID,
    timezone: 'UTC',
    week_starts_on: 0,
    pass_cap: 2,
    ...settings,
  };
  return {
    version: 2,
    generatedAt: now.toISOString(),
    horizonEnd: new Date(now.getTime() + 60 * 24 * 3_600_000).toISOString(),
    truncated: false,
    settings: alarmSettings,
    occurrences,
    eventInfo,
    // Nothing to refill from: the scenarios last far less than the hour after which main would re-expand.
    refillSource: { events: [], cheatDays: [] },
  };
}

function leftFromLabel(label: string | null): number {
  const match = label === null ? null : /(\d+) left$/.exec(label);
  return match === null ? 0 : Number(match[1]);
}

describe('shared alarm engine vectors (electron scheduler)', () => {
  for (const scenario of vectors.scenarios) {
    it(scenario.name, () => {
      const cache = emptyCache();
      const clock = new FakeClock(Date.parse(scenario.start));
      const scheduler = new AlarmScheduler({
        cache,
        persist: () => undefined,
        now: clock.now,
        timers: clock.timers,
        newId: () => USER_ID,
        onRing: () => undefined,
        onDismiss: () => undefined,
        log: () => undefined,
      });
      scheduler.start();
      scheduler.setSchedule(toPayload(scenario, scenario.settings, clock.now()));

      for (const step of scenario.steps) {
        clock.advance(Date.parse(step.at) - clock.time);
        if (step.push !== undefined) scheduler.setSchedule(toPayload(step.push, scenario.settings, clock.now()));
        if (step.action !== undefined && step.event !== undefined) {
          const state = cache.occurrences.find((s) => s.eventId === idOf(step.event!) && s.phase === 'ringing');
          const id = state === undefined ? `${idOf(step.event)}@none` : makeOccurrenceId(state.eventId, new Date(state.occurrenceAt));
          if (step.action === 'done') scheduler.done(id);
          else if (step.action === 'snooze') scheduler.snooze(id);
          else if (step.action === 'later') scheduler.later(id, step.minutes ?? 0);
          else if (step.action === 'cantNow') scheduler.cantNow(id, step.variant ?? scheduler.getAlarm(id)?.prayerChoices?.cantNow ?? 'until_last_call');
          else scheduler.windowClosed(id);
        }
        const where = `${scenario.name} @ ${step.at}`;
        if (step.ringing !== undefined) {
          const actual = cache.occurrences
            .filter((s) => s.phase === 'ringing' && s.wakeAt === null)
            .map((s) => {
              const view = scheduler.getAlarm(makeOccurrenceId(s.eventId, new Date(s.occurrenceAt)));
              const event = keyOf(s.eventId);
              const wanted = step.ringing?.find((row) => row.event === event);
              return {
                event,
                at: s.occurrenceAt,
                title: s.title,
                snoozesLeft: leftFromLabel(view?.snoozeLabel ?? null),
                snoozeLabel: view?.snoozeLabel ?? null,
                noticeShown: view?.snoozeNotice != null,
                ...(wanted?.laterMinutes === undefined ? {} : { laterMinutes: view?.prayerChoices?.laterMinutes ?? null }),
                ...(wanted?.cantNow === undefined ? {} : { cantNow: view?.prayerChoices?.cantNow ?? null }),
              };
            })
            .sort((a, b) => (a.event < b.event ? -1 : 1));
          const expected = [...step.ringing].sort((a, b) => (a.event < b.event ? -1 : 1));
          expect(actual, where).toEqual(expected);
        }
        if (step.pending !== undefined) {
          const actual = cache.pendingCompletions
            .map((c) => ({ event: keyOf(c.event_id), at: c.occurrence_at, snoozesUsed: c.snoozes_used, doneAt: c.done_at }))
            .sort((a, b) => (a.event + a.at < b.event + b.at ? -1 : 1));
          // doneAt is only checked for a row that names it (the older scenarios never did).
          const expected = [...step.pending].sort((a, b) => (a.event + a.at < b.event + b.at ? -1 : 1));
          expect(
            actual.map(({ doneAt, ...row }, i) => (expected[i]?.doneAt === undefined ? row : { ...row, doneAt })),
            where
          ).toEqual(expected);
        }
      }
    });
  }
});
