import { occurrencesBetween, type EventRow } from '@alarm-calendar/core';
import { describe, expect, it } from 'vitest';

import type { EventWriteInput } from './event-form';
import {
  createRelationshipFormSchema,
  defaultRelationshipFormValues,
  findRelationshipGroup,
  nextRelationshipRings,
  planRelationshipDates,
  relationshipGroupToFormValues,
  relationshipToWriteInputs,
  type RelationshipFormValues,
} from './relationship-template';

const NOW = new Date('2026-10-06T10:00:00Z');
const GROUP = '22222222-2222-4222-8222-222222222222';

function values(overrides: Partial<RelationshipFormValues> = {}): RelationshipFormValues {
  return {
    kind: 'birthday',
    personName: 'Sam',
    month: 1,
    day: 3,
    year: '',
    time: '09:00',
    giftNotes: '',
    ...overrides,
  };
}

function inputs(overrides: Partial<RelationshipFormValues> = {}, tz = 'UTC') {
  return relationshipToWriteInputs(values(overrides), { tz, now: NOW }, GROUP);
}

function asRow(input: EventWriteInput, id: string): EventRow {
  return {
    ...input,
    id,
    user_id: '99999999-9999-4999-8999-999999999999',
    active: true,
    updated_at: NOW.toISOString(),
    created_at: NOW.toISOString(),
  };
}

function groupRows(overrides: Partial<RelationshipFormValues> = {}, tz = 'UTC') {
  const { prep, wish } = inputs(overrides, tz);
  return { prep: asRow(prep, 'prep'), wish: asRow(wish, 'wish') };
}

describe('relationshipToWriteInputs', () => {
  it('creates two yearly alarms that share one group id', () => {
    const { prep, wish } = inputs();
    for (const alarm of [prep, wish]) {
      expect(alarm).toMatchObject({ repeat_unit: 'year', repeat_interval: 1, repeat_weekdays: null, ends_at: null });
      expect(alarm.group_id).toBe(GROUP);
    }
  });

  it('puts the prep alarm 7 days before, across the year boundary: a 3 January birthday preps on 27 December', () => {
    const { prep, wish } = inputs({ month: 1, day: 3 });
    expect(prep.start_at).toBe('2026-12-27T09:00:00.000Z');
    expect(wish.start_at).toBe('2027-01-03T09:00:00.000Z');
  });

  it('titles the alarms for a birthday and for an anniversary', () => {
    expect(inputs().prep.title).toBe("Prep for Sam's birthday");
    expect(inputs().wish.title).toBe('Wish Sam a happy birthday');
    const anniversary = inputs({ kind: 'anniversary', personName: '  Alex and Jo ' });
    expect(anniversary.prep.title).toBe("Prep for Alex and Jo's anniversary");
    expect(anniversary.wish.title).toBe('Wish Alex and Jo a happy anniversary');
  });

  it('puts the gift ideas on the prep alarm only, and nothing when they are blank', () => {
    const withGifts = inputs({ giftNotes: '  a book, the blue scarf ' });
    expect(withGifts.prep.notes).toBe('a book, the blue scarf');
    expect(withGifts.wish.notes).toBeNull();
    expect(inputs({ giftNotes: '   ' }).prep.notes).toBeNull();
  });

  it('gives both alarms the snooze defaults of a new alarm and keeps the cheat-day switch on', () => {
    const { prep, wish } = inputs();
    for (const alarm of [prep, wish]) {
      expect(alarm).toMatchObject({
        max_snoozes: 3,
        snooze_minutes: 5,
        passable: true,
        duration_min: 15,
        color: null,
      });
    }
  });

  it('stores the time of day in the settings zone as UTC for both alarms', () => {
    // 09:00 in Paris is 08:00 UTC in winter (CET), where both of these dates fall.
    const { prep, wish } = inputs({ month: 1, day: 3 }, 'Europe/Paris');
    expect(prep.start_at).toBe('2026-12-27T08:00:00.000Z');
    expect(wish.start_at).toBe('2027-01-03T08:00:00.000Z');
  });

  it('starts at the next one: a date that already passed this year starts next year, one still ahead starts this year', () => {
    expect(inputs({ month: 3, day: 1 }).wish.start_at).toBe('2027-03-01T09:00:00.000Z');
    expect(inputs({ month: 12, day: 25 }).wish.start_at).toBe('2026-12-25T09:00:00.000Z');
  });

  it('starts next year when the alarm time of today has already passed', () => {
    // NOW is 10:00 on 6 October; 09:00 today has gone by, 11:00 has not.
    expect(inputs({ month: 10, day: 6, time: '09:00' }).wish.start_at).toBe('2027-10-06T09:00:00.000Z');
    expect(inputs({ month: 10, day: 6, time: '11:00' }).wish.start_at).toBe('2026-10-06T11:00:00.000Z');
  });

  it('starts in the typed year when one is given', () => {
    const { wish, prep } = inputs({ year: '1990' });
    expect(wish.start_at).toBe('1990-01-03T09:00:00.000Z');
    expect(prep.start_at).toBe('1989-12-27T09:00:00.000Z');
  });

  it('carries the snooze, color, duration and cheat-day settings of an existing pair over on edit', () => {
    const existing = groupRows();
    existing.prep = { ...existing.prep, max_snoozes: 0, color: '#ef4444', passable: false, duration_min: 30 };
    const edited = relationshipToWriteInputs(values({ personName: 'Samira' }), { tz: 'UTC', now: NOW }, GROUP, existing);
    expect(edited.prep).toMatchObject({
      title: "Prep for Samira's birthday",
      max_snoozes: 0,
      color: '#ef4444',
      passable: false,
      duration_min: 30,
    });
    expect(edited.wish).toMatchObject({ title: 'Wish Samira a happy birthday', max_snoozes: 3, passable: true });
  });
});

