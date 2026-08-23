-- Committed SQL regression suite for migration 034 (LAUNCH-1 P1-6
-- remediation: purchases/bundle_checkout_snapshots ACL, discount_codes
-- ACL reset, handle_new_user() search_path + EXECUTE revoke, explicit
-- WITH CHECK on books/bundles/series UPDATE policies).
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql -- no new test
-- infrastructure needed. Two equivalent ways to run this, per the
-- P1-6 remediation instructions:
--
-- (a) Fresh schema.sql (already includes migration 034's final state):
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/034_harden_remaining_table_acls.test.sql
--
-- (b) An exact through-033 snapshot with migration 034 applied on top:
--   createdb librum_test_034
--   psql -d librum_test_034 -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test_034 -f <through-033 schema snapshot>
--   psql -d librum_test_034 -v ON_ERROR_STOP=1 -f supabase/migrations/034_harden_remaining_table_acls.sql
--   psql -d librum_test_034 -v ON_ERROR_STOP=1 -f supabase/tests/034_harden_remaining_table_acls.test.sql
--
-- Everything below runs inside one transaction and is rolled back at
-- the end, so this file is fully repeatable with no manual cleanup
-- between runs -- except the ACL assertions, which read committed
-- privilege state (has_table_privilege/has_column_privilege/
-- has_function_privilege and information_schema read what schema.sql
-- or migration 034 already committed, never anything this test writes).

begin;

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

-- ============================================================
-- Part 1: purchases -- table-level ACL, exactly per the required
-- final privilege model (SELECT only, authenticated only).
-- ============================================================
do $$
begin
  perform pg_temp.assert(not has_table_privilege('anon', 'public.purchases', 'SELECT'),
    'part1: anon must not have SELECT on purchases');
  perform pg_temp.assert(not has_table_privilege('anon', 'public.purchases', 'INSERT'),
    'part1: anon must not have INSERT on purchases');
  perform pg_temp.assert(not has_table_privilege('anon', 'public.purchases', 'UPDATE'),
    'part1: anon must not have UPDATE on purchases');
  perform pg_temp.assert(not has_table_privilege('anon', 'public.purchases', 'DELETE'),
    'part1: anon must not have DELETE on purchases');

  perform pg_temp.assert(has_table_privilege('authenticated', 'public.purchases', 'SELECT'),
    'part1: authenticated must have SELECT on purchases');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.purchases', 'INSERT'),
    'part1: authenticated must not have INSERT on purchases');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.purchases', 'UPDATE'),
    'part1: authenticated must not have UPDATE on purchases');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.purchases', 'DELETE'),
    'part1: authenticated must not have DELETE on purchases');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.purchases', 'TRUNCATE'),
    'part1: authenticated must not have TRUNCATE on purchases');

  -- service_role: untouched.
  perform pg_temp.assert(has_table_privilege('service_role', 'public.purchases', 'INSERT'),
    'part1: service_role must retain INSERT on purchases');
  perform pg_temp.assert(has_table_privilege('service_role', 'public.purchases', 'UPDATE'),
    'part1: service_role must retain UPDATE on purchases');

  perform pg_temp.assert(
    not exists (
      select 1 from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'purchases' and grantee = 'PUBLIC'
    ),
    'part1: PUBLIC must have zero explicit grants on purchases'
  );
end $$;

-- ============================================================
-- Part 2: bundle_checkout_snapshots -- same shape as Part 1.
-- ============================================================
do $$
begin
  perform pg_temp.assert(not has_table_privilege('anon', 'public.bundle_checkout_snapshots', 'SELECT'),
    'part2: anon must not have SELECT on bundle_checkout_snapshots');
  perform pg_temp.assert(not has_table_privilege('anon', 'public.bundle_checkout_snapshots', 'INSERT'),
    'part2: anon must not have INSERT on bundle_checkout_snapshots');

  perform pg_temp.assert(has_table_privilege('authenticated', 'public.bundle_checkout_snapshots', 'SELECT'),
    'part2: authenticated must have SELECT on bundle_checkout_snapshots');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.bundle_checkout_snapshots', 'INSERT'),
    'part2: authenticated must not have INSERT on bundle_checkout_snapshots');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.bundle_checkout_snapshots', 'UPDATE'),
    'part2: authenticated must not have UPDATE on bundle_checkout_snapshots');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.bundle_checkout_snapshots', 'DELETE'),
    'part2: authenticated must not have DELETE on bundle_checkout_snapshots');

  perform pg_temp.assert(has_table_privilege('service_role', 'public.bundle_checkout_snapshots', 'UPDATE'),
    'part2: service_role must retain UPDATE on bundle_checkout_snapshots');

  perform pg_temp.assert(
    not exists (
      select 1 from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'bundle_checkout_snapshots' and grantee = 'PUBLIC'
    ),
    'part2: PUBLIC must have zero explicit grants on bundle_checkout_snapshots'
  );
