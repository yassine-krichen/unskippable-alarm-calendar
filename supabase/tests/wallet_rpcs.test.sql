-- Checkpoint for build-order step 2 plus the wallet hardening migration:
-- exercises the wallet logic (spec section 7) with a controlled clock. Everything runs in one transaction that is rolled
-- back, including the throwaway auth.users row, so it is safe on a live project.
--
--   supabase db query --linked -f supabase/tests/wallet_rpcs.test.sql
--
-- or paste into the Supabase SQL editor. The final result set has one row per
-- check; every row must say PASS. A hard failure (unexpected exception) aborts
-- the transaction, which is also rolled back by the editor/CLI.

begin;

create temp table results (
  n serial primary key,
  name text not null,
  expected text,
  actual text,
  pass boolean not null
);

create temp table ctx (user_id uuid not null);

create function pg_temp.chk(p_name text, p_expected text, p_actual text)
returns void
language sql
as $$
  insert into pg_temp.results (name, expected, actual, pass)
  values (p_name, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

-- Runs p_sql and returns the error message, or 'ok' when it succeeds. The
-- sub-transaction undoes partial effects of a failing statement.
create function pg_temp.err(p_sql text)
returns text
language plpgsql
as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlerrm;
end;
$$;

create function pg_temp.wallet(p_user uuid)
returns text
language sql
as $$
  select balance || '/' || last_granted_week_start
  from public.pass_wallet where user_id = p_user;
$$;

do $$
declare
  u uuid := gen_random_uuid();
  u2 uuid := gen_random_uuid();
  w public.pass_wallet;
  r json;
begin
  insert into auth.users (id, aud, role, email)
  values (u, 'authenticated', 'authenticated', 'wallet-test-' || u || '@example.invalid'),
         (u2, 'authenticated', 'authenticated', 'wallet-test-' || u2 || '@example.invalid');

  insert into pg_temp.ctx values (u);

  -- Signup trigger
  perform pg_temp.chk('signup creates settings row (UTC, Monday, cap 2)',
    'UTC/0/2/120/30',
    (select timezone || '/' || week_starts_on || '/' || pass_cap || '/' || refire_seconds || '/' || grace_minutes
     from public.settings where user_id = u));
  perform pg_temp.chk('signup creates wallet with 1 pass',
    '1',
    (select balance::text from public.pass_wallet where user_id = u));
  perform pg_temp.chk('signup wallet snapshots settings and is not anchored yet',
    'UTC/0/true',
    (select timezone || '/' || week_starts_on || '/' || (anchored_at is null)
     from public.pass_wallet where user_id = u));

  -- Section 7 table. Reset the wallet so the first sync self-heals at a known Monday.
  delete from public.pass_wallet where user_id = u;

  w := private.sync_wallet(u, '2026-01-05 12:00+00');
  perform pg_temp.chk('section 7 week 1: initial, not used -> end balance 1', '1/2026-01-05', pg_temp.wallet(u));

  w := private.sync_wallet(u, '2026-01-14 09:00+00');
  perform pg_temp.chk('section 7 week 2: +1, not used -> end balance 2', '2/2026-01-12', pg_temp.wallet(u));

  w := private.sync_wallet(u, '2026-01-19 08:00+00');
  perform pg_temp.chk('section 7 week 3: +1 capped, still 2 before use', '2/2026-01-19', pg_temp.wallet(u));
  w := private.use_pass(u, '2026-01-21', '2026-01-19 08:00+00');
  perform pg_temp.chk('section 7 week 3: used -> end balance 1', '1/2026-01-19', pg_temp.wallet(u));

  w := private.sync_wallet(u, '2026-01-26 08:00+00');
  perform pg_temp.chk('section 7 week 4: +1 -> 2 before use', '2/2026-01-26', pg_temp.wallet(u));
  w := private.use_pass(u, '2026-01-26', '2026-01-26 08:00+00');
  perform pg_temp.chk('section 7 week 4: used -> end balance 1', '1/2026-01-26', pg_temp.wallet(u));
  perform pg_temp.chk('section 7: two cheat days recorded', '2',
    (select count(*)::text from public.cheat_days where user_id = u));

  -- Multi-week catch-up
  update public.pass_wallet set balance = 0 where user_id = u;
  w := private.sync_wallet(u, '2026-03-04 10:00+00');
  perform pg_temp.chk('catch-up: 0 pass, 5 weeks away -> capped at 2', '2/2026-03-02', pg_temp.wallet(u));

  update public.pass_wallet set balance = 0 where user_id = u;
  w := private.sync_wallet(u, '2026-03-10 10:00+00');
  perform pg_temp.chk('catch-up: 0 pass, 1 week boundary -> 1', '1/2026-03-09', pg_temp.wallet(u));

  w := private.sync_wallet(u, '2026-03-16 10:00+00');
  perform pg_temp.chk('catch-up: 1 pass, 1 week boundary -> 2', '2/2026-03-16', pg_temp.wallet(u));

  w := private.sync_wallet(u, '2026-03-18 10:00+00');
  perform pg_temp.chk('sync twice in the same week grants nothing', '2/2026-03-16', pg_temp.wallet(u));

  update public.pass_wallet set balance = 0 where user_id = u;
  w := private.sync_wallet(u, '2026-03-01 10:00+00');
  perform pg_temp.chk('clock going backwards (timezone change) grants nothing', '0/2026-03-16', pg_temp.wallet(u));

  -- Week start / timezone boundaries
  -- The wallet counts weeks with its own snapshot, so set that as well as settings.
  update public.settings set week_starts_on = 6 where user_id = u;  -- Sunday
  update public.pass_wallet set balance = 0, week_starts_on = 6, last_granted_week_start = '2026-03-15' where user_id = u;
  w := private.sync_wallet(u, '2026-03-21 23:30+00');
  perform pg_temp.chk('week_starts_on=6: Saturday 23:30 is still the old week', '0/2026-03-15', pg_temp.wallet(u));
  w := private.sync_wallet(u, '2026-03-22 00:30+00');
  perform pg_temp.chk('week_starts_on=6: Sunday 00:30 starts a new week', '1/2026-03-22', pg_temp.wallet(u));
  update public.settings set week_starts_on = 0 where user_id = u;
  update public.pass_wallet set week_starts_on = 0 where user_id = u;

  update public.settings set timezone = 'Asia/Tokyo' where user_id = u;
  update public.pass_wallet set balance = 0, timezone = 'Asia/Tokyo', last_granted_week_start = '2026-01-05' where user_id = u;
  w := private.sync_wallet(u, '2026-01-11 16:00+00');  -- Mon 01:00 in Tokyo, still Sunday in UTC
  perform pg_temp.chk('timezone: Sunday 16:00 UTC is Monday in Tokyo -> new week', '1/2026-01-12', pg_temp.wallet(u));
  update public.settings set timezone = 'UTC' where user_id = u;
  update public.pass_wallet set timezone = 'UTC' where user_id = u;

  perform pg_temp.chk('settings reject an unknown timezone',
    'time zone "Not/AZone" not recognized',
    pg_temp.err(format('update public.settings set timezone = %L where user_id = %L', 'Not/AZone', u)));
  perform pg_temp.chk('settings reject a POSIX-style timezone (UTC+5)',
    'time zone "UTC+5" not recognized',
    pg_temp.err(format('update public.settings set timezone = %L where user_id = %L', 'UTC+5', u)));
  perform pg_temp.chk('settings reject a POSIX-style timezone on insert',
    'time zone "EST5EDT4" not recognized',
    pg_temp.err(format('insert into public.settings (user_id, timezone) values (%L, %L)', u2, 'EST5EDT4')));
  perform pg_temp.chk('settings accept a real IANA timezone', 'ok',
    pg_temp.err(format('update public.settings set timezone = %L where user_id = %L', 'America/Argentina/Buenos_Aires', u)));
  update public.settings set timezone = 'UTC' where user_id = u;
  perform pg_temp.chk('settings reject pass_cap above 2 (check constraint)',
    'new row for relation "settings" violates check constraint "settings_pass_cap_range"',
    pg_temp.err(format('update public.settings set pass_cap = 3 where user_id = %L', u)));

  -- use_pass errors, in order: balance, past day, duplicate
  delete from public.cheat_days where user_id = u;
  update public.pass_wallet set balance = 0, last_granted_week_start = '2026-04-06' where user_id = u;

  perform pg_temp.chk('use_pass: balance 0 -> no_passes_left', 'no_passes_left',
    pg_temp.err(format('select private.use_pass(%L, %L, %L)', u, '2026-04-09', '2026-04-08 10:00+00')));
  perform pg_temp.chk('use_pass: balance 0 beats past day', 'no_passes_left',
    pg_temp.err(format('select private.use_pass(%L, %L, %L)', u, '2026-04-01', '2026-04-08 10:00+00')));

  update public.pass_wallet set balance = 1 where user_id = u;
  perform pg_temp.chk('use_pass: yesterday -> day_in_past', 'day_in_past',
    pg_temp.err(format('select private.use_pass(%L, %L, %L)', u, '2026-04-07', '2026-04-08 10:00+00')));
  perform pg_temp.chk('use_pass: null day -> invalid_day', 'invalid_day',
    pg_temp.err(format('select private.use_pass(%L, null, %L)', u, '2026-04-08 10:00+00')));
  perform pg_temp.chk('use_pass: failures leave the balance alone', '1/2026-04-06', pg_temp.wallet(u));

  w := private.use_pass(u, '2026-04-08', '2026-04-08 10:00+00');
  perform pg_temp.chk('use_pass: today is allowed, balance 1 -> 0', '0/2026-04-06', pg_temp.wallet(u));

  update public.pass_wallet set balance = 1 where user_id = u;
  perform pg_temp.chk('use_pass: same day twice -> already_cheat_day', 'already_cheat_day',
    pg_temp.err(format('select private.use_pass(%L, %L, %L)', u, '2026-04-08', '2026-04-08 10:00+00')));

  update public.pass_wallet set balance = 0 where user_id = u;
  perform pg_temp.chk('use_pass: balance 0 beats duplicate', 'no_passes_left',
    pg_temp.err(format('select private.use_pass(%L, %L, %L)', u, '2026-04-08', '2026-04-08 10:00+00')));

  insert into public.cheat_days (user_id, day) values (u, '2026-04-01');
  update public.pass_wallet set balance = 1 where user_id = u;
  perform pg_temp.chk('use_pass: past day beats duplicate', 'day_in_past',
    pg_temp.err(format('select private.use_pass(%L, %L, %L)', u, '2026-04-01', '2026-04-08 10:00+00')));

  -- Day boundaries use the user's timezone: 2026-04-08 23:30 UTC is already 04-09 in Tokyo.
  update public.settings set timezone = 'Asia/Tokyo' where user_id = u;
  update public.pass_wallet set timezone = 'Asia/Tokyo' where user_id = u;
  perform pg_temp.chk('use_pass: "today" is the wallet local day (Tokyo)', 'day_in_past',
    pg_temp.err(format('select private.use_pass(%L, %L, %L)', u, '2026-04-08', '2026-04-08 23:30+00')));
  update public.settings set timezone = 'UTC' where user_id = u;
  update public.pass_wallet set timezone = 'UTC' where user_id = u;

  -- refund_pass
  update public.pass_wallet set balance = 1 where user_id = u;
  w := private.use_pass(u, '2026-04-12', '2026-04-08 10:00+00');
  perform pg_temp.chk('refund setup: future cheat day spends the pass', '0/2026-04-06', pg_temp.wallet(u));
  w := private.refund_pass(u, '2026-04-12', '2026-04-08 10:00+00');
  perform pg_temp.chk('refund_pass: future day refunds the pass', '1/2026-04-06', pg_temp.wallet(u));
  perform pg_temp.chk('refund_pass: cheat day row is removed', '0',
    (select count(*)::text from public.cheat_days where user_id = u and day = '2026-04-12'));

  perform pg_temp.chk('refund_pass: today is not refundable', 'day_not_in_future',
    pg_temp.err(format('select private.refund_pass(%L, %L, %L)', u, '2026-04-08', '2026-04-08 10:00+00')));
  perform pg_temp.chk('refund_pass: past cheat day is not refundable', 'day_not_in_future',
    pg_temp.err(format('select private.refund_pass(%L, %L, %L)', u, '2026-04-01', '2026-04-08 10:00+00')));
  perform pg_temp.chk('refund_pass: day that is not a cheat day', 'not_a_cheat_day',
    pg_temp.err(format('select private.refund_pass(%L, %L, %L)', u, '2026-04-20', '2026-04-08 10:00+00')));
  perform pg_temp.chk('refund_pass: failures leave the balance alone', '1/2026-04-06', pg_temp.wallet(u));

  insert into public.cheat_days (user_id, day) values (u, '2026-04-15');
  update public.pass_wallet set balance = 2 where user_id = u;
  w := private.refund_pass(u, '2026-04-15', '2026-04-08 10:00+00');
  perform pg_temp.chk('refund_pass: respects the cap (2 stays 2)', '2/2026-04-06', pg_temp.wallet(u));

  -- ---- Wallet snapshot (hardening migration) ----

  -- M1: switching settings.timezone cannot move "today" for pass decisions.
  -- 2026-04-14 05:00 UTC is Tuesday in UTC, still Monday evening in Pago Pago.
  delete from public.cheat_days where user_id = u;
  update public.settings set timezone = 'Pacific/Pago_Pago', week_starts_on = 0 where user_id = u;
  update public.pass_wallet
  set balance = 1, timezone = 'UTC', week_starts_on = 0, last_granted_week_start = '2026-04-13',
      anchored_at = '2026-01-01 00:00+00'
  where user_id = u;
  insert into public.cheat_days (user_id, day) values (u, '2026-04-14');
  perform pg_temp.chk('snapshot: tz switch cannot refund today''s cheat day', 'day_not_in_future',
    pg_temp.err(format('select private.refund_pass(%L, %L, %L)', u, '2026-04-14', '2026-04-14 05:00+00')));
  perform pg_temp.chk('snapshot: tz switch cannot spend a pass on yesterday', 'day_in_past',
    pg_temp.err(format('select private.use_pass(%L, %L, %L)', u, '2026-04-13', '2026-04-14 05:00+00')));
  perform pg_temp.chk('snapshot: no boundary crossed, wallet keeps its own timezone and balance',
    '1/2026-04-13/UTC',
    pg_temp.wallet(u) || '/' || (select timezone from public.pass_wallet where user_id = u));
  delete from public.cheat_days where user_id = u;

  -- Settings are adopted at a grant boundary, after granting under the old snapshot.
  update public.settings set timezone = 'Asia/Tokyo', week_starts_on = 0 where user_id = u;
  update public.pass_wallet
  set balance = 0, timezone = 'UTC', week_starts_on = 0, last_granted_week_start = '2026-03-02'
  where user_id = u;
  w := private.sync_wallet(u, '2026-03-09 12:00+00');
  perform pg_temp.chk('snapshot: boundary grants, then adopts settings tz',
    '1/2026-03-09/Asia/Tokyo/0',
    pg_temp.wallet(u) || '/' || (select timezone || '/' || week_starts_on from public.pass_wallet where user_id = u));

  -- A week_starts_on that would put the next boundary under 7 days away is pushed out.
  update public.settings set timezone = 'UTC', week_starts_on = 6 where user_id = u;
  update public.pass_wallet
  set balance = 0, timezone = 'UTC', week_starts_on = 0, last_granted_week_start = '2026-03-02'
  where user_id = u;
  w := private.sync_wallet(u, '2026-03-09 12:00+00');
  perform pg_temp.chk('snapshot: adopted earlier week start is pushed out a week', '1/2026-03-15', pg_temp.wallet(u));
  w := private.sync_wallet(u, '2026-03-15 12:00+00');
  perform pg_temp.chk('snapshot: Sunday after the change grants nothing', '1/2026-03-15', pg_temp.wallet(u));
  w := private.sync_wallet(u, '2026-03-22 12:00+00');
  perform pg_temp.chk('snapshot: next Sunday grants again', '2/2026-03-22', pg_temp.wallet(u));

  -- Cycling week_starts_on every day must not farm passes: at most one grant
  -- per 7 days. The loop resets the balance each day so grants stay countable.
  update public.settings set timezone = 'UTC', week_starts_on = 0 where user_id = u;
  update public.pass_wallet
  set balance = 0, timezone = 'UTC', week_starts_on = 0, last_granted_week_start = '2026-06-01'
  where user_id = u;
  declare
    v_day date;
    v_grants integer := 0;
    v_prev_grant date;
    v_min_gap integer := 999;
  begin
    for i in 0..69 loop
      v_day := date '2026-06-02' + i;
      update public.settings set week_starts_on = i % 7 where user_id = u;
      w := private.sync_wallet(u, (v_day::text || ' 12:00+00')::timestamptz);
      if w.balance > 0 then
        v_grants := v_grants + 1;
        if v_prev_grant is not null then
          v_min_gap := least(v_min_gap, v_day - v_prev_grant);
        end if;
        v_prev_grant := v_day;
        update public.pass_wallet set balance = 0 where user_id = u;
      end if;
    end loop;
    perform pg_temp.chk('cycling week_starts_on daily: at most 10 grants in 10 weeks', 'true', (v_grants between 1 and 10)::text);
    perform pg_temp.chk('cycling week_starts_on daily: grants at least 7 days apart', 'true', (v_min_gap >= 7)::text);
  end;
  update public.settings set week_starts_on = 0 where user_id = u;

  -- New account: the first sync re-anchors to the client's settings, no grant.
  -- u2 signed up Sunday 23:00 UTC (week 2026-03-02) and then set Kiritimati, where it is Monday.
  update public.settings set timezone = 'Pacific/Kiritimati' where user_id = u2;
  update public.pass_wallet
  set balance = 1, timezone = 'UTC', week_starts_on = 0, last_granted_week_start = '2026-03-02', anchored_at = null
  where user_id = u2;
  w := private.sync_wallet(u2, '2026-03-08 23:30+00');
  perform pg_temp.chk('new account: first sync re-anchors without a grant', '1/2026-03-09', pg_temp.wallet(u2));
  perform pg_temp.chk('new account: wallet adopted the settings snapshot and is anchored',
    'Pacific/Kiritimati/0/true',
    (select timezone || '/' || week_starts_on || '/' || (anchored_at is not null)
     from public.pass_wallet where user_id = u2));
  update public.settings set timezone = 'Asia/Tokyo' where user_id = u2;
  w := private.sync_wallet(u2, '2026-03-08 23:40+00');
  perform pg_temp.chk('new account: anchors once, a later settings change waits for a boundary',
    '1/2026-03-09/Pacific/Kiritimati',
    pg_temp.wallet(u2) || '/' || (select timezone from public.pass_wallet where user_id = u2));

  -- M1 residual: a settings timezone switch timed at a weekly grant boundary.
  -- 2026-04-12 12:00 UTC is already Monday 04-13 in Kiritimati (+14), still Sunday 04-12
  -- in Pago Pago (-11). "Today" is the latest of: wallet zone before the sync, wallet
  -- zone after the sync, settings zone.
  delete from public.cheat_days where user_id = u;
  update public.settings set timezone = 'Pacific/Pago_Pago', week_starts_on = 0 where user_id = u;
  update public.pass_wallet
  set balance = 0, timezone = 'Pacific/Kiritimati', week_starts_on = 0, last_granted_week_start = '2026-04-06',
      anchored_at = '2026-01-01 00:00+00'
  where user_id = u;
  insert into public.cheat_days (user_id, day) values (u, '2026-04-13');
  perform pg_temp.chk('boundary tz switch: refund of a cheat day that started in the old zone fails',
    'day_not_in_future',
    pg_temp.err(format('select private.refund_pass(%L, %L, %L)', u, '2026-04-13', '2026-04-12 12:00+00')));
  perform pg_temp.chk('boundary tz switch: failed refund leaves wallet and cheat day alone',
    '0/2026-04-06/1',
    pg_temp.wallet(u) || '/' || (select count(*)::text from public.cheat_days where user_id = u and day = '2026-04-13'));

  -- The sync adopts Pago Pago and it sticks for the week; settings go back to Kiritimati.
  w := private.sync_wallet(u, '2026-04-12 12:00+00');
  perform pg_temp.chk('boundary tz switch: sync grants and adopts the new zone',
    '1/2026-04-13/Pacific/Pago_Pago',
    pg_temp.wallet(u) || '/' || (select timezone from public.pass_wallet where user_id = u));
  update public.settings set timezone = 'Pacific/Kiritimati' where user_id = u;
  -- Thursday 04-16 12:00 UTC is Friday 04-17 02:00 in Kiritimati; the 16th is a real yesterday.
  perform pg_temp.chk('boundary tz switch: switching back mid-week cannot spend a pass on yesterday',
    'day_in_past',
    pg_temp.err(format('select private.use_pass(%L, %L, %L)', u, '2026-04-16', '2026-04-16 12:00+00')));
  perform pg_temp.chk('boundary tz switch: today in settings zone is still spendable', 'ok',
    pg_temp.err(format('select private.use_pass(%L, %L, %L)', u, '2026-04-17', '2026-04-16 12:00+00')));
  delete from public.cheat_days where user_id = u;
  update public.settings set timezone = 'UTC' where user_id = u;
  update public.pass_wallet set timezone = 'UTC' where user_id = u;

  -- Self-heal
  delete from public.pass_wallet where user_id = u;
  delete from public.settings where user_id = u;
  w := private.sync_wallet(u, '2026-04-08 10:00+00');
  perform pg_temp.chk('self-heal: sync_wallet recreates missing rows with 1 pass', '1/2026-04-06', pg_temp.wallet(u));
  delete from public.pass_wallet where user_id = u;
  delete from public.settings where user_id = u;
  w := private.use_pass(u, '2026-04-09', '2026-04-08 10:00+00');
  perform pg_temp.chk('self-heal: use_pass recreates missing rows then spends', '0/2026-04-06', pg_temp.wallet(u));

  -- Public wrappers use auth.uid() (JWT claims) and the real clock.
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform pg_temp.chk('public.sync_wallet without a session -> not_authenticated', 'not_authenticated',
    pg_temp.err('select public.sync_wallet()'));
  perform pg_temp.chk('public.use_pass without a session -> not_authenticated', 'not_authenticated',
    pg_temp.err('select public.use_pass(current_date + 5)'));
  perform pg_temp.chk('public.refund_pass without a session -> not_authenticated', 'not_authenticated',
    pg_temp.err('select public.refund_pass(current_date + 5)'));

  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', u::text, true);
  update public.pass_wallet
  set balance = 1, last_granted_week_start = private.week_start(now(), 'UTC', 0)
  where user_id = u;
  r := public.use_pass((now() + interval '30 days')::date);
  perform pg_temp.chk('public.use_pass returns the new wallet as json', '0', r ->> 'balance');
  r := public.refund_pass((now() + interval '30 days')::date);
  perform pg_temp.chk('public.refund_pass returns the new wallet as json', '1', r ->> 'balance');
  r := public.sync_wallet();
  perform pg_temp.chk('public.sync_wallet returns balance and week start',
    '1/' || private.week_start(now(), 'UTC', 0),
    (r ->> 'balance') || '/' || (r ->> 'last_granted_week_start'));
  perform pg_temp.chk('public RPC json also carries the wallet timezone and week start',
    'UTC/0',
    (r ->> 'timezone') || '/' || (r ->> 'week_starts_on'));
end;
$$;

-- Client-facing permissions: run as the roles PostgREST uses.
do $$
declare
  u uuid := (select user_id from pg_temp.ctx);
  other uuid := gen_random_uuid();
  seen_own integer;
  seen_other integer;
  e_wallet_update text := 'ok';
  e_cheat_insert text := 'ok';
  e_cheat_delete text := 'ok';
  e_foreign_event text := 'ok';
  e_event_update text := 'ok';
  e_anon_select text := 'ok';
  e_anon_rpc text := 'ok';
  e_authed_private text := 'ok';
  e_cap_update text := 'ok';
  e_cap_insert text := 'ok';
  e_user_id_update text := 'ok';
  e_settings_delete text := 'ok';
  e_posix_insert text := 'ok';
  e_posix_update text := 'ok';
  e_settings_ok text := 'ok';
  e_truncate text := 'ok';
  v_cap integer;
  v_event uuid;
  v_updated_changed boolean;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;

  select count(*) into seen_own from public.pass_wallet;
  begin update public.pass_wallet set balance = 99; exception when others then e_wallet_update := sqlerrm; end;
  begin insert into public.cheat_days (day) values ('2030-01-01'); exception when others then e_cheat_insert := sqlerrm; end;
  begin delete from public.cheat_days; exception when others then e_cheat_delete := sqlerrm; end;
  begin
    insert into public.events (user_id, title, start_at) values (other, 'forged', now());
  exception when others then e_foreign_event := sqlerrm; end;
  begin perform private.sync_wallet(u, now()); exception when others then e_authed_private := sqlerrm; end;
  begin update public.settings set pass_cap = 2 where user_id = u; exception when others then e_cap_update := sqlerrm; end;
  begin insert into public.settings (user_id, pass_cap) values (other, 2); exception when others then e_cap_insert := sqlerrm; end;
  begin update public.settings set user_id = other where user_id = u; exception when others then e_user_id_update := sqlerrm; end;
  begin delete from public.settings where user_id = u; exception when others then e_settings_delete := sqlerrm; end;
  begin insert into public.settings (user_id, timezone) values (other, 'UTC+5'); exception when others then e_posix_insert := sqlerrm; end;
  begin update public.settings set timezone = 'UTC+5' where user_id = u; exception when others then e_posix_update := sqlerrm; end;
  begin
    update public.settings set timezone = 'Europe/Paris', week_starts_on = 6, refire_seconds = 60, grace_minutes = 10 where user_id = u;
  exception when others then e_settings_ok := sqlerrm; end;
  begin truncate public.cheat_days; exception when others then e_truncate := sqlerrm; end;
  select pass_cap into v_cap from public.settings where user_id = u;

  insert into public.events (title, start_at) values ('own event', '2026-05-01 08:00+00') returning id into v_event;
  begin
    update public.events set updated_at = '2000-01-01', title = 'renamed' where id = v_event;
  exception when others then e_event_update := sqlerrm; end;
  select updated_at > '2020-01-01' into v_updated_changed from public.events where id = v_event;

  perform set_config('request.jwt.claims', json_build_object('sub', other, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', other::text, true);
  select count(*) into seen_other from public.events;

  reset role;
  set local role anon;
  begin perform 1 from public.events; exception when others then e_anon_select := sqlerrm; end;
  begin perform public.sync_wallet(); exception when others then e_anon_rpc := sqlerrm; end;
  reset role;

  perform pg_temp.chk('authenticated can read own wallet', '1', seen_own::text);
  perform pg_temp.chk('authenticated cannot update the wallet directly', 'permission denied for table pass_wallet', e_wallet_update);
  perform pg_temp.chk('authenticated cannot insert cheat days directly', 'permission denied for table cheat_days', e_cheat_insert);
  perform pg_temp.chk('authenticated cannot delete cheat days directly', 'permission denied for table cheat_days', e_cheat_delete);
  perform pg_temp.chk('authenticated cannot insert an event for another user', 'new row violates row-level security policy for table "events"', e_foreign_event);
  perform pg_temp.chk('authenticated cannot call private functions', 'permission denied for schema private', e_authed_private);
  perform pg_temp.chk('authenticated can update own event (updated_at trigger runs)', 'ok', e_event_update);
  perform pg_temp.chk('updated_at trigger overrides the client value', 'true', v_updated_changed::text);
  perform pg_temp.chk('another user sees none of these events', '0', seen_other::text);
  perform pg_temp.chk('authenticated cannot update pass_cap', 'permission denied for table settings', e_cap_update);
  perform pg_temp.chk('authenticated cannot insert pass_cap', 'permission denied for table settings', e_cap_insert);
  perform pg_temp.chk('authenticated cannot update settings.user_id', 'permission denied for table settings', e_user_id_update);
  perform pg_temp.chk('authenticated cannot delete settings', 'permission denied for table settings', e_settings_delete);
  perform pg_temp.chk('authenticated cannot insert a POSIX timezone', 'time zone "UTC+5" not recognized', e_posix_insert);
  perform pg_temp.chk('authenticated cannot update to a POSIX timezone', 'time zone "UTC+5" not recognized', e_posix_update);
  perform pg_temp.chk('authenticated can still update tz, week start, refire and grace', 'ok', e_settings_ok);
  perform pg_temp.chk('authenticated cannot truncate cheat_days', 'permission denied for table cheat_days', e_truncate);
  perform pg_temp.chk('pass_cap is still 2 after the attempts', '2', v_cap::text);
  perform pg_temp.chk('anon cannot select events', 'permission denied for table events', e_anon_select);
  perform pg_temp.chk('anon cannot call public.sync_wallet', 'permission denied for function sync_wallet', e_anon_rpc);
end;
$$;

-- Table constraints
do $$
declare
  u uuid := (select user_id from pg_temp.ctx);
begin
  perform pg_temp.chk('check: max_snoozes 11 rejected', 'new row for relation "events" violates check constraint "events_max_snoozes_check"',
    pg_temp.err(format('insert into public.events (user_id, title, start_at, max_snoozes) values (%L, %L, now(), 11)', u, 't')));
  perform pg_temp.chk('check: repeat_interval 0 rejected', 'new row for relation "events" violates check constraint "events_repeat_interval_check"',
    pg_temp.err(format('insert into public.events (user_id, title, start_at, repeat_interval) values (%L, %L, now(), 0)', u, 't')));
  perform pg_temp.chk('check: weekday 7 rejected', 'new row for relation "events" violates check constraint "events_repeat_weekdays_check"',
    pg_temp.err(format('insert into public.events (user_id, title, start_at, repeat_weekdays) values (%L, %L, now(), %L)', u, 't', '{0,7}')));
  perform pg_temp.chk('check: snooze_minutes 0 rejected', 'new row for relation "events" violates check constraint "events_snooze_minutes_check"',
    pg_temp.err(format('insert into public.events (user_id, title, start_at, snooze_minutes) values (%L, %L, now(), 0)', u, 't')));
  perform pg_temp.chk('check: valid event with Mon+Thu weekly accepted', 'ok',
    pg_temp.err(format('insert into public.events (user_id, title, start_at, repeat_unit, repeat_interval, repeat_weekdays) values (%L, %L, now(), %L, 2, %L)', u, 'biweekly', 'week', '{0,3}')));
end;
$$;

select n, name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from pg_temp.results
union all
select 9999, 'SUMMARY', count(*) filter (where pass) || ' passed', count(*) filter (where not pass) || ' failed',
  case when bool_and(pass) then 'PASS' else 'FAIL' end
from pg_temp.results
order by n;

rollback;
