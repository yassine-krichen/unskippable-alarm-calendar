import { describe, expect, it } from 'vitest';

import { buildSchedulePayload, localDateString, occurrencesBetween } from '@alarm-calendar/core';
import type { AlarmSettings, CompletionRow, EventRow } from '@alarm-calendar/core';

import { emptyCache as emptyLegacyCache } from '../test-fixtures/legacy/legacy-cache';
import { AlarmScheduler as LegacyScheduler } from '../test-fixtures/legacy/legacy-scheduler';
import type { AlarmView } from './alarm-ipc';
import { emptyCache } from './cache';
import { FakeClock } from './fake-clock';
import { AlarmScheduler } from './scheduler';

/**
 * The per-event scheduler of phase 2 (a frozen copy, see test-fixtures/legacy) and the list-driven
 * one run side by side on one fake clock, get the same pushes and the same user actions, and must
 * ring the same occurrences at the same instants with the same snooze counters.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const USER = '99999999-9999-4999-8999-999999999999';
const ID = (n: number): string =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

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
    sound: 'chime',
  };
}

// Wall-clock times are chosen so the DST windows matter: 02:30 in Paris does not exist on
// 2026-03-29 and happens twice on 2026-10-25.
function fixture(startMs: number, hourlyInterval = 1): EventRow[] {
  return [
    makeEvent({ id: ID(1), title: 'daily 02:30 Paris', repeat_unit: 'day', start_at: '2026-01-10T01:30:00.000Z' }),
    makeEvent({
      id: ID(2),
      title: 'weekly Mon Wed Fri',
      repeat_unit: 'week',
      repeat_weekdays: [0, 2, 4],
      start_at: '2026-01-05T07:00:00.000Z',
    }),
    makeEvent({ id: ID(3), title: 'monthly 31st', repeat_unit: 'month', start_at: '2026-01-31T08:00:00.000Z' }),
    makeEvent({ id: ID(4), title: 'yearly Feb 29', repeat_unit: 'year', start_at: '2024-02-29T10:00:00.000Z' }),
    makeEvent({
      id: ID(5),
      title: 'hourly, not passable',
      repeat_unit: 'hour',
      repeat_interval: hourlyInterval,
      passable: false,
      start_at: '2026-01-01T00:00:00.000Z',
    }),
    makeEvent({ id: ID(6), title: 'one-off', start_at: new Date(startMs + 3 * HOUR).toISOString() }),
    makeEvent({
      id: ID(7),
      title: 'daily until day 10',
      repeat_unit: 'day',
      start_at: '2026-02-01T12:00:00.000Z',
      ends_at: new Date(startMs + 10 * DAY).toISOString(),
    }),
    makeEvent({ id: ID(8), title: 'inactive', repeat_unit: 'day', active: false }),
    makeEvent({
      id: ID(9),
      title: 'every 2 weeks Sunday',
      repeat_unit: 'week',
      repeat_interval: 2,
      repeat_weekdays: [6],
      start_at: '2026-01-04T18:00:00.000Z',
    }),
  ];
}

/** The events that keep running when nobody answers: few enough to stay fast, dense enough to matter. */
const SHORT_IDS = [ID(1), ID(2), ID(5), ID(6)];

interface Ring {
  occurrenceId: string;
  atMs: number;
  snoozeLabel: string | null;
}

/** One engine under test, seen through the little surface both implementations share. */
interface Probe {
  name: string;
  rings: Ring[];
  handled: number;
  scheduler: {
    start(): void;
    done(id: string): boolean;
    snooze(id: string): boolean;
    windowClosed(id: string): void;
  };
  push(events: EventRow[], cheatDays: string[], completions: CompletionRow[]): void;
  pending(): string[];
}