end $$;

-- ============================================================
-- Part 3: discount_codes -- full reset-and-regrant model.
-- ============================================================
do $$
begin
  perform pg_temp.assert(not has_table_privilege('anon', 'public.discount_codes', 'SELECT'),
    'part3: anon must not have SELECT on discount_codes');
  perform pg_temp.assert(not has_table_privilege('anon', 'public.discount_codes', 'INSERT'),
    'part3: anon must not have INSERT on discount_codes');
  perform pg_temp.assert(not has_table_privilege('anon', 'public.discount_codes', 'DELETE'),
    'part3: anon must not have DELETE on discount_codes');
  perform pg_temp.assert(not has_table_privilege('anon', 'public.discount_codes', 'UPDATE'),
    'part3: anon must not have UPDATE on discount_codes');

  perform pg_temp.assert(has_table_privilege('authenticated', 'public.discount_codes', 'SELECT'),
    'part3: authenticated must have SELECT on discount_codes');
  perform pg_temp.assert(has_table_privilege('authenticated', 'public.discount_codes', 'INSERT'),
    'part3: authenticated must have INSERT on discount_codes');
  perform pg_temp.assert(has_table_privilege('authenticated', 'public.discount_codes', 'DELETE'),
    'part3: authenticated must have DELETE on discount_codes');

  -- UPDATE, column by column: exactly `active`.
  perform pg_temp.assert(has_column_privilege('authenticated', 'public.discount_codes', 'active', 'UPDATE'),
    'part3: authenticated must have UPDATE on active');
  perform pg_temp.assert(not has_column_privilege('authenticated', 'public.discount_codes', 'percent_off', 'UPDATE'),
    'part3: authenticated must NOT have UPDATE on percent_off');
  perform pg_temp.assert(not has_column_privilege('authenticated', 'public.discount_codes', 'amount_off_cents', 'UPDATE'),
    'part3: authenticated must NOT have UPDATE on amount_off_cents');
  perform pg_temp.assert(not has_column_privilege('authenticated', 'public.discount_codes', 'book_id', 'UPDATE'),
    'part3: authenticated must NOT have UPDATE on book_id');
  perform pg_temp.assert(not has_column_privilege('authenticated', 'public.discount_codes', 'author_id', 'UPDATE'),
    'part3: authenticated must NOT have UPDATE on author_id');

  perform pg_temp.assert(has_table_privilege('service_role', 'public.discount_codes', 'UPDATE'),
    'part3: service_role must retain table-wide UPDATE on discount_codes');
  perform pg_temp.assert(has_column_privilege('service_role', 'public.discount_codes', 'percent_off', 'UPDATE'),
    'part3: service_role must retain UPDATE on percent_off specifically');

  perform pg_temp.assert(
    not exists (
      select 1 from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'discount_codes' and grantee = 'PUBLIC'
    ),
    'part3: PUBLIC must have zero explicit grants on discount_codes'
  );
end $$;

-- ============================================================
-- Part 4: handle_new_user() -- search_path and EXECUTE grants.
-- ============================================================
do $$
declare
  proc record;
begin
  select p.proconfig, p.prosecdef
  into proc
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'handle_new_user';

  perform pg_temp.assert(proc.prosecdef, 'part4: handle_new_user must remain SECURITY DEFINER');
  perform pg_temp.assert(
    proc.proconfig @> array['search_path=""']::text[],
    format('part4: handle_new_user search_path must be empty, got: %s', proc.proconfig)
  );

  perform pg_temp.assert(not has_function_privilege('anon', 'public.handle_new_user()', 'EXECUTE'),
    'part4: anon must not have EXECUTE on handle_new_user');
  perform pg_temp.assert(not has_function_privilege('authenticated', 'public.handle_new_user()', 'EXECUTE'),
    'part4: authenticated must not have EXECUTE on handle_new_user');

  perform pg_temp.assert(
    not exists (
      select 1 from information_schema.routine_privileges
      where routine_schema = 'public' and routine_name = 'handle_new_user' and grantee = 'PUBLIC'
    ),
    'part4: PUBLIC must have zero explicit EXECUTE grant on handle_new_user'
  );
