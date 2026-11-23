-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for publishing-house accounts
-- (supabase/migrations/20261123140000_publishing_house_account_kind.sql):
--
--   Part 1  shape: profiles.account_kind (text, not null, default
--           'person') and its two named CHECKs.
--   Part 2  values: new accounts are 'person'; only an author can be a
--           'publishing_house'; any other value is refused.
--   Part 3  who writes it: a signed-in user can read their own kind
--           but never change it (theirs or anyone's); the service role
--           can (the sign-up and upgrade switch).
--   Part 4  the real files: rollback twice, the migration again.
--
-- Unlike most suites this one is NOT one rolled-back transaction: Part
-- 4 runs the real migration and rollback files (each its own
-- begin/commit) with \i. run-sql-tests.sh gives every suite its own
-- throwaway database. Run from the repo root:
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/111_publishing_house_account_kind.test.sql
--
-- Against the BASE schema it fails in the set-up (no column): the negative
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
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, false);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), false);
  execute format('set role %I', p_role);
  begin
    execute p_sql;
    v_out := 'OK';
  exception when others then
    v_out := sqlerrm;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', false);
  perform set_config('request.jwt.claim.sub', '', false);
  return v_out;
end;
$$;

-- 'ok' when the profile row accepts this kind, else the error. Undone.
create function pg_temp.try_kind(p_id uuid, p_kind text) returns text
  language plpgsql as $$
begin
  update public.profiles set account_kind = p_kind where id = p_id;
  raise exception using errcode = 'P0001', message = 'probe ok';
exception
  when raise_exception then
    if sqlerrm = 'probe ok' then return 'ok'; end if;
    raise;
  when others then return sqlstate;
end;
$$;

create function pg_temp.kind_of(p_id uuid) returns text
  language sql as $$
  select account_kind from public.profiles where id = p_id;
$$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('e1110000-0000-4000-8000-000000000001', 'p111-reader@test', '{"display_name":"Lexuesi"}'),
  ('e1110000-0000-4000-8000-000000000002', 'p111-author@test', '{"display_name":"Autori"}'),
  ('e1110000-0000-4000-8000-000000000003', 'p111-house@test', '{"display_name":"Botime Test"}');

-- The sign-up switch, as the app does it with the service role.
update public.profiles set role = 'author', public_author_name = 'Autori'
 where id = 'e1110000-0000-4000-8000-000000000002';
update public.profiles set role = 'author', public_author_name = 'Botime Test', account_kind = 'publishing_house'
 where id = 'e1110000-0000-4000-8000-000000000003';

\set READER '''e1110000-0000-4000-8000-000000000001'''
\set AUTHOR '''e1110000-0000-4000-8000-000000000002'''
\set HOUSE '''e1110000-0000-4000-8000-000000000003'''

