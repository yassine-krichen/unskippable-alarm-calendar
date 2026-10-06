import { describe, expect, it } from 'vitest';

import { eventOccurrencesBetween, isEventPassable } from './occurrences';
import { occurrencesBetween } from './recurrence';
import {
  DEFAULT_PRAYER_SETTINGS,
  PRAYER_NAMES,
  prayerTimesOnDay,
  resolvePrayerConfig,
} from './prayer-times';
import { buildSchedulePayload, expandSchedule, makeOccurrenceId } from './schedule';
import { dayNumberFromDateString } from './time-zone';
import type { AlarmSettings, EventKind, EventRow, PrayerName, ScheduleOccurrence } from './types';

const MINUTE = 60_000;
const USER = '99999999-9999-4999-8999-999999999999';
const TZ = 'Africa/Tunis';

// 10:00 in Tunis, between Fajr (04:53) and Dhuhr (12:07) on 2026-10-06.
const MORNING = new Date('2026-10-06T09:00:00.000Z');

const SETTINGS: AlarmSettings = {
  user_id: USER,
  timezone: TZ,
  week_starts_on: 0,
  refire_seconds: 120,
  pass_cap: 2,
  grace_minutes: 30,
  ...DEFAULT_PRAYER_SETTINGS,
  prayers_enabled: true,
  prayers_enabled_since: '2026-09-01T00:00:00.000Z',
};

const config = resolvePrayerConfig(SETTINGS)!;

/** Stable ids so a test can name the completion of a given prayer. */
function prayerId(kind: Exclude<EventKind, 'normal'>, prayer: PrayerName): string {
  const kindDigit = kind === 'prayer' ? '1' : '2';
  return `0000000${kindDigit}-0000-4000-8000-00000000000${PRAYER_NAMES.indexOf(prayer)}`;
}

function prayerEvent(kind: Exclude<EventKind, 'normal'>, prayer: PrayerName, overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: prayerId(kind, prayer),
    user_id: USER,
    title: kind === 'prayer' ? prayer : `Before ${prayer}`,
    notes: null,
    // Ignored for a prayer row: a start far in the future and an end in the past change nothing.
    start_at: '2031-01-01T00:00:00.000Z',
    duration_min: 15,
    repeat_unit: 'none',
    repeat_interval: 1,
    repeat_weekdays: null,
    ends_at: '2020-01-01T00:00:00.000Z',
    max_snoozes: 9,
    snooze_minutes: 9,
    passable: true,
    color: null,
    active: true,
    updated_at: MORNING.toISOString(),
    kind,
    prayer,
    ...overrides,
  };
}

const ALL_PRAYER_EVENTS: EventRow[] = [
  ...PRAYER_NAMES.map((prayer) => prayerEvent('prayer', prayer)),
  ...PRAYER_NAMES.map((prayer) => prayerEvent('pre_prayer', prayer)),
];

function normalEvent(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    user_id: USER,
    title: 'Take medication',
    notes: null,
    start_at: '2026-10-06T10:00:00.000Z',
    duration_min: 15,
    repeat_unit: 'day',
    repeat_interval: 1,
    repeat_weekdays: null,
    ends_at: null,
    max_snoozes: 3,
    snooze_minutes: 5,
    passable: true,
    color: null,
    active: true,
    updated_at: MORNING.toISOString(),
    ...overrides,
  };
}

function expand(events: EventRow[], extra: Partial<Parameters<typeof expandSchedule>[0]> = {}) {
  return expandSchedule({ events, cheatDays: [], settings: SETTINGS, completions: [], now: MORNING, ...extra });
}

function occurrencesOf(result: ReturnType<typeof expand>, kind: Exclude<EventKind, 'normal'>, prayer: PrayerName): ScheduleOccurrence[] {
  return result.occurrences.filter((occurrence) => occurrence.eventId === prayerId(kind, prayer));
}

function prayerInstant(day: string, prayer: PrayerName): Date {
  return prayerTimesOnDay(config, dayNumberFromDateString(day))[prayer];
}