function makeProbes(clock: FakeClock, settings: AlarmSettings): [Probe, Probe] {
  const make = (name: string, build: (onRing: (view: AlarmView) => void) => Probe['scheduler'], push: Probe['push'], pending: () => string[]): Probe => {
    const rings: Ring[] = [];
    const scheduler = build((view) =>
      rings.push({ occurrenceId: view.occurrenceId, atMs: clock.time, snoozeLabel: view.snoozeLabel })
    );
    return { name, rings, handled: 0, scheduler, push, pending };
  };
  const common = {
    now: clock.now,
    timers: clock.timers,
    newId: () => '00000000-0000-4000-8000-000000000001',
    onDismiss: () => undefined,
    log: () => undefined,
    persist: () => undefined,
  };

  const legacyCache = emptyLegacyCache();
  let legacy!: LegacyScheduler;
  const old = make(
    'per-event (phase 2)',
    (onRing) => (legacy = new LegacyScheduler({ ...common, cache: legacyCache, onRing })),
    (events, cheatDays, completions) => legacy.setSchedule(events, cheatDays, settings, completions),
    () => legacyCache.pendingCompletions.map(pendingKey)
  );

  const cache = emptyCache();
  let list!: AlarmScheduler;
  const next = make(
    'list-driven',
    (onRing) => (list = new AlarmScheduler({ ...common, cache, onRing })),
    (events, cheatDays, completions) =>
      list.setSchedule(buildSchedulePayload({ events, cheatDays, settings, completions, now: clock.now() })),
    () => cache.pendingCompletions.map(pendingKey)
  );
  return [old, next];
}

const pendingKey = (row: CompletionRow): string => `${row.event_id}@${row.occurrence_at}#${row.snoozes_used}`;

type Policy = (probe: Probe, ring: Ring) => void;

/** The user presses Done on every alarm at once. */
const answerEveryAlarm: Policy = (probe, ring) => {
  probe.scheduler.done(ring.occurrenceId);
};

/** The user closes the window without choosing: the alarm comes back after refire_seconds. */
const closeEveryWindow: Policy = (probe, ring) => {
  probe.scheduler.windowClosed(ring.occurrenceId);
};

/** The user snoozes while the button is offered, then gives in and presses Done. */
const snoozeToTheLimit: Policy = (probe, ring) => {
  if (ring.snoozeLabel === null || !probe.scheduler.snooze(ring.occurrenceId)) {
    probe.scheduler.done(ring.occurrenceId);
  }
};

interface Scenario {
  startMs: number;
  settings: AlarmSettings;
  events: EventRow[];
  totalMs: number;
  stepMs: number;
  policy: Policy;
  /** Keeps the 30 second loop; most runs rely on the occurrence timeouts alone to stay fast. */
  keepInterval?: boolean;
  /** Pushes new events to both engines when the clock first reaches `atMs`. */
  repush?: { atMs: number; events: EventRow[] };
}

function run(scenario: Scenario): { old: Probe; next: Probe; clock: FakeClock } {
  const { startMs, settings, totalMs, stepMs, policy } = scenario;
  const clock = new FakeClock(startMs);
  const probes = makeProbes(clock, settings);
  const cheatDays = [3, 10, 11].map((d) => localDateString(new Date(startMs + d * DAY), settings.timezone));
  // One occurrence of the first event that another device already completed.
  const first = scenario.events[0]!;
  const completedAt = occurrencesBetween(
    first,
    new Date(startMs),
    new Date(startMs + 30 * DAY),
    settings.timezone
  )[1]!;
  const completions: CompletionRow[] = [
    {
      id: '33333333-3333-4333-8333-333333333333',
      user_id: USER,
      event_id: first.id,
      occurrence_at: completedAt.toISOString(),
      status: 'done',
      snoozes_used: 0,
      done_at: completedAt.toISOString(),
    },
  ];

  for (const probe of probes) {
    probe.scheduler.start();
    probe.push(scenario.events, cheatDays, completions);
  }
  if (!scenario.keepInterval) clock.dropIntervals();

  let repushed = false;
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    clock.advance(stepMs);
    if (scenario.repush && !repushed && clock.time >= scenario.repush.atMs) {
      repushed = true;
      for (const probe of probes) probe.push(scenario.repush.events, cheatDays, completions);
    }
    for (const probe of probes) {
      // Same user, same moment, for both engines.
      for (; probe.handled < probe.rings.length; probe.handled++) {
        policy(probe, probe.rings[probe.handled]!);
      }
    }
  }
  return { old: probes[0], next: probes[1], clock };
}

/** Ring sequence, ordered by instant then id (two events ringing at one instant have no fixed order). */
function sequence(probe: Probe): string[] {
  return [...probe.rings]
    .sort((a, b) => a.atMs - b.atMs || (a.occurrenceId < b.occurrenceId ? -1 : 1))
    .map((ring) => `${ring.atMs} ${ring.occurrenceId} ${ring.snoozeLabel ?? '-'}`);
}

function expectSameBehaviour({ old, next }: { old: Probe; next: Probe }, minRings: number): void {
  const expected = sequence(old);
  expect(expected.length).toBeGreaterThanOrEqual(minRings);
  expect(sequence(next)).toEqual(expected);
  expect([...next.pending()].sort()).toEqual([...old.pending()].sort());
}

