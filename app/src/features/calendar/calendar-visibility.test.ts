import { DEFAULT_PRAYER_SETTINGS, buildSchedulePayload, computeHabitsReport, type EventRow, type Settings } from '@alarm-calendar/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HIDDEN_CLASS,
  dayImpact,
  expandOccurrences,
  hasHiddenAlarms,
  hiddenAlarmCount,
  isHiddenFromCalendar,
  toCalendarEvent,
  visibleOccurrences,
} from './calendar-events';
import { readShowHidden, useShowHiddenStore } from './show-hidden-preference';

function eventRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: 'e1',
    user_id: 'u1',
    title: 'Take medication',
    notes: null,
    start_at: '2026-10-05T08:00:00.000Z',
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
    updated_at: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

const SETTINGS: Settings = {
  user_id: 'u1',
  timezone: 'Africa/Tunis',
  week_starts_on: 0,
  refire_seconds: 120,
  pass_cap: 2,
  grace_minutes: 30,
  ...DEFAULT_PRAYER_SETTINGS,
  prayers_enabled: true,
};

const prayerRow = (prayer: 'fajr' | 'dhuhr', overrides: Partial<EventRow> = {}): EventRow =>
  eventRow({ id: `p-${prayer}`, title: prayer, kind: 'prayer', prayer, passable: false, ...overrides });

const range = { from: new Date('2026-10-05T23:00:00Z'), to: new Date('2026-10-07T23:00:00Z') };

describe('isHiddenFromCalendar', () => {
  it('hides an alarm whose own switch is off and shows every other alarm, including rows with no flag', () => {
    expect(isHiddenFromCalendar(eventRow({ show_in_calendar: false }), SETTINGS)).toBe(true);
    expect(isHiddenFromCalendar(eventRow({ show_in_calendar: true }), SETTINGS)).toBe(false);
    expect(isHiddenFromCalendar(eventRow(), SETTINGS)).toBe(false);
  });

  it('hides the prayers unless Settings says to show them, whatever their own row says', () => {
    expect(isHiddenFromCalendar(prayerRow('fajr'), SETTINGS)).toBe(true);
    expect(isHiddenFromCalendar(prayerRow('fajr', { show_in_calendar: true }), SETTINGS)).toBe(true);
    expect(isHiddenFromCalendar(prayerRow('fajr'), { ...SETTINGS, show_prayers_in_calendar: true })).toBe(false);
    expect(
      isHiddenFromCalendar(prayerRow('fajr', { show_in_calendar: false }), { ...SETTINGS, show_prayers_in_calendar: true })
    ).toBe(false);
  });

  it('treats settings from before the column as "hide the prayers"', () => {
    const { show_prayers_in_calendar: _flag, ...older } = SETTINGS;
    expect(isHiddenFromCalendar(prayerRow('fajr'), older)).toBe(true);
  });
});

describe('hiding alarms from the calendar views', () => {
  const events = [
    eventRow(),
    eventRow({ id: 'e2', title: 'Quiet one', show_in_calendar: false }),
    prayerRow('fajr'),
    prayerRow('dhuhr'),
  ];

  it('flags hidden occurrences but still expands them, so what rings and what is counted stay the same', () => {
    const all = expandOccurrences(events, range, SETTINGS, []);
    // 2 days of each of the 4 alarms.
    expect(all).toHaveLength(8);
    expect(
      all
        .filter((occurrence) => occurrence.hidden)
        .map((occurrence) => occurrence.eventId)
        .sort()
    ).toEqual(['e2', 'e2', 'p-dhuhr', 'p-dhuhr', 'p-fajr', 'p-fajr']);
  });

  it('leaves the hidden ones out by default and brings them back, faded, with Show hidden', () => {
    const all = expandOccurrences(events, range, SETTINGS, []);
    expect(visibleOccurrences(all, false).map((occurrence) => occurrence.eventId)).toEqual(['e1', 'e1']);
    expect(visibleOccurrences(all, true)).toHaveLength(8);
    const shown = visibleOccurrences(all, true).find((occurrence) => occurrence.eventId === 'e2')!;
    expect(toCalendarEvent(shown).className).toContain(HIDDEN_CLASS);
    expect(toCalendarEvent(shown).extendedProps.hidden).toBe(true);
    const plain = visibleOccurrences(all, false)[0]!;
    expect(toCalendarEvent(plain).className).not.toContain(HIDDEN_CLASS);
  });

  it('shows the prayers once Settings turns them on', () => {
    const all = expandOccurrences(events, range, { ...SETTINGS, show_prayers_in_calendar: true }, []);
    expect(
      visibleOccurrences(all, false)
        .map((occurrence) => occurrence.eventId)
        .sort()
    ).toEqual(['e1', 'e1', 'p-dhuhr', 'p-dhuhr', 'p-fajr', 'p-fajr']);
  });

  it('still counts hidden alarms in what a cheat day would silence or let ring', () => {
    const impact = dayImpact(events, '2026-10-08', SETTINGS, new Date('2026-10-01T00:00:00Z'));
    // e1 and the hidden e2 are passable, the two prayers ring anyway.
    expect(impact).toEqual({ silenced: 2, stillRing: 2 });
  });
});

