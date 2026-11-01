-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for BD3-P3
-- (supabase/migrations/20261101150000_bd3_rights_public_domain_original.sql):
--
-- * part1 the constraint: book_rights_declarations has exactly one CHECK
--   on basis, named book_rights_declarations_basis_check; the three
--   bases are accepted; near misses, other case, a trailing space, an
--   empty string and NULL are refused.
-- * part2 the new basis is still append-only and still readable only by
--   the book's author (the existing RLS and trigger, unchanged).
--
-- The migration over populated data (every row and every other catalog
-- unchanged) is proven by
-- 086_bd3_rights_public_domain_original_catalog_equivalence.sh.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance (on 16 strip ", maintain" from a copy of schema.sql):
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/086_bd3_rights_public_domain_original.test.sql
--
-- Everything runs inside one transaction and is rolled back at the end.

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

-- 'ok' when a declaration with this basis is accepted, 'refused' on a
-- CHECK or NOT NULL violation. Each try is undone (savepoint).
create function pg_temp.try_basis(p_basis text) returns text
  language plpgsql as $$
begin
  insert into public.book_rights_declarations
    (book_id, book_title, author_id, author_public_name, basis, statement_version, statement_text)
  values ('e0861000-0000-4000-8000-0000000000a1', 'R086 A1', 'e0860000-0000-4000-8000-00000000000a',
          'R086 A', p_basis, 'rights-v2', 'probe');
  raise exception using errcode = 'P0001', message = 'probe ok';
exception
  when check_violation or not_null_violation then return 'refused';
  when raise_exception then
    if sqlerrm = 'probe ok' then return 'ok'; end if;
    raise;
end;
$$;

-- Runs one statement as a role with a JWT subject; 'OK:<rows>' or the
-- error code.
create function pg_temp.run_as(p_role text, p_uid uuid, p_sql text) returns text
  language plpgsql as $$
declare
  v_rows bigint;
  v_out text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
    v_out := 'OK:' || v_rows;
  exception when others then
    v_out := sqlstate;
  end;
  reset role;
  return v_out;
end;
$$;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0860000-0000-4000-8000-00000000000a', 'r086-a@test', now(), '{"role":"author","display_name":"R086 A"}'),
  ('e0860000-0000-4000-8000-00000000000b', 'r086-b@test', now(), '{"role":"author","display_name":"R086 B"}');

insert into public.books (id, author_id, title, status, price_all, published_at) values
  ('e0861000-0000-4000-8000-0000000000a1', 'e0860000-0000-4000-8000-00000000000a', 'R086 A1', 'published', 0, now());

insert into public.book_rights_declarations
  (id, book_id, book_title, author_id, author_public_name, basis, statement_version, statement_text) values
  ('e0862000-0000-4000-8000-0000000000a1', 'e0861000-0000-4000-8000-0000000000a1', 'R086 A1',
   'e0860000-0000-4000-8000-00000000000a', 'R086 A', 'public_domain_original', 'rights-v2',
   'Vepra origjinale është në domenin publik; përkthimi është imi ose kam lejen e përkthyesit për ta botuar dhe shitur');

-- part1
select pg_temp.assert(
  (select count(*) from pg_catalog.pg_constraint
    where conrelid = 'public.book_rights_declarations'::regclass and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) like '%basis%') = 1,
  'part1: exactly one CHECK on book_rights_declarations mentions basis');
select pg_temp.assert(
  exists (select 1 from pg_catalog.pg_constraint
           where conrelid = 'public.book_rights_declarations'::regclass
             and conname = 'book_rights_declarations_basis_check' and convalidated),
  'part1: the CHECK is named book_rights_declarations_basis_check and validated');

do $$
declare
  v_basis text;
begin
  foreach v_basis in array array['own_rights', 'public_domain', 'public_domain_original'] loop
    perform pg_temp.assert(pg_temp.try_basis(v_basis) = 'ok', 'part1: accepts ' || v_basis);
  end loop;
  foreach v_basis in array array[
    'public_domain_originals', 'Public_domain_original', 'public_domain_original ',
    'public-domain-original', 'original', 'translation', ''
  ] loop
    perform pg_temp.assert(pg_temp.try_basis(v_basis) = 'refused', 'part1: refuses "' || v_basis || '"');
  end loop;
  perform pg_temp.assert(pg_temp.try_basis(null) = 'refused', 'part1: refuses NULL');
end $$;

-- part2
do $$
declare
  v text;
begin
  v := pg_temp.run_as('authenticated', 'e0860000-0000-4000-8000-00000000000a',
    $q$select 1 from public.book_rights_declarations where id = 'e0862000-0000-4000-8000-0000000000a1'$q$);
  perform pg_temp.assert(v = 'OK:1', format('part2: the author reads their new-basis declaration -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0860000-0000-4000-8000-00000000000b',
    $q$select 1 from public.book_rights_declarations where id = 'e0862000-0000-4000-8000-0000000000a1'$q$);
  perform pg_temp.assert(v = 'OK:0', format('part2: another account sees nothing -- got %s', v));
  v := pg_temp.run_as('anon', 'e0860000-0000-4000-8000-00000000000b',
    $q$select 1 from public.book_rights_declarations$q$);
  perform pg_temp.assert(v = '42501', format('part2: anon may not read -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0860000-0000-4000-8000-00000000000a',
    $q$insert into public.book_rights_declarations (book_id, book_title, author_id, author_public_name, basis, statement_version, statement_text)
       values ('e0861000-0000-4000-8000-0000000000a1', 'x', 'e0860000-0000-4000-8000-00000000000a', 'x', 'public_domain_original', 'rights-v2', 'x')$q$);
  perform pg_temp.assert(v = '42501', format('part2: an author session may not insert -- got %s', v));
end $$;

do $$
begin
  update public.book_rights_declarations set basis = 'own_rights'
   where id = 'e0862000-0000-4000-8000-0000000000a1';
  perform pg_temp.assert(false, 'part2: the append-only trigger refuses changing the basis');
exception when raise_exception then
  perform pg_temp.assert(sqlerrm like 'book_rights_declarations is append-only%', 'part2: append-only message: ' || sqlerrm);
end $$;

do $$
declare v_n int;
begin
  select n into v_n from pg_temp.assertions_run;
  raise warning '086_bd3_rights_public_domain_original: % assertions passed', v_n;
  raise notice 'ALL PASSED: 086_bd3_rights_public_domain_original.test.sql (% assertions)', v_n;
end $$;

rollback;
