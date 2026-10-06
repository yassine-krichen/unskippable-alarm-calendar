import { describe, expect, it } from 'vitest';

import { buildSchedulePayload, MAX_LOOKBACK_MINUTES } from '@alarm-calendar/core';
import type { EventRow } from '@alarm-calendar/core';

import {
  MAX_EVENTS,
  MAX_OCCURRENCES,
  parseBoolean,
  parseSchedulePayload,
  parseSessionPayload,
  upgradeLegacyPayload,
} from './desktop-payloads';

const USER = '99999999-9999-4999-8999-999999999999';
const EVENT = '11111111-1111-4111-8111-111111111111';
const SUPABASE = 'https://example-ref.supabase.co';

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT,
    user_id: USER,
    title: 'Take medication',
    notes: null,
    start_at: '2026-03-02T09:01:00+00:00',
    duration_min: 15,
    repeat_unit: 'week',
    repeat_interval: 1,
    repeat_weekdays: [0, 3],
    ends_at: null,
    max_snoozes: 3,
    snooze_minutes: 5,
    passable: true,
    color: null,
    active: true,
    updated_at: '2026-03-01T10:00:00.123456+00:00',
    ...overrides,
  };
}

function schedule(overrides: Record<string, unknown> = {}) {
  return {
    events: [event()],
    cheatDays: ['2026-03-04'],
    settings: {
      user_id: USER,
      timezone: 'Africa/Tunis',
      week_starts_on: 0,
      refire_seconds: 120,
      pass_cap: 2,
      grace_minutes: 30,
      sound: 'bell',
    },
    completions: [],
    ...overrides,
  };
}

// Header.payload.signature shape only; the value is not a real token.
const JWT_SHAPED = 'aaaa.bbbb.cccc';

function session(overrides: Record<string, unknown> = {}) {
  return {
    url: `${SUPABASE}`,
    publishableKey: 'sb_publishable_abc-123',
    userId: USER,
    accessToken: JWT_SHAPED,
    expiresAt: 1_800_000_000,
    ...overrides,
  };
}

