import type { ModeRow } from '@alarm-calendar/core';

import { CliError } from '../errors';
import type { Recorder } from '../journal/recorder';
import { findMode, ruleValues, unknownModeError } from '../modes/mode-rules';
import type { Store } from '../store/store';

import type { PlanAction, PlanComputation, RuleAction } from './plan-diff';

export interface ApplyResult {
  created: number;
  updated: number;
  disabled: number;
  rulesWritten: number;
  rulesDeleted: number;
}

async function currentModes(store: Store, needBuiltins: boolean): Promise<ModeRow[]> {
  if (needBuiltins) await store.ensureBuiltinModes();
  return store.listModes();
}

/**
 * Writes what `computePlan` decided, through the recorder so every change lands in the undo journal. Order:
 * built-in modes if the plan needs one, new alarms (one statement), changes to existing alarms, then rules
 * (which need the ids of the alarms just created).
 */
export async function applyPlan(rec: Recorder, store: Store, computation: PlanComputation): Promise<ApplyResult> {
  const result: ApplyResult = { created: 0, updated: 0, disabled: 0, rulesWritten: 0, rulesDeleted: 0 };
  const modes = await currentModes(store, computation.missingBuiltins.length > 0);

  const idByKey = new Map<string, string>();
  const creates = computation.actions.filter((action): action is Extract<PlanAction, { kind: 'create' }> => action.kind === 'create');
  if (creates.length > 0) {
    const rows = await rec.createEvents(creates.map((action) => action.input));
    for (const row of rows) if (row.agent_key != null) idByKey.set(row.agent_key, row.id);
    result.created = rows.length;
  }

  for (const action of computation.actions) {
    if (action.kind !== 'patch') continue;
    await rec.updateEvent(action.existing, action.patch);
    if (action.patch.active === false) result.disabled += 1;
    else result.updated += 1;
  }

  for (const action of computation.actions) {
    if (action.rules.length === 0) continue;
    const eventId = action.kind === 'create' ? idByKey.get(action.key) : action.existing.id;
    if (eventId === undefined) throw new CliError('internal', `The alarm for ${action.key} was not created.`);
    for (const rule of action.rules) await writeRule(rec, modes, eventId, rule, result);
  }
  return result;
}

async function writeRule(
  rec: Recorder,
  modes: readonly ModeRow[],
  eventId: string,
  rule: RuleAction,
  result: ApplyResult
): Promise<void> {
  const mode = findMode(modes, rule.modeRef);
  if (mode === undefined) throw unknownModeError(rule.modeRef, modes);
  const values = ruleValues(rule.behavior);
  if (values === null) {
    if (rule.existing !== undefined) {
      await rec.deleteRule(rule.existing);
      result.rulesDeleted += 1;
    }
    return;
  }
  await rec.setRule(rule.existing, mode.id, eventId, values);
  result.rulesWritten += 1;
}
