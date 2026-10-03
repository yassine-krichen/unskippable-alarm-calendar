import { describe, expect, it } from 'vitest';

import type { EventRow, Settings } from '@alarm-calendar/core';

import type { AlarmView } from './alarm-ipc';
import { emptyCache } from './cache';
import type { CacheData } from './cache';
import { AlarmScheduler, REEVALUATE_INTERVAL_MS } from './scheduler';
import type { Timers } from './scheduler';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

// Monday 2026-03-02 09:00 UTC; UTC keeps the wall-clock math out of these tests.
const START = Date.parse('2026-03-02T09:00:00.000Z');

const EVENT_A = '11111111-1111-4111-8111-111111111111';
const EVENT_B = '22222222-2222-4222-8222-222222222222';

interface FakeTimer {
  at: number;
  callback: () => void;
  interval: number | null;
}

class FakeClock {
  time = START;
  private nextId = 1;
  private readonly pending = new Map<number, FakeTimer>();
  /** Every delay ever passed to setTimeout, to check what the scheduler asked for. */
  readonly timeoutDelays: number[] = [];

  readonly timers: Timers = {
    setTimeout: (callback, ms) => {
      this.timeoutDelays.push(ms);
      return this.add(callback, ms, null);
    },
    clearTimeout: (handle) => this.pending.delete(handle as number),
    setInterval: (callback, ms) => this.add(callback, ms, ms),
    clearInterval: (handle) => this.pending.delete(handle as number),
  };

  now = (): Date => new Date(this.time);

  get timerCount(): number {
    return this.pending.size;
  }

  /** Forgets every pending one-shot timeout, as if the timer had drifted or never fired. */
  dropTimeouts(): void {
    for (const [id, timer] of this.pending) {
      if (timer.interval === null) this.pending.delete(id);
    }
  }

  dropIntervals(): void {
    for (const [id, timer] of this.pending) {
      if (timer.interval !== null) this.pending.delete(id);
    }
  }

  /** Runs timers in order up to the new time, like real time passing while awake. */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const next = [...this.pending.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (next === undefined) break;
      const [id, timer] = next;
      this.time = Math.max(this.time, timer.at);
      if (timer.interval === null) this.pending.delete(id);
      else timer.at += timer.interval;
      timer.callback();
    }
    this.time = target;
  }

  /** Moves the clock without running any timer, like the machine being asleep. */
  sleepFor(ms: number): void {
    this.time += ms;
  }

  private add(callback: () => void, ms: number, interval: number | null): number {
    const id = this.nextId++;
    this.pending.set(id, { at: this.time + ms, callback, interval });
    return id;
  }
}

