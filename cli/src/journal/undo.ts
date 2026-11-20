import type { ModeActivationRow, ModeRuleRow } from '@alarm-calendar/core';

import { CliError } from '../errors';
import type { RuleValues, Store } from '../store/store';

import type { JournalEntry, JournalOp } from './journal';

const EVENT_RESTORE_COLUMNS = [
  'title',
  'notes',
  'start_at',
  'duration_min',
  'repeat_unit',
  'repeat_interval',
  'repeat_weekdays',
  'ends_at',
  'max_snoozes',
  'snooze_minutes',
  'passable',
  'color',
  'active',
  'show_in_calendar',
  'agent_key',
] as const;

const EXAM_RESTORE_COLUMNS = ['title', 'exam_at', 'difficulty', 'notes', 'active', 'agent_key'] as const;

function pick(row: Record<string, unknown>, columns: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(columns.filter((column) => column in row).map((column) => [column, row[column]]));
}

function ruleValues(row: Record<string, unknown>): RuleValues {
  return {
    behavior: row['behavior'] as RuleValues['behavior'],
    shift_minutes: (row['shift_minutes'] as number | null) ?? null,
    duration_min: (row['duration_min'] as number | null) ?? null,
  };
}

/** Runs a restore-insert; true when the row already exists (the store reports a duplicate as a conflict). */
async function alreadyThere(insert: () => Promise<void>): Promise<boolean> {
  try {
    await insert();
    return false;
  } catch (error) {
    if (error instanceof CliError && error.code === 'conflict') return true;
    throw error;
  }
}

/** Puts one change back. Creating something is undone by switching it off (alarms, exams) or deleting it (rules, ranges). */
async function revertOp(store: Store, op: JournalOp): Promise<string> {
  const before = op.before;
  switch (op.table) {
    case 'events':
    case 'exams': {
      const restore = op.table === 'events' ? EVENT_RESTORE_COLUMNS : EXAM_RESTORE_COLUMNS;
      const update = op.table === 'events' ? store.updateEvent.bind(store) : store.updateExam.bind(store);
      if (op.kind === 'insert' || before === null) {
        await update(op.id, { active: false });
        return `switched off the ${op.table === 'events' ? 'alarm' : 'exam'} that was created`;
      }
      await update(op.id, pick(before, restore));
      return `restored the ${op.table === 'events' ? 'alarm' : 'exam'}`;
    }
    case 'mode_rules': {
      if (op.kind === 'insert') {
        await store.deleteRules([op.id]);
        return 'removed a rule that was added';
      }
      if (before === null) return 'nothing to restore';
      if (op.kind === 'delete') {
        // A duplicate (23505) means a previous, interrupted undo already put it back.
        const rule = before as unknown as ModeRuleRow;
        if (await alreadyThere(() => store.insertRuleRow(rule))) {
          // Only the very same rule counts as restored; another rule for the same mode and alarm is a real conflict.
          if (!(await store.listRules()).some((candidate) => candidate.id === rule.id)) {
            throw new CliError('conflict', 'another rule already exists for that mode and alarm');
          }
          return 'rule was already restored';
        }
        return 'restored a rule that was removed';
      }
      await store.updateRule(op.id, ruleValues(before));
      return 'restored a rule';
    }
    case 'mode_activations': {
      if (op.kind === 'insert') {
        await store.deleteActivations([op.id]);
        return 'removed an activation that was added';
      }
      if (before === null) return 'nothing to restore';
      if (op.kind === 'delete') {
        if (await alreadyThere(() => store.insertActivationRow(before as unknown as ModeActivationRow))) return 'activation was already restored';
        return 'restored an activation that was removed';
      }
      await store.updateActivation(op.id, {
        starts_at: before['starts_at'] as string,
        ends_at: (before['ends_at'] as string | null) ?? null,
      });
      return 'restored an activation';
    }
    case 'settings': {
      if (before === null) return 'nothing to restore';
      await store.updateSettings(before);
      return 'restored settings';
    }
    case 'prayers': {
      if (before === null) return 'nothing to restore';
      await store.setPrayersEnabled(before['enabled'] === true);
      return 'restored the prayers switch';
    }
    case 'completions': {
      // Only a made-up prayer is ever written here, so undoing it is deleting that row: the prayer is missed again.
      if (op.kind === 'insert') {
        await store.deleteCompletion(op.id);
        return 'removed a made-up prayer, so it is missed again';
      }
      return 'nothing to restore';
    }
  }
}

type RowLike = Record<string, unknown>;

const RESTORED_FIELDS: Record<'events' | 'exams' | 'mode_rules' | 'mode_activations' | 'completions', readonly string[]> = {
  events: EVENT_RESTORE_COLUMNS,
  exams: EXAM_RESTORE_COLUMNS,
  completions: ['status', 'snoozes_used', 'done_at'],
  mode_rules: ['behavior', 'shift_minutes', 'duration_min'],
  mode_activations: ['starts_at', 'ends_at'],
};

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sameInstant = (a: unknown, b: unknown): boolean => typeof a === 'string' && typeof b === 'string' && Date.parse(a) === Date.parse(b);

