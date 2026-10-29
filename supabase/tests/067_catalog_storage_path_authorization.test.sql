-- Committed SQL regression suite for CATALOG-STORAGE-PATH-AUTH-1
-- (supabase/migrations/20260924141734_catalog_storage_path_authorization.sql):
-- authenticated can no longer name public.books.file_path or
-- public.books.cover_path in a direct INSERT -- whatever the value, null,
-- the author's own path or another author's -- while an ordinary pathless
-- draft stays directly insertable and service_role, the trusted server
-- path createBook now uses, can insert server-derived paths.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance (17 or newer: schema.sql uses the MAINTAIN privilege):
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/067_catalog_storage_path_authorization.test.sql
--
-- It must also pass against the OTHER build path -- the base schema.sql
-- plus the migration -- and
-- 067_catalog_storage_path_authorization_catalog_equivalence.sh proves
-- those two paths agree. Against the BASE schema alone (the Patch 7 ACL)
-- it must FAIL: that is the negative control showing this suite can see
-- the hole it exists to close.
--
-- Everything runs in one transaction and is rolled back; every probe runs
-- in its own subtransaction. Privilege errors and RLS errors share
-- SQLSTATE 42501, so every expected failure also pins the message
-- fragment: "permission denied for table" is the ACL, "row-level
-- security" is the policy.
--
-- PEN-NAMES-2 (20261019222500/20261019222600) narrowed this further:
-- authenticated has no INSERT on books at all (E5), anon reads
-- public_books instead of books (C1), and cover_path must have the
-- `<uuid>/cover.(jpg|png)` shape (C10). Every assertion below that the
-- PEN-NAMES-2 rule changed says so and states the new rule.

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

-- Runs one statement as `p_role` with `auth.uid()` = `p_sub` (null for
-- none) and returns 'OK:<rowcount>' or '<sqlstate>:<message>'. The
-- statement runs in its own subtransaction, so a failure rolls back only
-- itself.
create function pg_temp.run_as(p_role text, p_sub text, p_sql text) returns text
  language plpgsql as $$
declare
  v_rows bigint;
  v_state text;
  v_msg text;
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

create function pg_temp.expect_ok(p_role text, p_sub text, p_sql text, p_rows integer, p_message text)
  returns void language plpgsql as $$
declare
  v_out text := pg_temp.run_as(p_role, p_sub, p_sql);
begin
  perform pg_temp.assert(v_out = 'OK:' || p_rows, format('%s -- got %s', p_message, v_out));
end;
$$;

create function pg_temp.expect_error(p_role text, p_sub text, p_sql text, p_state text, p_fragment text, p_message text)
  returns void language plpgsql as $$
declare
  v_out text := pg_temp.run_as(p_role, p_sub, p_sql);
begin
  perform pg_temp.assert(
    v_out like p_state || ':%' and v_out like '%' || p_fragment || '%',
    format('%s -- got %s', p_message, v_out));
end;
$$;

-- Table-level ACL of one table for anon, authenticated, service_role and
-- PUBLIC, as 'grantee:PRIV,PRIV|...' in a fixed order. The owner is left
-- out: it differs by environment (postgres on Supabase, the test user
-- here) and this migration never touches it.
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
         and (a.grantee = 0 or r.rolname in ('anon', 'authenticated', 'service_role'))
       group by 1
    ) s;
$$;

-- Column-level ACL of one table, as 'grantee:PRIV:col,col|...'.
create function pg_temp.column_acl(p_table regclass) returns text
  language sql stable as $$
  select coalesce(string_agg(entry, '|' order by entry), '')
    from (
      select (case when a.grantee = 0 then 'PUBLIC' else r.rolname end)
             || ':' || a.privilege_type || ':'
             || string_agg(att.attname, ',' order by att.attname) as entry
        from pg_attribute att
        cross join lateral aclexplode(att.attacl) a
        left join pg_roles r on r.oid = a.grantee
       where att.attrelid = p_table
         and att.attnum > 0 and not att.attisdropped
       group by a.grantee, r.rolname, a.privilege_type
    ) s;
$$;

-- ============================================================
-- Part 0: fixtures, written as the table owner the way historical rows
-- were written. Author A owns a draft and a published book with canonical
-- paths and a legacy row whose paths are not canonical; author B owns a
-- draft whose manuscript is the forgery target.
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0670000-0000-0000-0000-00000000000a', 'p067-author-a@test', now(), '{"role":"author","display_name":"P067 A"}'),
  ('e0670000-0000-0000-0000-00000000000b', 'p067-author-b@test', now(), '{"role":"author","display_name":"P067 B"}');

