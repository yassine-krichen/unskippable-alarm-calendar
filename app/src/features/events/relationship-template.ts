import { nextOccurrence, type EventRow } from '@alarm-calendar/core';
import { z } from 'zod';

import { addDays, instantFromZoned, zonedDate, zonedParts } from '@/lib/zoned-time';

import { DEFAULT_DURATION_MIN, DEFAULT_MAX_SNOOZES, DEFAULT_SNOOZE_MINUTES, type EventWriteInput } from './event-form';

/**
 * The "Birthday / anniversary" template: one form, two linked yearly alarms.
 *  - prep: PREP_LEAD_DAYS before, titled "Prep for <name>'s birthday", the gift ideas as its notes;
 *  - wish: on the day, titled "Wish <name> a happy birthday".
 * Both are ordinary alarms (same snooze defaults as a new alarm) and both can be skipped by a cheat
 * day: a missed birthday wish is not a medication, so the cheat-day switch stays on.
 */

export const RELATIONSHIP_KINDS = ['birthday', 'anniversary'] as const;
export type RelationshipKind = (typeof RELATIONSHIP_KINDS)[number];

export const RELATIONSHIP_KIND_LABELS: Record<RelationshipKind, string> = {
  birthday: 'Birthday',
  anniversary: 'Anniversary',
};

export const PREP_LEAD_DAYS = 7;
export const DEFAULT_RELATIONSHIP_TIME = '09:00';
export const MIN_RELATIONSHIP_YEAR = 1900;
export const MAX_RELATIONSHIP_YEAR = 2200;

/** What the template form edits. Month and day are 1-based; the time is wall-clock in settings.timezone. */
export interface RelationshipFormValues {
  kind: RelationshipKind;
  personName: string;
  month: number;
  day: number;
  /** Four digits, or '' when the year is unknown or does not matter. */
  year: string;
  /** 'HH:mm' */
  time: string;
  giftNotes: string;
}

/** The two alarms of one template. */
export interface RelationshipGroup {
  prep: EventRow;
  wish: EventRow;
}

export interface RelationshipContext {
  tz: string;
  now: Date;
}

