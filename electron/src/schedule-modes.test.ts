import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildSchedulePayload } from '@alarm-calendar/core';
import type { AlarmSettings, EventRow, ModeActivationRow, ModeConfig, ModeRow, ModeRuleRow } from '@alarm-calendar/core';

import type { AlarmView } from './alarm-ipc';
import { createCachePersister, emptyCache, loadCache, scheduleFilePath } from './cache';
import type { CacheData } from './cache';
import { parseSchedulePayload } from './desktop-payloads';
import { FakeClock } from './fake-clock';
import { AlarmScheduler, REFILL_MAX_AGE_MS } from './scheduler';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const USER = '99999999-9999-4999-8999-999999999999';
const START = Date.parse('2026-03-02T09:00:00.000Z');
const GYM = '11111111-1111-4111-8111-111111111111';
const MEDS = '22222222-2222-4222-8222-222222222222';
const SICK = '00000000-0000-4000-8000-0000000000e4';
const RAMADAN = '00000000-0000-4000-8000-0000000000e2';

const SETTINGS: AlarmSettings = { user_id: USER, timezone: 'UTC', week_starts_on: 0, refire_seconds: 120, pass_cap: 2, grace_minutes: 30 };

function makeEvent(overrides: Partial<EventRow> & { id: string }): EventRow {
  return {
    user_id: USER,
    title: 'Alarm',
    notes: null,
    start_at: new Date(START + MINUTE).toISOString(),
    duration_min: 15,
    repeat_unit: 'day',
    repeat_interval: 1,
    repeat_weekdays: null,
    ends_at: null,
    max_snoozes: 3,
    snooze_minutes: 5,
    passable: true,
    color: null,
    active: true,
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const mode = (id: string, key: ModeRow['builtin_key'], behavior: ModeRow['default_behavior']): ModeRow => ({
  id,
  user_id: USER,
  name: key ?? 'x',
  kind: 'builtin',
  builtin_key: key,
  default_behavior: behavior,
  active: true,
});

const manual = (modeId: string, startsAt: string, endsAt: string | null): ModeActivationRow => ({
  id: 'a0000000-0000-4000-8000-000000000001',
  user_id: USER,
  mode_id: modeId,
  starts_at: startsAt,
  ends_at: endsAt,
  source: 'manual',
});

const rule = (modeId: string, eventId: string, overrides: Partial<ModeRuleRow>): ModeRuleRow => ({
  id: 'b0000000-0000-4000-8000-000000000001',
  user_id: USER,
  mode_id: modeId,
  event_id: eventId,
  behavior: 'keep',
  shift_minutes: null,
  duration_min: null,
  ...overrides,
});

function createEngine(cache: CacheData = emptyCache()) {
  const clock = new FakeClock(START);
  const rings: AlarmView[] = [];
  const logs: string[] = [];
  const scheduler = new AlarmScheduler({
    cache,
    persist: () => undefined,
    now: clock.now,
    timers: clock.timers,
    newId: () => '00000000-0000-4000-8000-000000000001',
    onRing: (view) => rings.push(view),
    onDismiss: () => undefined,
    log: (event) => {
      logs.push(event);
    },
  });
  return { clock, cache, rings, logs, scheduler };
}

function answerEveryAlarm(engine: ReturnType<typeof createEngine>, totalMs: number, stepMs: number): void {
  let handled = 0;
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    engine.clock.advance(Math.min(stepMs, totalMs - elapsed));
    for (; handled < engine.rings.length; handled++) engine.scheduler.done(engine.rings[handled]!.occurrenceId);
  }
}

describe('the refill applies the modes', () => {
  const events = [makeEvent({ id: GYM, title: 'Gym' }), makeEvent({ id: MEDS, title: 'Meds', passable: false })];

  function start(modes: ModeConfig) {
    const engine = createEngine();
    engine.scheduler.setSchedule(buildSchedulePayload({ events, cheatDays: [], settings: SETTINGS, completions: [], now: engine.clock.now(), modes }));
    engine.clock.dropIntervals();
    engine.scheduler.start();
    return engine;
  }

  it('keeps pausing what Sick pauses after the list ages out and main re-expands it alone', () => {
    const sick: ModeConfig = {
      modes: [mode(SICK, 'sick', 'skip')],
      rules: [],
      activations: [manual(SICK, '2026-03-02T00:00:00.000Z', null)],
      exams: [],
    };
    const engine = start(sick);
    expect(engine.cache.modes).toEqual(sick);
    // Past several daily refills (the list is renewed once it is a day old): only the medication ever rings.
    answerEveryAlarm(engine, 6 * DAY, DAY);
    expect(engine.logs.filter((entry) => entry === 'schedule.refilled').length).toBeGreaterThan(0);
    const titles = new Set(engine.rings.map((view) => view.title));
    expect(titles).toEqual(new Set(['Meds']));
    expect(engine.rings.length).toBe(6);
  });

  it('rings a shifted alarm at its new time in a refilled list, and rings again on time once the mode ends', () => {
    const ramadan: ModeConfig = {
      modes: [mode(RAMADAN, 'ramadan', 'keep')],
      rules: [rule(RAMADAN, GYM, { behavior: 'shift', shift_minutes: 120 })],
      // Ends on 5 March at noon.
      activations: [manual(RAMADAN, '2026-03-02T00:00:00.000Z', '2026-03-05T12:00:00.000Z')],
      exams: [],
    };
    const engine = start(ramadan);
    // Ride past a refill so the later rings come from main's own expansion.
    answerEveryAlarm(engine, REFILL_MAX_AGE_MS + 6 * DAY, HOUR);
    const gym = engine.rings.filter((view) => view.title === 'Gym').map((view) => view.occurrenceAt.slice(0, 16));
    // The 5 March occurrence is 09:01, before the mode ends at noon, so it is still shifted; the 6th is not.
    expect(gym.slice(0, 5)).toEqual(['2026-03-02T11:01', '2026-03-03T11:01', '2026-03-04T11:01', '2026-03-05T11:01', '2026-03-06T09:01']);
  });

  it('a push without modes leaves the cache with none, so an older app behaves as before', () => {
    const engine = createEngine();
    engine.scheduler.setSchedule(buildSchedulePayload({ events, cheatDays: [], settings: SETTINGS, completions: [], now: engine.clock.now() }));
    expect(engine.cache.modes).toBeNull();
  });
});

describe('modes in the schedule payload', () => {
  const modes: ModeConfig = {
    modes: [mode(SICK, 'sick', 'skip')],
    rules: [rule(SICK, GYM, { behavior: 'shift', shift_minutes: -30 })],
    activations: [manual(SICK, '2026-03-02T00:00:00.000Z', null)],
    exams: [{ id: '33333333-3333-4333-8333-333333333333', exam_at: '2026-03-20T09:00:00.000Z', active: true }],
  };
  const payload = (m?: ModeConfig) =>
    buildSchedulePayload({ events: [makeEvent({ id: GYM })], cheatDays: [], settings: { ...SETTINGS, exam_mode_days_before: 7 }, completions: [], now: new Date(START), ...(m === undefined ? {} : { modes: m }) });

  it('accepts what core produces, including the exam lead in the settings', () => {
    const parsed = parseSchedulePayload(JSON.parse(JSON.stringify(payload(modes))));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.version !== 2) return;
    expect(parsed.value.refillSource.modes).toEqual(modes);
    expect(parsed.value.settings.exam_mode_days_before).toBe(7);
    expect(parsed.dropped.modeRows).toBeUndefined();
  });

  it('has no modes for a push that carried none', () => {
    const parsed = parseSchedulePayload(JSON.parse(JSON.stringify(payload())));
    expect(parsed.ok && parsed.version === 2 && 'modes' in parsed.value.refillSource).toBe(false);
  });

  const OTHER = '00000000-0000-4000-8000-0000000000e2';
  /** The base modes plus a second, healthy mode with its own rule and activation. */
  function withSecondMode(): { refillSource: { modes: Record<string, unknown[]> } } {
    const raw = JSON.parse(JSON.stringify(payload(modes))) as { refillSource: { modes: Record<string, unknown[]> } };
    const r = raw.refillSource.modes;
    r.modes!.push(mode(OTHER, 'ramadan', 'keep'));
    r.rules!.push(rule(OTHER, GYM, { behavior: 'shorten', duration_min: 5, id: 'b0000000-0000-4000-8000-000000000009' }));
    r.activations!.push({ ...manual(OTHER, '2026-03-02T00:00:00.000Z', null), id: 'a0000000-0000-4000-8000-000000000009' });
    return raw;
  }
  const modesOf = (parsed: ReturnType<typeof parseSchedulePayload>) => (parsed.ok && parsed.version === 2 ? parsed.value.refillSource.modes : undefined);

  it.each([
    ['a 13 hour shift', rule(SICK, MEDS, { behavior: 'shift', shift_minutes: 781 })],
    ['a shift with no minutes', rule(SICK, MEDS, { behavior: 'shift', shift_minutes: null })],
    ['minutes on a keep', rule(SICK, MEDS, { behavior: 'keep', shift_minutes: 5 })],
    ['an unknown behavior', { ...rule(SICK, MEDS, {}), behavior: 'replace' }],
  ])('one invalid rule (%s) drops that whole mode, so it fails towards ringing, and leaves the other mode alone', (_name, bad) => {
    const raw = withSecondMode();
    raw.refillSource.modes.rules!.push(bad);
    const parsed = parseSchedulePayload(raw);
    const kept = modesOf(parsed)!;
    expect(kept.modes.map((m) => m.id)).toEqual([OTHER]);
    expect(kept.rules.map((r) => r.mode_id)).toEqual([OTHER]);
    expect(kept.activations.map((a) => a.mode_id)).toEqual([OTHER]);
    expect(kept.exams).toHaveLength(1);
    // Sick's mode row, its valid rule, the bad rule and its activation.
    expect(parsed.ok && parsed.dropped.modeRows).toBe(4);
  });

  it('an invalid activation (it ends before it starts) drops its mode as well', () => {
    const raw = withSecondMode();
    raw.refillSource.modes.activations!.push(manual(SICK, '2026-03-05T00:00:00.000Z', '2026-03-04T00:00:00.000Z'));
    expect(modesOf(parseSchedulePayload(raw))!.modes.map((m) => m.id)).toEqual([OTHER]);
  });

  it('a rule too broken to name its mode drops every mode (the exams are harmless alone)', () => {
    const raw = withSecondMode();
    raw.refillSource.modes.rules!.push({ behavior: 'skip' });
    const kept = modesOf(parseSchedulePayload(raw))!;
    expect([kept.modes.length, kept.rules.length, kept.activations.length]).toEqual([0, 0, 0]);
  });

  it('an invalid mode row is dropped alone, and a mode name is bounded at 400 characters', () => {
    const raw = withSecondMode();
    (raw.refillSource.modes.modes![1] as { name: string }).name = 'x'.repeat(400);
    expect(modesOf(parseSchedulePayload(raw))!.modes).toHaveLength(2);
    (raw.refillSource.modes.modes![1] as { name: string }).name = 'x'.repeat(401);
    expect(modesOf(parseSchedulePayload(raw))!.modes.map((m) => m.id)).toEqual([SICK]);
  });

  it('refuses a payload whose modes are not bounded arrays, and one with an out-of-range exam lead', () => {
    const raw = JSON.parse(JSON.stringify(payload(modes))) as { refillSource: { modes: unknown }; settings: Record<string, unknown> };
    expect(parseSchedulePayload({ ...raw, refillSource: { ...raw.refillSource, modes: 'nope' } }).ok).toBe(false);
    expect(parseSchedulePayload({ ...raw, settings: { ...raw.settings, exam_mode_days_before: 61 } }).ok).toBe(false);
  });
});

