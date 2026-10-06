import {
  MAX_SHIFT_MINUTES,
  eventKindOf,
  isEventPassable,
  type EventRow,
  type ModeBehavior,
  type ModeRow,
  type ModeRuleRow,
} from '@alarm-calendar/core';

import type { RuleWriteInput } from './modes-api';

/** What a new "shift" rule starts at, and what a new "shorten" rule starts from (half the alarm, at least a minute). */
export const DEFAULT_SHIFT_MINUTES = 60;

export const BEHAVIOR_LABELS: Record<ModeBehavior, string> = {
  keep: 'Keep as is',
  skip: 'Pause',
  shift: 'Shift',
  shorten: 'Shorten',
};

/** One alarm's line in a mode's editor. */
export interface RuleRow {
  eventId: string;
  title: string;
  color: string | null;
  /** A non-passable alarm (medication, the alarm before an exam) is never paused, so Pause is not offered for it. */
  alwaysRings: boolean;
  behavior: ModeBehavior;
  /** Minutes, -720 to 720; only used when `behavior` is 'shift'. */
  shiftMinutes: number;
  /** Calendar block length; only used when `behavior` is 'shorten'. */
  durationMin: number;
}

/**
 * The alarms a mode can have a rule for: the active, repeating, ordinary ones (the habits). The prayers and
 * their reminders follow the prayer times and are never changed by a mode, and a one-off alarm only follows the
 * mode's default. Sorted by title so the list never reshuffles.
 */
export function ruleCandidates(events: readonly EventRow[]): EventRow[] {
  return events
    .filter((event) => event.active && eventKindOf(event) === 'normal' && event.repeat_unit !== 'none')
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

/** What an alarm with no rule of its own does under this mode. */
export function implicitBehavior(mode: Pick<ModeRow, 'default_behavior'>, alwaysRings: boolean): 'keep' | 'skip' {
  return mode.default_behavior === 'skip' && !alwaysRings ? 'skip' : 'keep';
}

/** The editor's lines for a mode: each alarm with the behavior it has now (its rule, else the mode's default). */
export function ruleRowsFor(mode: ModeRow, events: readonly EventRow[], rules: readonly ModeRuleRow[]): RuleRow[] {
  return ruleCandidates(events).map((event) => {
    const alwaysRings = !isEventPassable(event);
    const rule = rules.find((candidate) => candidate.mode_id === mode.id && candidate.event_id === event.id);
    // A skip rule on an always-ringing alarm is ignored by the rules, so it is shown as what it does.
    const behavior = rule?.behavior ?? implicitBehavior(mode, alwaysRings);
    return {
      eventId: event.id,
      title: event.title,
      color: event.color,
      alwaysRings,
      behavior: behavior === 'skip' && alwaysRings ? 'keep' : behavior,
      shiftMinutes: rule?.shift_minutes ?? DEFAULT_SHIFT_MINUTES,
      durationMin: rule?.duration_min ?? Math.max(1, Math.ceil(event.duration_min / 2)),
    };
  });
}

export interface RuleChanges {
  upserts: RuleWriteInput[];
  /** Ids of rules that are no longer needed: the alarm is back to what the mode's default does. */
  deletes: string[];
  /** Alarms whose line has a value the database would refuse (a shift of 0 minutes); nothing is written for them. */
  invalid: string[];
}

function sameRule(existing: ModeRuleRow, wanted: RuleWriteInput): boolean {
  return (
    existing.behavior === wanted.behavior &&
    existing.shift_minutes === wanted.shift_minutes &&
    existing.duration_min === wanted.duration_min
  );
}

/**
 * Turns the edited lines into writes. A line that does what the mode's default would do needs no rule (and an
 * existing one is deleted), so changing the default later still moves every alarm that was left alone. Only
 * lines that differ from what is stored are written.
 */
export function ruleChanges(mode: ModeRow, rows: readonly RuleRow[], rules: readonly ModeRuleRow[]): RuleChanges {
  const changes: RuleChanges = { upserts: [], deletes: [], invalid: [] };
  for (const row of rows) {
    const existing = rules.find((candidate) => candidate.mode_id === mode.id && candidate.event_id === row.eventId);
    const behavior: ModeBehavior = row.behavior === 'skip' && row.alwaysRings ? 'keep' : row.behavior;

    if (behavior === implicitBehavior(mode, row.alwaysRings)) {
      if (existing !== undefined) changes.deletes.push(existing.id);
      continue;
    }
    if (behavior === 'shift' && (!Number.isInteger(row.shiftMinutes) || row.shiftMinutes === 0 || Math.abs(row.shiftMinutes) > MAX_SHIFT_MINUTES)) {
      changes.invalid.push(row.eventId);
      continue;
    }
    if (behavior === 'shorten' && (!Number.isInteger(row.durationMin) || row.durationMin < 1 || row.durationMin > 1440)) {
      changes.invalid.push(row.eventId);
      continue;
    }
    const wanted: RuleWriteInput = {
      mode_id: mode.id,
      event_id: row.eventId,
      behavior,
      shift_minutes: behavior === 'shift' ? row.shiftMinutes : null,
      duration_min: behavior === 'shorten' ? row.durationMin : null,
    };
    if (existing === undefined || !sameRule(existing, wanted)) changes.upserts.push(wanted);
  }
  return changes;
}

/** "+1 h", "-30 min", "+1 h 30 min": a shift as a person reads it. */
export function describeShift(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  const parts = [hours > 0 ? `${hours} h` : '', rest > 0 ? `${rest} min` : ''].filter((part) => part !== '');
  return `${sign}${parts.join(' ')}`;
}
