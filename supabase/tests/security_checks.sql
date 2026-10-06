-- Read-only catalog checks: RLS on every table, no client write path to the
-- wallet, column-level writes on settings, no TRUNCATE/REFERENCES/TRIGGER, and
-- RPC execute rights. Every row must say PASS.
--   supabase db query --linked -f supabase/tests/security_checks.sql
select 'rls enabled: ' || c.relname as name, 'true' as expected, c.relrowsecurity::text as actual,
  case when c.relrowsecurity then 'PASS' else 'FAIL' end as result
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('events', 'completions', 'settings', 'pass_wallet', 'cheat_days', 'exams', 'modes', 'mode_rules', 'mode_activations')
union all
select 'policy count: ' || t, expected::text, coalesce(p.cnt, 0)::text,
  case when coalesce(p.cnt, 0) = expected then 'PASS' else 'FAIL' end
from (values ('events', 4), ('completions', 4), ('settings', 3), ('pass_wallet', 1), ('cheat_days', 1), ('exams', 4), ('modes', 4), ('mode_rules', 4), ('mode_activations', 4)) as v(t, expected)
left join (select tablename, count(*) cnt from pg_policies where schemaname = 'public' group by tablename) p on p.tablename = v.t
union all
select 'policies only to authenticated: ' || tablename, 'true', bool_and(roles = '{authenticated}')::text,
  case when bool_and(roles = '{authenticated}') then 'PASS' else 'FAIL' end
from pg_policies where schemaname = 'public' group by tablename
union all
select format('%s can %s %s', role, priv, tbl), expected::text,
  has_table_privilege(role, 'public.' || tbl, priv)::text,
  case when has_table_privilege(role, 'public.' || tbl, priv) = expected then 'PASS' else 'FAIL' end
from (values
  ('authenticated', 'pass_wallet', 'INSERT', false), ('authenticated', 'pass_wallet', 'UPDATE', false),
  ('authenticated', 'pass_wallet', 'DELETE', false), ('authenticated', 'cheat_days', 'INSERT', false),
  ('authenticated', 'cheat_days', 'UPDATE', false), ('authenticated', 'cheat_days', 'DELETE', false),
  ('authenticated', 'pass_wallet', 'SELECT', true), ('authenticated', 'cheat_days', 'SELECT', true),
  ('anon', 'events', 'SELECT', false), ('anon', 'pass_wallet', 'SELECT', false),
  ('anon', 'exams', 'SELECT', false), ('anon', 'exams', 'INSERT', false), ('anon', 'exams', 'UPDATE', false), ('anon', 'exams', 'DELETE', false),
  ('authenticated', 'exams', 'SELECT', true), ('authenticated', 'exams', 'INSERT', true),
  ('authenticated', 'exams', 'UPDATE', true), ('authenticated', 'exams', 'DELETE', true),
  ('anon', 'modes', 'SELECT', false), ('anon', 'modes', 'INSERT', false), ('anon', 'modes', 'UPDATE', false), ('anon', 'modes', 'DELETE', false),
  ('anon', 'mode_rules', 'SELECT', false), ('anon', 'mode_rules', 'INSERT', false), ('anon', 'mode_rules', 'UPDATE', false), ('anon', 'mode_rules', 'DELETE', false),
  ('anon', 'mode_activations', 'SELECT', false), ('anon', 'mode_activations', 'INSERT', false), ('anon', 'mode_activations', 'UPDATE', false), ('anon', 'mode_activations', 'DELETE', false),
  ('authenticated', 'modes', 'SELECT', true), ('authenticated', 'modes', 'DELETE', true),
  ('authenticated', 'mode_rules', 'SELECT', true), ('authenticated', 'mode_rules', 'INSERT', true), ('authenticated', 'mode_rules', 'UPDATE', true), ('authenticated', 'mode_rules', 'DELETE', true),
  ('authenticated', 'mode_activations', 'SELECT', true), ('authenticated', 'mode_activations', 'INSERT', true), ('authenticated', 'mode_activations', 'UPDATE', true), ('authenticated', 'mode_activations', 'DELETE', true)
) as t(role, tbl, priv, expected)
union all
-- TRUNCATE, REFERENCES and TRIGGER are never needed by a client role.
select format('%s can %s %s', role, priv, tbl), 'false',
  has_table_privilege(role, 'public.' || tbl, priv)::text,
  case when has_table_privilege(role, 'public.' || tbl, priv) then 'FAIL' else 'PASS' end