update public.profiles set role = 'author'
  where id in ('e0670000-0000-0000-0000-00000000000a', 'e0670000-0000-0000-0000-00000000000b');

insert into public.series (id, author_id, title) values
  ('e0673000-0000-0000-0000-00000000000a', 'e0670000-0000-0000-0000-00000000000a', 'P067 Series A');

insert into public.books (id, author_id, title, status, price_all, published_at, cover_path, file_path, series_id, series_position) values
  ('e0671000-0000-0000-0000-0000000000a1', 'e0670000-0000-0000-0000-00000000000a', 'P067 A draft', 'draft', 199, null,
   'e0675000-0000-0000-0000-0000000000a1/cover.png',
   'e0670000-0000-0000-0000-00000000000a/e0671000-0000-0000-0000-0000000000a1.epub',
   'e0673000-0000-0000-0000-00000000000a', 1),
  ('e0671000-0000-0000-0000-0000000000a2', 'e0670000-0000-0000-0000-00000000000a', 'P067 A published', 'published', 0, now(),
   'e0675000-0000-0000-0000-0000000000a2/cover.jpg',
   'e0670000-0000-0000-0000-00000000000a/e0671000-0000-0000-0000-0000000000a2.epub', null, null),
  ('e0671000-0000-0000-0000-0000000000a3', 'e0670000-0000-0000-0000-00000000000a', 'P067 A legacy paths', 'published', null, now(),
   -- PEN-NAMES-2 (C10): a legacy cover key can no longer be stored, so
   -- the legacy row keeps only its legacy manuscript path.
   null, 'legacy/manuscript.epub', null, null),
  ('e0671000-0000-0000-0000-0000000000b1', 'e0670000-0000-0000-0000-00000000000b', 'P067 B draft', 'draft', 0, null,
   'e0675000-0000-0000-0000-0000000000b1/cover.png',
   'e0670000-0000-0000-0000-00000000000b/e0671000-0000-0000-0000-0000000000b1.epub', null, null);

-- ============================================================
-- Part 1: privilege metadata.
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    (select relrowsecurity and not relforcerowsecurity from pg_class where oid = 'public.books'::regclass),
    'part1: books keeps RLS enabled, not forced');

  -- Table-level ACL: no INSERT or UPDATE at table level for anon or
  -- authenticated; no PUBLIC entry at all. PEN-NAMES-2 (C1): anon holds
  -- no SELECT either.
  perform pg_temp.assert(
    pg_temp.table_acl('public.books') =
      'authenticated:DELETE,SELECT'
      || '|service_role:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE',
    format('part1: books table ACL -- got %s', pg_temp.table_acl('public.books')));

  -- Column-level ACL. PEN-NAMES-2 (E5): no INSERT column at all; only
  -- the series link remains.
  perform pg_temp.assert(
    pg_temp.column_acl('public.books') =
      'authenticated:UPDATE:series_id,series_position',
    format('part1: books column ACL -- got %s', pg_temp.column_acl('public.books')));

  -- bundles keeps the Patch 7 table ACL, minus anon SELECT (PEN-NAMES-2
  -- C1); its column INSERT grant is gone (PEN-NAMES-2 E5b, audit PEN-2 r1
  -- F1: createBundle inserts through the trusted writer).
  perform pg_temp.assert(
    pg_temp.table_acl('public.bundles') =
      'authenticated:DELETE,SELECT'
      || '|service_role:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE',
    format('part1: bundles table ACL unchanged -- got %s', pg_temp.table_acl('public.bundles')));
  perform pg_temp.assert(
    pg_temp.column_acl('public.bundles') = '',
    format('part1 (PEN-NAMES-2 E5b): bundles has no column grant -- got %s', pg_temp.column_acl('public.bundles')));
end $$;

-- Per role and per path column, as the privilege functions resolve it
-- (role membership and PUBLIC inheritance included). 5 roles x 2 columns
-- x INSERT/UPDATE = 20 assertions.
do $$
declare
  v_role text;
  v_col text;
  v_priv text;
  v_expected boolean;
begin
  foreach v_role in array array['public', 'anon', 'authenticated', 'service_role', current_user::text] loop
    foreach v_col in array array['file_path', 'cover_path'] loop
      foreach v_priv in array array['INSERT', 'UPDATE'] loop
        v_expected := v_role in ('service_role', current_user::text);
        perform pg_temp.assert(
          has_column_privilege(v_role, 'public.books', v_col, v_priv) = v_expected,
          format('part1: %s %s on books.%s is %s', v_role, v_priv, v_col, v_expected));
      end loop;
    end loop;
  end loop;
