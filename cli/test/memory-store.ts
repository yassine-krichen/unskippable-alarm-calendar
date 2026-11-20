import { randomUUID } from 'node:crypto';

import { WRITABLE_SETTINGS_COLUMNS } from '@alarm-calendar/core';
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

import { CliError } from '../src/errors';
import type { EventPatch, ExamPatch, ManualSwitchRequest, RuleValues, Store, WalletView } from '../src/store/store';

const KEY = /^[a-z0-9][a-z0-9/_.-]{0,99}$/;

/** An in-memory twin of the database rules the CLI depends on: unique agent keys, one rule per (mode, alarm), the manual-switch RPC. */
export class MemoryStore implements Store {
  readonly userId = '00000000-0000-0000-0000-0000000000aa';
  events: EventRow[] = [];
  exams: ExamRow[] = [];
  modes: ModeRow[] = [];
  rules: ModeRuleRow[] = [];
  activations: ModeActivationRow[] = [];
  cheatDays: string[] = [];
  completions: CompletionRow[] = [];
  wallet: WalletView | null = { balance: 1, last_granted_week_start: '2026-11-02', timezone: 'Africa/Tunis', week_starts_on: 0, anchored_at: '2026-10-01T00:00:00Z' };
  settings: Settings & Record<string, unknown>;
  prayersCalls: boolean[] = [];
  writes = 0;

  constructor(
    private readonly clock: () => Date,
    timezone = 'Africa/Tunis'
  ) {
    this.settings = {
      user_id: this.userId,
      timezone,
      week_starts_on: 0,
      refire_seconds: 120,
      pass_cap: 2,
      grace_minutes: 30,
      exam_mode_days_before: 10,
      prayers_enabled: false,
      holiday_country: null,
      islamic_holidays: false,
      hijri_offset_days: 0,
    };
  }

  private stamp(): string {
    return this.clock().toISOString();
  }

  async getSettings(): Promise<Settings> {
    return structuredClone(this.settings);
  }

  async updateSettings(patch: Record<string, unknown>): Promise<Settings> {
    this.writes += 1;
    const allowed = new Set<string>(WRITABLE_SETTINGS_COLUMNS);
    for (const column of Object.keys(patch)) {
      if (!allowed.has(column)) throw new CliError('permission_denied', `column ${column} is not writable`);
    }
    Object.assign(this.settings, patch);
    return structuredClone(this.settings);
  }

  async setPrayersEnabled(enabled: boolean): Promise<void> {
    this.writes += 1;
    this.prayersCalls.push(enabled);
    this.settings['prayers_enabled'] = enabled;
  }

  async listEvents(): Promise<EventRow[]> {
    return structuredClone(this.events);
  }

  private checkKey(key: string | null | undefined, exceptId?: string, rows: ReadonlyArray<{ id: string; agent_key?: string | null }> = this.events): void {
    if (key === null || key === undefined) return;
    if (!KEY.test(key)) throw new CliError('invalid_input', `agent_key format: ${key}`);
    if (rows.some((row) => row.agent_key === key && row.id !== exceptId)) throw new CliError('conflict', 'That agent key is already used by another row.');
  }

  async insertEvents(inputs: EventWriteInput[]): Promise<EventRow[]> {
    this.writes += 1;
    const created: EventRow[] = [];
    for (const input of inputs) {
      if (input.title.trim() === '') throw new CliError('invalid_input', 'title');
      this.checkKey(input.agent_key, undefined, [...this.events, ...created]);
      created.push({
        kind: 'normal',
        prayer: null,
        exam_id: null,
        exam_role: null,
        catch_up_of: null,
        group_id: null,
        agent_key: null,
        ...input,
        id: randomUUID(),
        user_id: this.userId,
        active: true,
        created_at: this.stamp(),
        updated_at: this.stamp(),
      } as EventRow);
    }
    this.events.push(...created);
    return structuredClone(created);
  }

