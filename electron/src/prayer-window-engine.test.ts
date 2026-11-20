import { describe, expect, it } from 'vitest';

import { buildSchedulePayload } from '@alarm-calendar/core';
import type { AlarmSettings, ScheduleEventInfo, ScheduleOccurrence, SchedulePayload } from '@alarm-calendar/core';

import { makeOccurrenceId } from './alarm-ipc';
import { emptyCache } from './cache';
import type { CacheData, OccurrenceState } from './cache';
import { FakeClock } from './fake-clock';
import { parseCantNowRequest, parseLaterRequest } from './later-request';
import { AlarmScheduler } from './scheduler';

const MINUTE = 60_000;
const USER = '99999999-9999-4999-8999-999999999999';
const EVENT = '11111111-1111-4111-8111-111111111111';
const AT = '2026-11-02T12:00:00.000Z';
const END = '2026-11-02T15:00:00.000Z';
const ID = makeOccurrenceId(EVENT, new Date(AT));
const T = (clock: string): number => Date.parse(`2026-11-02T${clock}.000Z`);

const SETTINGS: AlarmSettings = {
  user_id: USER,
  timezone: 'UTC',
  week_starts_on: 0,
  pass_cap: 2,
  grace_minutes: 30,
  refire_seconds: 120,
};

function payload(windowEnd: string | null, now: number): SchedulePayload {
  const info: ScheduleEventInfo = { title: 'Dhuhr', notes: null, maxSnoozes: 3, snoozeMinutes: 5, soundId: null, kind: 'prayer', prayer: 'dhuhr' };
  const occurrence: ScheduleOccurrence = {
    id: ID,
    eventId: EVENT,
    at: AT,
    silenced: false,
    completed: false,
    ...(windowEnd === null ? {} : { windowEnd }),
  };
  return {
    version: 2,
    generatedAt: new Date(now).toISOString(),
    horizonEnd: new Date(now + 60 * 24 * 60 * MINUTE).toISOString(),
    truncated: false,
    settings: SETTINGS,
    occurrences: [occurrence],
    eventInfo: { [EVENT]: info },
    refillSource: { events: [], cheatDays: [] },
  };
}

function harness(startMs: number, windowEnd: string | null = END, cache = emptyCache()) {
  const clock = new FakeClock(startMs);
  const dismissed: string[] = [];
  const scheduler = new AlarmScheduler({
    cache,
    persist: () => undefined,
    now: clock.now,
    timers: clock.timers,
    newId: () => USER,
    onRing: () => undefined,
    onDismiss: (id) => dismissed.push(id),
    log: () => undefined,
  });
  scheduler.start();
  scheduler.setSchedule(payload(windowEnd, startMs));
  return { cache, clock, dismissed, scheduler, run: (ms: number) => clock.advance(ms - clock.time) };
}