describe('a hidden alarm is only hidden from the calendar', () => {
  const now = new Date('2026-10-12T12:00:00Z');
  const hiddenDaily = eventRow({ show_in_calendar: false, created_at: '2026-10-01T00:00:00Z' });

  it('is in the schedule list the alarm engines ring from', () => {
    const payload = buildSchedulePayload({ events: [hiddenDaily], cheatDays: [], settings: SETTINGS, completions: [], now, horizonDays: 3 });
    expect(payload.occurrences.length).toBeGreaterThanOrEqual(3);
    expect(Object.keys(payload.eventInfo)).toEqual(['e1']);
  });

  it('is scored as a habit like a visible one', () => {
    const scoreOf = (event: EventRow) => computeHabitsReport([event], [], [], SETTINGS, now).habits[0]!;
    const hidden = scoreOf(hiddenDaily);
    const shown = scoreOf({ ...hiddenDaily, show_in_calendar: true });
    expect(hidden.missed).toBeGreaterThan(0);
    expect(hidden).toEqual(shown);
  });
});

describe('hiddenAlarmCount', () => {
  it('counts distinct hidden alarms, not their rings, and leaves the prayers out', () => {
    const events = [
      eventRow({ id: 'a', show_in_calendar: false }),
      eventRow({ id: 'b', show_in_calendar: false }),
      eventRow({ id: 'c' }),
      prayerRow('fajr'),
      prayerRow('dhuhr'),
    ];
    const all = expandOccurrences(events, range, SETTINGS, []);
    // Two hidden alarms ringing twice each, plus four hidden prayer rings: the count is 2.
    expect(all.filter((occurrence) => occurrence.hidden)).toHaveLength(8);
    expect(hiddenAlarmCount(all)).toBe(2);
    expect(hiddenAlarmCount(visibleOccurrences(all, false))).toBe(0);
  });
});

describe('hasHiddenAlarms', () => {
  it('is true only when an active, drawable alarm is hidden', () => {
    expect(hasHiddenAlarms([eventRow()], SETTINGS)).toBe(false);
    expect(hasHiddenAlarms([eventRow({ show_in_calendar: false })], SETTINGS)).toBe(true);
    expect(hasHiddenAlarms([eventRow({ show_in_calendar: false, active: false })], SETTINGS)).toBe(false);
  });

  it('counts the prayers while they are on and hidden, not while prayers are off or shown', () => {
    expect(hasHiddenAlarms([prayerRow('fajr')], SETTINGS)).toBe(true);
    expect(hasHiddenAlarms([prayerRow('fajr')], { ...SETTINGS, prayers_enabled: false })).toBe(false);
    expect(hasHiddenAlarms([prayerRow('fajr')], { ...SETTINGS, show_prayers_in_calendar: true })).toBe(false);
    // The pre-prayer reminders are never drawn, so they are not "hidden alarms" either.
    expect(hasHiddenAlarms([prayerRow('fajr', { kind: 'pre_prayer' })], SETTINGS)).toBe(false);
  });
});

describe('show hidden preference', () => {
  const stored = new Map<string, string>();

  beforeEach(() => {
    stored.clear();
    // The tests run in Node: give device-preference.ts a localStorage to talk to.
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, value),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useShowHiddenStore.setState({ showHidden: false });
  });

  it('is off by default, is stored per device and is read back', () => {
    expect(readShowHidden()).toBe(false);
    useShowHiddenStore.getState().setShowHidden(true);
    expect(useShowHiddenStore.getState().showHidden).toBe(true);
    expect(readShowHidden()).toBe(true);
    useShowHiddenStore.getState().setShowHidden(false);
    expect(readShowHidden()).toBe(false);
  });

  it('still holds for the session when storage refuses the value', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      },
    });
    expect(readShowHidden()).toBe(false);
    useShowHiddenStore.getState().setShowHidden(true);
    expect(useShowHiddenStore.getState().showHidden).toBe(true);
  });
});
