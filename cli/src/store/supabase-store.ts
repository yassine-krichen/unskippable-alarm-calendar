import type {
  CompletionRow,
  EventRow,
  EventWriteInput,
  ExamRow,
  ExamWriteInput,
  ModeActivationRow,
  ModeRow,
  ModeRuleRow,
  Settings,
} from '@alarm-calendar/core';
import { SETTINGS_COLUMNS, WRITABLE_SETTINGS_COLUMNS } from '@alarm-calendar/core';
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';

import { CliError } from '../errors';

import type { EventPatch, ExamPatch, ManualSwitchRequest, RuleValues, Store, WalletView } from './store';

const EVENT_COLUMNS =
  'id, user_id, title, notes, start_at, duration_min, repeat_unit, repeat_interval, repeat_weekdays, ends_at, max_snoozes, snooze_minutes, passable, color, active, created_at, updated_at, kind, prayer, exam_id, exam_role, catch_up_of, show_in_calendar, group_id, agent_key';
const EXAM_COLUMNS = 'id, user_id, title, exam_at, difficulty, notes, active, created_at, updated_at, agent_key';
const MODE_COLUMNS = 'id, user_id, name, kind, builtin_key, default_behavior, active, created_at, updated_at';
const RULE_COLUMNS = 'id, user_id, mode_id, event_id, behavior, shift_minutes, duration_min, updated_at';
const ACTIVATION_COLUMNS = 'id, user_id, mode_id, starts_at, ends_at, source, updated_at';
const COMPLETION_COLUMNS = 'id, user_id, event_id, occurrence_at, status, snoozes_used, done_at';

const PAGE_SIZE = 1000;
const MAX_PAGES = 20;

const RPC_MESSAGES: Record<string, string> = {
  mode_not_found: 'That mode no longer exists or is switched off.',
  invalid_start: 'The start cannot be in the future or more than 7 days ago.',
  invalid_end: 'The end has to be after the start.',
  not_authenticated: 'The session expired. Run `alarm-cal login` again.',
};

/** The one place a PostgREST/Postgres error becomes a CliError with a code an agent can branch on. */
export function toCliError(error: Pick<PostgrestError, 'message' | 'code'>): CliError {
  const { message, code } = error;
  if ((code === '42703' || code === 'PGRST204' || code === 'PGRST200') && /agent_key/.test(message)) {
    return new CliError(
      'migration_missing',
      'The database does not have the agent_key column yet.',
      'The owner has to push the agent_keys migration (supabase db push); the tool cannot do that.'
    );
  }
  if (code === '23505') {
    const isKey = /agent_key/.test(message);
    return new CliError('conflict', isKey ? 'That agent key is already used by another row.' : `Duplicate value: ${message}`);
  }
  if (code === '42501') return new CliError('permission_denied', 'The database refused that change (row-level security).', message);
  if (code === '23514') return new CliError('invalid_input', `The database rejected a value: ${message}`);
  if (code === '23503') return new CliError('invalid_input', `The row refers to something that does not exist: ${message}`);
  if (code === 'P0001') return new CliError('invalid_input', RPC_MESSAGES[message.trim()] ?? message);
  if (/fetch failed|network|ENOTFOUND|ECONN|timeout/i.test(message)) {
    return new CliError('network', 'Could not reach the server.', 'Check the connection and try again.');
  }
  return new CliError('server', message);
}

function check(error: PostgrestError | null): void {
  if (error) throw toCliError(error);
}

type PageResult<T> = PromiseLike<{ data: T[] | null; error: PostgrestError | null }>;

export class SupabaseStore implements Store {
  constructor(
    private readonly client: SupabaseClient,
    readonly userId: string
  ) {}

  private async pages<T>(read: (from: number, to: number) => PageResult<T>): Promise<{ rows: T[]; complete: boolean }> {
    const rows: T[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data, error } = await read(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
      check(error);
      const batch = data ?? [];
      rows.push(...batch);
      if (batch.length < PAGE_SIZE) return { rows, complete: true };
    }
    return { rows, complete: false };
  }