describe('Later and Cant now in the scheduler', () => {
  it('refuses Later for minutes that are not a preset, or no longer fit, and for a prayer without a window', () => {
    const h = harness(T('11:59:00'));
    h.run(T('12:00:00'));
    for (const minutes of [0, 5, 19, 61, Number.NaN]) expect(h.scheduler.later(ID, minutes), String(minutes)).toBe(false);
    h.run(T('14:35:00'));
    // 25 minutes left: nothing fits any more.
    for (const minutes of [20, 40, 60]) expect(h.scheduler.later(ID, minutes), String(minutes)).toBe(false);
    expect(h.cache.occurrences[0]?.phase).toBe('ringing');

    const plain = harness(T('11:59:00'), null);
    plain.run(T('12:00:00'));
    expect(plain.scheduler.later(ID, 20)).toBe(false);
    expect(plain.scheduler.cantNow(ID, 'until_last_call')).toBe(false);
  });

  it('does not count Later as a snooze', () => {
    const h = harness(T('11:59:00'));
    h.run(T('12:00:00'));
    for (let i = 0; i < 5; i++) {
      expect(h.scheduler.later(ID, 20)).toBe(true);
      h.run(h.clock.time + 20 * MINUTE);
    }
    expect(h.cache.occurrences[0]).toMatchObject({ snoozesUsed: 0, phase: 'ringing' });
  });

  it("Can't now sets the last call flag and wakes at the last call", () => {
    const h = harness(T('11:59:00'));
    h.run(T('12:00:00'));
    expect(h.scheduler.cantNow(ID, 'until_last_call')).toBe(true);
    expect(h.cache.occurrences[0]).toMatchObject({ phase: 'snoozed', lastCall: true, wakeAt: '2026-11-02T14:40:00.000Z' });
  });

  it("a second Can't now at the last call gives the prayer up: no completion, no state, never rung again", () => {
    const h = harness(T('11:59:00'));
    h.run(T('12:00:00'));
    h.scheduler.cantNow(ID, 'until_last_call');
    h.run(T('14:40:00'));
    expect(h.scheduler.getAlarm(ID)?.prayerChoices?.cantNow).toBe('give_up');
    expect(h.scheduler.cantNow(ID, 'give_up')).toBe(true);
    expect(h.cache.occurrences).toEqual([]);
    expect(h.cache.pendingCompletions).toEqual([]);
    h.run(T('16:00:00'));
    expect(h.cache.occurrences).toEqual([]);
  });

  it("refuses a Can't now whose button the clock has since changed, and leaves the prayer ringing", () => {
    const h = harness(T('11:59:00'));
    h.run(T('12:00:00'));
    // The person saw "Can't now · last call"; by the time it is pressed it is the last call: refused, not given up.
    h.run(T('14:39:30'));
    expect(h.scheduler.cantNow(ID, 'until_last_call')).toBe(false);
    expect(h.cache.occurrences[0]).toMatchObject({ phase: 'ringing' });
    expect(h.cache.occurrences[0]?.lastCall).toBeUndefined();
    expect(h.scheduler.getAlarm(ID)?.prayerChoices?.cantNow).toBe('give_up');
    // The give-up button, pressed early (a forged or replayed request), is refused too.
    const early = harness(T('11:59:00'));
    early.run(T('12:00:00'));
    expect(early.scheduler.cantNow(ID, 'give_up')).toBe(false);
    expect(early.cache.occurrences).toHaveLength(1);
    // Pressing what is shown works.
    expect(h.scheduler.cantNow(ID, 'give_up')).toBe(true);
    expect(h.cache.occurrences).toEqual([]);
  });

  it('refuses Snooze for a prayer with a window', () => {
    const h = harness(T('11:59:00'));
    h.run(T('12:00:00'));
    expect(h.scheduler.snooze(ID)).toBe(false);
  });
});

