import type { ModeActivationRow, ModeRow, ModeRuleRow } from '@alarm-calendar/core';
import { create } from 'zustand';

import { createLatestRequestGuard } from '@/lib/latest-request';
import { fail, ok, type Result } from '@/lib/result';

import {
  createMode,
  createRangeActivation,
  deleteActivation,
  deleteModeRules,
  ensureBuiltinModes,
  fetchModeActivations,
  fetchModeRules,
  fetchModes,
  setManualMode,
  updateMode,
  upsertModeRules,
  type ManualSwitchInput,
  type ModePatch,
  type RuleWriteInput,
} from './modes-api';

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** The four built-ins every person has; `loadModes` creates whichever is missing. */
export const BUILTIN_KEYS = ['exam', 'ramadan', 'vacation', 'sick'] as const;

interface ModesState {
  modes: ModeRow[];
  rules: ModeRuleRow[];
  activations: ModeActivationRow[];
  status: LoadStatus;
  error: string | null;
}

const INITIAL: ModesState = { modes: [], rules: [], activations: [], status: 'idle', error: null };

export const useModesStore = create<ModesState>(() => INITIAL);

type Row = { id: string; updated_at?: string };
type Collection = 'modes' | 'rules' | 'activations';

const guard = createLatestRequestGuard();

/** The state a signed-out store returns to. */
export function resetModes(): void {
  guard.invalidate();
  useModesStore.setState(INITIAL);
  for (const key of Object.keys(inFlightChanges) as Collection[]) inFlightChanges[key].clear();
  loadsInFlight = 0;
}

// Realtime changes that arrive while a load is in flight are replayed over its result, so an answer the
// server produced before the change cannot take the change away again (same scheme as events and exams).
const inFlightChanges: Record<Collection, Map<string, Row | null>> = {
  modes: new Map(),
  rules: new Map(),
  activations: new Map(),
};
let loadsInFlight = 0;

/** Called by the realtime handlers; `row` is null when the row is gone. */
export function recordRealtimeModeChange(collection: Collection, id: string, row: Row | null): void {
  if (loadsInFlight > 0) inFlightChanges[collection].set(id, row);
}

function replay<T extends Row>(collection: Collection, fetched: T[]): T[] {
  const byId = new Map(fetched.map((row) => [row.id, row]));
  for (const [id, change] of inFlightChanges[collection]) {
    const current = byId.get(id);
    if (change === null) byId.delete(id);
    else if (current === undefined || Date.parse(change.updated_at ?? '') >= Date.parse(current.updated_at ?? '')) {
      byId.set(id, change as T);
    }
  }
  return [...byId.values()];
}

function missingBuiltins(modes: readonly ModeRow[]): boolean {
  return BUILTIN_KEYS.some((key) => !modes.some((mode) => mode.builtin_key === key));
}

/**
 * Loads the modes, their rules and activations. A built-in that does not exist yet is created (once, by the
 * ensure_builtin_modes RPC) and the modes read again; failing to create them is not an error of the load (the
 * custom modes and the activations still work).
 */
export async function loadModes(): Promise<Result<null>> {
  if (useModesStore.getState().status !== 'ready') useModesStore.setState({ status: 'loading' });
  const isLatest = guard.begin();
  loadsInFlight += 1;
  let [modes, rules, activations] = await Promise.all([fetchModes(), fetchModeRules(), fetchModeActivations()]);
  if (modes.data !== null && missingBuiltins(modes.data)) {
    const ensured = await ensureBuiltinModes();
    if (ensured.error !== null) console.warn('Could not create the built-in modes:', ensured.error);
    else modes = await fetchModes();
  }
  loadsInFlight -= 1;
  const latest = isLatest();
  const failure = modes.error ?? rules.error ?? activations.error;
  const next =
    latest && modes.data !== null && rules.data !== null && activations.data !== null
      ? {
          modes: replay('modes', modes.data),
          rules: replay('rules', rules.data),
          activations: replay('activations', activations.data),
        }
      : null;
  if (loadsInFlight === 0) for (const key of Object.keys(inFlightChanges) as Collection[]) inFlightChanges[key].clear();
  if (!latest) return failure === null ? ok(null) : fail(failure);
  if (next !== null) {
    useModesStore.setState({ ...next, status: 'ready', error: null });
    return ok(null);
  }
  // A failed refetch keeps what is there; only a first load that failed shows an error.
  if (useModesStore.getState().status !== 'ready') useModesStore.setState({ status: 'error', error: failure });
  return fail(failure ?? 'Unknown error');
}

/** Applies a realtime row (insert or update) to the store; an older echo of a row already held is ignored. */
export function upsertRealtimeRow<T extends Row>(collection: Collection, row: T): void {
  recordRealtimeModeChange(collection, row.id, row);
  useModesStore.setState((state) => {
    const rows = state[collection] as unknown as T[];
    const existing = rows.find((candidate) => candidate.id === row.id);
    if (existing === undefined) return { [collection]: [...rows, row] } as Partial<ModesState>;
    if (Date.parse(existing.updated_at ?? '') > Date.parse(row.updated_at ?? '')) return state;
    return { [collection]: rows.map((candidate) => (candidate.id === row.id ? row : candidate)) } as Partial<ModesState>;
  });
}

export function removeRealtimeRow(collection: Collection, id: string): void {
  recordRealtimeModeChange(collection, id, null);
  useModesStore.setState((state) => ({
    [collection]: (state[collection] as Row[]).filter((row) => row.id !== id),
  }) as Partial<ModesState>);
}

// Every write below reloads the (small) lists afterwards: the answer of a load that started after the write
// has the write in it, and a load that started before it is made stale by the newer ticket.
async function afterWrite<T>(written: Result<T>): Promise<Result<T>> {
  if (written.error !== null) return written;
  const reloaded = await loadModes();
  // The write itself worked; the person sees the result as soon as the next load lands.
  if (reloaded.error !== null) console.warn('Saved, but could not refresh the modes:', reloaded.error);
  return written;
}

/**
 * The header switch. Reloads afterwards, so the chip, the calendar and the alarm schedule (which follows the
 * store) change together.
 */
export async function switchMode(input: ManualSwitchInput): Promise<Result<null>> {
  return afterWrite(await setManualMode(input));
}

export async function addMode(name: string, defaultBehavior: 'keep' | 'skip'): Promise<Result<ModeRow>> {
  return afterWrite(await createMode(name, defaultBehavior));
}

export async function patchMode(id: string, patch: ModePatch): Promise<Result<ModeRow>> {
  return afterWrite(await updateMode(id, patch));
}

export async function writeRuleChanges(upserts: readonly RuleWriteInput[], deletes: readonly string[]): Promise<Result<null>> {
  // Deleting first would leave a gap if the upsert then failed; the order is irrelevant to the result.
  const upserted = await upsertModeRules(upserts);
  if (upserted.error !== null) return afterWrite(upserted);
  return afterWrite(await deleteModeRules(deletes));
}

export async function addRange(modeId: string, startsAt: string, endsAt: string): Promise<Result<ModeActivationRow>> {
  return afterWrite(await createRangeActivation(modeId, startsAt, endsAt));
}

export async function removeActivation(id: string): Promise<Result<null>> {
  return afterWrite(await deleteActivation(id));
}