describe('the cache keeps the modes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'alarm-modes-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const modes: ModeConfig = { modes: [mode(SICK, 'sick', 'skip')], rules: [], activations: [manual(SICK, '2026-03-02T00:00:00.000Z', null)], exams: [] };

  it('saves them with the schedule and loads them back', () => {
    const file = join(dir, 'cache.json');
    const cache = emptyCache();
    cache.modes = modes;
    createCachePersister(file)(cache);
    expect(loadCache(file, () => undefined).modes).toEqual(modes);
    expect(readFileSync(file, 'utf8')).not.toContain('"modes"');
  });

  it('rewrites the schedule file when only the modes change', () => {
    const file = join(dir, 'cache.json');
    const persist = createCachePersister(file);
    const cache = emptyCache();
    persist(cache);
    const before = readFileSync(scheduleFilePath(file), 'utf8');
    persist({ ...cache, modes });
    expect(readFileSync(scheduleFilePath(file), 'utf8')).not.toBe(before);
  });

  it('loads a schedule file written before modes with none', () => {
    const file = join(dir, 'cache.json');
    createCachePersister(file)(emptyCache());
    const old = JSON.parse(readFileSync(scheduleFilePath(file), 'utf8')) as Record<string, unknown>;
    delete old['modes'];
    writeFileSync(scheduleFilePath(file), JSON.stringify(old));
    expect(loadCache(file, () => undefined).modes).toBeNull();
  });
});

