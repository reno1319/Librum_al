-- Committed SQL regression suite for ALL-DISCOUNT-3
-- (supabase/migrations/20260923112502_all_discount_codes_acl.sql):
-- authenticated can no longer write the legacy USD column
-- `discount_codes.amount_off_cents`, and every other discount_codes
-- capability is exactly what it was.
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
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/064_all_discount_codes_acl.test.sql
--
-- It must also pass against the OTHER build path -- base schema.sql plus
-- the migration -- and
-- supabase/tests/064_all_discount_codes_acl_catalog_equivalence.sh is
-- what proves those two paths agree in the first place. Against the
-- BASE schema alone it must FAIL: that is the negative control showing
-- this suite can see the hole it exists to close.
--
-- Everything below runs inside one transaction and is rolled back at the
-- end, so the file is repeatable and leaves no rows behind.
--
-- Two kinds of proof, deliberately both. Privilege METADATA
-- (has_*_privilege, relacl, attacl) says what the catalog grants;
-- EFFECTIVE behaviour (real INSERT/UPDATE/DELETE/SELECT under each role,
-- with RLS on) says what a caller can actually do. Either alone can be
-- right while the other is wrong -- e.g. a correct column grant masked
-- by a surviving table-level grant, or a correct ACL under an RLS policy
-- that no longer checks ownership.
--
-- Privilege errors and RLS errors share SQLSTATE 42501, so every
-- expected failure below also pins the message fragment that tells them
-- apart: "permission denied for table" is the ACL, "row-level security"
-- is the policy. A test expecting one must not pass on the other.

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

-- ============================================================
-- Part 0: fixtures. Two authors, one book each, and one pre-existing
-- code of each shape for author A -- including a LEGACY amount_off_cents
-- row, which must survive this change byte-for-byte and stay readable.
-- Pre-existing rows are written as the table owner, the way historical
-- rows were written.
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0640000-0000-0000-0000-00000000000a', 'p064-author-a@test', now(), '{"role":"author","display_name":"P064 A"}'),
  ('e0640000-0000-0000-0000-00000000000b', 'p064-author-b@test', now(), '{"role":"author","display_name":"P064 B"}');

update public.profiles set role = 'author'
  where id in ('e0640000-0000-0000-0000-00000000000a', 'e0640000-0000-0000-0000-00000000000b');

insert into public.books (id, author_id, title, status, price_all) values
  ('e0641000-0000-0000-0000-00000000000a', 'e0640000-0000-0000-0000-00000000000a', 'P064 Book A', 'published', 500),
  ('e0641000-0000-0000-0000-00000000000b', 'e0640000-0000-0000-0000-00000000000b', 'P064 Book B', 'published', 500);

insert into public.discount_codes (id, author_id, book_id, code, percent_off, amount_off_cents, amount_off_all) values
  ('e0642000-0000-0000-0000-000000000001', 'e0640000-0000-0000-0000-00000000000a',
   'e0641000-0000-0000-0000-00000000000a', 'P064-OLD-USD', null, 500, null),
  ('e0642000-0000-0000-0000-000000000002', 'e0640000-0000-0000-0000-00000000000a',
   'e0641000-0000-0000-0000-00000000000a', 'P064-OLD-PCT', 15, null, null),
  ('e0642000-0000-0000-0000-000000000003', 'e0640000-0000-0000-0000-00000000000a',
   'e0641000-0000-0000-0000-00000000000a', 'P064-OLD-ALL', null, null, 120),
  ('e0642000-0000-0000-0000-000000000004', 'e0640000-0000-0000-0000-00000000000b',
   'e0641000-0000-0000-0000-00000000000b', 'P064-B-PCT', 30, null, null);

create table pg_temp.rows_before as
  select id, row_to_json(d)::text as image
    from public.discount_codes d
   where id::text like 'e0642000-%';