end $$;

do $$
begin
  -- PEN-NAMES-2 (E5): the pathless draft columns are no longer
  -- insertable by authenticated either; status is still not.
  perform pg_temp.assert(not has_column_privilege('authenticated', 'public.books', 'title', 'INSERT')
    and not has_column_privilege('authenticated', 'public.books', 'price_all', 'INSERT')
    and not has_column_privilege('authenticated', 'public.books', 'author_id', 'INSERT')
    and not has_column_privilege('authenticated', 'public.books', 'id', 'INSERT'),
    'part1 (PEN-NAMES-2): authenticated has no INSERT on the draft columns');
  perform pg_temp.assert(not has_column_privilege('authenticated', 'public.books', 'status', 'INSERT')
    and not has_column_privilege('authenticated', 'public.books', 'published_at', 'INSERT'),
    'part1: status and published_at stay uninsertable');
  perform pg_temp.assert(not has_table_privilege('public', 'public.books', 'INSERT, UPDATE, DELETE, TRUNCATE')
    and not has_any_column_privilege('public', 'public.books', 'INSERT, UPDATE'),
    'part1: PUBLIC can write nothing');
  perform pg_temp.assert(not has_any_column_privilege('anon', 'public.books', 'INSERT, UPDATE')
    and not has_table_privilege('anon', 'public.books', 'DELETE, TRUNCATE')
    and not has_table_privilege('anon', 'public.books', 'SELECT')
    and has_table_privilege('anon', 'public.public_books', 'SELECT'),
    'part1 (PEN-NAMES-2): anon writes nothing and reads public_books, not books');
  perform pg_temp.assert(has_table_privilege('service_role', 'public.books', 'SELECT, INSERT, UPDATE, DELETE')
    and has_table_privilege(current_user, 'public.books', 'SELECT, INSERT, UPDATE, DELETE'),
    'part1: service_role and the owner keep full DML');

  -- Policies, defaults and constraints. PEN-NAMES-2 (C1) replaced the
  -- public/owner SELECT policies with an own-row and a staff policy.
  perform pg_temp.assert(
    (select count(*) from pg_policies where schemaname = 'public' and tablename = 'books') = 5,
    'part1: books has 5 policies');
  perform pg_temp.assert(
    (select with_check from pg_policies where tablename = 'books' and policyname = 'Authors can insert their own books') = '(auth.uid() = author_id)'
    and (select qual from pg_policies where tablename = 'books' and policyname = 'Authors can view their own books')
        = '(auth.uid() = author_id)',
    'part1 (PEN-NAMES-2): the insert policy is intact and the select policy is own-row only');
  perform pg_temp.assert(
    (select array_agg(conname::text) from pg_constraint where conrelid = 'public.books'::regclass
                  and pg_get_constraintdef(oid) ~ '(file_path|cover_path)') = array['books_cover_path_check'],
    'part1 (PEN-NAMES-2): the only path constraint is books_cover_path_check (C10)');
  perform pg_temp.assert(
    (select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d
       join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
      where d.adrelid = 'public.books'::regclass and a.attname = 'status') = '''draft''::text',
    'part1: books.status default is exactly ''draft''');
  perform pg_temp.assert(
    not exists (select 1 from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
                 where d.adrelid = 'public.books'::regclass and a.attname in ('file_path', 'cover_path')),
    'part1: neither path column has a default');
end $$;

-- ============================================================
-- Part 2: direct authenticated INSERT. PEN-NAMES-2 (E5): every direct
-- insert is refused by the ACL now, pathless or not.
-- ============================================================
select pg_temp.expect_error('authenticated', 'e0670000-0000-0000-0000-00000000000a',
  $q$insert into public.books (id, author_id, title, subtitle, description, keywords, isbn, language,
       publisher, edition, original_publication_date, genre, series_id, series_position, price_all)
     values ('e0671000-0000-0000-0000-0000000000c1', 'e0670000-0000-0000-0000-00000000000a', 'pathless draft',
       null, 'desc', '', null, 'sq', null, null, null, 'Letërsi artistike',
       'e0673000-0000-0000-0000-00000000000a', 2, 199)$q$,
  '42501', 'permission denied for table books', 'part2 (PEN-NAMES-2): a pathless paid draft is no longer directly insertable');

