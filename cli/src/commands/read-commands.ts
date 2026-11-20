import {
  MAX_SHIFT_MS,
  addDays,
  applyModesToInstants,
  buildModeTimeline,
  computeHabitsReport,
  effectiveModeAt,
  eventKindOf,
  eventOccurrencesBetween,
  isEventPassable,
  isHabit,
  startOfZonedDay,
  zonedDate,
  WRITABLE_SETTINGS_COLUMNS,
  type EventRow,
  type ModeConfig,
  type ModeRow,
} from '@alarm-calendar/core';

import { booleanOption, stringOption } from '../args';
import { CliError } from '../errors';
import { describeRuleValues, modeLabel } from '../modes/mode-rules';
import { plural, renderFields, renderTable } from '../output/render';
import { shortLocal, viewInstant } from '../output/time-format';
import type { Store } from '../store/store';

import { defineCommand } from './command';
import { keyPrefixOption, openWorld } from './support';

/** The modes, rules, activations and exams as core's mode rules read them. */
export async function loadModeConfig(store: Store): Promise<ModeConfig> {
  const [modes, rules, activations, exams] = await Promise.all([store.listModes(), store.listRules(), store.listActivations(), store.listExams()]);
  return { modes, rules, activations, exams };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A local date (start of that day) or a full ISO instant. */
export function parseWhen(value: string, tz: string, flag: string): Date {
  if (DATE_ONLY.test(value)) {
    try {
      return startOfZonedDay(value, tz);
    } catch {
      throw new CliError('invalid_input', `--${flag} "${value}" is not a real date.`);
    }
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || !/\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new CliError('invalid_input', `--${flag} must be a date like 2026-11-09 or an ISO instant, got "${value}".`);
  }
  return parsed;
}

export const occurrences = defineCommand({
  path: ['occurrences'],
  summary: 'Every ring in a time range, with what modes and cheat days do to it. --to is inclusive when it is a date.',
  options: [
    { name: 'from', type: 'string', value: 'date|ISO', description: 'Start of the range (default: today 00:00 in the settings timezone).' },
    { name: 'to', type: 'string', value: 'date|ISO', description: 'End of the range; a date includes that whole day (default: 7 days after --from).' },
    { name: 'key-prefix', type: 'string', value: 'workout/', description: 'Only alarms whose agent key starts with this.' },
    { name: 'include-prayers', type: 'boolean', description: 'Include the five daily prayers.' },
  ],
  writes: false,
  needsLogin: true,
  examples: ['alarm-cal occurrences --from 2026-11-09 --to 2026-11-15 --json'],
  async run({ rt, args }) {
    const { store, settings, tz, now } = await openWorld(rt);
    const today = zonedDate(now, tz);
    const fromArg = stringOption(args, 'from');
    const toArg = stringOption(args, 'to');
    const from = fromArg === undefined ? startOfZonedDay(today, tz) : parseWhen(fromArg, tz, 'from');
    let to: Date;
    if (toArg === undefined) to = new Date(from.getTime() + 7 * 86_400_000);
    else if (DATE_ONLY.test(toArg)) to = startOfZonedDay(addDays(toArg, 1), tz);
    else to = parseWhen(toArg, tz, 'to');
    if (to.getTime() <= from.getTime()) throw new CliError('invalid_input', '--to must be after --from.');
    if (to.getTime() - from.getTime() > 92 * 86_400_000) throw new CliError('invalid_input', 'Ask for at most 92 days at a time.');

    const prefix = keyPrefixOption(args);
    const includePrayers = booleanOption(args, 'include-prayers') === true;
    const [events, config, cheatDays] = await Promise.all([store.listEvents(), loadModeConfig(store), store.listCheatDays()]);
    const timeline = buildModeTimeline(config, settings);
    const cheat = new Set(cheatDays);
    const skipped: string[] = [];
    const rows: Array<{ at: number; json: Record<string, unknown>; cells: string[] }> = [];

    for (const event of events) {
      const kind = eventKindOf(event);
      if (!event.active || kind === 'pre_prayer' || (kind === 'prayer' && !includePrayers)) continue;
      if (prefix !== undefined && !(event.agent_key ?? '').startsWith(prefix)) continue;
      let moded;
      try {
        // A mode shifts a ring by up to 12 hours, so ask for that much more on each side and filter on where it rings.
        const slack = timeline.active && kind === 'normal' ? MAX_SHIFT_MS : 0;
        moded = applyModesToInstants(
          event,
          eventOccurrencesBetween(event, new Date(from.getTime() - slack), new Date(to.getTime() + slack), settings),
          timeline
        );
      } catch {
        skipped.push(event.title);
        continue;
      }
      for (const item of moded) {
        const atMs = item.at.getTime();
        if (atMs < from.getTime() || atMs >= to.getTime()) continue;
        const day = zonedDate(item.at, tz);
        const silenced = !item.paused && isEventPassable(event) && cheat.has(day);
        const shifted = item.original.getTime() !== atMs;
        const effects = [item.paused ? `paused by ${item.mode?.name}` : '', shifted ? `shifted from ${viewInstant(item.original.toISOString(), tz).local.slice(11)}` : '', item.durationMin !== null ? `shortened to ${item.durationMin} min` : '', silenced ? 'cheat day' : '']
          .filter((effect) => effect !== '');
        rows.push({
          at: atMs,
          json: {
            event_id: event.id,
            agent_key: event.agent_key ?? null,
            title: event.title,
            kind,
            at: viewInstant(item.at.toISOString(), tz),
            original_at: shifted ? viewInstant(item.original.toISOString(), tz) : null,
            duration_min: item.durationMin ?? event.duration_min,
            rings: !item.paused && !silenced,
            paused: item.paused,
            paused_by: item.paused ? (item.mode?.name ?? null) : null,
            shifted,
            shortened: item.durationMin !== null,
            mode: item.mode === null ? null : modeLabel(item.mode),
            silenced_by_cheat_day: silenced,
          },
          cells: [shortLocal(item.at.toISOString(), tz), event.agent_key ?? '', event.title, effects.join('; ')],
        });
      }
    }
    rows.sort((a, b) => a.at - b.at);
    const segments = timeline.segments(from, to).map((segment) => ({
      mode: modeLabel(segment.mode),
      source: segment.source,
      from: viewInstant(new Date(Math.max(segment.startMs, from.getTime())).toISOString(), tz),
      to: viewInstant(new Date(Math.min(segment.endMs, to.getTime())).toISOString(), tz),
    }));
    const header = `${plural(rows.length, 'ring')} from ${shortLocal(from.toISOString(), tz)} to ${shortLocal(to.toISOString(), tz)} (${tz})`;
    const modeLines = segments.map((segment) => `mode ${segment.mode} (${segment.source}) ${segment.from.local} to ${segment.to.local}`);
    const text = [header, ...modeLines, rows.length === 0 ? '' : renderTable(['when', 'key', 'title', 'effects'], rows.map((row) => row.cells)), skipped.length > 0 ? `Could not compute: ${skipped.join(', ')}` : '']
      .filter((line) => line !== '')
      .join('\n');
    return {
      data: {
        timezone: tz,
        from: viewInstant(from.toISOString(), tz),
        to: viewInstant(to.toISOString(), tz),
        count: rows.length,
        occurrences: rows.map((row) => row.json),
        mode_segments: segments,
        skipped_events: skipped,
      },
      text,
    };
  },
});

export const stats = defineCommand({
  path: ['stats'],
  summary: 'The habit report: score, tier and streak per recurring alarm, as the Stats screen computes it.',
  writes: false,
  needsLogin: true,
  async run({ rt }) {
    const { store, settings, tz, now } = await openWorld(rt);
    const [events, config, cheatDays] = await Promise.all([store.listEvents(), loadModeConfig(store), store.listCheatDays()]);
    // The longest scoring window is 180 days; one more day covers an occurrence at its edge.
    const since = new Date(now.getTime() - 181 * 86_400_000).toISOString();
    const completions = await store.listCompletions(since);
    const report = computeHabitsReport(events.filter(isHabit), completions.rows, cheatDays, settings, now, config);
    const keyOf = new Map(events.map((event) => [event.id, event.agent_key ?? null]));
    const habits = report.habits.map((habit) => ({
      event_id: habit.eventId,
      agent_key: keyOf.get(habit.eventId) ?? null,
      title: habit.title,
      score: habit.score === null ? null : Math.round(habit.score),
      tier: habit.tier,
      done: habit.done,
      missed: habit.missed,
      excused: habit.excused,
      paused: habit.paused,
      pending: habit.pending,
      current_streak: habit.currentStreak,
      best_streak: habit.bestStreak,
      window_days: habit.windowDays,
      // Only the pooled Prayer habit: how its prayers were done, and how many can still be made up (qada).
      ...(habit.prayerTimings === undefined
        ? {}
        : {
            prayer_timings: {
              on_time: habit.prayerTimings.onTime,
              late: habit.prayerTimings.late,
              qada: habit.prayerTimings.qada,
              open_qada: habit.prayerTimings.openQada,
            },
          }),
    }));
    const overall = report.overallScore === null ? null : Math.round(report.overallScore);
    const warnings = [
      ...(completions.complete ? [] : ['The completion history was too long to read in full, so scores may be lower than the app shows.']),
      ...(report.failed.length > 0 ? [`${plural(report.failed.length, 'alarm')} could not be scored: ${report.failed.map((event) => event.title).join(', ')}`] : []),
    ];
    const rows = habits.map((habit) => [habit.title, habit.score === null ? 'unranked' : String(habit.score), habit.tier, `${habit.done}/${habit.missed}/${habit.excused + habit.paused}`, `${habit.current_streak}/${habit.best_streak}`]);
    const text = [
      `Overall: ${overall === null ? 'unranked' : overall} (${report.overallTier})`,
      rows.length === 0 ? 'No recurring alarms to score yet.' : renderTable(['habit', 'score', 'tier', 'done/missed/excused', 'streak now/best'], rows),
      ...warnings.map((warning) => `warning: ${warning}`),
    ].join('\n');
    return { data: { timezone: tz, overall_score: overall, overall_tier: report.overallTier, habits, warnings }, text };
  },
});

export const passes = defineCommand({
  path: ['passes'],
  summary: 'The cheat-day pass wallet and the days passes were spent on.',
  writes: false,
  needsLogin: true,
  async run({ rt }) {
    const { store, settings, tz, now } = await openWorld(rt);
    const [wallet, cheatDays] = await Promise.all([store.getWallet(), store.listCheatDays()]);
    const today = zonedDate(now, tz);
    const upcoming = cheatDays.filter((day) => day >= today);
    const nextGrant = wallet === null ? null : addDays(wallet.last_granted_week_start, 7);
    const note = 'The balance is as of the last time the app synced the wallet; weekly grants appear when the app next opens.';
    return {
      data: {
        timezone: tz,
        balance: wallet?.balance ?? null,
        cap: settings.pass_cap,
        next_grant_on_or_after: nextGrant,
        cheat_days_upcoming: upcoming,
        cheat_days_past: cheatDays.filter((day) => day < today).slice(-30),
        note,
      },
      text: renderFields([
        ['balance', wallet === null ? '(no wallet yet; open the app once)' : `${wallet.balance} of ${settings.pass_cap}`],
        ['next grant', nextGrant ?? '(unknown)'],
        ['cheat days ahead', upcoming.length === 0 ? '(none)' : upcoming.join(', ')],
        ['note', note],
      ]),
    };
  },
});

export const examsList = defineCommand({
  path: ['exams', 'list'],
  summary: 'List exams with their revision sessions.',
  options: [{ name: 'all', type: 'boolean', description: 'Include removed exams.' }],
  writes: false,
  needsLogin: true,
  async run({ rt, args }) {
    const { store, tz, now } = await openWorld(rt);
    const all = booleanOption(args, 'all') === true;
    const [exams, events] = await Promise.all([store.listExams(), store.listEvents()]);
    const shown = exams.filter((exam) => all || exam.active);
    const views = shown.map((exam) => {
      const alarms = events.filter((event) => event.exam_id === exam.id && event.active);
      const upcoming = alarms.filter((event) => event.exam_role === 'session' && Date.parse(event.start_at) > now.getTime());
      return {
        id: exam.id,
        agent_key: exam.agent_key ?? null,
        title: exam.title,
        active: exam.active,
        exam_at: viewInstant(exam.exam_at, tz),
        difficulty: exam.difficulty,
        notes: exam.notes,
        alarms: alarms.length,
        upcoming_sessions: upcoming.length,
      };
    });
    const rows = views.map((view) => [view.agent_key ?? '', view.id.slice(0, 8), view.title, shortLocal(view.exam_at.iso, tz), String(view.difficulty), String(view.upcoming_sessions), view.active ? '' : 'removed']);
    return {
      data: { timezone: tz, count: views.length, exams: views },
      text: views.length === 0 ? 'No exams.' : `${plural(views.length, 'exam')}, times in ${tz}\n${renderTable(['key', 'id', 'title', 'exam at', 'difficulty', 'sessions to come', 'state'], rows)}`,
    };
  },
});

export const modesList = defineCommand({
  path: ['modes', 'list'],
  summary: 'The modes, the alarm rules under each, and when they are switched on.',
  writes: false,
  needsLogin: true,
  async run({ rt }) {
    const { store, settings, tz, now } = await openWorld(rt);
    const [events, config] = await Promise.all([store.listEvents(), loadModeConfig(store)]);
    const eventById = new Map<string, EventRow>(events.map((event) => [event.id, event]));
    const modeById = new Map<string, ModeRow>(config.modes.map((mode) => [mode.id, mode]));
    const effective = effectiveModeAt(now, config, settings);

    const modes = config.modes.map((mode) => ({
      id: mode.id,
      key: mode.builtin_key,
      name: mode.name,
      kind: mode.kind,
      active: mode.active,
      default_behavior: mode.default_behavior,
      in_effect_now: effective?.mode.id === mode.id,
      rules: config.rules
        .filter((rule) => rule.mode_id === mode.id)
        .map((rule) => ({
          event_id: rule.event_id,
          agent_key: eventById.get(rule.event_id)?.agent_key ?? null,
          title: eventById.get(rule.event_id)?.title ?? '(unknown alarm)',
          behavior: rule.behavior,
          shift_minutes: rule.shift_minutes,
          duration_min: rule.duration_min,
          summary: describeRuleValues(rule),
        })),
    }));
    const activations = config.activations.map((activation) => {
      const startMs = Date.parse(activation.starts_at);
      const endMs = activation.ends_at === null ? Infinity : Date.parse(activation.ends_at);
      const state = now.getTime() < startMs ? 'planned' : now.getTime() < endMs ? 'running' : 'past';
      const mode = modeById.get(activation.mode_id);
      return {
        id: activation.id,
        mode: mode === undefined ? activation.mode_id : modeLabel(mode),
        source: activation.source,
        starts: viewInstant(activation.starts_at, tz),
        ends: activation.ends_at === null ? null : viewInstant(activation.ends_at, tz),
        state,
      };
    });
    const lines = [
      effective === null ? 'No mode in effect now (Normal).' : `In effect now: ${modeLabel(effective.mode)} (${effective.source})`,
      ...modes.map((mode) => {
        const rules = mode.rules.length === 0 ? 'no alarm rules' : mode.rules.map((rule) => `${rule.agent_key ?? rule.title}: ${rule.summary}`).join(', ');
        return `${mode.key ?? mode.name}${mode.active ? '' : ' (off)'}: default ${mode.default_behavior}; ${rules}`;
      }),
      ...activations.filter((activation) => activation.state !== 'past').map((activation) => `${activation.state}: ${activation.mode} ${activation.starts.local} ${activation.ends === null ? 'until switched back' : `to ${activation.ends.local}`} (${activation.source}, id ${activation.id.slice(0, 8)})`),
    ];
    return {
      data: {
        timezone: tz,
        in_effect_now: effective === null ? null : { mode: modeLabel(effective.mode), source: effective.source },
        modes,
        activations,
      },
      text: lines.join('\n'),
    };
  },
});

export const settingsGet = defineCommand({
  path: ['settings', 'get'],
  summary: 'The settings row and which fields `settings set` may change.',
  writes: false,
  needsLogin: true,
  async run({ rt }) {
    const { settings, tz } = await openWorld(rt);
    const entries = Object.entries(settings).filter(([name]) => name !== 'user_id');
    return {
      data: { timezone: tz, settings, writable_fields: [...WRITABLE_SETTINGS_COLUMNS, 'prayers_enabled'] },
      text: renderFields(entries.map(([name, value]) => [name, value === null ? '(none)' : String(value)])),
    };
  },
});
