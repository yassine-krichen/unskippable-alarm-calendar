-- repeat_unit 'year' (roadmap-v2 phase 2): yearly repeat on the same day and month as start_at,
-- Feb 29 landing on Feb 28 in common years. The recurrence rule lives in packages/core.
--
-- ALTER TYPE ... ADD VALUE is not rolled back with its transaction, and the new value cannot be
-- used until this migration has committed. This file only adds it, so nothing here depends on it.
--
-- Down (manual): Postgres cannot drop an enum value. Remove every events row that uses 'year'
--                (or switch it to another unit) and, if the value must go, recreate the type.

alter type public.repeat_unit add value if not exists 'year';
