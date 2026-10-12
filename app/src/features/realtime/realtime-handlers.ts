import type {
  CompletionRow,
  EventRow,
  ExamRow,
  HolidaySettings,
  ModeActivationRow,
  ModeRow,
  ModeRuleRow,
  PrayerSettings,
  Settings,
} from '@alarm-calendar/core';

import { removeCompletion, upsertCompletion } from '@/features/completions/completions-store';
import { recordRealtimeEventChange, useEventsStore } from '@/features/events/events-store';
import {
  recordRealtimeExamChange,
  removeExamCompletion,
  upsertExamCompletion,
  useExamsStore,
} from '@/features/exams/exams-store';
import { removeHabitCompletion, upsertHabitCompletion } from '@/features/habits/habits-store';
import { removeRealtimeRow, upsertRealtimeRow } from '@/features/modes/modes-store';
import type { HabitCompletionRow } from '@/features/habits/habits-api';
import { loadCheatDays } from '@/features/passes/passes-store';
import { useSettingsStore } from '@/features/settings/settings-store';

/** The part of a Supabase postgres_changes payload the handlers read. */
export interface ChangePayload {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: Record<string, unknown>;
  old: Record<string, unknown>;
}

function hasString(row: Record<string, unknown>, key: string): boolean {
  return typeof row[key] === 'string';
}

function isEventRow(row: Record<string, unknown>): boolean {
  return hasString(row, 'id') && hasString(row, 'title') && hasString(row, 'start_at') && hasString(row, 'updated_at');
}

/**
 * events: a soft-deleted row (active = false) leaves the list, like the initial load. An older
 * echo of a row we already hold a newer version of (for example our own write) is ignored.
 */
export function handleEventChange(payload: ChangePayload): void {
  if (payload.eventType === 'DELETE') {
    const id = payload.old.id;
    if (typeof id === 'string') {
      recordRealtimeEventChange(id, null);
      useEventsStore.setState((state) => ({ events: state.events.filter((event) => event.id !== id) }));
    }
    return;
  }
  if (!isEventRow(payload.new)) return;
  const row = payload.new as unknown as EventRow;
  recordRealtimeEventChange(row.id, row);
  useEventsStore.setState((state) => {
    if (!row.active) return { events: state.events.filter((event) => event.id !== row.id) };
    const existing = state.events.find((event) => event.id === row.id);
    if (existing === undefined) return { events: [...state.events, row] };
    if (Date.parse(existing.updated_at) > Date.parse(row.updated_at)) return state;
    return { events: state.events.map((event) => (event.id === row.id ? row : event)) };
  });
}

function isExamRow(row: Record<string, unknown>): boolean {
  return hasString(row, 'id') && hasString(row, 'title') && hasString(row, 'exam_at') && hasString(row, 'updated_at');
}

/** exams: like events, a soft-deleted exam (active = false) leaves the list, and an older echo is ignored. */
export function handleExamChange(payload: ChangePayload): void {
  if (payload.eventType === 'DELETE') {
    const id = payload.old.id;
    if (typeof id === 'string') {
      recordRealtimeExamChange(id, null);
      useExamsStore.setState((state) => ({ exams: state.exams.filter((exam) => exam.id !== id) }));
    }
    return;
  }
  if (!isExamRow(payload.new)) return;
  const row = payload.new as unknown as ExamRow;
  recordRealtimeExamChange(row.id, row);
  useExamsStore.setState((state) => {
    if (!row.active) return { exams: state.exams.filter((exam) => exam.id !== row.id) };
    const existing = state.exams.find((exam) => exam.id === row.id);
    if (existing === undefined) return { exams: [...state.exams, row] };
    if (Date.parse(existing.updated_at) > Date.parse(row.updated_at)) return state;
    return { exams: state.exams.map((exam) => (exam.id === row.id ? row : exam)) };
  });
}

/**
 * modes, mode_rules and mode_activations: a row is applied by id, an older echo of a row already held is
 * ignored, and a DELETE (which carries only the primary key under RLS) removes by id. Nothing is soft-deleted
 * here: a custom mode that is "deleted" is an update to active = false, which stays in the list (the rules
 * ignore an inactive mode).
 */
function handleModeTableChange<T extends { id: string }>(
  collection: 'modes' | 'rules' | 'activations',
  isRow: (row: Record<string, unknown>) => boolean,
  payload: ChangePayload
): void {
  if (payload.eventType === 'DELETE') {
    const id = payload.old.id;
    if (typeof id === 'string') removeRealtimeRow(collection, id);
    return;
  }
  if (!isRow(payload.new)) return;
  upsertRealtimeRow(collection, payload.new as unknown as T);
}