  async updateEvent(id: string, patch: EventPatch): Promise<EventRow> {
    this.writes += 1;
    const row = this.events.find((event) => event.id === id);
    if (row === undefined) throw new CliError('not_found', `No alarm with id ${id}.`);
    if (patch.agent_key !== undefined) this.checkKey(patch.agent_key, id);
    Object.assign(row, patch, { updated_at: this.stamp() });
    return structuredClone(row);
  }

  async listExams(): Promise<ExamRow[]> {
    return structuredClone(this.exams);
  }

  async insertExam(input: ExamWriteInput): Promise<ExamRow> {
    this.writes += 1;
    this.checkKey(input.agent_key, undefined, this.exams);
    const row: ExamRow = { agent_key: null, ...input, id: randomUUID(), user_id: this.userId, active: true, created_at: this.stamp(), updated_at: this.stamp() };
    this.exams.push(row);
    return structuredClone(row);
  }

  async updateExam(id: string, patch: ExamPatch): Promise<ExamRow> {
    this.writes += 1;
    const row = this.exams.find((exam) => exam.id === id);
    if (row === undefined) throw new CliError('not_found', `No exam with id ${id}.`);
    if (patch.agent_key !== undefined) this.checkKey(patch.agent_key, id, this.exams);
    Object.assign(row, patch, { updated_at: this.stamp() });
    return structuredClone(row);
  }

  async ensureBuiltinModes(): Promise<void> {
    const wanted: Array<[ModeRow['builtin_key'], string, 'keep' | 'skip']> = [
      ['exam', 'Exam', 'keep'],
      ['ramadan', 'Ramadan', 'keep'],
      ['vacation', 'Vacation', 'skip'],
      ['sick', 'Sick', 'skip'],
    ];
    for (const [key, name, behavior] of wanted) {
      if (this.modes.some((mode) => mode.builtin_key === key)) continue;
      this.modes.push({ id: randomUUID(), user_id: this.userId, name, kind: 'builtin', builtin_key: key, default_behavior: behavior, active: true, created_at: this.stamp(), updated_at: this.stamp() });
    }
  }

  async listModes(): Promise<ModeRow[]> {
    return structuredClone(this.modes);
  }

  async listRules(): Promise<ModeRuleRow[]> {
    return structuredClone(this.rules);
  }

  async upsertRule(modeId: string, eventId: string, values: RuleValues): Promise<ModeRuleRow> {
    this.writes += 1;
    if (!this.modes.some((mode) => mode.id === modeId)) throw new CliError('permission_denied', 'mode');
    if (!this.events.some((event) => event.id === eventId)) throw new CliError('permission_denied', 'event');
    const existing = this.rules.find((rule) => rule.mode_id === modeId && rule.event_id === eventId);
    if (existing !== undefined) {
      Object.assign(existing, values, { updated_at: this.stamp() });
      return structuredClone(existing);
    }
    const row: ModeRuleRow = { id: randomUUID(), user_id: this.userId, mode_id: modeId, event_id: eventId, ...values, updated_at: this.stamp() };
    this.rules.push(row);
    return structuredClone(row);
  }

  async insertRuleRow(row: ModeRuleRow): Promise<void> {
    this.writes += 1;
    if (this.rules.some((rule) => rule.mode_id === row.mode_id && rule.event_id === row.event_id)) throw new CliError('conflict', 'duplicate rule');
    this.rules.push({ ...row });
  }

  async updateRule(id: string, values: RuleValues): Promise<void> {
    this.writes += 1;
    const rule = this.rules.find((candidate) => candidate.id === id);
    if (rule !== undefined) Object.assign(rule, values, { updated_at: this.stamp() });
  }

  async deleteRules(ids: string[]): Promise<void> {
    this.writes += 1;
    this.rules = this.rules.filter((rule) => !ids.includes(rule.id));
  }

