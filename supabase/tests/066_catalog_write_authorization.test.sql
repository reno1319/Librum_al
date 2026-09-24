-- Committed SQL regression suite for CATALOG-WRITE-AUTH-1
-- (supabase/migrations/20260924101853_catalog_write_authorization.sql):
-- authors can no longer write the protected catalog columns of
-- public.books and public.bundles directly -- `status`, `price_all`,
-- `published_at`, `author_id`, legacy `price_cents`, the timestamps --
-- while paid DRAFT creation, the series unlink, author deletes, public
-- reads and every service_role write keep working.
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql -- no new test
-- infrastructure, same as every other suite in this directory.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance (17 or newer: schema.sql uses the MAINTAIN privilege):
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/066_catalog_write_authorization.test.sql
--
-- It must also pass against the OTHER build path -- base schema.sql plus
-- the migration -- and
-- supabase/tests/066_catalog_write_authorization_catalog_equivalence.sh
-- is what proves those two paths agree in the first place. Against the
-- BASE schema alone it must FAIL: that is the negative control showing
-- this suite can see the hole it exists to close.
--
-- Everything below runs inside one transaction and is rolled back at the
-- end, so every probe is rollback-only, the file is repeatable, and it
-- leaves no rows behind.
--
-- Two kinds of proof, deliberately both. Privilege METADATA (relacl,
-- attacl, has_*_privilege) says what the catalog grants; EFFECTIVE
-- behaviour (real INSERT/UPDATE/DELETE/TRUNCATE/SELECT under each role,
-- with RLS on) says what a caller can actually do.
--
-- Privilege errors and RLS errors share SQLSTATE 42501, so every
-- expected failure also pins the message fragment that tells them apart:
-- "permission denied for table" is the ACL, "row-level security" is the
-- policy. A test expecting one must not pass on the other.

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
-- were written. Author A owns a paid draft, a free published book and a
-- paid published book (all in one series), a draft bundle and a published
-- paid bundle; author B owns one draft book and one published bundle.
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0660000-0000-0000-0000-00000000000a', 'p066-author-a@test', now(), '{"role":"author","display_name":"P066 A"}'),
  ('e0660000-0000-0000-0000-00000000000b', 'p066-author-b@test', now(), '{"role":"author","display_name":"P066 B"}');

update public.profiles set role = 'author'
  where id in ('e0660000-0000-0000-0000-00000000000a', 'e0660000-0000-0000-0000-00000000000b');

insert into public.series (id, author_id, title) values
  ('e0663000-0000-0000-0000-00000000000a', 'e0660000-0000-0000-0000-00000000000a', 'P066 Series A'),
  ('e0663000-0000-0000-0000-00000000000b', 'e0660000-0000-0000-0000-00000000000b', 'P066 Series B');

insert into public.books (id, author_id, title, status, price_all, published_at, series_id, series_position) values
  ('e0661000-0000-0000-0000-0000000000a1', 'e0660000-0000-0000-0000-00000000000a', 'P066 A draft paid',     'draft',     199, null,  'e0663000-0000-0000-0000-00000000000a', 1),
  ('e0661000-0000-0000-0000-0000000000a2', 'e0660000-0000-0000-0000-00000000000a', 'P066 A published free', 'published', 0,   now(), 'e0663000-0000-0000-0000-00000000000a', 2),
  ('e0661000-0000-0000-0000-0000000000a3', 'e0660000-0000-0000-0000-00000000000a', 'P066 A published paid','published', 199, now(), null, null),
  ('e0661000-0000-0000-0000-0000000000b1', 'e0660000-0000-0000-0000-00000000000b', 'P066 B draft',          'draft',     0,   null,  'e0663000-0000-0000-0000-00000000000b', 1);