from unnest(array['anon', 'authenticated']) as role
cross join unnest(array['TRUNCATE', 'REFERENCES', 'TRIGGER']) as priv
cross join unnest(array['events', 'completions', 'settings', 'pass_wallet', 'cheat_days', 'exams', 'modes', 'mode_rules', 'mode_activations']) as tbl
union all
-- settings is writable by column: pass_cap must stay out of reach, and so must
-- the table-level privileges that would imply every column.
select format('authenticated can %s settings.%s', priv, col), expected::text,
  has_column_privilege('authenticated', 'public.settings', col, priv)::text,
  case when has_column_privilege('authenticated', 'public.settings', col, priv) = expected then 'PASS' else 'FAIL' end
from (values
  ('pass_cap', 'INSERT', false), ('pass_cap', 'UPDATE', false),
  ('user_id', 'UPDATE', false), ('user_id', 'INSERT', true),
  ('timezone', 'INSERT', true), ('timezone', 'UPDATE', true),
  ('week_starts_on', 'INSERT', true), ('week_starts_on', 'UPDATE', true),
  ('refire_seconds', 'INSERT', true), ('refire_seconds', 'UPDATE', true),
  ('grace_minutes', 'INSERT', true), ('grace_minutes', 'UPDATE', true),
  ('pass_cap', 'SELECT', true)
) as c(col, priv, expected)
union all
-- Prayer settings (prayer_times migration): every new column is client-writable by authenticated, on insert
-- and on update, and anon holds no privilege on any of them.
select format('%s can %s settings.%s', role, priv, col), expected::text,
  has_column_privilege(role, 'public.settings', col, priv)::text,
  case when has_column_privilege(role, 'public.settings', col, priv) = expected then 'PASS' else 'FAIL' end
from unnest(array[
  'prayers_enabled', 'prayers_enabled_since', 'latitude', 'longitude', 'location_label', 'fajr_angle', 'isha_angle',
  'asr_factor', 'fajr_offset_min', 'dhuhr_offset_min', 'asr_offset_min', 'maghrib_offset_min', 'isha_offset_min',
  'pre_prayer_minutes', 'prayer_max_snoozes', 'prayer_snooze_minutes'
]) as col
cross join (values
  ('authenticated', 'INSERT', true), ('authenticated', 'UPDATE', true), ('authenticated', 'SELECT', true),
  ('anon', 'INSERT', false), ('anon', 'UPDATE', false), ('anon', 'SELECT', false)
) as g(role, priv, expected)
union all
select 'authenticated can ' || priv || ' settings (table level)', 'false',
  has_table_privilege('authenticated', 'public.settings', priv)::text,
  case when has_table_privilege('authenticated', 'public.settings', priv) then 'FAIL' else 'PASS' end
from unnest(array['INSERT', 'UPDATE', 'DELETE']) as priv
union all
select 'pass_wallet has no column writable by authenticated: ' || a.attname, 'false',
  (has_column_privilege('authenticated', 'public.pass_wallet', a.attname, 'INSERT')
   or has_column_privilege('authenticated', 'public.pass_wallet', a.attname, 'UPDATE'))::text,
  case when has_column_privilege('authenticated', 'public.pass_wallet', a.attname, 'INSERT')
        or has_column_privilege('authenticated', 'public.pass_wallet', a.attname, 'UPDATE') then 'FAIL' else 'PASS' end
from pg_attribute a
where a.attrelid = 'public.pass_wallet'::regclass and a.attnum > 0 and not a.attisdropped
union all
select 'settings has pass_cap range check', 'true',
  exists (select 1 from pg_constraint where conrelid = 'public.settings'::regclass and conname = 'settings_pass_cap_range')::text,
  case when exists (select 1 from pg_constraint where conrelid = 'public.settings'::regclass and conname = 'settings_pass_cap_range') then 'PASS' else 'FAIL' end
union all
select format('%s can execute %s', role, fn), expected::text,
  has_function_privilege(role, fn, 'EXECUTE')::text,
  case when has_function_privilege(role, fn, 'EXECUTE') = expected then 'PASS' else 'FAIL' end