  async listActivations(): Promise<ModeActivationRow[]> {
    return structuredClone(this.activations);
  }

  /** The set_manual_mode RPC, including its start-time window and supersession rules. */
  async setManualMode(request: ManualSwitchRequest): Promise<void> {
    this.writes += 1;
    const now = this.clock().getTime();
    const start = request.startsAt === null ? now : Date.parse(request.startsAt);
    if (start > now || start < now - 7 * 86_400_000) throw new CliError('invalid_input', 'invalid_start');
    if (request.modeId !== null) {
      if (request.endsAt !== null && Date.parse(request.endsAt) <= start) throw new CliError('invalid_input', 'invalid_end');
      if (!this.modes.some((mode) => mode.id === request.modeId && mode.active)) throw new CliError('invalid_input', 'mode_not_found');
    }
    this.activations = this.activations.filter((row) => !(row.source === 'manual' && Date.parse(row.starts_at) >= start));
    for (const row of this.activations) {
      if (row.source === 'manual' && Date.parse(row.starts_at) < start && (row.ends_at === null || Date.parse(row.ends_at) > start)) {
        row.ends_at = new Date(start).toISOString();
        row.updated_at = this.stamp();
      }
    }
    if (request.modeId !== null) {
      this.activations.push({ id: randomUUID(), user_id: this.userId, mode_id: request.modeId, starts_at: new Date(start).toISOString(), ends_at: request.endsAt, source: 'manual', updated_at: this.stamp() });
    }
  }

  async insertRange(modeId: string, startsAt: string, endsAt: string): Promise<ModeActivationRow> {
    this.writes += 1;
    const row: ModeActivationRow = { id: randomUUID(), user_id: this.userId, mode_id: modeId, starts_at: startsAt, ends_at: endsAt, source: 'range', updated_at: this.stamp() };
    this.activations.push(row);
    return structuredClone(row);
  }

  async insertActivationRow(row: ModeActivationRow): Promise<void> {
    this.writes += 1;
    if (this.activations.some((candidate) => candidate.id === row.id)) throw new CliError('conflict', 'duplicate activation');
    this.activations.push({ ...row });
  }

  async updateActivation(id: string, patch: { starts_at?: string; ends_at?: string | null }): Promise<void> {
    this.writes += 1;
    const row = this.activations.find((candidate) => candidate.id === id);
    if (row !== undefined) Object.assign(row, patch, { updated_at: this.stamp() });
  }

  async deleteActivations(ids: string[]): Promise<void> {
    this.writes += 1;
    this.activations = this.activations.filter((row) => !ids.includes(row.id));
  }

  async listCheatDays(): Promise<string[]> {
    return [...this.cheatDays];
  }

  async getWallet(): Promise<WalletView | null> {
    return this.wallet;
  }

  async listCompletions(sinceIso: string): Promise<{ rows: CompletionRow[]; complete: boolean }> {
    return { rows: this.completions.filter((row) => Date.parse(row.occurrence_at) >= Date.parse(sinceIso)), complete: true };
  }

  async insertCompletion(input: { event_id: string; occurrence_at: string; done_at: string }): Promise<CompletionRow> {
    this.writes += 1;
    if (!this.events.some((event) => event.id === input.event_id)) throw new CliError('invalid_input', 'event');
    if (this.completions.some((row) => row.event_id === input.event_id && Date.parse(row.occurrence_at) === Date.parse(input.occurrence_at))) {
      throw new CliError('conflict', 'Duplicate value: completions_event_id_occurrence_at_key');
    }
    const row: CompletionRow = { id: randomUUID(), user_id: this.userId, status: 'done', snoozes_used: 0, ...input };
    this.completions.push(row);
    return structuredClone(row);
  }

  async deleteCompletion(id: string): Promise<void> {
    this.writes += 1;
    this.completions = this.completions.filter((row) => row.id !== id);
  }
}
