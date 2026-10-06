import { describe, expect, it } from 'vitest';

import { buildSchedulePayload } from '@alarm-calendar/core';
import type { EventRow } from '@alarm-calendar/core';

import { parseSchedulePayload } from './desktop-payloads';

const USER = '99999999-9999-4999-8999-999999999999';
const NOW = new Date('2026-10-06T09:00:00.000Z');

const SETTINGS = {
  user_id: USER,
  timezone: 'Africa/Tunis',
  week_starts_on: 0,
  refire_seconds: 120,
  pass_cap: 2,
  grace_minutes: 30,
  prayerSound: 'custom',
  prayers_enabled: true,
  prayers_enabled_since: '2026-09-01T00:00:00+00:00',
  latitude: 36.8625,
  longitude: 10.1956,
  location_label: 'Ariana, Tunisia',
  fajr_angle: 18,
  isha_angle: 18,
  asr_factor: 1 as const,
  fajr_offset_min: 0,
  dhuhr_offset_min: 2,
  asr_offset_min: 0,
  maghrib_offset_min: 0,
  isha_offset_min: 0,
  pre_prayer_minutes: 15,
  prayer_max_snoozes: 0,
  prayer_snooze_minutes: 5,
};

function row(kind: 'prayer' | 'pre_prayer', prayer: string | null, id: string): Record<string, unknown> {
  return {
    id,
    user_id: USER,
    title: kind === 'prayer' ? 'Dhuhr' : 'Before Dhuhr',
    notes: null,
    start_at: '2026-09-01T00:00:00+00:00',
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
    updated_at: '2026-09-01T00:00:00+00:00',
    kind,
    prayer,
  };
}

const PRAYER_ID = '00000001-0000-4000-8000-000000000001';
const PRE_ID = '00000002-0000-4000-8000-000000000001';
// Fajr is in the list because it is the prayer before Dhuhr: the Dhuhr reminder refers to it.
const FAJR_ID = '00000001-0000-4000-8000-000000000000';
const ROWS = [row('prayer', 'fajr', FAJR_ID), row('prayer', 'dhuhr', PRAYER_ID), row('pre_prayer', 'dhuhr', PRE_ID)];

function build() {
  return buildSchedulePayload({
    events: ROWS as unknown as EventRow[],
    cheatDays: [],
    settings: SETTINGS,
    completions: [],
    now: NOW,
    horizonDays: 3,
  });
}

