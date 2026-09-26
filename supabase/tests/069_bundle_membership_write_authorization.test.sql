-- Committed SQL regression suite for BUNDLE-MEMBERSHIP-AUTH-1
-- (supabase/migrations/20260926061034_bundle_membership_trusted_writer.sql
-- and 20260926061037_bundle_membership_write_authorization.sql):
-- no client role writes public.bundle_books directly any more, and the
-- only writers -- public.replace_bundle_membership and
-- public.create_bundle_with_membership, EXECUTE for service_role only --
-- replace a bundle's membership atomically and only with at least two
-- distinct books that the bundle's own author still owns and has
-- published. Reads, both ON DELETE CASCADE paths, the policies and the
-- service_role fixture tooling keep working.
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql -- no new test
-- infrastructure.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance (17 or newer: schema.sql uses the MAINTAIN privilege):
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/069_bundle_membership_write_authorization.test.sql
--
-- It must also pass against the OTHER build path -- base schema.sql plus
-- both migrations -- and
-- supabase/tests/069_bundle_membership_write_authorization_catalog_equivalence.sh
-- proves those two paths agree. Against the BASE schema alone it must
-- FAIL: that is the negative control showing this suite can see the hole.
--
-- Everything runs inside one transaction and is rolled back at the end,
-- so every probe is rollback-only and the file leaves no rows behind.
--
-- Privilege errors and RLS errors share SQLSTATE 42501, so every
-- expected failure also pins the message fragment that tells them apart:
-- "permission denied for table" / "permission denied for function" is the
-- ACL, "row-level security" is a policy, "bundle membership:" is the
-- writer's own refusal.

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

-- Table-level ACL for anon, authenticated, service_role and PUBLIC, as
-- 'grantee:PRIV,PRIV|...'. The owner is left out: it differs by
-- environment (postgres on Supabase, the test user here).
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

-- Function ACL for the same roles, owner left out likewise.
create function pg_temp.function_acl(p_fn regprocedure) returns text
  language sql stable as $$
  select coalesce(string_agg(g.name || ':' || a.privilege_type, '|' order by g.name), '')
    from pg_proc p
    cross join lateral aclexplode(p.proacl) a
    left join pg_roles r on r.oid = a.grantee
    cross join lateral (select case when a.grantee = 0 then 'PUBLIC' else r.rolname end as name) g
   where p.oid = p_fn
     and a.grantee <> p.proowner;
$$;

-- The membership of one bundle, as 'book,book' in book-id order.
create function pg_temp.members(p_bundle uuid) returns text
  language sql stable as $$
  select coalesce(string_agg(book_id::text, ',' order by book_id), '<none>')
    from public.bundle_books where bundle_id = p_bundle;
$$;

-- ============================================================
-- Part 0: fixtures, written as the table owner.
-- Author A: published books a1, a2, a3; draft book a4; a draft bundle
-- (members a1, a2) and a published bundle (members a2, a3).
-- Author B: published books b1, b2; a published bundle (members b1, b2).
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0690000-0000-4000-8000-00000000000a', 'p069-author-a@test', now(), '{"role":"author","display_name":"P069 A"}'),
  ('e0690000-0000-4000-8000-00000000000b', 'p069-author-b@test', now(), '{"role":"author","display_name":"P069 B"}');

update public.profiles set role = 'author'
  where id in ('e0690000-0000-4000-8000-00000000000a', 'e0690000-0000-4000-8000-00000000000b');

insert into public.books (id, author_id, title, status, price_all, published_at) values
  ('e0691000-0000-4000-8000-0000000000a1', 'e0690000-0000-4000-8000-00000000000a', 'P069 A1', 'published', 199, now()),
  ('e0691000-0000-4000-8000-0000000000a2', 'e0690000-0000-4000-8000-00000000000a', 'P069 A2', 'published', 0,   now()),
  ('e0691000-0000-4000-8000-0000000000a3', 'e0690000-0000-4000-8000-00000000000a', 'P069 A3', 'published', 299, now()),
  ('e0691000-0000-4000-8000-0000000000a4', 'e0690000-0000-4000-8000-00000000000a', 'P069 A4 draft', 'draft', 199, null),
  ('e0691000-0000-4000-8000-0000000000b1', 'e0690000-0000-4000-8000-00000000000b', 'P069 B1', 'published', 0,   now()),
  ('e0691000-0000-4000-8000-0000000000b2', 'e0690000-0000-4000-8000-00000000000b', 'P069 B2', 'published', 0,   now());

insert into public.bundles (id, author_id, title, status, price_all) values
  ('e0692000-0000-4000-8000-0000000000a1', 'e0690000-0000-4000-8000-00000000000a', 'P069 A draft bundle',     'draft',     0),
  ('e0692000-0000-4000-8000-0000000000a2', 'e0690000-0000-4000-8000-00000000000a', 'P069 A published bundle', 'published', 399),
  ('e0692000-0000-4000-8000-0000000000b1', 'e0690000-0000-4000-8000-00000000000b', 'P069 B published bundle', 'published', 0);

insert into public.bundle_books (bundle_id, book_id) values
  ('e0692000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a1'),
  ('e0692000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a2'),
  ('e0692000-0000-4000-8000-0000000000a2', 'e0691000-0000-4000-8000-0000000000a2'),
  ('e0692000-0000-4000-8000-0000000000a2', 'e0691000-0000-4000-8000-0000000000a3'),
  ('e0692000-0000-4000-8000-0000000000b1', 'e0691000-0000-4000-8000-0000000000b1'),
  ('e0692000-0000-4000-8000-0000000000b1', 'e0691000-0000-4000-8000-0000000000b2');

-- ============================================================
-- Part 1: privilege and function metadata.
-- ============================================================
do $$
declare
  v_role text;
  v_priv text;
