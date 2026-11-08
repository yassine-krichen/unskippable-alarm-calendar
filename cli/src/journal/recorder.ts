import type {
  EventRow,
  EventWriteInput,
  ExamRow,
  ExamWriteInput,
  ModeActivationRow,
  ModeRuleRow,
  Settings,
} from '@alarm-calendar/core';

import type { EventPatch, ExamPatch, ManualSwitchRequest, RuleValues, Store } from '../store/store';

import type { JournalOp } from './journal';

const asRecord = (row: object): Record<string, unknown> => ({ ...row });

function pick(row: Record<string, unknown>, columns: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(columns.filter((column) => column in row).map((column) => [column, row[column]]));
}

/**
 * Every write goes through here. Each call performs the database write and notes the rows before and after it,
 * straight away, so a command that fails half-way still has an accurate list of what did land (the journal
 * entry for it is marked partial and `alarm-cal undo` can revert it).
 */
export class Recorder {
  readonly ops: JournalOp[] = [];

  constructor(private readonly store: Store) {}

  async createEvents(inputs: EventWriteInput[]): Promise<EventRow[]> {
    const rows = await this.store.insertEvents(inputs);
    for (const row of rows) this.ops.push({ table: 'events', kind: 'insert', id: row.id, before: null, after: asRecord(row) });
    return rows;
  }

  async updateEvent(before: EventRow, patch: EventPatch): Promise<EventRow> {
    const after = await this.store.updateEvent(before.id, patch);
    this.ops.push({ table: 'events', kind: 'update', id: before.id, before: asRecord(before), after: asRecord(after) });
    return after;
  }

  async createExam(input: ExamWriteInput): Promise<ExamRow> {
    const row = await this.store.insertExam(input);
    this.ops.push({ table: 'exams', kind: 'insert', id: row.id, before: null, after: asRecord(row) });
    return row;
  }

  async updateExam(before: ExamRow, patch: ExamPatch): Promise<ExamRow> {
    const after = await this.store.updateExam(before.id, patch);
    this.ops.push({ table: 'exams', kind: 'update', id: before.id, before: asRecord(before), after: asRecord(after) });
    return after;
  }

  /** Creates the rule, or replaces the one of the same (mode, alarm) that `existing` is. */
  async setRule(existing: ModeRuleRow | undefined, modeId: string, eventId: string, values: RuleValues): Promise<ModeRuleRow> {
    const after = await this.store.upsertRule(modeId, eventId, values);
    this.ops.push({
      table: 'mode_rules',
      kind: existing === undefined ? 'insert' : 'update',
      id: after.id,
      before: existing === undefined ? null : asRecord(existing),
      after: asRecord(after),
    });
    return after;
  }

  async deleteRule(existing: ModeRuleRow): Promise<void> {
    await this.store.deleteRules([existing.id]);
    this.ops.push({ table: 'mode_rules', kind: 'delete', id: existing.id, before: asRecord(existing), after: null });
  }

  async updateSettings(before: Settings, patch: Record<string, unknown>): Promise<Settings> {
    const after = await this.store.updateSettings(patch);
    const columns = Object.keys(patch);
    this.ops.push({
      table: 'settings',
      kind: 'update',
      id: before.user_id,
      before: pick(asRecord(before), columns),
      after: pick(asRecord(after), columns),
    });
    return after;
  }

  async setPrayersEnabled(before: boolean, enabled: boolean): Promise<void> {
    await this.store.setPrayersEnabled(enabled);
    this.ops.push({ table: 'prayers', kind: 'update', id: 'prayers', before: { enabled: before }, after: { enabled } });
  }

  /**
   * The header switch (the set_manual_mode RPC). It may end, remove and add activations in one go, so the rows
   * are listed before and after and the difference is what gets recorded.
   */
  async switchMode(request: ManualSwitchRequest): Promise<void> {
    const before = await this.store.listActivations();
    await this.store.setManualMode(request);
    const after = await this.store.listActivations();
    const beforeById = new Map(before.map((row) => [row.id, row]));
    const afterById = new Map(after.map((row) => [row.id, row]));
    for (const row of before) {
      if (!afterById.has(row.id)) this.ops.push({ table: 'mode_activations', kind: 'delete', id: row.id, before: asRecord(row), after: null });
    }
    for (const row of after) {
      const old = beforeById.get(row.id);
      if (old === undefined) {
        this.ops.push({ table: 'mode_activations', kind: 'insert', id: row.id, before: null, after: asRecord(row) });
      } else if (old.starts_at !== row.starts_at || old.ends_at !== row.ends_at) {
        this.ops.push({ table: 'mode_activations', kind: 'update', id: row.id, before: asRecord(old), after: asRecord(row) });
      }
    }
  }

  async addRange(modeId: string, startsAt: string, endsAt: string): Promise<ModeActivationRow> {
    const row = await this.store.insertRange(modeId, startsAt, endsAt);
    this.ops.push({ table: 'mode_activations', kind: 'insert', id: row.id, before: null, after: asRecord(row) });
    return row;
  }

  async removeActivation(existing: ModeActivationRow): Promise<void> {
    await this.store.deleteActivations([existing.id]);
    this.ops.push({ table: 'mode_activations', kind: 'delete', id: existing.id, before: asRecord(existing), after: null });
  }
}
