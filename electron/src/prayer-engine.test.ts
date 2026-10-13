import { describe, expect, it } from 'vitest';

import {
  buildSchedulePayload,
  DEFAULT_PRAYER_SETTINGS,
  dayNumberFromDateString,
  PRAYER_NAMES,
  prayerTimesOnDay,
  resolvePrayerConfig,
} from '@alarm-calendar/core';
import type { AlarmSettings, EventKind, EventRow, PrayerName } from '@alarm-calendar/core';

import type { AlarmView } from './alarm-ipc';
import { emptyCache } from './cache';
import { FakeClock } from './fake-clock';
import { AlarmScheduler } from './scheduler';

const MINUTE = 60_000;
const USER = '99999999-9999-4999-8999-999999999999';

// 10:00 in Tunis on 2026-10-06: after Fajr (04:53), before Dhuhr (12:07).
const START = Date.parse('2026-10-06T09:00:00.000Z');

const SETTINGS: AlarmSettings = {
  user_id: USER,
  timezone: 'Africa/Tunis',
  week_starts_on: 0,
  refire_seconds: 120,
  pass_cap: 2,
  grace_minutes: 30,
  ...DEFAULT_PRAYER_SETTINGS,
  prayers_enabled: true,
  prayers_enabled_since: '2026-09-01T00:00:00.000Z',
};

const config = resolvePrayerConfig(SETTINGS)!;

function prayerId(kind: Exclude<EventKind, 'normal'>, prayer: PrayerName): string {
  return `0000000${kind === 'prayer' ? '1' : '2'}-0000-4000-8000-00000000000${PRAYER_NAMES.indexOf(prayer)}`;
}

function prayerEvent(kind: Exclude<EventKind, 'normal'>, prayer: PrayerName): EventRow {
  return {
    id: prayerId(kind, prayer),
    user_id: USER,
    title: kind === 'prayer' ? prayer.charAt(0).toUpperCase() + prayer.slice(1) : `Before ${prayer}`,
    notes: null,
    start_at: '2026-09-01T00:00:00.000Z',
    duration_min: 15,
    repeat_unit: 'day',
    repeat_interval: 1,
    repeat_weekdays: null,
    ends_at: null,
    max_snoozes: 0,
    snooze_minutes: 5,
    passable: false,
    color: null,
    active: true,
    updated_at: '2026-09-01T00:00:00.000Z',
    kind,
    prayer,
  };
}

const PRAYER_EVENTS: EventRow[] = [
  ...PRAYER_NAMES.map((prayer) => prayerEvent('prayer', prayer)),
  ...PRAYER_NAMES.map((prayer) => prayerEvent('pre_prayer', prayer)),
];

function at(prayer: PrayerName, day = '2026-10-06'): number {
  return prayerTimesOnDay(config, dayNumberFromDateString(day))[prayer].getTime();
}

function createHarness(startMs: number = START) {
  const cache = emptyCache();
  const clock = new FakeClock(startMs);
  const rings: AlarmView[] = [];
  const dismissed: string[] = [];
  let id = 0;
  const scheduler = new AlarmScheduler({
    cache,
    persist: () => undefined,
    now: clock.now,
    timers: clock.timers,
    newId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    onRing: (view) => rings.push(view),
    onDismiss: (occurrenceId) => dismissed.push(occurrenceId),
    log: () => undefined,
  });
  return {
    cache,
    clock,
    rings,
    dismissed,
    scheduler,
    push(events: EventRow[], cheatDays: string[] = [], settings: AlarmSettings = SETTINGS): void {
      scheduler.setSchedule(
        buildSchedulePayload({ events, cheatDays, settings, completions: [], now: clock.now() })
      );
    },
    /** Runs the clock to an instant (inclusive of the timeout that fires there). */
    runTo(ms: number): void {
      clock.advance(ms - clock.time);
    },
  };
}