end $$;

-- ============================================================
-- Part 5: books/bundles/series UPDATE policies -- explicit WITH CHECK
-- present and identical to USING, per migration 034's ALTER POLICY.
-- ============================================================
do $$
declare
  pol record;
begin
  select pg_get_expr(polqual, polrelid) as qual, pg_get_expr(polwithcheck, polrelid) as with_check
  into pol
  from pg_policy
  where polrelid = 'public.books'::regclass and polname = 'Authors can update their own books';
  perform pg_temp.assert(pol.with_check is not null and pol.with_check = '(auth.uid() = author_id)',
    format('part5: unexpected books WITH CHECK: %s', pol.with_check));

  select pg_get_expr(polqual, polrelid) as qual, pg_get_expr(polwithcheck, polrelid) as with_check
  into pol
  from pg_policy
  where polrelid = 'public.bundles'::regclass and polname = 'Authors can update their own bundles';
  perform pg_temp.assert(pol.with_check is not null and pol.with_check = '(auth.uid() = author_id)',
    format('part5: unexpected bundles WITH CHECK: %s', pol.with_check));

  select pg_get_expr(polqual, polrelid) as qual, pg_get_expr(polwithcheck, polrelid) as with_check
  into pol
  from pg_policy
  where polrelid = 'public.series'::regclass and polname = 'Authors can rename their own series';
  perform pg_temp.assert(pol.with_check is not null and pol.with_check = '(auth.uid() = author_id)',
    format('part5: unexpected series WITH CHECK: %s', pol.with_check));
end $$;

-- ============================================================
-- Part 6: end-to-end functional checks -- fixtures.
-- ============================================================
insert into auth.users (id, email, raw_user_meta_data) values
  ('77777777-7777-7777-7777-777777777777', 'p034-author@test', '{"role":"author","display_name":"Author"}'),
  ('88888888-8888-8888-8888-888888888888', 'p034-reader@test', '{"role":"reader","display_name":"Reader"}'),
  ('99999999-9999-9999-9999-999999999999', 'p034-other@test', '{"role":"reader","display_name":"Other"}');

insert into public.books (id, author_id, title, price_cents, status) values
  ('11111111-2222-3333-4444-555555555555', '77777777-7777-7777-7777-777777777777', 'P034 Test Book', 500, 'published');

insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('22222222-2222-2222-2222-222222222222', '11111111-2222-3333-4444-555555555555', '88888888-8888-8888-8888-888888888888', 'cs_test_p034', 500);

insert into public.bundle_checkout_snapshots
  (id, author_id, reader_id, bundle_title, bundle_price_cents_at_checkout, items, protection_expires_at, fulfilled_at)
values
  ('33333333-3333-3333-3333-333333333333', '77777777-7777-7777-7777-777777777777', '88888888-8888-8888-8888-888888888888',
   'P034 Test Bundle', 900, '[]'::jsonb, now() + interval '1 day', now());

-- --- Part 6a: purchases functional access ---
do $$
declare
  n integer;
begin
  -- Reader can see their own purchase.
  perform set_config('request.jwt.claim.sub', '88888888-8888-8888-8888-888888888888', true);
  set local role authenticated;
  select count(*) into n from public.purchases where id = '22222222-2222-2222-2222-222222222222';
  reset role;
  perform pg_temp.assert(n = 1, 'part6a: reader must be able to SELECT their own purchase');

  -- Author can see a purchase of their own book.
  perform set_config('request.jwt.claim.sub', '77777777-7777-7777-7777-777777777777', true);
  set local role authenticated;
  select count(*) into n from public.purchases where id = '22222222-2222-2222-2222-222222222222';
  reset role;
  perform pg_temp.assert(n = 1, 'part6a: author must be able to SELECT a purchase of their own book');
end $$;

