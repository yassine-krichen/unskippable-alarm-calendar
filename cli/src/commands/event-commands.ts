import type { EventRow } from '@alarm-calendar/core';

import { booleanOption, numberOption, stringOption, type OptionSpec, type ParsedArgs } from '../args';
import { CliError } from '../errors';
import {
  AGENT_KEY_PATTERN,
  changedColumns,
  describeEventRow,
  diffFriendly,
  eventSpecSchema,
  resolveEventSpec,
  type EventSpec,
  type FieldChange,
  type FriendlyEvent,
} from '../events/event-spec';
import { describeRuleValues, modeLabel } from '../modes/mode-rules';
import { longLocal, shortLocal } from '../output/time-format';
import { plural, renderFields, renderTable } from '../output/render';
import type { EventPatch } from '../store/store';

import { defineCommand } from './command';
import {
  eventView,
  findEventRef,
  isUserAlarm,
  journalJson,
  journalled,
  keyPrefixOption,
  openWorld,
  repeatText,
  undoHint,
} from './support';

export const EVENT_FLAGS: readonly OptionSpec[] = [
  { name: 'title', type: 'string', description: 'Alarm title (1 to 120 characters).' },
  { name: 'notes', type: 'string', description: 'Notes; an empty string clears them.' },
  { name: 'time', type: 'string', value: 'HH:mm', description: 'Time of day in the settings timezone, 24-hour.' },
  { name: 'start', type: 'string', value: 'yyyy-MM-dd', description: 'First date (or the date of a one-time alarm).' },
  { name: 'at', type: 'string', value: '"yyyy-MM-dd HH:mm"', description: 'Shorthand for --start and --time together.' },
  { name: 'duration', type: 'string', value: 'minutes|1h30m', description: 'Calendar block length.' },
  { name: 'repeat', type: 'string', value: 'preset', description: 'none, every-12-hours, daily, every-2-days, every-3-days, weekly, monthly, yearly.' },
  { name: 'every', type: 'number', value: 'N', description: 'Custom repeat: every N units (needs --unit).' },
  { name: 'unit', type: 'string', value: 'hour|day|week|month|year', description: 'Unit of a custom repeat.' },
  { name: 'days', type: 'string', value: 'mon,wed,fri', description: 'Weekdays (implies a weekly repeat); also weekdays or weekends.' },
  { name: 'ends', type: 'string', value: 'yyyy-MM-dd|none', description: 'Last date of a repeating alarm.' },
  { name: 'max-snoozes', type: 'number', value: '0-10', description: 'Snoozes allowed.' },
  { name: 'snooze-minutes', type: 'number', value: '1-120', description: 'Snooze length.' },
  { name: 'passable', type: 'boolean', description: 'Whether a pass or a mode may silence it (--no-passable for medication).' },
  { name: 'color', type: 'string', value: 'name|none', description: 'red, orange, yellow, green, blue, violet, pink, or none.' },
  { name: 'show-in-calendar', type: 'boolean', description: 'Draw it on the calendar (--no-show-in-calendar hides it; it still rings).' },
  { name: 'key', type: 'string', value: 'workout/push-day', description: 'Agent key: a stable name to find this alarm again.' },
];

type SpecInput = Partial<EventSpec>;