describe('originalAt on a shifted occurrence', () => {
  const ramadan: ModeConfig = {
    modes: [mode(RAMADAN, 'ramadan', 'keep')],
    rules: [rule(RAMADAN, GYM, { behavior: 'shift', shift_minutes: 90 })],
    activations: [manual(RAMADAN, '2026-03-01T00:00:00.000Z', null)],
    exams: [],
  };
  const raw = () =>
    JSON.parse(
      JSON.stringify(buildSchedulePayload({ events: [makeEvent({ id: GYM })], cheatDays: [], settings: SETTINGS, completions: [], now: new Date(START), modes: ramadan }))
    ) as { occurrences: Array<Record<string, unknown>> };

  it('is kept when it is the real original of the shifted occurrence', () => {
    const payload2 = raw();
    expect(payload2.occurrences[0]!.originalAt).toBe('2026-03-02T09:01:00.000Z');
    const parsed = parseSchedulePayload(payload2);
    expect(parsed.ok && parsed.version === 2 && parsed.value.occurrences[0]!.originalAt).toBe('2026-03-02T09:01:00.000Z');
  });

  it('is refused (the occurrence dropped) when it equals `at`, is more than 12 hours away, or is not a timestamp', () => {
    for (const bad of ['same', '2026-03-03T09:01:00.000Z', 'soon']) {
      const payload2 = raw();
      payload2.occurrences[0]!.originalAt = bad === 'same' ? payload2.occurrences[0]!.at : bad;
      const parsed = parseSchedulePayload(payload2);
      expect(parsed.ok && parsed.dropped.occurrences, bad).toBe(1);
    }
  });
});

