-- Read-only catalog checks: RLS on every table, no client write path to the
-- wallet, column-level writes on settings, no TRUNCATE/REFERENCES/TRIGGER, and
-- RPC execute rights. Every row must say PASS.
--   supabase db query --linked -f supabase/tests/security_checks.sql
select 'rls enabled: ' || c.relname as name, 'true' as expected, c.relrowsecurity::text as actual,
  case when c.relrowsecurity then 'PASS' else 'FAIL' end as result
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('events', 'completions', 'settings', 'pass_wallet', 'cheat_days')
union all
select 'policy count: ' || t, expected::text, coalesce(p.cnt, 0)::text,
  case when coalesce(p.cnt, 0) = expected then 'PASS' else 'FAIL' end
from (values ('events', 4), ('completions', 4), ('settings', 3), ('pass_wallet', 1), ('cheat_days', 1)) as v(t, expected)
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
  ('anon', 'events', 'SELECT', false), ('anon', 'pass_wallet', 'SELECT', false)
) as t(role, tbl, priv, expected)
union all
-- TRUNCATE, REFERENCES and TRIGGER are never needed by a client role.
select format('%s can %s %s', role, priv, tbl), 'false',
  has_table_privilege(role, 'public.' || tbl, priv)::text,
  case when has_table_privilege(role, 'public.' || tbl, priv) then 'FAIL' else 'PASS' end
from unnest(array['anon', 'authenticated']) as role
cross join unnest(array['TRUNCATE', 'REFERENCES', 'TRIGGER']) as priv
cross join unnest(array['events', 'completions', 'settings', 'pass_wallet', 'cheat_days']) as tbl
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
  ('anon', 'private.use_pass(uuid,date,timestamptz)', false), ('authenticated', 'private.use_pass(uuid,date,timestamptz)', false),
  ('authenticated', 'private.pass_today(timestamptz,text,text,text)', false), ('anon', 'private.pass_today(timestamptz,text,text,text)', false),
  ('authenticated', 'private.sync_wallet(uuid,timestamptz)', false), ('authenticated', 'private.refund_pass(uuid,date,timestamptz)', false)
) as f(role, fn, expected)
union all
select 'realtime publication has ' || t, 'true',
  exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t)::text,
  case when exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then 'PASS' else 'FAIL' end
from unnest(array['events', 'completions', 'cheat_days', 'settings']) as t
order by 1;