do $$
begin
  perform pg_temp.assert(
    not exists (select 1 from public.books where id = 'e0671000-0000-0000-0000-0000000000c1'),
    'part2 (PEN-NAMES-2): the refused pathless row did not land');
end $$;

select pg_temp.expect_error('authenticated', 'e0670000-0000-0000-0000-00000000000a',
  $q$insert into public.books (author_id, title, price_all)
     values ('e0670000-0000-0000-0000-00000000000a', 'pathless returning', 0) returning id$q$,
  '42501', 'permission denied for table books', 'part2 (PEN-NAMES-2): INSERT ... RETURNING id is refused too');

select pg_temp.expect_error('authenticated', 'e0670000-0000-0000-0000-00000000000a',
  $q$insert into public.books (author_id, title, file_path) values ('e0670000-0000-0000-0000-00000000000a', 'f null', null)$q$,
  '42501', 'permission denied for table books', 'part2: naming file_path as null is refused');
select pg_temp.expect_error('authenticated', 'e0670000-0000-0000-0000-00000000000a',
  $q$insert into public.books (author_id, title, cover_path) values ('e0670000-0000-0000-0000-00000000000a', 'c null', null)$q$,
  '42501', 'permission denied for table books', 'part2: naming cover_path as null is refused');
select pg_temp.expect_error('authenticated', 'e0670000-0000-0000-0000-00000000000a',
  $q$insert into public.books (id, author_id, title, file_path)
     values ('e0671000-0000-0000-0000-0000000000c2', 'e0670000-0000-0000-0000-00000000000a', 'own canonical manuscript',
       'e0670000-0000-0000-0000-00000000000a/e0671000-0000-0000-0000-0000000000c2.epub')$q$,
  '42501', 'permission denied for table books', 'part2: the author''s own syntactically canonical file_path is refused');
select pg_temp.expect_error('authenticated', 'e0670000-0000-0000-0000-00000000000a',
  $q$insert into public.books (id, author_id, title, cover_path)
     values ('e0671000-0000-0000-0000-0000000000c3', 'e0670000-0000-0000-0000-00000000000a', 'own canonical cover',
       'e0670000-0000-0000-0000-00000000000a/e0671000-0000-0000-0000-0000000000c3-cover.png')$q$,
  '42501', 'permission denied for table books', 'part2: the author''s own syntactically canonical cover_path is refused');
select pg_temp.expect_error('authenticated', 'e0670000-0000-0000-0000-00000000000a',
  $q$insert into public.books (author_id, title, file_path)
     values ('e0670000-0000-0000-0000-00000000000a', 'forged manuscript',
       'e0670000-0000-0000-0000-00000000000b/e0671000-0000-0000-0000-0000000000b1.epub')$q$,
  '42501', 'permission denied for table books', 'part2: another author''s manuscript path is refused');
select pg_temp.expect_error('authenticated', 'e0670000-0000-0000-0000-00000000000a',
  $q$insert into public.books (author_id, title, cover_path)
     values ('e0670000-0000-0000-0000-00000000000a', 'forged cover',
       'e0670000-0000-0000-0000-00000000000b/e0671000-0000-0000-0000-0000000000b1-cover.png')$q$,
  '42501', 'permission denied for table books', 'part2: another author''s cover path is refused');
select pg_temp.expect_error('authenticated', 'e0670000-0000-0000-0000-00000000000a',
  $q$insert into public.books (author_id, title, cover_path, file_path)
     values ('e0670000-0000-0000-0000-00000000000a', 'both',
       'e0670000-0000-0000-0000-00000000000a/x-cover.png', 'e0670000-0000-0000-0000-00000000000a/x.epub')$q$,
  '42501', 'permission denied for table books', 'part2: naming both path columns is refused');
-- The exact column list the pre-Patch-8 createBook sent through the
-- session: refused now. This is why the application must deploy first.
select pg_temp.expect_error('authenticated', 'e0670000-0000-0000-0000-00000000000a',
  $q$insert into public.books (id, author_id, title, subtitle, description, keywords, isbn, language,
       publisher, edition, original_publication_date, genre, series_id, series_position, price_all,
       cover_path, file_path)
     values ('e0671000-0000-0000-0000-0000000000c4', 'e0670000-0000-0000-0000-00000000000a', 'old createBook shape',
       null, 'desc', '', null, 'sq', null, null, null, 'Letërsi artistike', null, null, 199,
       'e0670000-0000-0000-0000-00000000000a/e0671000-0000-0000-0000-0000000000c4-cover.png',
       'e0670000-0000-0000-0000-00000000000a/e0671000-0000-0000-0000-0000000000c4.epub')$q$,
  '42501', 'permission denied for table books', 'part2: the pre-Patch-8 createBook session insert is refused');