export function handleModeChange(payload: ChangePayload): void {
  handleModeTableChange<ModeRow>(
    'modes',
    (row) => hasString(row, 'id') && hasString(row, 'name') && hasString(row, 'default_behavior') && hasString(row, 'updated_at'),
    payload
  );
}

export function handleModeRuleChange(payload: ChangePayload): void {
  handleModeTableChange<ModeRuleRow>(
    'rules',
    (row) => hasString(row, 'id') && hasString(row, 'mode_id') && hasString(row, 'event_id') && hasString(row, 'behavior'),
    payload
  );
}

export function handleModeActivationChange(payload: ChangePayload): void {
  handleModeTableChange<ModeActivationRow>(
    'activations',
    (row) => hasString(row, 'id') && hasString(row, 'mode_id') && hasString(row, 'starts_at') && hasString(row, 'source'),
    payload
  );
}

const PRAYER_NUMBER_KEYS = [
  'latitude',
  'longitude',
  'fajr_angle',
  'isha_angle',
  'asr_factor',
  'fajr_offset_min',
  'dhuhr_offset_min',
  'asr_offset_min',
  'maghrib_offset_min',
  'isha_offset_min',
  'pre_prayer_minutes',
  'prayer_max_snoozes',
  'prayer_snooze_minutes',
] as const;

/** The prayer columns a payload carries, with the right types; a column that is absent is left out. */
function prayerFieldsOf(row: Record<string, unknown>): Partial<PrayerSettings> {
  const fields: Record<string, unknown> = {};
  if (typeof row.prayers_enabled === 'boolean') fields.prayers_enabled = row.prayers_enabled;
  if (typeof row.show_prayers_in_calendar === 'boolean') fields.show_prayers_in_calendar = row.show_prayers_in_calendar;
  if (row.prayers_enabled_since === null || typeof row.prayers_enabled_since === 'string') {
    if ('prayers_enabled_since' in row) fields.prayers_enabled_since = row.prayers_enabled_since;
  }
  if (typeof row.location_label === 'string') fields.location_label = row.location_label;
  for (const key of PRAYER_NUMBER_KEYS) {
    if (key in row && row[key] !== null) fields[key] = Number(row[key]);
  }
  return fields as Partial<PrayerSettings>;
}

/** The holiday columns a payload carries, with the right types; a column that is absent is left out. */
function holidayFieldsOf(row: Record<string, unknown>): Partial<HolidaySettings> {
  const fields: Partial<HolidaySettings> = {};
  if (row.holiday_country === null || typeof row.holiday_country === 'string') {
    if ('holiday_country' in row) fields.holiday_country = row.holiday_country;
  }
  if (typeof row.islamic_holidays === 'boolean') fields.islamic_holidays = row.islamic_holidays;
  if (row.hijri_offset_days !== undefined && row.hijri_offset_days !== null) {
    fields.hijri_offset_days = Number(row.hijri_offset_days);
  }
  return fields;
}

/** settings: one row per user, so any insert or update is the new truth. */
export function handleSettingsChange(payload: ChangePayload): void {
  if (payload.eventType === 'DELETE') return;
  const row = payload.new;
  if (!hasString(row, 'user_id') || !hasString(row, 'timezone')) return;
  const next: Settings = {
    user_id: row.user_id as string,
    timezone: row.timezone as string,
    week_starts_on: Number(row.week_starts_on),
    refire_seconds: Number(row.refire_seconds),
    pass_cap: Number(row.pass_cap),
    grace_minutes: Number(row.grace_minutes),
    ...(row.exam_mode_days_before === undefined || row.exam_mode_days_before === null
      ? {}
      : { exam_mode_days_before: Number(row.exam_mode_days_before) }),
    ...prayerFieldsOf(row),
    ...holidayFieldsOf(row),
  };
  useSettingsStore.getState().setSettings(next);
}

/**
 * cheat_days: always refetch. A DELETE payload carries only the primary key under RLS (see
 * docs/decisions.md), so the day cannot be read from it, and a refetch is one small query.
 */
export function handleCheatDayChange(): void {
  void loadCheatDays();
}

/**
 * completions: keep the recent list current so a done occurrence is known to the alarm engine,
 * and the 28-day list the Stats screen scores, so a Done on any device moves the ranks live.
 */
export function handleCompletionChange(payload: ChangePayload): void {
  if (payload.eventType === 'DELETE') {
    const id = payload.old.id;
    if (typeof id === 'string') {
      removeCompletion(id);
      removeHabitCompletion(id);
      removeExamCompletion(id);
    }
    return;
  }
  const row = payload.new;
  if (!hasString(row, 'id') || !hasString(row, 'event_id') || !hasString(row, 'occurrence_at')) return;
  upsertCompletion(row as unknown as CompletionRow);
  upsertHabitCompletion(row as unknown as HabitCompletionRow);
  upsertExamCompletion(row as unknown as CompletionRow);
}