  private async all<T>(read: (from: number, to: number) => PageResult<T>, what: string): Promise<T[]> {
    const { rows, complete } = await this.pages(read);
    if (!complete) throw new CliError('server', `Too many ${what} to read safely.`);
    return rows;
  }

  async getSettings(): Promise<Settings> {
    const { data, error } = await this.client.from('settings').select(SETTINGS_COLUMNS).maybeSingle<Settings>();
    check(error);
    if (data === null) {
      throw new CliError('not_found', 'Your settings row does not exist yet.', 'Open the app once; it creates it on first sign-in.');
    }
    return data;
  }

  async updateSettings(patch: Record<string, unknown>): Promise<Settings> {
    // Plain UPDATE, never upsert: an upsert's ON CONFLICT touches columns clients have no privilege on.
    const allowed = new Set<string>(WRITABLE_SETTINGS_COLUMNS);
    const picked = Object.fromEntries(Object.entries(patch).filter(([column]) => allowed.has(column)));
    const { data, error } = await this.client
      .from('settings')
      .update(picked)
      .eq('user_id', this.userId)
      .select(SETTINGS_COLUMNS)
      .maybeSingle<Settings>();
    check(error);
    if (data === null) throw new CliError('not_found', 'Your settings row does not exist yet.');
    return data;
  }

  async setPrayersEnabled(enabled: boolean): Promise<void> {
    const { error } = await this.client.rpc('set_prayers_enabled', { p_enabled: enabled });
    check(error);
  }

  listEvents(): Promise<EventRow[]> {
    return this.all<EventRow>(
      (from, to) =>
        this.client
          .from('events')
          .select(EVENT_COLUMNS)
          .order('start_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to)
          .overrideTypes<EventRow[], { merge: false }>(),
      'alarms'
    );
  }

  async insertEvents(inputs: EventWriteInput[]): Promise<EventRow[]> {
    if (inputs.length === 0) return [];
    const { data, error } = await this.client
      .from('events')
      .insert(inputs)
      .select(EVENT_COLUMNS)
      .overrideTypes<EventRow[], { merge: false }>();
    check(error);
    return data ?? [];
  }

  async updateEvent(id: string, patch: EventPatch): Promise<EventRow> {
    const { data, error } = await this.client.from('events').update(patch).eq('id', id).select(EVENT_COLUMNS).maybeSingle<EventRow>();
    check(error);
    if (data === null) throw new CliError('not_found', `No alarm with id ${id}.`);
    return data;
  }

  listExams(): Promise<ExamRow[]> {
    return this.all<ExamRow>(
      (from, to) =>
        this.client
          .from('exams')
          .select(EXAM_COLUMNS)
          .order('exam_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to)
          .overrideTypes<ExamRow[], { merge: false }>(),
      'exams'
    );
  }

  async insertExam(input: ExamWriteInput): Promise<ExamRow> {
    const { data, error } = await this.client.from('exams').insert(input).select(EXAM_COLUMNS).single<ExamRow>();
    check(error);
    if (data === null) throw new CliError('server', 'The exam was not returned after saving.');
    return data;
  }

  async updateExam(id: string, patch: ExamPatch): Promise<ExamRow> {
    const { data, error } = await this.client.from('exams').update(patch).eq('id', id).select(EXAM_COLUMNS).maybeSingle<ExamRow>();
    check(error);
    if (data === null) throw new CliError('not_found', `No exam with id ${id}.`);
    return data;
  }

  async ensureBuiltinModes(): Promise<void> {
    const { error } = await this.client.rpc('ensure_builtin_modes');
    check(error);
  }

  listModes(): Promise<ModeRow[]> {
    return this.all<ModeRow>(
      (from, to) =>
        this.client
          .from('modes')
          .select(MODE_COLUMNS)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to)
          .overrideTypes<ModeRow[], { merge: false }>(),
      'modes'
    );
  }

  listRules(): Promise<ModeRuleRow[]> {
    return this.all<ModeRuleRow>(
      (from, to) =>
        this.client
          .from('mode_rules')
          .select(RULE_COLUMNS)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to)
          .overrideTypes<ModeRuleRow[], { merge: false }>(),
      'mode rules'
    );
  }