begin
  perform pg_temp.assert(
    (select relrowsecurity and not relforcerowsecurity from pg_class where oid = 'public.bundle_books'::regclass),
    'part1: bundle_books keeps RLS enabled, not forced');

  -- Exact table ACL: anon SELECT, authenticated SELECT, service_role all,
  -- no PUBLIC entry (table_acl would list one).
  perform pg_temp.assert(
    pg_temp.table_acl('public.bundle_books') =
      'anon:SELECT'
      || '|authenticated:SELECT'
      || '|service_role:DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE',
    format('part1: bundle_books table ACL -- got %s', pg_temp.table_acl('public.bundle_books')));

  -- No column-level grant of any kind remains.
  perform pg_temp.assert(
    not exists (select 1 from pg_attribute
                 where attrelid = 'public.bundle_books'::regclass and attnum > 0 and attacl is not null),
    'part1: bundle_books carries no column-level ACL');

  -- Effective privileges, resolved per role (includes PUBLIC inheritance).
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
      perform pg_temp.assert(
        not has_table_privilege(v_role, 'public.bundle_books', v_priv),
        format('part1: %s holds no %s on bundle_books', v_role, v_priv));
    end loop;
    perform pg_temp.assert(
      has_table_privilege(v_role, 'public.bundle_books', 'SELECT'),
      format('part1: %s keeps SELECT on bundle_books', v_role));
    perform pg_temp.assert(
      not has_any_column_privilege(v_role, 'public.bundle_books', 'INSERT, UPDATE, REFERENCES'),
      format('part1: %s holds no column-level write on bundle_books', v_role));
  end loop;
  perform pg_temp.assert(
    not has_any_column_privilege('public', 'public.bundle_books', 'SELECT, INSERT, UPDATE, REFERENCES'),
    'part1: PUBLIC holds nothing on bundle_books');
  perform pg_temp.assert(
    has_table_privilege('service_role', 'public.bundle_books', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE'),
    'part1: service_role keeps every data privilege');

  -- The three policies are byte-identical to the base (md5 measured on
  -- the unpatched schema).
  perform pg_temp.assert(
    (select md5(string_agg(policyname || '|' || permissive || '|' || array_to_string(roles, ',') || '|' || cmd
                           || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' order by policyname))
       from pg_policies where schemaname = 'public' and tablename = 'bundle_books')
      = '1588642de5e11d02d5cf0048d27f0ba2',
    'part1: the three bundle_books policies are unchanged');

  -- Function identities: exact arguments, return type, invoker, volatile,
  -- empty search_path, owned by the schema owner.
  perform pg_temp.assert(
    (select pg_get_function_identity_arguments(p.oid) = 'p_bundle_id uuid, p_author_id uuid, p_book_ids uuid[]'
            and pg_get_function_result(p.oid) = 'TABLE(member_bundle_id uuid, member_book_id uuid)'
            and not p.prosecdef and p.provolatile = 'v' and p.proretset
            and p.proconfig = array['search_path=""']
            and p.prolang = (select oid from pg_language where lanname = 'plpgsql')
            and p.proowner = (select relowner from pg_class where oid = 'public.bundle_books'::regclass)
       from pg_proc p where p.oid = 'public.replace_bundle_membership(uuid, uuid, uuid[])'::regprocedure),
    'part1: replace_bundle_membership identity');
  perform pg_temp.assert(
    (select pg_get_function_identity_arguments(p.oid)
              = 'p_bundle_id uuid, p_author_id uuid, p_title text, p_description text, p_price_all integer, p_book_ids uuid[]'
            and pg_get_function_result(p.oid) = 'TABLE(member_bundle_id uuid, member_book_id uuid)'
            and not p.prosecdef and p.provolatile = 'v' and p.proretset
            and p.proconfig = array['search_path=""']
            and p.proowner = (select relowner from pg_class where oid = 'public.bundle_books'::regclass)
       from pg_proc p where p.oid = 'public.create_bundle_with_membership(uuid, uuid, text, text, integer, uuid[])'::regprocedure),
    'part1: create_bundle_with_membership identity');
  perform pg_temp.assert(
    (select pg_get_function_identity_arguments(p.oid)
              = 'p_bundle_id uuid, p_author_id uuid, p_expected_status text, p_check_expected_price_all boolean, p_expected_price_all integer, p_title text, p_description text, p_price_all integer, p_book_ids uuid[]'
            and pg_get_function_result(p.oid)
              = 'TABLE(member_bundle_id uuid, member_book_id uuid, bundle_title text, bundle_description text, bundle_price_all integer, bundle_status text)'
            and not p.prosecdef and p.provolatile = 'v' and p.proretset
            and p.proconfig = array['search_path=""']
            and p.prolang = (select oid from pg_language where lanname = 'plpgsql')
            and p.proowner = (select relowner from pg_class where oid = 'public.bundle_books'::regclass)
       from pg_proc p where p.oid = 'public.update_bundle_with_membership(uuid, uuid, text, boolean, integer, text, text, integer, uuid[])'::regprocedure),
    'part1: update_bundle_with_membership identity');
  perform pg_temp.assert(
    (select count(*) from pg_proc
      where proname in ('replace_bundle_membership', 'create_bundle_with_membership', 'update_bundle_with_membership')) = 3,
    'part1: exactly one overload of each writer');

  -- Exact function ACLs: service_role EXECUTE only (owner aside).
  perform pg_temp.assert(
    pg_temp.function_acl('public.replace_bundle_membership(uuid, uuid, uuid[])') = 'service_role:EXECUTE',
    format('part1: replace ACL -- got %s', pg_temp.function_acl('public.replace_bundle_membership(uuid, uuid, uuid[])')));
  perform pg_temp.assert(
    pg_temp.function_acl('public.create_bundle_with_membership(uuid, uuid, text, text, integer, uuid[])') = 'service_role:EXECUTE',
    'part1: create ACL');
  perform pg_temp.assert(
    pg_temp.function_acl('public.update_bundle_with_membership(uuid, uuid, text, boolean, integer, text, text, integer, uuid[])') = 'service_role:EXECUTE',
    'part1: update ACL');
  foreach v_role in array array['public', 'anon', 'authenticated'] loop
    perform pg_temp.assert(
      not has_function_privilege(v_role, 'public.replace_bundle_membership(uuid, uuid, uuid[])', 'EXECUTE')
      and not has_function_privilege(v_role, 'public.create_bundle_with_membership(uuid, uuid, text, text, integer, uuid[])', 'EXECUTE')
      and not has_function_privilege(v_role, 'public.update_bundle_with_membership(uuid, uuid, text, boolean, integer, text, text, integer, uuid[])', 'EXECUTE'),
      format('part1: %s cannot execute any writer', v_role));
  end loop;
end $$;

-- ============================================================
-- Part 2: direct client writes are refused by the ACL, before RLS.
-- ============================================================
select pg_temp.expect_error('authenticated', 'e0690000-0000-4000-8000-00000000000a',
  $q$insert into public.bundle_books (bundle_id, book_id) values ('e0692000-0000-4000-8000-0000000000a2', 'e0691000-0000-4000-8000-0000000000a4')$q$,
  '42501', 'permission denied for table bundle_books', 'part2: author cannot insert into own bundle');
select pg_temp.expect_error('authenticated', 'e0690000-0000-4000-8000-00000000000a',
  $q$delete from public.bundle_books where bundle_id = 'e0692000-0000-4000-8000-0000000000a2'$q$,
  '42501', 'permission denied for table bundle_books', 'part2: author cannot delete own bundle membership');
select pg_temp.expect_error('authenticated', 'e0690000-0000-4000-8000-00000000000a',
  $q$update public.bundle_books set book_id = 'e0691000-0000-4000-8000-0000000000a4' where bundle_id = 'e0692000-0000-4000-8000-0000000000a2'$q$,
  '42501', 'permission denied for table bundle_books', 'part2: author cannot update membership');
select pg_temp.expect_error('authenticated', 'e0690000-0000-4000-8000-00000000000a',
  $q$truncate public.bundle_books$q$,
  '42501', 'permission denied for table bundle_books', 'part2: author cannot truncate');
select pg_temp.expect_error('authenticated', 'e0690000-0000-4000-8000-00000000000a',
  $q$insert into public.bundle_books (bundle_id, book_id) values ('e0692000-0000-4000-8000-0000000000b1', 'e0691000-0000-4000-8000-0000000000a1')$q$,
  '42501', 'permission denied for table bundle_books', 'part2: cross-author insert refused');
select pg_temp.expect_error('authenticated', 'e0690000-0000-4000-8000-00000000000a',
  $q$insert into public.bundle_books (bundle_id, book_id) values ('e0692000-0000-4000-8000-0000000000a2', 'e0691000-0000-4000-8000-0000000000a4') on conflict (bundle_id, book_id) do nothing$q$,
  '42501', 'permission denied for table bundle_books', 'part2: author cannot upsert');
select pg_temp.expect_error('anon', null,
  $q$insert into public.bundle_books (bundle_id, book_id) values ('e0692000-0000-4000-8000-0000000000b1', 'e0691000-0000-4000-8000-0000000000a1')$q$,
  '42501', 'permission denied for table bundle_books', 'part2: anon insert refused');
select pg_temp.expect_error('anon', null,
  $q$delete from public.bundle_books$q$,
  '42501', 'permission denied for table bundle_books', 'part2: anon delete refused');
select pg_temp.expect_error('anon', null,
  $q$truncate public.bundle_books$q$,
  '42501', 'permission denied for table bundle_books', 'part2: anon truncate refused');

-- The writers are not callable as an ordinary signed-in user or anon.
select pg_temp.expect_error('authenticated', 'e0690000-0000-4000-8000-00000000000a',
  $q$select * from public.replace_bundle_membership('e0692000-0000-4000-8000-0000000000a2', 'e0690000-0000-4000-8000-00000000000a', array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a3']::uuid[])$q$,
  '42501', 'permission denied for function replace_bundle_membership', 'part2: authenticated cannot call replace');
select pg_temp.expect_error('authenticated', 'e0690000-0000-4000-8000-00000000000a',
  $q$select * from public.create_bundle_with_membership(gen_random_uuid(), 'e0690000-0000-4000-8000-00000000000a', 't', '', 0, array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a3']::uuid[])$q$,
  '42501', 'permission denied for function create_bundle_with_membership', 'part2: authenticated cannot call create');
select pg_temp.expect_error('anon', null,
  $q$select * from public.replace_bundle_membership('e0692000-0000-4000-8000-0000000000b1', 'e0690000-0000-4000-8000-00000000000b', array['e0691000-0000-4000-8000-0000000000b1', 'e0691000-0000-4000-8000-0000000000b2']::uuid[])$q$,
  '42501', 'permission denied for function replace_bundle_membership', 'part2: anon cannot call replace');
select pg_temp.expect_error('authenticated', 'e0690000-0000-4000-8000-00000000000a',
  $q$select * from public.update_bundle_with_membership('e0692000-0000-4000-8000-0000000000a1', 'e0690000-0000-4000-8000-00000000000a', null, false, null, 't', '', 0, array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a3']::uuid[])$q$,
  '42501', 'permission denied for function update_bundle_with_membership', 'part2: authenticated cannot call update');

-- Nothing changed.
do $$
begin
  perform pg_temp.assert(
    pg_temp.members('e0692000-0000-4000-8000-0000000000a2') = 'e0691000-0000-4000-8000-0000000000a2,e0691000-0000-4000-8000-0000000000a3'
    and pg_temp.members('e0692000-0000-4000-8000-0000000000b1') = 'e0691000-0000-4000-8000-0000000000b1,e0691000-0000-4000-8000-0000000000b2'
    and (select count(*) from public.bundle_books) >= 6,
    'part2: every refused write left membership untouched');
end $$;

-- ============================================================
-- Part 3: SELECT visibility is still the policy's.
-- ============================================================
select pg_temp.expect_ok('anon', null,
  $q$select 1 from public.bundle_books where bundle_id in ('e0692000-0000-4000-8000-0000000000a1', 'e0692000-0000-4000-8000-0000000000a2', 'e0692000-0000-4000-8000-0000000000b1')$q$,
  4, 'part3: anon sees only published bundles'' members');
select pg_temp.expect_ok('authenticated', 'e0690000-0000-4000-8000-00000000000a',
  $q$select 1 from public.bundle_books where bundle_id in ('e0692000-0000-4000-8000-0000000000a1', 'e0692000-0000-4000-8000-0000000000a2', 'e0692000-0000-4000-8000-0000000000b1')$q$,
  6, 'part3: author A sees own draft + both published bundles');
select pg_temp.expect_ok('authenticated', 'e0690000-0000-4000-8000-00000000000b',
  $q$select 1 from public.bundle_books where bundle_id = 'e0692000-0000-4000-8000-0000000000a1'$q$,
  0, 'part3: author B cannot see A''s draft bundle');
select pg_temp.expect_ok('authenticated', 'e0690000-0000-4000-8000-00000000000a',
  $q$select bb.book_id, b.author_id, b.status from public.bundle_books bb join public.books b on b.id = bb.book_id where bb.bundle_id = 'e0692000-0000-4000-8000-0000000000a2'$q$,
  2, 'part3: publishBundle''s membership join still reads');

-- ============================================================
-- Part 4: the trusted writer, as service_role.
-- ============================================================
select pg_temp.expect_ok('service_role', null,
  $q$select * from public.replace_bundle_membership('e0692000-0000-4000-8000-0000000000a2', 'e0690000-0000-4000-8000-00000000000a', array['e0691000-0000-4000-8000-0000000000a3', 'e0691000-0000-4000-8000-0000000000a1']::uuid[])$q$,
  2, 'part4: replace succeeds and returns exactly the two new rows');

do $$
begin
  perform pg_temp.assert(
    pg_temp.members('e0692000-0000-4000-8000-0000000000a2') = 'e0691000-0000-4000-8000-0000000000a1,e0691000-0000-4000-8000-0000000000a3',
    'part4: membership is exactly the new set');
  perform pg_temp.assert(
    (select string_agg(member_bundle_id::text || '/' || member_book_id::text, ',' order by member_book_id)
       from public.replace_bundle_membership('e0692000-0000-4000-8000-0000000000a2', 'e0690000-0000-4000-8000-00000000000a',
                                             array['e0691000-0000-4000-8000-0000000000a2', 'e0691000-0000-4000-8000-0000000000a3', 'e0691000-0000-4000-8000-0000000000a1']::uuid[]))
    = 'e0692000-0000-4000-8000-0000000000a2/e0691000-0000-4000-8000-0000000000a1,'
      || 'e0692000-0000-4000-8000-0000000000a2/e0691000-0000-4000-8000-0000000000a2,'
      || 'e0692000-0000-4000-8000-0000000000a2/e0691000-0000-4000-8000-0000000000a3',
    'part4: the returned rows are the re-read membership, bound to the bundle');
end $$;

-- Every refusal. Each leaves the three-member set from above intact.
select pg_temp.expect_error('service_role', null,
  $q$select * from public.replace_bundle_membership('e0692000-0000-4000-8000-0000000000a2', 'e0690000-0000-4000-8000-00000000000a', array['e0691000-0000-4000-8000-0000000000a1']::uuid[])$q$,
  '22023', 'at least two books', 'part4: one book refused');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.replace_bundle_membership('e0692000-0000-4000-8000-0000000000a2', 'e0690000-0000-4000-8000-00000000000a', array[]::uuid[])$q$,
  '22023', 'flat list', 'part4: empty list refused');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.replace_bundle_membership('e0692000-0000-4000-8000-0000000000a2', 'e0690000-0000-4000-8000-00000000000a', null)$q$,
  '22023', 'are required', 'part4: null list refused');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.replace_bundle_membership('e0692000-0000-4000-8000-0000000000a2', 'e0690000-0000-4000-8000-00000000000a', array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a1']::uuid[])$q$,
  '22023', 'duplicate', 'part4: duplicate ids refused');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.replace_bundle_membership('e0692000-0000-4000-8000-0000000000a2', 'e0690000-0000-4000-8000-00000000000a', array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a3']::uuid[])$q$,
  '22023', 'duplicate', 'part4: duplicate among three refused');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.replace_bundle_membership('e0692000-0000-4000-8000-0000000000a2', 'e0690000-0000-4000-8000-00000000000a', array['e0691000-0000-4000-8000-0000000000a1', null]::uuid[])$q$,
  '22023', 'flat list', 'part4: null element refused');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.replace_bundle_membership('e0692000-0000-4000-8000-0000000000a2', 'e0690000-0000-4000-8000-00000000000a', array[array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a2'], array['e0691000-0000-4000-8000-0000000000a3', 'e0691000-0000-4000-8000-0000000000a1']]::uuid[])$q$,
  '22023', 'flat list', 'part4: two-dimensional list refused');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.replace_bundle_membership('e0692000-0000-4000-8000-0000000000b1', 'e0690000-0000-4000-8000-00000000000a', array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a2']::uuid[])$q$,
  '42501', 'bundle not found for this author', 'part4: another author''s bundle refused');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.replace_bundle_membership('e0692000-0000-4000-8000-0000000000ff', 'e0690000-0000-4000-8000-00000000000a', array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a2']::uuid[])$q$,
  '42501', 'bundle not found for this author', 'part4: nonexistent bundle refused');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.replace_bundle_membership('e0692000-0000-4000-8000-0000000000a2', 'e0690000-0000-4000-8000-00000000000a', array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000b1']::uuid[])$q$,
  '42501', 'own published book', 'part4: another author''s book refused');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.replace_bundle_membership('e0692000-0000-4000-8000-0000000000a2', 'e0690000-0000-4000-8000-00000000000a', array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a4']::uuid[])$q$,
  '42501', 'own published book', 'part4: unpublished book refused');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.replace_bundle_membership('e0692000-0000-4000-8000-0000000000a2', 'e0690000-0000-4000-8000-00000000000a', array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000ff']::uuid[])$q$,
  '42501', 'own published book', 'part4: nonexistent book refused');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.replace_bundle_membership(null, 'e0690000-0000-4000-8000-00000000000a', array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a2']::uuid[])$q$,
  '22023', 'are required', 'part4: null bundle refused');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.replace_bundle_membership('e0692000-0000-4000-8000-0000000000a2', null, array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a2']::uuid[])$q$,
  '22023', 'are required', 'part4: null author refused');

do $$
begin
  perform pg_temp.assert(
    pg_temp.members('e0692000-0000-4000-8000-0000000000a2')
      = 'e0691000-0000-4000-8000-0000000000a1,e0691000-0000-4000-8000-0000000000a2,e0691000-0000-4000-8000-0000000000a3',
    'part4: every refused replacement left the previous membership exactly as it was');
  perform pg_temp.assert(
    pg_temp.members('e0692000-0000-4000-8000-0000000000b1') = 'e0691000-0000-4000-8000-0000000000b1,e0691000-0000-4000-8000-0000000000b2',
    'part4: author B''s bundle untouched');
end $$;

-- Insertion failure AFTER validation and after the delete: a temporary
-- trigger (owner-created, rolled back with everything else) makes the
-- insert raise. The delete must roll back with it -- no empty or partial
-- bundle is ever visible.
create function pg_temp.fail_insert() returns trigger language plpgsql as $$
begin
  raise exception 'injected membership insert failure' using errcode = 'XX999';
end;
$$;
create trigger p069_fail_insert before insert on public.bundle_books
  for each row execute function pg_temp.fail_insert();

select pg_temp.expect_error('service_role', null,
  $q$select * from public.replace_bundle_membership('e0692000-0000-4000-8000-0000000000a2', 'e0690000-0000-4000-8000-00000000000a', array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a3']::uuid[])$q$,
  'XX999', 'injected membership insert failure', 'part4: an insert failure surfaces as an error');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.create_bundle_with_membership('e0692000-0000-4000-8000-0000000000a9', 'e0690000-0000-4000-8000-00000000000a', 'P069 injected', '', 0, array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a3']::uuid[])$q$,
  'XX999', 'injected membership insert failure', 'part4: create surfaces an insert failure');

drop trigger p069_fail_insert on public.bundle_books;

do $$
begin
  perform pg_temp.assert(
    pg_temp.members('e0692000-0000-4000-8000-0000000000a2')
      = 'e0691000-0000-4000-8000-0000000000a1,e0691000-0000-4000-8000-0000000000a2,e0691000-0000-4000-8000-0000000000a3',
    'part4: the failed replacement rolled its delete back -- old membership survives');
  perform pg_temp.assert(
    not exists (select 1 from public.bundles where id = 'e0692000-0000-4000-8000-0000000000a9'),
    'part4: the failed create left no bundle row behind');
end $$;

-- ============================================================
-- Part 4b: the database itself enforces the exact set and the complete
-- state, inside the transaction.
--
-- pg_temp.injected() creates an owner-level trigger that tampers with
-- the write, calls a writer as service_role, and records what happened:
-- the call's outcome, then -- from a SEPARATE statement after the call --
-- the bundle's full state (details and membership). Everything,
-- trigger included, is rolled back afterwards.
-- ============================================================
create function pg_temp.state(p_bundle uuid) returns text
  language sql stable as $$
  select coalesce((select b.title || '|' || b.description || '|' || coalesce(b.price_all::text, 'null') || '|' || b.status
                     from public.bundles b where b.id = p_bundle), '<no bundle>')
         || '|' || pg_temp.members(p_bundle);
$$;

create function pg_temp.injected(p_setup text, p_call text, p_bundle uuid) returns text
  language plpgsql as $$
declare
  v_out text;
  v_after text;
  v_rows bigint;
  v_state text;
  v_msg text;
begin
  begin
    execute p_setup;
    execute 'set local role service_role';
    begin
      execute p_call;
      get diagnostics v_rows = row_count;
      v_out := 'OK:' || v_rows;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      v_out := v_state || ':' || v_msg;
    end;
    execute 'reset role';
    v_after := pg_temp.state(p_bundle);
    raise exception using errcode = 'P0999', message = 'roll the injection back';
  exception when sqlstate 'P0999' then
    null;
  end;
  return v_out || '#' || v_after;
end;
$$;

create function pg_temp.drop_a3() returns trigger language plpgsql as $$
begin
  if new.book_id = 'e0691000-0000-4000-8000-0000000000a3' then
    return null;
  end if;
  return new;
end;
$$;
create function pg_temp.substitute_a3() returns trigger language plpgsql as $$
begin
  if new.book_id = 'e0691000-0000-4000-8000-0000000000a3' then
    new.book_id := 'e0691000-0000-4000-8000-0000000000a4';
  end if;
  return new;
end;
$$;
create function pg_temp.misroute_a3() returns trigger language plpgsql as $$
begin
  if new.book_id = 'e0691000-0000-4000-8000-0000000000a3' then
    new.bundle_id := 'e0692000-0000-4000-8000-0000000000b1';
  end if;
  return new;
end;
$$;
create function pg_temp.extra_a4() returns trigger language plpgsql as $$
begin
  if new.book_id = 'e0691000-0000-4000-8000-0000000000a3' then
    insert into public.bundle_books (bundle_id, book_id) values (new.bundle_id, 'e0691000-0000-4000-8000-0000000000a4');
  end if;
  return new;
end;
$$;
-- The row is written to ANOTHER bundle, and a correct copy is inserted
-- by a nested statement: the target bundle ends up holding exactly the
-- requested set, so only the rows the INSERT itself reported can show
-- that one of them went elsewhere.
create function pg_temp.misroute_readd_a3() returns trigger language plpgsql as $$
begin
  if new.book_id = 'e0691000-0000-4000-8000-0000000000a3' and pg_catalog.pg_trigger_depth() = 1 then
    insert into public.bundle_books (bundle_id, book_id) values (new.bundle_id, new.book_id);
    new.bundle_id := 'e0692000-0000-4000-8000-0000000000b1';
  end if;
  return new;
end;
$$;
create function pg_temp.alter_title() returns trigger language plpgsql as $$
begin
  new.title := new.title || ' (altered)';
  return new;
end;
$$;

do $$
declare
  v_before_a2 text := pg_temp.state('e0692000-0000-4000-8000-0000000000a2');
  v_before_a1 text := pg_temp.state('e0692000-0000-4000-8000-0000000000a1');
  v_before_b1 text := pg_temp.state('e0692000-0000-4000-8000-0000000000b1');
  v_replace text := $q$select * from public.replace_bundle_membership('e0692000-0000-4000-8000-0000000000a2', 'e0690000-0000-4000-8000-00000000000a', array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a3']::uuid[])$q$;
  v_update text := $q$select * from public.update_bundle_with_membership('e0692000-0000-4000-8000-0000000000a1', 'e0690000-0000-4000-8000-00000000000a', null, false, null, 'P069 edited', 'edited', 0, array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a3']::uuid[])$q$;
  v_create text := $q$select * from public.create_bundle_with_membership('e0692000-0000-4000-8000-0000000000c1', 'e0690000-0000-4000-8000-00000000000a', 'P069 injected create', '', 0, array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a3']::uuid[])$q$;
  v_ins text := 'create trigger p069_t before insert on public.bundle_books for each row execute function ';
  v_r text;
  v_case record;
begin
  for v_case in
    select * from (values
      ('dropped row',      v_ins || 'pg_temp.drop_a3()'),
      ('substituted row',  v_ins || 'pg_temp.substitute_a3()'),
      ('wrong-bundle row', v_ins || 'pg_temp.misroute_a3()'),
      ('wrong-bundle copy, target still exact', v_ins || 'pg_temp.misroute_readd_a3()'),
      ('extra row',        v_ins || 'pg_temp.extra_a4()')
    ) as t(label, setup)
  loop
    -- replace: the old membership survives.
    v_r := pg_temp.injected(v_case.setup, v_replace, 'e0692000-0000-4000-8000-0000000000a2');
    perform pg_temp.assert(
      v_r = '23000:bundle membership: stored membership does not equal the requested set#' || v_before_a2,
      format('part4b: replace with a %s raises 23000 and leaves the old membership -- got %s', v_case.label, v_r));
    -- update: neither the details nor the membership change.
    v_r := pg_temp.injected(v_case.setup, v_update, 'e0692000-0000-4000-8000-0000000000a1');
    perform pg_temp.assert(
      v_r = '23000:bundle membership: stored membership does not equal the requested set#' || v_before_a1,
      format('part4b: update with a %s raises 23000 and restores details and membership -- got %s', v_case.label, v_r));
    -- create: neither the bundle nor any membership is left.
    v_r := pg_temp.injected(v_case.setup, v_create, 'e0692000-0000-4000-8000-0000000000c1');
    perform pg_temp.assert(
      v_r = '23000:bundle membership: stored membership does not equal the requested set#<no bundle>|<none>',
      format('part4b: create with a %s raises 23000 and leaves nothing -- got %s', v_case.label, v_r));
  end loop;

  -- The misrouted row never reached author B's bundle either.
  perform pg_temp.assert(pg_temp.state('e0692000-0000-4000-8000-0000000000b1') = v_before_b1, 'part4b: the wrong-bundle target is untouched');

  -- A tampered DETAILS write: the update raises and the membership it had
  -- already replaced is rolled back with it.
  v_r := pg_temp.injected(
    'create trigger p069_t before update on public.bundles for each row execute function pg_temp.alter_title()',
    v_update, 'e0692000-0000-4000-8000-0000000000a1');
  perform pg_temp.assert(
    v_r = '23000:bundle update: stored details do not equal the submitted details#' || v_before_a1,
    format('part4b: altered details raise 23000 and restore details and membership -- got %s', v_r));

  -- A failure AFTER the details update and BEFORE the membership is
  -- complete (the selection is refused inside the same transaction):
  -- the details come back too.
  v_r := pg_temp.injected('select 1',
    $q$select * from public.update_bundle_with_membership('e0692000-0000-4000-8000-0000000000a1', 'e0690000-0000-4000-8000-00000000000a', null, false, null, 'P069 edited', 'edited', 0, array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a4']::uuid[])$q$,
    'e0692000-0000-4000-8000-0000000000a1');
  perform pg_temp.assert(
    v_r = '42501:bundle membership: every book must be the author''s own published book#' || v_before_a1,
    format('part4b: a refusal after the details update restores the original details and membership -- got %s', v_r));

  -- Nothing leaked out of any probe.
  perform pg_temp.assert(
    pg_temp.state('e0692000-0000-4000-8000-0000000000a1') = v_before_a1 and pg_temp.state('e0692000-0000-4000-8000-0000000000a2') = v_before_a2
    and not exists (select 1 from public.bundles where id = 'e0692000-0000-4000-8000-0000000000c1')
    and not exists (select 1 from pg_catalog.pg_trigger where tgname = 'p069_t'),
    'part4b: every injection rolled back completely');
end $$;

-- ============================================================
-- Part 4c: update_bundle_with_membership -- the complete edit.
-- ============================================================
-- A legacy price_cents on both bundles edited below: the function must
-- never write that column.
update public.bundles set price_cents = 777
 where id in ('e0692000-0000-4000-8000-0000000000a1', 'e0692000-0000-4000-8000-0000000000a2');
select pg_temp.expect_ok('service_role', null,
  $q$select * from public.update_bundle_with_membership('e0692000-0000-4000-8000-0000000000a1', 'e0690000-0000-4000-8000-00000000000a', null, false, null, 'P069 edited', 'edited', 0, array['e0691000-0000-4000-8000-0000000000a3', 'e0691000-0000-4000-8000-0000000000a1']::uuid[])$q$,
  2, 'part4c: a complete edit returns one row per member');
do $$
begin
  perform pg_temp.assert(
    pg_temp.state('e0692000-0000-4000-8000-0000000000a1') = 'P069 edited|edited|0|draft|e0691000-0000-4000-8000-0000000000a1,e0691000-0000-4000-8000-0000000000a3',
    format('part4c: details and membership were saved together -- got %s', pg_temp.state('e0692000-0000-4000-8000-0000000000a1')));
  perform pg_temp.assert(
    (select price_cents = 777 from public.bundles where id = 'e0692000-0000-4000-8000-0000000000a1'),
    'part4c: price_cents is never written');
end $$;

-- The returned proof carries the persisted details on every row.
do $$
declare
  v_proof text;
begin
  execute 'set local role service_role';
  select string_agg(r.member_bundle_id || '|' || r.member_book_id || '|' || r.bundle_title || '|' || r.bundle_description
                    || '|' || r.bundle_price_all || '|' || r.bundle_status, ',' order by r.member_book_id)
    into v_proof
    from public.update_bundle_with_membership('e0692000-0000-4000-8000-0000000000a2', 'e0690000-0000-4000-8000-00000000000a', 'published', true, 399, 'P069 A published bundle', '', 399,
           array['e0691000-0000-4000-8000-0000000000a2', 'e0691000-0000-4000-8000-0000000000a3', 'e0691000-0000-4000-8000-0000000000a1']::uuid[]) as r;
  execute 'reset role';
  perform pg_temp.assert(
    v_proof = 'e0692000-0000-4000-8000-0000000000a2|e0691000-0000-4000-8000-0000000000a1|P069 A published bundle||399|published,'
           || 'e0692000-0000-4000-8000-0000000000a2|e0691000-0000-4000-8000-0000000000a2|P069 A published bundle||399|published,'
           || 'e0692000-0000-4000-8000-0000000000a2|e0691000-0000-4000-8000-0000000000a3|P069 A published bundle||399|published',
    format('part4c: the returned proof is the complete persisted state -- got %s', v_proof));
  perform pg_temp.assert(
    (select price_cents = 777 from public.bundles where id = 'e0692000-0000-4000-8000-0000000000a2'),
    'part4c: a paid edit never writes price_cents either');
end $$;

-- The PAID-REPRICING-1 compare-and-set, evaluated on the locked row.
select pg_temp.expect_error('service_role', null,
  $q$select * from public.update_bundle_with_membership('e0692000-0000-4000-8000-0000000000a1', 'e0690000-0000-4000-8000-00000000000a', 'published', false, null, 'P069 stale', '', 199, array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a2']::uuid[])$q$,
  'LB409', 'changed since it was read', 'part4c: a stale expected status is refused');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.update_bundle_with_membership('e0692000-0000-4000-8000-0000000000a2', 'e0690000-0000-4000-8000-00000000000a', 'published', true, 299, 'P069 stale', '', 299, array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a2']::uuid[])$q$,
  'LB409', 'changed since it was read', 'part4c: a stale expected price is refused');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.update_bundle_with_membership('e0692000-0000-4000-8000-0000000000a1', 'e0690000-0000-4000-8000-00000000000a', 'draft', true, null, 'P069 stale', '', 199, array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a2']::uuid[])$q$,
  'LB409', 'changed since it was read', 'part4c: an expected "still unpriced" is refused on a priced row');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.update_bundle_with_membership('e0692000-0000-4000-8000-0000000000b1', 'e0690000-0000-4000-8000-00000000000a', null, false, null, 'P069 hijack', '', 0, array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a2']::uuid[])$q$,
  '42501', 'bundle not found for this author', 'part4c: another author''s bundle is refused');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.update_bundle_with_membership('e0692000-0000-4000-8000-0000000000a1', 'e0690000-0000-4000-8000-00000000000b', null, false, null, 'P069 hijack', '', 0, array['e0691000-0000-4000-8000-0000000000b1', 'e0691000-0000-4000-8000-0000000000b2']::uuid[])$q$,
  '42501', 'bundle not found for this author', 'part4c: the bundle is bound to the given author');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.update_bundle_with_membership('e0692000-0000-4000-8000-0000000000a1', 'e0690000-0000-4000-8000-00000000000a', null, false, null, 'P069 bad', '', 0, array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000b1']::uuid[])$q$,
  '42501', 'own published book', 'part4c: another author''s book is refused');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.update_bundle_with_membership('e0692000-0000-4000-8000-0000000000a1', 'e0690000-0000-4000-8000-00000000000a', null, false, null, 'P069 bad', '', 0, array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a1']::uuid[])$q$,
  '22023', 'duplicate', 'part4c: duplicate books are refused');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.update_bundle_with_membership('e0692000-0000-4000-8000-0000000000a1', 'e0690000-0000-4000-8000-00000000000a', null, null, null, 'P069 bad', '', 0, array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a2']::uuid[])$q$,
  '22023', 'are required', 'part4c: a null guard flag is refused');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.update_bundle_with_membership('e0692000-0000-4000-8000-0000000000a1', 'e0690000-0000-4000-8000-00000000000a', null, false, null, 'P069 bad', '', 50, array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a2']::uuid[])$q$,
  '23514', 'bundles_price_all_range_check', 'part4c: an out-of-domain price is refused');

do $$
begin
  perform pg_temp.assert(
    pg_temp.state('e0692000-0000-4000-8000-0000000000a1') = 'P069 edited|edited|0|draft|e0691000-0000-4000-8000-0000000000a1,e0691000-0000-4000-8000-0000000000a3'
    and pg_temp.state('e0692000-0000-4000-8000-0000000000b1') = 'P069 B published bundle||0|published|e0691000-0000-4000-8000-0000000000b1,e0691000-0000-4000-8000-0000000000b2',
    'part4c: every refused update left details and membership exactly as they were');
end $$;

-- Restore bundle a1 to its fixture state with a second complete edit.
select pg_temp.expect_ok('service_role', null,
  $q$select * from public.update_bundle_with_membership('e0692000-0000-4000-8000-0000000000a1', 'e0690000-0000-4000-8000-00000000000a', 'draft', true, 0, 'P069 A draft bundle', '', 0, array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a2']::uuid[])$q$,
  2, 'part4c: a second complete edit (with the full compare-and-set) succeeds');
do $$
begin
  perform pg_temp.assert(
    pg_temp.state('e0692000-0000-4000-8000-0000000000a1') = 'P069 A draft bundle||0|draft|e0691000-0000-4000-8000-0000000000a1,e0691000-0000-4000-8000-0000000000a2',
    'part4c: the second edit restored the original state exactly');
end $$;

-- create_bundle_with_membership: bundle and membership together.
select pg_temp.expect_ok('service_role', null,
  $q$select * from public.create_bundle_with_membership('e0692000-0000-4000-8000-0000000000a5', 'e0690000-0000-4000-8000-00000000000a', 'P069 created', 'desc', 499, array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a2']::uuid[])$q$,
  2, 'part4: create returns exactly two rows');
do $$
begin
  perform pg_temp.assert(
    (select author_id = 'e0690000-0000-4000-8000-00000000000a' and title = 'P069 created' and description = 'desc'
            and price_all = 499 and status = 'draft' and price_cents = 0
       from public.bundles where id = 'e0692000-0000-4000-8000-0000000000a5'),
    'part4: created bundle is a draft with the given metadata and the legacy default');
  perform pg_temp.assert(
    pg_temp.members('e0692000-0000-4000-8000-0000000000a5') = 'e0691000-0000-4000-8000-0000000000a1,e0691000-0000-4000-8000-0000000000a2',
    'part4: created bundle has exactly the requested membership');
end $$;

-- A create whose membership is refused leaves no bundle; so does one
-- whose bundle row is refused.
select pg_temp.expect_error('service_role', null,
  $q$select * from public.create_bundle_with_membership('e0692000-0000-4000-8000-0000000000a6', 'e0690000-0000-4000-8000-00000000000a', 'P069 bad', '', 0, array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a4']::uuid[])$q$,
  '42501', 'own published book', 'part4: create with an unpublished book refused');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.create_bundle_with_membership('e0692000-0000-4000-8000-0000000000a7', 'e0690000-0000-4000-8000-00000000000a', 'P069 bad', '', 0, array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000b1']::uuid[])$q$,
  '42501', 'own published book', 'part4: create with another author''s book refused');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.create_bundle_with_membership('e0692000-0000-4000-8000-0000000000a8', 'e0690000-0000-4000-8000-00000000000a', 'P069 bad', '', 0, array['e0691000-0000-4000-8000-0000000000a1']::uuid[])$q$,
  '22023', 'at least two books', 'part4: create with one book refused');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.create_bundle_with_membership('e0692000-0000-4000-8000-0000000000a8', 'e0690000-0000-4000-8000-00000000000a', 'P069 bad', '', 50, array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a2']::uuid[])$q$,
  '23514', 'bundles_price_all_range_check', 'part4: create with an out-of-domain price refused');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.create_bundle_with_membership('e0692000-0000-4000-8000-0000000000a5', 'e0690000-0000-4000-8000-00000000000a', 'P069 dup', '', 0, array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a3']::uuid[])$q$,
  '23505', 'bundles_pkey', 'part4: create with an existing bundle id refused');
select pg_temp.expect_error('service_role', null,
  $q$select * from public.create_bundle_with_membership(null, 'e0690000-0000-4000-8000-00000000000a', 'P069 bad', '', 0, array['e0691000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a2']::uuid[])$q$,
  '22023', 'are required', 'part4: create with a null id refused');

do $$
begin
  perform pg_temp.assert(
    not exists (select 1 from public.bundles
                 where id in ('e0692000-0000-4000-8000-0000000000a6', 'e0692000-0000-4000-8000-0000000000a7', 'e0692000-0000-4000-8000-0000000000a8'))
    and not exists (select 1 from public.bundle_books
                     where bundle_id in ('e0692000-0000-4000-8000-0000000000a6', 'e0692000-0000-4000-8000-0000000000a7', 'e0692000-0000-4000-8000-0000000000a8')),
    'part4: every refused create left neither a bundle nor membership');
  perform pg_temp.assert(
    (select title = 'P069 created' from public.bundles where id = 'e0692000-0000-4000-8000-0000000000a5')
    and pg_temp.members('e0692000-0000-4000-8000-0000000000a5') = 'e0691000-0000-4000-8000-0000000000a1,e0691000-0000-4000-8000-0000000000a2',
    'part4: the id-collision attempt did not touch the existing bundle');
end $$;

-- ============================================================
-- Part 5: cascades still work without DELETE on bundle_books.
-- ============================================================
select pg_temp.expect_ok('authenticated', 'e0690000-0000-4000-8000-00000000000a',
  $q$delete from public.bundles where id = 'e0692000-0000-4000-8000-0000000000a5' and author_id = 'e0690000-0000-4000-8000-00000000000a'$q$,
  1, 'part5: deleteBundle''s delete succeeds');
select pg_temp.expect_ok('authenticated', 'e0690000-0000-4000-8000-00000000000a',
  $q$delete from public.books where id = 'e0691000-0000-4000-8000-0000000000a3'$q$,
  1, 'part5: deleting a member book succeeds');
select pg_temp.expect_ok('authenticated', 'e0690000-0000-4000-8000-00000000000b',
  $q$delete from public.bundles where id = 'e0692000-0000-4000-8000-0000000000a2'$q$,
  0, 'part5: author B cannot delete A''s bundle (RLS)');

do $$
begin
  perform pg_temp.assert(
    pg_temp.members('e0692000-0000-4000-8000-0000000000a5') = '<none>',
    'part5: deleting the bundle cascaded its membership away');
  perform pg_temp.assert(
    pg_temp.members('e0692000-0000-4000-8000-0000000000a2') = 'e0691000-0000-4000-8000-0000000000a1,e0691000-0000-4000-8000-0000000000a2'
    and not exists (select 1 from public.bundle_books where book_id = 'e0691000-0000-4000-8000-0000000000a3'),
    'part5: deleting the book cascaded exactly its membership rows away');
end $$;

-- ============================================================
-- Part 6: service_role fixture tooling and the owner.
-- ============================================================
-- scripts/staging-fixtures/live-deps.mts upsertBundleBooks: explicit
-- ids, on conflict (bundle_id, book_id) do update.
select pg_temp.expect_ok('service_role', null,
  $q$insert into public.bundle_books (id, bundle_id, book_id) values
       ('e0694000-0000-4000-8000-000000000001', 'e0692000-0000-4000-8000-0000000000b1', 'e0691000-0000-4000-8000-0000000000b1'),
       ('e0694000-0000-4000-8000-000000000002', 'e0692000-0000-4000-8000-0000000000b1', 'e0691000-0000-4000-8000-0000000000b2')
     on conflict (bundle_id, book_id) do update set id = excluded.id$q$,
  2, 'part6: service_role fixture upsert works');
select pg_temp.expect_ok('service_role', null,
  $q$select id from public.bundle_books where bundle_id = 'e0692000-0000-4000-8000-0000000000b1'$q$,
  2, 'part6: service_role reads everything');
select pg_temp.expect_ok('service_role', null,
  $q$delete from public.bundles where id = 'e0692000-0000-4000-8000-0000000000b1'$q$,
  1, 'part6: fixture teardown (bundles delete) cascades as service_role');
select pg_temp.expect_ok('service_role', null,
  $q$delete from public.bundle_books where bundle_id = 'e0692000-0000-4000-8000-0000000000a1'$q$,
  2, 'part6: service_role direct delete works');

do $$
begin
  perform pg_temp.assert(
    pg_temp.members('e0692000-0000-4000-8000-0000000000b1') = '<none>',
    'part6: teardown left no membership behind');
  insert into public.bundle_books (bundle_id, book_id)
    values ('e0692000-0000-4000-8000-0000000000a1', 'e0691000-0000-4000-8000-0000000000a1');
  perform pg_temp.assert(
    pg_temp.members('e0692000-0000-4000-8000-0000000000a1') = 'e0691000-0000-4000-8000-0000000000a1',
    'part6: the table owner can still write');
end $$;

-- ============================================================
-- Part 7: the suite really ran.
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

select 'BUNDLE-MEMBERSHIP-AUTH-1 069 suite: all assertions passed' as result;

rollback;
