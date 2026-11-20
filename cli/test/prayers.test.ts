import { DEFAULT_PRAYER_SETTINGS, PRAYER_NAMES, dayNumberFromDateString, prayerTimesOnDay, prayerWindowEnd, resolvePrayerConfig } from '@alarm-calendar/core';
import type { EventRow, PrayerName } from '@alarm-calendar/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './harness';

let harness: Harness;

const TZ = 'Africa/Tunis';
const MINUTE = 60_000;

// NOW is 2026-11-08 11:00 in Tunis: Fajr is over, Dhuhr is still to come.
beforeEach(() => {
  harness = createHarness();
  Object.assign(harness.store.settings, DEFAULT_PRAYER_SETTINGS, { prayers_enabled: true, prayers_enabled_since: '2026-10-20T00:00:00.000Z' });
  harness.store.events = PRAYER_NAMES.map(
    (prayer, index): EventRow =>
      ({
        id: `0000000a-0000-4000-8000-00000000000${index}`,
        user_id: harness.store.userId,
        title: prayer,
        notes: null,
        start_at: '2026-10-01T00:00:00.000Z',
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
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
        kind: 'prayer',
        prayer,
        agent_key: null,
      }) as EventRow
  );
});
afterEach(() => harness.cleanup());

const config = () => resolvePrayerConfig(harness.store.settings)!;
const eventOf = (prayer: PrayerName): EventRow => harness.store.events.find((event) => event.prayer === prayer)!;
const instant = (prayer: PrayerName, date: string): Date => prayerTimesOnDay(config(), dayNumberFromDateString(date))[prayer];

function complete(prayer: PrayerName, date: string, doneAfterMinutes: number): void {
  const at = instant(prayer, date);
  harness.store.completions.push({
    id: `c-${prayer}-${date}`,
    user_id: harness.store.userId,
    event_id: eventOf(prayer).id,
    occurrence_at: at.toISOString(),
    status: 'done',
    snoozes_used: 0,
    done_at: new Date(at.getTime() + doneAfterMinutes * MINUTE).toISOString(),
  });
}

describe('prayers', () => {
  it("lists today's five with their window end and status", async () => {
    complete('fajr', '2026-11-08', 5);
    const result = await harness.run(['prayers', '--json']);
    expect(result.code).toBe(0);
    const rows = result.json['prayers'] as Array<Record<string, any>>;
    expect(rows.map((row) => [row['prayer'], row['status']])).toEqual([
      ['fajr', 'on time'],
      ['dhuhr', 'to come'],
      ['asr', 'to come'],
      ['maghrib', 'to come'],
      ['isha', 'to come'],
    ]);
    const dhuhr = rows[1]!;
    expect(dhuhr['window_ends'].iso).toBe(instant('asr', '2026-11-08').toISOString());
    expect(dhuhr['at']).toMatchObject({ timezone: TZ });
  });

  it('calls an unanswered prayer missed once its time is over, and a late and a made-up one by what they are', async () => {
    complete('fajr', '2026-11-07', 40);
    // Dhuhr of Nov 7: done after Asr began, so a qada.
    complete('dhuhr', '2026-11-07', 4 * 60);
    const result = await harness.run(['prayers', '--date', '2026-11-07', '--json']);
    const status = Object.fromEntries((result.json['prayers'] as Array<Record<string, any>>).map((row) => [row['prayer'], row['status']]));
    expect(status).toEqual({ fajr: 'late', dhuhr: 'qada', asr: 'missed', maghrib: 'missed', isha: 'missed' });
  });

  it('refuses when prayers are off, a bad date and too many days', async () => {
    expect((await harness.run(['prayers', '--date', '2026-13-40', '--json'])).code).toBe(5);
    expect((await harness.run(['prayers', '--days', '40', '--json'])).code).toBe(5);
    harness.store.settings['prayers_enabled'] = false;
    const off = await harness.run(['prayers', '--json']);
    expect(off.code).toBe(5);
    expect(off.json['error'].hint).toContain('prayers_enabled true');
  });
});

describe('qada list', () => {
  it('lists every prayer of the last 28 days whose time ran out with no record', async () => {
    complete('fajr', '2026-11-08', 5);
    const result = await harness.run(['qada', 'list', '--json']);
    expect(result.code).toBe(0);
    const open = result.json['qada'] as Array<Record<string, any>>;
    // From Oct 20 (when prayers were switched on) to this morning: 20 full days of five, minus the Nov 8 prayers still to come.
    expect(result.json['count']).toBe(open.length);
    expect(open.length).toBeGreaterThan(90);
    expect(open.every((row) => row['status'] === 'missed')).toBe(true);
    expect(open.some((row) => row['prayer_day'] === '2026-11-08' && row['prayer'] === 'fajr')).toBe(false);
    expect(open[0]!['prayer_day'] >= '2026-10-20').toBe(true);
  });
});

