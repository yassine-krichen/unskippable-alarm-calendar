import { z } from 'zod';

import { AGENT_KEY_PATTERN, eventSpecShape } from '../events/event-spec';
import { CliError } from '../errors';
import { modeBehaviorSchema } from '../modes/mode-rules';

export const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,48}$/;
export const MAX_PLAN_ITEMS = 200;
/** A plan file larger than this is refused before it is parsed. */
export const MAX_PLAN_BYTES = 1_048_576;

export const planItemSchema = z.strictObject({
  ...eventSpecShape,
  enabled: z
    .boolean()
    .optional()
    .describe('False keeps the alarm switched off (and switches it off if it exists). Default true.'),
  modes: z
    .record(z.string().min(1), modeBehaviorSchema)
    .optional()
    .describe(
      'What this alarm does while a mode is in effect, keyed by built-in mode (exam, ramadan, vacation, sick) or custom mode name. Modes not listed keep whatever rule they already have.'
    ),
});

export const planSchema = z.strictObject({
  $schema: z.string().optional(),
  version: z.literal(1).optional().describe('Plan format version; omit or 1.'),
  namespace: z
    .string()
    .regex(NAMESPACE_PATTERN, 'must be lowercase letters, digits, "_", "." or "-", like "workout"')
    .describe('Groups the plan: every item key must start with "<namespace>/". `prune` only touches keys in this namespace.'),
  prune: z
    .boolean()
    .optional()
    .describe('True switches off alarms in this namespace that are not in the plan any more. Default false.'),
  items: z
    .record(z.string().regex(AGENT_KEY_PATTERN, 'must be lowercase letters, digits and "/", "_", ".", "-" (max 100), like "workout/push-day"'), planItemSchema)
    .refine((items) => Object.keys(items).length <= MAX_PLAN_ITEMS, { message: `at most ${MAX_PLAN_ITEMS} items per plan` })
    .describe(`The alarms, keyed by their agent key, at most ${MAX_PLAN_ITEMS}. Applying twice changes nothing the second time.`),
});

export type Plan = z.infer<typeof planSchema>;
export type PlanItem = z.infer<typeof planItemSchema>;

/** The JSON Schema agents can validate a plan against (published as cli/plan.schema.json). */
export function planJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(planSchema, { io: 'input', target: 'draft-2020-12' }) as Record<string, unknown>;
  return {
    ...schema,
    $id: 'https://alarm-calendar.local/plan.schema.json',
    title: 'alarm-cal plan',
    description:
      'A declarative set of alarms for `alarm-cal plan check|diff|apply`. Items are keyed by agent key; applying is idempotent.',
  };
}

function issuePath(path: ReadonlyArray<PropertyKey>): string {
  return path.length === 0 ? '(plan)' : path.map(String).join('.');
}

/** Parses plan text (JSON). Every problem is reported at once, with the path of the offending field. */
export function parsePlan(text: string): Plan {
  if (Buffer.byteLength(text) > MAX_PLAN_BYTES) {
    throw new CliError('invalid_plan', `The plan is larger than ${MAX_PLAN_BYTES / 1_048_576} MB.`, 'Split it into plans per namespace.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, '')) as unknown;
  } catch (error) {
    throw new CliError('invalid_plan', `The plan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issuePath(issue.path)}: ${issue.message}`);
    throw new CliError(
      'invalid_plan',
      `The plan has ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
      'Validate against cli/plan.schema.json, or see `alarm-cal schema plan`.',
      { problems }
    );
  }
  const plan = parsed.data;
  const problems: string[] = [];
  const keys = Object.keys(plan.items);
  if (keys.length === 0) problems.push('items: the plan has no items');
  for (const key of keys) {
    if (!key.startsWith(`${plan.namespace}/`)) {
      problems.push(`items.${key}: the key must start with "${plan.namespace}/" (the plan's namespace)`);
    }
  }
  if (problems.length > 0) {
    throw new CliError(
      'invalid_plan',
      `The plan has ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
      undefined,
      { problems }
    );
  }
  return plan;
}