-- ============================================================
-- Part 1: shape.
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    (select format_type(atttypid, atttypmod) = 'text' and attnotnull
       from pg_attribute
      where attrelid = 'public.profiles'::regclass and attname = 'account_kind' and not attisdropped),
    'part1: profiles.account_kind is a not-null text column');
  perform pg_temp.assert(
    (select pg_get_expr(adbin, adrelid) from pg_attrdef d join pg_attribute a
       on a.attrelid = d.adrelid and a.attnum = d.adnum
      where d.adrelid = 'public.profiles'::regclass and a.attname = 'account_kind') = '''person''::text',
    'part1: the default is person');
  perform pg_temp.assert(
    exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass and conname = 'profiles_account_kind_check')
    and exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass and conname = 'profiles_publishing_house_is_author'),
    'part1: both named CHECKs exist');
end $$;

-- ============================================================
-- Part 2: values.
-- ============================================================
select pg_temp.assert(pg_temp.kind_of(:READER) = 'person', 'part2: a new reader is a person');
select pg_temp.assert(pg_temp.kind_of(:AUTHOR) = 'person', 'part2: an author switched without a kind stays a person');
select pg_temp.assert(pg_temp.kind_of(:HOUSE) = 'publishing_house', 'part2: the house switch is stored');
select pg_temp.assert(pg_temp.try_kind(:READER, 'publishing_house') = '23514', 'part2: a reader can never be a house');
select pg_temp.assert(pg_temp.try_kind(:AUTHOR, 'publishing_house') = 'ok', 'part2: an author can be a house');
select pg_temp.assert(pg_temp.try_kind(:HOUSE, 'person') = 'ok', 'part2: a house can be set back to person');
select pg_temp.assert(pg_temp.try_kind(:AUTHOR, 'company') = '23514', 'part2: an unknown kind is refused');
select pg_temp.assert(pg_temp.try_kind(:AUTHOR, null) = '23502', 'part2: no kind is refused');
select pg_temp.assert(
  (select count(*) from public.pen_names where author_id = :HOUSE and is_default and name = 'Botime Test') = 1,
  'part2: the house gets its default pen name like any author');

-- ============================================================
-- Part 3: who writes it.
-- ============================================================
select pg_temp.assert(
  pg_temp.run_as('authenticated', :HOUSE,
    $q$do $d$ begin
         if (select account_kind from public.profiles where id = 'e1110000-0000-4000-8000-000000000003') is distinct from 'publishing_house'
         then raise exception 'not read'; end if;
       end $d$$q$) = 'OK',
  'part3: a signed-in user reads their own kind');
select pg_temp.assert(
  pg_temp.run_as('authenticated', :AUTHOR,
    $q$update public.profiles set account_kind = 'publishing_house' where id = 'e1110000-0000-4000-8000-000000000002'$q$) like 'permission denied%',
  'part3: an author cannot make themself a house');
select pg_temp.assert(
  pg_temp.run_as('authenticated', :HOUSE,
    $q$update public.profiles set account_kind = 'person' where id = 'e1110000-0000-4000-8000-000000000003'$q$) like 'permission denied%',
  'part3: a house cannot switch itself back');
select pg_temp.assert(
  pg_temp.run_as('anon', null, $q$update public.profiles set account_kind = 'person'$q$) like 'permission denied%',
  'part3: anon writes nothing');
select pg_temp.assert(pg_temp.kind_of(:AUTHOR) = 'person' and pg_temp.kind_of(:HOUSE) = 'publishing_house',
  'part3: nothing changed');
select pg_temp.assert(
  pg_temp.run_as('service_role', null,
    $q$update public.profiles set account_kind = 'publishing_house' where id = 'e1110000-0000-4000-8000-000000000002'$q$) = 'OK',
  'part3: the service role can write it');
select pg_temp.assert(pg_temp.kind_of(:AUTHOR) = 'publishing_house', 'part3: the service-role write landed');
update public.profiles set account_kind = 'person' where id = :AUTHOR;

-- ============================================================
-- Part 4: the real files.
-- ============================================================
\i supabase/tests/111_publishing_house_account_kind.rollback.sql
\i supabase/tests/111_publishing_house_account_kind.rollback.sql

do $$
begin
  perform pg_temp.assert(
    not exists (select 1 from pg_attribute where attrelid = 'public.profiles'::regclass and attname = 'account_kind' and not attisdropped),
    'part4: rollback drops the column');
  perform pg_temp.assert(
    not exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass
                 and conname in ('profiles_account_kind_check', 'profiles_publishing_house_is_author')),
    'part4: rollback drops both CHECKs');
  perform pg_temp.assert(
    (select count(*) from public.profiles where id::text like 'e1110000-%') = 3
    and (select role from public.profiles where id = 'e1110000-0000-4000-8000-000000000003') = 'author',
    'part4: rollback keeps every account; the house stays an author');
end $$;

\i supabase/migrations/20261123140000_publishing_house_account_kind.sql

do $$
begin
  perform pg_temp.assert(
    (select count(*) from public.profiles where id::text like 'e1110000-%' and account_kind = 'person') = 3,
    'part4: the migration on existing accounts makes everyone a person');
  perform pg_temp.assert(
    exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass and conname = 'profiles_publishing_house_is_author'),
    'part4: the CHECKs are back');
end $$;

select 'ALL PASS' as result;