describe('eventOccurrencesBetween', () => {
  const from = new Date('2026-10-06T00:00:00.000Z');
  const to = new Date('2026-10-09T00:00:00.000Z');

  it('follows the recurrence rule for a normal alarm, exactly as before', () => {
    const event = normalEvent();
    expect(eventOccurrencesBetween(event, from, to, SETTINGS)).toEqual(occurrencesBetween(event, from, to, TZ));
    // An event with an explicit kind of normal is the same thing.
    expect(eventOccurrencesBetween({ ...event, kind: 'normal' }, from, to, SETTINGS)).toEqual(
      occurrencesBetween(event, from, to, TZ)
    );
  });

  it('takes a prayer from the prayer times and ignores its start, repeat and end', () => {
    const instants = eventOccurrencesBetween(prayerEvent('prayer', 'asr'), from, to, SETTINGS);
    expect(instants.map((at) => at.toISOString())).toEqual(
      ['2026-10-06', '2026-10-07', '2026-10-08'].map((day) => prayerInstant(day, 'asr').toISOString())
    );
  });

  it('has nothing for a prayer while prayers are off, and nothing for an inactive row', () => {
    expect(eventOccurrencesBetween(prayerEvent('prayer', 'asr'), from, to, { ...SETTINGS, prayers_enabled: false })).toEqual([]);
    expect(eventOccurrencesBetween(prayerEvent('prayer', 'asr'), from, to, { timezone: TZ })).toEqual([]);
    expect(eventOccurrencesBetween(prayerEvent('prayer', 'asr', { active: false }), from, to, SETTINGS)).toEqual([]);
  });

  it('refuses a prayer row that names no prayer', () => {
    expect(() => eventOccurrencesBetween(prayerEvent('prayer', 'asr', { prayer: null }), from, to, SETTINGS)).toThrow(RangeError);
  });

  it('is never passable for a prayer, whatever the row says', () => {
    expect(isEventPassable({ kind: 'prayer', passable: true })).toBe(false);
    expect(isEventPassable({ kind: 'pre_prayer', passable: true })).toBe(false);
    expect(isEventPassable({ kind: 'normal', passable: true })).toBe(true);
    expect(isEventPassable({ passable: true })).toBe(true);
  });
});

