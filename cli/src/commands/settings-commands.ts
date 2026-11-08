import { WRITABLE_SETTINGS_COLUMNS, assertValidTimeZone } from '@alarm-calendar/core';

import { CliError } from '../errors';
import { parseWeekday } from '../events/event-spec';

import { defineCommand } from './command';
import { journalJson, journalled, openWorld, undoHint } from './support';

interface SettingSpec {
  describe: string;
  parse(raw: string): unknown;
}

const integer = (min: number, max: number): SettingSpec => ({
  describe: `whole number ${min} to ${max}`,
  parse(raw) {
    const value = Number(raw);
    if (raw.trim() === '' || !Number.isInteger(value) || value < min || value > max) {
      throw new CliError('invalid_input', `Expected a whole number from ${min} to ${max}, got "${raw}".`);
    }
    return value;
  },
});

const decimal = (min: number, max: number): SettingSpec => ({
  describe: `number ${min} to ${max}`,
  parse(raw) {
    const value = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(value) || value < min || value > max) {
      throw new CliError('invalid_input', `Expected a number from ${min} to ${max}, got "${raw}".`);
    }
    return value;
  },
});

const boolean: SettingSpec = {
  describe: 'true or false',
  parse(raw) {
    const lowered = raw.trim().toLowerCase();
    if (['true', 'on', 'yes', '1'].includes(lowered)) return true;
    if (['false', 'off', 'no', '0'].includes(lowered)) return false;
    throw new CliError('invalid_input', `Expected true or false, got "${raw}".`);
  },
};

/** The settings a client may write, with the same bounds the database checks. */
const SETTING_SPECS: Record<string, SettingSpec> = {
  timezone: {
    describe: 'IANA zone name, like Africa/Tunis',
    parse(raw) {
      try {
        assertValidTimeZone(raw);
      } catch {
        throw new CliError('invalid_input', `"${raw}" is not an IANA time zone name.`);
      }
      return raw;
    },
  },
  week_starts_on: {
    describe: 'weekday 0 (Monday) to 6 (Sunday), or a name like mon',
    parse(raw) {
      return /^\d$/.test(raw) ? integer(0, 6).parse(raw) : parseWeekday(raw);
    },
  },
  refire_seconds: integer(1, 3600),
  grace_minutes: integer(0, 10080),
  exam_mode_days_before: integer(0, 60),
  latitude: decimal(-65, 65),
  longitude: decimal(-180, 180),
  location_label: {
    describe: 'text up to 100 characters',
    parse(raw) {
      if (raw.length > 100) throw new CliError('invalid_input', 'The location label is at most 100 characters.');
      return raw;
    },
  },
  fajr_angle: decimal(10, 22),
  isha_angle: decimal(10, 22),
  asr_factor: {
    describe: '1 (Shafi, Maliki, Hanbali) or 2 (Hanafi)',
    parse(raw) {
      const lowered = raw.toLowerCase();
      if (lowered === '1' || lowered === 'shafi') return 1;
      if (lowered === '2' || lowered === 'hanafi') return 2;
      throw new CliError('invalid_input', `asr_factor is 1 or 2, got "${raw}".`);
    },
  },
  fajr_offset_min: integer(-60, 60),
  dhuhr_offset_min: integer(-60, 60),
  asr_offset_min: integer(-60, 60),
  maghrib_offset_min: integer(-60, 60),
  isha_offset_min: integer(-60, 60),
  pre_prayer_minutes: integer(0, 120),
  prayer_max_snoozes: integer(0, 10),
  prayer_snooze_minutes: integer(1, 120),
  show_prayers_in_calendar: boolean,
  holiday_country: {
    describe: 'two-letter country code like TN, or none',
    parse(raw) {
      if (raw.toLowerCase() === 'none') return null;
      if (!/^[A-Za-z]{2}$/.test(raw)) throw new CliError('invalid_input', 'The holiday country is a two-letter code like TN, or none.');
      return raw.toUpperCase();
    },
  },
  islamic_holidays: boolean,
  hijri_offset_days: integer(-2, 2),
};

/** `prayers_enabled` is not a column a client may update: it goes through an RPC that also makes the ten prayer alarms. */
const PRAYERS_SWITCH = 'prayers_enabled';

export const settingsSet = defineCommand({
  path: ['settings', 'set'],
  summary: 'Change settings: `settings set <field> <value> [<field> <value> ...]`. Only the fields the database lets a client write.',
  positionals: [{ name: 'field value', description: 'One or more field/value pairs; see `settings get` for the field names.', required: true, variadic: true }],
  writes: true,
  needsLogin: true,
  examples: ['alarm-cal settings set grace_minutes 15', 'alarm-cal settings set latitude 36.8625 longitude 10.1956 location_label Ariana', 'alarm-cal settings set prayers_enabled true'],
  async run({ rt, args }) {
    const words = args.positionals;
    if (words.length === 0 || words.length % 2 !== 0) {
      throw new CliError('usage', 'Give field/value pairs, like `settings set grace_minutes 15`.', `Fields: ${[...WRITABLE_SETTINGS_COLUMNS, PRAYERS_SWITCH].join(', ')}.`);
    }
    const patch: Record<string, unknown> = {};
    let prayers: boolean | undefined;
    for (let index = 0; index < words.length; index += 2) {
      const field = words[index] as string;
      const raw = words[index + 1] as string;
      if (field === PRAYERS_SWITCH) {
        prayers = boolean.parse(raw) as boolean;
        continue;
      }
      const spec = SETTING_SPECS[field];
      if (spec === undefined || !(WRITABLE_SETTINGS_COLUMNS as readonly string[]).includes(field)) {
        const readOnly = field === 'pass_cap' || field === 'user_id' || field === 'prayers_enabled_since';
        throw new CliError(
          'invalid_input',
          readOnly ? `${field} cannot be changed by a client.` : `Unknown setting "${field}".`,
          `Writable fields: ${[...WRITABLE_SETTINGS_COLUMNS, PRAYERS_SWITCH].join(', ')}.`
        );
      }
      patch[field] = spec.parse(raw);
    }

    const { store, settings } = await openWorld(rt);
    const current = settings as unknown as Record<string, unknown>;
    const changed = Object.entries(patch).filter(([field, value]) => current[field] !== value);
    const prayersChanged = prayers !== undefined && (current['prayers_enabled'] === true) !== prayers;
    if (changed.length === 0 && !prayersChanged) {
      return { data: { changes: [], ...journalJson(null) }, text: 'No changes: the settings already have those values.' };
    }
    const result = await journalled(rt, store, async (recorder) => {
      const lines: string[] = [];
      if (changed.length > 0) {
        await recorder.updateSettings(settings, Object.fromEntries(changed));
        for (const [field, value] of changed) lines.push(`${field}: ${String(current[field] ?? '(none)')} -> ${String(value ?? '(none)')}`);
      }
      if (prayersChanged && prayers !== undefined) {
        await recorder.setPrayersEnabled(current['prayers_enabled'] === true, prayers);
        lines.push(`prayers_enabled: ${String(current['prayers_enabled'] === true)} -> ${String(prayers)}`);
      }
      return { value: null, changes: lines };
    });
    const warnings = patch['timezone'] !== undefined && changed.some(([field]) => field === 'timezone')
      ? ['Alarms are stored as instants: their local times shift to the new zone. Recheck with `alarm-cal events list`.']
      : [];
    return {
      data: { changes: result.changes, warnings, ...journalJson(result.entry) },
      text: `${result.changes.join('\n')}${warnings.map((warning) => `\nwarning: ${warning}`).join('')}${undoHint(result.entry)}`,
    };
  },
});