describe('29 February', () => {
  it('starts the series on a real 29 February so it returns to the 29th in leap years', () => {
    const { prep, wish } = inputs({ month: 2, day: 29 });
    expect(wish.start_at).toBe('2024-02-29T09:00:00.000Z');
    expect(prep.start_at).toBe('2024-02-22T09:00:00.000Z');
  });

  it('rings the wish on 28 February in common years and 29 February in leap years', () => {
    const { wish } = inputs({ month: 2, day: 29 });
    const rings = occurrencesBetween(
      { ...wish, active: true },
      new Date('2026-01-01T00:00:00Z'),
      new Date('2029-01-01T00:00:00Z'),
      'UTC'
    );
    expect(rings.map((date) => date.toISOString())).toEqual([
      '2026-02-28T09:00:00.000Z',
      '2027-02-28T09:00:00.000Z',
      '2028-02-29T09:00:00.000Z',
    ]);
  });

  it('rings the prep alarm on 22 February every year, 7 days before a real 29 February', () => {
    const { prep } = inputs({ month: 2, day: 29 });
    const rings = occurrencesBetween(
      { ...prep, active: true },
      new Date('2027-01-01T00:00:00Z'),
      new Date('2029-01-01T00:00:00Z'),
      'UTC'
    );
    expect(rings.map((date) => date.toISOString())).toEqual([
      '2027-02-22T09:00:00.000Z',
      '2028-02-22T09:00:00.000Z',
    ]);
  });

  it('starts on the typed leap year', () => {
    expect(planRelationshipDates(values({ month: 2, day: 29, year: '2000' }), { tz: 'UTC', now: NOW })).toEqual({
      wishDate: '2000-02-29',
      prepDate: '2000-02-22',
    });
  });

  it('starts on the next 29 February when it is still ahead', () => {
    const early = new Date('2027-06-01T00:00:00Z');
    const plan = planRelationshipDates(values({ month: 2, day: 29 }), { tz: 'UTC', now: early });
    expect(plan.wishDate).toBe('2028-02-29');
  });

  it('starts on the 29 February just gone by when the next one has not come yet', () => {
    const after = new Date('2028-03-01T00:00:00Z');
    const plan = planRelationshipDates(values({ month: 2, day: 29 }), { tz: 'UTC', now: after });
    expect(plan.wishDate).toBe('2028-02-29');
  });
});