select pg_temp.expect_error('authenticated', 'e0670000-0000-0000-0000-00000000000a',
  $q$insert into public.books (author_id, title, file_path)
     select 'e0670000-0000-0000-0000-00000000000a', 'copy b', b.file_path from public.books b
      where b.id = 'e0671000-0000-0000-0000-0000000000a2'$q$,
  '42501', 'permission denied for table books', 'part2: copying a readable path through INSERT ... SELECT is refused');

-- PEN-NAMES-2 (E5): an insert as another author is refused by the ACL
-- before RLS is consulted.
select pg_temp.expect_error('authenticated', 'e0670000-0000-0000-0000-00000000000a',
  $q$insert into public.books (author_id, title) values ('e0670000-0000-0000-0000-00000000000b', 'as someone else')$q$,
  '42501', 'permission denied for table books', 'part2 (PEN-NAMES-2): a pathless insert as another author is refused by the ACL');

-- ============================================================
-- Part 3: direct authenticated UPDATE of a path stays refused.
-- ============================================================
select pg_temp.expect_error('authenticated', 'e0670000-0000-0000-0000-00000000000a',
  $q$update public.books set file_path = 'e0670000-0000-0000-0000-00000000000b/e0671000-0000-0000-0000-0000000000b1.epub'
      where id = 'e0671000-0000-0000-0000-0000000000a1'$q$,
  '42501', 'permission denied for table books', 'part3: UPDATE of file_path to another author''s object is refused');
select pg_temp.expect_error('authenticated', 'e0670000-0000-0000-0000-00000000000a',
  $q$update public.books set cover_path = null where id = 'e0671000-0000-0000-0000-0000000000a1'$q$,
  '42501', 'permission denied for table books', 'part3: UPDATE of cover_path is refused');
select pg_temp.expect_error('authenticated', 'e0670000-0000-0000-0000-00000000000a',
  $q$update public.books set file_path = file_path where id = 'e0671000-0000-0000-0000-0000000000c1'$q$,
  '42501', 'permission denied for table books', 'part3: even a no-op path UPDATE on a pathless draft is refused');
select pg_temp.expect_ok('authenticated', 'e0670000-0000-0000-0000-00000000000a',
  $q$update public.books set series_id = null, series_position = null
      where series_id = 'e0673000-0000-0000-0000-00000000000a' and author_id = 'e0670000-0000-0000-0000-00000000000a'$q$,
  1, 'part3: the series unlink still works on the author''s own rows (PEN-NAMES-2: one row, the refused pathless draft never landed)');

-- ============================================================
-- Part 4: anon stays read-only; RLS still isolates reads.
-- ============================================================
select pg_temp.expect_error('anon', null,
  $q$insert into public.books (author_id, title) values ('e0670000-0000-0000-0000-00000000000a', 'anon')$q$,
  '42501', 'permission denied for table books', 'part4: anon pathless INSERT is refused');
select pg_temp.expect_error('anon', null,
  $q$insert into public.books (author_id, title, file_path) values ('e0670000-0000-0000-0000-00000000000a', 'anon', 'x/y.epub')$q$,
  '42501', 'permission denied for table books', 'part4: anon INSERT with a path is refused');
select pg_temp.expect_error('anon', null,
  $q$update public.books set file_path = 'x' where id = 'e0671000-0000-0000-0000-0000000000a2'$q$,
  '42501', 'permission denied for table books', 'part4: anon UPDATE is refused');
select pg_temp.expect_ok('anon', null,
  $q$select 1 from public.public_books where id::text like 'e0671000-%'$q$,
  2, 'part4 (PEN-NAMES-2): anon sees exactly the two published P067 books through public_books');
select pg_temp.expect_ok('authenticated', 'e0670000-0000-0000-0000-00000000000a',
  $q$select 1 from public.books where id = 'e0671000-0000-0000-0000-0000000000b1'$q$,
  0, 'part4: author A cannot see author B''s draft');
select pg_temp.expect_ok('authenticated', 'e0670000-0000-0000-0000-00000000000a',
  $q$delete from public.books where id = 'e0671000-0000-0000-0000-0000000000b1'$q$,
  0, 'part4: author A cannot delete author B''s draft');