from (values
  ('anon', 'public.sync_wallet()', false), ('anon', 'public.use_pass(date)', false), ('anon', 'public.refund_pass(date)', false),
  ('authenticated', 'public.sync_wallet()', true), ('authenticated', 'public.use_pass(date)', true), ('authenticated', 'public.refund_pass(date)', true),
  ('anon', 'public.set_prayers_enabled(boolean)', false), ('authenticated', 'public.set_prayers_enabled(boolean)', true),
  ('anon', 'public.ensure_builtin_modes()', false), ('authenticated', 'public.ensure_builtin_modes()', true),
  ('anon', 'public.set_manual_mode(uuid,timestamptz,timestamptz)', false), ('authenticated', 'public.set_manual_mode(uuid,timestamptz,timestamptz)', true),
  ('anon', 'private.use_pass(uuid,date,timestamptz)', false), ('authenticated', 'private.use_pass(uuid,date,timestamptz)', false),
  ('authenticated', 'private.pass_today(timestamptz,text,text,text)', false), ('anon', 'private.pass_today(timestamptz,text,text,text)', false),
  ('authenticated', 'private.sync_wallet(uuid,timestamptz)', false), ('authenticated', 'private.refund_pass(uuid,date,timestamptz)', false)
) as f(role, fn, expected)
union all
select 'realtime publication has ' || t, 'true',
  exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t)::text,
  case when exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then 'PASS' else 'FAIL' end
from unnest(array['events', 'completions', 'cheat_days', 'settings', 'exams', 'modes', 'mode_rules', 'mode_activations']) as t
union all
-- events.created_at is table-writable by the client roles, so a trigger must pin it
-- (set on insert, unchanged on update). Needs the events_created_at migration.
select 'events has the created_at pin trigger', 'true',
  exists (select 1 from pg_trigger where tgrelid = 'public.events'::regclass and tgname = 'events_pin_created_at' and not tgisinternal)::text,
  case when exists (select 1 from pg_trigger where tgrelid = 'public.events'::regclass and tgname = 'events_pin_created_at' and not tgisinternal) then 'PASS' else 'FAIL' end
union all
select 'events.created_at is not null', 'true',
  coalesce((select a.attnotnull from pg_attribute a where a.attrelid = 'public.events'::regclass and a.attname = 'created_at' and not a.attisdropped), false)::text,
  case when coalesce((select a.attnotnull from pg_attribute a where a.attrelid = 'public.events'::regclass and a.attname = 'created_at' and not a.attisdropped), false) then 'PASS' else 'FAIL' end
union all
-- Prayer rows (prayer_times migration): a prayer row names its prayer, and a user has at most one
-- row per (kind, prayer). Both are enforced by the database, not the app.
select 'events has the prayer shape check and the unique index', 'true',
  (exists (select 1 from pg_constraint where conrelid = 'public.events'::regclass and conname = 'events_prayer_shape')
   and exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'events_prayer_unique'))::text,
  case when exists (select 1 from pg_constraint where conrelid = 'public.events'::regclass and conname = 'events_prayer_shape')
        and exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'events_prayer_unique') then 'PASS' else 'FAIL' end
union all
-- Exams (exams_and_revision migration): the catch-up idempotency rests on a plain unique index on
-- events.catch_up_of (the app inserts with ON CONFLICT (catch_up_of) DO NOTHING, which cannot name a partial
-- index), one active exam alarm per exam, and the shape checks.
select 'events has the exam link columns', 'true',
  (select count(*) = 3 from pg_attribute a where a.attrelid = 'public.events'::regclass and not a.attisdropped
     and a.attname in ('exam_id', 'exam_role', 'catch_up_of'))::text,
  case when (select count(*) = 3 from pg_attribute a where a.attrelid = 'public.events'::regclass and not a.attisdropped
     and a.attname in ('exam_id', 'exam_role', 'catch_up_of')) then 'PASS' else 'FAIL' end
union all
select 'events.catch_up_of has a plain unique index', 'true',
  exists (select 1 from pg_index i join pg_class c on c.oid = i.indexrelid
          where i.indrelid = 'public.events'::regclass and c.relname = 'events_catch_up_of_unique'
            and i.indisunique and i.indpred is null)::text,
  case when exists (select 1 from pg_index i join pg_class c on c.oid = i.indexrelid
          where i.indrelid = 'public.events'::regclass and c.relname = 'events_catch_up_of_unique'
            and i.indisunique and i.indpred is null) then 'PASS' else 'FAIL' end
union all
select 'events has the one-exam-alarm unique index and the exam checks', 'true',
  (exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'events_exam_alarm_unique')
   and exists (select 1 from pg_constraint where conrelid = 'public.events'::regclass and conname = 'events_exam_role_values')
   and exists (select 1 from pg_constraint where conrelid = 'public.events'::regclass and conname = 'events_catch_up_shape'))::text,
  case when exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'events_exam_alarm_unique')
        and exists (select 1 from pg_constraint where conrelid = 'public.events'::regclass and conname = 'events_exam_role_values')
        and exists (select 1 from pg_constraint where conrelid = 'public.events'::regclass and conname = 'events_catch_up_shape') then 'PASS' else 'FAIL' end