-- ============================================================
-- Part 1: privilege metadata -- amount_off_cents is unwritable by
-- PUBLIC, anon and authenticated, on INSERT and on UPDATE.
-- ============================================================
do $$
declare
  v_role text;
  v_priv text;
begin
  foreach v_role in array array['public', 'anon', 'authenticated'] loop
    foreach v_priv in array array['INSERT', 'UPDATE'] loop
      perform pg_temp.assert(
        not has_column_privilege(v_role, 'public.discount_codes', 'amount_off_cents', v_priv),
        format('part1: %s must NOT have %s on amount_off_cents', v_role, v_priv));
      -- No table-level grant may survive: it would cover every column,
      -- amount_off_cents included, whatever the column grants say.
      perform pg_temp.assert(
        not has_table_privilege(v_role, 'public.discount_codes', v_priv),
        format('part1: %s must NOT have table-level %s on discount_codes', v_role, v_priv));
    end loop;
  end loop;
end $$;

-- ============================================================
-- Part 2: the exact per-column INSERT and UPDATE sets for
-- authenticated, over EVERY column of the table -- so a future column
-- that silently becomes writable is caught too.
-- ============================================================
do $$
declare
  v_insert text;
  v_update text;
  v_select text;
  v_cols text;
begin
  select string_agg(attname, ',' order by attname) filter
           (where has_column_privilege('authenticated', 'public.discount_codes', attname, 'INSERT')),
         string_agg(attname, ',' order by attname) filter
           (where has_column_privilege('authenticated', 'public.discount_codes', attname, 'UPDATE')),
         string_agg(attname, ',' order by attname) filter
           (where has_column_privilege('authenticated', 'public.discount_codes', attname, 'SELECT')),
         string_agg(attname, ',' order by attname)
    into v_insert, v_update, v_select, v_cols
    from pg_catalog.pg_attribute
   where attrelid = 'public.discount_codes'::regclass and attnum > 0 and not attisdropped;

  perform pg_temp.assert(
    v_cols = 'active,amount_off_all,amount_off_cents,author_id,book_id,code,created_at,expires_at,id,percent_off',
    format('part2: discount_codes column set changed -- re-derive this suite''s expectations; found %s', v_cols));
  perform pg_temp.assert(
    v_insert = 'amount_off_all,author_id,book_id,code,expires_at,id,percent_off',
    format('part2: authenticated INSERT columns must be exactly the application''s create path -- found %s', v_insert));
  perform pg_temp.assert(v_update = 'active',
    format('part2: authenticated UPDATE must remain exactly (active) -- found %s', v_update));
  perform pg_temp.assert(v_select = v_cols,
    format('part2: authenticated SELECT must still cover every column -- found %s', v_select));
end $$;

-- ============================================================
-- Part 3: everything else about the table's privileges is unchanged.
-- ============================================================
do $$
declare
  v_priv text;
  v_col text;
  v_acl text;
  v_colacl text;
