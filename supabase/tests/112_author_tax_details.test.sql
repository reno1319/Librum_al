-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for the Payment & tax page
-- (supabase/migrations/20261123200000_author_tax_details.sql):
--
--   Part 1  shape: the table, RLS and grants; every function SECURITY
--           DEFINER with an empty search_path, and their EXECUTE grants.
--   Part 2  set_author_tax_details(): Albania (NID) and abroad (home tax
--           number), normalising, every refusal, errors never echo the
--           input, an update keeps one row, no direct writes.
--   Part 3  who reads what: an author reads only their own row; anon and
--           service_role read nothing.
--   Part 4  set_author_payout_destination(): foreign IBANs for ALL, the
--           Albanian rule and the checksum unchanged.
--   Part 5  readiness: _self for the signed-in author only, _for for
--           service_role only, yes/no only.
--   Part 6  cascade: a deleted account takes its tax details.
--   Part 7  the real files: rollback twice, the migration again.
--
-- Made-up names and numbers only. NOT one rolled-back transaction:
-- Part 7 runs the real migration and rollback files with \i.
-- run-sql-tests.sh gives every suite its own throwaway database. Run
-- from the repo root:
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/112_author_tax_details.test.sql
--
-- Against the BASE schema it fails in Part 1 (no table): the negative
-- control.

set client_min_messages = warning;

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

-- Runs one statement as the given role (and user id); 'OK' or the error.
create function pg_temp.run_as(p_role text, p_uid text, p_sql text) returns text
  language plpgsql as $$
declare
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), false);
  execute format('set role %I', p_role);
  begin
    execute p_sql;
    v_out := 'OK';
  exception when others then
    v_out := sqlerrm;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', false);
  return v_out;
end;
$$;

-- One text value read as the given role (and user id); or the error.
create function pg_temp.value_as(p_role text, p_uid text, p_sql text) returns text
  language plpgsql as $$
declare
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), false);
  execute format('set role %I', p_role);
  begin
    execute p_sql into v_out;
  exception when others then
    v_out := sqlerrm;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', false);
  return coalesce(v_out, '<null>');
end;
$$;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('11200000-0000-4000-8000-000000000001', 'p112-author-a@test', now(), '{"role":"author","display_name":"P112 A"}'),
  ('11200000-0000-4000-8000-000000000002', 'p112-author-b@test', now(), '{"role":"author","display_name":"P112 B"}'),
  ('11200000-0000-4000-8000-000000000003', 'p112-author-c@test', now(), '{"role":"author","display_name":"P112 C"}');

\set A '''11200000-0000-4000-8000-000000000001'''
\set B '''11200000-0000-4000-8000-000000000002'''
\set C '''11200000-0000-4000-8000-000000000003'''

-- ============================================================
-- Part 1: shape.
-- ============================================================
do $$
begin
  perform pg_temp.assert(to_regclass('public.author_tax_details') is not null, 'part1: the table exists');
  perform pg_temp.assert(
    (select relrowsecurity from pg_class where oid = 'public.author_tax_details'::regclass),
    'part1: RLS is on');
  perform pg_temp.assert(
    has_table_privilege('authenticated', 'public.author_tax_details', 'SELECT')
    and not has_table_privilege('authenticated', 'public.author_tax_details', 'INSERT')
    and not has_table_privilege('authenticated', 'public.author_tax_details', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.author_tax_details', 'DELETE'),
    'part1: authenticated may only SELECT');
  perform pg_temp.assert(
    not has_table_privilege('anon', 'public.author_tax_details', 'SELECT,INSERT,UPDATE,DELETE')
    and not has_table_privilege('service_role', 'public.author_tax_details', 'SELECT,INSERT,UPDATE,DELETE'),
    'part1: anon and service_role hold nothing on the table');

  perform pg_temp.assert(
    (select bool_and(p.prosecdef and p.proconfig = array['search_path=""'])
       from pg_proc p
      where p.oid in (
        'public.set_author_tax_details(text,text,text)'::regprocedure,
        'public.set_author_payout_destination(text,text,text)'::regprocedure,
        'public.author_payment_details_ready_self()'::regprocedure,
        'public.author_payment_details_ready_for(uuid)'::regprocedure)),
    'part1: every function is SECURITY DEFINER with an empty search_path');

  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.set_author_tax_details(text,text,text)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.set_author_tax_details(text,text,text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.set_author_tax_details(text,text,text)', 'EXECUTE'),
    'part1: set_author_tax_details is authenticated + service_role, never anon');
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.set_author_payout_destination(text,text,text)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.set_author_payout_destination(text,text,text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.set_author_payout_destination(text,text,text)', 'EXECUTE'),
    'part1: set_author_payout_destination grants unchanged');
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.author_payment_details_ready_self()', 'EXECUTE')
    and not has_function_privilege('service_role', 'public.author_payment_details_ready_self()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.author_payment_details_ready_self()', 'EXECUTE'),
    'part1: _self is authenticated only');
  perform pg_temp.assert(
    has_function_privilege('service_role', 'public.author_payment_details_ready_for(uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.author_payment_details_ready_for(uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.author_payment_details_ready_for(uuid)', 'EXECUTE'),
    'part1: _for is service_role only');
