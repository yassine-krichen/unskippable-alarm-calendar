import type { BuiltinModeKey, ModeRow, ModeRuleRow } from '@alarm-calendar/core';
import { z } from 'zod';

import { CliError } from '../errors';
import type { RuleValues } from '../store/store';

export const BUILTIN_MODE_KEYS: readonly BuiltinModeKey[] = ['exam', 'ramadan', 'vacation', 'sick'];

const BUILTIN_NAMES: Record<BuiltinModeKey, string> = {
  exam: 'Exam',
  ramadan: 'Ramadan',
  vacation: 'Vacation',
  sick: 'Sick',
};

/** What a plan or a command says an alarm does under a mode. `inherit` removes the alarm's own rule. */
export type BehaviorSpec =
  | { kind: 'keep' }
  | { kind: 'skip' }
  | { kind: 'inherit' }
  | { kind: 'shift'; minutes: number }
  | { kind: 'shorten'; minutes: number };

export const modeBehaviorSchema = z
  .union([
    z.enum(['keep', 'skip', 'inherit']),
    z.strictObject({ shift: z.number().int().min(-720).max(720) }),
    z.strictObject({ shorten: z.number().int().min(1).max(1440) }),
  ])
  .describe(
    '"keep" rings as usual, "skip" pauses it (passable alarms only), { shift: ±minutes } rings earlier or later (max 720), { shorten: minutes } shortens the calendar block, "inherit" removes the alarm\'s own rule so the mode default applies.'
  );

export type ModeBehaviorInput = z.infer<typeof modeBehaviorSchema>;

export function behaviorFromInput(input: ModeBehaviorInput): BehaviorSpec {
  if (typeof input === 'string') return { kind: input };
  if ('shift' in input) return { kind: 'shift', minutes: input.shift };
  return { kind: 'shorten', minutes: input.shorten };
}

/** From command words: `keep`, `skip`, `inherit`, `shift -120`, `shorten 30`. */
export function behaviorFromWords(words: readonly string[]): BehaviorSpec {
  const [word, amount, ...rest] = words;
  if (word === undefined || rest.length > 0) {
    throw new CliError('usage', 'Give a behaviour: keep, skip, inherit, shift <±minutes> or shorten <minutes>.');
  }
  if (word === 'keep' || word === 'skip' || word === 'inherit') {
    if (amount !== undefined) throw new CliError('usage', `"${word}" takes no amount.`);
    return { kind: word };
  }
  if (word === 'shift' || word === 'shorten') {
    const minutes = Number(amount);
    if (amount === undefined || !Number.isInteger(minutes)) {
      throw new CliError('usage', `"${word}" needs a whole number of minutes, like \`${word} ${word === 'shift' ? '-120' : '30'}\`.`);
    }
    if (word === 'shift' && Math.abs(minutes) > 720) throw new CliError('invalid_input', 'A shift is at most 720 minutes (12 hours) either way.');
    if (word === 'shorten' && (minutes < 1 || minutes > 1440)) throw new CliError('invalid_input', 'Shorten takes 1 to 1440 minutes.');
    return { kind: word, minutes };
  }
  throw new CliError('usage', `Unknown behaviour "${word}"; use keep, skip, inherit, shift or shorten.`);
}

/** The columns a behaviour is stored as; null for `inherit` (the rule is removed instead). */
export function ruleValues(spec: BehaviorSpec): RuleValues | null {
  switch (spec.kind) {
    case 'inherit':
      return null;
    case 'keep':
    case 'skip':
      return { behavior: spec.kind, shift_minutes: null, duration_min: null };
    case 'shift':
      return { behavior: 'shift', shift_minutes: spec.minutes, duration_min: null };
    case 'shorten':
      return { behavior: 'shorten', shift_minutes: null, duration_min: spec.minutes };
  }
}

export function describeRuleValues(values: Pick<ModeRuleRow, 'behavior' | 'shift_minutes' | 'duration_min'> | null): string {
  if (values === null) return 'mode default';
  switch (values.behavior) {
    case 'shift':
      return `shift ${(values.shift_minutes ?? 0) > 0 ? '+' : ''}${values.shift_minutes} min`;
    case 'shorten':
      return `shorten to ${values.duration_min} min`;
    default:
      return values.behavior;
  }
}

export function ruleValuesEqual(a: RuleValues, b: Pick<ModeRuleRow, 'behavior' | 'shift_minutes' | 'duration_min'>): boolean {
  return a.behavior === b.behavior && a.shift_minutes === b.shift_minutes && a.duration_min === b.duration_min;
}

export function modeLabel(mode: Pick<ModeRow, 'name' | 'builtin_key'>): string {
  return mode.builtin_key ?? mode.name;
}

/**
 * Finds a mode by built-in key (`sick`), id, or name (case-insensitive). A built-in the database does not have
 * yet is reported as missing so the caller can create the built-ins first.
 */
export function findMode(modes: readonly ModeRow[], ref: string): ModeRow | undefined {
  const lowered = ref.trim().toLowerCase();
  const matches = modes.filter(
    (mode) => mode.id === ref || mode.builtin_key === lowered || mode.name.toLowerCase() === lowered
  );
  const active = matches.filter((mode) => mode.active);
  const pool = active.length > 0 ? active : matches;
  if (pool.length > 1) {
    throw new CliError('ambiguous', `"${ref}" matches ${pool.length} modes: ${pool.map((mode) => `${mode.name} (${mode.id})`).join(', ')}.`, 'Use the mode id.');
  }
  return pool[0];
}

export function isBuiltinKey(ref: string): ref is BuiltinModeKey {
  return (BUILTIN_MODE_KEYS as readonly string[]).includes(ref.trim().toLowerCase());
}

export function builtinName(key: BuiltinModeKey): string {
  return BUILTIN_NAMES[key];
}

export function unknownModeError(ref: string, modes: readonly ModeRow[]): CliError {
  const known = modes.filter((mode) => mode.active).map(modeLabel);
  return new CliError('not_found', `No mode "${ref}".`, `Known modes: ${known.length > 0 ? known.join(', ') : 'none yet'}. Built-ins are exam, ramadan, vacation, sick.`);
}