const windows = [
  ['late February (Feb 28 clamps for the Feb 29 and the 31st series)', Date.parse('2026-02-24T00:07:00.000Z')],
  ['around the spring DST change', Date.parse('2026-03-25T00:07:00.000Z')],
  ['around the autumn DST change', Date.parse('2026-10-22T00:07:00.000Z')],
] as const;

// These run every alarm for 30 days on a fake clock; under load (a parallel `pnpm -r test`) the default 5 s is too tight.
describe('parity with the per-event scheduler', { timeout: 30_000 }, () => {
  describe('every alarm answered at once, over 30 days', () => {
    const cases: Array<[string, string, number]> = [
      ...windows.map(([label, startMs]) => ['Europe/Paris', label, startMs] as [string, string, number]),
      ['Africa/Tunis', windows[1][0], windows[1][1]],
    ];
    it.each(cases)('in %s, %s', (timezone, _label, startMs) => {
      // The hourly alarm runs every hour in the spring window and every 6 hours elsewhere, to keep the suite quick.
      const hourlyInterval = startMs === windows[1][1] ? 1 : 6;
      const result = run({
        startMs,
        settings: settingsFor(timezone),
        events: fixture(startMs, hourlyInterval),
        totalMs: 30 * DAY,
        stepMs: 30 * MINUTE,
        policy: answerEveryAlarm,
      });
      expectSameBehaviour(result, 150);
      // A completed occurrence, and cheat days, are in there: neither engine rang them.
      expect(result.next.pending().length).toBeGreaterThan(150);
    });
  });

  it('never answered: a closed window refires every refire_seconds and later occurrences are dropped', () => {
    // Twelve hours across the spring DST change in Paris; the hourly alarm is stuck ringing from the first ring.
    const startMs = Date.parse('2026-03-28T20:07:00.000Z');
    const result = run({
      startMs,
      settings: settingsFor('Europe/Paris'),
      events: fixture(startMs).filter((event) => SHORT_IDS.includes(event.id)),
      totalMs: 12 * HOUR,
      stepMs: MINUTE,
      policy: closeEveryWindow,
    });
    expectSameBehaviour(result, 150);
    // Re-rings of one alarm are exactly refire_seconds apart, not occurrences of the schedule.
    const hourly = result.next.rings.filter((ring) => ring.occurrenceId.startsWith(ID(5)));
    expect(new Set(hourly.map((ring) => ring.occurrenceId.slice(37))).size).toBeLessThan(3);
  });

  it('snoozed to the limit, then done: the counters and the wake-up instants agree', () => {
    const startMs = Date.parse('2026-03-27T00:07:00.000Z');
    const result = run({
      startMs,
      settings: settingsFor('Europe/Paris'),
      events: fixture(startMs),
      totalMs: 3 * DAY,
      stepMs: MINUTE,
      policy: snoozeToTheLimit,
    });
    expectSameBehaviour(result, 200);
    const labels = new Set(result.next.rings.map((ring) => ring.snoozeLabel));
    expect(labels).toEqual(
      new Set(['Snooze 5 min · 3 left', 'Snooze 5 min · 2 left', 'Snooze 5 min · 1 left', null])
    );
  });

  it('a re-push in the middle of the run with an edited event time', () => {
    const startMs = Date.parse('2026-03-28T00:07:00.000Z');
    const events = fixture(startMs);
    const edited = events.map((event) => {
      if (event.id === ID(1)) return { ...event, start_at: '2026-01-10T02:15:00.000Z', title: 'daily, moved' };
      if (event.id === ID(2)) return { ...event, active: false };
      if (event.id === ID(6)) return { ...event, start_at: new Date(startMs + 2 * DAY).toISOString() };
      return event;
    });
    edited.push(makeEvent({ id: ID(7).replace(/7/g, 'a'), title: 'added later', repeat_unit: 'day', start_at: '2026-03-01T09:00:00.000Z' }));
    const result = run({
      startMs,
      settings: settingsFor('Europe/Paris'),
      events,
      totalMs: 4 * DAY,
      stepMs: 5 * MINUTE,
      policy: answerEveryAlarm,
      repush: { atMs: startMs + 1.5 * DAY, events: edited },
    });
    expectSameBehaviour(result, 100);
    const ringsOfEdited = result.next.rings.filter((ring) => ring.occurrenceId.startsWith(ID(1)));
    expect(ringsOfEdited.some((ring) => ring.occurrenceId.includes('T01:15:00'))).toBe(true);
  });
});
