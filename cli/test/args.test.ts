import { describe, expect, it } from 'vitest';

import { parseArgs, type OptionSpec } from '../src/args';
import { CliError } from '../src/errors';

const specs: OptionSpec[] = [
  { name: 'title', type: 'string', description: '' },
  { name: 'max-snoozes', type: 'number', description: '' },
  { name: 'passable', type: 'boolean', description: '' },
  { name: 'days', type: 'list', description: '' },
];

describe('parseArgs', () => {
  it('reads --name value, --name=value and camel-cases dashed names', () => {
    const parsed = parseArgs(['--title', 'Push day', '--max-snoozes=2'], specs);
    expect(parsed.options).toEqual({ title: 'Push day', maxSnoozes: 2 });
  });

  it('negates booleans with --no- and accepts an explicit value', () => {
    expect(parseArgs(['--no-passable'], specs).options['passable']).toBe(false);
    expect(parseArgs(['--passable'], specs).options['passable']).toBe(true);
    expect(parseArgs(['--passable=false'], specs).options['passable']).toBe(false);
  });

  it('keeps negative numbers as positionals so a shift of -120 works', () => {
    const parsed = parseArgs(['sick', 'workout/x', 'shift', '-120'], specs);
    expect(parsed.positionals).toEqual(['sick', 'workout/x', 'shift', '-120']);
  });

  it('lets a string option take a value that starts with a single dash', () => {
    expect(parseArgs(['--title', '-5 degrees'], specs).options['title']).toBe('-5 degrees');
  });

  it('collects repeated and comma separated list values', () => {
    expect(parseArgs(['--days', 'mon,wed', '--days', 'fri'], specs).options['days']).toEqual(['mon', 'wed', 'fri']);
  });

  it('treats everything after -- as positional', () => {
    expect(parseArgs(['--', '--title'], specs).positionals).toEqual(['--title']);
  });

  it('rejects unknown options with the valid ones listed', () => {
    expect(() => parseArgs(['--nope'], specs)).toThrow(CliError);
    try {
      parseArgs(['--nope'], specs);
    } catch (error) {
      expect((error as CliError).code).toBe('usage');
      expect((error as CliError).hint).toContain('--title');
    }
  });

  it('rejects a missing value and a non-numeric number', () => {
    expect(() => parseArgs(['--title'], specs)).toThrow(/needs a value/);
    expect(() => parseArgs(['--max-snoozes', 'many'], specs)).toThrow(/must be a number/);
  });
});