describe('an Isha after local midnight', () => {
  // Ariana's Isha is 23:16 in India; an hour's offset puts it at 00:16 the next clock date, still the evening's prayer.
  beforeEach(() => {
    Object.assign(harness.store.settings, { timezone: 'Asia/Kolkata', isha_offset_min: 60 });
  });

  it('is listed under its prayer-day, and that day is what qada done takes', async () => {
    const isha = instant('isha', '2026-11-05');
    const clockDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(isha);
    expect(clockDate).toBe('2026-11-06');

    const list = await harness.run(['qada', 'list', '--json']);
    const row = (list.json['qada'] as Array<Record<string, any>>).find((entry) => entry['prayer'] === 'isha' && entry['at'].iso === isha.toISOString());
    expect(row?.['prayer_day']).toBe('2026-11-05');

    // `prayers` shows it with the evening it belongs to, not with the next morning's prayers.
    const day = await harness.run(['prayers', '--date', '2026-11-05', '--json']);
    const onDay = (day.json['prayers'] as Array<Record<string, any>>).filter((entry) => entry['prayer_day'] === '2026-11-05');
    expect(onDay.map((entry) => entry['prayer'])).toEqual(['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']);
    const next = await harness.run(['prayers', '--date', '2026-11-06', '--json']);
    expect((next.json['prayers'] as Array<Record<string, any>>).map((entry) => entry['prayer_day'])).toEqual(['2026-11-06', '2026-11-06', '2026-11-06', '2026-11-06', '2026-11-06']);

    const done = await harness.run(['qada', 'done', 'isha', '--date', row!['prayer_day'], '--json']);
    expect(done.code, done.stdout).toBe(0);
    expect(harness.store.completions[0]).toMatchObject({ event_id: eventOf('isha').id, occurrence_at: isha.toISOString() });
    // It echoes the prayer-day it was given, not the clock date of the 00:16 ring.
    expect(done.json['date']).toBe('2026-11-05');
  });
});

describe('qada done', () => {
  it('records a made-up prayer with done_at = now, leaves the list, and undo puts it back', async () => {
    const before = ((await harness.run(['qada', 'list', '--json'])).json['qada'] as unknown[]).length;
    const result = await harness.run(['qada', 'done', 'maghrib', '--date', '2026-11-05', '--json']);
    expect(result.code).toBe(0);
    expect(harness.store.completions).toHaveLength(1);
    expect(harness.store.completions[0]).toMatchObject({
      event_id: eventOf('maghrib').id,
      occurrence_at: instant('maghrib', '2026-11-05').toISOString(),
      status: 'done',
      done_at: harness.clock.now.toISOString(),
    });
    expect(result.json['journal']).toMatchObject({ undo: 'alarm-cal undo' });

    // The recorded prayer is a qada now, not a miss.
    const day = await harness.run(['prayers', '--date', '2026-11-05', '--json']);
    expect((day.json['prayers'] as Array<Record<string, any>>).find((row) => row['prayer'] === 'maghrib')!['status']).toBe('qada');
    expect(((await harness.run(['qada', 'list', '--json'])).json['qada'] as unknown[]).length).toBe(before - 1);

    const undone = await harness.run(['undo', '--json']);
    expect(undone.code).toBe(0);
    expect(harness.store.completions).toEqual([]);
    expect(((await harness.run(['qada', 'list', '--json'])).json['qada'] as unknown[]).length).toBe(before);
  });

  it('refuses a prayer that is still inside its time, with when it ends', async () => {
    const asrEnd = prayerWindowEnd(config(), 'asr', instant('asr', '2026-11-08'), TZ)!;
    harness.clock.now = new Date(instant('asr', '2026-11-08').getTime() + 10 * MINUTE);
    const result = await harness.run(['qada', 'done', 'asr', '--date', '2026-11-08', '--json']);
    expect(result.code).toBe(5);
    expect(result.json['error'].message).toContain('still inside its time');
    expect(asrEnd.getTime()).toBeGreaterThan(harness.clock.now.getTime());
    expect(harness.store.completions).toEqual([]);
  });

  it('refuses a prayer that already has a record: qada is only for one that was missed', async () => {
    complete('dhuhr', '2026-11-05', 5);
    const result = await harness.run(['qada', 'done', 'dhuhr', '--date', '2026-11-05', '--json']);
    expect(result.code).toBe(6);
    expect(result.json['error'].code).toBe('conflict');
    expect(harness.store.completions).toHaveLength(1);
  });

  it('refuses a prayer to come, one older than 28 days, one before prayers were switched on, and bad input', async () => {
    expect((await harness.run(['qada', 'done', 'isha', '--date', '2026-11-08', '--json'])).code).toBe(5);
    harness.clock.now = new Date('2026-12-20T10:00:00.000Z');
    expect((await harness.run(['qada', 'done', 'dhuhr', '--date', '2026-11-08', '--json'])).code).toBe(5);
    harness.clock.now = new Date('2026-11-08T10:00:00.000Z');
    expect((await harness.run(['qada', 'done', 'dhuhr', '--date', '2026-10-10', '--json'])).code).toBe(5);
    expect((await harness.run(['qada', 'done', 'zuhr', '--date', '2026-11-05', '--json'])).code).toBe(2);
    expect((await harness.run(['qada', 'done', 'dhuhr', '--json'])).code).toBe(2);
    expect((await harness.run(['qada', 'done', 'dhuhr', '--date', 'yesterday', '--json'])).code).toBe(5);
    expect(harness.store.completions).toEqual([]);
  });

  it('shows up in stats as made up, not as a miss', async () => {
    await harness.run(['qada', 'done', 'dhuhr', '--date', '2026-11-05', '--json']);
    const stats = await harness.run(['stats', '--json']);
    const prayer = (stats.json['habits'] as Array<Record<string, any>>).find((habit) => habit['title'] === 'Prayer');
    expect(prayer?.['prayer_timings']).toMatchObject({ qada: 1 });
  });
});