insert into public.bundles (id, author_id, title, status, price_all) values
  ('e0662000-0000-0000-0000-0000000000a1', 'e0660000-0000-0000-0000-00000000000a', 'P066 A draft bundle',     'draft',     0),
  ('e0662000-0000-0000-0000-0000000000a2', 'e0660000-0000-0000-0000-00000000000a', 'P066 A published bundle', 'published', 299),
  ('e0662000-0000-0000-0000-0000000000b1', 'e0660000-0000-0000-0000-00000000000b', 'P066 B published bundle', 'published', 0);

-- ============================================================
-- Part 1: privilege metadata.
-- ============================================================
do $$
begin
  -- RLS stays enabled (and is not newly forced) on both tables.
  perform pg_temp.assert(
    (select relrowsecurity and not relforcerowsecurity from pg_class where oid = 'public.books'::regclass),
    'part1: books keeps RLS enabled, not forced');
  perform pg_temp.assert(
    (select relrowsecurity and not relforcerowsecurity from pg_class where oid = 'public.bundles'::regclass),
    'part1: bundles keeps RLS enabled, not forced');

  -- Exact table-level ACLs. anon: SELECT only. authenticated: SELECT
  -- and DELETE only -- no INSERT, UPDATE, TRUNCATE, REFERENCES, TRIGGER or
  -- MAINTAIN at table level. service_role: all, unchanged. PUBLIC:
  -- nothing (table_acl would list a PUBLIC entry).
  perform pg_temp.assert(
    pg_temp.table_acl('public.books') =
      'anon:SELECT'
      || '|authenticated:DELETE,SELECT'
      || '|service_role:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE',
    format('part1: books table ACL -- got %s', pg_temp.table_acl('public.books')));
  perform pg_temp.assert(
    pg_temp.table_acl('public.bundles') =
      'anon:SELECT'
      || '|authenticated:DELETE,SELECT'
      || '|service_role:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE',
    format('part1: bundles table ACL -- got %s', pg_temp.table_acl('public.bundles')));

  -- Exact column-level ACLs: authenticated only, INSERT on the create
  -- columns, UPDATE on the series link (books) and nothing (bundles).
  perform pg_temp.assert(
    pg_temp.column_acl('public.books') =
      'authenticated:INSERT:author_id,cover_path,description,edition,file_path,genre,id,isbn,'
      || 'keywords,language,original_publication_date,price_all,publisher,series_id,'
      || 'series_position,subtitle,title'
      || '|authenticated:UPDATE:series_id,series_position',
    format('part1: books column ACL -- got %s', pg_temp.column_acl('public.books')));
  perform pg_temp.assert(
    pg_temp.column_acl('public.bundles') = 'authenticated:INSERT:author_id,description,price_all,title',
    format('part1: bundles column ACL -- got %s', pg_temp.column_acl('public.bundles')));

  -- Effective privilege, as the privilege functions see it.
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.books', 'INSERT'), 'part1: authenticated has no table INSERT on books');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.books', 'UPDATE'), 'part1: authenticated has no table UPDATE on books');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.bundles', 'INSERT'), 'part1: authenticated has no table INSERT on bundles');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.bundles', 'UPDATE'), 'part1: authenticated has no table UPDATE on bundles');
  perform pg_temp.assert(not has_any_column_privilege('authenticated', 'public.bundles', 'UPDATE'), 'part1: authenticated has no column UPDATE on bundles at all');
  perform pg_temp.assert(not has_any_column_privilege('anon', 'public.books', 'INSERT, UPDATE'), 'part1: anon can write no column of books');
  perform pg_temp.assert(not has_any_column_privilege('anon', 'public.bundles', 'INSERT, UPDATE'), 'part1: anon can write no column of bundles');
  perform pg_temp.assert(has_table_privilege('anon', 'public.books', 'SELECT') and has_table_privilege('anon', 'public.bundles', 'SELECT'), 'part1: anon keeps SELECT');
  perform pg_temp.assert(has_table_privilege('authenticated', 'public.books', 'SELECT, DELETE') and has_table_privilege('authenticated', 'public.bundles', 'SELECT, DELETE'), 'part1: authenticated keeps SELECT and DELETE');
  perform pg_temp.assert(has_table_privilege('service_role', 'public.books', 'SELECT, INSERT, UPDATE, DELETE') and has_table_privilege('service_role', 'public.bundles', 'SELECT, INSERT, UPDATE, DELETE'), 'part1: service_role keeps full DML');
