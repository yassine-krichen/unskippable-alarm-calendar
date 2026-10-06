import { describe, expect, it } from 'vitest';

import { buildSchedulePayload } from '@alarm-calendar/core';
import type {
  AlarmSettings,
  CompletionRow,
  EventRow,
  SchedulePayload,
  Settings,
} from '@alarm-calendar/core';

import type { AlarmView } from './alarm-ipc';
import { emptyCache } from './cache';
import type { CacheData } from './cache';
import { AlarmScheduler, KNOWN_COMPLETION_RETENTION_MS } from './scheduler';
import type { Timers } from './scheduler';

const MINUTE = 60_000;
const START = Date.parse('2026-03-02T09:00:00.000Z');
const USER = '99999999-9999-4999-8999-999999999999';
const EVENT = '11111111-1111-4111-8111-111111111111';

const SETTINGS: Settings = {
  user_id: USER,
  timezone: 'UTC',
  week_starts_on: 0,
  refire_seconds: 120,
  pass_cap: 2,
  grace_minutes: 30,
};

// Timers never fire: these tests drive evaluate() by hand, like a resume after sleep.
const inertTimers: Timers = {
  setTimeout: () => 1,
  clearTimeout: () => undefined,
  setInterval: () => 1,
  clearInterval: () => undefined,
};

function makeEvent(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: EVENT,
    user_id: USER,
    title: 'Take medication',
    notes: null,
    start_at: new Date(START + MINUTE).toISOString(),
    duration_min: 15,
    repeat_unit: 'none',
    repeat_interval: 1,
    repeat_weekdays: null,
    ends_at: null,
    max_snoozes: 3,
    snooze_minutes: 5,
    passable: true,
    color: null,
    active: true,
    updated_at: new Date(START).toISOString(),
    ...overrides,
  };
}

function completion(occurrenceAt: string, overrides: Partial<CompletionRow> = {}): CompletionRow {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    user_id: USER,
    event_id: EVENT,
    occurrence_at: occurrenceAt,
    status: 'done',
    snoozes_used: 0,
    done_at: occurrenceAt,
    ...overrides,
  };
}

function createHarness(cache: CacheData = emptyCache()) {
  let time = START;
  const rings: AlarmView[] = [];
  const scheduler = new AlarmScheduler({
    cache,
    persist: () => undefined,
    now: () => new Date(time),
    timers: inertTimers,
    newId: () => '44444444-4444-4444-8444-444444444444',
    onRing: (view) => rings.push(view),
    onDismiss: () => undefined,
    log: () => undefined,
  });
  return {
    cache,
    rings,
    scheduler,
    /** What the app does: expands the events at the current time, completions folded in, and pushes the list. */
    push(
      events: EventRow[],
      cheatDays: string[],
      settings: AlarmSettings,
      completions: CompletionRow[] = []
    ): void {
      scheduler.setSchedule(
        buildSchedulePayload({ events, cheatDays, settings, completions, now: new Date(time) })
      );
    },
    scheduleOf(
      events: EventRow[],
      extra: (payload: SchedulePayload) => void
    ): void {
      const payload = buildSchedulePayload({
        events,
        cheatDays: [],
        settings: SETTINGS,
        completions: [],
        now: new Date(time),
      });
      extra(payload);
      scheduler.setSchedule(payload);
    },
    // The machine was asleep through the alarm and wakes up `ms` after START.
    wakeAt(ms: number): void {
      time = START + ms;
      scheduler.evaluate('resume');
    },
  };
}