union all
select 'events insert and update policies check the exam link', 'true',
  (select bool_and(coalesce(with_check, '') like '%exams%') from pg_policies
   where schemaname = 'public' and tablename = 'events' and policyname in ('events_insert', 'events_update'))::text,
  case when (select bool_and(coalesce(with_check, '') like '%exams%') from pg_policies
   where schemaname = 'public' and tablename = 'events' and policyname in ('events_insert', 'events_update')) then 'PASS' else 'FAIL' end
union all
select 'exams has the updated_at trigger and the difficulty check', 'true',
  (exists (select 1 from pg_trigger where tgrelid = 'public.exams'::regclass and tgname = 'exams_set_updated_at' and not tgisinternal)
   and exists (select 1 from pg_constraint where conrelid = 'public.exams'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%difficulty%'))::text,
  case when exists (select 1 from pg_trigger where tgrelid = 'public.exams'::regclass and tgname = 'exams_set_updated_at' and not tgisinternal)
        and exists (select 1 from pg_constraint where conrelid = 'public.exams'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%difficulty%') then 'PASS' else 'FAIL' end
union all
-- catch_up_of must belong to the caller (rls.owns_event, security definer, in a schema PostgREST does not expose).
select 'events insert and update policies check that catch_up_of is owned', 'true',
  (select bool_and(coalesce(with_check, '') like '%catch_up_of%' and coalesce(with_check, '') like '%owns_event%') from pg_policies
   where schemaname = 'public' and tablename = 'events' and policyname in ('events_insert', 'events_update'))::text,
  case when (select bool_and(coalesce(with_check, '') like '%catch_up_of%' and coalesce(with_check, '') like '%owns_event%') from pg_policies
   where schemaname = 'public' and tablename = 'events' and policyname in ('events_insert', 'events_update')) then 'PASS' else 'FAIL' end
union all
select format('%s can execute rls.owns_event(uuid)', role), expected::text,
  has_function_privilege(role, 'rls.owns_event(uuid)', 'EXECUTE')::text,
  case when has_function_privilege(role, 'rls.owns_event(uuid)', 'EXECUTE') = expected then 'PASS' else 'FAIL' end
from (values ('anon', false), ('authenticated', true)) as f(role, expected)
union all
select format('%s has usage on schema %s', role, sch), expected::text,
  has_schema_privilege(role, sch, 'USAGE')::text,
  case when has_schema_privilege(role, sch, 'USAGE') = expected then 'PASS' else 'FAIL' end
from (values ('anon', 'rls', false), ('authenticated', 'rls', true), ('anon', 'private', false), ('authenticated', 'private', false)) as f(role, sch, expected)
union all
select 'rls.owns_event is security definer with a fixed search_path', 'true',
  coalesce((select (p.prosecdef and coalesce(p.proconfig::text, '') like '%search_path%') from pg_proc p
    where p.oid = 'rls.owns_event(uuid)'::regprocedure), false)::text,
  case when coalesce((select (p.prosecdef and coalesce(p.proconfig::text, '') like '%search_path%') from pg_proc p
    where p.oid = 'rls.owns_event(uuid)'::regprocedure), false) then 'PASS' else 'FAIL' end
union all
-- Modes (modes migration). The identity of a mode (kind, builtin_key) is fixed at insert and user_id is never
-- client-writable; settings.exam_mode_days_before is.
select format('authenticated can %s modes.%s', priv, col), expected::text,
  has_column_privilege('authenticated', 'public.modes', col, priv)::text,
  case when has_column_privilege('authenticated', 'public.modes', col, priv) = expected then 'PASS' else 'FAIL' end
from (values
  ('name', 'INSERT', true), ('kind', 'INSERT', true), ('builtin_key', 'INSERT', true), ('default_behavior', 'INSERT', true), ('active', 'INSERT', true),
  ('user_id', 'INSERT', false), ('user_id', 'UPDATE', false),
  ('name', 'UPDATE', true), ('default_behavior', 'UPDATE', true), ('active', 'UPDATE', true),
  ('kind', 'UPDATE', false), ('builtin_key', 'UPDATE', false)
) as c(col, priv, expected)
union all
select format('%s can %s settings.exam_mode_days_before', role, priv), expected::text,
  has_column_privilege(role, 'public.settings', 'exam_mode_days_before', priv)::text,
  case when has_column_privilege(role, 'public.settings', 'exam_mode_days_before', priv) = expected then 'PASS' else 'FAIL' end
from (values
  ('authenticated', 'INSERT', true), ('authenticated', 'UPDATE', true), ('authenticated', 'SELECT', true),
  ('anon', 'INSERT', false), ('anon', 'UPDATE', false), ('anon', 'SELECT', false)
) as g(role, priv, expected)
union all
select 'modes has the unique built-in index and the shape check', 'true',
  (exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'modes_builtin_unique')
   and exists (select 1 from pg_constraint where conrelid = 'public.modes'::regclass and conname = 'modes_builtin_shape'))::text,
  case when exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'modes_builtin_unique')
        and exists (select 1 from pg_constraint where conrelid = 'public.modes'::regclass and conname = 'modes_builtin_shape') then 'PASS' else 'FAIL' end
union all
select 'mode_rules has the shift and shorten shape checks and one rule per mode and alarm', 'true',
  (exists (select 1 from pg_constraint where conrelid = 'public.mode_rules'::regclass and conname = 'mode_rules_shift_shape')
   and exists (select 1 from pg_constraint where conrelid = 'public.mode_rules'::regclass and conname = 'mode_rules_shorten_shape')
   and exists (select 1 from pg_constraint where conrelid = 'public.mode_rules'::regclass and conname = 'mode_rules_mode_event_unique'))::text,
  case when exists (select 1 from pg_constraint where conrelid = 'public.mode_rules'::regclass and conname = 'mode_rules_shift_shape')
        and exists (select 1 from pg_constraint where conrelid = 'public.mode_rules'::regclass and conname = 'mode_rules_shorten_shape')
        and exists (select 1 from pg_constraint where conrelid = 'public.mode_rules'::regclass and conname = 'mode_rules_mode_event_unique') then 'PASS' else 'FAIL' end
union all
-- mode_id and event_id are foreign keys (the check ignores RLS), so the write policies must verify ownership.
select 'mode_rules write policies check mode and alarm ownership', 'true',
  (select bool_and(coalesce(with_check, '') like '%modes%' and coalesce(with_check, '') like '%events%') from pg_policies
   where schemaname = 'public' and tablename = 'mode_rules' and policyname in ('mode_rules_insert', 'mode_rules_update'))::text,
  case when (select bool_and(coalesce(with_check, '') like '%modes%' and coalesce(with_check, '') like '%events%') from pg_policies
   where schemaname = 'public' and tablename = 'mode_rules' and policyname in ('mode_rules_insert', 'mode_rules_update')) then 'PASS' else 'FAIL' end
union all
select 'mode_activations write policies check mode ownership', 'true',
  (select bool_and(coalesce(with_check, '') like '%modes%') from pg_policies
   where schemaname = 'public' and tablename = 'mode_activations' and policyname in ('mode_activations_insert', 'mode_activations_update'))::text,
  case when (select bool_and(coalesce(with_check, '') like '%modes%') from pg_policies
   where schemaname = 'public' and tablename = 'mode_activations' and policyname in ('mode_activations_insert', 'mode_activations_update')) then 'PASS' else 'FAIL' end
union all
select 'mode_activations has the order and bounded-range checks', 'true',
  (exists (select 1 from pg_constraint where conrelid = 'public.mode_activations'::regclass and conname = 'mode_activations_order')
   and exists (select 1 from pg_constraint where conrelid = 'public.mode_activations'::regclass and conname = 'mode_activations_range_bounded'))::text,
  case when exists (select 1 from pg_constraint where conrelid = 'public.mode_activations'::regclass and conname = 'mode_activations_order')
        and exists (select 1 from pg_constraint where conrelid = 'public.mode_activations'::regclass and conname = 'mode_activations_range_bounded') then 'PASS' else 'FAIL' end
union all
select 'the mode RPCs are security invoker with a fixed search_path', 'true',
  (select bool_and(not p.prosecdef and coalesce(p.proconfig::text, '') like '%search_path%') from pg_proc p
   where p.oid in ('public.ensure_builtin_modes()'::regprocedure, 'public.set_manual_mode(uuid,timestamptz,timestamptz)'::regprocedure))::text,
  case when (select bool_and(not p.prosecdef and coalesce(p.proconfig::text, '') like '%search_path%') from pg_proc p
   where p.oid in ('public.ensure_builtin_modes()'::regprocedure, 'public.set_manual_mode(uuid,timestamptz,timestamptz)'::regprocedure)) then 'PASS' else 'FAIL' end
order by 1;