/** The flags as a partial spec; only what was given. */
export function specFromFlags(args: ParsedArgs): SpecInput {
  const spec: Record<string, unknown> = {};
  const set = (field: string, value: unknown): void => {
    if (value !== undefined) spec[field] = value;
  };
  set('title', stringOption(args, 'title'));
  const notes = stringOption(args, 'notes');
  set('notes', notes === '' ? null : notes);
  let time = stringOption(args, 'time');
  let start = stringOption(args, 'start');
  const at = stringOption(args, 'at');
  if (at !== undefined) {
    const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(at);
    if (match === null) throw new CliError('usage', '--at must look like "2026-11-09 07:30".');
    start = match[1];
    time = match[2];
  }
  set('time', time);
  set('start', start);
  const duration = stringOption(args, 'duration');
  set('duration', duration !== undefined && /^\d+$/.test(duration) ? Number(duration) : duration);
  const every = numberOption(args, 'every');
  const unit = stringOption(args, 'unit');
  const repeat = stringOption(args, 'repeat');
  if (every !== undefined || unit !== undefined) {
    if (every === undefined || unit === undefined) throw new CliError('usage', '--every and --unit go together, like --every 2 --unit week.');
    if (repeat !== undefined) throw new CliError('usage', 'Use --repeat for a preset, or --every with --unit for a custom repeat, not both.');
    set('repeat', { every, unit });
  } else {
    set('repeat', repeat);
  }
  const days = stringOption(args, 'days');
  if (days !== undefined) set('days', days.includes(',') || !['weekdays', 'weekends'].includes(days) ? days.split(',').map((item) => item.trim().toLowerCase().slice(0, 3)) : days);
  const ends = stringOption(args, 'ends');
  set('ends', ends === 'none' ? null : ends);
  set('maxSnoozes', numberOption(args, 'max-snoozes'));
  set('snoozeMinutes', numberOption(args, 'snooze-minutes'));
  set('passable', booleanOption(args, 'passable'));
  const color = stringOption(args, 'color');
  if (color !== undefined) set('color', color === 'none' ? null : color.toLowerCase());
  set('showInCalendar', booleanOption(args, 'show-in-calendar'));
  return spec as SpecInput;
}

function spliceSpec(base: SpecInput, flags: SpecInput): SpecInput {
  const merged: SpecInput = { ...base, ...flags };
  // Changing the repeat without naming days drops the old days unless the new repeat is weekly again.
  const isWeekly = (repeat: SpecInput['repeat']): boolean => repeat === 'weekly' || (typeof repeat === 'object' && repeat.unit === 'week');
  if (flags.repeat !== undefined && flags.days === undefined && !isWeekly(flags.repeat)) delete merged.days;
  // Naming days makes the alarm weekly; keep a fortnightly rhythm, drop any other repeat.
  if (flags.days !== undefined && flags.repeat === undefined && !isWeekly(base.repeat)) delete merged.repeat;
  return merged;
}

/** The plan-vocabulary spec of a stored alarm, to edit with flags. */
export function specFromRow(row: EventRow, tz: string): SpecInput {
  const friendly = describeEventRow(row, tz);
  const spec: Record<string, unknown> = {
    title: friendly.title,
    notes: friendly.notes,
    time: friendly.time,
    start: friendly.start,
    duration: friendly.duration,
    maxSnoozes: friendly.maxSnoozes,
    snoozeMinutes: friendly.snoozeMinutes,
    passable: friendly.passable,
    color: friendly.color,
    showInCalendar: friendly.showInCalendar,
    ends: friendly.ends,
  };
  if (friendly.repeat !== 'none') spec['repeat'] = friendly.repeat;
  if (friendly.days !== null) spec['days'] = friendly.days;
  return spec as SpecInput;
}