describe('prayer alarms in the scheduler', () => {
  it('rings Dhuhr as a prayer: kind, no snooze button, Done records a completion', () => {
    const h = createHarness();
    h.push(PRAYER_EVENTS);
    h.scheduler.start();
    h.runTo(at('dhuhr'));

    const dhuhr = h.rings.find((view) => view.occurrenceId.startsWith(prayerId('prayer', 'dhuhr')));
    expect(dhuhr).toMatchObject({ title: 'Dhuhr', kind: 'prayer', snoozeLabel: null, snoozeNotice: null });
    expect(h.scheduler.snooze(dhuhr!.occurrenceId)).toBe(false);
    expect(h.scheduler.done(dhuhr!.occurrenceId)).toBe(true);
    expect(h.cache.pendingCompletions).toMatchObject([
      { event_id: prayerId('prayer', 'dhuhr'), occurrence_at: new Date(at('dhuhr')).toISOString(), status: 'done' },
    ]);
  });

  it('is not silenced by a cheat day', () => {
    const h = createHarness();
    h.push(PRAYER_EVENTS, ['2026-10-06']);
    h.scheduler.start();
    h.runTo(at('dhuhr'));
    expect(h.rings.some((view) => view.occurrenceId.startsWith(prayerId('prayer', 'dhuhr')))).toBe(true);
  });

  it('allows snoozing when the prayer settings say so', () => {
    const h = createHarness();
    h.push(PRAYER_EVENTS, [], { ...SETTINGS, prayer_max_snoozes: 2, prayer_snooze_minutes: 10 });
    h.scheduler.start();
    h.runTo(at('dhuhr'));
    const dhuhr = h.rings.find((view) => view.occurrenceId.startsWith(prayerId('prayer', 'dhuhr')))!;
    expect(dhuhr.snoozeLabel).toBe('Snooze 10 min · 2 left');
  });

  it('plays the prayer sound for the prayer and the normal sound for the reminder', () => {
    const h = createHarness();
    h.push(PRAYER_EVENTS, [], { ...SETTINGS, sound: 'chime', prayerSound: 'custom' });
    h.scheduler.start();
    h.runTo(at('dhuhr'));
    const prayer = h.rings.find((view) => view.occurrenceId.startsWith(prayerId('prayer', 'dhuhr')));
    const reminder = h.rings.find((view) => view.occurrenceId.startsWith(prayerId('pre_prayer', 'dhuhr')));
    expect(prayer?.soundId).toBe('custom');
    expect(reminder?.soundId).toBe('chime');
  });
});

describe('pre-prayer text decided when the alarm rings', () => {
  function preAsr(h: ReturnType<typeof createHarness>): AlarmView | undefined {
    return h.rings.find((view) => view.occurrenceId.startsWith(prayerId('pre_prayer', 'asr')));
  }

  it('reminds you of Dhuhr when it was never logged', () => {
    const h = createHarness();
    h.push(PRAYER_EVENTS);
    h.scheduler.start();
    h.runTo(at('asr') - 15 * MINUTE);
    expect(preAsr(h)?.title).toBe("You haven't logged Dhuhr — you have until Asr");
    expect(preAsr(h)?.kind).toBe('pre_prayer');
  });

  it('says how long is left once Dhuhr was marked done on this device', () => {
    const h = createHarness();
    h.push(PRAYER_EVENTS);
    h.scheduler.start();
    h.runTo(at('dhuhr'));
    const dhuhr = h.rings.find((view) => view.occurrenceId.startsWith(prayerId('prayer', 'dhuhr')))!;
    expect(h.scheduler.done(dhuhr.occurrenceId)).toBe(true);

    h.runTo(at('asr') - 15 * MINUTE);
    expect(preAsr(h)?.title).toBe('Asr in 15 min');
  });

  it('keeps the text of a ringing reminder when the schedule is pushed again', () => {
    const h = createHarness();
    h.push(PRAYER_EVENTS);
    h.scheduler.start();
    h.runTo(at('asr') - 15 * MINUTE);
    const before = preAsr(h)!;

    // The app pushes on every change; the list is rebuilt around the ringing alarm.
    h.push(PRAYER_EVENTS);
    expect(h.scheduler.getAlarm(before.occurrenceId)?.title).toBe("You haven't logged Dhuhr — you have until Asr");
  });

  it('dismisses a ringing prayer when prayers are switched off', () => {
    const h = createHarness();
    h.push(PRAYER_EVENTS);
    h.scheduler.start();
    h.runTo(at('dhuhr'));
    const dhuhr = h.rings.find((view) => view.occurrenceId.startsWith(prayerId('prayer', 'dhuhr')))!;

    h.push(PRAYER_EVENTS, [], { ...SETTINGS, prayers_enabled: false });
    expect(h.dismissed).toContain(dhuhr.occurrenceId);
    expect(h.scheduler.getAlarm(dhuhr.occurrenceId)).toBeNull();
  });
});