describe('the live completion check follows the shift', () => {
  const alarm = makeEvent({ id: GYM, title: 'Gym', start_at: '2026-03-01T09:00:00.000Z' });
  const shiftBack: ModeConfig = {
    modes: [mode(RAMADAN, 'ramadan', 'keep')],
    rules: [rule(RAMADAN, GYM, { behavior: 'shift', shift_minutes: -30 })],
    activations: [manual(RAMADAN, '2026-03-01T00:00:00.000Z', '2026-03-02T08:35:00.000Z')],
    exams: [],
  };

  function engineAt(startIso: string, modes: ModeConfig | undefined) {
    const engine = createEngine();
    engine.clock.advance(Date.parse(startIso) - engine.clock.now().getTime());
    engine.scheduler.setSchedule(
      buildSchedulePayload({ events: [alarm], cheatDays: [], settings: SETTINGS, completions: [], now: engine.clock.now(), ...(modes === undefined ? {} : { modes }) })
    );
    engine.clock.dropIntervals();
    engine.scheduler.start();
    return engine;
  }

  it('does not ring the 09:00 occurrence when this device saw a Done at the shifted 08:30 (mode over at 08:35)', () => {
    const engine = engineAt('2026-03-02T08:40:00.000Z', shiftBack);
    engine.cache.knownCompletions = [`${GYM}@2026-03-02T08:30:00.000Z`];
    engine.clock.advance(21 * MINUTE);
    expect(engine.rings.filter((view) => view.occurrenceAt === '2026-03-02T09:00:00.000Z')).toEqual([]);
  });

  it('also counts a Done still waiting to be flushed, and rings normally with no such Done', () => {
    const pending = engineAt('2026-03-02T08:40:00.000Z', shiftBack);
    pending.cache.pendingCompletions = [
      { id: '00000000-0000-4000-8000-0000000000aa', user_id: USER, event_id: GYM, occurrence_at: '2026-03-02T08:30:00.000Z', status: 'done', snoozes_used: 0, done_at: '2026-03-02T08:30:10.000Z' },
    ];
    pending.clock.advance(21 * MINUTE);
    expect(pending.rings).toEqual([]);

    const none = engineAt('2026-03-02T08:40:00.000Z', shiftBack);
    none.clock.advance(21 * MINUTE);
    expect(none.rings.map((view) => view.occurrenceAt)).toEqual(['2026-03-02T09:00:00.000Z']);
  });

  it('a shifted occurrence is also covered by a Done recorded at its original instant (originalAt), even for a fast alarm whose reverse match is off', () => {
    // Hourly +60: the shift equals the repeat period, so the reverse match ignores it and only originalAt can say 09:00 was done.
    const hourly = makeEvent({ id: GYM, title: 'Gym', repeat_unit: 'hour', start_at: '2026-03-01T09:00:00.000Z' });
    const forward: ModeConfig = { ...shiftBack, rules: [rule(RAMADAN, GYM, { behavior: 'shift', shift_minutes: 60 })], activations: [manual(RAMADAN, '2026-03-01T00:00:00.000Z', null)] };
    const engine = createEngine();
    engine.clock.advance(Date.parse('2026-03-02T08:40:00.000Z') - engine.clock.now().getTime());
    engine.scheduler.setSchedule(buildSchedulePayload({ events: [hourly], cheatDays: [], settings: SETTINGS, completions: [], now: engine.clock.now(), modes: forward }));
    engine.clock.dropIntervals();
    engine.scheduler.start();
    engine.cache.knownCompletions = [`${GYM}@2026-03-02T09:00:00.000Z`];
    engine.clock.advance(151 * MINUTE);
    // 09:00 rings at 10:00 shifted; 10:00 rings at 11:00. Only the first is covered.
    expect(engine.rings.map((view) => view.occurrenceAt)).not.toContain('2026-03-02T10:00:00.000Z');
    expect(engine.rings.map((view) => view.occurrenceAt)).toContain('2026-03-02T11:00:00.000Z');
  });
});