do $$
begin
  -- authenticated cannot INSERT into purchases at all -- ACL blocks it
  -- before RLS is even reached.
  perform set_config('request.jwt.claim.sub', '88888888-8888-8888-8888-888888888888', true);
  set local role authenticated;
  begin
    insert into public.purchases (book_id, reader_id, stripe_checkout_session_id, amount_cents)
    values ('11111111-2222-3333-4444-555555555555', '88888888-8888-8888-8888-888888888888', 'cs_forged', 1);
    perform pg_temp.assert(false, 'part6a: authenticated must not be able to INSERT into purchases');
  exception when insufficient_privilege then
    null;
  end;
  reset role;
end $$;

do $$
begin
  -- authenticated cannot UPDATE purchases (e.g. self-unrefund) at all.
  perform set_config('request.jwt.claim.sub', '88888888-8888-8888-8888-888888888888', true);
  set local role authenticated;
  begin
    update public.purchases set refunded_at = null where id = '22222222-2222-2222-2222-222222222222';
    perform pg_temp.assert(false, 'part6a: authenticated must not be able to UPDATE purchases');
  exception when insufficient_privilege then
    null;
  end;
  reset role;
end $$;

do $$
begin
  -- anon cannot SELECT purchases at all -- no table grant, not merely
  -- an RLS mismatch.
  set local role anon;
  begin
    perform count(*) from public.purchases;
    perform pg_temp.assert(false, 'part6a: anon must not be able to SELECT purchases at all');
  exception when insufficient_privilege then
    null;
  end;
  reset role;
end $$;

-- --- Part 6b: bundle_checkout_snapshots functional access ---
do $$
declare
  n integer;
begin
  perform set_config('request.jwt.claim.sub', '77777777-7777-7777-7777-777777777777', true);
  set local role authenticated;
  select count(*) into n from public.bundle_checkout_snapshots where id = '33333333-3333-3333-3333-333333333333';
  reset role;
  perform pg_temp.assert(n = 1, 'part6b: author must be able to SELECT their own fulfilled snapshot');

  perform set_config('request.jwt.claim.sub', '88888888-8888-8888-8888-888888888888', true);
  set local role authenticated;
  select count(*) into n from public.bundle_checkout_snapshots where id = '33333333-3333-3333-3333-333333333333';
  reset role;
  perform pg_temp.assert(n = 1, 'part6b: reader must be able to SELECT their own fulfilled snapshot');

  -- A third, unrelated authenticated user still has the table grant but
  -- must match zero rows via RLS.
  perform set_config('request.jwt.claim.sub', '99999999-9999-9999-9999-999999999999', true);
  set local role authenticated;
  select count(*) into n from public.bundle_checkout_snapshots where id = '33333333-3333-3333-3333-333333333333';
  reset role;
  perform pg_temp.assert(n = 0, 'part6b: an unrelated user must see zero rows for someone else''s snapshot');
end $$;

do $$
begin
  set local role anon;
  begin
    perform count(*) from public.bundle_checkout_snapshots;
    perform pg_temp.assert(false, 'part6b: anon must not be able to SELECT bundle_checkout_snapshots at all');
  exception when insufficient_privilege then
    null;
  end;
  reset role;
end $$;

-- --- Part 6c: discount_codes functional CRUD ---
do $$
declare
  n integer;
begin
  perform set_config('request.jwt.claim.sub', '77777777-7777-7777-7777-777777777777', true);
  set local role authenticated;

  insert into public.discount_codes (id, author_id, book_id, code, percent_off)
  values ('44444444-4444-4444-4444-444444444444', '77777777-7777-7777-7777-777777777777',
    '11111111-2222-3333-4444-555555555555', 'P034TEST', 10);

  select count(*) into n from public.discount_codes where id = '44444444-4444-4444-4444-444444444444';
  perform pg_temp.assert(n = 1, 'part6c: author must be able to INSERT and then SELECT their own code');

  update public.discount_codes set active = false where id = '44444444-4444-4444-4444-444444444444';
  perform pg_temp.assert(
    (select active from public.discount_codes where id = '44444444-4444-4444-4444-444444444444') = false,
    'part6c: toggleDiscountCode''s exact `{ active }` payload must actually persist'
  );

  reset role;
end $$;

