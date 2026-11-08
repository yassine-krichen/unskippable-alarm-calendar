import { eventKindOf, nextOccurrence, type EventRow, type ExamRow, type Settings } from '@alarm-calendar/core';

import { stringOption, type ParsedArgs } from '../args';
import { CliError } from '../errors';
import { describeEventRow, type FriendlyEvent } from '../events/event-spec';
import type { JournalEntry } from '../journal/journal';
import { Recorder } from '../journal/recorder';
import { viewInstant, type InstantView } from '../output/time-format';
import type { Runtime } from '../runtime';
import type { Store } from '../store/store';

export interface World {
  store: Store;
  settings: Settings;
  tz: string;
  now: Date;
}

/** Opens the signed-in user's data and reads the settings, whose timezone every time shown depends on. */
export async function openWorld(rt: Runtime): Promise<World> {
  const store = await rt.openStore();
  const settings = await store.getSettings();
  return { store, settings, tz: settings.timezone, now: rt.now() };
}

const UUID_PREFIX = /^[0-9a-f]{8}(-[0-9a-f]{4}){0,3}(-[0-9a-f]{0,12})?$/i;

/** Finds one row by exact id, agent key, or an unambiguous id prefix of at least 8 characters. */
export function findByRef<T extends { id: string; agent_key?: string | null }>(rows: readonly T[], ref: string, what: string): T {
  const exact = rows.filter((row) => row.id === ref || row.agent_key === ref);
  if (exact.length === 1) return exact[0] as T;
  if (exact.length > 1) throw new CliError('ambiguous', `"${ref}" matches more than one ${what}.`);
  if (ref.length >= 8 && UUID_PREFIX.test(ref)) {
    const byPrefix = rows.filter((row) => row.id.startsWith(ref.toLowerCase()));
    if (byPrefix.length === 1) return byPrefix[0] as T;
    if (byPrefix.length > 1) throw new CliError('ambiguous', `The id prefix "${ref}" matches ${byPrefix.length} ${what}s; give more characters.`);
  }
  throw new CliError('not_found', `No ${what} with id or agent key "${ref}".`, `List them with \`alarm-cal ${what === 'exam' ? 'exams' : 'events'} list --all\`.`);
}

/** `--key-prefix`: an empty one would match every alarm, which is never what was meant. */
export function keyPrefixOption(args: ParsedArgs): string | undefined {
  const prefix = stringOption(args, 'key-prefix');
  if (prefix !== undefined && prefix.trim() === '') {
    throw new CliError('invalid_input', '--key-prefix must not be empty: it would match every alarm.', 'Give a prefix like workout/.');
  }
  return prefix;
}

export function findEventRef(events: readonly EventRow[], ref: string): EventRow {
  return findByRef(events, ref, 'alarm');
}

export function findExamRef(exams: readonly ExamRow[], ref: string): ExamRow {
  return findByRef(exams, ref, 'exam');
}

/** Prayer rows are managed from the settings and never listed or edited here. */
export function isUserAlarm(event: EventRow): boolean {
  return eventKindOf(event) === 'normal';
}

export interface EventView {
  id: string;
  agent_key: string | null;
  active: boolean;
  /** The alarm in plan vocabulary: this object can be pasted into a plan item. */
  spec: FriendlyEvent;
  start: InstantView;
  ends: InstantView | null;
  next_ring: InstantView | null;
  exam_id: string | null;
  exam_role: string | null;
  group_id: string | null;
  created_at: string | undefined;
  updated_at: string;
}

export function eventView(event: EventRow, tz: string, now: Date): EventView {
  let next: InstantView | null = null;
  if (event.active && isUserAlarm(event)) {
    try {
      const at = nextOccurrence(event, now, tz);
      next = at === null ? null : viewInstant(at.toISOString(), tz);
    } catch {
      next = null;
    }
  }
  return {
    id: event.id,
    agent_key: event.agent_key ?? null,
    active: event.active,
    spec: describeEventRow(event, tz),
    start: viewInstant(event.start_at, tz),
    ends: event.ends_at === null ? null : viewInstant(event.ends_at, tz),
    next_ring: next,
    exam_id: event.exam_id ?? null,
    exam_role: event.exam_role ?? null,
    group_id: event.group_id ?? null,
    created_at: event.created_at,
    updated_at: event.updated_at,
  };
}

export function repeatText(spec: FriendlyEvent): string {
  const repeat = typeof spec.repeat === 'string' ? spec.repeat : `every ${spec.repeat.every} ${spec.repeat.unit}${spec.repeat.every === 1 ? '' : 's'}`;
  return spec.days === null ? repeat : `${repeat} ${spec.days.join(',')}`;
}

export interface WriteOutcome<T> {
  value: T;
  /** One line per change, shown to the person and returned as `changes`. */
  changes: string[];
}

export interface JournalledResult<T> {
  value: T;
  changes: string[];
  entry: JournalEntry | null;
}

/**
 * Runs a write command with an undo journal. All writes go through the recorder; when the command finishes
 * its changes become one journal entry that `alarm-cal undo` reverts. If it fails part-way, what did land is
 * journalled as a partial entry and the error says so.
 */
export async function journalled<T>(
  rt: Runtime,
  store: Store,
  fn: (recorder: Recorder) => Promise<WriteOutcome<T>>
): Promise<JournalledResult<T>> {
  const recorder = new Recorder(store);
  let outcome: WriteOutcome<T>;
  try {
    outcome = await fn(recorder);
  } catch (error) {
    if (recorder.ops.length > 0) {
      const entry = await rt.journal().append({
        at: rt.now().toISOString(),
        userId: store.userId,
        command: rt.commandLine,
        summary: 'failed part-way; the changes that were applied',
        ops: recorder.ops,
        partial: true,
      });
      const note = `${recorder.ops.length} change(s) were applied before the failure (journal #${entry.id}); \`alarm-cal undo\` reverts them.`;
      if (error instanceof CliError) throw new CliError(error.code, error.message, [error.hint, note].filter(Boolean).join(' '), error.details);
    }
    throw error;
  }
  if (recorder.ops.length === 0) return { value: outcome.value, changes: outcome.changes, entry: null };
  const entry = await rt.journal().append({
    at: rt.now().toISOString(),
    userId: store.userId,
    command: rt.commandLine,
    summary: outcome.changes.length > 0 ? outcome.changes.join('; ') : `${recorder.ops.length} change(s)`,
    ops: recorder.ops,
  });
  return { value: outcome.value, changes: outcome.changes, entry };
}

export function undoHint(entry: JournalEntry | null): string {
  return entry === null ? '' : `\nUndo with: alarm-cal undo   (journal #${entry.id})`;
}

export function journalJson(entry: JournalEntry | null): Record<string, unknown> {
  return entry === null ? { journal: null } : { journal: { id: entry.id, undo: 'alarm-cal undo' } };
}
