import type { OptionSpec, ParsedArgs } from '../args';
import type { Runtime } from '../runtime';

export interface PositionalSpec {
  name: string;
  description: string;
  required?: boolean;
  /** Takes every remaining word. */
  variadic?: boolean;
}

/** What a command returns: the object `--json` prints (with `ok: true` added) and the text a person reads. */
export interface CommandOutput {
  data: Record<string, unknown>;
  text: string;
}

export interface CommandContext {
  rt: Runtime;
  args: ParsedArgs;
  json: boolean;
}

export interface CommandDef {
  /** Words that select the command: ['events', 'list']. */
  path: readonly string[];
  summary: string;
  positionals?: readonly PositionalSpec[];
  options?: readonly OptionSpec[];
  /** Changes data (and so writes an undo journal entry). */
  writes: boolean;
  /** Needs a signed-in session. */
  needsLogin: boolean;
  /** Prints its data bare as JSON even without --json (the machine-readable description). */
  alwaysJson?: boolean;
  examples?: readonly string[];
  run(context: CommandContext): Promise<CommandOutput>;
}

export function defineCommand(def: CommandDef): CommandDef {
  return def;
}