const WISH_TITLE = /^Wish (.+) a happy (birthday|anniversary)$/;
const PREP_TITLE_NAME = /^Prep for (.+)'s (birthday|anniversary)$/;

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dateString(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** The date in a given year; 29 February becomes 28 February in a common year, like the yearly rule. */
function clampedDate(year: number, month: number, day: number): string {
  return dateString(year, month, Math.min(day, daysInMonth(year, month)));
}

/**
 * The year a template without a typed year starts in: the year of the next time the wish alarm
 * rings after `reference`. A 29 February series starts on a real 29 February (the latest leap year
 * not after that year, so possibly in the past) because the yearly rule clamps from the original
 * date: only then does it return to the 29th in leap years instead of staying on the 28th.
 */
function defaultStartYear(month: number, day: number, time: string, tz: string, reference: Date): number {
  const currentYear = Number(zonedDate(reference, tz).slice(0, 4));
  let year = currentYear;
  if (instantFromZoned(clampedDate(currentYear, month, day), time, tz).getTime() <= reference.getTime()) {
    year += 1;
  }
  if (month === 2 && day === 29) {
    while (!isLeapYear(year)) year -= 1;
  }
  return year;
}

function startYear(values: RelationshipFormValues, context: RelationshipContext): number {
  if (values.year !== '') return Number(values.year);
  return defaultStartYear(values.month, values.day, values.time, context.tz, context.now);
}

/**
 * The first dates of the two series: the wish alarm on the day and the prep alarm 7 days earlier.
 * The prep date is fixed in the start year and then repeats on that month and day, so across a 29
 * February it ends up one day more or less than 7 days ahead in some years.
 */
export function planRelationshipDates(
  values: RelationshipFormValues,
  context: RelationshipContext
): { wishDate: string; prepDate: string } {
  const wishDate = dateString(startYear(values, context), values.month, values.day);
  return { wishDate, prepDate: addDays(wishDate, -PREP_LEAD_DAYS) };
}

export function defaultRelationshipFormValues(slotDate: string): RelationshipFormValues {
  return {
    kind: 'birthday',
    personName: '',
    month: Number(slotDate.slice(5, 7)),
    day: Number(slotDate.slice(8, 10)),
    year: '',
    time: DEFAULT_RELATIONSHIP_TIME,
    giftNotes: '',
  };
}

export function prepTitle(kind: RelationshipKind, personName: string): string {
  return `Prep for ${personName.trim()}'s ${kind}`;
}

export function wishTitle(kind: RelationshipKind, personName: string): string {
  return `Wish ${personName.trim()} a happy ${kind}`;
}

export function createRelationshipFormSchema() {
  return z
    .object({
      kind: z.enum(RELATIONSHIP_KINDS),
      personName: z.string().trim().min(1, 'Enter the name.').max(60, 'Keep the name under 60 characters.'),
      month: z.number('Pick a month.').int().min(1, 'Pick a month.').max(12, 'Pick a month.'),
      day: z.number('Enter a day.').int('Use a whole number.').min(1, 'Day must be 1 to 31.').max(31, 'Day must be 1 to 31.'),
      year: z
        .string()
        .trim()
        .refine(
          (value) =>
            value === '' ||
            (/^\d{4}$/.test(value) &&
              Number(value) >= MIN_RELATIONSHIP_YEAR &&
              Number(value) <= MAX_RELATIONSHIP_YEAR),
          `Enter a four-digit year (${MIN_RELATIONSHIP_YEAR} to ${MAX_RELATIONSHIP_YEAR}) or leave it empty.`
        ),
      time: z.string().regex(TIME_PATTERN, 'Enter a time like 08:30.'),
      giftNotes: z.string().max(2000, 'Keep gift ideas under 2000 characters.'),
    })
    .superRefine((values, ctx) => {
      // Without a year, 29 February is allowed: the alarm falls on the 28th in common years.
      const checkYear =
        values.year !== '' && /^\d{4}$/.test(values.year) ? Number(values.year) : 2000;
      if (values.day > daysInMonth(checkYear, values.month)) {
        const leapOnly = values.month === 2 && values.day === 29;
        ctx.addIssue({
          code: 'custom',
          path: [leapOnly && values.year !== '' ? 'year' : 'day'],
          message: leapOnly
            ? `${values.year} is not a leap year, so there is no 29 February.`
            : 'That month does not have that many days.',
        });
      }
    });
}

/** The columns both alarms share. A plain new alarm's snooze defaults; they are never part of the template form. */
function sharedColumns(groupId: string): Pick<
  EventWriteInput,
  | 'duration_min'
  | 'repeat_unit'
  | 'repeat_interval'
  | 'repeat_weekdays'
  | 'ends_at'
  | 'max_snoozes'
  | 'snooze_minutes'
  | 'passable'
  | 'color'
  | 'group_id'
> {
  return {
    duration_min: DEFAULT_DURATION_MIN,
    repeat_unit: 'year',
    repeat_interval: 1,
    repeat_weekdays: null,
    ends_at: null,
    max_snoozes: DEFAULT_MAX_SNOOZES,
    snooze_minutes: DEFAULT_SNOOZE_MINUTES,
    passable: true,
    color: null,
    group_id: groupId,
  };
}

/**
 * Converts validated template values to the two rows to write, prep first. When editing, the
 * settings the person may have changed on a row elsewhere (snooze, color, cheat-day switch,
 * duration) are carried over from the existing row, so propagating a rename or a new date does
 * not reset them.
 */
export function relationshipToWriteInputs(
  values: RelationshipFormValues,
  context: RelationshipContext,
  groupId: string,
  existing?: RelationshipGroup
): { prep: EventWriteInput; wish: EventWriteInput } {
  // An edit with no typed year plans from when the pair was created, the same basis the form uses to
  // decide whether a year was typed, so editing later never turns a derived year into a shown one.
  const planContext =
    existing !== undefined && values.year === ''
      ? { ...context, now: new Date(existing.wish.created_at ?? existing.wish.updated_at) }
      : context;
  const { wishDate, prepDate } = planRelationshipDates(values, planContext);
  const gifts = values.giftNotes.trim();
  const shared = sharedColumns(groupId);

  const carryOver = (row: EventRow | undefined): Partial<EventWriteInput> =>
    row === undefined
      ? {}
      : {
          duration_min: row.duration_min,
          max_snoozes: row.max_snoozes,
          snooze_minutes: row.snooze_minutes,
          passable: row.passable,
          color: row.color,
        };

  return {
    prep: {
      ...shared,
      ...carryOver(existing?.prep),
      title: prepTitle(values.kind, values.personName),
      notes: gifts === '' ? null : gifts,
      start_at: instantFromZoned(prepDate, values.time, context.tz).toISOString(),
    },
    wish: {
      ...shared,
      ...carryOver(existing?.wish),
      title: wishTitle(values.kind, values.personName),
      notes: null,
      start_at: instantFromZoned(wishDate, values.time, context.tz).toISOString(),
    },
  };
}

/**
 * The two alarms an edit would open as one template, or null for a plain alarm (or a group that
 * lost a member, or whose titles are not the template's): those open in the normal form. Prep and
 * wish are told apart by their titles, not by their order in time, because a save that failed
 * half-way can leave the prep alarm dated after the wish alarm.
 */
export function findRelationshipGroup(event: EventRow, events: readonly EventRow[]): RelationshipGroup | null {
  if (!event.group_id) return null;
  const members = events.filter((candidate) => candidate.group_id === event.group_id && candidate.active);
  if (members.length !== 2) return null;
  const wish = members.find((member) => WISH_TITLE.test(member.title));
  const prep = members.find((member) => PREP_TITLE_NAME.test(member.title));
  if (wish === undefined || prep === undefined || wish === prep) return null;
  if (prep.repeat_unit !== 'year' || wish.repeat_unit !== 'year') return null;
  return { prep, wish };
}

/** Fills the template form from an existing pair. The year shows only when it was typed, not derived. */
export function relationshipGroupToFormValues(group: RelationshipGroup, tz: string): RelationshipFormValues {
  const match = WISH_TITLE.exec(group.wish.title);
  const start = zonedParts(new Date(group.wish.start_at), tz);
  const month = Number(start.date.slice(5, 7));
  const day = Number(start.date.slice(8, 10));
  const startYearNumber = Number(start.date.slice(0, 4));
  const created = new Date(group.wish.created_at ?? group.wish.updated_at);
  const derivedYear = defaultStartYear(month, day, start.time, tz, created);
  return {
    kind: match?.[2] === 'anniversary' ? 'anniversary' : 'birthday',
    personName: match?.[1] ?? '',
    month,
    day,
    year: startYearNumber === derivedYear ? '' : String(startYearNumber),
    time: start.time,
    giftNotes: group.prep.notes ?? '',
  };
}

/** When each alarm rings next, for the form's preview line; null when the series never rings again. */
export function nextRelationshipRings(
  values: RelationshipFormValues,
  context: RelationshipContext,
  existing?: RelationshipGroup
): { prep: Date | null; wish: Date | null } {
  const inputs = relationshipToWriteInputs(values, context, 'preview', existing);
  const next = (input: EventWriteInput): Date | null =>
    nextOccurrence({ ...input, active: true }, context.now, context.tz);
  return { prep: next(inputs.prep), wish: next(inputs.wish) };
}
