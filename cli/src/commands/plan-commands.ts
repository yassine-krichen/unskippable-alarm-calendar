import { CliError } from '../errors';
import { applyPlan } from '../plan/plan-apply';
import { computePlan, type ItemDiff, type PlanComputation, type PlanDiff } from '../plan/plan-diff';
import { MAX_PLAN_BYTES, parsePlan, type Plan } from '../plan/plan-schema';
import type { Runtime } from '../runtime';
import { plural } from '../output/render';

import { defineCommand } from './command';
import { renderChange } from './event-commands';
import { loadModeConfig } from './read-commands';
import { journalJson, journalled, openWorld, undoHint, type World } from './support';

async function readPlan(rt: Runtime, file: string | undefined): Promise<Plan> {
  if (file === undefined) throw new CliError('usage', 'Give the plan file, or - to read it from standard input.');
  const text = file === '-' ? await rt.readStdin(MAX_PLAN_BYTES) : rt.readTextFile(file, MAX_PLAN_BYTES);
  return parsePlan(text);
}

async function computeAgainstDatabase(world: World, plan: Plan): Promise<PlanComputation> {
  const [events, config] = await Promise.all([world.store.listEvents(), loadModeConfig(world.store)]);
  return computePlan(plan, { events, modes: config.modes, rules: config.rules, tz: world.tz, now: world.now });
}

function describeCreate(item: ItemDiff): string {
  const value = (field: string): unknown => item.changes.find((change) => change.field === field)?.to;
  const repeat = value('repeat');
  const days = value('days');
  const repeatLabel = typeof repeat === 'object' && repeat !== null ? `every ${(repeat as { every: number }).every} ${(repeat as { unit: string }).unit}` : String(repeat ?? 'none');
  return `${String(value('time'))} ${repeatLabel}${Array.isArray(days) ? ` ${(days as string[]).join(',')}` : ''}, ${String(value('duration'))} min`;
}

export function renderPlanDiff(diff: PlanDiff, applied: boolean): string {
  const s = diff.summary;
  const counts = applied
    ? `${s.create} created, ${s.update + s.enable} updated, ${s.disable} switched off, ${s.unchanged} unchanged`
    : `${s.create} to create, ${s.update + s.enable} to update, ${s.disable} to switch off, ${s.unchanged} unchanged`;
  const lines = [
    `Plan "${diff.namespace}" (times in ${diff.timezone}): ${counts}${s.ruleChanges > 0 ? `, ${plural(s.ruleChanges, 'rule change')}` : ''}${diff.prune ? ' (prune on)' : ''}`,
  ];
  for (const item of diff.items) {
    const label = `${item.key}  "${item.title}"`;
    switch (item.action) {
      case 'create':
        lines.push(`+ ${label}  ${describeCreate(item)}`);
        break;
      case 'update':
      case 'enable':
        lines.push(`~ ${label}${item.action === 'enable' ? '  (switched back on)' : ''}`);
        for (const change of item.changes) lines.push(`    ${renderChange(change)}`);
        break;
      case 'disable':
        lines.push(`- ${label}  switched off (${item.reason ?? ''})`);
        break;
      case 'skip':
        lines.push(`  ${label}  skipped (${item.reason ?? ''})`);
        break;
      case 'unchanged':
        if (item.rules.length === 0) lines.push(`= ${label}`);
        else lines.push(`~ ${label}  (alarm unchanged, rules differ)`);
        break;
    }
    for (const rule of item.rules) lines.push(`    mode ${rule.mode}: ${rule.from} -> ${rule.to} (${rule.action})`);
  }
  for (const warning of diff.warnings) lines.push(`warning: ${warning}`);
  return lines.join('\n');
}

export const planCheck = defineCommand({
  path: ['plan', 'check'],
  summary: 'Validate a plan file (JSON). Works offline; when signed in it also resolves times, modes and keys against your data.',
  positionals: [{ name: 'file', description: 'Path to the plan JSON, or - for standard input.', required: true }],
  writes: false,
  needsLogin: false,
  examples: ['alarm-cal plan check workout.plan.json --json'],
  async run({ rt, args }) {
    const plan = await readPlan(rt, args.positionals[0]);
    const items = Object.keys(plan.items).length;
    let computation: PlanComputation | null = null;
    let offlineReason: string | null = null;
    try {
      computation = await computeAgainstDatabase(await openWorld(rt), plan);
    } catch (error) {
      if (error instanceof CliError && (error.code === 'not_logged_in' || error.code === 'config_missing' || error.code === 'network')) {
        offlineReason = error.message;
      } else {
        throw error;
      }
    }
    const warnings = computation?.diff.warnings ?? [];
    const text =
      computation === null
        ? `The plan is structurally valid (${plural(items, 'item')} in "${plan.namespace}"). Not checked against your data: ${offlineReason}`
        : `The plan is valid (${plural(items, 'item')} in "${plan.namespace}").${warnings.map((warning) => `\nwarning: ${warning}`).join('')}`;
    return {
      data: { valid: true, namespace: plan.namespace, items, checked_against_data: computation !== null, offline_reason: offlineReason, warnings },
      text,
    };
  },
});

export const planDiff = defineCommand({
  path: ['plan', 'diff'],
  summary: 'Show what applying a plan would change, field by field. Writes nothing.',
  positionals: [{ name: 'file', description: 'Path to the plan JSON, or - for standard input.', required: true }],
  writes: false,
  needsLogin: true,
  async run({ rt, args }) {
    const plan = await readPlan(rt, args.positionals[0]);
    const computation = await computeAgainstDatabase(await openWorld(rt), plan);
    return { data: { applied: false, diff: computation.diff }, text: renderPlanDiff(computation.diff, false) };
  },
});

export const planApply = defineCommand({
  path: ['plan', 'apply'],
  summary: 'Apply a plan: create missing alarms, update changed ones, leave identical ones alone, write mode rules. Idempotent.',
  positionals: [{ name: 'file', description: 'Path to the plan JSON, or - for standard input.', required: true }],
  writes: true,
  needsLogin: true,
  examples: ['alarm-cal plan apply workout.plan.json'],
  async run({ rt, args }) {
    const plan = await readPlan(rt, args.positionals[0]);
    const world = await openWorld(rt);
    const computation = await computeAgainstDatabase(world, plan);
    const { diff } = computation;
    const hasWork = computation.actions.length > 0;
    if (!hasWork) {
      return { data: { applied: true, nothing_to_do: true, diff, ...journalJson(null) }, text: `Nothing to do: the calendar already matches the plan.\n${renderPlanDiff(diff, true)}` };
    }
    const result = await journalled(rt, world.store, async (recorder) => {
      const outcome = await applyPlan(recorder, world.store, computation);
      const parts = [
        outcome.created > 0 ? `${outcome.created} created` : '',
        outcome.updated > 0 ? `${outcome.updated} updated` : '',
        outcome.disabled > 0 ? `${outcome.disabled} switched off` : '',
        outcome.rulesWritten + outcome.rulesDeleted > 0 ? `${outcome.rulesWritten} rule(s) set, ${outcome.rulesDeleted} removed` : '',
      ].filter((part) => part !== '');
      return { value: outcome, changes: [`plan "${plan.namespace}": ${parts.join(', ')}`] };
    });
    return {
      data: { applied: true, nothing_to_do: false, result: result.value, diff, ...journalJson(result.entry) },
      text: `${renderPlanDiff(diff, true)}\nApplied: ${result.changes.join('; ')}${undoHint(result.entry)}`,
    };
  },
});