describe('createRelationshipFormSchema', () => {
  const schema = createRelationshipFormSchema();
  const issues = (input: RelationshipFormValues): string[] => {
    const result = schema.safeParse(input);
    return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
  };

  it('accepts a complete form', () => {
    expect(issues(values())).toEqual([]);
    expect(issues(values({ year: '1990' }))).toEqual([]);
  });

  it('asks for a name', () => {
    expect(issues(values({ personName: '   ' }))).toEqual(['personName']);
  });

  it('rejects a day that the month does not have', () => {
    expect(issues(values({ month: 2, day: 30 }))).toEqual(['day']);
    expect(issues(values({ month: 4, day: 31 }))).toEqual(['day']);
    expect(issues(values({ month: 1, day: 31 }))).toEqual([]);
  });

  it('allows 29 February without a year or in a leap year, and rejects it in a common year', () => {
    expect(issues(values({ month: 2, day: 29 }))).toEqual([]);
    expect(issues(values({ month: 2, day: 29, year: '2024' }))).toEqual([]);
    expect(issues(values({ month: 2, day: 29, year: '2027' }))).toEqual(['year']);
    expect(issues(values({ month: 2, day: 29, year: '1900' }))).toEqual(['year']);
  });

  it('rejects a year that is not four digits in range', () => {
    expect(issues(values({ year: '99' }))).toEqual(['year']);
    expect(issues(values({ year: 'abcd' }))).toEqual(['year']);
    expect(issues(values({ year: '1800' }))).toEqual(['year']);
  });

  it('rejects a malformed time', () => {
    expect(issues(values({ time: '25:00' }))).toEqual(['time']);
  });
});

describe('editing a pair', () => {
  const tz = 'UTC';

  it('finds the pair from either alarm and tells prep from wish', () => {
    const { prep, wish } = groupRows();
    const events = [wish, prep];
    expect(findRelationshipGroup(prep, events)).toEqual({ prep, wish });
    expect(findRelationshipGroup(wish, events)).toEqual({ prep, wish });
  });

  it('treats an alarm without a group, or whose partner is gone, as a plain alarm', () => {
    const { prep, wish } = groupRows();
    expect(findRelationshipGroup({ ...prep, group_id: null }, [prep, wish])).toBeNull();
    expect(findRelationshipGroup(prep, [prep])).toBeNull();
    expect(findRelationshipGroup({ ...prep, group_id: undefined }, [prep, wish])).toBeNull();
  });

  it('tells prep from wish by title when a half-failed save left the prep alarm dated after the wish', () => {
    const { prep, wish } = groupRows();
    const moved = { ...prep, start_at: '2027-02-03T09:00:00.000Z' };
    expect(findRelationshipGroup(moved, [wish, moved])).toEqual({ prep: moved, wish });
    expect(findRelationshipGroup(wish, [moved, wish])).toEqual({ prep: moved, wish });
  });

  it('does not pair two alarms that are both prep-shaped or both wish-shaped', () => {
    const { prep, wish } = groupRows();
    expect(findRelationshipGroup(prep, [prep, { ...wish, title: prep.title }])).toBeNull();
    expect(findRelationshipGroup(wish, [wish, { ...prep, title: wish.title }])).toBeNull();
  });

  it('treats a group whose titles are not the template ones as plain alarms', () => {
    const { prep, wish } = groupRows();
    expect(findRelationshipGroup(prep, [prep, { ...wish, title: 'Something else' }])).toBeNull();
  });

  it('turns a saved pair back into the same form values', () => {
    const original = values({
      personName: 'Alex and Jo',
      kind: 'anniversary',
      month: 6,
      day: 12,
      time: '18:45',
      giftNotes: 'dinner',
    });
    expect(relationshipGroupToFormValues(groupRows(original), tz)).toEqual(original);
  });

  it('shows the year only when one was typed', () => {
    expect(relationshipGroupToFormValues(groupRows({ year: '' }), tz).year).toBe('');
    expect(relationshipGroupToFormValues(groupRows({ year: '1990' }), tz).year).toBe('1990');
  });

  it('keeps a 29 February pair without a year free of a year field', () => {
    const form = relationshipGroupToFormValues(groupRows({ month: 2, day: 29 }), tz);
    expect(form).toMatchObject({ month: 2, day: 29, year: '' });
  });

  it('moves both alarms when the date changes', () => {
    const existing = groupRows();
    const moved = relationshipToWriteInputs(values({ month: 2, day: 10 }), { tz, now: NOW }, GROUP, existing);
    expect(moved.wish.start_at).toBe('2027-02-10T09:00:00.000Z');
    expect(moved.prep.start_at).toBe('2027-02-03T09:00:00.000Z');
  });
});