-- ============================================================
-- Part 5: service_role -- the trusted createBook path -- inserts a row
-- with server-derived paths, and keeps its update authority.
-- ============================================================
select pg_temp.expect_ok('service_role', null,
  $q$insert into public.books (id, author_id, title, description, keywords, genre, price_all, cover_path, file_path)
     values ('e0671000-0000-0000-0000-0000000000e1', 'e0670000-0000-0000-0000-00000000000a', 'trusted create',
       'desc', '', 'Letërsi artistike', 199,
       'e0675000-0000-0000-0000-0000000000e1/cover.png',
       'e0670000-0000-0000-0000-00000000000a/e0671000-0000-0000-0000-0000000000e1.epub')
     returning id$q$,
  1, 'part5: service_role inserts the createBook row with its derived paths');
do $$
begin
  perform pg_temp.assert(
    (select status = 'draft' and published_at is null
        and file_path = author_id::text || '/' || id::text || '.epub'
        and cover_path = 'e0675000-0000-0000-0000-0000000000e1/cover.png'
       from public.books where id = 'e0671000-0000-0000-0000-0000000000e1'),
    'part5: the trusted row is a draft whose manuscript path derives from its author and id (PEN-NAMES-2: the cover key is `<random uuid>/cover.<ext>`)');
end $$;
select pg_temp.expect_ok('service_role', null,
  $q$update public.books set cover_path = 'e0675000-0000-0000-0000-0000000000e2/cover.jpg'
      where id = 'e0671000-0000-0000-0000-0000000000e1' and author_id = 'e0670000-0000-0000-0000-00000000000a' returning id$q$,
  1, 'part5: service_role keeps path UPDATE (updateBook''s replacement upload)');

-- ============================================================
-- Part 6: nothing refused above changed a pre-existing row. The series
-- unlink in part 3 legitimately changed the series columns of two A rows,
-- so this compares each fixture row's id, owner, status and exact paths.
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    (select string_agg(id::text || '|' || author_id::text || '|' || status || '|'
                       || coalesce(cover_path, '<null>') || '|' || coalesce(file_path, '<null>'), ',' order by id)
       from public.books where id in ('e0671000-0000-0000-0000-0000000000a1', 'e0671000-0000-0000-0000-0000000000a2',
                                      'e0671000-0000-0000-0000-0000000000a3', 'e0671000-0000-0000-0000-0000000000b1'))
    = 'e0671000-0000-0000-0000-0000000000a1|e0670000-0000-0000-0000-00000000000a|draft|'
      || 'e0675000-0000-0000-0000-0000000000a1/cover.png|'
      || 'e0670000-0000-0000-0000-00000000000a/e0671000-0000-0000-0000-0000000000a1.epub,'
      || 'e0671000-0000-0000-0000-0000000000a2|e0670000-0000-0000-0000-00000000000a|published|'
      || 'e0675000-0000-0000-0000-0000000000a2/cover.jpg|'
      || 'e0670000-0000-0000-0000-00000000000a/e0671000-0000-0000-0000-0000000000a2.epub,'
      || 'e0671000-0000-0000-0000-0000000000a3|e0670000-0000-0000-0000-00000000000a|published|'
      || '<null>|legacy/manuscript.epub,'
      || 'e0671000-0000-0000-0000-0000000000b1|e0670000-0000-0000-0000-00000000000b|draft|'
      || 'e0675000-0000-0000-0000-0000000000b1/cover.png|'
      || 'e0670000-0000-0000-0000-00000000000b/e0671000-0000-0000-0000-0000000000b1.epub',
    'part6: every fixture row keeps its owner, status and exact paths, legacy row included');
  perform pg_temp.assert(
    (select count(*) from public.books where id::text like 'e0671000-%') = 5
    and (select count(*) from public.books where title = 'pathless returning') = 0
    and (select count(*) from public.books where file_path is not null and id::text like 'e0671000-%') = 5,
    'part6 (PEN-NAMES-2): only the trusted insert added a row, and no refused path landed');
end $$;

-- ============================================================
-- Part 7: the suite really ran.
-- ============================================================
do $$
declare
  v_n integer;
begin
  select n into v_n from pg_temp.assertions_run;
  if v_n <> 63 then
    raise exception 'FAIL: expected 63 assertions to run, found %', v_n;
  end if;
end $$;

select 'CATALOG-STORAGE-PATH-AUTH-1 067 suite: all assertions passed' as result;

rollback;
