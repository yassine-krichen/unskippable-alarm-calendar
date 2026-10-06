import { describe, expect, it } from 'vitest';

import { buildRange, buildSwitchRequest, modeErrorMessage } from './mode-switch';

const SICK = '00000000-0000-4000-8000-0000000000e4';
// Wednesday 7 October 2026, 15:30 in Tunis (UTC+1, no DST).
const NOW = new Date('2026-10-07T14:30:00.000Z');
const TUNIS = 'Africa/Tunis';

describe('buildSwitchRequest: the header switch', () => {
  it('Normal is just "end the manual mode": no mode, no start, no end', () => {
    expect(buildSwitchRequest({ modeId: null, start: 'today', end: 'date', endDate: '' }, NOW, TUNIS)).toEqual({
      data: { modeId: null, startsAt: null, endsAt: null },
      error: null,
    });
  });

  it('switches on now and open-ended by default, until switched back', () => {
    expect(buildSwitchRequest({ modeId: SICK, start: 'now', end: 'open', endDate: '' }, NOW, TUNIS)).toEqual({
      data: { modeId: SICK, startsAt: null, endsAt: null },
      error: null,
    });
  });

  it('"since this morning" starts at the beginning of today in the settings zone', () => {
    const result = buildSwitchRequest({ modeId: SICK, start: 'today', end: 'open', endDate: '' }, NOW, TUNIS);
    expect(result.data?.startsAt).toBe('2026-10-06T23:00:00.000Z');
  });

  it('a chosen last day is included whole: the mode ends when the next day begins', () => {
    const result = buildSwitchRequest({ modeId: SICK, start: 'now', end: 'date', endDate: '2026-10-09' }, NOW, TUNIS);
    expect(result.data).toEqual({ modeId: SICK, startsAt: null, endsAt: '2026-10-09T23:00:00.000Z' });
  });

  it('allows today as the last day, refuses a missing, invalid or past one', () => {
    expect(buildSwitchRequest({ modeId: SICK, start: 'now', end: 'date', endDate: '2026-10-07' }, NOW, TUNIS).error).toBeNull();
    expect(buildSwitchRequest({ modeId: SICK, start: 'now', end: 'date', endDate: '' }, NOW, TUNIS).error).toMatch(/last day/);
    expect(buildSwitchRequest({ modeId: SICK, start: 'now', end: 'date', endDate: '2026-02-31' }, NOW, TUNIS).error).toMatch(/last day/);
    expect(buildSwitchRequest({ modeId: SICK, start: 'now', end: 'date', endDate: '2026-10-06' }, NOW, TUNIS).error).toMatch(/before today/);
  });

  it('decides "today" in the settings zone, not the device zone', () => {
    // 23:30 UTC on the 7th is already the 8th in Tunis.
    const lateUtc = new Date('2026-10-07T23:30:00.000Z');
    const result = buildSwitchRequest({ modeId: SICK, start: 'today', end: 'date', endDate: '2026-10-08' }, lateUtc, TUNIS);
    expect(result.data?.startsAt).toBe('2026-10-07T23:00:00.000Z');
    expect(result.data?.endsAt).toBe('2026-10-08T23:00:00.000Z');
  });
});

describe('buildRange: a planned range', () => {
  it('runs from the start of the first day to the start of the day after the last', () => {
    expect(buildRange({ modeId: SICK, firstDay: '2026-10-10', lastDay: '2026-10-12' }, TUNIS)).toEqual({
      data: { modeId: SICK, startsAt: '2026-10-09T23:00:00.000Z', endsAt: '2026-10-12T23:00:00.000Z' },
      error: null,
    });
  });

  it('a single day is a range of one day', () => {
    const { data } = buildRange({ modeId: SICK, firstDay: '2026-10-10', lastDay: '2026-10-10' }, TUNIS);
    expect(Date.parse(data!.endsAt) - Date.parse(data!.startsAt)).toBe(24 * 3_600_000);
  });

  it('refuses a last day before the first, and dates that do not exist', () => {
    expect(buildRange({ modeId: SICK, firstDay: '2026-10-10', lastDay: '2026-10-09' }, TUNIS).error).toMatch(/before the first/);
    expect(buildRange({ modeId: SICK, firstDay: '', lastDay: '2026-10-09' }, TUNIS).error).toMatch(/Pick/);
  });

  it('is a 23 hour day across a spring DST change, not 24', () => {
    const { data } = buildRange({ modeId: SICK, firstDay: '2026-03-29', lastDay: '2026-03-29' }, 'Europe/Paris');
    expect(Date.parse(data!.endsAt) - Date.parse(data!.startsAt)).toBe(23 * 3_600_000);
  });
});

describe('modeErrorMessage', () => {
  it('turns the RPC codes into sentences, and anything else into a generic one', () => {
    expect(modeErrorMessage('mode_not_found')).toMatch(/no longer exists/);
    expect(modeErrorMessage('invalid_start')).toMatch(/7 days/);
    expect(modeErrorMessage('Failed to fetch')).toMatch(/Can't reach/);
    expect(modeErrorMessage('boom')).toMatch(/Something went wrong/);
  });
});
