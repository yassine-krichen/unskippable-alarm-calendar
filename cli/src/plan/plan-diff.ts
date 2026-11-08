import type { EventRow, EventWriteInput, ModeRow, ModeRuleRow } from '@alarm-calendar/core';

import { CliError } from '../errors';
import {
  changedColumns,
  describeEventRow,
  diffFriendly,
  resolveEventSpec,
  type FieldChange,
  type FriendlyEvent,
} from '../events/event-spec';
import {
  behaviorFromInput,
  describeRuleValues,
  findMode,
  isBuiltinKey,
  ruleValues,
  ruleValuesEqual,
  unknownModeError,
  type BehaviorSpec,
} from '../modes/mode-rules';
import type { EventPatch, RuleValues } from '../store/store';

import type { Plan, PlanItem } from './plan-schema';

export interface PlanState {
  events: readonly EventRow[];
  modes: readonly ModeRow[];
  rules: readonly ModeRuleRow[];
  tz: string;
  now: Date;
}

export interface RuleChange {
  mode: string;
  action: 'create' | 'update' | 'delete';
  from: string;
  to: string;
}

export type ItemAction = 'create' | 'update' | 'enable' | 'disable' | 'unchanged' | 'skip';

export interface ItemDiff {
  key: string;
  action: ItemAction;
  title: string;
  /** The id of the existing alarm, when there is one. */
  eventId?: string;
  /** Why, for disable and skip. */
  reason?: string;
  /** Field-level changes in plan vocabulary: for a create, every field `to` its value. */
  changes: FieldChange[];
  rules: RuleChange[];
}

export interface PlanDiff {
  namespace: string;
  timezone: string;
  prune: boolean;
  items: ItemDiff[];
  summary: { create: number; update: number; enable: number; disable: number; unchanged: number; skip: number; ruleChanges: number };
  /** Keyed alarms in this namespace that the plan does not mention (switched off only with `prune`). */
  notInPlan: string[];
  warnings: string[];
}

/** A rule the apply step has to write: the mode is resolved when it runs, because a built-in may not exist yet. */
export interface RuleAction {
  modeRef: string;
  behavior: BehaviorSpec;
  existing: ModeRuleRow | undefined;
}

export type PlanAction =
  | { kind: 'create'; key: string; input: EventWriteInput; rules: RuleAction[] }
  | { kind: 'patch'; key: string; existing: EventRow; patch: EventPatch; rules: RuleAction[] }
  | { kind: 'rules'; key: string; existing: EventRow; rules: RuleAction[] };

export interface PlanComputation {
  diff: PlanDiff;
  actions: PlanAction[];
  /** Built-in modes the plan uses that the database does not have yet. */
  missingBuiltins: string[];
}

function friendlyAll(friendly: FriendlyEvent): FieldChange[] {
  return Object.entries(friendly).map(([field, to]) => ({ field, from: null, to }));
}

function pushWarning(warnings: string[], key: string, message: string): void {
  warnings.push(`${key}: ${message}`);
}

/**
 * Compares the plan with what is in the database and says what applying it would do. Pure: it reads the
 * state it is given and writes nothing. Items are matched by agent key, so renaming a title updates the
 * alarm in place; an item whose key is unknown creates one; an item identical to its alarm is left alone.
 */
