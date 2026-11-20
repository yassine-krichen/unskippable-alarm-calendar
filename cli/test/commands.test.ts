import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './harness';

let harness: Harness;
beforeEach(() => {
  harness = createHarness();
});
afterEach(() => harness.cleanup());

const addPush = (extra: string[] = []) =>
  harness.run(['events', 'add', '--title', 'Push day', '--time', '07:30', '--days', 'mon,wed,fri', '--duration', '60', '--key', 'workout/push-day', '--json', ...extra]);

describe('events add / list / get', () => {
  it('creates an alarm from flags and prints what it did, with local and ISO times', async () => {
    const result = await addPush();
    expect(result.code).toBe(0);
    expect(result.json['changes'][0]).toContain('created "Push day" (workout/push-day)');
    expect(result.json['event']).toMatchObject({
      agent_key: 'workout/push-day',
      active: true,
      spec: { title: 'Push day', time: '07:30', duration: 60, repeat: 'weekly', days: ['mon', 'wed', 'fri'] },
    });
    expect(result.json['event'].next_ring).toMatchObject({ local: '2026-11-09 07:30', timezone: 'Africa/Tunis', iso: '2026-11-09T06:30:00.000Z', weekday: 'Mon' });
    expect(result.json['journal']).toMatchObject({ undo: 'alarm-cal undo' });
  });

  it('prints human text with the same facts', async () => {
    const result = await harness.run(['events', 'add', '--title', 'Dentist', '--at', '2026-11-20 09:15', '--no-passable']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('created "Dentist"');
    expect(result.stdout).toContain('Next ring: Fri 2026-11-20 09:15 Africa/Tunis (2026-11-20T08:15:00.000Z)');
    expect(result.stdout).toContain('Undo with: alarm-cal undo');
    expect(harness.store.events[0]).toMatchObject({ passable: false, repeat_unit: 'none' });
  });

  it('refuses a duplicate key with exit 6 and an invalid key with exit 5', async () => {
    await addPush();
    const duplicate = await addPush();
    expect(duplicate.code).toBe(6);
    expect(duplicate.json['error'].code).toBe('conflict');
    const invalid = await harness.run(['events', 'add', '--title', 'X', '--time', '08:00', '--key', 'Bad Key', '--json']);
    expect(invalid.code).toBe(5);
  });

  it('lists with filters, hides switched-off alarms until --all, and never lists prayer rows', async () => {
    await addPush();
    await harness.run(['events', 'add', '--title', 'Read', '--time', '21:00', '--repeat', 'daily', '--key', 'study/read']);
    await harness.store.insertEvents([{ title: 'Fajr', kind: 'prayer', prayer: 'fajr', notes: null, start_at: '2026-11-09T04:00:00.000Z', duration_min: 15, repeat_unit: 'day', repeat_interval: 1, repeat_weekdays: null, ends_at: null, max_snoozes: 0, snooze_minutes: 5, passable: false, color: null, show_in_calendar: true }]);
    await harness.run(['events', 'disable', 'study/read']);

    const all = await harness.run(['events', 'list', '--json']);
    expect(all.json['events'].map((event: { agent_key: string }) => event.agent_key)).toEqual(['workout/push-day']);
    const withOff = await harness.run(['events', 'list', '--all', '--json']);
    expect(withOff.json['count']).toBe(2);
    const prefixed = await harness.run(['events', 'list', '--all', '--key-prefix', 'study/', '--json']);
    expect(prefixed.json['events']).toHaveLength(1);
    const table = await harness.run(['events', 'list']);
    expect(table.stdout).toContain('times in Africa/Tunis');
    expect(table.stdout).toContain('workout/push-day');
  });

  it('gets one alarm by key, by id and by id prefix, with its mode rules', async () => {
    const created = await addPush();
    const id = created.json['event'].id as string;
    await harness.run(['modes', 'rule', 'set', 'sick', 'workout/push-day', 'skip']);
    const byKey = await harness.run(['events', 'get', 'workout/push-day', '--json']);
    expect(byKey.json['event'].id).toBe(id);
    expect(byKey.json['mode_rules']).toEqual([{ mode: 'sick', behavior: 'skip', shift_minutes: null, duration_min: null }]);
    expect((await harness.run(['events', 'get', id.slice(0, 8), '--json'])).json['event'].id).toBe(id);
    const missing = await harness.run(['events', 'get', 'nope/none', '--json']);
    expect(missing.code).toBe(4);
    expect(missing.json['error'].code).toBe('not_found');
  });
});

describe('events update / disable / enable', () => {
  it('changes only the flagged fields and prints the field changes', async () => {
    await addPush();
    const result = await harness.run(['events', 'update', 'workout/push-day', '--time', '08:00', '--duration', '45m', '--json']);
    expect(result.code).toBe(0);
    expect(result.json['changes']).toEqual([
      { field: 'time', from: '07:30', to: '08:00' },
      { field: 'duration', from: 60, to: 45 },
    ]);
    expect(harness.store.events[0]).toMatchObject({ duration_min: 45, repeat_weekdays: [0, 2, 4], agent_key: 'workout/push-day' });
    expect(harness.store.events[0]?.start_at.slice(11, 16)).toBe('07:00');
  });

  it('says so when nothing changes, and writes nothing', async () => {
    await addPush();
    const writes = harness.store.writes;
    const result = await harness.run(['events', 'update', 'workout/push-day', '--duration', '60']);
    expect(result.stdout).toContain('No changes');
    expect(harness.store.writes).toBe(writes);
  });

  it('switching to a daily repeat drops the old weekdays; weekly keeps them', async () => {
    await addPush();
    await harness.run(['events', 'update', 'workout/push-day', '--repeat', 'daily']);
    expect(harness.store.events[0]).toMatchObject({ repeat_unit: 'day', repeat_weekdays: null });
    const days = await harness.run(['events', 'update', 'workout/push-day', '--days', 'tue,thu', '--json']);
    expect(days.code).toBe(0);
    expect(harness.store.events[0]).toMatchObject({ repeat_unit: 'week', repeat_weekdays: [1, 3] });
  });

  it('assigns a key to an alarm made in the app, and refuses a key another alarm has', async () => {
    await harness.store.insertEvents([{ title: 'From the app', notes: null, start_at: '2026-11-09T06:00:00.000Z', duration_min: 15, repeat_unit: 'day', repeat_interval: 1, repeat_weekdays: null, ends_at: null, max_snoozes: 3, snooze_minutes: 5, passable: true, color: null, show_in_calendar: true }]);
    await addPush();
    const id = harness.store.events[0]?.id as string;
    const ok = await harness.run(['events', 'update', id, '--key', 'misc/app-alarm', '--json']);
    expect(ok.code).toBe(0);
    expect(harness.store.events[0]?.agent_key).toBe('misc/app-alarm');
    const clash = await harness.run(['events', 'update', id, '--key', 'workout/push-day', '--json']);
    expect(clash.code).toBe(6);
  });

  it('disables and enables by key or by prefix; any alarm, not only the ones the tool made', async () => {
    await addPush();
    await harness.run(['events', 'add', '--title', 'Pull day', '--time', '07:30', '--days', 'tue,thu', '--key', 'workout/pull-day']);
    await harness.store.insertEvents([{ title: 'From the app', notes: null, start_at: '2026-11-09T06:00:00.000Z', duration_min: 15, repeat_unit: 'day', repeat_interval: 1, repeat_weekdays: null, ends_at: null, max_snoozes: 3, snooze_minutes: 5, passable: true, color: null, show_in_calendar: true }]);
    const off = await harness.run(['events', 'disable', '--key-prefix', 'workout/', '--json']);
    expect(off.json['changed']).toHaveLength(2);
    expect(harness.store.events.map((event) => event.active)).toEqual([false, false, true]);
    const appAlarmId = harness.store.events[2]?.id as string;
    await harness.run(['events', 'disable', appAlarmId]);
    expect(harness.store.events[2]?.active).toBe(false);
    const again = await harness.run(['events', 'disable', 'workout/push-day']);
    expect(again.stdout).toContain('already off');
    await harness.run(['events', 'enable', '--key-prefix', 'workout/']);
    expect(harness.store.events.slice(0, 2).every((event) => event.active)).toBe(true);
  });

  it('asks for something to disable', async () => {
    const result = await harness.run(['events', 'disable', '--json']);
    expect(result.code).toBe(2);
  });
});

describe('occurrences', () => {
  it('expands rings in the user zone and marks modes, shifts and cheat days', async () => {
    await addPush();
    await harness.run(['events', 'add', '--title', 'Pill', '--time', '09:00', '--repeat', 'daily', '--no-passable', '--key', 'meds/pill']);
    await harness.run(['modes', 'rule', 'set', 'ramadan', 'meds/pill', 'shift', '120']);
    await harness.run(['modes', 'switch', 'sick', '--since', 'today']);
    harness.store.cheatDays.push('2026-11-13');
    const result = await harness.run(['occurrences', '--from', '2026-11-09', '--to', '2026-11-10', '--json']);
    expect(result.code).toBe(0);
    const rings = result.json['occurrences'] as Array<Record<string, any>>;
    const push = rings.find((ring) => ring['agent_key'] === 'workout/push-day');
    expect(push).toMatchObject({ paused: true, paused_by: 'Sick', rings: false, at: { local: '2026-11-09 07:30', timezone: 'Africa/Tunis' } });
    const pill = rings.filter((ring) => ring['agent_key'] === 'meds/pill');
    expect(pill).toHaveLength(2);
    expect(pill.every((ring) => ring['paused'] === false && ring['rings'] === true)).toBe(true); // a non-passable alarm is never paused
    expect(result.json['mode_segments'][0]).toMatchObject({ mode: 'sick', source: 'manual' });

    const cheat = await harness.run(['occurrences', '--from', '2026-11-13', '--to', '2026-11-13', '--key-prefix', 'workout/', '--json']);
    expect(cheat.json['occurrences'][0]).toMatchObject({ paused: true }); // sick still on; the mode wins over the cheat day
  });

  it('shows a shift and a cheat day when no mode pauses the alarm', async () => {
    await harness.run(['events', 'add', '--title', 'Read', '--time', '21:00', '--repeat', 'daily', '--key', 'study/read']);
    await harness.run(['modes', 'rule', 'set', 'vacation', 'study/read', 'shift', '-60']);
    await harness.run(['modes', 'range', 'add', 'vacation', '--from', '2026-11-10', '--to', '2026-11-10']);
    harness.store.cheatDays.push('2026-11-11');
    const result = await harness.run(['occurrences', '--from', '2026-11-09', '--to', '2026-11-11', '--json']);
    const byDay = Object.fromEntries((result.json['occurrences'] as Array<Record<string, any>>).map((ring) => [ring['at'].local.slice(0, 10), ring]));
    expect(byDay['2026-11-09']).toMatchObject({ shifted: false, silenced_by_cheat_day: false, rings: true });
    expect(byDay['2026-11-10']).toMatchObject({ shifted: true, at: { local: '2026-11-10 20:00' }, original_at: { local: '2026-11-10 21:00' } });
    expect(byDay['2026-11-11']).toMatchObject({ silenced_by_cheat_day: true, rings: false });
  });

  it('validates the range', async () => {
    expect((await harness.run(['occurrences', '--from', '2026-11-10', '--to', '2026-11-09', '--json'])).code).toBe(5);
    expect((await harness.run(['occurrences', '--from', 'tomorrow', '--json'])).code).toBe(5);
  });
});

describe('modes', () => {
  it('lists built-ins created on demand with rules and activations', async () => {
    await addPush();
    await harness.run(['modes', 'rule', 'set', 'exam', 'workout/push-day', 'shorten', '30']);
    await harness.run(['modes', 'switch', 'vacation', '--until', '2026-11-20']);
    const result = await harness.run(['modes', 'list', '--json']);
    expect(result.json['in_effect_now']).toEqual({ mode: 'vacation', source: 'manual' });
    const exam = result.json['modes'].find((mode: { key: string }) => mode.key === 'exam');
    expect(exam.rules[0]).toMatchObject({ agent_key: 'workout/push-day', behavior: 'shorten', duration_min: 30 });
    expect(result.json['activations'][0]).toMatchObject({ mode: 'vacation', state: 'running', ends: { local: '2026-11-21 00:00' } });
  });

  it('rule set replaces, keeps and removes (inherit) a rule, and warns about a non-passable skip', async () => {
    await addPush();
    await harness.run(['events', 'add', '--title', 'Pill', '--time', '09:00', '--repeat', 'daily', '--no-passable', '--key', 'meds/pill']);
    const skip = await harness.run(['modes', 'rule', 'set', 'sick', 'meds/pill', 'skip', '--json']);
    expect(skip.json['warnings'][0]).toContain('not passable');
    const shift = await harness.run(['modes', 'rule', 'set', 'sick', 'meds/pill', 'shift', '-30', '--json']);
    expect(shift.json['result']).toBe('updated');
    expect(harness.store.rules).toHaveLength(1);
    expect(harness.store.rules[0]).toMatchObject({ behavior: 'shift', shift_minutes: -30 });
    expect((await harness.run(['modes', 'rule', 'set', 'sick', 'meds/pill', 'shift', '-30', '--json'])).json['result']).toBe('unchanged');
    expect((await harness.run(['modes', 'rule', 'set', 'sick', 'meds/pill', 'inherit', '--json'])).json['result']).toBe('removed');
    expect(harness.store.rules).toHaveLength(0);
    expect((await harness.run(['modes', 'rule', 'set', 'sick', 'meds/pill', 'shift', '900', '--json'])).code).toBe(5);
    expect((await harness.run(['modes', 'rule', 'set', 'nonsense', 'meds/pill', 'skip', '--json'])).code).toBe(4);
  });

  it('switches the sick mode on since this morning, and back to normal', async () => {
    const result = await harness.run(['modes', 'switch', 'sick', '--since', 'today', '--json']);
    expect(result.code).toBe(0);
    expect(result.json['starts_at']).toBe('2026-11-07T23:00:00.000Z'); // 00:00 Tunis on the 8th
    expect(harness.store.activations[0]).toMatchObject({ source: 'manual', ends_at: null });
    await harness.run(['modes', 'normal']);
    expect(harness.store.activations[0]?.ends_at).toBe(NOW_ISO);
    const both = await harness.run(['modes', 'switch', 'sick', '--until', '2026-11-12', '--open', '--json']);
    expect(both.code).toBe(2);
  });

  it('plans and removes a range', async () => {
    const added = await harness.run(['modes', 'range', 'add', 'ramadan', '--from', '2027-02-08', '--to', '2027-03-09', '--json']);
    expect(added.code).toBe(0);
    const row = harness.store.activations[0];
    expect(row).toMatchObject({ source: 'range', starts_at: '2027-02-07T23:00:00.000Z', ends_at: '2027-03-09T23:00:00.000Z' });
    const removed = await harness.run(['modes', 'range', 'remove', (row?.id as string).slice(0, 8), '--json']);
    expect(removed.code).toBe(0);
    expect(harness.store.activations).toHaveLength(0);
  });
});

const NOW_ISO = '2026-11-08T10:00:00.000Z';

describe('exams', () => {
  it('plans the exam alarm and revision sessions like the app and tags the exam with a key', async () => {
    const result = await harness.run(['exams', 'add', '--title', 'Maths final', '--date', '2026-12-10', '--time', '09:00', '--difficulty', 'hard', '--key', 'exams/maths-final', '--json']);
    expect(result.code).toBe(0);
    expect(harness.store.exams[0]).toMatchObject({ title: 'Maths final', difficulty: 3, agent_key: 'exams/maths-final', exam_at: '2026-12-10T08:00:00.000Z' });
    const alarms = harness.store.events.filter((event) => event.exam_id === harness.store.exams[0]?.id);
    expect(alarms.filter((event) => event.exam_role === 'exam')).toHaveLength(1);
    expect(alarms.filter((event) => event.exam_role === 'session').length).toBeGreaterThanOrEqual(3);
    expect(alarms.find((event) => event.exam_role === 'exam')).toMatchObject({ passable: false, title: 'Exam: Maths final' });
    expect(result.json['sessions']).toBe(alarms.filter((event) => event.exam_role === 'session').length);
  });

  it('regenerates by diff on update and removes everything on remove', async () => {
    await harness.run(['exams', 'add', '--title', 'Maths final', '--date', '2026-12-10', '--key', 'exams/maths']);
    const sessionIds = harness.store.events.filter((event) => event.exam_role === 'session').map((event) => event.id);
    const retitled = await harness.run(['exams', 'update', 'exams/maths', '--title', 'Maths resit', '--json']);
    expect(retitled.code).toBe(0);
    expect(harness.store.events.filter((event) => event.exam_role === 'session' && event.active).map((event) => event.id)).toEqual(sessionIds);
    expect(harness.store.events.filter((event) => event.exam_role === 'session')[0]?.title).toContain('Maths resit');

    const moved = await harness.run(['exams', 'update', 'exams/maths', '--date', '2026-12-17', '--json']);
    expect(moved.code).toBe(0);
    expect(harness.store.exams[0]?.exam_at).toBe('2026-12-17T08:00:00.000Z');

    await harness.run(['exams', 'remove', 'exams/maths']);
    expect(harness.store.exams[0]?.active).toBe(false);
    expect(harness.store.events.filter((event) => event.exam_id === harness.store.exams[0]?.id).every((event) => !event.active)).toBe(true);
    const list = await harness.run(['exams', 'list', '--all', '--json']);
    expect(list.json['exams'][0]).toMatchObject({ agent_key: 'exams/maths', active: false });
  });

  it('refuses an exam in the past or with a bad lead', async () => {
    expect((await harness.run(['exams', 'add', '--title', 'Old', '--date', '2026-11-01', '--json'])).code).toBe(5);
    expect((await harness.run(['exams', 'add', '--title', 'X', '--date', '2026-12-10', '--lead', '5000', '--json'])).code).toBe(5);
  });
});

describe('settings', () => {
  it('shows the settings and the writable fields', async () => {
    const result = await harness.run(['settings', 'get', '--json']);
    expect(result.json['settings'].timezone).toBe('Africa/Tunis');
    expect(result.json['writable_fields']).toContain('grace_minutes');
    expect(result.json['writable_fields']).not.toContain('pass_cap');
  });

  it('sets several fields in one update and reports old and new values', async () => {
    const result = await harness.run(['settings', 'set', 'grace_minutes', '15', 'latitude', '36.8625', 'islamic_holidays', 'on', '--json']);
    expect(result.code).toBe(0);
    expect(result.json['changes']).toEqual(['grace_minutes: 30 -> 15', 'latitude: (none) -> 36.8625', 'islamic_holidays: false -> true']);
    expect(harness.store.settings).toMatchObject({ grace_minutes: 15, latitude: 36.8625, islamic_holidays: true });
  });

  it('writes the Fajr reminder switch', async () => {
    const result = await harness.run(['settings', 'set', 'pre_prayer_skip_fajr', 'off', '--json']);
    expect(result.code).toBe(0);
    expect(harness.store.settings['pre_prayer_skip_fajr']).toBe(false);
    expect((await harness.run(['settings', 'get', '--json'])).json['writable_fields']).toContain('pre_prayer_skip_fajr');
  });

  it('refuses read-only fields, out-of-range values and unknown names with exit 5', async () => {
    for (const args of [['pass_cap', '9'], ['grace_minutes', '-1'], ['latitude', '80'], ['timezone', 'Mars/Base'], ['colour', 'x'], ['holiday_country', 'TUN']]) {
      const result = await harness.run(['settings', 'set', ...args, '--json']);
      expect(result.code, args.join(' ')).toBe(5);
    }
    expect(harness.store.settings['pass_cap']).toBe(2);
  });

  it('switches prayers through the RPC and the country to null with none', async () => {
    await harness.run(['settings', 'set', 'prayers_enabled', 'true', 'holiday_country', 'tn']);
    expect(harness.store.prayersCalls).toEqual([true]);
    expect(harness.store.settings['holiday_country']).toBe('TN');
    await harness.run(['settings', 'set', 'holiday_country', 'none']);
    expect(harness.store.settings['holiday_country']).toBeNull();
  });

  it('warns that changing the timezone shifts local times', async () => {
    const result = await harness.run(['settings', 'set', 'timezone', 'Europe/Paris', '--json']);
    expect(result.json['warnings'][0]).toContain('local times shift');
  });
});

describe('stats and passes', () => {
  it('scores a daily alarm from its completions', async () => {
    harness.clock.now = new Date('2026-11-08T10:00:00Z');
    await harness.run(['events', 'add', '--title', 'Read', '--time', '21:00', '--repeat', 'daily', '--start', '2026-10-01', '--key', 'study/read']);
    const event = harness.store.events[0];
    if (event === undefined) throw new Error('no event');
    event.created_at = '2026-10-01T00:00:00.000Z';
    for (let day = 1; day <= 7; day++) {
      harness.store.completions.push({ id: `c${day}`, user_id: 'u', event_id: event.id, occurrence_at: `2026-11-0${day}T20:00:00.000Z`, status: 'done', snoozes_used: 0, done_at: `2026-11-0${day}T20:01:00.000Z` });
    }
    const result = await harness.run(['stats', '--json']);
    expect(result.code).toBe(0);
    expect(result.json['habits'][0]).toMatchObject({ agent_key: 'study/read', title: 'Read', done: 7 });
    expect(result.json['habits'][0].score).toBeGreaterThan(0);
  });

  it('shows the wallet and cheat days', async () => {
    harness.store.cheatDays.push('2026-11-12', '2026-11-01');
    const result = await harness.run(['passes', '--json']);
    expect(result.json).toMatchObject({ balance: 1, cap: 2, next_grant_on_or_after: '2026-11-09', cheat_days_upcoming: ['2026-11-12'], cheat_days_past: ['2026-11-01'] });
  });
});

describe('routing, help and errors', () => {
  it('prints help --json with every command, the exit codes and the plan schema', async () => {
    const result = await harness.run(['help', '--json']);
    expect(result.code).toBe(0);
    const commands = (result.json['commands'] as Array<{ command: string }>).map((command) => command.command);
    expect(commands).toEqual(expect.arrayContaining(['login', 'events add', 'plan apply', 'modes rule set', 'undo', 'history', 'exams add', 'settings set']));
    expect(result.json['exit_codes']['5']).toContain('invalid');
    expect(result.json['plan_schema'].properties.namespace).toBeDefined();
  });

  it('schema prints bare JSON, and schema plan prints only the plan schema', async () => {
    const all = await harness.run(['schema']);
    expect(all.json['tool']).toBe('alarm-cal');
    const plan = await harness.run(['schema', 'plan']);
    expect(plan.json['$id']).toContain('plan.schema.json');
    expect(plan.json['ok']).toBeUndefined();
  });

  it('reports usage errors with exit 2, as JSON when asked', async () => {
    const unknown = await harness.run(['evnts', 'list', '--json']);
    expect(unknown.code).toBe(2);
    expect(unknown.json).toMatchObject({ ok: false, error: { code: 'usage' } });
    const missing = await harness.run(['events', 'get', '--json']);
    expect(missing.code).toBe(2);
    expect(missing.json['error'].message).toContain('Missing argument');
    const option = await harness.run(['events', 'list', '--bogus']);
    expect(option.code).toBe(2);
    expect(option.stderr).toContain('Unknown option --bogus');
    const near = await harness.run(['events', 'frobnicate', '--json']);
    expect(near.json['error'].hint).toContain('events list');
  });

  it('describes one command with help <command> and --help', async () => {
    const viaHelp = await harness.run(['help', 'events', 'add']);
    expect(viaHelp.stdout).toContain('--time <HH:mm>');
    const viaFlag = await harness.run(['plan', 'apply', '--help']);
    expect(viaFlag.stdout).toContain('Idempotent');
  });

  it('keeps stdout clean in --json mode: exactly one JSON document', async () => {
    const result = await harness.run(['events', 'list', '--json']);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(result.stderr).toBe('');
  });
});
