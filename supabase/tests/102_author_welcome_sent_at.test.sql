-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for AUTHOR-EMAILS (migration
-- 20261117190000_author_welcome_sent_at.sql): profiles has a nullable
-- author_welcome_sent_at timestamptz that only the service role can
-- write (the app's once-only claim); a signed-in user can't set or clear
-- it, so nobody can make Librum send the welcome again.
--
-- Reproduce against a disposable PostgreSQL 17 instance:
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/102_author_welcome_sent_at.test.sql
begin;

set local client_min_messages = warning;

create table pg_temp.assertions_run (n integer not null);
insert into pg_temp.assertions_run values (0);

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  update pg_temp.assertions_run set n = n + 1;
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

select pg_temp.assert(
  (select data_type = 'timestamp with time zone' and is_nullable = 'YES' and column_default is null
     from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'author_welcome_sent_at'),
  'column exists: nullable timestamptz, no default');

select pg_temp.assert(
  not has_column_privilege('authenticated', 'public.profiles', 'author_welcome_sent_at', 'UPDATE'),
  'authenticated cannot update author_welcome_sent_at');
select pg_temp.assert(
  not has_column_privilege('authenticated', 'public.profiles', 'author_welcome_sent_at', 'INSERT'),
  'authenticated cannot insert author_welcome_sent_at');
select pg_temp.assert(
  not has_column_privilege('anon', 'public.profiles', 'author_welcome_sent_at', 'SELECT'),
  'anon cannot read author_welcome_sent_at');
select pg_temp.assert(
  has_column_privilege('service_role', 'public.profiles', 'author_welcome_sent_at', 'UPDATE'),
  'service_role can claim author_welcome_sent_at');

select pg_temp.assert((select n from pg_temp.assertions_run) = 5, 'all assertions ran');
select 'PASS: 102_author_welcome_sent_at (' || n || ' assertions)' from pg_temp.assertions_run;

rollback;
