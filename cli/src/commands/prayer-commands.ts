import {
  HABIT_WINDOW_DAYS,
  PRAYER_LABELS,
  PRAYER_NAMES,
  addDays,
  dayNumberFromDateString,
  isRealDate,
  prayerLog,
  prayerTimesOnDay,
  resolvePrayerConfig,
  startOfZonedDay,
  zonedDate,
  type EventRow,
  type PrayerLogEntry,
  type PrayerName,
  type Settings,
} from '@alarm-calendar/core';

import { numberOption, stringOption } from '../args';
import { CliError } from '../errors';
import { plural, renderTable } from '../output/render';
import { shortLocal, viewInstant } from '../output/time-format';
import type { Store } from '../store/store';

import { defineCommand } from './command';
import { journalJson, journalled, openWorld, undoHint } from './support';

const MS_PER_DAY = 86_400_000;
const MAX_DAYS = 31;
/** Completions are matched by prayer-day, which can sit a day off the instant: read a margin around the range. */
const COMPLETION_MARGIN_DAYS = 2;

type PrayerStatus = 'on time' | 'late' | 'qada' | 'missed' | 'open' | 'to come';

function statusOf(entry: PrayerLogEntry, now: Date): PrayerStatus {
  switch (entry.tier) {
    case 'on_time':
      return 'on time';
    case 'late':
      return 'late';
    case 'qada':
      return 'qada';
    case 'missed':
      return 'missed';
    case 'pending':
      return entry.at.getTime() > now.getTime() ? 'to come' : 'open';
  }
}

function prayerEventsOf(events: readonly EventRow[]): EventRow[] {
  return events.filter((event) => event.kind === 'prayer' && event.active && event.prayer != null);
}

/** Prayers switched off: nothing to show, and the way to switch them on. */
function requirePrayersOn(settings: Settings): void {
  if (settings.prayers_enabled !== true) {
    throw new CliError('invalid_input', 'Prayer alarms are off.', 'Switch them on with `alarm-cal settings set prayers_enabled true`.');
  }
}

async function loadLog(store: Store, settings: Settings, now: Date, fromMs: number, toMs: number): Promise<PrayerLogEntry[]> {
  const events = prayerEventsOf(await store.listEvents());
  const since = new Date(fromMs - COMPLETION_MARGIN_DAYS * MS_PER_DAY).toISOString();
  const completions = await store.listCompletions(since);
  return prayerLog(events, completions.rows, settings, now, fromMs, toMs);
}

function view(entry: PrayerLogEntry, tz: string, now: Date): Record<string, unknown> {
  return {
    prayer: entry.prayer,
    // The prayer-day, not the clock date: an Isha after midnight belongs to the evening before, and this is the date
    // `qada done --date` takes. The clock time is in `at`.
    prayer_day: entry.day,
    at: viewInstant(entry.at.toISOString(), tz),
    window_ends: entry.windowEnd === null ? null : viewInstant(entry.windowEnd.toISOString(), tz),
    status: statusOf(entry, now),
  };
}

export const prayers = defineCommand({
  path: ['prayers'],
  summary: "Each prayer's day (prayer-day), time, when its window ends, and what became of it: on time, late, qada (made up), missed, open (still inside its time) or to come.",
  options: [
    { name: 'date', type: 'string', value: 'yyyy-MM-dd', description: 'First day to show (default: today in the settings timezone).' },
    { name: 'days', type: 'number', value: '1-31', description: 'How many days from --date. Default 1.' },
  ],
  writes: false,
  needsLogin: true,
  examples: ['alarm-cal prayers --json', 'alarm-cal prayers --date 2026-11-09 --days 3 --json'],
  async run({ rt, args }) {
    const { store, settings, tz, now } = await openWorld(rt);
    requirePrayersOn(settings);
    const date = stringOption(args, 'date') ?? zonedDate(now, tz);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isRealDate(date)) throw new CliError('invalid_input', `--date must be a real date like 2026-11-09, got "${date}".`);
    const days = numberOption(args, 'days') ?? 1;
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new CliError('invalid_input', `--days is a whole number from 1 to ${MAX_DAYS}.`);
    // The days are prayer-days, so an Isha after midnight is listed with the evening it belongs to: read a day more on
    // each side of the clock range and keep the entries whose prayer-day is inside it.
    const lastDay = addDays(date, days - 1);
    const from = startOfZonedDay(addDays(date, -1), tz).getTime();
    const to = startOfZonedDay(addDays(date, days + 1), tz).getTime() - 1;
    const log = (await loadLog(store, settings, now, from, to)).filter((entry) => entry.day >= date && entry.day <= lastDay);
    const rows = log.map((entry) => view(entry, tz, now));
    const table = log.map((entry) => [
      entry.day,
      shortLocal(entry.at.toISOString(), tz),
      PRAYER_LABELS[entry.prayer],
      entry.windowEnd === null ? '' : viewInstant(entry.windowEnd.toISOString(), tz).local.slice(11),
      statusOf(entry, now),
    ]);
    return {
      data: { timezone: tz, from: date, days, count: rows.length, prayers: rows },
      text: rows.length === 0 ? 'No prayers in that range (they start counting when the prayer alarms were switched on).' : `${plural(rows.length, 'prayer')}, times in ${tz}\n${renderTable(['prayer day', 'when', 'prayer', 'ends', 'status'], table)}`,
    };
  },
});