end $$;

-- ============================================================
-- Part 2: set_author_tax_details().
-- ============================================================
select pg_temp.assert(
  pg_temp.run_as('authenticated', null, $q$select public.set_author_tax_details('AL', 'Arta Test', 'J12345678A')$q$)
    like '%not authenticated%',
  'part2: signed out is refused');
select pg_temp.assert(
  pg_temp.run_as('service_role', null, $q$select public.set_author_tax_details('AL', 'Arta Test', 'J12345678A')$q$)
    like '%not authenticated%',
  'part2: service_role with no user is refused too');
select pg_temp.assert(
  pg_temp.run_as('anon', null, $q$select public.set_author_tax_details('AL', 'Arta Test', 'J12345678A')$q$)
    like '%permission denied%',
  'part2: anon cannot call it');

-- Albania: the NID, normalised (typing help removed, upper-cased).
select pg_temp.assert(
  pg_temp.run_as('authenticated', :A, $q$select public.set_author_tax_details(' al ', '  Arta   Test ', 'j12-345.678 a')$q$) = 'OK',
  'part2: an author in Albania saves');
select pg_temp.assert(
  (select country_code || '|' || legal_name || '|' || tax_id from public.author_tax_details
    where author_id = '11200000-0000-4000-8000-000000000001') = 'AL|Arta Test|J12345678A',
  'part2: saved normalised');

-- Refusals, and the input never appears in the message.
select pg_temp.assert(r like '%nid format is not valid' and r not like '%Q1234%', 'part2: a malformed NID is refused: ' || r)
  from (select pg_temp.run_as('authenticated', :A, $q$select public.set_author_tax_details('AL', 'Arta', 'Q1234X')$q$) r) x;
select pg_temp.assert(r like '%tax number format is not valid' and r not like '%123%', 'part2: a too-short number abroad is refused: ' || r)
  from (select pg_temp.run_as('authenticated', :A, $q$select public.set_author_tax_details('DE', 'Arta', '123')$q$) r) x;
select pg_temp.assert(
  pg_temp.run_as('authenticated', :A, $q$select public.set_author_tax_details('Germany', 'Arta', '12345678')$q$)
    like '%country is required',
  'part2: a country that is not two letters is refused');
select pg_temp.assert(
  pg_temp.run_as('authenticated', :A, $q$select public.set_author_tax_details('AL', '   ', 'J12345678A')$q$)
    like '%legal name is required',
  'part2: a blank legal name is refused');
select pg_temp.assert(
  pg_temp.run_as('authenticated', :A, format('select public.set_author_tax_details(%L, %L, %L)', 'AL', repeat('a', 201), 'J12345678A'))
    like '%legal name is required',
  'part2: a legal name over 200 characters is refused');
select pg_temp.assert(
  (select tax_id from public.author_tax_details where author_id = '11200000-0000-4000-8000-000000000001') = 'J12345678A',
  'part2: a refused save changes nothing');

-- Abroad, then an update: still one row, now the new values.
select pg_temp.assert(
  pg_temp.run_as('authenticated', :A, $q$select public.set_author_tax_details('xk', 'Arta Test', '12-345.678/90')$q$) = 'OK',
  'part2: the same author moves abroad');
select pg_temp.assert(
  (select count(*) = 1 and min(country_code || '|' || tax_id) = 'XK|1234567890'
     from public.author_tax_details where author_id = '11200000-0000-4000-8000-000000000001'),
  'part2: an update keeps one row with the new values');
select pg_temp.assert(
  pg_temp.run_as('authenticated', :B, $q$select public.set_author_tax_details('AL', 'Besa Test', 'K87654321B')$q$) = 'OK',
  'part2: a second author saves');

