import { WRITABLE_SETTINGS_COLUMNS } from '@alarm-calendar/core';

import { CliError, EXIT_CODE_MEANINGS } from '../errors';
import { planJsonSchema } from '../plan/plan-schema';
import { TOOL_VERSION } from '../version';

import { defineCommand, type CommandDef } from './command';
import { allCommands } from './registry';

const GLOBAL_OPTIONS = [
  { name: '--json', description: 'Print one JSON object on standard output (errors too, as { ok: false, error }). Without it, human text.' },
  { name: '--help', description: 'Show help for the command.' },
  { name: '--version', description: 'Print the version.' },
];

const NOTES = [
  'Times are shown in the account timezone (settings.timezone) with the ISO instant beside them; local inputs (--time, --start, plan "time") are read in that zone.',
  'Writes apply immediately and each records an undo entry: `alarm-cal undo` reverts the last one, `alarm-cal history` lists them. Deleting is switching off (active=false).',
  'Alarms are found by id, an 8+ character id prefix, or agent key (like workout/push-day). Prayer alarms are managed with `settings set` and are never created here.',
  'Prefer `plan apply` for anything with more than one alarm: it is idempotent, so running it twice changes nothing the second time.',
  'A non-passable alarm (--no-passable, or passable false) is never paused by a mode or a cheat day; use it for medication.',
  'Sign-in is two steps for agents: `login --email X` sends a code, `login --email X --code N` verifies it. The session then refreshes itself.',
];

function describeCommand(def: CommandDef): Record<string, unknown> {
  return {
    command: def.path.join(' '),
    summary: def.summary,
    writes: def.writes,
    needs_login: def.needsLogin,
    positionals: (def.positionals ?? []).map((positional) => ({
      name: positional.name,
      description: positional.description,
      required: positional.required === true,
      variadic: positional.variadic === true,
    })),
    options: (def.options ?? []).map((option) => ({
      name: `--${option.name}`,
      type: option.type,
      ...(option.value === undefined ? {} : { value: option.value }),
      description: option.description,
    })),
    examples: def.examples ?? [],
  };
}

export function buildSpec(commands: readonly CommandDef[]): Record<string, unknown> {
  return {
    tool: 'alarm-cal',
    version: TOOL_VERSION,
    global_options: GLOBAL_OPTIONS,
    exit_codes: EXIT_CODE_MEANINGS,
    notes: NOTES,
    writable_settings: [...WRITABLE_SETTINGS_COLUMNS, 'prayers_enabled'],
    commands: commands.map(describeCommand),
    plan_schema: planJsonSchema(),
  };
}

export function renderHelp(commands: readonly CommandDef[], words: readonly string[]): string {
  const exact = commands.find((def) => def.path.join(' ') === words.join(' '));
  if (exact !== undefined) {
    const positionals = (exact.positionals ?? []).map((positional) => (positional.required ? `<${positional.name}>` : `[${positional.name}]`) + (positional.variadic ? '...' : ''));
    const lines = [`alarm-cal ${exact.path.join(' ')}${positionals.length > 0 ? ` ${positionals.join(' ')}` : ''}${(exact.options ?? []).length > 0 ? ' [options]' : ''}`, '', exact.summary];
    if ((exact.positionals ?? []).length > 0) {
      lines.push('', 'Arguments:');
      for (const positional of exact.positionals ?? []) lines.push(`  ${positional.name.padEnd(14)} ${positional.description}`);
    }
    if ((exact.options ?? []).length > 0) {
      lines.push('', 'Options:');
      for (const option of exact.options ?? []) {
        const label = `--${option.name}${option.type === 'boolean' ? '' : ` <${option.value ?? option.type}>`}`;
        lines.push(`  ${label.padEnd(34)} ${option.description}`);
      }
    }
    if ((exact.examples ?? []).length > 0) lines.push('', 'Examples:', ...(exact.examples ?? []).map((example) => `  ${example}`));
    lines.push('', `${exact.writes ? 'Changes data (undo with `alarm-cal undo`). ' : ''}${exact.needsLogin ? 'Needs sign-in.' : ''}`.trim());
    return lines.join('\n').trimEnd();
  }
  const prefix = words.join(' ');
  const matching = commands.filter((def) => def.path.join(' ').startsWith(prefix));
  if (words.length > 0 && matching.length === 0) throw new CliError('usage', `No command "${prefix}".`, 'Run `alarm-cal help` for the list.');
  const width = Math.max(...matching.map((def) => def.path.join(' ').length));
  return [
    words.length === 0 ? 'alarm-cal: read and change the alarm calendar from the command line.\n\nUsage: alarm-cal <command> [options]   (add --json for machine output)\n' : '',
    ...matching.map((def) => `  ${def.path.join(' ').padEnd(width)}  ${def.summary}`),
    words.length === 0 ? '\nRun `alarm-cal help <command>` for options, `alarm-cal help --json` or `alarm-cal schema` for a machine-readable description.' : '',
  ]
    .join('\n')
    .trim();
}

export const help = defineCommand({
  path: ['help'],
  summary: 'Describe the commands. `help --json` prints every command, option, exit code and the plan JSON Schema.',
  positionals: [{ name: 'command', description: 'A command to describe, like `events add`.', variadic: true }],
  writes: false,
  needsLogin: false,
  async run({ args, json }) {
    const commands = allCommands();
    if (json) return { data: buildSpec(commands), text: '' };
    return { data: {}, text: renderHelp(commands, args.positionals) };
  },
});

export const schema = defineCommand({
  path: ['schema'],
  summary: 'Print the machine-readable description: commands, options, exit codes and the plan JSON Schema (always JSON).',
  positionals: [{ name: 'part', description: '"plan" for only the plan JSON Schema, "commands" for only the commands. Default: everything.' }],
  writes: false,
  needsLogin: false,
  alwaysJson: true,
  async run({ args }) {
    const part = args.positionals[0];
    const spec = buildSpec(allCommands());
    if (part === 'plan') return { data: spec['plan_schema'] as Record<string, unknown>, text: '' };
    if (part === 'commands') return { data: { commands: spec['commands'] }, text: '' };
    if (part !== undefined) throw new CliError('usage', 'schema takes "plan", "commands" or nothing.');
    return { data: spec, text: '' };
  },
});
