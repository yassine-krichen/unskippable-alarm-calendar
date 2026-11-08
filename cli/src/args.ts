import { CliError } from './errors';

export type OptionType = 'string' | 'number' | 'boolean' | 'list';

export interface OptionSpec {
  name: string;
  type: OptionType;
  description: string;
  /** Shown in help for a value placeholder, like `HH:mm`. */
  value?: string;
}

export interface ParsedArgs {
  positionals: string[];
  /** Keyed by the camelCase option name (`--key-prefix` is `keyPrefix`). */
  options: Record<string, string | number | boolean | string[] | undefined>;
}

const camel = (name: string): string => name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

/**
 * A small parser instead of node:util parseArgs because values may start with a dash (`shift -120`,
 * `--duration=-5` for a clear error) and `--no-flag` negation must be explicit and predictable. Supports
 * `--name value`, `--name=value`, `--flag`, `--no-flag`, `--flag=false`, repeated or comma-separated lists,
 * and `--` to end options.
 */
export function parseArgs(tokens: readonly string[], specs: readonly OptionSpec[]): ParsedArgs {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const positionals: string[] = [];
  const options: ParsedArgs['options'] = {};

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as string;
    if (token === '--') {
      positionals.push(...tokens.slice(index + 1));
      break;
    }
    if (!token.startsWith('--') || token.length === 2) {
      positionals.push(token);
      continue;
    }

    const equals = token.indexOf('=');
    const rawName = token.slice(2, equals === -1 ? undefined : equals);
    const inlineValue = equals === -1 ? undefined : token.slice(equals + 1);

    let spec = byName.get(rawName);
    let negated = false;
    if (spec === undefined && rawName.startsWith('no-')) {
      const positive = byName.get(rawName.slice(3));
      if (positive?.type === 'boolean') {
        spec = positive;
        negated = true;
      }
    }
    if (spec === undefined) {
      throw new CliError('usage', `Unknown option --${rawName}.`, optionHint(specs));
    }

    const key = camel(spec.name);
    if (spec.type === 'boolean') {
      if (inlineValue !== undefined && !['true', 'false'].includes(inlineValue)) {
        throw new CliError('usage', `--${spec.name} is a flag; use --${spec.name}, --no-${spec.name} or --${spec.name}=true|false.`);
      }
      const value = inlineValue === undefined ? true : inlineValue === 'true';
      options[key] = negated ? !value : value;
      continue;
    }

    let value = inlineValue;
    if (value === undefined) {
      const next = tokens[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new CliError('usage', `--${spec.name} needs a value${spec.value ? ` (${spec.value})` : ''}.`);
      }
      value = next;
      index += 1;
    }

    if (spec.type === 'number') {
      const parsed = Number(value);
      if (value.trim() === '' || !Number.isFinite(parsed)) {
        throw new CliError('usage', `--${spec.name} must be a number, got "${value}".`);
      }
      options[key] = parsed;
    } else if (spec.type === 'list') {
      const previous = options[key];
      const items = value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
      options[key] = [...(Array.isArray(previous) ? previous : []), ...items];
    } else {
      options[key] = value;
    }
  }

  return { positionals, options };
}

function optionHint(specs: readonly OptionSpec[]): string | undefined {
  if (specs.length === 0) return 'This command takes no options.';
  return `Valid options: ${specs.map((spec) => `--${spec.name}`).join(', ')}.`;
}

export function stringOption(args: ParsedArgs, name: string): string | undefined {
  const value = args.options[camel(name)];
  return typeof value === 'string' ? value : undefined;
}

export function numberOption(args: ParsedArgs, name: string): number | undefined {
  const value = args.options[camel(name)];
  return typeof value === 'number' ? value : undefined;
}

export function booleanOption(args: ParsedArgs, name: string): boolean | undefined {
  const value = args.options[camel(name)];
  return typeof value === 'boolean' ? value : undefined;
}

export function listOption(args: ParsedArgs, name: string): string[] | undefined {
  const value = args.options[camel(name)];
  return Array.isArray(value) ? value : undefined;
}
