import { parseArgs } from './args';
import { buildSpec, renderHelp } from './commands/help-commands';
import { allCommands } from './commands/registry';
import type { CommandDef } from './commands/command';
import { CliError, errorToJson } from './errors';
import type { Runtime } from './runtime';
import { TOOL_VERSION } from './version';

function findCommand(commands: readonly CommandDef[], words: readonly string[]): CommandDef | undefined {
  let best: CommandDef | undefined;
  for (const def of commands) {
    if (def.path.length > words.length) continue;
    if (!def.path.every((word, index) => word === words[index])) continue;
    if (best === undefined || def.path.length > best.path.length) best = def;
  }
  return best;
}

function suggest(commands: readonly CommandDef[], word: string | undefined): string {
  const same = commands.filter((def) => def.path[0] === word).map((def) => def.path.join(' '));
  if (same.length > 0) return `Did you mean: ${same.join(', ')}?`;
  return 'Run `alarm-cal help` for the list of commands.';
}

function checkPositionals(def: CommandDef, positionals: readonly string[]): void {
  const specs = def.positionals ?? [];
  const required = specs.filter((spec) => spec.required === true).length;
  const variadic = specs.some((spec) => spec.variadic === true);
  if (positionals.length < required) {
    const missing = specs.filter((spec) => spec.required === true)[positionals.length];
    throw new CliError('usage', `Missing argument <${missing?.name ?? 'argument'}>.`, `Run \`alarm-cal help ${def.path.join(' ')}\`.`);
  }
  if (!variadic && positionals.length > specs.length) {
    throw new CliError('usage', `Unexpected argument "${positionals[specs.length]}".`, `Run \`alarm-cal help ${def.path.join(' ')}\`.`);
  }
}

function printError(rt: Runtime, error: CliError, json: boolean): void {
  if (json) {
    rt.out(JSON.stringify(errorToJson(error), null, 2));
    return;
  }
  rt.err(`error: ${error.message}`);
  if (error.hint !== undefined && error.hint !== '') rt.err(`hint: ${error.hint}`);
}

/** Runs one invocation and returns the process exit code. */
export async function main(argv: readonly string[], rt: Runtime): Promise<number> {
  const separator = argv.indexOf('--');
  const head = separator === -1 ? argv : argv.slice(0, separator);
  const tail = separator === -1 ? [] : argv.slice(separator);
  const json = head.includes('--json');
  const wantsHelp = head.includes('--help') || head.includes('-h');
  const wantsVersion = head.includes('--version') || head.includes('-v');
  const tokens = [...head.filter((token) => token !== '--json' && token !== '--help' && token !== '-h' && token !== '--version' && token !== '-v'), ...tail];

  const commands = allCommands();
  try {
    if (wantsVersion) {
      rt.out(json ? JSON.stringify({ ok: true, version: TOOL_VERSION }) : `alarm-cal ${TOOL_VERSION}`);
      return 0;
    }
    const words: string[] = [];
    for (const token of tokens) {
      if (token.startsWith('-')) break;
      words.push(token);
    }
    const def = findCommand(commands, words);
    if (def === undefined) {
      if (words.length === 0 && (wantsHelp || tokens.length === 0)) {
        rt.out(json ? JSON.stringify({ ok: true, ...buildSpec(commands) }, null, 2) : renderHelp(commands, []));
        return 0;
      }
      throw new CliError('usage', words.length === 0 ? `Unexpected "${tokens[0]}" before a command.` : `Unknown command "${words.join(' ')}".`, suggest(commands, words[0]));
    }
    if (wantsHelp && def.path[0] !== 'help') {
      rt.out(json ? JSON.stringify({ ok: true, ...(buildSpec([def]) as object) }, null, 2) : renderHelp(commands, def.path));
      return 0;
    }

    const parsed = parseArgs(tokens.slice(def.path.length), def.options ?? []);
    checkPositionals(def, parsed.positionals);
    const output = await def.run({ rt, args: parsed, json });
    if (def.alwaysJson === true) rt.out(JSON.stringify(output.data, null, 2));
    else if (json) rt.out(JSON.stringify({ ok: true, ...output.data }, null, 2));
    else rt.out(output.text);
    return 0;
  } catch (error) {
    const cliError =
      error instanceof CliError
        ? error
        : new CliError('internal', error instanceof Error ? error.message : String(error), rt.env['ALARM_CAL_DEBUG'] === '1' && error instanceof Error ? error.stack : undefined);
    printError(rt, cliError, json);
    return cliError.exitCode;
  }
}