describe('main re-expands prayers on its own', () => {
  it('rings prayers from the cached events and settings when the list has to be rebuilt', () => {
    const h = createHarness();
    h.push(PRAYER_EVENTS);
    h.scheduler.start();
    // A week and a half later with the window closed: main refills from what it holds.
    h.clock.sleepFor(10 * 24 * 60 * MINUTE);
    h.scheduler.evaluate('resume');
    const next = at('asr', '2026-10-16');
    h.runTo(next);
    expect(h.rings.some((view) => view.title === 'Asr' && view.occurrenceId.endsWith(new Date(next).toISOString()))).toBe(true);
  });
});

describe('a done prayer stays done when its settings change', () => {
  // 04:00 in Tunis on 2026-10-06, before Fajr (04:53).
  const BEFORE_FAJR = Date.parse('2026-10-06T03:00:00.000Z');

  function prayedFajrThen(newSettings: AlarmSettings) {
    const h = createHarness(BEFORE_FAJR);
    h.push(PRAYER_EVENTS);
    h.scheduler.start();
    h.runTo(at('fajr'));
    const fajr = h.rings.find((view) => view.occurrenceId.startsWith(prayerId('prayer', 'fajr')))!;
    expect(h.scheduler.done(fajr.occurrenceId)).toBe(true);
    // The Done is still pending offline (never flushed); the user edits a setting and the app pushes.
    h.push(PRAYER_EVENTS, [], newSettings);
    return h;
  }

  function fajrRings(h: ReturnType<typeof createHarness>): number {
    return h.rings.filter((view) => view.occurrenceId.startsWith(prayerId('prayer', 'fajr'))).length;
  }

  it('does not ring the moved Fajr again after +2 minutes is saved', () => {
    const h = prayedFajrThen({ ...SETTINGS, fajr_offset_min: 2 });
    h.runTo(at('fajr') + 5 * MINUTE);
    expect(fajrRings(h)).toBe(1);
  });

  it('does not ring the moved Fajr again after the location changes', () => {
    const settings = { ...SETTINGS, longitude: 9.4456 };
    const moved = prayerTimesOnDay(resolvePrayerConfig(settings)!, dayNumberFromDateString('2026-10-06')).fajr.getTime();
    expect(moved).toBeGreaterThan(at('fajr'));
    const h = prayedFajrThen(settings);
    h.runTo(moved + 5 * MINUTE);
    expect(fajrRings(h)).toBe(1);
  });

  it('still rings the next day Fajr', () => {
    const h = prayedFajrThen({ ...SETTINGS, fajr_offset_min: 2 });
    h.runTo(at('fajr', '2026-10-07') + 2 * MINUTE + MINUTE);
    expect(fajrRings(h)).toBe(2);
  });
});

describe('a refill knows what was done here and not flushed yet', () => {
  function preAsrToday(h: ReturnType<typeof createHarness>) {
    const asr = new Date(at('asr') - 15 * MINUTE).toISOString();
    return h.cache.schedule?.occurrences.find(
      (occurrence) => occurrence.eventId === prayerId('pre_prayer', 'asr') && occurrence.at === asr
    );
  }

  it('does not ask the engine to remind about a prayer whose Done is still pending', () => {
    const h = createHarness();
    h.push(PRAYER_EVENTS);
    h.scheduler.start();
    h.runTo(at('dhuhr'));
    const dhuhr = h.rings.find((view) => view.occurrenceId.startsWith(prayerId('prayer', 'dhuhr')))!;

    // Without the Done, the refilled reminder carries the unlogged text for the engine.
    h.cache.schedule = null;
    h.scheduler.evaluate('test-refill-before-done');
    expect(preAsrToday(h)?.labelIfUnlogged?.label).toBe("You haven't logged Dhuhr — you have until Asr");

    expect(h.scheduler.done(dhuhr.occurrenceId)).toBe(true);
    expect(h.cache.pendingCompletions).toHaveLength(1);
    h.cache.schedule = null;
    h.scheduler.evaluate('test-refill-with-pending-done');
    expect(preAsrToday(h)).toMatchObject({ label: 'Asr in 15 min' });
    expect(preAsrToday(h)?.labelIfUnlogged).toBeUndefined();
  });
});
