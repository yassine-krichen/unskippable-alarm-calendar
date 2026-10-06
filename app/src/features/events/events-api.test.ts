import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fake } from '@/test/fake-supabase';

vi.mock('@/lib/supabase', async () => {
  const { fakeClient } = await import('@/test/fake-supabase');
  return { supabase: fakeClient };
});

import { createEvents, deactivateEvent, deactivateEvents, fetchActiveEvents, resetGroupIdColumnProbe, updateEvent, useGroupIdSupport } from './events-api';
import type { EventWriteInput } from './event-form';

beforeEach(() => {
  fake.reset();
  resetGroupIdColumnProbe();
});

describe('deactivateEvent', () => {
  it('soft-deletes by setting active to false', async () => {
    fake.responses['update:events'] = { data: [{ id: 'e1' }], error: null };

    const result = await deactivateEvent('e1');

    expect(result.error).toBeNull();
    expect(fake.payloadOf('update:events')).toEqual({ active: false });
  });

  it('reports an error when no row was updated, instead of a silent success', async () => {
    fake.responses['update:events'] = { data: [], error: null };
    const result = await deactivateEvent('gone');
    expect(result.error).toMatch(/no longer exists/i);
  });

  it('passes a database error through', async () => {
    fake.responses['update:events'] = { data: null, error: { message: 'rls' } };
    expect((await deactivateEvent('e1')).error).toBe('rls');
  });
});

describe('deactivateEvents', () => {
  it('soft-deletes several alarms with one update', async () => {
    fake.responses['update:events'] = { data: [{ id: 'a' }, { id: 'b' }], error: null };

    const result = await deactivateEvents(['a', 'b']);

    expect(result.error).toBeNull();
    expect(fake.names()).toEqual(['update:events']);
    expect(fake.filters).toEqual([{ op: 'in', args: ['id', ['a', 'b']] }]);
  });
});

const INPUT: EventWriteInput = {
  title: 'Wish Sam a happy birthday',
  notes: null,
  start_at: '2027-01-03T09:00:00.000Z',
  duration_min: 15,
  repeat_unit: 'year',
  repeat_interval: 1,
  repeat_weekdays: null,
  ends_at: null,
  max_snoozes: 3,
  snooze_minutes: 5,
  passable: true,
  color: null,
  group_id: '22222222-2222-4222-8222-222222222222',
};

describe('createEvents', () => {
  it('inserts all the alarms of a template in one statement', async () => {
    fake.responses['insert:events'] = { data: [{ id: 'a' }, { id: 'b' }], error: null };

    const result = await createEvents([INPUT, { ...INPUT, title: 'Prep' }]);

    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(2);
    expect(fake.names()).toEqual(['insert:events']);
    expect(fake.payloadOf('insert:events')).toHaveLength(2);
  });

  it('passes a database error through', async () => {
    fake.responses['insert:events'] = { data: null, error: { message: 'invalid input value for enum repeat_unit: "year"' } };
    expect((await createEvents([INPUT])).error).toMatch(/repeat_unit/);
  });
});

describe('reading before the group_id migration is pushed', () => {
  const missingColumn = {
    data: null,
    error: { code: '42703', message: 'column events.group_id does not exist' },
  };

  it('reads group_id when the column exists', async () => {
    fake.responses['select:events'] = { data: [], error: null };
    await fetchActiveEvents();
    expect(fake.calls[0]?.payload).toMatch(/group_id/);
  });

  it('retries without group_id when the column is missing, and keeps leaving it out afterwards', async () => {
    fake.queued['select:events'] = [Promise.resolve(missingColumn)];
    fake.responses['select:events'] = { data: [{ id: 'e1' }], error: null };

    const result = await fetchActiveEvents();

    expect(result.error).toBeNull();
    expect(result.data).toEqual([{ id: 'e1' }]);
    const columns = fake.calls.map((call) => String(call.payload));
    expect(columns).toHaveLength(2);
    expect(columns[0]).toMatch(/group_id/);
    expect(columns[1]).not.toMatch(/group_id/);

    fake.calls = [];
    await fetchActiveEvents();
    expect(String(fake.calls[0]?.payload)).not.toMatch(/group_id/);
  });

  it('also retries the read-back of a write, so a plain alarm still saves', async () => {
    fake.queued['update:events'] = [Promise.resolve(missingColumn)];
    fake.responses['update:events'] = { data: { id: 'e1' }, error: null };

    const result = await updateEvent('e1', INPUT);

    expect(result.error).toBeNull();
    expect(fake.names()).toEqual(['update:events', 'update:events']);
  });

  it('recognises the PostgREST code for an unknown column in a write', async () => {
    fake.queued['insert:events'] = [
      Promise.resolve({
        data: null,
        error: { code: 'PGRST204', message: "Could not find the 'group_id' column of 'events' in the schema cache" },
      }),
    ];
    fake.responses['insert:events'] = { data: [], error: null };

    await createEvents([INPUT]);

    expect(fake.names()).toEqual(['insert:events', 'insert:events']);
    expect(useGroupIdSupport.getState().missing).toBe(true);
  });

  it('surfaces another error that merely mentions group_id instead of masking it', async () => {
    fake.responses['select:events'] = {
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint on group_id' },
    };

    const result = await fetchActiveEvents();

    expect(result.error).toMatch(/duplicate key/);
    expect(fake.calls).toHaveLength(1);
    expect(useGroupIdSupport.getState().missing).toBe(false);
  });

  it('does not treat a missing-column code for some other column as the group_id case', async () => {
    fake.responses['select:events'] = { data: null, error: { code: '42703', message: 'column events.color does not exist' } };
    const result = await fetchActiveEvents();
    expect(result.error).toMatch(/color/);
    expect(fake.calls).toHaveLength(1);
  });

  it('reports the column as missing so the UI can hide the birthday template', async () => {
    expect(useGroupIdSupport.getState().missing).toBe(false);
    fake.queued['select:events'] = [Promise.resolve(missingColumn)];
    fake.responses['select:events'] = { data: [], error: null };
    await fetchActiveEvents();
    expect(useGroupIdSupport.getState().missing).toBe(true);
  });

  it('does not hide other errors behind a retry', async () => {
    fake.responses['select:events'] = { data: null, error: { message: 'network down' } };
    const result = await fetchActiveEvents();
    expect(result.error).toBe('network down');
    expect(fake.calls).toHaveLength(1);
  });
});