end $$;

-- Neither anon nor authenticated holds any of the four non-DML
-- privileges the reset removed, at table level or (REFERENCES, the only
-- one of the four that exists per column) on any column; anon holds no
-- DELETE; service_role keeps all four. 22 assertions.
do $$
declare
  v_role text;
  v_table text;
  v_priv text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_table in array array['public.books', 'public.bundles'] loop
      foreach v_priv in array array['REFERENCES', 'TRIGGER', 'MAINTAIN', 'TRUNCATE'] loop
        perform pg_temp.assert(not has_table_privilege(v_role, v_table, v_priv),
          format('part1: %s has no %s on %s', v_role, v_priv, v_table));
      end loop;
      perform pg_temp.assert(not has_any_column_privilege(v_role, v_table, 'REFERENCES'),
        format('part1: %s has no column-level REFERENCES on %s', v_role, v_table));
    end loop;
  end loop;
  perform pg_temp.assert(not has_table_privilege('anon', 'public.books', 'DELETE') and not has_table_privilege('anon', 'public.bundles', 'DELETE'),
    'part1: anon has no DELETE on books or bundles');
  perform pg_temp.assert(
    has_table_privilege('service_role', 'public.books', 'TRUNCATE')
      and has_table_privilege('service_role', 'public.books', 'REFERENCES')
      and has_table_privilege('service_role', 'public.books', 'TRIGGER')
      and has_table_privilege('service_role', 'public.books', 'MAINTAIN')
      and has_table_privilege('service_role', 'public.bundles', 'TRUNCATE')
      and has_table_privilege('service_role', 'public.bundles', 'REFERENCES')
      and has_table_privilege('service_role', 'public.bundles', 'TRIGGER')
      and has_table_privilege('service_role', 'public.bundles', 'MAINTAIN'),
    'part1: service_role keeps TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on both tables');
end $$;

-- Every protected column is unwritable by authenticated, per column.
do $$
declare
  v_col text;
begin
  foreach v_col in array array['status', 'price_all', 'published_at', 'author_id', 'price_cents', 'created_at', 'updated_at', 'cover_path', 'file_path', 'title'] loop
    perform pg_temp.assert(not has_column_privilege('authenticated', 'public.books', v_col, 'UPDATE'),
      format('part1: authenticated cannot UPDATE books.%s', v_col));
  end loop;
  foreach v_col in array array['status', 'price_cents', 'published_at', 'created_at', 'updated_at', 'preview_text'] loop
    perform pg_temp.assert(not has_column_privilege('authenticated', 'public.books', v_col, 'INSERT'),
      format('part1: authenticated cannot INSERT books.%s', v_col));
  end loop;
  foreach v_col in array array['status', 'price_all', 'author_id', 'price_cents', 'created_at', 'updated_at', 'title', 'description'] loop
    perform pg_temp.assert(not has_column_privilege('authenticated', 'public.bundles', v_col, 'UPDATE'),
      format('part1: authenticated cannot UPDATE bundles.%s', v_col));
  end loop;
  foreach v_col in array array['id', 'status', 'price_cents', 'created_at', 'updated_at'] loop
    perform pg_temp.assert(not has_column_privilege('authenticated', 'public.bundles', v_col, 'INSERT'),
      format('part1: authenticated cannot INSERT bundles.%s', v_col));
  end loop;

  -- The status default is still exactly 'draft' on both tables.
  perform pg_temp.assert(
    (select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d
       join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
      where d.adrelid = 'public.books'::regclass and a.attname = 'status') = '''draft''::text',
    'part1: books.status default is exactly ''draft''');
  perform pg_temp.assert(
    (select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d
       join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
      where d.adrelid = 'public.bundles'::regclass and a.attname = 'status') = '''draft''::text',
    'part1: bundles.status default is exactly ''draft''');

  -- The ownership policies are all still there, unchanged in number.
  perform pg_temp.assert(
    (select count(*) from pg_policies where schemaname = 'public' and tablename = 'books') = 5
    and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'bundles') = 4,
    'part1: books keeps its 5 policies and bundles its 4');
  perform pg_temp.assert(
    (select with_check from pg_policies where tablename = 'books' and policyname = 'Authors can insert their own books') = '(auth.uid() = author_id)'
    and (select with_check from pg_policies where tablename = 'bundles' and policyname = 'Authors can insert their own bundles') = '(auth.uid() = author_id)'
    and (select qual from pg_policies where tablename = 'books' and policyname = 'Authors can update their own books') = '(auth.uid() = author_id)'
    and (select with_check from pg_policies where tablename = 'books' and policyname = 'Authors can update their own books') = '(auth.uid() = author_id)',
    'part1: the ownership checks are intact');