describe('expandSchedule with prayers', () => {
  it('lists the five prayers and their reminders every day over the horizon, sorted', () => {
    const result = expand(ALL_PRAYER_EVENTS);
    // The grace window before now reaches back 30 minutes: nothing is missed at 10:00, so the list
    // starts at the next prayer. 60 days of 10 alarms, with the first day short of Fajr and its reminder.
    const ids = result.occurrences.map((occurrence) => occurrence.id);
    expect(new Set(ids).size).toBe(ids.length);
    const times = result.occurrences.map((occurrence) => Date.parse(occurrence.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    for (const prayer of PRAYER_NAMES) {
      expect(occurrencesOf(result, 'prayer', prayer).length).toBeGreaterThanOrEqual(59);
      expect(occurrencesOf(result, 'pre_prayer', prayer).length).toBeGreaterThanOrEqual(59);
    }
    expect(occurrencesOf(result, 'prayer', 'dhuhr')[0]?.at).toBe(prayerInstant('2026-10-06', 'dhuhr').toISOString());
    expect(result.truncated).toBe(false);
  });

  it('is not silenced by a cheat day, unlike a passable alarm on the same day', () => {
    const medication = normalEvent();
    const result = expand([...ALL_PRAYER_EVENTS, medication], { cheatDays: ['2026-10-06', '2026-10-07'] });
    const today = result.occurrences.filter((occurrence) => occurrence.at.startsWith('2026-10-06') || occurrence.at.startsWith('2026-10-07'));
    const prayers = today.filter((occurrence) => occurrence.eventId !== medication.id);
    expect(prayers.length).toBeGreaterThan(10);
    expect(prayers.every((occurrence) => !occurrence.silenced)).toBe(true);
    expect(today.filter((occurrence) => occurrence.eventId === medication.id).every((occurrence) => occurrence.silenced)).toBe(true);
  });

  it('flags a prayer as completed when its completion is known', () => {
    const dhuhrAt = prayerInstant('2026-10-06', 'dhuhr');
    const result = expand(ALL_PRAYER_EVENTS, {
      completions: [{ event_id: prayerId('prayer', 'dhuhr'), occurrence_at: dhuhrAt.toISOString().replace('Z', '+00:00') }],
    });
    const first = occurrencesOf(result, 'prayer', 'dhuhr')[0];
    expect(first?.at).toBe(dhuhrAt.toISOString());
    expect(first?.completed).toBe(true);
  });

  it('takes snooze rules from the settings, not from the row', () => {
    const result = expand(ALL_PRAYER_EVENTS, { settings: { ...SETTINGS, prayer_max_snoozes: 2, prayer_snooze_minutes: 10 } });
    expect(result.eventInfo[prayerId('prayer', 'fajr')]).toMatchObject({ maxSnoozes: 2, snoozeMinutes: 10 });
    expect(result.eventInfo[prayerId('pre_prayer', 'fajr')]).toMatchObject({ maxSnoozes: 2, snoozeMinutes: 10 });
    // The default is no snooze at all, whatever the row holds.
    expect(expand(ALL_PRAYER_EVENTS).eventInfo[prayerId('prayer', 'asr')]).toMatchObject({ maxSnoozes: 0, snoozeMinutes: 5 });
  });

  it('plays the prayer sound for a prayer and the normal sound for its reminder', () => {
    const result = expand(ALL_PRAYER_EVENTS, { settings: { ...SETTINGS, sound: 'chime', prayerSound: 'custom' } });
    expect(result.eventInfo[prayerId('prayer', 'asr')]).toMatchObject({ soundId: 'custom', kind: 'prayer', prayer: 'asr' });
    expect(result.eventInfo[prayerId('pre_prayer', 'asr')]).toMatchObject({ soundId: 'chime', kind: 'pre_prayer', prayer: 'asr' });
    // Without a separate prayer sound the prayers use the device sound.
    const shared = expand(ALL_PRAYER_EVENTS, { settings: { ...SETTINGS, sound: 'pulse' } });
    expect(shared.eventInfo[prayerId('prayer', 'asr')]?.soundId).toBe('pulse');
  });

  it('leaves prayer events out entirely while prayers are off, so a ringing prayer is dismissed', () => {
    const result = expand([...ALL_PRAYER_EVENTS, normalEvent()], { settings: { ...SETTINGS, prayers_enabled: false } });
    expect(Object.keys(result.eventInfo)).toEqual([normalEvent().id]);
    expect(result.occurrences.every((occurrence) => occurrence.eventId === normalEvent().id)).toBe(true);
  });

  it('reports bad prayer settings once per prayer event and still schedules the normal alarms', () => {
    const failed: string[] = [];
    const result = expand([...ALL_PRAYER_EVENTS, normalEvent()], {
      settings: { ...SETTINGS, latitude: 123 },
      onEventFailed: (eventId) => failed.push(eventId),
    });
    expect(failed).toHaveLength(10);
    expect(result.occurrences.length).toBeGreaterThan(0);
    expect(result.occurrences.every((occurrence) => occurrence.eventId === normalEvent().id)).toBe(true);
  });

  it('has no reminders when the lead is 0, and no snooze data for normal alarms', () => {
    const result = expand([...ALL_PRAYER_EVENTS, normalEvent()], { settings: { ...SETTINGS, pre_prayer_minutes: 0 } });
    for (const prayer of PRAYER_NAMES) expect(occurrencesOf(result, 'pre_prayer', prayer)).toEqual([]);
    expect(result.eventInfo[normalEvent().id]).toEqual({
      title: 'Take medication',
      notes: null,
      maxSnoozes: 3,
      snoozeMinutes: 5,
      soundId: null,
    });
  });

  it('survives a payload round trip with the prayer fields', () => {
    const payload = buildSchedulePayload({
      events: ALL_PRAYER_EVENTS,
      cheatDays: [],
      settings: SETTINGS,
      completions: [],
      now: MORNING,
    });
    expect(payload.settings.prayers_enabled).toBe(true);
    expect(payload.refillSource.events).toHaveLength(10);
    expect(JSON.parse(JSON.stringify(payload)).occurrences).toEqual(payload.occurrences);
  });
});

describe('pre-prayer alarm text', () => {
  /** The pre-prayer occurrence of `prayer` on `day` in a list built at `now`. */
  function pre(
    now: Date,
    day: string,
    prayer: PrayerName,
    extra: Partial<Parameters<typeof expandSchedule>[0]> = {}
  ): ScheduleOccurrence {
    const at = new Date(prayerInstant(day, prayer).getTime() - 15 * MINUTE).toISOString();
    const found = occurrencesOf(expand(ALL_PRAYER_EVENTS, { now, ...extra }), 'pre_prayer', prayer).find(
      (occurrence) => occurrence.at === at
    );
    if (found === undefined) throw new Error(`no pre-prayer ${prayer} at ${at}`);
    return found;
  }

  const AFTER_DHUHR = new Date(prayerInstant('2026-10-06', 'dhuhr').getTime() + 60 * MINUTE);

  it('says how long is left when nothing is outstanding', () => {
    const occurrence = pre(MORNING, '2026-10-06', 'dhuhr', {
      // Fajr was prayed.
      completions: [{ event_id: prayerId('prayer', 'fajr'), occurrence_at: prayerInstant('2026-10-06', 'fajr').toISOString() }],
    });
    expect(occurrence.label).toBe('Dhuhr in 15 min');
    expect(occurrence.labelIfUnlogged).toBeUndefined();
  });

  it('hands the engine the unlogged text when the previous prayer already passed with no Done', () => {
    const occurrence = pre(AFTER_DHUHR, '2026-10-06', 'asr');
    // The engine decides at ring time: a Done made after this list was built must still win.
    expect(occurrence.label).toBe('Asr in 15 min');
    expect(occurrence.labelIfUnlogged).toEqual({
      id: makeOccurrenceId(prayerId('prayer', 'dhuhr'), prayerInstant('2026-10-06', 'dhuhr')),
      label: "You haven't logged Dhuhr — you have until Asr",
    });
  });

  it('falls back to the plain text once that prayer is logged', () => {
    const occurrence = pre(AFTER_DHUHR, '2026-10-06', 'asr', {
      completions: [{ event_id: prayerId('prayer', 'dhuhr'), occurrence_at: prayerInstant('2026-10-06', 'dhuhr').toISOString() }],
    });
    expect(occurrence.label).toBe('Asr in 15 min');
  });

  it('lets the engine decide when the previous prayer is still to come', () => {
    const occurrence = pre(MORNING, '2026-10-06', 'asr');
    expect(occurrence.label).toBe('Asr in 15 min');
    expect(occurrence.labelIfUnlogged).toEqual({
      id: makeOccurrenceId(prayerId('prayer', 'dhuhr'), prayerInstant('2026-10-06', 'dhuhr')),
      label: "You haven't logged Dhuhr — you have until Asr",
    });
  });

  it('uses the previous day Isha for the Fajr reminder', () => {
    const occurrence = pre(MORNING, '2026-10-07', 'fajr');
    expect(occurrence.labelIfUnlogged).toEqual({
      id: makeOccurrenceId(prayerId('prayer', 'isha'), prayerInstant('2026-10-06', 'isha')),
      label: "You haven't logged Isha — you have until Fajr",
    });
    // Already past and not logged: still left to the engine.
    const lateNight = new Date(prayerInstant('2026-10-06', 'isha').getTime() + 30 * MINUTE);
    expect(pre(lateNight, '2026-10-07', 'fajr').labelIfUnlogged?.label).toBe("You haven't logged Isha — you have until Fajr");
  });

  it('says Fajr ended at sunrise in the Dhuhr reminder', () => {
    expect(pre(AFTER_DHUHR, '2026-10-07', 'dhuhr').labelIfUnlogged?.label).toBe(
      "You haven't logged Fajr — its time ended at sunrise"
    );
    const justBeforeDhuhr = new Date(prayerInstant('2026-10-06', 'dhuhr').getTime() - 20 * MINUTE);
    expect(pre(justBeforeDhuhr, '2026-10-06', 'dhuhr').labelIfUnlogged?.label).toBe(
      "You haven't logged Fajr — its time ended at sunrise"
    );
  });

  it('ignores prayers from before prayers were switched on', () => {
    const switchedOn = new Date(prayerInstant('2026-10-06', 'dhuhr').getTime() + 30 * MINUTE).toISOString();
    const occurrence = pre(AFTER_DHUHR, '2026-10-06', 'asr', { settings: { ...SETTINGS, prayers_enabled_since: switchedOn } });
    expect(occurrence.label).toBe('Asr in 15 min');
    expect(occurrence.labelIfUnlogged).toBeUndefined();
  });

  it('keeps the plain text when the previous prayer is not over yet at the reminder', () => {
    // A 2 hour lead puts the Isha reminder before Maghrib has passed.
    const lead = 120;
    const settings = { ...SETTINGS, pre_prayer_minutes: lead };
    const at = new Date(prayerInstant('2026-10-06', 'isha').getTime() - lead * MINUTE).toISOString();
    const occurrence = occurrencesOf(expand(ALL_PRAYER_EVENTS, { settings }), 'pre_prayer', 'isha').find(
      (candidate) => candidate.at === at
    );
    expect(occurrence?.label).toBe('Isha in 120 min');
    expect(occurrence?.labelIfUnlogged).toBeUndefined();
  });

  it('keeps the plain text when the previous prayer has no active event', () => {
    const withoutDhuhr = ALL_PRAYER_EVENTS.filter((event) => event.id !== prayerId('prayer', 'dhuhr'));
    const at = new Date(prayerInstant('2026-10-06', 'asr').getTime() - 15 * MINUTE).toISOString();
    const occurrence = occurrencesOf(expand(withoutDhuhr, { now: AFTER_DHUHR }), 'pre_prayer', 'asr').find(
      (candidate) => candidate.at === at
    );
    expect(occurrence?.label).toBe('Asr in 15 min');
  });
});
