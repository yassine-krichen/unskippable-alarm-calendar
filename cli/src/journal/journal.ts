import { z } from 'zod';

import { createFileLock } from '../auth/file-lock';
import type { ConfigPaths } from '../config/paths';
import { ensurePrivateDir, readJsonFile, writeJsonFile } from '../config/private-files';

export type JournalTable = 'events' | 'exams' | 'mode_rules' | 'mode_activations' | 'settings' | 'prayers' | 'completions';

/** One row-level change. `before` / `after` are the rows (or, for settings, the touched columns) around it. */
export interface JournalOp {
  table: JournalTable;
  kind: 'insert' | 'update' | 'delete';
  id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface JournalEntry {
  id: number;
  at: string;
  userId: string;
  command: string;
  summary: string;
  ops: JournalOp[];
  /** The command failed half-way: these are the changes that did land. */
  partial?: boolean;
  undoneAt?: string;
  /** Indexes into `ops` already reverted by an undo that did not finish; a retry skips them. */
  revertedSteps?: number[];
}

const opSchema = z.object({
  table: z.enum(['events', 'exams', 'mode_rules', 'mode_activations', 'settings', 'prayers', 'completions']),
  kind: z.enum(['insert', 'update', 'delete']),
  id: z.string(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
});

const entrySchema = z.object({
  id: z.number().int(),
  at: z.string(),
  userId: z.string(),
  command: z.string(),
  summary: z.string(),
  ops: z.array(opSchema),
  partial: z.boolean().optional(),
  undoneAt: z.string().optional(),
  revertedSteps: z.array(z.number().int()).optional(),
});

const fileSchema = z.object({ version: z.literal(1), nextId: z.number().int(), entries: z.array(entrySchema) });

/** Keeps the journal from growing without bound; an undo older than this is not something anyone wants. */
export const MAX_JOURNAL_ENTRIES = 200;

interface JournalFile {
  version: 1;
  nextId: number;
  entries: JournalEntry[];
}

/**
 * The local undo log: before/after rows of every write, in the config directory. Every change to the file is
 * a read-modify-write under a lock file of its own, so two commands finishing at once cannot lose an entry or
 * hand out the same number twice.
 */
export class Journal {
  private readonly lock: ReturnType<typeof createFileLock>;

  constructor(
    private readonly paths: ConfigPaths,
    private readonly env: Record<string, string | undefined>,
    private readonly platform: NodeJS.Platform
  ) {
    this.lock = createFileLock(paths.journalLock, () => ensurePrivateDir(paths.dir, env, platform));
  }

  private load(): JournalFile {
    const parsed = fileSchema.safeParse(readJsonFile(this.paths.journal));
    return parsed.success ? (parsed.data as JournalFile) : { version: 1, nextId: 1, entries: [] };
  }

  private save(file: JournalFile): void {
    ensurePrivateDir(this.paths.dir, this.env, this.platform);
    writeJsonFile(this.paths.journal, file);
  }

  private modify<T>(change: (file: JournalFile) => T): Promise<T> {
    return this.lock('journal', 10_000, async () => {
      const file = this.load();
      const result = change(file);
      this.save(file);
      return result;
    });
  }

  entries(): JournalEntry[] {
    return this.load().entries;
  }

  append(entry: Omit<JournalEntry, 'id'>): Promise<JournalEntry> {
    return this.modify((file) => {
      const saved: JournalEntry = { id: file.nextId, ...entry };
      file.nextId += 1;
      file.entries.push(saved);
      file.entries = file.entries.slice(-MAX_JOURNAL_ENTRIES);
      return saved;
    });
  }

  markStepReverted(id: number, step: number): Promise<void> {
    return this.modify((file) => {
      const entry = file.entries.find((candidate) => candidate.id === id);
      if (entry !== undefined && !(entry.revertedSteps ?? []).includes(step)) entry.revertedSteps = [...(entry.revertedSteps ?? []), step];
    });
  }

  markUndone(id: number, at: string): Promise<void> {
    return this.modify((file) => {
      const entry = file.entries.find((candidate) => candidate.id === id);
      if (entry !== undefined) entry.undoneAt = at;
    });
  }
}