begin
  -- authenticated keeps table-level SELECT and DELETE, and still has
  -- nothing it did not have before.
  perform pg_temp.assert(has_table_privilege('authenticated', 'public.discount_codes', 'SELECT'),
    'part3: authenticated must keep table-level SELECT');
  perform pg_temp.assert(has_table_privilege('authenticated', 'public.discount_codes', 'DELETE'),
    'part3: authenticated must keep table-level DELETE');
  foreach v_priv in array array['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
    perform pg_temp.assert(not has_table_privilege('authenticated', 'public.discount_codes', v_priv),
      format('part3: authenticated must NOT have %s', v_priv));
  end loop;

  -- anon and PUBLIC hold nothing, at either level.
  foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
    perform pg_temp.assert(not has_table_privilege('anon', 'public.discount_codes', v_priv),
      format('part3: anon must NOT have %s', v_priv));
    perform pg_temp.assert(not has_table_privilege('public', 'public.discount_codes', v_priv),
      format('part3: PUBLIC must NOT have %s', v_priv));
  end loop;
  perform pg_temp.assert(not has_any_column_privilege('anon', 'public.discount_codes', 'SELECT,INSERT,UPDATE,REFERENCES'),
    'part3: anon must hold no column-level privilege on discount_codes');
  perform pg_temp.assert(not has_any_column_privilege('public', 'public.discount_codes', 'SELECT,INSERT,UPDATE,REFERENCES'),
    'part3: PUBLIC must hold no column-level privilege on discount_codes');

  -- service_role is not narrowed: every table privilege, and write
  -- access to the legacy column specifically.
  foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
    perform pg_temp.assert(has_table_privilege('service_role', 'public.discount_codes', v_priv),
      format('part3: service_role must keep table-level %s', v_priv));
  end loop;
  foreach v_col in array array['amount_off_cents', 'amount_off_all', 'percent_off', 'active'] loop
    perform pg_temp.assert(has_column_privilege('service_role', 'public.discount_codes', v_col, 'INSERT'),
      format('part3: service_role must keep INSERT on %s', v_col));
    perform pg_temp.assert(has_column_privilege('service_role', 'public.discount_codes', v_col, 'UPDATE'),
      format('part3: service_role must keep UPDATE on %s', v_col));
  end loop;

  -- The table owner (postgres on Supabase) keeps everything.
  foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
    perform pg_temp.assert(
      has_table_privilege((select relowner from pg_class where oid = 'public.discount_codes'::regclass),
                          'public.discount_codes', v_priv),
      format('part3: the table owner must keep %s', v_priv));
  end loop;

  -- The exact non-owner table ACL, and the exact column ACLs. Owner
  -- entries are excluded because the owner's role name differs between
  -- a local instance and a Supabase project.
  select string_agg(g || ':' || p, ' | ' order by g, p) into v_acl
    from (select case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as g,
                 a.privilege_type as p
            from pg_class c, aclexplode(c.relacl) a
           where c.oid = 'public.discount_codes'::regclass and a.grantee <> c.relowner) s;
  perform pg_temp.assert(v_acl =
    'authenticated:DELETE | authenticated:SELECT'
    || ' | service_role:DELETE | service_role:INSERT | service_role:MAINTAIN | service_role:REFERENCES | service_role:SELECT'
    || ' | service_role:TRIGGER | service_role:TRUNCATE | service_role:UPDATE',
    format('part3: discount_codes table ACL -- found %s', v_acl));

  select string_agg(att.attname || '/' || (a.grantee::regrole::text) || ':' || a.privilege_type, ' | '
                    order by att.attname, a.privilege_type) into v_colacl
    from pg_attribute att, aclexplode(att.attacl) a
   where att.attrelid = 'public.discount_codes'::regclass and att.attnum > 0;
  perform pg_temp.assert(v_colacl =
    'active/authenticated:UPDATE'
    || ' | amount_off_all/authenticated:INSERT'
    || ' | author_id/authenticated:INSERT'
    || ' | book_id/authenticated:INSERT'
    || ' | code/authenticated:INSERT'
    || ' | expires_at/authenticated:INSERT'
    || ' | id/authenticated:INSERT'
    || ' | percent_off/authenticated:INSERT',
    format('part3: discount_codes column ACLs -- found %s', v_colacl));

  -- RLS is on, not forced, and the four ownership policies are intact.
  perform pg_temp.assert(
    (select relrowsecurity and not relforcerowsecurity from pg_class where oid = 'public.discount_codes'::regclass),
    'part3: row level security must still be enabled (and not forced) on discount_codes');
  perform pg_temp.assert(
    (select string_agg(policyname || '/' || cmd, ' | ' order by policyname)
       from pg_policies where schemaname = 'public' and tablename = 'discount_codes') =
    'Authors can create discount codes for their own books/INSERT'
    || ' | Authors can delete their own discount codes/DELETE'
    || ' | Authors can update their own discount codes/UPDATE'
    || ' | Authors can view their own discount codes/SELECT',
    'part3: the discount_codes policy set changed');
end $$;

-- ============================================================
-- Part 4: effective behaviour as authenticated author A.
-- ============================================================
select pg_temp.expect_ok('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$insert into public.discount_codes (id, author_id, book_id, code, percent_off, expires_at)
     values ('e0643000-0000-0000-0000-000000000001', 'e0640000-0000-0000-0000-00000000000a',
             'e0641000-0000-0000-0000-00000000000a', 'P064-NEW-PCT', 20, null)$q$,
  1, 'part4: author can create a percentage code with the application''s exact column list');

select pg_temp.expect_ok('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$insert into public.discount_codes (id, author_id, book_id, code, amount_off_all, expires_at)
     values ('e0643000-0000-0000-0000-000000000002', 'e0640000-0000-0000-0000-00000000000a',
             'e0641000-0000-0000-0000-00000000000a', 'P064-NEW-ALL', 250, now() + interval '30 days')$q$,
  1, 'part4: author can create an amount_off_all code with the application''s exact column list');

-- The domain bounds, below the catalog floor included.
select pg_temp.expect_ok('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$insert into public.discount_codes (id, author_id, book_id, code, amount_off_all)
     values ('e0643000-0000-0000-0000-000000000003', 'e0640000-0000-0000-0000-00000000000a',
             'e0641000-0000-0000-0000-00000000000a', 'P064-NEW-ALL-1', 1),
            ('e0643000-0000-0000-0000-000000000004', 'e0640000-0000-0000-0000-00000000000a',
             'e0641000-0000-0000-0000-00000000000a', 'P064-NEW-ALL-MAX', 100000)$q$,
  2, 'part4: amount_off_all 1 and 100000 are both creatable');

do $$
begin
  perform pg_temp.assert(
    (select amount_off_all = 250 and percent_off is null and amount_off_cents is null and active
       from public.discount_codes where id = 'e0643000-0000-0000-0000-000000000002'),
    'part4: the ALL code stores exactly 250 in amount_off_all, nothing in the other two, active by default');
  perform pg_temp.assert(
    (select percent_off = 20 and amount_off_all is null and amount_off_cents is null
       from public.discount_codes where id = 'e0643000-0000-0000-0000-000000000001'),
    'part4: the percentage code stores exactly 20 in percent_off');
end $$;

-- The hole this migration closes: a raw INSERT naming amount_off_cents.
select pg_temp.expect_error('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$insert into public.discount_codes (author_id, book_id, code, amount_off_cents)
     values ('e0640000-0000-0000-0000-00000000000a', 'e0641000-0000-0000-0000-00000000000a', 'P064-HOLE', 500)$q$,
  '42501', 'permission denied for table discount_codes',
  'part4: author must NOT be able to INSERT an amount_off_cents code');

-- Naming the column at all is refused, even with a NULL value: this is
-- the shape of the pre-Patch-3 application's payload, which is why the
-- Patch 3 application omits the key rather than sending null.
select pg_temp.expect_error('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$insert into public.discount_codes (id, author_id, book_id, code, percent_off, amount_off_cents, expires_at)
     values (gen_random_uuid(), 'e0640000-0000-0000-0000-00000000000a',
             'e0641000-0000-0000-0000-00000000000a', 'P064-NULL-CENTS', 10, null, null)$q$,
  '42501', 'permission denied for table discount_codes',
  'part4: an INSERT naming amount_off_cents as NULL is refused too');

-- Defaulted columns are not insertable.
select pg_temp.expect_error('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$insert into public.discount_codes (author_id, book_id, code, percent_off, active)
     values ('e0640000-0000-0000-0000-00000000000a', 'e0641000-0000-0000-0000-00000000000a', 'P064-ACTIVE', 10, false)$q$,
  '42501', 'permission denied for table discount_codes',
  'part4: author must NOT be able to INSERT active explicitly');
select pg_temp.expect_error('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$insert into public.discount_codes (author_id, book_id, code, percent_off, created_at)
     values ('e0640000-0000-0000-0000-00000000000a', 'e0641000-0000-0000-0000-00000000000a', 'P064-CREATED', 10, now())$q$,
  '42501', 'permission denied for table discount_codes',
  'part4: author must NOT be able to INSERT created_at explicitly');

-- The constraints still back the ACL: no discount at all, and an
-- out-of-range ALL amount, are refused by CHECK, not silently stored.
select pg_temp.expect_error('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$insert into public.discount_codes (author_id, book_id, code)
     values ('e0640000-0000-0000-0000-00000000000a', 'e0641000-0000-0000-0000-00000000000a', 'P064-EMPTY')$q$,
  '23514', 'discount_codes_exactly_one_discount_type_check',
  'part4: a code with no discount column violates the exactly-one CHECK');
select pg_temp.expect_error('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$insert into public.discount_codes (author_id, book_id, code, amount_off_all)
     values ('e0640000-0000-0000-0000-00000000000a', 'e0641000-0000-0000-0000-00000000000a', 'P064-ZERO', 0)$q$,
  '23514', 'discount_codes_amount_off_all_range_check',
  'part4: amount_off_all = 0 violates the range CHECK');
select pg_temp.expect_error('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$insert into public.discount_codes (author_id, book_id, code, amount_off_all)
     values ('e0640000-0000-0000-0000-00000000000a', 'e0641000-0000-0000-0000-00000000000a', 'P064-OVER', 100001)$q$,
  '23514', 'discount_codes_amount_off_all_range_check',
  'part4: amount_off_all = 100001 violates the range CHECK');
select pg_temp.expect_error('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$insert into public.discount_codes (author_id, book_id, code, percent_off, amount_off_all)
     values ('e0640000-0000-0000-0000-00000000000a', 'e0641000-0000-0000-0000-00000000000a', 'P064-BOTH', 10, 100)$q$,
  '23514', 'discount_codes_exactly_one_discount_type_check',
  'part4: percent_off and amount_off_all together violate the exactly-one CHECK');

-- UPDATE: only `active`, on the author's own rows.
select pg_temp.expect_error('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$update public.discount_codes set amount_off_cents = 1 where id = 'e0642000-0000-0000-0000-000000000001'$q$,
  '42501', 'permission denied for table discount_codes',
  'part4: author must NOT be able to UPDATE amount_off_cents on their own legacy code');
select pg_temp.expect_error('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$update public.discount_codes set amount_off_cents = 700, percent_off = null where id = 'e0642000-0000-0000-0000-000000000002'$q$,
  '42501', 'permission denied for table discount_codes',
  'part4: author must NOT be able to turn a percentage code into an amount_off_cents code');
select pg_temp.expect_error('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$update public.discount_codes set amount_off_all = 1 where id = 'e0643000-0000-0000-0000-000000000002'$q$,
  '42501', 'permission denied for table discount_codes',
  'part4: author must NOT be able to UPDATE amount_off_all (a code''s value is immutable)');
select pg_temp.expect_error('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$update public.discount_codes set percent_off = 99 where id = 'e0643000-0000-0000-0000-000000000001'$q$,
  '42501', 'permission denied for table discount_codes',
  'part4: author must NOT be able to UPDATE percent_off');
select pg_temp.expect_error('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$update public.discount_codes set book_id = 'e0641000-0000-0000-0000-00000000000b' where id = 'e0643000-0000-0000-0000-000000000001'$q$,
  '42501', 'permission denied for table discount_codes',
  'part4: author must NOT be able to repoint a code at another book');
select pg_temp.expect_ok('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$update public.discount_codes set active = false where id = 'e0643000-0000-0000-0000-000000000002'$q$,
  1, 'part4: toggleDiscountCode''s `{ active }` update still works on the author''s own code');
do $$
begin
  perform pg_temp.assert(
    (select not active from public.discount_codes where id = 'e0643000-0000-0000-0000-000000000002'),
    'part4: the deactivation persisted');
end $$;

-- SELECT: the author still sees their own legacy row, value intact.
select pg_temp.expect_ok('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$select 1 from public.discount_codes where id = 'e0642000-0000-0000-0000-000000000001' and amount_off_cents = 500$q$,
  1, 'part4: author can still SELECT their own legacy amount_off_cents code');
select pg_temp.expect_ok('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$select 1 from public.discount_codes where author_id = 'e0640000-0000-0000-0000-00000000000a'$q$,
  7, 'part4: author A sees exactly their own seven codes');

-- DELETE: own rows only.
select pg_temp.expect_ok('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$delete from public.discount_codes where id = 'e0643000-0000-0000-0000-000000000003'$q$,
  1, 'part4: author can still DELETE their own code');

-- ============================================================
-- Part 5: ownership cannot be bypassed through the new column grants.
-- ============================================================
select pg_temp.expect_error('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$insert into public.discount_codes (author_id, book_id, code, amount_off_all)
     values ('e0640000-0000-0000-0000-00000000000b', 'e0641000-0000-0000-0000-00000000000b', 'P064-STEAL-1', 100)$q$,
  '42501', 'row-level security',
  'part5: author A must NOT create a code as author B');
select pg_temp.expect_error('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$insert into public.discount_codes (author_id, book_id, code, amount_off_all)
     values ('e0640000-0000-0000-0000-00000000000a', 'e0641000-0000-0000-0000-00000000000b', 'P064-STEAL-2', 100)$q$,
  '42501', 'row-level security',
  'part5: author A must NOT create a code for author B''s book');
select pg_temp.expect_error('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$insert into public.discount_codes (author_id, book_id, code, percent_off)
     values ('e0640000-0000-0000-0000-00000000000a', 'e0641000-0000-0000-0000-00000000000b', 'P064-STEAL-3', 10)$q$,
  '42501', 'row-level security',
  'part5: the same holds for a percentage code');
select pg_temp.expect_error('authenticated', null,
  $q$insert into public.discount_codes (author_id, book_id, code, percent_off)
     values ('e0640000-0000-0000-0000-00000000000a', 'e0641000-0000-0000-0000-00000000000a', 'P064-NOUID', 10)$q$,
  '42501', 'row-level security',
  'part5: authenticated with no auth.uid() cannot create a code');
select pg_temp.expect_ok('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$update public.discount_codes set active = false where id = 'e0642000-0000-0000-0000-000000000004'$q$,
  0, 'part5: author A cannot deactivate author B''s code (zero rows)');
select pg_temp.expect_ok('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$delete from public.discount_codes where id = 'e0642000-0000-0000-0000-000000000004'$q$,
  0, 'part5: author A cannot delete author B''s code (zero rows)');
select pg_temp.expect_ok('authenticated', 'e0640000-0000-0000-0000-00000000000a',
  $q$select 1 from public.discount_codes where author_id = 'e0640000-0000-0000-0000-00000000000b'$q$,
  0, 'part5: author A cannot read author B''s codes');

-- ============================================================
-- Part 6: anon writes nothing and reads nothing.
-- ============================================================
select pg_temp.expect_error('anon', null,
  $q$insert into public.discount_codes (author_id, book_id, code, percent_off)
     values ('e0640000-0000-0000-0000-00000000000a', 'e0641000-0000-0000-0000-00000000000a', 'P064-ANON', 10)$q$,
  '42501', 'permission denied for table discount_codes', 'part6: anon must NOT INSERT');
select pg_temp.expect_error('anon', null,
  $q$insert into public.discount_codes (author_id, book_id, code, amount_off_all)
     values ('e0640000-0000-0000-0000-00000000000a', 'e0641000-0000-0000-0000-00000000000a', 'P064-ANON-ALL', 10)$q$,
  '42501', 'permission denied for table discount_codes', 'part6: anon must NOT INSERT amount_off_all');
select pg_temp.expect_error('anon', null,
  $q$update public.discount_codes set active = false$q$,
  '42501', 'permission denied for table discount_codes', 'part6: anon must NOT UPDATE');
select pg_temp.expect_error('anon', null,
  $q$delete from public.discount_codes$q$,
  '42501', 'permission denied for table discount_codes', 'part6: anon must NOT DELETE');
select pg_temp.expect_error('anon', null,
  $q$select 1 from public.discount_codes$q$,
  '42501', 'permission denied for table discount_codes', 'part6: anon must NOT SELECT');

-- ============================================================
-- Part 7: service_role and the table owner are not narrowed -- both can
-- still write the legacy column, so historical data stays operable.
-- ============================================================
select pg_temp.expect_ok('service_role', null,
  $q$insert into public.discount_codes (id, author_id, book_id, code, amount_off_cents, active, created_at)
     values ('e0643000-0000-0000-0000-000000000010', 'e0640000-0000-0000-0000-00000000000b',
             'e0641000-0000-0000-0000-00000000000b', 'P064-SR-USD', 900, true, now())$q$,
  1, 'part7: service_role can still INSERT amount_off_cents (and active, created_at)');
select pg_temp.expect_ok('service_role', null,
  $q$update public.discount_codes set amount_off_cents = 901, active = false
     where id = 'e0643000-0000-0000-0000-000000000010'$q$,
  1, 'part7: service_role can still UPDATE amount_off_cents');
select pg_temp.expect_ok('service_role', null,
  $q$select 1 from public.discount_codes where id::text like 'e064%'$q$,
  8, 'part7: service_role still reads every code');
select pg_temp.expect_ok('service_role', null,
  $q$delete from public.discount_codes where id = 'e0643000-0000-0000-0000-000000000010'$q$,
  1, 'part7: service_role can still DELETE');

do $$
declare
  v_rows integer;
begin
  -- The owner, as itself (no role switch): this is how historical rows
  -- were written and how the fixtures above were written.
  insert into public.discount_codes (id, author_id, book_id, code, amount_off_cents)
    values ('e0643000-0000-0000-0000-000000000011', 'e0640000-0000-0000-0000-00000000000b',
            'e0641000-0000-0000-0000-00000000000b', 'P064-OWNER-USD', 250);
  update public.discount_codes set amount_off_cents = 251 where id = 'e0643000-0000-0000-0000-000000000011';
  get diagnostics v_rows = row_count;
  perform pg_temp.assert(v_rows = 1, 'part7: the table owner can still write amount_off_cents');
  delete from public.discount_codes where id = 'e0643000-0000-0000-0000-000000000011';
end $$;

-- ============================================================
-- Part 8: pre-existing rows are byte-identical after everything above.
-- ============================================================
do $$
declare
  v_changed integer;
begin
  select count(*) into v_changed
    from pg_temp.rows_before b
    left join public.discount_codes d on d.id = b.id
   where d.id is null or row_to_json(d)::text <> b.image;
  perform pg_temp.assert(v_changed = 0,
    format('part8: %s pre-existing discount row(s) changed or disappeared', v_changed));
  perform pg_temp.assert((select count(*) from pg_temp.rows_before) = 4,
    'part8: the snapshot must cover all four pre-existing rows');
end $$;

-- ============================================================
-- Part 9: the suite really ran. The number of assertions is pinned, so
-- a block that silently stopped asserting is a failure, not a pass.
-- ============================================================
do $$
declare
  v_n integer;
begin
  select n into v_n from pg_temp.assertions_run;
  if v_n <> 106 then
    raise exception 'FAIL: expected 106 assertions to run, found %', v_n;
  end if;
end $$;

select 'ALL-DISCOUNT-3 064 suite: all assertions passed' as result;

rollback;