function makeEvent(overrides: Partial<EventRow> & { id: string }): EventRow {
  return {
    user_id: '99999999-9999-4999-8999-999999999999',
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

const SETTINGS: Settings = {
  user_id: '99999999-9999-4999-8999-999999999999',
  timezone: 'UTC',
  week_starts_on: 0,
  refire_seconds: 120,
  pass_cap: 2,
  grace_minutes: 30,
};

interface HarnessOptions {
  onRing?(view: AlarmView, attempt: number): void;
}

function createHarness(cache: CacheData = emptyCache(), options: HarnessOptions = {}) {
  const clock = new FakeClock();
  const rings: AlarmView[] = [];
  const dismissed: string[] = [];
  const logs: string[] = [];
  let ringAttempts = 0;
  let afterEvaluateCount = 0;
  let idCounter = 0;
  let persistCount = 0;
  const scheduler = new AlarmScheduler({
    cache,
    persist: () => {
      persistCount++;
    },
    now: clock.now,
    timers: clock.timers,
    newId: () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, '0')}`,
    onRing: (view) => {
      options.onRing?.(view, ++ringAttempts);
      rings.push(view);
    },
    onDismiss: (id) => dismissed.push(id),
    afterEvaluate: () => {
      afterEvaluateCount++;
    },
    log: (event) => {
      logs.push(event);
    },
  });
  return {
    clock,
    cache,
    rings,
    dismissed,
    logs,
    scheduler,
    get afterEvaluateCount() {
      return afterEvaluateCount;
    },
    get persistCount() {
      return persistCount;
    },
  };
}

function ringingView(rings: AlarmView[]): AlarmView {
  const view = rings.at(-1);
  if (view === undefined) throw new Error('expected an alarm to be ringing');
  return view;
}

describe('AlarmScheduler', () => {
  it('rings an event at its start time and not before', () => {
    const h = createHarness();
    h.scheduler.setSchedule([makeEvent({ id: EVENT_A })], [], SETTINGS);
    h.scheduler.start();

    h.clock.advance(MINUTE - SECOND);
    expect(h.rings).toHaveLength(0);

    h.clock.advance(SECOND);
    expect(h.rings).toHaveLength(1);
    expect(h.rings[0]).toMatchObject({
      title: 'Take medication',
      occurrenceAt: new Date(START + MINUTE).toISOString(),
    });
  });

  it('uses one timeout aimed at the soonest event', () => {
    const h = createHarness();
    h.scheduler.setSchedule(
      [
        makeEvent({ id: EVENT_A, start_at: new Date(START + 10 * MINUTE).toISOString() }),
        makeEvent({ id: EVENT_B, start_at: new Date(START + 5 * MINUTE).toISOString() }),
      ],
      [],
      SETTINGS
    );
    h.scheduler.start();
    // One interval for the 30 s re-evaluation plus exactly one timeout.
    expect(h.clock.timerCount).toBe(2);

    h.clock.advance(5 * MINUTE);
    expect(h.rings.map((r) => r.occurrenceAt)).toEqual([
      new Date(START + 5 * MINUTE).toISOString(),
    ]);
  });

  it('re-evaluates every 30 seconds so a drifted timer cannot miss an alarm', () => {
    const h = createHarness();
    h.scheduler.setSchedule([makeEvent({ id: EVENT_A })], [], SETTINGS);
    h.scheduler.start();

    // The one-shot timeout never fires; only the interval is left to notice.
    h.clock.dropTimeouts();
    h.clock.advance(MINUTE - SECOND);
    expect(h.rings).toHaveLength(0);
    h.clock.advance(SECOND);
    expect(h.rings).toHaveLength(1);
  });

  it('clamps the timeout to the 32-bit limit for an event more than 25 days away', () => {
    const maxTimeoutMs = 2 ** 31 - 1;
    const thirtyDays = 30 * 24 * HOUR;
    const h = createHarness();
    h.scheduler.setSchedule(
      [makeEvent({ id: EVENT_A, start_at: new Date(START + thirtyDays).toISOString() })],
      [],
      SETTINGS
    );
    h.scheduler.start();
    h.clock.dropIntervals();
    expect(h.clock.timeoutDelays.at(-1)).toBe(maxTimeoutMs);

    // The clamped timeout fires early, finds nothing due and re-arms for the rest.
    h.clock.advance(maxTimeoutMs);
    expect(h.rings).toHaveLength(0);
    expect(h.clock.timeoutDelays.at(-1)).toBe(thirtyDays - maxTimeoutMs);
    h.clock.advance(thirtyDays - maxTimeoutMs);
    expect(h.rings).toHaveLength(1);
  });

  it('tells the host after every evaluation and logs only when something happened', () => {
    const h = createHarness();
    h.scheduler.setSchedule([makeEvent({ id: EVENT_A })], [], SETTINGS);
    h.scheduler.start();
    const evaluationsBefore = h.afterEvaluateCount;
    const logsBefore = h.logs.length;

    h.clock.advance(30 * SECOND);
    expect(h.afterEvaluateCount).toBeGreaterThan(evaluationsBefore);
    expect(h.logs).toHaveLength(logsBefore);
  });

  describe('snoozing', () => {
    it('allows exactly max_snoozes snoozes, then offers none', () => {
      const h = createHarness();
      h.scheduler.setSchedule(
        [makeEvent({ id: EVENT_A, max_snoozes: 3, snooze_minutes: 5 })],
        [],
        SETTINGS
      );
      h.scheduler.start();
      h.clock.advance(MINUTE);

      const labels: Array<string | null> = [];
      for (let used = 0; used < 3; used++) {
        const view = ringingView(h.rings);
        labels.push(view.snoozeLabel);
        expect(h.scheduler.snooze(view.occurrenceId)).toBe(true);
        h.clock.advance(4 * MINUTE);
        expect(h.rings).toHaveLength(used + 1);
        h.clock.advance(MINUTE);
        expect(h.rings).toHaveLength(used + 2);
      }
      expect(labels).toEqual([
        'Snooze 5 min (3 left)',
        'Snooze 5 min (2 left)',
        'Snooze 5 min (1 left)',
      ]);

      const last = ringingView(h.rings);
      expect(last.snoozeLabel).toBeNull();
      expect(last.snoozeNotice).toBe('No snoozes left, do it now');
      expect(h.scheduler.snooze(last.occurrenceId)).toBe(false);
      expect(h.scheduler.getAlarm(last.occurrenceId)).not.toBeNull();
    });

    it('never offers or accepts a snooze when max_snoozes is 0', () => {
      const h = createHarness();
      h.scheduler.setSchedule([makeEvent({ id: EVENT_A, max_snoozes: 0 })], [], SETTINGS);
      h.scheduler.start();
      h.clock.advance(MINUTE);

      const view = ringingView(h.rings);
      expect(view.snoozeLabel).toBeNull();
      expect(view.snoozeNotice).toBeNull();
      expect(h.scheduler.snooze(view.occurrenceId)).toBe(false);
    });

    it('records the snoozes used on the completion', () => {
      const h = createHarness();
      h.scheduler.setSchedule(
        [makeEvent({ id: EVENT_A, max_snoozes: 2, snooze_minutes: 1 })],
        [],
        SETTINGS
      );
      h.scheduler.start();
      h.clock.advance(MINUTE);
      h.scheduler.snooze(ringingView(h.rings).occurrenceId);
      h.clock.advance(MINUTE);
      h.scheduler.done(ringingView(h.rings).occurrenceId);

      expect(h.cache.pendingCompletions).toHaveLength(1);
      expect(h.cache.pendingCompletions[0]).toMatchObject({
        event_id: EVENT_A,
        occurrence_at: new Date(START + MINUTE).toISOString(),
        status: 'done',
        snoozes_used: 1,
      });
    });
  });

  describe('closing the alarm window without a choice', () => {
    it('re-rings after refire_seconds and keeps the snoozes already used', () => {
      const h = createHarness();
      h.scheduler.setSchedule(
        [makeEvent({ id: EVENT_A, max_snoozes: 2, snooze_minutes: 1 })],
        [],
        { ...SETTINGS, refire_seconds: 20 }
      );
      h.scheduler.start();
      h.clock.advance(MINUTE);
      h.scheduler.snooze(ringingView(h.rings).occurrenceId);
      h.clock.advance(MINUTE);
      expect(h.rings).toHaveLength(2);

      h.scheduler.windowClosed(ringingView(h.rings).occurrenceId);
      h.clock.advance(19 * SECOND);
      expect(h.rings).toHaveLength(2);
      h.clock.advance(SECOND);
      expect(h.rings).toHaveLength(3);
      expect(ringingView(h.rings).snoozeLabel).toBe('Snooze 1 min (1 left)');

      // And again, until a choice is made.
      h.scheduler.windowClosed(ringingView(h.rings).occurrenceId);
      h.clock.advance(20 * SECOND);
      expect(h.rings).toHaveLength(4);
    });

    it('does not re-ring a window closed by the app after Done or Snooze', () => {
      const h = createHarness();
      h.scheduler.setSchedule([makeEvent({ id: EVENT_A, snooze_minutes: 60 })], [], SETTINGS);
      h.scheduler.start();
      h.clock.advance(MINUTE);
      const view = ringingView(h.rings);

      h.scheduler.snooze(view.occurrenceId);
      h.scheduler.windowClosed(view.occurrenceId);
      h.clock.advance(10 * MINUTE);
      expect(h.rings).toHaveLength(1);
    });

    it('rings an alarm that was on screen when the app was killed', () => {
      const first = createHarness();
      first.scheduler.setSchedule([makeEvent({ id: EVENT_A })], [], SETTINGS);
      first.scheduler.start();
      first.clock.advance(MINUTE);
      expect(first.rings).toHaveLength(1);
      first.scheduler.stop();

      // Same cache, fresh process.
      const second = createHarness(first.cache);
      second.clock.time = first.clock.time + 5 * SECOND;
      second.scheduler.start();
      expect(second.rings).toHaveLength(1);
      expect(second.rings[0]?.occurrenceId).toBe(first.rings[0]?.occurrenceId);
    });

    it('keeps a window-closed refire across a restart', () => {
      const first = createHarness();
      first.scheduler.setSchedule([makeEvent({ id: EVENT_A })], [], SETTINGS);
      first.scheduler.start();
      first.clock.advance(MINUTE);
      first.scheduler.windowClosed(ringingView(first.rings).occurrenceId);
      first.scheduler.stop();

      // Restart 30 s later: the 120 s refire is still ahead, so nothing rings yet.
      const second = createHarness(first.cache);
      second.clock.time = first.clock.time + 30 * SECOND;
      second.scheduler.start();
      expect(second.rings).toHaveLength(0);
      second.clock.advance(89 * SECOND);
      expect(second.rings).toHaveLength(0);
      second.clock.advance(SECOND);
      expect(second.rings).toHaveLength(1);
    });

    it('rings at once after a restart when the refire time already passed', () => {
      const first = createHarness();
      first.scheduler.setSchedule([makeEvent({ id: EVENT_A })], [], SETTINGS);
      first.scheduler.start();
      first.clock.advance(MINUTE);
      first.scheduler.windowClosed(ringingView(first.rings).occurrenceId);
      first.scheduler.stop();

      const second = createHarness(first.cache);
      second.clock.time = first.clock.time + 10 * MINUTE;
      second.scheduler.start();
      expect(second.rings).toHaveLength(1);
    });

    it('rings a snoozed alarm at once after a restart when its wake time already passed', () => {
      const first = createHarness();
      first.scheduler.setSchedule(
        [makeEvent({ id: EVENT_A, max_snoozes: 3, snooze_minutes: 5 })],
        [],
        SETTINGS
      );
      first.scheduler.start();
      first.clock.advance(MINUTE);
      first.scheduler.snooze(ringingView(first.rings).occurrenceId);
      first.scheduler.stop();

      const second = createHarness(first.cache);
      second.clock.time = first.clock.time + 10 * MINUTE;
      second.scheduler.start();
      expect(second.rings).toHaveLength(1);
      // The snooze already used survives the restart.
      expect(second.rings[0]?.snoozeLabel).toBe('Snooze 5 min (2 left)');
    });

    it('keeps a snoozed alarm waiting across a restart when its wake time is ahead', () => {
      const first = createHarness();
      first.scheduler.setSchedule([makeEvent({ id: EVENT_A, snooze_minutes: 5 })], [], SETTINGS);
      first.scheduler.start();
      first.clock.advance(MINUTE);
      first.scheduler.snooze(ringingView(first.rings).occurrenceId);
      first.scheduler.stop();

      const second = createHarness(first.cache);
      second.clock.time = first.clock.time + 2 * MINUTE;
      second.scheduler.start();
      expect(second.rings).toHaveLength(0);
      second.clock.advance(3 * MINUTE);
      expect(second.rings).toHaveLength(1);
    });

    it('re-schedules the re-ring when the host fails to show the alarm', () => {
      const h = createHarness(emptyCache(), {
        onRing: (_view, attempt) => {
          if (attempt === 1) throw new Error('window creation failed');
        },
      });
      h.scheduler.setSchedule([makeEvent({ id: EVENT_A })], [], {
        ...SETTINGS,
        refire_seconds: 20,
      });
      h.scheduler.start();
      h.clock.advance(MINUTE);
      expect(h.logs).toContain('alarm.show_failed');
      expect(h.rings).toHaveLength(0);

      h.clock.advance(19 * SECOND);
      expect(h.rings).toHaveLength(0);
      h.clock.advance(SECOND);
      expect(h.rings).toHaveLength(1);
    });
  });

  describe('grace window after sleep', () => {
    it('rings immediately on resume when the occurrence is within grace_minutes', () => {
      const h = createHarness();
      h.scheduler.setSchedule([makeEvent({ id: EVENT_A })], [], SETTINGS);
      h.scheduler.start();

      h.clock.sleepFor(MINUTE + 10 * MINUTE);
      expect(h.rings).toHaveLength(0);
      h.scheduler.evaluate('resume');
      expect(h.rings).toHaveLength(1);
    });

    it('ignores an occurrence older than grace_minutes', () => {
      const h = createHarness();
      h.scheduler.setSchedule([makeEvent({ id: EVENT_A })], [], SETTINGS);
      h.scheduler.start();

      h.clock.sleepFor(MINUTE + 31 * MINUTE);
      h.scheduler.evaluate('resume');
      expect(h.rings).toHaveLength(0);
    });

    it('rings only once for a long sleep across several recurrences', () => {
      const h = createHarness();
      h.scheduler.setSchedule(
        [makeEvent({ id: EVENT_A, repeat_unit: 'hour', repeat_interval: 1 })],
        [],
        { ...SETTINGS, grace_minutes: 180 }
      );
      h.scheduler.start();

      h.clock.sleepFor(3 * HOUR);
      h.scheduler.evaluate('resume');
      expect(h.rings).toHaveLength(1);
      expect(h.rings[0]?.occurrenceAt).toBe(new Date(START + 3 * HOUR + MINUTE - HOUR).toISOString());
    });

    it('does not ring an occurrence that was already marked Done', () => {
      const h = createHarness();
      h.scheduler.setSchedule([makeEvent({ id: EVENT_A })], [], SETTINGS);
      h.scheduler.start();
      h.clock.advance(MINUTE);
      h.scheduler.done(ringingView(h.rings).occurrenceId);

      h.scheduler.evaluate('unlock-screen');
      h.clock.advance(10 * MINUTE);
      h.scheduler.evaluate('resume');
      expect(h.rings).toHaveLength(1);
    });
  });

  describe('cheat days', () => {
    it('silences passable events and still rings non-passable ones', () => {
      const h = createHarness();
      h.scheduler.setSchedule(
        [
          makeEvent({ id: EVENT_A, title: 'Passable', passable: true }),
          makeEvent({ id: EVENT_B, title: 'Medication', passable: false }),
        ],
        ['2026-03-02'],
        SETTINGS
      );
      h.scheduler.start();
      h.clock.advance(MINUTE);

      expect(h.rings.map((r) => r.title)).toEqual(['Medication']);
    });

    it('does not silence an occurrence on a different day', () => {
      const h = createHarness();
      h.scheduler.setSchedule([makeEvent({ id: EVENT_A })], ['2026-03-03'], SETTINGS);
      h.scheduler.start();
      h.clock.advance(MINUTE);
      expect(h.rings).toHaveLength(1);
    });

    it('does not ring a silenced occurrence later via the grace window', () => {
      const h = createHarness();
      h.scheduler.setSchedule([makeEvent({ id: EVENT_A })], ['2026-03-02'], SETTINGS);
      h.scheduler.start();
      h.clock.advance(MINUTE);
      h.clock.advance(5 * MINUTE);
      h.scheduler.evaluate('resume');
      expect(h.rings).toHaveLength(0);
    });
  });

  describe('recurring events', () => {
    it('drops a new occurrence while the previous one is still ringing', () => {
      const h = createHarness();
      h.scheduler.setSchedule(
        [makeEvent({ id: EVENT_A, repeat_unit: 'hour', repeat_interval: 1 })],
        [],
        SETTINGS
      );
      h.scheduler.start();
      h.clock.advance(MINUTE);
      expect(h.rings).toHaveLength(1);

      h.clock.advance(HOUR);
      expect(h.rings).toHaveLength(1);
      expect(h.cache.occurrences).toHaveLength(1);
      expect(h.cache.occurrences[0]?.occurrenceAt).toBe(new Date(START + MINUTE).toISOString());
    });

    it('also drops a new occurrence while the same event is snoozed', () => {
      const h = createHarness();
      h.scheduler.setSchedule(
        [
          makeEvent({
            id: EVENT_A,
            repeat_unit: 'hour',
            repeat_interval: 1,
            snooze_minutes: 90,
          }),
        ],
        [],
        SETTINGS
      );
      h.scheduler.start();
      h.clock.advance(MINUTE);
      h.scheduler.snooze(ringingView(h.rings).occurrenceId);

      // The 10:01 occurrence comes due while the 09:01 one is snoozed until 10:31.
      h.clock.advance(HOUR);
      expect(h.rings).toHaveLength(1);
      expect(h.cache.occurrences).toHaveLength(1);

      h.clock.advance(30 * MINUTE);
      expect(h.rings).toHaveLength(2);
      expect(h.rings[1]?.occurrenceAt).toBe(new Date(START + MINUTE).toISOString());
    });

    it('rings the next occurrence after Done and not the dropped one', () => {
      const h = createHarness();
      h.scheduler.setSchedule(
        [makeEvent({ id: EVENT_A, repeat_unit: 'hour', repeat_interval: 1 })],
        [],
        SETTINGS
      );
      h.scheduler.start();
      h.clock.advance(MINUTE);
      h.clock.advance(HOUR);
      h.scheduler.done(ringingView(h.rings).occurrenceId);

      h.scheduler.evaluate('resume');
      expect(h.rings).toHaveLength(1);
      h.clock.advance(HOUR);
      expect(h.rings).toHaveLength(2);
      expect(ringingView(h.rings).occurrenceAt).toBe(new Date(START + 2 * HOUR + MINUTE).toISOString());
    });

    it('still rings a different event while one is ringing', () => {
      const h = createHarness();
      h.scheduler.setSchedule(
        [makeEvent({ id: EVENT_A }), makeEvent({ id: EVENT_B, title: 'Second' })],
        [],
        SETTINGS
      );
      h.scheduler.start();
      h.clock.advance(MINUTE);
      expect(h.rings.map((r) => r.title)).toEqual(['Take medication', 'Second']);
    });
  });

  describe('setSchedule', () => {
    it('dismisses a ringing alarm whose event was deleted', () => {
      const h = createHarness();
      h.scheduler.setSchedule([makeEvent({ id: EVENT_A })], [], SETTINGS);
      h.scheduler.start();
      h.clock.advance(MINUTE);
      const view = ringingView(h.rings);

      h.scheduler.setSchedule([makeEvent({ id: EVENT_A, active: false })], [], SETTINGS);
      expect(h.dismissed).toEqual([view.occurrenceId]);
      expect(h.scheduler.getAlarm(view.occurrenceId)).toBeNull();
    });

    it('forgets handled-through watermarks of events that left the schedule', () => {
      const h = createHarness();
      h.scheduler.setSchedule([makeEvent({ id: EVENT_A }), makeEvent({ id: EVENT_B })], [], SETTINGS);
      h.scheduler.start();
      h.clock.advance(MINUTE);
      expect(Object.keys(h.cache.handledThrough).sort()).toEqual([EVENT_A, EVENT_B]);

      h.scheduler.setSchedule([makeEvent({ id: EVENT_A })], [], SETTINGS);
      expect(Object.keys(h.cache.handledThrough)).toEqual([EVENT_A]);
    });

    it('rejects Done for an occurrence that is not ringing', () => {
      const h = createHarness();
      h.scheduler.setSchedule([makeEvent({ id: EVENT_A })], [], SETTINGS);
      h.scheduler.start();
      expect(h.scheduler.done(`${EVENT_A}@${new Date(START + MINUTE).toISOString()}`)).toBe(false);
      expect(h.cache.pendingCompletions).toHaveLength(0);
    });
  });
});
