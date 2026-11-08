import { addDays, startOfZonedDay, zonedDate, type ModeRow } from '@alarm-calendar/core';

import { booleanOption, stringOption } from '../args';
import { CliError } from '../errors';
import {
  behaviorFromWords,
  describeRuleValues,
  findMode,
  isBuiltinKey,
  modeLabel,
  ruleValues,
  ruleValuesEqual,
  unknownModeError,
} from '../modes/mode-rules';
import { longLocal } from '../output/time-format';
import type { Store } from '../store/store';

import { defineCommand } from './command';
import { parseWhen } from './read-commands';
import { findEventRef, isUserAlarm, journalJson, journalled, openWorld, undoHint } from './support';

/** Finds a mode by key, name or id; a missing built-in is created first (the app does the same on load). */
async function resolveMode(store: Store, ref: string): Promise<ModeRow> {
  let modes = await store.listModes();
  let mode = findMode(modes, ref);
  if (mode === undefined && isBuiltinKey(ref)) {
    await store.ensureBuiltinModes();
    modes = await store.listModes();
    mode = findMode(modes, ref);
  }
  if (mode === undefined) throw unknownModeError(ref, modes);
  return mode;
}

export const modesRuleSet = defineCommand({
  path: ['modes', 'rule', 'set'],
  summary: 'Set what one alarm does while a mode is in effect: keep, skip, shift <±min>, shorten <min>, or inherit (remove the rule).',
  positionals: [
    { name: 'mode', description: 'exam, ramadan, vacation, sick, a custom mode name, or a mode id.', required: true },
    { name: 'event', description: 'Alarm id (or prefix) or agent key.', required: true },
    { name: 'behavior', description: 'keep | skip | shift <±minutes> | shorten <minutes> | inherit', required: true, variadic: true },
  ],
  writes: true,
  needsLogin: true,
  examples: [
    'alarm-cal modes rule set sick workout/push-day skip',
    'alarm-cal modes rule set exam workout/push-day shorten 30',
    'alarm-cal modes rule set ramadan workout/push-day shift 120',
  ],
  async run({ rt, args }) {
    const [modeRef, eventRef, ...words] = args.positionals;
    if (modeRef === undefined || eventRef === undefined) throw new CliError('usage', 'Usage: alarm-cal modes rule set <mode> <event> <behavior>.');
    const behavior = behaviorFromWords(words);
    const { store, tz } = await openWorld(rt);
    const event = findEventRef(await store.listEvents(), eventRef);
    if (!isUserAlarm(event)) throw new CliError('invalid_input', 'Prayer alarms are not affected by modes.');
    const mode = await resolveMode(store, modeRef);
    const existing = (await store.listRules()).find((rule) => rule.mode_id === mode.id && rule.event_id === event.id);
    const values = ruleValues(behavior);
    const warnings: string[] = [];
    if (behavior.kind === 'skip' && !event.passable) {
      warnings.push('This alarm is not passable, so a mode never pauses it: "skip" has no effect. Shift and shorten still apply.');
    }
    if (!mode.active) warnings.push(`The ${modeLabel(mode)} mode is switched off, so the rule has no effect until it is switched on in the app.`);

    const result = await journalled(rt, store, async (recorder) => {
      const label = `${event.agent_key ?? event.title} under ${modeLabel(mode)}`;
      if (values === null) {
        if (existing === undefined) return { value: 'unchanged', changes: [] };
        await recorder.deleteRule(existing);
        return { value: 'removed', changes: [`${label}: ${describeRuleValues(existing)} -> mode default (${mode.default_behavior})`] };
      }
      if (existing !== undefined && ruleValuesEqual(values, existing)) return { value: 'unchanged', changes: [] };
      await recorder.setRule(existing, mode.id, event.id, values);
      return { value: existing === undefined ? 'created' : 'updated', changes: [`${label}: ${describeRuleValues(existing ?? null)} -> ${describeRuleValues(values)}`] };
    });
    return {
      data: { timezone: tz, mode: modeLabel(mode), event_id: event.id, agent_key: event.agent_key ?? null, result: result.value, changes: result.changes, warnings, ...journalJson(result.entry) },
      text: `${result.changes.length === 0 ? 'No change: the rule is already like that.' : result.changes.join('\n')}${warnings.map((warning) => `\nwarning: ${warning}`).join('')}${undoHint(result.entry)}`,
    };
  },
});