end $$;

-- ============================================================
-- Part 2: authenticated INSERT. A direct insert naming `status` is
-- refused whatever its value; a paid draft that omits it succeeds and
-- lands as 'draft'.
-- ============================================================
select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$insert into public.books (id, author_id, title, status, price_all)
     values ('e0661000-0000-0000-0000-0000000000c1', 'e0660000-0000-0000-0000-00000000000a', 'direct published paid', 'published', 500)$q$,
  '42501', 'permission denied for table books', 'part2: INSERT naming status=published is denied by the ACL');

select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$insert into public.books (id, author_id, title, status, price_all)
     values ('e0661000-0000-0000-0000-0000000000c2', 'e0660000-0000-0000-0000-00000000000a', 'direct draft', 'draft', 500)$q$,
  '42501', 'permission denied for table books', 'part2: INSERT naming status=draft is denied too');

select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$insert into public.books (id, author_id, title, price_all, published_at)
     values ('e0661000-0000-0000-0000-0000000000c3', 'e0660000-0000-0000-0000-00000000000a', 'direct', 500, now())$q$,
  '42501', 'permission denied for table books', 'part2: INSERT naming published_at is denied');

select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$insert into public.books (id, author_id, title, price_cents)
     values ('e0661000-0000-0000-0000-0000000000c4', 'e0660000-0000-0000-0000-00000000000a', 'direct', 999)$q$,
  '42501', 'permission denied for table books', 'part2: INSERT naming legacy price_cents is denied');

select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$insert into public.books (id, author_id, title, created_at)
     values ('e0661000-0000-0000-0000-0000000000c5', 'e0660000-0000-0000-0000-00000000000a', 'direct', now())$q$,
  '42501', 'permission denied for table books', 'part2: INSERT naming created_at is denied');

-- The exact column list createBook sends, with a paid price: succeeds.
select pg_temp.expect_ok('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$insert into public.books (id, author_id, title, subtitle, description, keywords, isbn, language,
       publisher, edition, original_publication_date, genre, series_id, series_position, price_all,
       cover_path, file_path)
     values ('e0661000-0000-0000-0000-0000000000c6', 'e0660000-0000-0000-0000-00000000000a', 'createBook paid draft',
       null, 'desc', '', null, 'sq', null, null, null, 'Fiction',
       'e0663000-0000-0000-0000-00000000000a', 3, 199,
       'e0660000-0000-0000-0000-00000000000a/c6-cover.png', 'e0660000-0000-0000-0000-00000000000a/c6.epub')$q$,
  1, 'part2: createBook''s paid draft insert, omitting status, succeeds');

do $$
begin
  perform pg_temp.assert(
    (select status = 'draft' and price_all = 199 and published_at is null and price_cents = 0
       from public.books where id = 'e0661000-0000-0000-0000-0000000000c6'),
    'part2: the new book is a paid DRAFT by default, with no published_at and legacy price_cents 0');
end $$;

-- Ownership still enforced on insert: RLS, not the ACL, refuses this.
select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$insert into public.books (id, author_id, title, price_all)
     values ('e0661000-0000-0000-0000-0000000000c7', 'e0660000-0000-0000-0000-00000000000b', 'as someone else', 0)$q$,
  '42501', 'row-level security', 'part2: inserting a book for another author is refused by RLS');

