-- Committed SQL regression suite for BOOK-PEN-NAME-RIGHTS-CHOICE-1
-- (migrations/20261018074425_book_pen_name_rights_librum_choice.sql):
--
-- * books.pen_name and books.librum_choice_at are readable like the
--   title and neither insertable nor updatable by anon or authenticated;
--   the pen_name check refuses blank and untrimmed values;
-- * book_rights_declarations: no write privilege for anon or
--   authenticated, service_role (the application's key) may only read
--   and insert -- no UPDATE, DELETE or TRUNCATE -- an author reads only
--   their own rows, and every UPDATE is refused by the trigger, even for
--   the table owner, except the foreign keys' own SET
--   NULL when the book or profile is deleted; a direct null on a live
--   parent is refused; the record survives deleting the book and,
--   separately, the account, with its title, name and sentence intact;
-- * at most one book is picked; set_librum_choice moves the pick, a
--   refused call leaves it in place, and only service_role may execute
--   either function.
--
-- The two-session race is in
-- 072_book_pen_name_rights_librum_choice_contention.sh, and the
-- schema.sql / migration equivalence in
-- 072_book_pen_name_rights_librum_choice_catalog_equivalence.sh.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL
-- instance:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/072_book_pen_name_rights_librum_choice.test.sql
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

-- Runs p_sql as p_role with auth.uid() = p_sub; returns 'OK:<rows>' or
-- '<sqlstate>:<message>'. Each call is its own subtransaction.
create function pg_temp.run_as(p_role text, p_sub text, p_sql text) returns text
  language plpgsql as $$
declare
  v_state text;
  v_msg text;
  v_rows bigint;
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
    v_out := 'OK:' || v_rows;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_out := v_state || ':' || v_msg;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  return v_out;
end;
$$;

-- Same, for a query returning one text value.
create function pg_temp.value_as(p_role text, p_sub text, p_sql text) returns text
  language plpgsql as $$
declare
  v_state text;
  v_msg text;
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql into v_out;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_out := v_state || ':' || v_msg;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  return v_out;
end;
$$;

create function pg_temp.table_acl(p_table regclass) returns text
  language sql stable as $$
  select coalesce(string_agg(grantee || ':' || privs, '|' order by grantee), '')
    from (
      select case when a.grantee = 0 then 'PUBLIC' else r.rolname end as grantee,
             string_agg(a.privilege_type, ',' order by a.privilege_type) as privs
        from pg_class c
        cross join lateral aclexplode(c.relacl) a
        left join pg_roles r on r.oid = a.grantee
       where c.oid = p_table
         and (a.grantee = 0 or r.rolname in ('anon', 'authenticated'))
       group by 1
    ) s;
$$;

create function pg_temp.picked() returns text
  language sql stable as $$
  select coalesce(string_agg(id::text, ',' order by id), '<none>')
    from public.books where librum_choice_at is not null;
$$;

-- ============================================================
-- Part 0: fixtures, written as the table owner.
-- Author A: published a1, a2, a4; draft a3. Author B: published b1.
-- One declaration each for a1, a2 (A) and b1 (B).
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0720000-0000-4000-8000-00000000000a', 'p072-author-a@test', now(), '{"role":"author","display_name":"P072 A"}'),
  ('e0720000-0000-4000-8000-00000000000b', 'p072-author-b@test', now(), '{"role":"author","display_name":"P072 B"}');

update public.profiles set role = 'author'
  where id in ('e0720000-0000-4000-8000-00000000000a', 'e0720000-0000-4000-8000-00000000000b');

insert into public.books (id, author_id, title, status, price_all, published_at) values
  ('e0721000-0000-4000-8000-0000000000a1', 'e0720000-0000-4000-8000-00000000000a', 'P072 A1', 'published', 199, now()),
  ('e0721000-0000-4000-8000-0000000000a2', 'e0720000-0000-4000-8000-00000000000a', 'P072 A2', 'published', 0,   now()),
  ('e0721000-0000-4000-8000-0000000000a3', 'e0720000-0000-4000-8000-00000000000a', 'P072 A3', 'draft',     0,   null),
  ('e0721000-0000-4000-8000-0000000000a4', 'e0720000-0000-4000-8000-00000000000a', 'P072 A4', 'published', 0,   now()),
  ('e0721000-0000-4000-8000-0000000000b1', 'e0720000-0000-4000-8000-00000000000b', 'P072 B1', 'published', 0,   now());

update public.books set pen_name = 'Jo Pen' where id = 'e0721000-0000-4000-8000-0000000000a1';

insert into public.book_rights_declarations
  (id, book_id, book_title, author_id, author_public_name, basis, statement_version, statement_text) values
  ('e0722000-0000-4000-8000-0000000000a1', 'e0721000-0000-4000-8000-0000000000a1', 'P072 A1',
   'e0720000-0000-4000-8000-00000000000a', 'P072 A', 'own_rights', 'rights-v1',
   'I own the rights to this book, or I have the rights holder''s permission to publish and sell it'),
  ('e0722000-0000-4000-8000-0000000000a2', 'e0721000-0000-4000-8000-0000000000a2', 'P072 A2',
   'e0720000-0000-4000-8000-00000000000a', 'P072 A', 'public_domain', 'rights-v1',
   'This book is in the public domain, including any translation I upload'),
  ('e0722000-0000-4000-8000-0000000000b1', 'e0721000-0000-4000-8000-0000000000b1', 'P072 B1',
   'e0720000-0000-4000-8000-00000000000b', 'P072 B', 'own_rights', 'rights-v1',
   'I own the rights to this book, or I have the rights holder''s permission to publish and sell it');

-- ============================================================
-- Part 1: catalog and privileges.
-- ============================================================
do $$
declare
  r text;
  c text;
  p text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    foreach c in array array['pen_name', 'librum_choice_at'] loop
      foreach p in array array['INSERT', 'UPDATE'] loop
        perform pg_temp.assert(not has_column_privilege(r, 'public.books', c, p),
          format('part1: %s must not hold %s on books.%s', r, p, c));
      end loop;
      perform pg_temp.assert(has_column_privilege(r, 'public.books', c, 'SELECT'),
        format('part1: %s reads books.%s', r, c));
    end loop;
  end loop;

  perform pg_temp.assert(
    (select format_type(atttypid, atttypmod) from pg_attribute
      where attrelid = 'public.books'::regclass and attname = 'librum_choice_at') = 'timestamp with time zone',
    'part1: librum_choice_at is timestamptz');

  perform pg_temp.assert(
    (select relrowsecurity from pg_class where oid = 'public.book_rights_declarations'::regclass),
    'part1: book_rights_declarations has RLS enabled');
  perform pg_temp.assert(
    pg_temp.table_acl('public.book_rights_declarations') = 'authenticated:SELECT',
    format('part1: book_rights_declarations ACL for PUBLIC/anon/authenticated -- got %s',
           pg_temp.table_acl('public.book_rights_declarations')));
  perform pg_temp.assert(
    (select array_agg(confdeltype order by conname)::text from pg_constraint
      where conrelid = 'public.book_rights_declarations'::regclass and contype = 'f') = '{n,n}',
    'part1: both declaration foreign keys are ON DELETE SET NULL');

  foreach p in array array['public.set_librum_choice(uuid)', 'public.clear_librum_choice()'] loop
    perform pg_temp.assert(not has_function_privilege('anon', p, 'EXECUTE'), format('part1: anon cannot execute %s', p));
    perform pg_temp.assert(not has_function_privilege('authenticated', p, 'EXECUTE'), format('part1: authenticated cannot execute %s', p));
    perform pg_temp.assert(has_function_privilege('service_role', p, 'EXECUTE'), format('part1: service_role executes %s', p));
    perform pg_temp.assert(
      (select not prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = p::regprocedure),
      format('part1: %s is security invoker with an empty search_path', p));
  end loop;
  perform pg_temp.assert(
    (select not prosecdef and proconfig @> array['search_path=""'] from pg_proc
      where oid = 'public.enforce_book_rights_declarations_append_only()'::regprocedure),
    'part1: the append-only trigger function has an empty search_path');
end $$;

-- ============================================================
-- Part 2: pen_name is public and checked.
-- ============================================================
do $$
declare
  v text;
  bad text;
begin
  v := pg_temp.value_as('anon', null,
    $q$select pen_name || '|' || coalesce(librum_choice_at::text, '<null>') from public.books where id = 'e0721000-0000-4000-8000-0000000000a1'$q$);
  perform pg_temp.assert(v = 'Jo Pen|<null>', format('part2: anon reads pen_name and librum_choice_at -- got %s', v));

  foreach bad in array array['', ' x', E'\tx', E'x\n', 'x ', repeat('x', 121)] loop
    v := pg_temp.run_as('service_role', null,
      format('update public.books set pen_name = %L where id = %L', bad, 'e0721000-0000-4000-8000-0000000000a2'));
    perform pg_temp.assert(v like '23514:%books_pen_name_check%',
      format('part2: pen_name %L must be refused -- got %s', bad, v));
  end loop;

  v := pg_temp.run_as('service_role', null,
    format('update public.books set pen_name = %L where id = %L', repeat('x', 120), 'e0721000-0000-4000-8000-0000000000a2'));
  perform pg_temp.assert(v = 'OK:1', format('part2: a 120-character pen_name is accepted -- got %s', v));
  update public.books set pen_name = null where id = 'e0721000-0000-4000-8000-0000000000a2';

  v := pg_temp.run_as('authenticated', 'e0720000-0000-4000-8000-00000000000a',
    $q$update public.books set pen_name = 'Forged' where id = 'e0721000-0000-4000-8000-0000000000a1'$q$);
  perform pg_temp.assert(v like '42501:%', format('part2: an author cannot write pen_name directly -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0720000-0000-4000-8000-00000000000a',
    $q$insert into public.books (author_id, title, pen_name) values ('e0720000-0000-4000-8000-00000000000a', 'x', 'Forged')$q$);
  perform pg_temp.assert(v like '42501:%', format('part2: an author cannot insert pen_name -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0720000-0000-4000-8000-00000000000a',
    $q$update public.books set librum_choice_at = now() where id = 'e0721000-0000-4000-8000-0000000000a1'$q$);
  perform pg_temp.assert(v like '42501:%', format('part2: an author cannot pick a book directly -- got %s', v));
end $$;

-- ============================================================
-- Part 3: who may read and write declarations.
-- ============================================================
do $$
declare
  v text;
begin
  v := pg_temp.value_as('authenticated', 'e0720000-0000-4000-8000-00000000000a',
    $q$select string_agg(id::text, ',' order by id) from public.book_rights_declarations$q$);
  perform pg_temp.assert(v = 'e0722000-0000-4000-8000-0000000000a1,e0722000-0000-4000-8000-0000000000a2',
    format('part3: author A reads exactly their own declarations -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0720000-0000-4000-8000-00000000000b',
    $q$select string_agg(id::text, ',' order by id) from public.book_rights_declarations$q$);
  perform pg_temp.assert(v = 'e0722000-0000-4000-8000-0000000000b1',
    format('part3: author B reads exactly their own declaration -- got %s', v));
  v := pg_temp.value_as('anon', null, $q$select count(*)::text from public.book_rights_declarations$q$);
  perform pg_temp.assert(v like '42501:%', format('part3: anon cannot read declarations -- got %s', v));

  foreach v in array array[
    pg_temp.run_as('authenticated', 'e0720000-0000-4000-8000-00000000000a',
      $q$insert into public.book_rights_declarations (book_id, book_title, author_id, author_public_name, basis, statement_version, statement_text)
         values ('e0721000-0000-4000-8000-0000000000a1', 'P072 A1', 'e0720000-0000-4000-8000-00000000000a', 'P072 A', 'own_rights', 'rights-v1', 'x')$q$),
    pg_temp.run_as('authenticated', 'e0720000-0000-4000-8000-00000000000a',
      $q$update public.book_rights_declarations set statement_text = 'x' where id = 'e0722000-0000-4000-8000-0000000000a1'$q$),
    pg_temp.run_as('authenticated', 'e0720000-0000-4000-8000-00000000000a',
      $q$delete from public.book_rights_declarations where id = 'e0722000-0000-4000-8000-0000000000a1'$q$),
    pg_temp.run_as('anon', null,
      $q$insert into public.book_rights_declarations (book_id, book_title, author_id, author_public_name, basis, statement_version, statement_text)
         values ('e0721000-0000-4000-8000-0000000000a1', 'P072 A1', 'e0720000-0000-4000-8000-00000000000a', 'P072 A', 'own_rights', 'rights-v1', 'x')$q$),
    pg_temp.run_as('anon', null,
      $q$update public.book_rights_declarations set statement_text = 'x'$q$),
    pg_temp.run_as('anon', null,
      $q$delete from public.book_rights_declarations$q$)
  ] loop
    perform pg_temp.assert(v like '42501:permission denied for table book_rights_declarations%',
      format('part3: anon/authenticated writes are refused -- got %s', v));
  end loop;

  v := pg_temp.run_as('service_role', null,
    $q$insert into public.book_rights_declarations (book_id, book_title, author_id, author_public_name, basis, statement_version, statement_text)
       values ('e0721000-0000-4000-8000-0000000000a1', 'P072 A1', 'e0720000-0000-4000-8000-00000000000a', 'P072 A', 'other', 'rights-v1', 'x')$q$);
  perform pg_temp.assert(v like '23514:%', format('part3: an unknown basis is refused -- got %s', v));
  v := pg_temp.run_as('service_role', null,
    $q$insert into public.book_rights_declarations (book_id, book_title, author_id, author_public_name, basis, statement_version, statement_text)
       values ('e0721000-0000-4000-8000-0000000000a1', 'P072 A1', 'e0720000-0000-4000-8000-00000000000a', 'P072 A', 'own_rights', 'rights-v1', '   ')$q$);
  perform pg_temp.assert(v like '23514:%', format('part3: a blank sentence is refused -- got %s', v));
  v := pg_temp.run_as('service_role', null,
    $q$insert into public.book_rights_declarations (book_id, book_title, author_id, author_public_name, basis, statement_version, statement_text)
       values ('e0721000-0000-4000-8000-0000000000a1', 'P072 A1', 'e0720000-0000-4000-8000-00000000000a', null, 'own_rights', 'rights-v1', 'x')$q$);
  perform pg_temp.assert(v like '23502:%', format('part3: a null author name is refused -- got %s', v));
end $$;

-- ============================================================
-- Part 4: append-only. service_role holds no UPDATE, DELETE or
-- TRUNCATE at all; the trigger refuses every edit even for the table
-- owner (the only role left holding UPDATE), as defence in depth.
-- ============================================================
do $$
declare
  v text;
  p text;
begin
  foreach p in array array['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
                     || case when current_setting('server_version_num')::int >= 170000
                             then array['MAINTAIN'] else array[]::text[] end loop
    perform pg_temp.assert(not has_table_privilege('service_role', 'public.book_rights_declarations', p),
      format('part4: service_role must not hold %s on book_rights_declarations', p));
  end loop;
  perform pg_temp.assert(has_table_privilege('service_role', 'public.book_rights_declarations', 'SELECT, INSERT'),
    'part4: service_role holds SELECT and INSERT');

  foreach v in array array[
    pg_temp.run_as('service_role', null,
      $q$update public.book_rights_declarations set statement_text = 'Edited' where id = 'e0722000-0000-4000-8000-0000000000a1'$q$),
    pg_temp.run_as('service_role', null,
      $q$update public.book_rights_declarations set book_id = null where id = 'e0722000-0000-4000-8000-0000000000a1'$q$),
    pg_temp.run_as('service_role', null,
      $q$delete from public.book_rights_declarations where id = 'e0722000-0000-4000-8000-0000000000a1'$q$),
    pg_temp.run_as('service_role', null,
      $q$truncate public.book_rights_declarations$q$)
  ] loop
    perform pg_temp.assert(v like '42501:permission denied for table book_rights_declarations%',
      format('part4: service_role cannot update, delete or truncate declarations -- got %s', v));
  end loop;

  v := pg_temp.value_as('service_role', null,
    $q$select count(*)::text from public.book_rights_declarations where id::text like 'e0722000-%'$q$);
  perform pg_temp.assert(v = '3', format('part4: service_role reads every declaration -- got %s', v));
  v := pg_temp.value_as('service_role', null,
    $q$with i as (insert into public.book_rights_declarations (book_id, book_title, author_id, author_public_name, basis, statement_version, statement_text)
         values ('e0721000-0000-4000-8000-0000000000a4', 'P072 A4', 'e0720000-0000-4000-8000-00000000000a', 'P072 A', 'own_rights', 'rights-v1',
                 'I own the rights to this book, or I have the rights holder''s permission to publish and sell it')
         returning id) select count(*)::text from i$q$);
  perform pg_temp.assert(v = '1', format('part4: service_role inserts with RETURNING -- got %s', v));
  delete from public.book_rights_declarations where book_id = 'e0721000-0000-4000-8000-0000000000a4';
end $$;

do $$
declare
  v text;
  stmt text;
begin
  foreach stmt in array array[
    $q$update public.book_rights_declarations set statement_text = 'Edited' where id = 'e0722000-0000-4000-8000-0000000000a1'$q$,
    $q$update public.book_rights_declarations set book_title = 'Edited' where id = 'e0722000-0000-4000-8000-0000000000a1'$q$,
    $q$update public.book_rights_declarations set author_public_name = 'Edited' where id = 'e0722000-0000-4000-8000-0000000000a1'$q$,
    $q$update public.book_rights_declarations set basis = 'public_domain' where id = 'e0722000-0000-4000-8000-0000000000a1'$q$,
    $q$update public.book_rights_declarations set statement_version = 'rights-v2' where id = 'e0722000-0000-4000-8000-0000000000a1'$q$,
    $q$update public.book_rights_declarations set declared_at = declared_at - interval '1 day' where id = 'e0722000-0000-4000-8000-0000000000a1'$q$,
    $q$update public.book_rights_declarations set id = gen_random_uuid() where id = 'e0722000-0000-4000-8000-0000000000a1'$q$,
    -- re-pointing to another live book or profile
    $q$update public.book_rights_declarations set book_id = 'e0721000-0000-4000-8000-0000000000a4' where id = 'e0722000-0000-4000-8000-0000000000a1'$q$,
    $q$update public.book_rights_declarations set author_id = 'e0720000-0000-4000-8000-00000000000b' where id = 'e0722000-0000-4000-8000-0000000000a1'$q$,
    -- a direct null while the book / the profile still exists
    $q$update public.book_rights_declarations set book_id = null where id = 'e0722000-0000-4000-8000-0000000000a1'$q$,
    $q$update public.book_rights_declarations set author_id = null where id = 'e0722000-0000-4000-8000-0000000000a1'$q$,
    -- a null smuggled in with a text edit
    $q$update public.book_rights_declarations set book_id = null, statement_text = 'Edited' where id = 'e0722000-0000-4000-8000-0000000000a1'$q$
  ] loop
    v := pg_temp.run_as('postgres', null, stmt);
    perform pg_temp.assert(v like 'P0001:book_rights_declarations%', format('part4: %s must raise -- got %s', stmt, v));
  end loop;

  perform pg_temp.assert(
    (select book_id = 'e0721000-0000-4000-8000-0000000000a1' and author_id = 'e0720000-0000-4000-8000-00000000000a'
            and statement_text = 'I own the rights to this book, or I have the rights holder''s permission to publish and sell it'
       from public.book_rights_declarations where id = 'e0722000-0000-4000-8000-0000000000a1'),
    'part4: the declaration is unchanged after every refused update');
end $$;

-- ============================================================
-- Part 5: the record outlives the book, then the account.
-- ============================================================
do $$
declare
  v text;
begin
  -- Author A deletes book a2 with their own session (they hold DELETE).
  v := pg_temp.run_as('authenticated', 'e0720000-0000-4000-8000-00000000000a',
    $q$delete from public.books where id = 'e0721000-0000-4000-8000-0000000000a2'$q$);
  perform pg_temp.assert(v = 'OK:1', format('part5: the author deletes their book -- got %s', v));
  perform pg_temp.assert(
    (select book_id is null and author_id = 'e0720000-0000-4000-8000-00000000000a' and book_title = 'P072 A2'
            and author_public_name = 'P072 A' and basis = 'public_domain'
            and statement_text = 'This book is in the public domain, including any translation I upload'
       from public.book_rights_declarations where id = 'e0722000-0000-4000-8000-0000000000a2'),
    'part5: the deleted book''s declaration stays, book_id null, title and sentence intact');

  -- Once detached, it still cannot be edited or re-attached, even by the owner.
  v := pg_temp.run_as('postgres', null,
    $q$update public.book_rights_declarations set book_id = 'e0721000-0000-4000-8000-0000000000a1' where id = 'e0722000-0000-4000-8000-0000000000a2'$q$);
  perform pg_temp.assert(v like 'P0001:%', format('part5: a detached record cannot be re-attached -- got %s', v));
  v := pg_temp.run_as('postgres', null,
    $q$update public.book_rights_declarations set statement_text = 'Edited' where id = 'e0722000-0000-4000-8000-0000000000a2'$q$);
  perform pg_temp.assert(v like 'P0001:%', format('part5: a detached record cannot be edited -- got %s', v));

  -- Account B is deleted: profile cascade, its book cascades too.
  delete from auth.users where id = 'e0720000-0000-4000-8000-00000000000b';
  perform pg_temp.assert(
    not exists (select 1 from public.books where id = 'e0721000-0000-4000-8000-0000000000b1'),
    'part5: the deleted account''s book is gone');
  perform pg_temp.assert(
    (select book_id is null and author_id is null and book_title = 'P072 B1' and author_public_name = 'P072 B'
            and basis = 'own_rights'
            and statement_text = 'I own the rights to this book, or I have the rights holder''s permission to publish and sell it'
       from public.book_rights_declarations where id = 'e0722000-0000-4000-8000-0000000000b1'),
    'part5: the deleted account''s declaration stays with both keys null, title, name and sentence intact');
  perform pg_temp.assert(
    (select count(*) from public.book_rights_declarations where id::text like 'e0722000-%') = 3,
    'part5: no declaration was deleted');
end $$;

-- ============================================================
-- Part 6: Librum's choice.
-- ============================================================
do $$
declare
  v text;
begin
  perform pg_temp.assert(pg_temp.picked() = '<none>', 'part6: nothing is picked at the start');

  update public.books set librum_choice_at = now() where id = 'e0721000-0000-4000-8000-0000000000a1';
  v := pg_temp.run_as('service_role', null,
    $q$update public.books set librum_choice_at = now() where id = 'e0721000-0000-4000-8000-0000000000a4'$q$);
  perform pg_temp.assert(v like '23505:%books_one_librum_choice%', format('part6: a second direct pick is refused -- got %s', v));
  update public.books set librum_choice_at = null;

  v := pg_temp.value_as('service_role', null, $q$select public.set_librum_choice('e0721000-0000-4000-8000-0000000000a1')::text$q$);
  perform pg_temp.assert(v = 'true' and pg_temp.picked() = 'e0721000-0000-4000-8000-0000000000a1',
    format('part6: set_librum_choice picks a1 -- got %s / %s', v, pg_temp.picked()));

  v := pg_temp.value_as('service_role', null, $q$select public.set_librum_choice('e0721000-0000-4000-8000-0000000000a4')::text$q$);
  perform pg_temp.assert(v = 'true' and pg_temp.picked() = 'e0721000-0000-4000-8000-0000000000a4',
    format('part6: set_librum_choice moves the pick from a1 to a4 -- got %s / %s', v, pg_temp.picked()));

  v := pg_temp.value_as('service_role', null, $q$select public.set_librum_choice('e0721000-0000-4000-8000-0000000000a4')::text$q$);
  perform pg_temp.assert(v = 'true' and pg_temp.picked() = 'e0721000-0000-4000-8000-0000000000a4',
    format('part6: re-picking the picked book keeps it -- got %s / %s', v, pg_temp.picked()));

  v := pg_temp.value_as('service_role', null, $q$select public.set_librum_choice('e0721000-0000-4000-8000-0000000000a3')::text$q$);
  perform pg_temp.assert(v = 'false' and pg_temp.picked() = 'e0721000-0000-4000-8000-0000000000a4',
    format('part6: a draft is refused and the pick stays -- got %s / %s', v, pg_temp.picked()));

  v := pg_temp.value_as('service_role', null, $q$select public.set_librum_choice('e0721000-0000-4000-8000-0000000000ff')::text$q$);
  perform pg_temp.assert(v = 'false' and pg_temp.picked() = 'e0721000-0000-4000-8000-0000000000a4',
    format('part6: a missing book is refused and the pick stays -- got %s / %s', v, pg_temp.picked()));

  v := pg_temp.value_as('authenticated', 'e0720000-0000-4000-8000-00000000000a',
    $q$select public.set_librum_choice('e0721000-0000-4000-8000-0000000000a1')::text$q$);
  perform pg_temp.assert(v like '42501:%', format('part6: authenticated cannot execute set_librum_choice -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0720000-0000-4000-8000-00000000000a', $q$select public.clear_librum_choice()$q$);
  perform pg_temp.assert(v like '42501:%', format('part6: authenticated cannot execute clear_librum_choice -- got %s', v));
  v := pg_temp.value_as('anon', null, $q$select public.set_librum_choice('e0721000-0000-4000-8000-0000000000a1')::text$q$);
  perform pg_temp.assert(v like '42501:%', format('part6: anon cannot execute set_librum_choice -- got %s', v));
  perform pg_temp.assert(pg_temp.picked() = 'e0721000-0000-4000-8000-0000000000a4', 'part6: refused callers changed nothing');

  v := pg_temp.run_as('service_role', null, $q$select public.clear_librum_choice()$q$);
  perform pg_temp.assert(v = 'OK:1' and pg_temp.picked() = '<none>',
    format('part6: clear_librum_choice clears the pick -- got %s / %s', v, pg_temp.picked()));
end $$;

do $$
declare
  n integer;
begin
  select pg_temp.assertions_run.n into n from pg_temp.assertions_run;
  if n < 60 then
    raise exception 'FAIL: only % assertions ran', n;
  end if;
  raise warning 'PASS: 072_book_pen_name_rights_librum_choice.test.sql -- % assertions', n;
end $$;

rollback;
