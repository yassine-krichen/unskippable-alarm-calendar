// A recording stand-in for the supabase-js client, shared by the tests that mock '@/lib/supabase'.
// It records each table operation and RPC by name ('select:settings', 'update:settings',
// 'insert:settings', 'upsert:settings', 'rpc:sync_wallet') in call order, and answers from `responses`.

export interface FakeResponse {
  data: unknown;
  error: { message: string; code?: string } | null;
}

export interface RecordedCall {
  name: string;
  payload?: unknown;
}

export const fake = {
  calls: [] as RecordedCall[],
  /** Options of each upsert (onConflict, ignoreDuplicates) in call order, for tests that check what a write asked for. */
  upsertOptions: [] as unknown[],
  /** Range filters (gte, lt, in) in call order, for tests that check what a query asked for. */
  filters: [] as Array<{ op: string; args: unknown[] }>,
  responses: {} as Record<string, FakeResponse>,
  /**
   * Responses a test resolves by hand, consumed first-in-first-out per name before `responses`,
   * to make answers arrive out of order.
   */
  queued: {} as Record<string, Array<Promise<FakeResponse>>>,
  reset(): void {
    this.calls = [];
    this.filters = [];
    this.upsertOptions = [];
    this.responses = {};
    this.queued = {};
  },
  names(): string[] {
    return this.calls.map((call) => call.name);
  },
  payloadOf(name: string): unknown {
    return this.calls.find((call) => call.name === name)?.payload;
  },
};

function answer(name: string): Promise<FakeResponse> {
  const queued = fake.queued[name]?.shift();
  if (queued !== undefined) return queued;
  return Promise.resolve(fake.responses[name] ?? { data: null, error: null });
}

function builder(table: string) {
  let operation = 'select';
  const record = (name: string, payload?: unknown): void => {
    fake.calls.push({ name, payload });
  };
  const resolve = () => answer(`${operation}:${table}`);
  const chain = {
    select(columns?: string) {
      // `.update(...).select(...)` reads back the written row; it is not a separate select.
      if (operation === 'select') record(`select:${table}`, columns);
      return chain;
    },
    update(payload: unknown) {
      operation = 'update';
      record(`update:${table}`, payload);
      return chain;
    },
    insert(payload: unknown) {
      operation = 'insert';
      record(`insert:${table}`, payload);
      return chain;
    },
    upsert(payload: unknown, options?: unknown) {
      operation = 'upsert';
      record(`upsert:${table}`, payload);
      fake.upsertOptions.push(options);
      return chain;
    },
    eq: () => chain,
    gte: (...args: unknown[]) => {
      fake.filters.push({ op: 'gte', args });
      return chain;
    },
    lt: (...args: unknown[]) => {
      fake.filters.push({ op: 'lt', args });
      return chain;
    },
    in: (...args: unknown[]) => {
      fake.filters.push({ op: 'in', args });
      return chain;
    },
    limit: () => chain,
    range: () => chain,
    order: () => chain,
    overrideTypes: () => chain,
    maybeSingle: () => resolve(),
    single: () => resolve(),
    then: (onFulfilled: (value: FakeResponse) => unknown, onRejected?: (reason: unknown) => unknown) =>
      resolve().then(onFulfilled, onRejected),
  };
  return chain;
}

export const fakeClient = {
  from: (table: string) => builder(table),
  rpc: (name: string, args?: unknown) => {
    fake.calls.push({ name: `rpc:${name}`, payload: args });
    return answer(`rpc:${name}`);
  },
};