function validateSpec(spec: SpecInput): EventSpec {
  const parsed = eventSpecSchema.safeParse(spec);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'alarm'}: ${issue.message}`);
    throw new CliError('invalid_input', problems.join('; '));
  }
  return parsed.data;
}

function assertKey(key: string): void {
  if (!AGENT_KEY_PATTERN.test(key)) {
    throw new CliError('invalid_input', `The key "${key}" is not valid.`, 'Use lowercase letters, digits and / _ . - (max 100 characters), like workout/push-day.');
  }
}

function formatValue(value: unknown): string {
  return value === null || value === undefined ? '(none)' : typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value);
}

export function renderChange(change: FieldChange): string {
  return `${change.field}: ${formatValue(change.from)} -> ${formatValue(change.to)}`;
}

function describeNew(spec: FriendlyEvent): string {
  return `${spec.time}, ${repeatText(spec)}, ${spec.duration} min`;
}

export const eventsList = defineCommand({
  path: ['events', 'list'],
  summary: 'List alarms with their agent keys and next ring time.',
  writes: false,
  needsLogin: true,
  options: [
    { name: 'all', type: 'boolean', description: 'Include switched-off alarms.' },
    { name: 'key-prefix', type: 'string', value: 'workout/', description: 'Only alarms whose agent key starts with this.' },
  ],
  examples: ['alarm-cal events list --json', 'alarm-cal events list --key-prefix workout/'],
  async run({ rt, args }) {
    const { store, tz, now } = await openWorld(rt);
    const prefix = keyPrefixOption(args);
    const includeInactive = booleanOption(args, 'all') === true;
    const events = (await store.listEvents()).filter(
      (event) => isUserAlarm(event) && (includeInactive || event.active) && (prefix === undefined || (event.agent_key ?? '').startsWith(prefix))
    );
    const views = events.map((event) => eventView(event, tz, now));
    const rows = views.map((view) => [
      view.agent_key ?? '',
      view.id.slice(0, 8),
      view.spec.title,
      `${view.spec.time} ${repeatText(view.spec)}`,
      view.next_ring === null ? '' : shortLocal(view.next_ring.iso, tz),
      view.active ? '' : 'off',
    ]);
    const text =
      events.length === 0
        ? `No alarms${prefix === undefined ? '' : ` with key prefix ${prefix}`}. (Times are in ${tz}.)`
        : `${plural(events.length, 'alarm')}, times in ${tz}\n${renderTable(['key', 'id', 'title', 'schedule', 'next ring', 'state'], rows)}`;
    return { data: { timezone: tz, count: views.length, events: views }, text };
  },
});

export const eventsGet = defineCommand({
  path: ['events', 'get'],
  summary: 'Show one alarm in full, with its rules under each mode.',
  positionals: [{ name: 'ref', description: 'Alarm id (or 8+ character prefix) or agent key.', required: true }],
  writes: false,
  needsLogin: true,
  async run({ rt, args }) {
    const ref = args.positionals[0];
    if (ref === undefined) throw new CliError('usage', 'Give an alarm id or agent key.');
    const { store, tz, now } = await openWorld(rt);
    const event = findEventRef(await store.listEvents(), ref);
    const [modes, rules] = await Promise.all([store.listModes(), store.listRules()]);
    const view = eventView(event, tz, now);
    const modeRules = rules
      .filter((rule) => rule.event_id === event.id)
      .map((rule) => {
        const mode = modes.find((candidate) => candidate.id === rule.mode_id);
        return { mode: mode === undefined ? rule.mode_id : modeLabel(mode), behavior: rule.behavior, shift_minutes: rule.shift_minutes, duration_min: rule.duration_min };
      });
    const fields: Array<[string, string]> = [
      ['id', view.id],
      ['key', view.agent_key ?? '(none)'],
      ['title', view.spec.title],
      ['state', view.active ? 'on' : 'off'],
      ['starts', longLocal(event.start_at, tz)],
      ['schedule', `${view.spec.time} ${repeatText(view.spec)}, ${view.spec.duration} min`],
      ['ends', view.ends === null ? 'never' : longLocal(view.ends.iso, tz)],
      ['next ring', view.next_ring === null ? '(none)' : longLocal(view.next_ring.iso, tz)],
      ['snoozes', `${view.spec.maxSnoozes} x ${view.spec.snoozeMinutes} min`],
      ['passable', String(view.spec.passable)],
      ['color', view.spec.color ?? '(none)'],
      ['on calendar', String(view.spec.showInCalendar)],
    ];
    if (view.spec.notes !== null) fields.push(['notes', view.spec.notes]);
    if (modeRules.length > 0) {
      fields.push(['mode rules', modeRules.map((rule) => `${rule.mode}: ${describeRuleValues({ behavior: rule.behavior as never, shift_minutes: rule.shift_minutes, duration_min: rule.duration_min })}`).join('; ')]);
    }
    return { data: { timezone: tz, event: view, mode_rules: modeRules }, text: renderFields(fields) };
  },
});

export const eventsAdd = defineCommand({
  path: ['events', 'add'],
  summary: 'Create an alarm.',
  writes: true,
  needsLogin: true,
  options: EVENT_FLAGS,
  examples: [
    'alarm-cal events add --title "Push day" --time 07:30 --days mon,wed,fri --duration 60 --key workout/push-day',
    'alarm-cal events add --title "Dentist" --at "2026-11-20 09:15" --no-passable',
  ],
  async run({ rt, args }) {
    const { store, tz, now } = await openWorld(rt);
    const flags = specFromFlags(args);
    const spec = validateSpec(flags);
    const key = stringOption(args, 'key');
    if (key !== undefined) {
      assertKey(key);
      if ((await store.listEvents()).some((event) => event.agent_key === key)) {
        throw new CliError('conflict', `The key "${key}" is already used.`, 'Use `events update` to change that alarm, or pick another key.');
      }
    }
    const resolved = resolveEventSpec(spec, { tz, now });
    const result = await journalled(rt, store, async (recorder) => {
      const [row] = await recorder.createEvents([{ ...resolved.input, ...(key === undefined ? {} : { agent_key: key }) }]);
      if (row === undefined) throw new CliError('server', 'The alarm was not returned after saving.');
      return { value: row, changes: [`created "${row.title}"${key === undefined ? '' : ` (${key})`}: ${describeNew(describeEventRow(row, tz))}`] };
    });
    const view = eventView(result.value, tz, now);
    const nextLine = view.next_ring === null ? 'It has no upcoming ring.' : `Next ring: ${longLocal(view.next_ring.iso, tz)}`;
    return {
      data: { timezone: tz, event: view, changes: result.changes, warnings: resolved.warnings, ...journalJson(result.entry) },
      text: `${result.changes.join('\n')}\nid ${view.id}\n${nextLine}${resolved.warnings.map((warning) => `\nwarning: ${warning}`).join('')}${undoHint(result.entry)}`,
    };
  },
});

export const eventsUpdate = defineCommand({
  path: ['events', 'update'],
  summary: 'Change an alarm; only the flags you give change.',
  positionals: [{ name: 'ref', description: 'Alarm id (or prefix) or agent key.', required: true }],
  writes: true,
  needsLogin: true,
  options: EVENT_FLAGS,
  examples: ['alarm-cal events update workout/push-day --time 08:00 --duration 45'],
  async run({ rt, args }) {
    const ref = args.positionals[0];
    if (ref === undefined) throw new CliError('usage', 'Give an alarm id or agent key.');
    const { store, tz, now } = await openWorld(rt);
    const events = await store.listEvents();
    const existing = findEventRef(events, ref);
    if (!isUserAlarm(existing)) throw new CliError('invalid_input', 'Prayer alarms are managed in settings, not here.', 'See `alarm-cal settings get`.');
    const flags = specFromFlags(args);
    const key = stringOption(args, 'key');
    if (key !== undefined) {
      assertKey(key);
      if (events.some((event) => event.agent_key === key && event.id !== existing.id)) {
        throw new CliError('conflict', `The key "${key}" is already used by another alarm.`);
      }
    }
    const spec = validateSpec(spliceSpec(specFromRow(existing, tz), flags));
    const resolved = resolveEventSpec(spec, { tz, now, existing });
    const patch: EventPatch = { ...changedColumns(existing, resolved.input, tz) };
    if (key !== undefined && key !== existing.agent_key) patch.agent_key = key;
    const changes = diffFriendly(describeEventRow(existing, tz), describeEventRow(resolved.input, tz));
    if (key !== undefined && key !== existing.agent_key) changes.push({ field: 'key', from: existing.agent_key ?? null, to: key });
    if (Object.keys(patch).length === 0) {
      return { data: { timezone: tz, event: eventView(existing, tz, now), changes: [], ...journalJson(null) }, text: 'No changes: the alarm already looks like that.' };
    }
    const result = await journalled(rt, store, async (recorder) => {
      const row = await recorder.updateEvent(existing, patch);
      return { value: row, changes: changes.map((change) => `${existing.agent_key ?? existing.title}: ${renderChange(change)}`) };
    });
    const view = eventView(result.value, tz, now);
    return {
      data: { timezone: tz, event: view, changes: changes, warnings: resolved.warnings, ...journalJson(result.entry) },
      text: `${result.changes.join('\n')}\nNext ring: ${view.next_ring === null ? '(none)' : longLocal(view.next_ring.iso, tz)}${undoHint(result.entry)}`,
    };
  },
});

function switchCommand(name: 'disable' | 'enable') {
  const active = name === 'enable';
  return defineCommand({
    path: ['events', name],
    summary: active ? 'Switch alarms back on.' : 'Switch alarms off (soft delete: they can be switched on again).',
    positionals: [{ name: 'ref', description: 'Alarm ids or agent keys.', variadic: true }],
    options: [{ name: 'key-prefix', type: 'string', value: 'workout/', description: `${active ? 'Enable' : 'Disable'} every alarm whose agent key starts with this.` }],
    writes: true,
    needsLogin: true,
    examples: [`alarm-cal events ${name} --key-prefix workout/`, `alarm-cal events ${name} workout/push-day`],
    async run({ rt, args }) {
      const prefix = keyPrefixOption(args);
      if (args.positionals.length === 0 && prefix === undefined) {
        throw new CliError('usage', `Name the alarms to ${name}, or pass --key-prefix.`);
      }
      const { store, tz, now } = await openWorld(rt);
      const events = await store.listEvents();
      const targets = new Map<string, EventRow>();
      for (const ref of args.positionals) {
        const event = findEventRef(events, ref);
        targets.set(event.id, event);
      }
      if (prefix !== undefined) {
        const matched = events.filter((event) => (event.agent_key ?? '').startsWith(prefix));
        if (matched.length === 0) throw new CliError('not_found', `No alarm has an agent key starting with "${prefix}".`);
        for (const event of matched) targets.set(event.id, event);
      }
      for (const event of targets.values()) {
        if (!isUserAlarm(event)) throw new CliError('invalid_input', 'Prayer alarms are managed in settings, not here.');
      }
      const toChange = [...targets.values()].filter((event) => event.active !== active);
      const result = await journalled(rt, store, async (recorder) => {
        const lines: string[] = [];
        for (const event of toChange) {
          await recorder.updateEvent(event, { active });
          lines.push(`${active ? 'switched on' : 'switched off'} "${event.title}"${event.agent_key == null ? '' : ` (${event.agent_key})`}`);
        }
        return { value: toChange.length, changes: lines };
      });
      const already = targets.size - toChange.length;
      const text =
        toChange.length === 0
          ? `Nothing to do: ${plural(targets.size, 'alarm')} already ${active ? 'on' : 'off'}.`
          : `${result.changes.join('\n')}${already > 0 ? `\n${plural(already, 'alarm')} already ${active ? 'on' : 'off'}.` : ''}${undoHint(result.entry)}`;
      return {
        data: { timezone: tz, changed: toChange.map((event) => ({ id: event.id, agent_key: event.agent_key ?? null, title: event.title })), unchanged: already, changes: result.changes, ...journalJson(result.entry), now: now.toISOString() },
        text,
      };
    },
  });
}

export const eventsDisable = switchCommand('disable');
export const eventsEnable = switchCommand('enable');