-- No direct writes for anyone but the function.
select pg_temp.assert(
  pg_temp.run_as('authenticated', :C,
    $q$insert into public.author_tax_details (author_id, country_code, legal_name, tax_id)
       values ('11200000-0000-4000-8000-000000000003', 'AL', 'C', 'J12345678A')$q$) like '%permission denied%',
  'part2: no direct insert as authenticated');
select pg_temp.assert(
  pg_temp.run_as('authenticated', :A, $q$update public.author_tax_details set legal_name = 'X'$q$) like '%permission denied%',
  'part2: no direct update as authenticated');
select pg_temp.assert(
  pg_temp.run_as('service_role', null, $q$delete from public.author_tax_details$q$) like '%permission denied%',
  'part2: no direct delete as service_role');

-- ============================================================
-- Part 3: who reads what.
-- ============================================================
select pg_temp.assert(
  pg_temp.value_as('authenticated', :A, $q$select string_agg(author_id::text, ',') from public.author_tax_details$q$)
    = '11200000-0000-4000-8000-000000000001',
  'part3: author A reads only their own row');
select pg_temp.assert(
  pg_temp.value_as('authenticated', :B, $q$select string_agg(country_code, ',') from public.author_tax_details$q$) = 'AL',
  'part3: author B reads only their own row');
select pg_temp.assert(
  pg_temp.value_as('authenticated', :C, $q$select count(*)::text from public.author_tax_details$q$) = '0',
  'part3: an author with no row reads nothing');
select pg_temp.assert(
  pg_temp.value_as('anon', null, $q$select count(*)::text from public.author_tax_details$q$) like '%permission denied%',
  'part3: anon is denied');
select pg_temp.assert(
  pg_temp.value_as('service_role', null, $q$select count(*)::text from public.author_tax_details$q$) like '%permission denied%',
  'part3: service_role is denied');

-- ============================================================
-- Part 4: set_author_payout_destination().
-- ============================================================
select pg_temp.assert(
  pg_temp.run_as('authenticated', :A, $q$select * from public.set_author_payout_destination('ALL', 'Arta Test', 'XK05 1212 0123 4567 8906')$q$) = 'OK',
  'part4: a Kosovo IBAN is accepted for ALL');
select pg_temp.assert(
  pg_temp.run_as('authenticated', :C, $q$select * from public.set_author_payout_destination('ALL', 'C Test', 'de89 3704 0044 0532 0130 00')$q$) = 'OK',
  'part4: a German IBAN (lower case, spaced) is accepted for ALL');
select pg_temp.assert(
  pg_temp.run_as('authenticated', :B, $q$select * from public.set_author_payout_destination('ALL', 'Besa Test', 'AL47 2121 1009 0000 0002 3569 8741')$q$) = 'OK',
  'part4: an Albanian IBAN still works');
select pg_temp.assert(
  pg_temp.run_as('authenticated', :B, $q$select * from public.set_author_payout_destination('ALL', 'Besa Test', 'AL472121100900000002356987')$q$)
    like '%expected Albanian IBAN format%',
  'part4: a short Albanian IBAN keeps the Albanian refusal');
select pg_temp.assert(
  pg_temp.run_as('authenticated', :B, $q$select * from public.set_author_payout_destination('ALL', 'Besa Test', 'DE89370400440532013001')$q$)
    like '%checksum%',
  'part4: a foreign IBAN with a bad checksum is refused');
select pg_temp.assert(
  pg_temp.run_as('authenticated', :B, $q$select * from public.set_author_payout_destination('ALL', 'Besa Test', 'not-an-iban')$q$)
    like '%expected IBAN format',
  'part4: something that is not an IBAN is refused');
select pg_temp.assert(
  (select iban from public.author_payout_destinations
    where author_id = '11200000-0000-4000-8000-000000000002' and currency = 'ALL') = 'AL47212110090000000235698741',
  'part4: a refused save changes nothing');

-- ============================================================
-- Part 5: readiness, yes/no only.
-- ============================================================
-- A and B: tax + ALL destination. C: destination only.
select pg_temp.assert(pg_temp.value_as('authenticated', :A, 'select public.author_payment_details_ready_self()::text') = 'true',
  'part5: A is ready');
select pg_temp.assert(pg_temp.value_as('authenticated', :C, 'select public.author_payment_details_ready_self()::text') = 'false',
  'part5: C (no tax details) is not ready');
select pg_temp.assert(pg_temp.value_as('authenticated', null, 'select public.author_payment_details_ready_self()::text') = 'false',
  'part5: no signed-in user is not ready');
select pg_temp.assert(
  pg_temp.value_as('anon', null, 'select public.author_payment_details_ready_self()::text') like '%permission denied%',
  'part5: anon cannot ask _self');