export function computePlan(plan: Plan, state: PlanState): PlanComputation {
  const { tz, now } = state;
  const warnings: string[] = [];
  const items: ItemDiff[] = [];
  const actions: PlanAction[] = [];
  const missingBuiltins = new Set<string>();
  const byKey = new Map<string, EventRow>();
  for (const event of state.events) {
    if (event.agent_key != null) byKey.set(event.agent_key, event);
  }

  for (const [key, item] of Object.entries(plan.items)) {
    const existing = byKey.get(key);
    const wantsActive = item.enabled !== false;
    const diff: ItemDiff = { key, action: 'unchanged', title: item.title, changes: [], rules: [] };
    items.push(diff);

    if (!wantsActive) {
      if (existing === undefined) {
        diff.action = 'skip';
        diff.reason = 'enabled is false and the alarm does not exist';
      } else if (existing.active) {
        diff.action = 'disable';
        diff.eventId = existing.id;
        diff.reason = 'enabled is false in the plan';
        actions.push({ kind: 'patch', key, existing, patch: { active: false }, rules: [] });
      } else {
        diff.eventId = existing.id;
      }
      continue;
    }

    const resolved = resolveItem(key, item, existing, tz, now);
    for (const warning of resolved.warnings) pushWarning(warnings, key, warning);
    const rules = planRules(key, item, existing, state, missingBuiltins, diff, warnings, resolved.input);

    if (existing === undefined) {
      diff.action = 'create';
      diff.changes = friendlyAll(describeEventRow(resolved.input, tz));
      actions.push({ kind: 'create', key, input: resolved.input, rules });
      continue;
    }

    diff.eventId = existing.id;
    const columns = changedColumns(existing, resolved.input, tz);
    const patch: EventPatch = { ...columns };
    const reactivate = !existing.active;
    if (reactivate) patch.active = true;
    const changes = diffFriendly(describeEventRow(existing, tz), describeEventRow(resolved.input, tz));
    diff.changes = changes;

    if (Object.keys(patch).length > 0) {
      diff.action = reactivate ? 'enable' : 'update';
      actions.push({ kind: 'patch', key, existing, patch, rules });
    } else if (rules.length > 0) {
      diff.action = 'unchanged';
      actions.push({ kind: 'rules', key, existing, rules });
    }
  }

  const namespacePrefix = `${plan.namespace}/`;
  const notInPlan: string[] = [];
  for (const event of state.events) {
    const key = event.agent_key;
    if (key == null || !key.startsWith(namespacePrefix) || key in plan.items) continue;
    if (!event.active) continue;
    notInPlan.push(key);
    if (plan.prune === true) {
      items.push({
        key,
        action: 'disable',
        title: event.title,
        eventId: event.id,
        reason: 'not in the plan any more (prune)',
        changes: [],
        rules: [],
      });
      actions.push({ kind: 'patch', key, existing: event, patch: { active: false }, rules: [] });
    }
  }
  if (plan.prune !== true && notInPlan.length > 0) {
    warnings.push(`${notInPlan.length} active alarm(s) in "${plan.namespace}/" are not in the plan and stay on (set "prune": true to switch them off): ${notInPlan.join(', ')}`);
  }

  const count = (action: ItemAction): number => items.filter((item) => item.action === action).length;
  const ruleChanges = items.reduce((total, item) => total + item.rules.length, 0);
  // An item that only changes rules is "unchanged" for the alarm but still has work to do.
  return {
    diff: {
      namespace: plan.namespace,
      timezone: tz,
      prune: plan.prune === true,
      items,
      summary: {
        create: count('create'),
        update: count('update'),
        enable: count('enable'),
        disable: count('disable'),
        unchanged: count('unchanged'),
        skip: count('skip'),
        ruleChanges,
      },
      notInPlan,
      warnings,
    },
    actions,
    missingBuiltins: [...missingBuiltins],
  };
}

function resolveItem(key: string, item: PlanItem, existing: EventRow | undefined, tz: string, now: Date) {
  try {
    const { enabled: _enabled, modes: _modes, ...spec } = item;
    const resolved = resolveEventSpec(spec, { tz, now, existing });
    return { ...resolved, input: { ...resolved.input, agent_key: key } };
  } catch (error) {
    if (error instanceof CliError) {
      throw new CliError('invalid_plan', `${key}: ${error.message}`, error.hint);
    }
    throw error;
  }
}

function planRules(
  key: string,
  item: PlanItem,
  existing: EventRow | undefined,
  state: PlanState,
  missingBuiltins: Set<string>,
  diff: ItemDiff,
  warnings: string[],
  input: EventWriteInput
): RuleAction[] {
  const actions: RuleAction[] = [];
  for (const [modeRef, behaviorInput] of Object.entries(item.modes ?? {})) {
    const behavior = behaviorFromInput(behaviorInput);
    const mode = findMode(state.modes, modeRef);
    if (mode === undefined) {
      if (isBuiltinKey(modeRef)) missingBuiltins.add(modeRef.toLowerCase());
      else throw new CliError('invalid_plan', `${key}: modes.${modeRef}: ${unknownModeError(modeRef, state.modes).message}`, unknownModeError(modeRef, state.modes).hint);
    } else if (!mode.active) {
      pushWarning(warnings, key, `mode "${modeRef}" is switched off, so its rule has no effect until it is switched on`);
    }
    if (behavior.kind === 'skip' && input.passable === false) {
      pushWarning(warnings, key, `modes.${modeRef}: "skip" has no effect because the alarm is not passable (a non-passable alarm is never paused)`);
    }

    const existingRule = existing === undefined || mode === undefined ? undefined : state.rules.find((rule) => rule.mode_id === mode.id && rule.event_id === existing.id);
    const wanted = ruleValues(behavior);
    const label = mode?.builtin_key ?? mode?.name ?? modeRef.toLowerCase();

    if (wanted === null) {
      if (existingRule === undefined) continue;
      diff.rules.push({ mode: label, action: 'delete', from: describeRuleValues(existingRule), to: describeRuleValues(null) });
    } else if (existingRule === undefined) {
      diff.rules.push({ mode: label, action: 'create', from: describeRuleValues(null), to: describeRuleValues(wanted) });
    } else if (!ruleValuesEqual(wanted as RuleValues, existingRule)) {
      diff.rules.push({ mode: label, action: 'update', from: describeRuleValues(existingRule), to: describeRuleValues(wanted) });
    } else {
      continue;
    }
    actions.push({ modeRef, behavior, existing: existingRule });
  }
  return actions;
}
