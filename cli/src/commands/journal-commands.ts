import { numberOption, booleanOption } from '../args';
import { CliError } from '../errors';
import { findUndoConflicts, undoEntry } from '../journal/undo';
import { renderTable } from '../output/render';

import { defineCommand } from './command';

export const undo = defineCommand({
  path: ['undo'],
  summary: 'Revert the last change (or the last N): restores the previous state. Creating something is undone by switching it off.',
  options: [
    { name: 'steps', type: 'number', value: 'N', description: 'How many changes to revert, newest first. Default 1.' },
    { name: 'force', type: 'boolean', description: 'Revert even if the rows were changed after the recorded change (those later changes are overwritten).' },
  ],
  writes: false,
  needsLogin: true,
  examples: ['alarm-cal undo', 'alarm-cal undo --steps 2'],
  async run({ rt, args }) {
    const steps = numberOption(args, 'steps') ?? 1;
    if (!Number.isInteger(steps) || steps < 1 || steps > 50) throw new CliError('usage', '--steps is a whole number from 1 to 50.');
    const store = await rt.openStore();
    const journal = rt.journal();
    const pending = journal
      .entries()
      .filter((entry) => entry.undoneAt === undefined && entry.userId === store.userId)
      .slice(-steps)
      .reverse();
    if (pending.length === 0) {
      return { data: { reverted: [] }, text: 'Nothing to undo.' };
    }
    // Refuse before writing anything if a row moved on since (the app, another agent, a later command that was not undone).
    if (booleanOption(args, 'force') !== true) {
      const covered = new Set<string>();
      const conflicts: string[] = [];
      for (const entry of pending) {
        // An undo that was interrupted already passed this check.
        if ((entry.revertedSteps ?? []).length > 0) continue;
        const check = await findUndoConflicts(store, entry, covered);
        for (const key of check.keys) covered.add(key);
        conflicts.push(...check.conflicts.map((conflict) => `#${entry.id}: ${conflict}`));
      }
      if (conflicts.length > 0) {
        throw new CliError(
          'conflict',
          `Cannot undo safely, things changed since:\n${conflicts.map((conflict) => `  - ${conflict}`).join('\n')}`,
          'Run `alarm-cal undo --force` to overwrite those later changes, or fix them by hand.',
          { conflicts }
        );
      }
    }
    const reverted: Array<{ id: number; command: string; summary: string; steps: string[] }> = [];
    for (const entry of pending) {
      const done = await undoEntry(store, entry, (step) => journal.markStepReverted(entry.id, step));
      await journal.markUndone(entry.id, rt.now().toISOString());
      reverted.push({ id: entry.id, command: entry.command, summary: entry.summary, steps: done });
    }
    const text = reverted.map((item) => `Reverted #${item.id}: ${item.summary}\n  (${item.command})`).join('\n');
    return { data: { reverted }, text };
  },
});

export const history = defineCommand({
  path: ['history'],
  summary: 'The local undo journal: what was changed, newest first. Works offline.',
  options: [
    { name: 'limit', type: 'number', value: 'N', description: 'How many entries. Default 20.' },
    { name: 'ops', type: 'boolean', description: 'Include the before/after rows (JSON only).' },
  ],
  writes: false,
  needsLogin: false,
  async run({ rt, args, json }) {
    const limit = numberOption(args, 'limit') ?? 20;
    const withOps = booleanOption(args, 'ops') === true;
    const entries = rt.journal().entries().slice(-limit).reverse();
    const view = entries.map((entry) => ({
      id: entry.id,
      at: entry.at,
      command: entry.command,
      summary: entry.summary,
      changes: entry.ops.length,
      partial: entry.partial === true,
      undone_at: entry.undoneAt ?? null,
      ...(withOps && json ? { ops: entry.ops } : {}),
    }));
    const text =
      view.length === 0
        ? 'No changes recorded yet.'
        : renderTable(['#', 'when (UTC)', 'state', 'summary'], view.map((entry) => [String(entry.id), entry.at.slice(0, 16).replace('T', ' '), entry.undone_at === null ? (entry.partial ? 'partial' : '') : 'undone', entry.summary.length > 90 ? `${entry.summary.slice(0, 87)}...` : entry.summary]));
    return { data: { count: view.length, entries: view }, text };
  },
});