describe('the window closing', () => {
  it('dismisses a ringing prayer through onDismiss and records nothing', () => {
    const h = harness(T('11:59:00'), '2026-11-02T12:30:00.000Z');
    h.run(T('12:00:00'));
    expect(h.cache.occurrences).toHaveLength(1);
    h.run(T('12:29:59'));
    expect(h.dismissed).toEqual([]);
    h.run(T('12:30:00'));
    expect(h.dismissed).toEqual([ID]);
    expect(h.cache.occurrences).toEqual([]);
    expect(h.cache.pendingCompletions).toEqual([]);
  });

  it('dismisses a snoozed prayer whose wake-up lies after the window end (a state restored from disk)', () => {
    const cache = emptyCache();
    const state: OccurrenceState = {
      eventId: EVENT,
      occurrenceAt: AT,
      snoozesUsed: 0,
      phase: 'snoozed',
      wakeAt: '2026-11-02T13:00:00.000Z',
      userId: USER,
      title: 'Dhuhr',
      notes: null,
      maxSnoozes: 0,
      snoozeMinutes: 5,
      soundId: null,
      kind: 'prayer',
      windowEnd: '2026-11-02T12:45:00.000Z',
    };
    cache.occurrences.push(state);
    const h = harness(T('12:30:00'), null, cache);
    h.run(T('12:44:59'));
    expect(h.dismissed).toEqual([]);
    h.run(T('12:45:00'));
    expect(h.dismissed).toEqual([ID]);
    expect(cache.occurrences).toEqual([]);
  });

  it('after a restart past the window, a ringing state is dismissed instead of rung again', () => {
    const cache = emptyCache();
    cache.occurrences.push({
      eventId: EVENT,
      occurrenceAt: AT,
      snoozesUsed: 0,
      phase: 'ringing',
      wakeAt: null,
      userId: USER,
      title: 'Dhuhr',
      notes: null,
      maxSnoozes: 0,
      snoozeMinutes: 5,
      soundId: null,
      kind: 'prayer',
      windowEnd: '2026-11-02T12:30:00.000Z',
    });
    const h = harness(T('12:40:00'), null, cache);
    expect(h.dismissed).toEqual([ID]);
    expect(cache.occurrences).toEqual([]);
  });

  it('keeps the window of a ringing state when a push from an older app (no windowEnd) arrives', () => {
    const h = harness(T('11:59:00'));
    h.run(T('12:00:00'));
    h.scheduler.setSchedule(payload(null, h.clock.time));
    expect(h.cache.occurrences[0]?.windowEnd).toBe(END);
    expect(h.scheduler.getAlarm(ID)?.prayerChoices).toBeDefined();
  });

  it('survives a refill: the rebuilt list still carries the window of each prayer', () => {
    const cache = emptyCache();
    const clock = new FakeClock(Date.parse('2026-10-06T09:00:00.000Z'));
    const scheduler = new AlarmScheduler({
      cache,
      persist: () => undefined,
      now: clock.now,
      timers: clock.timers,
      newId: () => USER,
      onRing: () => undefined,
      onDismiss: () => undefined,
      log: () => undefined,
    });
    const settings = { ...SETTINGS, timezone: 'Africa/Tunis', prayers_enabled: true, prayers_enabled_since: '2026-09-01T00:00:00.000Z' };
    const events = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'].map((prayer, i) => ({
      id: `0000000a-0000-4000-8000-00000000000${i}`,
      user_id: USER,
      title: prayer,
      notes: null,
      start_at: '2026-09-01T00:00:00.000Z',
      duration_min: 15,
      repeat_unit: 'day' as const,
      repeat_interval: 1,
      repeat_weekdays: null,
      ends_at: null,
      max_snoozes: 0,
      snooze_minutes: 5,
      passable: false,
      color: null,
      active: true,
      updated_at: '2026-09-01T00:00:00.000Z',
      kind: 'prayer' as const,
      prayer: prayer as 'fajr',
    }));
    scheduler.setSchedule(
      buildSchedulePayload({ events, cheatDays: [], settings, completions: [], now: clock.now() })
    );
    cache.schedule = null;
    scheduler.evaluate('test-refill');
    const prayers = (cache.schedule as CacheData['schedule'])?.occurrences ?? [];
    expect(prayers.length).toBeGreaterThan(0);
    expect(prayers.every((occurrence) => occurrence.windowEnd !== undefined)).toBe(true);
  });
});

describe('parseLaterRequest', () => {
  it('accepts an occurrence id with one of the preset minutes', () => {
    expect(parseLaterRequest({ occurrenceId: ID, minutes: 40 })).toEqual({ occurrenceId: ID, minutes: 40 });
  });

  it('refuses anything else', () => {
    for (const bad of [
      null,
      'x',
      42,
      {},
      { occurrenceId: ID },
      { minutes: 20 },
      { occurrenceId: ID, minutes: 15 },
      { occurrenceId: ID, minutes: 20.5 },
      { occurrenceId: ID, minutes: '20' },
      { occurrenceId: ID, minutes: -20 },
      { occurrenceId: 'not an id', minutes: 20 },
      { occurrenceId: `${EVENT}@2026-02-31T12:00:00.000Z`, minutes: 20 },
    ]) {
      expect(parseLaterRequest(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('parseCantNowRequest', () => {
  it('accepts an occurrence id with one of the two variants', () => {
    expect(parseCantNowRequest({ occurrenceId: ID, shown: 'until_last_call' })).toEqual({ occurrenceId: ID, shown: 'until_last_call' });
    expect(parseCantNowRequest({ occurrenceId: ID, shown: 'give_up' })).toEqual({ occurrenceId: ID, shown: 'give_up' });
  });

  it('refuses a bare id (the old shape), an unknown variant and anything malformed', () => {
    const bads = [null, 'x', ID, {}, { occurrenceId: ID }, { shown: 'give_up' }, { occurrenceId: ID, shown: 'now' }, { occurrenceId: ID, shown: 1 }, { occurrenceId: 'nope', shown: 'give_up' }];
    for (const bad of bads) expect(parseCantNowRequest(bad), JSON.stringify(bad)).toBeNull();
  });
});