describe('parseSchedulePayload', () => {
  it('accepts a real-shaped schedule with Supabase style timestamps', () => {
    const parsed = parseSchedulePayload(schedule());
    expect(parsed.ok).toBe(true);
  });

  it('accepts a yearly event and keeps its repeat_unit', () => {
    const yearly = event({ repeat_unit: 'year', repeat_weekdays: null });
    const parsed = parseSchedulePayload(schedule({ events: [yearly] }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.version === 1) {
      expect(parsed.value.events).toEqual([yearly]);
      expect(parsed.dropped.events).toBe(0);
    }
  });

  it('rejects anything that is not an object with the four fields', () => {
    expect(parseSchedulePayload(null).ok).toBe(false);
    expect(parseSchedulePayload('events').ok).toBe(false);
    expect(parseSchedulePayload({ events: [] }).ok).toBe(false);
  });

  it('drops an invalid event but keeps the valid ones and counts what it dropped', () => {
    const good = event({ id: '55555555-5555-4555-8555-555555555555' });
    const parsed = parseSchedulePayload(
      schedule({
        events: [
          event({ repeat_unit: 'decade' }),
          good,
          event({ start_at: '2026-02-31' }),
          event({ max_snoozes: 11 }),
          event({ repeat_weekdays: [7] }),
          event({ id: 'not-a-uuid' }),
          event({ title: 'x'.repeat(2001) }),
        ],
      })
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.version === 1) {
      expect(parsed.value.events).toEqual([good]);
      expect(parsed.dropped).toEqual({ occurrences: 0, events: 6, cheatDays: 0, completions: 0 });
    }
  });

  it('matches the database checks: blank title, zero duration and an empty weekday list are refused', () => {
    for (const bad of [{ title: '   ' }, { duration_min: 0 }, { repeat_weekdays: [] }, { repeat_interval: 0 }]) {
      const parsed = parseSchedulePayload(schedule({ events: [event(bad)] }));
      expect(parsed.ok && parsed.dropped.events).toBe(1);
    }
  });

  it('drops invalid completions and cheat days one at a time too', () => {
    const goodCompletion = {
      id: '66666666-6666-4666-8666-666666666666',
      user_id: USER,
      event_id: EVENT,
      occurrence_at: '2026-03-02T09:01:00+00:00',
      status: 'done',
      snoozes_used: 1,
      done_at: '2026-03-02T09:02:00+00:00',
    };
    const parsed = parseSchedulePayload(
      schedule({
        completions: [goodCompletion, { ...goodCompletion, status: 'maybe' }, 'junk'],
        cheatDays: ['2026-03-04', '04/03/2026', '2026-02-30'],
      })
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.version === 1) {
      expect(parsed.value.completions).toEqual([goodCompletion]);
      expect(parsed.value.cheatDays).toEqual(['2026-03-04']);
      expect(parsed.dropped).toEqual({ occurrences: 0, events: 0, cheatDays: 2, completions: 2 });
    }
  });

  it('reports no drops for a clean payload', () => {
    const parsed = parseSchedulePayload(schedule());
    expect(parsed.ok && parsed.dropped).toEqual({ occurrences: 0, events: 0, cheatDays: 0, completions: 0 });
  });

  it('still rejects the whole payload when an array is oversized', () => {
    const tooMany = Array.from({ length: MAX_EVENTS + 1 }, () => event());
    expect(parseSchedulePayload(schedule({ events: tooMany })).ok).toBe(false);
    expect(parseSchedulePayload(schedule({ events: 'not an array' })).ok).toBe(false);
  });

  it('rejects settings with an unknown time zone, a bad week start or a hostile sound id', () => {
    const base = schedule().settings;
    expect(parseSchedulePayload(schedule({ settings: { ...base, timezone: 'Mars/Base' } })).ok).toBe(false);
    expect(parseSchedulePayload(schedule({ settings: { ...base, week_starts_on: 7 } })).ok).toBe(false);
    expect(parseSchedulePayload(schedule({ settings: { ...base, sound: '../../etc' } })).ok).toBe(false);
  });

  it('accepts settings without a sound', () => {
    const { sound: _sound, ...withoutSound } = schedule().settings;
    expect(parseSchedulePayload(schedule({ settings: withoutSound })).ok).toBe(true);
  });

  it('drops fields it does not know instead of passing them to the scheduler', () => {
    const parsed = parseSchedulePayload(schedule({ events: [event({ injected: 'x' })] }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.version === 1) {
      expect(parsed.value.events[0]).not.toHaveProperty('injected');
    }
  });

  it('reports where it failed without echoing the value', () => {
    const base = schedule().settings;
    const parsed = parseSchedulePayload(schedule({ settings: { ...base, timezone: 'Secret/Zone-Value' } }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain('settings.timezone');
      expect(parsed.reason).not.toContain('Secret/Zone-Value');
    }
  });
});

describe('parseSchedulePayload, precomputed schedule (version 2)', () => {
  const NOW = new Date('2026-03-02T09:00:00.000Z');

  function precomputed(overrides: Record<string, unknown> = {}) {
    const base = schedule();
    const payload = buildSchedulePayload({
      events: [event({ repeat_unit: 'day', repeat_weekdays: null }) as unknown as EventRow],
      cheatDays: base.cheatDays,
      settings: base.settings,
      completions: [],
      now: NOW,
      horizonDays: 3,
    });
    return { ...payload, ...overrides };
  }

  it('accepts what core builds, unchanged', () => {
    const payload = precomputed();
    const parsed = parseSchedulePayload(payload);
    expect(parsed.ok && parsed.version).toBe(2);
    if (parsed.ok && parsed.version === 2) {
      expect(parsed.value.occurrences).toEqual(payload.occurrences);
      expect(parsed.value.horizonEnd).toBe(payload.horizonEnd);
      expect(Object.keys(parsed.value.eventInfo)).toEqual([EVENT]);
      expect(parsed.dropped).toEqual({ occurrences: 0, events: 0, cheatDays: 0, completions: 0 });
    }
  });

  it('drops an occurrence whose id disagrees with its event or instant, keeps the rest', () => {
    const payload = precomputed();
    const [first, ...rest] = payload.occurrences;
    const parsed = parseSchedulePayload({
      ...payload,
      occurrences: [
        { ...first, id: `${EVENT}@2026-03-02T09:02:00.000Z` },
        { ...first, eventId: '77777777-7777-4777-8777-777777777777' },
        { ...first, at: '2026-03-02T09:01:00+00:00' },
        ...rest,
      ],
    });
    expect(parsed.ok && parsed.dropped.occurrences).toBe(3);
    if (parsed.ok && parsed.version === 2) expect(parsed.value.occurrences).toEqual(rest);
  });

  it('drops event info with a blank title, a hostile sound id or too many snoozes, and the occurrences that relied on it', () => {
    const payload = precomputed();
    const [info] = Object.values(payload.eventInfo);
    for (const bad of [{ title: '  ' }, { soundId: '../../etc' }, { maxSnoozes: 11 }, { snoozeMinutes: 0 }]) {
      const parsed = parseSchedulePayload({ ...payload, eventInfo: { [EVENT]: { ...info, ...bad } } });
      expect(parsed.ok && parsed.dropped.occurrences).toBe(payload.occurrences.length + 1);
      if (parsed.ok && parsed.version === 2) {
        expect(parsed.value.occurrences).toEqual([]);
        expect(parsed.value.eventInfo).toEqual({});
      }
    }
  });

  it('strips unknown fields from occurrences and event info', () => {
    const payload = precomputed();
    const [first] = payload.occurrences;
    const parsed = parseSchedulePayload({
      ...payload,
      occurrences: [{ ...first, injected: 'x' }],
      eventInfo: { [EVENT]: { ...payload.eventInfo[EVENT], injected: 'y' } },
    });
    expect(parsed.ok && parsed.dropped.occurrences).toBe(0);
    if (parsed.ok && parsed.version === 2) {
      expect(parsed.value.occurrences[0]).not.toHaveProperty('injected');
      expect(parsed.value.eventInfo[EVENT]).not.toHaveProperty('injected');
    }
  });

  it('drops occurrences and event info of events that are not among the kept events', () => {
    const payload = precomputed();
    const stranger = '77777777-7777-4777-8777-777777777777';
    const [first] = payload.occurrences;
    const parsed = parseSchedulePayload({
      ...payload,
      occurrences: [
        ...payload.occurrences,
        { ...first, id: `${stranger}@${first!.at}`, eventId: stranger },
      ],
      eventInfo: { ...payload.eventInfo, [stranger]: payload.eventInfo[EVENT] },
    });
    // One occurrence and one info entry of the event that the refill source does not know.
    expect(parsed.ok && parsed.dropped.occurrences).toBe(2);
    if (parsed.ok && parsed.version === 2) {
      expect(parsed.value.occurrences).toEqual(payload.occurrences);
      expect(Object.keys(parsed.value.eventInfo)).toEqual([EVENT]);
    }
  });

  it('drops everything of an event whose own row was invalid and so was dropped from the refill source', () => {
    const payload = precomputed();
    const parsed = parseSchedulePayload({
      ...payload,
      refillSource: { events: [event({ repeat_unit: 'decade' })], cheatDays: [] },
    });
    expect(parsed.ok && parsed.dropped).toEqual({
      occurrences: payload.occurrences.length + 1,
      events: 1,
      cheatDays: 0,
      completions: 0,
    });
    if (parsed.ok && parsed.version === 2) expect(parsed.value.occurrences).toEqual([]);
  });

  it('accepts a grace window up to the look-back and rejects a larger one', () => {
    const payload = precomputed();
    expect(
      parseSchedulePayload(precomputed({ settings: { ...payload.settings, grace_minutes: MAX_LOOKBACK_MINUTES } })).ok
    ).toBe(true);
    expect(
      parseSchedulePayload(precomputed({ settings: { ...payload.settings, grace_minutes: MAX_LOOKBACK_MINUTES + 1 } })).ok
    ).toBe(false);
  });

  it('counts invalid refill events and cheat days as dropped', () => {
    const payload = precomputed();
    const parsed = parseSchedulePayload({
      ...payload,
      refillSource: {
        events: [...payload.refillSource.events, event({ repeat_unit: 'decade' })],
        cheatDays: ['2026-03-04', 'nope'],
      },
    });
    expect(parsed.ok && parsed.dropped).toEqual({ occurrences: 0, events: 1, cheatDays: 1, completions: 0 });
  });

  it('rejects a payload without the refill source, with too many occurrences or with bad settings', () => {
    const payload = precomputed();
    const { refillSource: _source, ...withoutSource } = payload;
    expect(parseSchedulePayload(withoutSource).ok).toBe(false);
    const many = Array.from({ length: MAX_OCCURRENCES + 1 }, () => payload.occurrences[0]);
    expect(parseSchedulePayload(precomputed({ occurrences: many })).ok).toBe(false);
    expect(
      parseSchedulePayload(precomputed({ settings: { ...payload.settings, timezone: 'Mars/Base' } })).ok
    ).toBe(false);
    expect(parseSchedulePayload(precomputed({ horizonEnd: 'tomorrow' })).ok).toBe(false);
  });

  it('treats a payload with an unknown version as unusable', () => {
    expect(parseSchedulePayload(precomputed({ version: 3 })).ok).toBe(false);
  });
});

describe('upgradeLegacyPayload (an older renderer pushing raw events)', () => {
  it('expands the events with core so the scheduler receives the same list a new renderer would send', () => {
    const parsed = parseSchedulePayload(schedule({ completions: [] }));
    expect(parsed.ok && parsed.version).toBe(1);
    if (!parsed.ok || parsed.version !== 1) return;
    const now = new Date('2026-03-02T09:00:00.000Z');
    const upgraded = upgradeLegacyPayload(parsed.value, now);
    expect(upgraded).toEqual(
      buildSchedulePayload({
        events: parsed.value.events,
        cheatDays: parsed.value.cheatDays,
        settings: parsed.value.settings,
        completions: [],
        now,
      })
    );
    expect(upgraded.version).toBe(2);
    expect(upgraded.occurrences.length).toBeGreaterThan(0);
  });

  it('folds the legacy completions into the completed flags', () => {
    const completion = {
      id: '66666666-6666-4666-8666-666666666666',
      user_id: USER,
      event_id: EVENT,
      occurrence_at: '2026-03-02T09:01:00+00:00',
      status: 'done',
      snoozes_used: 0,
      done_at: '2026-03-02T09:02:00+00:00',
    };
    const parsed = parseSchedulePayload(
      schedule({ events: [event({ repeat_unit: 'none', repeat_weekdays: null })], completions: [completion] })
    );
    if (!parsed.ok || parsed.version !== 1) throw new Error('expected a version 1 payload');
    const upgraded = upgradeLegacyPayload(parsed.value, new Date('2026-03-02T09:05:00.000Z'));
    expect(upgraded.occurrences.map((o) => [o.at, o.completed])).toEqual([['2026-03-02T09:01:00.000Z', true]]);
  });
});

describe('parseSessionPayload', () => {
  it('accepts null, which means sign-out', () => {
    expect(parseSessionPayload(null, SUPABASE)).toEqual({ ok: true, value: null });
  });

  it('accepts a session for the origin this build was made for', () => {
    expect(parseSessionPayload(session(), SUPABASE).ok).toBe(true);
  });

  it('refuses a session aimed at any other server', () => {
    expect(parseSessionPayload(session({ url: 'https://evil.example.com' }), SUPABASE).ok).toBe(false);
    expect(parseSessionPayload(session({ url: 'https://example-ref.supabase.co.evil.com' }), SUPABASE).ok).toBe(false);
  });

  it('refuses every session when the build has no Supabase origin', () => {
    expect(parseSessionPayload(session(), null).ok).toBe(false);
  });

  it('refuses a token that is not JWT shaped, an oversized token and a bad key', () => {
    expect(parseSessionPayload(session({ accessToken: 'plain' }), SUPABASE).ok).toBe(false);
    expect(parseSessionPayload(session({ accessToken: `${'a'.repeat(9000)}.b.c` }), SUPABASE).ok).toBe(false);
    expect(parseSessionPayload(session({ publishableKey: 'has space' }), SUPABASE).ok).toBe(false);
  });

  it('never puts the token in the failure reason', () => {
    const parsed = parseSessionPayload(session({ accessToken: 'secret-token-value' }), SUPABASE);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).not.toContain('secret-token-value');
  });
});

describe('parseBoolean', () => {
  it('accepts only real booleans', () => {
    expect(parseBoolean(true).ok).toBe(true);
    expect(parseBoolean('true').ok).toBe(false);
    expect(parseBoolean(1).ok).toBe(false);
  });
});
