-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for the one shared limit on error
-- emails (migration 20261121170000_error_email_shared_cap.sql, N18).
--   Part 1  shape: the single-row table, RLS with no policies and no
--           grants, claim_error_email_slot() rights and grants.
--   Part 2  the count: per day, the hour gap, a new UTC day, the hour
--           gap across midnight, bad arguments.
--   Part 3  the rollback file and running the migration again.
--
-- Run from the repo root (run-sql-tests.sh gives it its own database):
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/108_error_email_shared_cap.test.sql

set client_min_messages = warning;

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

-- Runs one statement as the given role; 'OK' or the error.
create function pg_temp.run_as(p_role text, p_sql text) returns text
  language plpgsql as $$
declare
  v_out text;
begin
  execute format('set role %I', p_role);
  begin
    execute p_sql;
    v_out := 'OK';
  exception when others then
    v_out := sqlerrm;
  end;
  reset role;
  return v_out;
end;
$$;

-- ------------------------------------------------------------
-- Part 1: shape
-- ------------------------------------------------------------
select pg_temp.assert(
  (select relrowsecurity from pg_class where oid = 'public.error_email_throttle'::regclass),
  'part1: RLS is on');
select pg_temp.assert(
  not exists (select 1 from pg_policy where polrelid = 'public.error_email_throttle'::regclass),
  'part1: no policies');
select pg_temp.assert(
  not has_table_privilege(r, 'public.error_email_throttle', p),
  format('part1: %s has no %s on the table', r, p))
from unnest(array['anon', 'authenticated', 'service_role']) r,
     unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p;

select pg_temp.assert(
  (select prosecdef and proconfig = array['search_path=""']
     from pg_proc where oid = 'public.claim_error_email_slot(integer, integer)'::regprocedure),
  'part1: security definer with an empty search_path');
select pg_temp.assert(
  has_function_privilege('service_role', 'public.claim_error_email_slot(integer, integer)', 'EXECUTE'),
  'part1: service_role may execute');
select pg_temp.assert(
  not has_function_privilege(r, 'public.claim_error_email_slot(integer, integer)', 'EXECUTE'),
  format('part1: %s may not execute', r))
from unnest(array['anon', 'authenticated']) r;
select pg_temp.assert(
  pg_temp.run_as(r, 'select public.claim_error_email_slot(3, 3600)') like 'permission denied%',
  format('part1: %s is refused', r))
from unnest(array['anon', 'authenticated']) r;
select pg_temp.assert(
  pg_temp.run_as('service_role', 'select * from public.error_email_throttle') like 'permission denied%',
  'part1: service_role cannot read the table directly');
select pg_temp.assert(
  pg_temp.run_as('service_role', 'select public.claim_error_email_slot(3, 0)') = 'OK',
  'part1: service_role can claim');
select pg_temp.assert((select sent_today from public.error_email_throttle) = 1, 'part1: that claim counted');
delete from public.error_email_throttle;

-- ------------------------------------------------------------
-- Part 2: the count
-- ------------------------------------------------------------
-- Per day: with no hour gap, exactly 3 pass, the 4th does not.
select pg_temp.assert(public.claim_error_email_slot(3, 0), 'part2: 1st of 3');
select pg_temp.assert(public.claim_error_email_slot(3, 0), 'part2: 2nd of 3');
select pg_temp.assert(public.claim_error_email_slot(3, 0), 'part2: 3rd of 3');
select pg_temp.assert(not public.claim_error_email_slot(3, 0), 'part2: 4th refused');
select pg_temp.assert((select sent_today from public.error_email_throttle) = 3, 'part2: a refusal changes nothing');
select pg_temp.assert((select count(*) from public.error_email_throttle) = 1, 'part2: one row');

-- The hour gap.
delete from public.error_email_throttle;
select pg_temp.assert(public.claim_error_email_slot(3, 3600), 'part2: first of the hour');
select pg_temp.assert(not public.claim_error_email_slot(3, 3600), 'part2: second in the same hour refused');
update public.error_email_throttle set last_sent_at = now() - interval '59 minutes';
select pg_temp.assert(not public.claim_error_email_slot(3, 3600), 'part2: 59 minutes later refused');
update public.error_email_throttle set last_sent_at = now() - interval '61 minutes';
select pg_temp.assert(public.claim_error_email_slot(3, 3600), 'part2: 61 minutes later allowed');
select pg_temp.assert((select sent_today from public.error_email_throttle) = 2, 'part2: two counted');

-- A new UTC day starts again from 1.
update public.error_email_throttle
   set day = (timezone('UTC', now()))::date - 1, sent_today = 3, last_sent_at = now() - interval '2 hours';
select pg_temp.assert(public.claim_error_email_slot(3, 3600), 'part2: new day allowed');
select pg_temp.assert(
  (select day = (timezone('UTC', now()))::date and sent_today = 1 from public.error_email_throttle),
  'part2: new day counts from 1');

-- The hour gap holds across midnight.
update public.error_email_throttle
   set day = (timezone('UTC', now()))::date - 1, sent_today = 3, last_sent_at = now() - interval '10 minutes';
select pg_temp.assert(not public.claim_error_email_slot(3, 3600), 'part2: hour gap holds across midnight');
select pg_temp.assert(
  (select day = (timezone('UTC', now()))::date - 1 and sent_today = 3 from public.error_email_throttle),
  'part2: refused across midnight changes nothing');

-- Bad arguments.
select pg_temp.assert(pg_temp.run_as('service_role', format('select public.claim_error_email_slot(%s, %s)', a, b)) like 'p_%must be between%',
  format('part2: refuses (%s, %s)', a, b))
from (values ('0', '0'), ('101', '0'), ('null', '0'), ('3', '-1'), ('3', '86401'), ('3', 'null')) v(a, b);

-- ------------------------------------------------------------
-- Part 3: the rollback file and running the migration again
-- ------------------------------------------------------------
\i supabase/tests/108_error_email_shared_cap.rollback.sql
select pg_temp.assert(to_regclass('public.error_email_throttle') is null, 'part3: rollback drops the table');
select pg_temp.assert(to_regprocedure('public.claim_error_email_slot(integer, integer)') is null, 'part3: rollback drops the function');
\i supabase/migrations/20261121170000_error_email_shared_cap.sql
select pg_temp.assert(public.claim_error_email_slot(3, 3600), 'part3: works again after the migration');
select pg_temp.assert(
  not has_function_privilege('anon', 'public.claim_error_email_slot(integer, integer)', 'EXECUTE'),
  'part3: grants as before');

select 'ok: 108_error_email_shared_cap' as result;