export const modesSwitch = defineCommand({
  path: ['modes', 'switch'],
  summary: 'Switch a mode on now (or since earlier), until a date or until switched back. Use for sick days: `modes switch sick`.',
  positionals: [{ name: 'mode', description: 'exam, ramadan, vacation, sick, a custom mode name, or a mode id.', required: true }],
  options: [
    { name: 'since', type: 'string', value: 'today|ISO', description: 'When it began: "today" (the start of today), or an ISO instant up to 7 days back. Default: now.' },
    { name: 'until', type: 'string', value: 'yyyy-MM-dd', description: 'Last day of the mode (included whole).' },
    { name: 'open', type: 'boolean', description: 'Stay on until `modes normal` (the default when --until is absent).' },
  ],
  writes: true,
  needsLogin: true,
  examples: ['alarm-cal modes switch sick --since today --until 2026-11-12', 'alarm-cal modes switch vacation --open'],
  async run({ rt, args }) {
    const modeRef = args.positionals[0];
    if (modeRef === undefined) throw new CliError('usage', 'Usage: alarm-cal modes switch <mode>.');
    const until = stringOption(args, 'until');
    if (until !== undefined && booleanOption(args, 'open') === true) throw new CliError('usage', 'Use --until or --open, not both.');
    const { store, tz, now } = await openWorld(rt);
    const mode = await resolveMode(store, modeRef);
    const sinceArg = stringOption(args, 'since');
    let startsAt: string | null = null;
    if (sinceArg === 'today') startsAt = startOfZonedDay(zonedDate(now, tz), tz).toISOString();
    else if (sinceArg !== undefined) startsAt = parseWhen(sinceArg, tz, 'since').toISOString();
    let endsAt: string | null = null;
    if (until !== undefined) {
      const day = parseWhen(until, tz, 'until');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new CliError('invalid_input', '--until takes a date like 2026-11-12.');
      endsAt = startOfZonedDay(addDays(zonedDate(day, tz), 1), tz).toISOString();
    }
    const result = await journalled(rt, store, async (recorder) => {
      await recorder.switchMode({ modeId: mode.id, startsAt, endsAt });
      const began = startsAt ?? now.toISOString();
      return {
        value: null,
        changes: [`${modeLabel(mode)} mode on since ${longLocal(began, tz)} ${endsAt === null ? 'until switched back' : `until ${longLocal(endsAt, tz)}`}`],
      };
    });
    return {
      data: { timezone: tz, mode: modeLabel(mode), starts_at: startsAt ?? now.toISOString(), ends_at: endsAt, changes: result.changes, ...journalJson(result.entry) },
      text: `${result.changes.join('\n')}\nCheck the effect with: alarm-cal occurrences${undoHint(result.entry)}`,
    };
  },
});

export const modesNormal = defineCommand({
  path: ['modes', 'normal'],
  summary: 'Switch back to Normal: ends the manual mode. A planned range or an exam window still applies.',
  writes: true,
  needsLogin: true,
  async run({ rt }) {
    const { store, tz } = await openWorld(rt);
    const result = await journalled(rt, store, async (recorder) => {
      await recorder.switchMode({ modeId: null, startsAt: null, endsAt: null });
      return { value: null, changes: ['manual mode ended (back to Normal)'] };
    });
    return {
      data: { timezone: tz, changes: result.changes, ...journalJson(result.entry) },
      text: `${result.changes.join('\n')}\nA planned range or an exam window can still put a mode in effect; see \`alarm-cal modes list\`.${undoHint(result.entry)}`,
    };
  },
});

export const modesRangeAdd = defineCommand({
  path: ['modes', 'range', 'add'],
  summary: 'Plan a mode for a range of days (both ends included), like Ramadan or a holiday.',
  positionals: [{ name: 'mode', description: 'exam, ramadan, vacation, sick, a custom mode name, or a mode id.', required: true }],
  options: [
    { name: 'from', type: 'string', value: 'yyyy-MM-dd', description: 'First day.' },
    { name: 'to', type: 'string', value: 'yyyy-MM-dd', description: 'Last day (included).' },
  ],
  writes: true,
  needsLogin: true,
  examples: ['alarm-cal modes range add ramadan --from 2027-02-08 --to 2027-03-09'],
  async run({ rt, args }) {
    const modeRef = args.positionals[0];
    const from = stringOption(args, 'from');
    const to = stringOption(args, 'to');
    if (modeRef === undefined || from === undefined || to === undefined) throw new CliError('usage', 'Usage: alarm-cal modes range add <mode> --from <date> --to <date>.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new CliError('invalid_input', '--from and --to take dates like 2027-02-08.');
    if (to < from) throw new CliError('invalid_input', 'The last day cannot be before the first.');
    const { store, tz } = await openWorld(rt);
    const mode = await resolveMode(store, modeRef);
    const startsAt = parseWhen(from, tz, 'from').toISOString();
    const endsAt = startOfZonedDay(addDays(to, 1), tz).toISOString();
    const result = await journalled(rt, store, async (recorder) => {
      const row = await recorder.addRange(mode.id, startsAt, endsAt);
      return { value: row, changes: [`planned ${modeLabel(mode)} from ${from} to ${to} (${tz})`] };
    });
    return {
      data: { timezone: tz, activation_id: result.value.id, mode: modeLabel(mode), changes: result.changes, ...journalJson(result.entry) },
      text: `${result.changes.join('\n')}\nid ${result.value.id}${undoHint(result.entry)}`,
    };
  },
});

export const modesRangeRemove = defineCommand({
  path: ['modes', 'range', 'remove'],
  summary: 'Remove a planned or running activation by id (see `modes list`).',
  positionals: [{ name: 'id', description: 'The activation id or an 8+ character prefix.', required: true }],
  writes: true,
  needsLogin: true,
  async run({ rt, args }) {
    const ref = args.positionals[0];
    if (ref === undefined) throw new CliError('usage', 'Usage: alarm-cal modes range remove <id>.');
    const { store, tz } = await openWorld(rt);
    const activations = await store.listActivations();
    const matches = activations.filter((row) => row.id === ref || (ref.length >= 8 && row.id.startsWith(ref.toLowerCase())));
    if (matches.length === 0) throw new CliError('not_found', `No activation with id "${ref}".`, 'See `alarm-cal modes list`.');
    if (matches.length > 1) throw new CliError('ambiguous', `"${ref}" matches ${matches.length} activations; give more characters.`);
    const target = matches[0];
    if (target === undefined) throw new CliError('not_found', 'No such activation.');
    const modes = await store.listModes();
    const mode = modes.find((candidate) => candidate.id === target.mode_id);
    const result = await journalled(rt, store, async (recorder) => {
      await recorder.removeActivation(target);
      return { value: null, changes: [`removed ${mode === undefined ? 'a' : modeLabel(mode)} activation (${target.source}) that began ${longLocal(target.starts_at, tz)}`] };
    });
    return { data: { timezone: tz, changes: result.changes, ...journalJson(result.entry) }, text: `${result.changes.join('\n')}${undoHint(result.entry)}` };
  },
});