-- Bundles: the same shape.
select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$insert into public.bundles (author_id, title, status, price_all)
     values ('e0660000-0000-0000-0000-00000000000a', 'direct published bundle', 'published', 500)$q$,
  '42501', 'permission denied for table bundles', 'part2: bundle INSERT naming status=published is denied');

select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$insert into public.bundles (author_id, title, status, price_all)
     values ('e0660000-0000-0000-0000-00000000000a', 'direct draft bundle', 'draft', 500)$q$,
  '42501', 'permission denied for table bundles', 'part2: bundle INSERT naming status=draft is denied');

select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$insert into public.bundles (author_id, title, price_cents)
     values ('e0660000-0000-0000-0000-00000000000a', 'direct', 999)$q$,
  '42501', 'permission denied for table bundles', 'part2: bundle INSERT naming legacy price_cents is denied');

select pg_temp.expect_ok('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$insert into public.bundles (author_id, title, description, price_all)
     values ('e0660000-0000-0000-0000-00000000000a', 'P066 createBundle paid draft', 'two books', 299)$q$,
  1, 'part2: createBundle''s paid draft insert, omitting status, succeeds');

-- createBundle reads back the new id through `.select("id")`: INSERT ...
-- RETURNING id must also work under the new ACL.
select pg_temp.expect_ok('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$insert into public.bundles (author_id, title, description, price_all)
     values ('e0660000-0000-0000-0000-00000000000a', 'P066 createBundle returning', '', 0) returning id$q$,
  1, 'part2: INSERT ... RETURNING id works for the author');

do $$
begin
  perform pg_temp.assert(
    (select bool_and(status = 'draft') and count(*) = 2 from public.bundles where title like 'P066 createBundle%'),
    'part2: both new bundles are drafts by default');
end $$;

select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$insert into public.bundles (author_id, title, price_all)
     values ('e0660000-0000-0000-0000-00000000000b', 'as someone else', 0)$q$,
  '42501', 'row-level security', 'part2: inserting a bundle for another author is refused by RLS');

-- ============================================================
-- Part 3: authenticated UPDATE. Every protected column is refused by
-- the ACL even on the author's own row; the series link still works.
-- ============================================================
select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$update public.books set status = 'published' where id = 'e0661000-0000-0000-0000-0000000000a1'$q$,
  '42501', 'permission denied for table books', 'part3: UPDATE of books.status on an own paid draft is denied');
select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$update public.books set price_all = 750 where id = 'e0661000-0000-0000-0000-0000000000a2'$q$,
  '42501', 'permission denied for table books', 'part3: UPDATE of books.price_all on an own published free book is denied');
select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$update public.books set published_at = now() where id = 'e0661000-0000-0000-0000-0000000000a1'$q$,
  '42501', 'permission denied for table books', 'part3: UPDATE of books.published_at is denied');
select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$update public.books set author_id = 'e0660000-0000-0000-0000-00000000000b' where id = 'e0661000-0000-0000-0000-0000000000a1'$q$,
  '42501', 'permission denied for table books', 'part3: UPDATE of books.author_id is denied');
select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$update public.books set price_cents = 999 where id = 'e0661000-0000-0000-0000-0000000000a1'$q$,
  '42501', 'permission denied for table books', 'part3: UPDATE of legacy books.price_cents is denied');
select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$update public.books set created_at = now(), updated_at = now() where id = 'e0661000-0000-0000-0000-0000000000a1'$q$,
  '42501', 'permission denied for table books', 'part3: UPDATE of books timestamps is denied');
select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$update public.books set file_path = 'e0660000-0000-0000-0000-00000000000b/other.epub' where id = 'e0661000-0000-0000-0000-0000000000a3'$q$,
  '42501', 'permission denied for table books', 'part3: UPDATE of books.file_path is denied');
