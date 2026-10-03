import { describe, expect, it } from 'vitest';

import {
  MAX_EVENTS,
  parseBoolean,
  parseSchedulePayload,
  parseSessionPayload,
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
          event({ repeat_unit: 'year' }),
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
    if (parsed.ok) {
      expect(parsed.value.events).toEqual([good]);
      expect(parsed.dropped).toEqual({ events: 6, cheatDays: 0, completions: 0 });
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
    if (parsed.ok) {
      expect(parsed.value.completions).toEqual([goodCompletion]);
      expect(parsed.value.cheatDays).toEqual(['2026-03-04']);
      expect(parsed.dropped).toEqual({ events: 0, cheatDays: 2, completions: 2 });
    }
  });

  it('reports no drops for a clean payload', () => {
    const parsed = parseSchedulePayload(schedule());
    expect(parsed.ok && parsed.dropped).toEqual({ events: 0, cheatDays: 0, completions: 0 });
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
    if (parsed.ok) expect(parsed.value.events[0]).not.toHaveProperty('injected');
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