export const qadaList = defineCommand({
  path: ['qada', 'list'],
  summary: `Prayers of the last ${HABIT_WINDOW_DAYS} days whose time ran out with no record: the ones that can still be made up with \`qada done\`.`,
  writes: false,
  needsLogin: true,
  examples: ['alarm-cal qada list --json'],
  async run({ rt }) {
    const { store, settings, tz, now } = await openWorld(rt);
    requirePrayersOn(settings);
    const log = await loadLog(store, settings, now, now.getTime() - HABIT_WINDOW_DAYS * MS_PER_DAY, now.getTime());
    const open = log.filter((entry) => entry.tier === 'missed');
    const rows = open.map((entry) => view(entry, tz, now));
    const table = open.map((entry) => [PRAYER_LABELS[entry.prayer], entry.day, shortLocal(entry.at.toISOString(), tz)]);
    return {
      data: { timezone: tz, window_days: HABIT_WINDOW_DAYS, count: rows.length, qada: rows },
      text: rows.length === 0 ? `Nothing to make up from the last ${HABIT_WINDOW_DAYS} days.` : `${plural(rows.length, 'prayer')} to make up, times in ${tz}\n${renderTable(['prayer', 'prayer day', 'was due'], table)}`,
    };
  },
});

export const qadaDone = defineCommand({
  path: ['qada', 'done'],
  summary: 'Record a missed prayer as made up (qada): `qada done <prayer> --date yyyy-MM-dd`. Only for a prayer that was actually missed and whose time is over. `alarm-cal undo` removes it.',
  positionals: [{ name: 'prayer', description: 'fajr, dhuhr, asr, maghrib or isha.', required: true }],
  options: [{ name: 'date', type: 'string', value: 'yyyy-MM-dd', description: 'The day the prayer belonged to (required).' }],
  writes: true,
  needsLogin: true,
  examples: ['alarm-cal qada done dhuhr --date 2026-11-09'],
  async run({ rt, args }) {
    const name = (args.positionals[0] ?? '').toLowerCase();
    if (!(PRAYER_NAMES as readonly string[]).includes(name)) {
      throw new CliError('usage', `The prayer is one of ${PRAYER_NAMES.join(', ')}, got "${args.positionals[0] ?? ''}".`);
    }
    const prayer = name as PrayerName;
    const date = stringOption(args, 'date');
    if (date === undefined) throw new CliError('usage', '`qada done` needs --date yyyy-MM-dd: which day the prayer was missed.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isRealDate(date)) throw new CliError('invalid_input', `--date must be a real date like 2026-11-09, got "${date}".`);

    const { store, settings, tz, now } = await openWorld(rt);
    requirePrayersOn(settings);
    const config = resolvePrayerConfig(settings);
    if (config === null) throw new CliError('invalid_input', 'Prayer alarms are off.');
    const at = prayerTimesOnDay(config, dayNumberFromDateString(date))[prayer];
    if (now.getTime() - at.getTime() > HABIT_WINDOW_DAYS * MS_PER_DAY) {
      throw new CliError('invalid_input', `${PRAYER_LABELS[prayer]} of ${date} is more than ${HABIT_WINDOW_DAYS} days ago: the app no longer scores or lists it.`);
    }
    const log = await loadLog(store, settings, now, at.getTime(), at.getTime());
    const entry = log.find((candidate) => candidate.prayer === prayer && candidate.at.getTime() === at.getTime());
    if (entry === undefined) {
      throw new CliError('not_found', `There is no ${PRAYER_LABELS[prayer]} alarm for ${date} (prayers count from when they were switched on, and not in the future).`);
    }
    if (entry.tier === 'pending') {
      const ends = entry.windowEnd === null ? '' : ` until ${viewInstant(entry.windowEnd.toISOString(), tz).local.slice(11)}`;
      throw new CliError('invalid_input', `${PRAYER_LABELS[prayer]} of ${date} is still inside its time${ends}.`, 'Qada is for a prayer whose time is over. Pray it on time instead.');
    }
    if (entry.tier !== 'missed') {
      throw new CliError('conflict', `${PRAYER_LABELS[prayer]} of ${date} already has a record (${statusOf(entry, now)}).`, 'Qada is only for a prayer that was missed.');
    }

    const events = prayerEventsOf(await store.listEvents());
    const event = events.find((candidate) => candidate.id === entry.eventId);
    if (event === undefined) throw new CliError('not_found', `The ${PRAYER_LABELS[prayer]} alarm is not there any more.`);
    const { value, changes, entry: journal } = await journalled(rt, store, async (recorder) => {
      const row = await recorder.createCompletion({ event_id: event.id, occurrence_at: at.toISOString(), done_at: now.toISOString() });
      return { value: row, changes: [`${PRAYER_LABELS[prayer]} of ${date}: made up (qada)`] };
    });
    return {
      data: { prayer, date, completion_id: value.id, done_at: viewInstant(value.done_at, tz), changes, ...journalJson(journal) },
      text: `${changes.join('\n')}${undoHint(journal)}`,
    };
  },
});