select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$update public.books set status = 'published', price_all = 500, series_id = null where id = 'e0661000-0000-0000-0000-0000000000a1'$q$,
  '42501', 'permission denied for table books', 'part3: a protected column cannot ride along with a permitted one');

-- The series unlink deleteSeries issues, on the author's own rows.
select pg_temp.expect_ok('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$update public.books set series_id = null, series_position = null
      where series_id = 'e0663000-0000-0000-0000-00000000000a' and author_id = 'e0660000-0000-0000-0000-00000000000a'$q$,
  3, 'part3: deleteSeries unlinks the author''s three series books');
-- Another author's series row is filtered out by RLS, not refused.
select pg_temp.expect_ok('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$update public.books set series_id = null, series_position = null
      where series_id = 'e0663000-0000-0000-0000-00000000000b'$q$,
  0, 'part3: another author''s series book is not updatable (RLS matches no row)');
select pg_temp.expect_ok('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$update public.books set series_position = 4 where id = 'e0661000-0000-0000-0000-0000000000b1'$q$,
  0, 'part3: another author''s book cannot be touched through the permitted columns either');

do $$
begin
  perform pg_temp.assert(
    (select count(*) from public.books where series_id = 'e0663000-0000-0000-0000-00000000000a') = 0
    and (select series_id = 'e0663000-0000-0000-0000-00000000000b' and series_position = 1
           from public.books where id = 'e0661000-0000-0000-0000-0000000000b1'),
    'part3: A''s series is unlinked and B''s book is untouched');
  perform pg_temp.assert(
    (select status = 'draft' and price_all = 199 and published_at is null
       from public.books where id = 'e0661000-0000-0000-0000-0000000000a1')
    and (select status = 'published' and price_all = 0
           from public.books where id = 'e0661000-0000-0000-0000-0000000000a2'),
    'part3: every refused protected write left its row exactly as it was');
end $$;

-- Bundles: no authenticated UPDATE of any column.
select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$update public.bundles set status = 'published' where id = 'e0662000-0000-0000-0000-0000000000a1'$q$,
  '42501', 'permission denied for table bundles', 'part3: UPDATE of bundles.status is denied');
select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$update public.bundles set price_all = 900 where id = 'e0662000-0000-0000-0000-0000000000a2'$q$,
  '42501', 'permission denied for table bundles', 'part3: UPDATE of a published bundle''s price_all is denied');
select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$update public.bundles set author_id = 'e0660000-0000-0000-0000-00000000000b' where id = 'e0662000-0000-0000-0000-0000000000a1'$q$,
  '42501', 'permission denied for table bundles', 'part3: UPDATE of bundles.author_id is denied');
select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$update public.bundles set price_cents = 1 where id = 'e0662000-0000-0000-0000-0000000000a1'$q$,
  '42501', 'permission denied for table bundles', 'part3: UPDATE of legacy bundles.price_cents is denied');
select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$update public.bundles set title = 'renamed' where id = 'e0662000-0000-0000-0000-0000000000a1'$q$,
  '42501', 'permission denied for table bundles', 'part3: even bundle metadata is not directly updatable');

-- ============================================================
-- Part 4: anon writes nothing, and TRUNCATE and TRIGGER are gone for both
-- roles.
-- ============================================================
select pg_temp.expect_error('anon', null,
  $q$insert into public.books (id, author_id, title) values ('e0661000-0000-0000-0000-0000000000d1', 'e0660000-0000-0000-0000-00000000000a', 'anon')$q$,
  '42501', 'permission denied for table books', 'part4: anon INSERT into books is denied');
select pg_temp.expect_error('anon', null,
  $q$update public.books set title = 'anon' where id = 'e0661000-0000-0000-0000-0000000000a2'$q$,
  '42501', 'permission denied for table books', 'part4: anon UPDATE of books is denied');
select pg_temp.expect_error('anon', null,
  $q$delete from public.books where id = 'e0661000-0000-0000-0000-0000000000a2'$q$,
  '42501', 'permission denied for table books', 'part4: anon DELETE from books is denied');