describe('completed occurrences and the grace window', () => {
  it('rings an occurrence missed during sleep when nothing says it was done (control)', () => {
    const h = createHarness();
    h.push([makeEvent()], [], SETTINGS);
    h.wakeAt(10 * MINUTE);
    expect(h.rings).toHaveLength(1);
  });

  it('does not ring on resume an occurrence another device already completed', () => {
    const h = createHarness();
    const occurrenceAt = new Date(START + MINUTE).toISOString();
    h.push([makeEvent()], [], SETTINGS, [completion(occurrenceAt)]);
    h.wakeAt(10 * MINUTE);
    expect(h.rings).toHaveLength(0);
  });

  it('matches a synced completion written with a +00:00 offset, as Supabase returns it', () => {
    const h = createHarness();
    const synced = completion('2026-03-02T09:01:00+00:00');
    h.push([makeEvent()], [], SETTINGS, [synced]);
    h.wakeAt(10 * MINUTE);
    expect(h.rings).toHaveLength(0);
  });

  it('does not ring an occurrence done on this device whose completion is still pending', () => {
    // A cache without watermarks, as written before they existed: only the pending row knows.
    const cache = emptyCache();
    cache.pendingCompletions.push(completion(new Date(START + MINUTE).toISOString()));
    const h = createHarness(cache);
    h.push([makeEvent()], [], SETTINGS);
    h.wakeAt(10 * MINUTE);
    expect(h.rings).toHaveLength(0);
  });

  it('still rings today when only yesterday of a repeating event was completed', () => {
    const h = createHarness();
    const daily = makeEvent({
      repeat_unit: 'day',
      start_at: new Date(START - 24 * 60 * MINUTE + MINUTE).toISOString(),
    });
    const yesterday = new Date(START - 24 * 60 * MINUTE + MINUTE).toISOString();
    h.push([daily], [], SETTINGS, [completion(yesterday)]);
    h.wakeAt(10 * MINUTE);
    expect(h.rings).toHaveLength(1);
    expect(h.rings[0]?.occurrenceAt).toBe(new Date(START + MINUTE).toISOString());
  });

  it('does not ring a completed occurrence again after the cache is reloaded', () => {
    const first = createHarness();
    const occurrenceAt = new Date(START + MINUTE).toISOString();
    first.push([makeEvent()], [], SETTINGS, [completion(occurrenceAt)]);

    // Same data through a JSON round trip, as the app being restarted. Watermarks dropped to
    // prove the known completion alone is what suppresses the ring.
    const reloaded = JSON.parse(JSON.stringify(first.cache)) as CacheData;
    reloaded.handledThrough = {};
    const second = createHarness(reloaded);
    second.wakeAt(10 * MINUTE);
    expect(second.rings).toHaveLength(0);
  });
});

describe('known completions merge', () => {
  it('keeps a completion seen earlier when a later sync carries none', () => {
    const h = createHarness();
    const occurrenceAt = new Date(START + MINUTE).toISOString();
    h.push([makeEvent()], [], SETTINGS, [completion(occurrenceAt)]);
    h.push([makeEvent()], [], SETTINGS, []);
    expect(h.cache.knownCompletions).toHaveLength(1);
  });

  it('does not duplicate a completion that arrives twice', () => {
    const h = createHarness();
    const occurrenceAt = new Date(START + MINUTE).toISOString();
    const row = completion(occurrenceAt);
    h.push([makeEvent()], [], SETTINGS, [row, row]);
    h.push([makeEvent()], [], SETTINGS, [row]);
    h.scheduler.markCompleted(row);
    expect(h.cache.knownCompletions).toHaveLength(1);
  });

  it('forgets completions older than the retention window', () => {
    const h = createHarness();
    const old = new Date(START - KNOWN_COMPLETION_RETENTION_MS - MINUTE).toISOString();
    const recent = new Date(START - MINUTE).toISOString();
    // Occurrences this old are never in a list core builds (it reaches back by the grace window),
    // so they are added by hand: the scheduler's own pruning is what is under test.
    h.scheduleOf([makeEvent()], (payload) => {
      for (const at of [old, recent]) {
        payload.occurrences.push({
          id: `${EVENT}@${at}`,
          eventId: EVENT,
          at,
          silenced: false,
          completed: true,
        });
      }
    });
    expect(h.cache.knownCompletions).toEqual([`${EVENT}@${recent}`]);
  });
});

describe('sound on the alarm view', () => {
  it('passes the sound from the pushed settings to the alarm screen, null when unset', () => {
    const withSound = createHarness();
    withSound.push([makeEvent()], [], { ...SETTINGS, sound: 'chime' });
    withSound.wakeAt(2 * MINUTE);
    expect(withSound.rings[0]?.soundId).toBe('chime');

    const without = createHarness();
    without.push([makeEvent()], [], SETTINGS);
    without.wakeAt(2 * MINUTE);
    expect(without.rings[0]?.soundId).toBeNull();
  });
});
