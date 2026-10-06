import type { ModeRow } from '@alarm-calendar/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fake } from '@/test/fake-supabase';

vi.mock('@/lib/supabase', async () => {
  const { fakeClient } = await import('@/test/fake-supabase');
  return { supabase: fakeClient };
});

import { handleModeActivationChange, handleModeChange, handleModeRuleChange } from '@/features/realtime/realtime-handlers';

import { BUILTIN_MODES, SICK_ID, activationRow, modeRow, ruleRow } from './mode-fixtures';
import { MAX_ACTIVATION_PAGES, MODES_PAGE_LIMIT } from './modes-api';
import { addMode, addRange, loadModes, removeActivation, resetModes, switchMode, useModesStore, writeRuleChanges } from './modes-store';

function respond(modes: ModeRow[], rules: unknown[] = [], activations: unknown[] = []): void {
  fake.responses['select:modes'] = { data: modes, error: null };
  fake.responses['select:mode_rules'] = { data: rules, error: null };
  fake.responses['select:mode_activations'] = { data: activations, error: null };
}

beforeEach(() => {
  fake.reset();
  resetModes();
});

describe('loadModes', () => {
  it('fills the three lists and does not create built-ins that all exist', async () => {
    respond(BUILTIN_MODES, [ruleRow(SICK_ID, 'e1')], [activationRow(SICK_ID, '2026-03-01T00:00:00.000Z', null)]);
    expect((await loadModes()).error).toBeNull();
    const state = useModesStore.getState();
    expect(state).toMatchObject({ status: 'ready', error: null });
    expect([state.modes.length, state.rules.length, state.activations.length]).toEqual([4, 1, 1]);
    expect(fake.names()).not.toContain('rpc:ensure_builtin_modes');
  });

  it('creates the missing built-ins once, then reads the modes again', async () => {
    const queue = [
      Promise.resolve({ data: [modeRow('c1', null)], error: null }),
      Promise.resolve({ data: [...BUILTIN_MODES, modeRow('c1', null)], error: null }),
    ];
    fake.queued['select:modes'] = queue;
    fake.responses['select:mode_rules'] = { data: [], error: null };
    fake.responses['select:mode_activations'] = { data: [], error: null };
    await loadModes();
    expect(fake.names().filter((name) => name === 'rpc:ensure_builtin_modes')).toHaveLength(1);
    expect(useModesStore.getState().modes).toHaveLength(5);
  });

  it('still loads when creating the built-ins fails (the custom modes and the activations keep working)', async () => {
    respond([modeRow('c1', null)]);
    fake.responses['rpc:ensure_builtin_modes'] = { data: null, error: { message: 'nope' } };
    const result = await loadModes();
    expect(result.error).toBeNull();
    expect(useModesStore.getState()).toMatchObject({ status: 'ready' });
    expect(useModesStore.getState().modes).toHaveLength(1);
  });

  it('a failed first load is an error with nothing in the lists; a failed refetch keeps what is there', async () => {
    fake.responses['select:modes'] = { data: null, error: { message: 'boom' } };
    fake.responses['select:mode_rules'] = { data: [], error: null };
    fake.responses['select:mode_activations'] = { data: [], error: null };
    expect((await loadModes()).error).toBe('boom');
    expect(useModesStore.getState()).toMatchObject({ status: 'error', error: 'boom', modes: [] });

    respond(BUILTIN_MODES);
    await loadModes();
    fake.responses['select:mode_rules'] = { data: null, error: { message: 'offline' } };
    await loadModes();
    expect(useModesStore.getState()).toMatchObject({ status: 'ready' });
    expect(useModesStore.getState().modes).toHaveLength(4);
  });

  it('treats a full page of modes or rules as a failed read rather than silently dropping rows', async () => {
    respond(BUILTIN_MODES, Array.from({ length: MODES_PAGE_LIMIT }, (_, i) => ruleRow(SICK_ID, `e${i}`)));
    expect((await loadModes()).error).toMatch(/Too many rows/);
    expect(useModesStore.getState().status).toBe('error');
  });

  it('reads activations in pages: a full first page is followed by a second, and both end up in the store', async () => {
    const full = Array.from({ length: MODES_PAGE_LIMIT }, (_, i) => activationRow(SICK_ID, `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00.000Z`, `2026-01-02T00:00:00.000Z`));
    respond(BUILTIN_MODES);
    fake.queued['select:mode_activations'] = [
      Promise.resolve({ data: full, error: null }),
      Promise.resolve({ data: [activationRow(SICK_ID, '2026-03-01T00:00:00.000Z', null)], error: null }),
    ];
    expect((await loadModes()).error).toBeNull();
    expect(useModesStore.getState().activations).toHaveLength(MODES_PAGE_LIMIT + 1);
    expect(fake.ranges).toEqual([[0, MODES_PAGE_LIMIT - 1], [MODES_PAGE_LIMIT, 2 * MODES_PAGE_LIMIT - 1]]);
  });

  it('gives up honestly when the activations do not fit in the page budget', async () => {
    const full = Array.from({ length: MODES_PAGE_LIMIT }, () => activationRow(SICK_ID, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'));
    respond(BUILTIN_MODES, [], full);
    expect((await loadModes()).error).toMatch(/Too many mode activations/);
    expect(fake.ranges).toHaveLength(MAX_ACTIVATION_PAGES);
    expect(useModesStore.getState().status).toBe('error');
  });

  it('asks only for open-ended activations and those that ended within the longest habit window plus a day', async () => {
    respond(BUILTIN_MODES);
    await loadModes();
    const or = fake.filters.find((f) => f.op === 'or');
    const match = /^ends_at\.is\.null,ends_at\.gt\.(.+)$/.exec(String(or?.args[0]));
    expect(match).not.toBeNull();
    const ageDays = (Date.now() - Date.parse(match![1]!)) / 86_400_000;
    expect(ageDays).toBeGreaterThan(180.99);
    expect(ageDays).toBeLessThan(181.01);
  });

  it('an older answer that arrives after a newer one cannot overwrite it', async () => {
    let releaseOld!: (value: { data: unknown; error: null }) => void;
    const old = new Promise<{ data: unknown; error: null }>((resolve) => (releaseOld = resolve));
    fake.queued['select:modes'] = [old, Promise.resolve({ data: BUILTIN_MODES, error: null })];
    fake.responses['select:mode_rules'] = { data: [], error: null };
    fake.responses['select:mode_activations'] = { data: [], error: null };
    const first = loadModes();
    const second = loadModes();
    await second;
    releaseOld({ data: [modeRow('stale', null)], error: null });
    await first;
    expect(useModesStore.getState().modes).toHaveLength(4);
  });
});

describe('realtime changes', () => {
  const payload = (eventType: 'INSERT' | 'UPDATE' | 'DELETE', row: Record<string, unknown>) => ({
    eventType,
    new: eventType === 'DELETE' ? {} : row,
    old: eventType === 'DELETE' ? { id: row.id } : {},
  });

  it('applies a mode, a rule and an activation from another device, and ignores an older echo', () => {
    useModesStore.setState({ modes: BUILTIN_MODES, rules: [], activations: [], status: 'ready', error: null });
    handleModeChange(payload('UPDATE', { ...modeRow(SICK_ID, 'sick'), default_behavior: 'keep', updated_at: '2026-03-02T00:00:00.000Z' }));
    expect(useModesStore.getState().modes.find((m) => m.id === SICK_ID)?.default_behavior).toBe('keep');
    handleModeChange(payload('UPDATE', { ...modeRow(SICK_ID, 'sick'), default_behavior: 'skip', updated_at: '2026-03-01T12:00:00.000Z' }));
    expect(useModesStore.getState().modes.find((m) => m.id === SICK_ID)?.default_behavior).toBe('keep');

    const rule = ruleRow(SICK_ID, 'e1', { behavior: 'shift', shift_minutes: 30 });
    handleModeRuleChange(payload('INSERT', { ...rule }));
    expect(useModesStore.getState().rules).toHaveLength(1);
    handleModeRuleChange(payload('DELETE', { id: rule.id }));
    expect(useModesStore.getState().rules).toHaveLength(0);

    const activation = activationRow(SICK_ID, '2026-03-02T08:00:00.000Z', null);
    handleModeActivationChange(payload('INSERT', { ...activation }));
    expect(useModesStore.getState().activations).toEqual([activation]);
    // Ending it (the switch back) arrives as an update to the same row.
    handleModeActivationChange(payload('UPDATE', { ...activation, ends_at: '2026-03-02T09:00:00.000Z', updated_at: '2026-03-02T09:00:00.000Z' }));
    expect(useModesStore.getState().activations[0]?.ends_at).toBe('2026-03-02T09:00:00.000Z');
  });

  it('ignores a payload that is not a row of that table', () => {
    useModesStore.setState({ modes: BUILTIN_MODES, rules: [], activations: [], status: 'ready', error: null });
    handleModeChange(payload('INSERT', { id: 'x' }));
    handleModeRuleChange(payload('INSERT', { id: 'x' }));
    handleModeActivationChange(payload('INSERT', { id: 'x' }));
    expect(useModesStore.getState().modes).toHaveLength(4);
    expect(useModesStore.getState().rules).toHaveLength(0);
    expect(useModesStore.getState().activations).toHaveLength(0);
  });

  it('a change that arrives while a load is in flight is replayed over its result', async () => {
    let releaseActivations!: (value: { data: unknown; error: null }) => void;
    fake.queued['select:mode_activations'] = [new Promise((resolve) => (releaseActivations = resolve))];
    fake.responses['select:modes'] = { data: BUILTIN_MODES, error: null };
    fake.responses['select:mode_rules'] = { data: [], error: null };
    const loading = loadModes();
    // Another device switches Sick on while the answer (which does not have it yet) is on its way.
    const activation = activationRow(SICK_ID, '2026-03-02T08:00:00.000Z', null);
    handleModeActivationChange(payload('INSERT', { ...activation }));
    releaseActivations({ data: [], error: null });
    await loading;
    expect(useModesStore.getState().activations).toEqual([activation]);
  });
});

describe('writes', () => {
  beforeEach(() => respond(BUILTIN_MODES));

  it('the header switch calls set_manual_mode with the parameters, then reloads the lists', async () => {
    const result = await switchMode({ modeId: SICK_ID, startsAt: '2026-10-06T23:00:00.000Z', endsAt: null });
    expect(result.error).toBeNull();
    expect(fake.payloadOf('rpc:set_manual_mode')).toEqual({ p_mode_id: SICK_ID, p_starts_at: '2026-10-06T23:00:00.000Z', p_ends_at: null });
    // The reload after the switch is what makes the chip, the calendar and the schedule change.
    expect(fake.names().slice(0, 1)).toEqual(['rpc:set_manual_mode']);
    expect(fake.names()).toContain('select:mode_activations');
  });

  it('switching back to normal sends a null mode', async () => {
    await switchMode({ modeId: null, startsAt: null, endsAt: null });
    expect(fake.payloadOf('rpc:set_manual_mode')).toEqual({ p_mode_id: null, p_starts_at: null, p_ends_at: null });
  });

  it('a failed switch reports the error code and does not reload', async () => {
    fake.responses['rpc:set_manual_mode'] = { data: null, error: { message: 'mode_not_found' } };
    expect((await switchMode({ modeId: SICK_ID, startsAt: null, endsAt: null })).error).toBe('mode_not_found');
    expect(fake.names()).toEqual(['rpc:set_manual_mode']);
  });

  it('creates a custom mode with only a name and a default (never a kind or a key)', async () => {
    fake.responses['insert:modes'] = { data: modeRow('c1', null), error: null };
    const result = await addMode('Hackathon', 'skip');
    expect(result.data?.id).toBe('c1');
    expect(fake.payloadOf('insert:modes')).toEqual({ name: 'Hackathon', default_behavior: 'skip' });
  });

  it('writes rules as one upsert on (mode_id, event_id) and deletes by id', async () => {
    const upserts = [{ mode_id: SICK_ID, event_id: 'e1', behavior: 'shift' as const, shift_minutes: 30, duration_min: null }];
    await writeRuleChanges(upserts, ['r1', 'r2']);
    expect(fake.payloadOf('upsert:mode_rules')).toEqual(upserts);
    expect(fake.upsertOptions[0]).toEqual({ onConflict: 'mode_id,event_id' });
    expect(fake.names()).toContain('delete:mode_rules');
    expect(fake.filters.find((f) => f.op === 'in')?.args).toEqual(['id', ['r1', 'r2']]);
  });

  it('writes nothing when there is nothing to write, and stops at a failed upsert', async () => {
    await writeRuleChanges([], []);
    expect(fake.names().filter((name) => name.startsWith('upsert') || name.startsWith('delete'))).toEqual([]);
    fake.reset();
    fake.responses['upsert:mode_rules'] = { data: null, error: { message: 'rls' } };
    const result = await writeRuleChanges([{ mode_id: SICK_ID, event_id: 'e1', behavior: 'skip', shift_minutes: null, duration_min: null }], ['r1']);
    expect(result.error).toBe('rls');
    expect(fake.names()).not.toContain('delete:mode_rules');
  });

  it('adds a planned range as a range activation and removes one by id', async () => {
    fake.responses['insert:mode_activations'] = { data: activationRow(SICK_ID, '2026-10-10T00:00:00.000Z', '2026-10-12T00:00:00.000Z', 'range'), error: null };
    await addRange(SICK_ID, '2026-10-10T00:00:00.000Z', '2026-10-12T00:00:00.000Z');
    expect(fake.payloadOf('insert:mode_activations')).toEqual({
      mode_id: SICK_ID,
      starts_at: '2026-10-10T00:00:00.000Z',
      ends_at: '2026-10-12T00:00:00.000Z',
      source: 'range',
    });
    await removeActivation('a1');
    expect(fake.names()).toContain('delete:mode_activations');
  });
});