select pg_temp.expect_error('anon', null,
  $q$insert into public.bundles (author_id, title) values ('e0660000-0000-0000-0000-00000000000a', 'anon')$q$,
  '42501', 'permission denied for table bundles', 'part4: anon INSERT into bundles is denied');
select pg_temp.expect_error('anon', null,
  $q$update public.bundles set title = 'anon' where id = 'e0662000-0000-0000-0000-0000000000a2'$q$,
  '42501', 'permission denied for table bundles', 'part4: anon UPDATE of bundles is denied');
select pg_temp.expect_error('anon', null,
  $q$delete from public.bundles where id = 'e0662000-0000-0000-0000-0000000000a2'$q$,
  '42501', 'permission denied for table bundles', 'part4: anon DELETE from bundles is denied');
select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$truncate public.books cascade$q$,
  '42501', 'permission denied for table books', 'part4: authenticated TRUNCATE of books is denied');
select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$truncate public.bundles cascade$q$,
  '42501', 'permission denied for table bundles', 'part4: authenticated TRUNCATE of bundles is denied');
select pg_temp.expect_error('anon', null,
  $q$truncate public.books cascade$q$,
  '42501', 'permission denied for table books', 'part4: anon TRUNCATE of books is denied');
select pg_temp.expect_error('anon', null,
  $q$truncate public.bundles cascade$q$,
  '42501', 'permission denied for table bundles', 'part4: anon TRUNCATE of bundles is denied');

-- TRIGGER, effectively: neither role can attach a trigger to either
-- table. The trigger would be inert (`when (false)`) so that, on the
-- negative-control path where it is allowed, it changes no later probe.
select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$create trigger p066_probe before update on public.books for each row when (false) execute function suppress_redundant_updates_trigger()$q$,
  '42501', 'permission denied for table books', 'part4: authenticated cannot create a trigger on books');
select pg_temp.expect_error('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$create trigger p066_probe before update on public.bundles for each row when (false) execute function suppress_redundant_updates_trigger()$q$,
  '42501', 'permission denied for table bundles', 'part4: authenticated cannot create a trigger on bundles');
select pg_temp.expect_error('anon', null,
  $q$create trigger p066_probe before update on public.books for each row when (false) execute function suppress_redundant_updates_trigger()$q$,
  '42501', 'permission denied for table books', 'part4: anon cannot create a trigger on books');
select pg_temp.expect_error('anon', null,
  $q$create trigger p066_probe before update on public.bundles for each row when (false) execute function suppress_redundant_updates_trigger()$q$,
  '42501', 'permission denied for table bundles', 'part4: anon cannot create a trigger on bundles');

-- ============================================================
-- Part 5: reads are unchanged. anon sees published rows only; the author
-- sees published rows plus their own drafts.
-- ============================================================
select pg_temp.expect_ok('anon', null,
  $q$select 1 from public.books where id::text like 'e0661000-%'$q$,
  2, 'part5: anon sees exactly the two published P066 books');
select pg_temp.expect_ok('anon', null,
  $q$select 1 from public.bundles where id::text like 'e0662000-%'$q$,
  2, 'part5: anon sees exactly the two published P066 bundles');
select pg_temp.expect_ok('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$select 1 from public.books where id::text like 'e0661000-%'$q$,
  4, 'part5: author A sees their three books, the new draft, and none of B''s drafts');
select pg_temp.expect_ok('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$select id, status, price_all from public.books where id = 'e0661000-0000-0000-0000-0000000000a1'$q$,
  1, 'part5: the author can still read status and price_all (the compare-and-set reads)');

-- ============================================================
-- Part 6: author deletes are unchanged, and still ownership-scoped.
-- ============================================================
select pg_temp.expect_ok('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$delete from public.books where id = 'e0661000-0000-0000-0000-0000000000c6' and author_id = 'e0660000-0000-0000-0000-00000000000a'$q$,
  1, 'part6: the author can delete their own book');