describe('parseSchedulePayload, prayer times', () => {
  it('keeps the kind and prayer of events, the prayer settings, the labels and the event info kind', () => {
    const payload = build();
    const parsed = parseSchedulePayload(payload);
    expect(parsed.ok && parsed.version).toBe(2);
    if (!parsed.ok || parsed.version !== 2) return;
    expect(parsed.dropped).toEqual({ occurrences: 0, events: 0, cheatDays: 0, completions: 0 });
    expect(parsed.value.refillSource.events.map((e) => [e.kind, e.prayer])).toEqual([
      ['prayer', 'fajr'],
      ['prayer', 'dhuhr'],
      ['pre_prayer', 'dhuhr'],
    ]);
    expect(parsed.value.settings).toMatchObject({ prayers_enabled: true, dhuhr_offset_min: 2, prayerSound: 'custom', asr_factor: 1 });
    expect(parsed.value.eventInfo[PRAYER_ID]).toMatchObject({ kind: 'prayer', prayer: 'dhuhr' });
    expect(parsed.value.eventInfo[PRE_ID]).toMatchObject({ kind: 'pre_prayer', prayer: 'dhuhr' });
    expect(parsed.value.occurrences.some((occurrence) => occurrence.label !== undefined)).toBe(true);
    expect(parsed.value.occurrences).toEqual(payload.occurrences);
  });

  it('keeps a labelIfUnlogged instruction untouched', () => {
    const payload = build();
    const withInstruction = payload.occurrences.filter((occurrence) => occurrence.labelIfUnlogged !== undefined);
    expect(withInstruction.length).toBeGreaterThan(0);
    const parsed = parseSchedulePayload(payload);
    expect(parsed.ok && parsed.version === 2 && parsed.value.occurrences.filter((o) => o.labelIfUnlogged !== undefined)).toEqual(
      withInstruction
    );
  });

  it('drops an occurrence whose label is empty or whose conditional text names no occurrence', () => {
    const payload = build();
    const [first, second, ...rest] = payload.occurrences;
    const parsed = parseSchedulePayload({
      ...payload,
      occurrences: [{ ...first, label: '' }, { ...second, labelIfUnlogged: { id: 'not an id', label: 'x' } }, ...rest],
    });
    expect(parsed.ok && parsed.dropped.occurrences).toBe(2);
  });

  it('drops a prayer event without a prayer instead of letting it be scheduled from its start_at', () => {
    const payload = build();
    const parsed = parseSchedulePayload({
      ...payload,
      refillSource: { ...payload.refillSource, events: [row('prayer', null, PRAYER_ID), ROWS[0], ROWS[2]] },
    });
    expect(parsed.ok && parsed.dropped.events).toBe(1);
  });

  it('rejects prayer settings outside the database bounds', () => {
    for (const bad of [
      { latitude: 91 },
      { fajr_angle: 5 },
      { asr_factor: 3 },
      { pre_prayer_minutes: 500 },
      { dhuhr_offset_min: 90 },
      { prayerSound: 'Not A Sound!' },
    ]) {
      const parsed = parseSchedulePayload({ ...build(), settings: { ...SETTINGS, ...bad } });
      expect(parsed.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('still accepts settings from before prayer times', () => {
    const plain = { user_id: USER, timezone: 'Africa/Tunis', week_starts_on: 0, refire_seconds: 120, pass_cap: 2, grace_minutes: 30 };
    expect(parseSchedulePayload({ ...build(), settings: plain }).ok).toBe(true);
  });
});

describe('parseSchedulePayload, calendar visibility', () => {
  const shownOnly = { ...SETTINGS, show_prayers_in_calendar: true };
  const hiddenRows = ROWS.map((event) => ({ ...event, show_in_calendar: false }));

  function buildWith(events: Record<string, unknown>[], settings: typeof SETTINGS & { show_prayers_in_calendar?: boolean }) {
    return buildSchedulePayload({ events: events as unknown as EventRow[], cheatDays: [], settings, completions: [], now: NOW, horizonDays: 3 });
  }

  it('accepts the visibility flags and leaves what rings exactly as it was', () => {
    const baseline = buildWith(ROWS, SETTINGS);
    for (const [events, settings] of [
      [hiddenRows, SETTINGS],
      [ROWS, shownOnly],
      [hiddenRows, shownOnly],
    ] as const) {
      const parsed = parseSchedulePayload(buildWith(events, settings));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok || parsed.version !== 2) return;
      expect(parsed.dropped).toEqual({ occurrences: 0, events: 0, cheatDays: 0, completions: 0 });
      // A hidden alarm is in the list, with the same times and the same text, as a visible one.
      expect(parsed.value.occurrences).toEqual(baseline.occurrences);
    }
  });

  it('never drops an event or rejects a push over a malformed flag: it reads as absent', () => {
    const baseline = buildWith(ROWS, SETTINGS);
    const badSettings = parseSchedulePayload({ ...baseline, settings: { ...SETTINGS, show_prayers_in_calendar: 'no' } });
    expect(badSettings.ok).toBe(true);
    if (badSettings.ok && badSettings.version === 2) {
      expect(badSettings.value.settings.show_prayers_in_calendar).toBeUndefined();
      expect(badSettings.value.occurrences).toEqual(baseline.occurrences);
    }

    const badEvent = parseSchedulePayload({
      ...baseline,
      refillSource: { ...baseline.refillSource, events: [{ ...ROWS[0], show_in_calendar: 'no' }, ROWS[1], ROWS[2]] },
    });
    expect(badEvent.ok).toBe(true);
    if (badEvent.ok && badEvent.version === 2) {
      expect(badEvent.dropped).toEqual({ occurrences: 0, events: 0, cheatDays: 0, completions: 0 });
      expect(badEvent.value.refillSource.events).toHaveLength(3);
    }
  });
});
