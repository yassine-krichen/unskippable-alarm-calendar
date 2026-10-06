import { describe, expect, it } from 'vitest';

import { occurrencesBetween } from './recurrence';
import {
  buildSchedulePayload,
  DEFAULT_HORIZON_DAYS,
  expandSchedule,
  makeOccurrenceId,
  MAX_LOOKBACK_MINUTES,
  MAX_OCCURRENCES_PER_EVENT,
  MAX_SCHEDULE_OCCURRENCES,
} from './schedule';
import type { AlarmSettings, EventRow } from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const NOW = new Date('2026-03-02T09:00:00.000Z');
const USER = '99999999-9999-4999-8999-999999999999';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const SETTINGS: AlarmSettings = {
  user_id: USER,
  timezone: 'UTC',
  week_starts_on: 0,
  refire_seconds: 120,
  pass_cap: 2,
  grace_minutes: 30,
};

function event(overrides: Partial<EventRow> & { id: string }): EventRow {
  return {
    user_id: USER,
    title: 'Take medication',
    notes: null,
    start_at: new Date(NOW.getTime() + MINUTE).toISOString(),
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
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function expand(events: EventRow[], extra: Partial<Parameters<typeof expandSchedule>[0]> = {}) {
  return expandSchedule({
    events,
    cheatDays: [],
    settings: SETTINGS,
    completions: [],
    now: NOW,
    ...extra,
  });
}

describe('expandSchedule records', () => {
  it('keeps an occurrence thin and the existing id format', () => {
    const at = new Date(NOW.getTime() + MINUTE);
    const { occurrences } = expand([event({ id: A, title: 'Meds' })]);
    expect(occurrences).toEqual([
      { id: `${A}@2026-03-02T09:01:00.000Z`, eventId: A, at: at.toISOString(), silenced: false, completed: false },
    ]);
    expect(occurrences[0]?.id).toBe(makeOccurrenceId(A, at));
  });

  it('puts the text, snooze rules and sound once per event', () => {
    const { eventInfo } = expand(
      [
        event({ id: A, title: 'Meds', notes: 'with water', max_snoozes: 2, snooze_minutes: 7, repeat_unit: 'day' }),
        event({ id: B, active: false }),
      ],
      { settings: { ...SETTINGS, sound: 'chime' } }
    );
    expect(eventInfo).toEqual({
      [A]: { title: 'Meds', notes: 'with water', maxSnoozes: 2, snoozeMinutes: 7, soundId: 'chime' },
    });
  });

  it('has a null sound when none is set', () => {
    expect(expand([event({ id: A })]).eventInfo[A]?.soundId).toBeNull();
  });

  it('is sorted by instant then event id, with no duplicate ids', () => {
    const { occurrences } = expand([
      event({ id: B, repeat_unit: 'hour', start_at: '2026-03-02T09:00:00.000Z' }),
      event({ id: A, repeat_unit: 'day', start_at: '2026-03-02T10:00:00.000Z' }),
      event({ id: A, repeat_unit: 'day', start_at: '2026-03-02T10:00:00.000Z' }),
    ]);
    const keys = occurrences.map((o) => `${o.at}|${o.eventId}`);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(occurrences.map((o) => o.id)).size).toBe(occurrences.length);
    // A and B both ring at 10:00: A first.
    const ten = occurrences.filter((o) => o.at === '2026-03-02T10:00:00.000Z');
    expect(ten.map((o) => o.eventId)).toEqual([A, B]);
  });

  it('leaves out inactive events but still lists active events that have no occurrence in range', () => {
    const { occurrences, eventInfo } = expand([
      event({ id: A, active: false }),
      event({ id: B, start_at: new Date(NOW.getTime() + 400 * DAY).toISOString() }),
    ]);
    expect(occurrences).toEqual([]);
    expect(Object.keys(eventInfo)).toEqual([B]);
  });

  it('skips an event the recurrence rules refuse and keeps the others', () => {
    const failed: string[] = [];
    const { occurrences } = expand(
      [event({ id: A, repeat_unit: 'day', repeat_interval: 0 }), event({ id: B })],
      { onEventFailed: (id) => failed.push(id) }
    );
    expect(failed).toEqual([A]);
    expect(occurrences.map((o) => o.eventId)).toEqual([B]);
    // A failed event is still an active one, so its ringing alarm is not dismissed.
    expect(Object.keys(expand([event({ id: A, repeat_unit: 'day', repeat_interval: 0 })]).eventInfo)).toEqual([A]);
  });
});

describe('expandSchedule bounds', () => {
  it('reaches back by the grace window and forward by 60 days, both ends inclusive', () => {
    const horizonEndMs = NOW.getTime() + DEFAULT_HORIZON_DAYS * DAY;
    const { occurrences, horizonEnd } = expand([
      event({ id: A, start_at: new Date(NOW.getTime() - 30 * MINUTE).toISOString() }),
      event({ id: B, start_at: new Date(horizonEndMs).toISOString() }),
      event({ id: '33333333-3333-4333-8333-333333333333', start_at: new Date(horizonEndMs + 1).toISOString() }),
      event({
        id: '44444444-4444-4444-8444-444444444444',
        start_at: new Date(NOW.getTime() - 30 * MINUTE - 1).toISOString(),
      }),
    ]);
    expect(horizonEnd).toBe(new Date(horizonEndMs).toISOString());
    expect(occurrences.map((o) => o.eventId)).toEqual([A, B]);
  });

  it('honours a custom horizon', () => {
    const { occurrences, horizonEnd } = expand(
      [event({ id: A, repeat_unit: 'day', start_at: '2026-03-02T12:00:00.000Z' })],
      { horizonDays: 3 }
    );
    expect(occurrences).toHaveLength(3);
    expect(horizonEnd).toBe('2026-03-05T09:00:00.000Z');
  });

  it('caps the look-back at 7 days however large the grace window is', () => {
    const settings = { ...SETTINGS, grace_minutes: 525_600 };
    const sixDaysAgo = event({ id: A, start_at: new Date(NOW.getTime() - 6 * DAY).toISOString() });
    const eightDaysAgo = event({ id: B, start_at: new Date(NOW.getTime() - 8 * DAY).toISOString() });
    const { occurrences } = expand([sixDaysAgo, eightDaysAgo], { settings, horizonDays: 1 });
    expect(occurrences.map((o) => o.eventId)).toEqual([A]);
  });

  it('keeps only the latest occurrence of an event before now, however long the grace window', () => {
    // Hourly at :00 with 3 hours of grace: 06:00 to 09:00 are past, only 09:00 can still ring.
    const { occurrences } = expand(
      [event({ id: A, repeat_unit: 'hour', start_at: '2026-03-01T00:00:00.000Z' })],
      { settings: { ...SETTINGS, grace_minutes: 180 }, horizonDays: 0.1 }
    );
    expect(occurrences.map((o) => o.at)).toEqual([
      '2026-03-02T09:00:00.000Z',
      '2026-03-02T10:00:00.000Z',
      '2026-03-02T11:00:00.000Z',
    ]);
  });

  it('backfills a recurring occurrence missed inside the grace window', () => {
    const { occurrences } = expand(
      [event({ id: A, repeat_unit: 'day', start_at: '2026-02-20T08:45:00.000Z' })],
      { horizonDays: 1 }
    );
    expect(occurrences.map((o) => o.at)).toEqual(['2026-03-02T08:45:00.000Z', '2026-03-03T08:45:00.000Z']);
  });

  it('keeps a list of one hourly alarm over the default horizon whole', () => {
    const { occurrences, truncated } = expand([
      event({ id: A, repeat_unit: 'hour', start_at: '2026-03-02T09:00:00.000Z' }),
    ]);
    expect(truncated).toBe(false);
    expect(occurrences).toHaveLength(DEFAULT_HORIZON_DAYS * 24 + 1);
  });
});

describe('expandSchedule caps', () => {
  it('cuts one dense event at the per-event cap and pulls the horizon back to just before the cut', () => {
    const hourly = event({ id: A, repeat_unit: 'hour', start_at: '2026-03-02T09:00:00.000Z' });
    const { occurrences, truncated, horizonEnd } = expand([hourly], { horizonDays: 100 });
    expect(truncated).toBe(true);
    // The 09:00 occurrence at now counts as the backfilled one; the rest is future.
    expect(occurrences).toHaveLength(MAX_OCCURRENCES_PER_EVENT);
    const first = Date.parse('2026-03-02T09:00:00.000Z');
    const firstCut = first + MAX_OCCURRENCES_PER_EVENT * HOUR;
    expect(Date.parse(horizonEnd)).toBe(firstCut - 1);
    expect(Date.parse(occurrences.at(-1)!.at)).toBeLessThanOrEqual(Date.parse(horizonEnd));
  });

  it('cuts the whole list at the total cap, still complete for every event up to the new horizon', () => {
    const events = [A, B, '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'].map(
      (id) => event({ id, repeat_unit: 'hour', start_at: '2026-03-02T09:00:00.000Z' })
    );
    const { occurrences, truncated, horizonEnd } = expand(events);
    expect(truncated).toBe(true);
    expect(occurrences.length).toBeLessThanOrEqual(MAX_SCHEDULE_OCCURRENCES);
    expect(Date.parse(horizonEnd)).toBeLessThan(NOW.getTime() + DEFAULT_HORIZON_DAYS * DAY);
    expect(Date.parse(horizonEnd)).toBeGreaterThan(NOW.getTime() + 40 * DAY);
    for (const e of events) {
      const expected = occurrencesBetween(e, new Date(NOW.getTime()), new Date(Date.parse(horizonEnd) + 1), 'UTC');
      expect(occurrences.filter((o) => o.eventId === e.id)).toHaveLength(expected.length);
    }
  });

  it('never cuts at or before now: the backfilled occurrences all stay and the horizon ends at now', () => {
    // 5100 one-off alarms that rang 10 minutes ago: more than the total cap, all in the past.
    const events = Array.from({ length: MAX_SCHEDULE_OCCURRENCES + 100 }, (_, n) => {
      const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
      return event({ id, start_at: new Date(NOW.getTime() - 10 * MINUTE).toISOString() });
    });
    const { occurrences, truncated, horizonEnd } = expand(events);
    expect(occurrences).toHaveLength(MAX_SCHEDULE_OCCURRENCES + 100);
    expect(truncated).toBe(true);
    expect(horizonEnd).toBe(NOW.toISOString());
  });

  it('keeps the backfilled occurrence when only the future is cut', () => {
    const events = [A, B, '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'].map(
      (id) => event({ id, repeat_unit: 'hour', start_at: '2026-03-02T08:30:00.000Z' })
    );
    const { occurrences } = expand(events);
    expect(occurrences.filter((o) => o.at === '2026-03-02T08:30:00.000Z')).toHaveLength(4);
  });

  it('is not truncated when nothing hits a cap', () => {
    const { truncated, horizonEnd } = expand([event({ id: A, repeat_unit: 'day' })]);
    expect(truncated).toBe(false);
    expect(Date.parse(horizonEnd)).toBe(NOW.getTime() + 60 * DAY);
  });
});

describe('expandSchedule cheat days', () => {
  it('silences a passable occurrence by its local date in the settings time zone', () => {
    // 23:30 UTC on 2026-03-02 is already 00:30 on 03-03 in Tunis.
    const late = event({ id: A, start_at: '2026-03-02T23:30:00.000Z' });
    const utc = expand([late], { cheatDays: ['2026-03-02'] });
    expect(utc.occurrences[0]?.silenced).toBe(true);

    const tunis = expand([late], {
      cheatDays: ['2026-03-02'],
      settings: { ...SETTINGS, timezone: 'Africa/Tunis' },
    });
    expect(tunis.occurrences[0]?.silenced).toBe(false);
    const tunisNext = expand([late], {
      cheatDays: ['2026-03-03'],
      settings: { ...SETTINGS, timezone: 'Africa/Tunis' },
    });
    expect(tunisNext.occurrences[0]?.silenced).toBe(true);
  });

  it('never silences a non-passable occurrence', () => {
    const { occurrences } = expand([event({ id: A, passable: false })], { cheatDays: ['2026-03-02'] });
    expect(occurrences[0]?.silenced).toBe(false);
  });

  it('silences only the covered days of a series', () => {
    const { occurrences } = expand(
      [event({ id: A, repeat_unit: 'day', start_at: '2026-03-02T12:00:00.000Z' })],
      { cheatDays: ['2026-03-03'], horizonDays: 3 }
    );
    expect(occurrences.map((o) => [o.at.slice(0, 10), o.silenced])).toEqual([
      ['2026-03-02', false],
      ['2026-03-03', true],
      ['2026-03-04', false],
    ]);
  });
});

describe('expandSchedule completions', () => {
  const completion = (eventId: string, occurrenceAt: string) => ({ event_id: eventId, occurrence_at: occurrenceAt });

  it('marks a completed occurrence, matching a Supabase +00:00 timestamp', () => {
    const { occurrences } = expand([event({ id: A, repeat_unit: 'day', start_at: '2026-03-02T09:01:00.000Z' })], {
      completions: [completion(A, '2026-03-02T09:01:00+00:00')],
      horizonDays: 2,
    });
    expect(occurrences.map((o) => o.completed)).toEqual([true, false]);
  });

  it('does not mark an occurrence of another event or an unreadable completion', () => {
    const { occurrences } = expand([event({ id: A })], {
      completions: [completion(B, '2026-03-02T09:01:00.000Z'), completion(A, 'not a date')],
    });
    expect(occurrences[0]?.completed).toBe(false);
  });
});

describe('buildSchedulePayload', () => {
  it('wraps the expansion with the version, times, settings and refill inputs', () => {
    const events = [event({ id: A, repeat_unit: 'day' })];
    const payload = buildSchedulePayload({
      events,
      cheatDays: ['2026-03-05'],
      settings: SETTINGS,
      completions: [],
      now: NOW,
    });
    expect(payload).toMatchObject({
      version: 2,
      generatedAt: NOW.toISOString(),
      horizonEnd: new Date(NOW.getTime() + 60 * DAY).toISOString(),
      truncated: false,
      settings: SETTINGS,
      refillSource: { events, cheatDays: ['2026-03-05'] },
    });
    expect(Object.keys(payload.eventInfo)).toEqual([A]);
    expect(payload.occurrences.length).toBeGreaterThan(50);
  });

  it('states a grace window beyond the look-back as the look-back', () => {
    const payload = buildSchedulePayload({
      events: [],
      cheatDays: [],
      settings: { ...SETTINGS, grace_minutes: 525_600 },
      completions: [],
      now: NOW,
    });
    expect(payload.settings.grace_minutes).toBe(MAX_LOOKBACK_MINUTES);
  });
});