select pg_temp.expect_ok('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$delete from public.books where id = 'e0661000-0000-0000-0000-0000000000b1'$q$,
  0, 'part6: the author cannot delete another author''s book');
select pg_temp.expect_ok('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$delete from public.bundles where id = 'e0662000-0000-0000-0000-0000000000a1' and author_id = 'e0660000-0000-0000-0000-00000000000a'$q$,
  1, 'part6: the author can delete their own bundle');
select pg_temp.expect_ok('authenticated', 'e0660000-0000-0000-0000-00000000000a',
  $q$delete from public.bundles where id = 'e0662000-0000-0000-0000-0000000000b1'$q$,
  0, 'part6: the author cannot delete another author''s bundle');

-- ============================================================
-- Part 7: service_role -- the trusted server path -- keeps every
-- protected write.
-- ============================================================
select pg_temp.expect_ok('service_role', null,
  $q$update public.books set status = 'published', published_at = now()
      where id = 'e0661000-0000-0000-0000-0000000000a1' and author_id = 'e0660000-0000-0000-0000-00000000000a'
        and status = 'draft' and price_all = 199 returning id$q$,
  1, 'part7: service_role publishes a book with the compare-and-set filters');
select pg_temp.expect_ok('service_role', null,
  $q$update public.books set title = 'edited', price_all = 250
      where id = 'e0661000-0000-0000-0000-0000000000a3' and author_id = 'e0660000-0000-0000-0000-00000000000a' returning id$q$,
  1, 'part7: service_role writes metadata and price_all in one row update');
select pg_temp.expect_ok('service_role', null,
  $q$update public.books set status = 'draft'
      where id = 'e0661000-0000-0000-0000-0000000000a2' and author_id = 'e0660000-0000-0000-0000-00000000000a' returning id$q$,
  1, 'part7: service_role unpublishes a book');
select pg_temp.expect_ok('service_role', null,
  $q$update public.books set status = 'published'
      where id = 'e0661000-0000-0000-0000-0000000000b1' and author_id = 'e0660000-0000-0000-0000-00000000000a'$q$,
  0, 'part7: the author_id predicate is what scopes a service_role write -- another author''s row matches nothing');
select pg_temp.expect_ok('service_role', null,
  $q$update public.bundles set title = 'edited', price_all = 399, status = 'published'
      where id = 'e0662000-0000-0000-0000-0000000000a2' and author_id = 'e0660000-0000-0000-0000-00000000000a' returning id$q$,
  1, 'part7: service_role writes bundle metadata, price_all and status');
select pg_temp.expect_ok('service_role', null,
  $q$insert into public.books (id, author_id, title, status, price_all)
     values ('e0661000-0000-0000-0000-0000000000e1', 'e0660000-0000-0000-0000-00000000000a', 'service insert', 'published', 199)$q$,
  1, 'part7: service_role can still insert any column');

do $$
begin
  perform pg_temp.assert(
    (select status = 'published' and published_at is not null from public.books where id = 'e0661000-0000-0000-0000-0000000000a1')
    and (select price_all = 250 and title = 'edited' from public.books where id = 'e0661000-0000-0000-0000-0000000000a3')
    and (select status = 'draft' from public.books where id = 'e0661000-0000-0000-0000-0000000000a2')
    and (select status = 'draft' from public.books where id = 'e0661000-0000-0000-0000-0000000000b1')
    and (select price_all = 399 and status = 'published' from public.bundles where id = 'e0662000-0000-0000-0000-0000000000a2'),
    'part7: every service_role write landed exactly where it was scoped');
end $$;

-- ============================================================
-- Part 8: the suite really ran. The number of assertions is pinned, so
-- a block that silently stopped asserting is a failure, not a pass.
-- ============================================================
do $$
declare
  v_n integer;
begin
  select n into v_n from pg_temp.assertions_run;
  if v_n <> 133 then
    raise exception 'FAIL: expected 133 assertions to run, found %', v_n;
  end if;
end $$;

select 'CATALOG-WRITE-AUTH-1 066 suite: all assertions passed' as result;

rollback;
