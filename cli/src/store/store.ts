import type {
  CompletionRow,
  EventWriteInput,
  EventRow,
  ExamRow,
  ExamWriteInput,
  ModeActivationRow,
  ModeBehavior,
  ModeRow,
  ModeRuleRow,
  Settings,
} from '@alarm-calendar/core';

/** The columns an alarm update may touch (everything but identity and the database's own columns). */
export type EventPatch = Partial<EventWriteInput> & { active?: boolean };
export type ExamPatch = Partial<ExamWriteInput> & { active?: boolean };

export interface RuleValues {
  behavior: ModeBehavior;
  shift_minutes: number | null;
  duration_min: number | null;
}

export interface WalletView {
  balance: number;
  last_granted_week_start: string;
  timezone: string;
  week_starts_on: number;
  anchored_at: string | null;
}

export interface ManualSwitchRequest {
  /** Null = back to normal. */
  modeId: string | null;
  /** ISO instant; null = now. The database allows at most 7 days back. */
  startsAt: string | null;
  /** ISO instant; null = open-ended. */
  endsAt: string | null;
}

/**
 * Everything the commands need from the database. The real one is SupabaseStore (the signed-in user's rows
 * under RLS, publishable key only); tests use an in-memory twin. Methods return the rows as the database
 * holds them after the write, which is what the undo journal records.
 */
export interface Store {
  readonly userId: string;

  getSettings(): Promise<Settings>;
  updateSettings(patch: Record<string, unknown>): Promise<Settings>;
  setPrayersEnabled(enabled: boolean): Promise<void>;

  listEvents(): Promise<EventRow[]>;
  insertEvents(inputs: EventWriteInput[]): Promise<EventRow[]>;
  updateEvent(id: string, patch: EventPatch): Promise<EventRow>;

  listExams(): Promise<ExamRow[]>;
  insertExam(input: ExamWriteInput): Promise<ExamRow>;
  updateExam(id: string, patch: ExamPatch): Promise<ExamRow>;

  /** Creates the four built-in modes that are missing; safe to repeat. */
  ensureBuiltinModes(): Promise<void>;
  listModes(): Promise<ModeRow[]>;
  listRules(): Promise<ModeRuleRow[]>;
  upsertRule(modeId: string, eventId: string, values: RuleValues): Promise<ModeRuleRow>;
  /** Re-creates a rule with its original id (undo of a delete). */
  insertRuleRow(row: ModeRuleRow): Promise<void>;
  updateRule(id: string, values: RuleValues): Promise<void>;
  deleteRules(ids: string[]): Promise<void>;

  /** Every activation, past and future (a person has a handful). */
  listActivations(): Promise<ModeActivationRow[]>;
  setManualMode(request: ManualSwitchRequest): Promise<void>;
  insertRange(modeId: string, startsAt: string, endsAt: string): Promise<ModeActivationRow>;
  insertActivationRow(row: ModeActivationRow): Promise<void>;
  updateActivation(id: string, patch: { starts_at?: string; ends_at?: string | null }): Promise<void>;
  deleteActivations(ids: string[]): Promise<void>;

  listCheatDays(): Promise<string[]>;
  getWallet(): Promise<WalletView | null>;
  /** Completions whose occurrence is at or after `sinceIso`; `complete` is false when the read was cut short. */
  listCompletions(sinceIso: string): Promise<{ rows: CompletionRow[]; complete: boolean }>;
  /**
   * Writes a 'done' completion (a made-up prayer: `doneAt` is after its window). A completion already there for
   * that occurrence is a conflict, never overwritten: the first write wins, as in the apps.
   */
  insertCompletion(input: { event_id: string; occurrence_at: string; done_at: string }): Promise<CompletionRow>;
  /** Removes one completion by id (undo of insertCompletion). */
  deleteCompletion(id: string): Promise<void>;
}
