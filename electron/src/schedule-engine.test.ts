import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildSchedulePayload } from '@alarm-calendar/core';
import type { AlarmSettings, EventRow } from '@alarm-calendar/core';

import type { AlarmView } from './alarm-ipc';
import { emptyCache, loadCache } from './cache';
import type { CacheData } from './cache';
import { parseSchedulePayload, upgradeLegacyPayload } from './desktop-payloads';
import { FakeClock } from './fake-clock';
import {
  AlarmScheduler,
  REFILL_MAX_AGE_MS,
  REFILL_MIN_GAP_MS,
} from './scheduler';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const USER = '99999999-9999-4999-8999-999999999999';
const ID = (n: number): string => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

function makeEvent(overrides: Partial<EventRow> & { id: string }): EventRow {
  return {
    user_id: USER,
    title: 'Alarm',
    notes: null,
    start_at: '2026-01-10T08:00:00.000Z',
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
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function settingsFor(timezone: string): AlarmSettings {
  return {
    user_id: USER,
    timezone,
    week_starts_on: 0,
    refire_seconds: 120,
    pass_cap: 2,
    grace_minutes: 30,
  };
}

function createEngine(startMs: number, cache: CacheData = emptyCache()) {
  const clock = new FakeClock(startMs);
  const rings: AlarmView[] = [];
  const logs: string[] = [];
  const scheduler = new AlarmScheduler({
    cache,
    persist: () => undefined,
    now: clock.now,
    timers: clock.timers,
    newId: () => '00000000-0000-4000-8000-000000000001',
    onRing: (view) => rings.push(view),
    onDismiss: () => undefined,
    log: (event) => {
      logs.push(event);
    },
  });
  return { clock, cache, rings, logs, scheduler };
}

type Engine = ReturnType<typeof createEngine>;

/** Lets time pass in steps and presses Done on whatever rang, like a user who always answers. */
function runAnsweringEveryAlarm(engine: Engine, totalMs: number, stepMs: number): void {
  let handled = 0;
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    engine.clock.advance(Math.min(stepMs, totalMs - elapsed));
    for (; handled < engine.rings.length; handled++) {
      engine.scheduler.done(engine.rings[handled]!.occurrenceId);
    }
  }
}

describe('self-refill', () => {
  const START = Date.parse('2026-03-02T09:00:00.000Z');
  const settings = settingsFor('UTC');
  const daily = makeEvent({ id: ID(1), repeat_unit: 'day', start_at: new Date(START + MINUTE).toISOString() });

  function engineWith(events: EventRow[], horizonDays?: number) {
    const engine = createEngine(START);
    engine.scheduler.setSchedule(
      buildSchedulePayload({
        events,
        cheatDays: [],
        settings,
        completions: [],
        now: engine.clock.now(),
        horizonDays,
      })
    );
    engine.scheduler.start();
    return engine;
  }

  const refills = (engine: Engine): number => engine.logs.filter((entry) => entry === 'schedule.refilled').length;

  it('keeps ringing for 100 days although the app never pushes again (the horizon is 60)', () => {
    const engine = engineWith([daily]);
    // Only the occurrence timeouts run (a 30 second loop for 100 days is 288k evaluations).
    engine.clock.dropIntervals();
    runAnsweringEveryAlarm(engine, 100 * DAY, DAY);
    expect(engine.rings).toHaveLength(100);
    expect(engine.rings.at(-1)?.occurrenceAt).toBe(new Date(START + MINUTE + 99 * DAY).toISOString());
  });

  it('refills once the list is a day old, not before', () => {
    const engine = engineWith([daily]);
    engine.clock.advance(REFILL_MAX_AGE_MS - MINUTE);
    expect(refills(engine)).toBe(0);
    engine.clock.advance(MINUTE);
    expect(refills(engine)).toBe(1);
    expect(engine.cache.schedule?.generatedAt).toBe(new Date(START + REFILL_MAX_AGE_MS).toISOString());
    expect(engine.cache.schedule?.horizonEnd).toBe(new Date(START + REFILL_MAX_AGE_MS + 60 * DAY).toISOString());
  });

  it('refills when under 7 days of horizon remain, but not more than hourly', () => {
    // A horizon of 7.01 days is under 7 days left after about 15 minutes.
    const engine = engineWith([daily], 7.01);
    engine.clock.advance(REFILL_MIN_GAP_MS - MINUTE);
    expect(refills(engine)).toBe(0);
    engine.clock.advance(MINUTE);
    expect(refills(engine)).toBe(1);
    // The new list reaches 60 days again, so nothing more follows soon.
    engine.clock.advance(HOUR * 5);
    expect(refills(engine)).toBe(1);
  });

  it('does not re-expand every evaluation when a size cap keeps the horizon short', () => {
    const hourlyEvents = [1, 2, 3, 4].map((n) =>
      makeEvent({ id: ID(n), repeat_unit: 'hour', start_at: new Date(START).toISOString() })
    );
    const engine = engineWith(hourlyEvents);
    expect(engine.cache.schedule?.truncated).toBe(true);
    // Done is never pressed, so an hour of 30 second evaluations must not each expand again.
    engine.clock.advance(HOUR - MINUTE);
    expect(refills(engine)).toBe(0);
  });

  it('refills a list stamped in the future, as after the clock was set back', () => {
    const engine = createEngine(START);
    engine.scheduler.setSchedule(
      buildSchedulePayload({
        events: [daily],
        cheatDays: [],
        settings,
        completions: [],
        now: new Date(START + 3 * DAY),
      })
    );
    engine.scheduler.start();
    expect(refills(engine)).toBe(1);
    expect(engine.cache.schedule?.generatedAt).toBe(new Date(START).toISOString());
  });

  it('applies the cached cheat days and known completions when it refills', () => {
    const engine = createEngine(START);
    const cheatDay = '2026-03-04';
    const firstRing = new Date(START + MINUTE + 2 * DAY);
    engine.scheduler.setSchedule(
      buildSchedulePayload({
        events: [daily],
        cheatDays: [cheatDay],
        settings,
        completions: [{ event_id: daily.id, occurrence_at: new Date(START + MINUTE + 3 * DAY).toISOString() }],
        now: engine.clock.now(),
      })
    );
    engine.scheduler.start();
    runAnsweringEveryAlarm(engine, 5 * DAY, DAY);
    // Mar 2 and Mar 3 ring, Mar 4 is a cheat day, Mar 5 is completed elsewhere, Mar 6 rings.
    expect(engine.rings.map((view) => view.occurrenceAt)).toEqual([
      new Date(START + MINUTE).toISOString(),
      new Date(START + MINUTE + DAY).toISOString(),
      new Date(START + MINUTE + 4 * DAY).toISOString(),
    ]);
    expect(firstRing.toISOString().slice(0, 10)).toBe(cheatDay);
  });

  it('survives a cached time zone that is no longer valid without stopping the evaluation loop', () => {
    const engine = engineWith([daily]);
    engine.cache.settings = { ...settings, timezone: 'Mars/Base' };
    engine.clock.advance(REFILL_MAX_AGE_MS);
    expect(engine.logs).toContain('schedule.refill_failed');
    expect(engine.rings).toHaveLength(1);
  });
});

describe('a push in the events-based format from an older renderer', () => {
  const START = Date.parse('2026-03-02T09:00:00.000Z');

  it('is expanded by main and rings the same alarm, then keeps refilling on its own', () => {
    const event = makeEvent({
      id: ID(1),
      repeat_unit: 'day',
      start_at: new Date(START + MINUTE).toISOString(),
      repeat_weekdays: null,
    });
    const legacyPush = {
      events: [event],
      cheatDays: [],
      settings: settingsFor('UTC'),
      completions: [],
    };
    const parsed = parseSchedulePayload(legacyPush);
    if (!parsed.ok || parsed.version !== 1) throw new Error('expected a version 1 payload');

    const engine = createEngine(START);
    engine.scheduler.setSchedule(upgradeLegacyPayload(parsed.value, engine.clock.now()));
    engine.scheduler.start();
    engine.clock.dropIntervals();
    runAnsweringEveryAlarm(engine, 70 * DAY, DAY);
    expect(engine.rings).toHaveLength(70);
    expect(engine.rings[0]?.title).toBe('Alarm');
  });
});

describe('a version 1 cache from before the precomputed schedule', () => {
  const START = Date.parse('2026-03-02T09:00:00.000Z');
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'alarm-engine-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is re-expanded from its cached events on the first start, and a snoozed alarm survives', () => {
    const event = makeEvent({
      id: ID(1),
      title: 'Take medication',
      repeat_unit: 'day',
      max_snoozes: 3,
      snooze_minutes: 5,
      start_at: new Date(START - 10 * MINUTE).toISOString(),
    });
    const rungAt = new Date(START - 10 * MINUTE).toISOString();
    const file = join(dir, 'cache.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        events: [event],
        cheatDays: [],
        settings: settingsFor('UTC'),
        // The alarm of 10 minutes ago was snoozed once and wakes again in 2 minutes.
        occurrences: [
          {
            eventId: event.id,
            occurrenceAt: rungAt,
            snoozesUsed: 1,
            phase: 'snoozed',
            wakeAt: new Date(START + 2 * MINUTE).toISOString(),
          },
        ],
        handledThrough: { [event.id]: rungAt },
        pendingCompletions: [],
        knownCompletions: [],
        autostartInitialized: true,
      })
    );

    const migrationLog: string[] = [];
    const cache = loadCache(file, (entry) => migrationLog.push(entry));
    expect(migrationLog).toContain('cache.migrated');
    expect(cache.version).toBe(2);
    expect(cache.schedule).toBeNull();

    const engine = createEngine(START, cache);
    engine.scheduler.start();
    expect(engine.logs).toContain('schedule.refilled');
    expect(cache.schedule?.occurrences.length).toBeGreaterThan(50);

    // The snoozed alarm wakes with the title and the rules it had, one snooze already used.
    engine.clock.advance(2 * MINUTE);
    expect(engine.rings).toHaveLength(1);
    expect(engine.rings[0]).toMatchObject({
      title: 'Take medication',
      occurrenceAt: rungAt,
      snoozeLabel: 'Snooze 5 min (2 left)',
    });
    // And tomorrow's occurrence is in the refilled list: Done now, then the next day rings.
    engine.scheduler.done(engine.rings[0]!.occurrenceId);
    engine.clock.advance(DAY);
    expect(engine.rings).toHaveLength(2);
    expect(engine.rings[1]?.occurrenceAt).toBe(new Date(START - 10 * MINUTE + DAY).toISOString());
  });
});