function describeOp(op: JournalOp): string {
  const row = op.after ?? op.before;
  const name = row !== null && typeof row['title'] === 'string' ? ` "${row['title']}"` : '';
  const label: Record<JournalOp['table'], string> = {
    events: 'alarm',
    exams: 'exam',
    mode_rules: 'mode rule',
    mode_activations: 'mode activation',
    settings: 'setting',
    prayers: 'prayers switch',
    completions: 'made-up prayer',
  };
  return `${label[op.table]}${name}`;
}

export interface ConflictCheck {
  conflicts: string[];
  /** Rows (or settings columns) this entry covers, so an older entry of the same undo skips them. */
  keys: Set<string>;
}

/**
 * Before reverting, makes sure nothing changed the rows since the entry wrote them: the row's updated_at (or, for
 * settings, the written columns) must still be what the entry recorded after its last write. Rows a newer entry of the
 * same undo already covers are skipped, because reverting that entry moves them (and their updated_at) on purpose.
 */
export async function findUndoConflicts(store: Store, entry: JournalEntry, covered: ReadonlySet<string> = new Set()): Promise<ConflictCheck> {
  const lastByKey = new Map<string, JournalOp>();
  for (const op of entry.ops) {
    if (op.table === 'settings') {
      for (const column of Object.keys(op.after ?? {})) lastByKey.set(`settings|${column}`, { ...op, after: { [column]: (op.after ?? {})[column] } });
    } else {
      lastByKey.set(`${op.table}|${op.id}`, op);
    }
  }
  const cache = new Map<string, Promise<unknown>>();
  const once = <T>(name: string, load: () => Promise<T>): Promise<T> => {
    if (!cache.has(name)) cache.set(name, load());
    return cache.get(name) as Promise<T>;
  };
  const conflicts: string[] = [];
  for (const [key, op] of lastByKey) {
    if (covered.has(key)) continue;
    const after = op.after;
    if (op.table === 'settings' || op.table === 'prayers') {
      const settings = (await once('settings', () => store.getSettings())) as unknown as RowLike;
      if (op.table === 'prayers') {
        if ((settings['prayers_enabled'] === true) !== (after?.['enabled'] === true)) conflicts.push(`the prayers switch was changed since`);
      } else if (after !== null) {
        for (const [column, value] of Object.entries(after)) {
          if (!sameValue(settings[column], value)) conflicts.push(`setting ${column} was changed since (now ${JSON.stringify(settings[column] ?? null)})`);
        }
      }
      continue;
    }
    const rows = (await once<unknown[]>(op.table, async (): Promise<unknown[]> => {
      switch (op.table) {
        case 'events':
          return store.listEvents();
        case 'exams':
          return store.listExams();
        case 'mode_rules':
          return store.listRules();
        case 'completions': {
          // A day either side of the occurrence is plenty to find the one row.
          const at = Date.parse(String((op.after ?? op.before)?.['occurrence_at'] ?? ''));
          return (await store.listCompletions(new Date((Number.isNaN(at) ? 0 : at) - 86_400_000).toISOString())).rows;
        }
        default:
          return store.listActivations();
      }
    })) as unknown as RowLike[];
    const current = rows.find((row) => row['id'] === op.id);
    if (after === null) {
      // A removed rule is "back" when any rule now holds its (mode, alarm) slot, whatever its id.
      const back =
        op.table === 'mode_rules'
          ? rows.some((row) => row['mode_id'] === op.before?.['mode_id'] && row['event_id'] === op.before?.['event_id'])
          : current !== undefined;
      if (back) conflicts.push(`${describeOp(op)} exists again; it was removed by this change`);
      continue;
    }
    if (current === undefined) {
      conflicts.push(`${describeOp(op)} no longer exists`);
      continue;
    }
    const unchanged =
      current['updated_at'] !== undefined && after['updated_at'] !== undefined
        ? sameInstant(current['updated_at'], after['updated_at'])
        : RESTORED_FIELDS[op.table].every((field) => sameValue(current[field], after[field]));
    if (!unchanged) conflicts.push(`${describeOp(op)} was changed after this change`);
  }
  return { conflicts, keys: new Set(lastByKey.keys()) };
}

/**
 * Reverts every change of an entry, newest first. Each step that lands is reported to `onStepReverted` so an
 * interrupted undo can be retried: steps already done are skipped. Stops at the first failure and says how far it got.
 */
export async function undoEntry(
  store: Store,
  entry: JournalEntry,
  onStepReverted: (step: number) => Promise<void> = async () => undefined
): Promise<string[]> {
  if (entry.userId !== store.userId) {
    throw new CliError('conflict', `Change #${entry.id} was made by another account.`, 'Sign in as that account to undo it.');
  }
  const already = new Set(entry.revertedSteps ?? []);
  const done: string[] = [];
  for (let step = entry.ops.length - 1; step >= 0; step--) {
    if (already.has(step)) continue;
    const op = entry.ops[step] as JournalOp;
    try {
      done.push(await revertOp(store, op));
      await onStepReverted(step);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CliError(
        'conflict',
        `Could not fully undo change #${entry.id} (${already.size + done.length} of ${entry.ops.length} steps were reverted): ${reason}`,
        'Run `alarm-cal undo` again: it continues where this stopped.',
        { reverted: done }
      );
    }
  }
  return done;
}