select pg_temp.assert(
  pg_temp.value_as('service_role', null, 'select public.author_payment_details_ready_self()::text') like '%permission denied%',
  'part5: service_role cannot ask _self');

select pg_temp.assert(
  pg_temp.value_as('service_role', null, format('select public.author_payment_details_ready_for(%L)::text', '11200000-0000-4000-8000-000000000002')) = 'true',
  'part5: staff (service_role) read B as ready');
select pg_temp.assert(
  pg_temp.value_as('service_role', null, format('select public.author_payment_details_ready_for(%L)::text', '11200000-0000-4000-8000-000000000003')) = 'false',
  'part5: staff read C as not ready');
select pg_temp.assert(
  pg_temp.value_as('service_role', null, 'select public.author_payment_details_ready_for(null)::text') = 'false',
  'part5: a null author is not ready');
select pg_temp.assert(
  pg_temp.value_as('authenticated', :A, format('select public.author_payment_details_ready_for(%L)::text', '11200000-0000-4000-8000-000000000002')) like '%permission denied%',
  'part5: an author cannot ask _for about anyone');
select pg_temp.assert(
  pg_temp.value_as('anon', null, format('select public.author_payment_details_ready_for(%L)::text', '11200000-0000-4000-8000-000000000002')) like '%permission denied%',
  'part5: anon cannot ask _for');

-- Only the ALL destination counts.
delete from public.author_payout_destinations where author_id = '11200000-0000-4000-8000-000000000002';
select pg_temp.assert(
  pg_temp.run_as('authenticated', :B, $q$select * from public.set_author_payout_destination('EUR', 'Besa Test', 'AL47212110090000000235698741')$q$) = 'OK',
  'part5: B saves a EUR destination only');
select pg_temp.assert(pg_temp.value_as('authenticated', :B, 'select public.author_payment_details_ready_self()::text') = 'false',
  'part5: a EUR destination alone is not ready');

-- ============================================================
-- Part 6: cascade.
-- ============================================================
delete from auth.users where id = '11200000-0000-4000-8000-000000000002';
select pg_temp.assert(
  not exists (select 1 from public.author_tax_details where author_id = '11200000-0000-4000-8000-000000000002'),
  'part6: a deleted account takes its tax details');
select pg_temp.assert(
  exists (select 1 from public.author_tax_details where author_id = '11200000-0000-4000-8000-000000000001'),
  'part6: other authors keep theirs');

-- ============================================================
-- Part 7: the real files.
-- ============================================================
\i supabase/tests/112_author_tax_details.rollback.sql
\i supabase/tests/112_author_tax_details.rollback.sql

do $$
begin
  perform pg_temp.assert(to_regclass('public.author_tax_details') is null, 'part7: rollback drops the table');
  perform pg_temp.assert(
    to_regprocedure('public.set_author_tax_details(text,text,text)') is null
    and to_regprocedure('public.author_payment_details_ready_self()') is null
    and to_regprocedure('public.author_payment_details_ready_for(uuid)') is null,
    'part7: rollback drops the three new functions');
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.set_author_payout_destination(text,text,text)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.set_author_payout_destination(text,text,text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.set_author_payout_destination(text,text,text)', 'EXECUTE'),
    'part7: rollback keeps the payout destination grants');
  perform pg_temp.assert(
    exists (select 1 from public.author_payout_destinations where author_id = '11200000-0000-4000-8000-000000000001'),
    'part7: rollback keeps saved destinations');
end $$;

select pg_temp.assert(
  pg_temp.run_as('authenticated', :C, $q$select * from public.set_author_payout_destination('ALL', 'C Test', 'DE89370400440532013000')$q$)
    like '%expected Albanian IBAN format%',
  'part7: after rollback a foreign IBAN is refused again (old rule)');

\i supabase/migrations/20261123200000_author_tax_details.sql

select pg_temp.assert(
  pg_temp.run_as('authenticated', :C, $q$select public.set_author_tax_details('DE', 'C Test', '12345678901')$q$) = 'OK',
  'part7: the migration again works');
select pg_temp.assert(pg_temp.value_as('authenticated', :C, 'select public.author_payment_details_ready_self()::text') = 'true',
  'part7: C is ready again');
select pg_temp.assert(
  pg_temp.run_as('authenticated', :C, $q$select * from public.set_author_payout_destination('ALL', 'C Test', 'DE89370400440532013000')$q$) = 'OK',
  'part7: foreign IBANs accepted again');

select 'ALL PASS' as result;