  async upsertRule(modeId: string, eventId: string, values: RuleValues): Promise<ModeRuleRow> {
    const { data, error } = await this.client
      .from('mode_rules')
      .upsert({ mode_id: modeId, event_id: eventId, ...values }, { onConflict: 'mode_id,event_id' })
      .select(RULE_COLUMNS)
      .single<ModeRuleRow>();
    check(error);
    if (data === null) throw new CliError('server', 'The rule was not returned after saving.');
    return data;
  }

  async insertRuleRow(row: ModeRuleRow): Promise<void> {
    const { error } = await this.client.from('mode_rules').insert({
      id: row.id,
      mode_id: row.mode_id,
      event_id: row.event_id,
      behavior: row.behavior,
      shift_minutes: row.shift_minutes,
      duration_min: row.duration_min,
    });
    check(error);
  }

  async updateRule(id: string, values: RuleValues): Promise<void> {
    const { error } = await this.client.from('mode_rules').update(values).eq('id', id);
    check(error);
  }

  async deleteRules(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const { error } = await this.client.from('mode_rules').delete().in('id', ids);
    check(error);
  }

  listActivations(): Promise<ModeActivationRow[]> {
    return this.all<ModeActivationRow>(
      (from, to) =>
        this.client
          .from('mode_activations')
          .select(ACTIVATION_COLUMNS)
          .order('starts_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to)
          .overrideTypes<ModeActivationRow[], { merge: false }>(),
      'mode activations'
    );
  }

  async setManualMode(request: ManualSwitchRequest): Promise<void> {
    const { error } = await this.client.rpc('set_manual_mode', {
      p_mode_id: request.modeId,
      p_starts_at: request.startsAt,
      p_ends_at: request.endsAt,
    });
    check(error);
  }

  async insertRange(modeId: string, startsAt: string, endsAt: string): Promise<ModeActivationRow> {
    const { data, error } = await this.client
      .from('mode_activations')
      .insert({ mode_id: modeId, starts_at: startsAt, ends_at: endsAt, source: 'range' })
      .select(ACTIVATION_COLUMNS)
      .single<ModeActivationRow>();
    check(error);
    if (data === null) throw new CliError('server', 'The range was not returned after saving.');
    return data;
  }

  async insertActivationRow(row: ModeActivationRow): Promise<void> {
    const { error } = await this.client.from('mode_activations').insert({
      id: row.id,
      mode_id: row.mode_id,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      source: row.source,
    });
    check(error);
  }

  async updateActivation(id: string, patch: { starts_at?: string; ends_at?: string | null }): Promise<void> {
    const { error } = await this.client.from('mode_activations').update(patch).eq('id', id);
    check(error);
  }

  async deleteActivations(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const { error } = await this.client.from('mode_activations').delete().in('id', ids);
    check(error);
  }

  async listCheatDays(): Promise<string[]> {
    const rows = await this.all<{ day: string }>(
      (from, to) =>
        this.client
          .from('cheat_days')
          .select('day')
          .order('day', { ascending: true })
          .range(from, to)
          .overrideTypes<Array<{ day: string }>, { merge: false }>(),
      'cheat days'
    );
    return rows.map((row) => row.day);
  }

  async getWallet(): Promise<WalletView | null> {
    const { data, error } = await this.client
      .from('pass_wallet')
      .select('balance, last_granted_week_start, timezone, week_starts_on, anchored_at')
      .maybeSingle<WalletView>();
    check(error);
    return data;
  }

  listCompletions(sinceIso: string): Promise<{ rows: CompletionRow[]; complete: boolean }> {
    return this.pages<CompletionRow>((from, to) =>
      this.client
        .from('completions')
        .select(COMPLETION_COLUMNS)
        .gte('occurrence_at', sinceIso)
        .order('occurrence_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to)
        .overrideTypes<CompletionRow[], { merge: false }>()
    );
  }
}