describe('editing in a later year', () => {
  const later = new Date('2028-05-01T10:00:00Z');
  const tz = 'UTC';

  it('keeps the start year of a pair with no typed year when only the name changes', () => {
    const existing = groupRows();
    const edited = relationshipToWriteInputs(values({ personName: 'Samira' }), { tz, now: later }, GROUP, existing);
    expect(edited.wish.start_at).toBe(existing.wish.start_at);
    expect(edited.prep.start_at).toBe(existing.prep.start_at);
  });

  it('never shows a year the person did not type, even after the date moves in a later year', () => {
    const existing = groupRows();
    for (const change of [{}, { month: 12, day: 25 }, { month: 2, day: 29 }, { time: '18:30' }]) {
      const edited = relationshipToWriteInputs(values(change), { tz, now: later }, GROUP, existing);
      const reopened = relationshipGroupToFormValues(
        { prep: asRow(edited.prep, 'prep'), wish: asRow(edited.wish, 'wish') },
        tz
      );
      expect(reopened.year).toBe('');
      expect(reopened).toMatchObject({ month: change.month ?? 1, day: change.day ?? 3 });
    }
  });

  it('re-plans only month, day and time: a new date still starts in the pair own start year basis', () => {
    const existing = groupRows();
    const edited = relationshipToWriteInputs(values({ month: 12, day: 25 }), { tz, now: later }, GROUP, existing);
    expect(edited.wish.start_at).toBe('2026-12-25T09:00:00.000Z');
    expect(edited.prep.start_at).toBe('2026-12-18T09:00:00.000Z');
  });

  it('keeps a typed year as typed', () => {
    const existing = groupRows({ year: '1990' });
    const edited = relationshipToWriteInputs(values({ year: '1990' }), { tz, now: later }, GROUP, existing);
    expect(edited.wish.start_at).toBe('1990-01-03T09:00:00.000Z');
    const reopened = relationshipGroupToFormValues(
      { prep: asRow(edited.prep, 'prep'), wish: asRow(edited.wish, 'wish') },
      tz
    );
    expect(reopened.year).toBe('1990');
  });

  it('previews the next rings from the edited pair', () => {
    const existing = groupRows();
    const rings = nextRelationshipRings(values(), { tz, now: later }, existing);
    expect(rings.wish?.toISOString()).toBe('2029-01-03T09:00:00.000Z');
    expect(rings.prep?.toISOString()).toBe('2028-12-27T09:00:00.000Z');
  });
});

describe('nextRelationshipRings', () => {
  it('previews the next prep and wish alarms', () => {
    const rings = nextRelationshipRings(values(), { tz: 'UTC', now: NOW });
    expect(rings.prep?.toISOString()).toBe('2026-12-27T09:00:00.000Z');
    expect(rings.wish?.toISOString()).toBe('2027-01-03T09:00:00.000Z');
  });

  it('previews a prep alarm that already passed this year as next year', () => {
    // The birthday is in 3 days; its prep alarm was 4 days ago, so it rings next year.
    const rings = nextRelationshipRings(values({ month: 10, day: 9 }), { tz: 'UTC', now: NOW });
    expect(rings.wish?.toISOString()).toBe('2026-10-09T09:00:00.000Z');
    expect(rings.prep?.toISOString()).toBe('2027-10-02T09:00:00.000Z');
  });
});

describe('defaultRelationshipFormValues', () => {
  it('prefills the month and day of the clicked slot and a 09:00 alarm', () => {
    expect(defaultRelationshipFormValues('2026-10-06')).toMatchObject({
      kind: 'birthday',
      month: 10,
      day: 6,
      year: '',
      time: '09:00',
    });
  });
});