do $$
begin
  -- Column ACL blocks any other column, even for the code's own author.
  perform set_config('request.jwt.claim.sub', '77777777-7777-7777-7777-777777777777', true);
  set local role authenticated;
  begin
    update public.discount_codes set percent_off = 99 where id = '44444444-4444-4444-4444-444444444444';
    perform pg_temp.assert(false, 'part6c: author must not be able to UPDATE percent_off via raw API');
  exception when insufficient_privilege then
    null;
  end;
  reset role;
end $$;

do $$
declare
  n integer;
begin
  perform set_config('request.jwt.claim.sub', '77777777-7777-7777-7777-777777777777', true);
  set local role authenticated;
  delete from public.discount_codes where id = '44444444-4444-4444-4444-444444444444';
  select count(*) into n from public.discount_codes where id = '44444444-4444-4444-4444-444444444444';
  reset role;
  perform pg_temp.assert(n = 0, 'part6c: deleteDiscountCode must actually remove the author''s own code');
end $$;

do $$
begin
  set local role anon;
  begin
    perform count(*) from public.discount_codes;
    perform pg_temp.assert(false, 'part6c: anon must not be able to SELECT discount_codes at all');
  exception when insufficient_privilege then
    null;
  end;
  reset role;
end $$;

-- --- Part 6d: handle_new_user() functional signup behavior, unaffected
-- by the search_path/EXECUTE changes ---
insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-1111-1111-1111-111111111111', 'p034-signup-author@test', '{"role":"author","display_name":"Signup Author"}'),
  ('aaaaaaaa-2222-2222-2222-222222222222', 'p034-signup-reader@test', '{"role":"reader","display_name":"Signup Reader"}'),
  ('aaaaaaaa-3333-3333-3333-333333333333', 'p034-signup-crafted@test', '{"role":"admin","display_name":"Crafted"}'),
  ('aaaaaaaa-4444-4444-4444-444444444444', 'p034-signup-noname@test', '{}');

do $$
begin
  perform pg_temp.assert(
    (select role from public.profiles where id = 'aaaaaaaa-1111-1111-1111-111111111111') = 'author',
    'part6d: signup with role=author must produce an author profile'
  );
  perform pg_temp.assert(
    (select display_name from public.profiles where id = 'aaaaaaaa-1111-1111-1111-111111111111') = 'Signup Author',
    'part6d: signup must use the provided display_name'
  );
  perform pg_temp.assert(
    (select role from public.profiles where id = 'aaaaaaaa-2222-2222-2222-222222222222') = 'reader',
    'part6d: signup with role=reader must produce a reader profile'
  );
  perform pg_temp.assert(
    (select role from public.profiles where id = 'aaaaaaaa-3333-3333-3333-333333333333') = 'reader',
    'part6d: a crafted role=admin signup must still be whitelisted down to reader'
  );
  perform pg_temp.assert(
    (select display_name from public.profiles where id = 'aaaaaaaa-4444-4444-4444-444444444444') = 'p034-signup-noname',
    'part6d: signup with no display_name must fall back to the email local-part'
  );
end $$;

-- --- Part 6e: books author_id reassignment still blocked (implicit
-- USING-reuse before migration 034, now an explicit WITH CHECK -- same
-- observable behavior either way: the target row is matched by USING
-- (its CURRENT author_id is the caller's own), but the resulting NEW
-- row fails the check clause, which Postgres raises as a row-level
-- security violation, not a silent zero-row match). ---
do $$
begin
  perform set_config('request.jwt.claim.sub', '77777777-7777-7777-7777-777777777777', true);
  set local role authenticated;
  begin
    update public.books
    set author_id = '88888888-8888-8888-8888-888888888888'
    where id = '11111111-2222-3333-4444-555555555555'
      and author_id = '77777777-7777-7777-7777-777777777777';
    perform pg_temp.assert(false, 'part6e: reassigning a book''s author_id must be rejected');
  exception when insufficient_privilege then
    null;
  end;
  reset role;

  perform pg_temp.assert(
    (select author_id from public.books where id = '11111111-2222-3333-4444-555555555555') = '77777777-7777-7777-7777-777777777777',
    'part6e: the book must still belong to its original author'
  );
end $$;

select 'ALL PASSED: 034_harden_remaining_table_acls.test.sql' as result;

rollback;
