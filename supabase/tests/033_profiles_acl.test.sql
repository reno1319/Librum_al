-- Committed SQL regression suite for migration 033 (profiles ACL
-- hardening). LAUNCH-1 P1-5.
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql, the same stub
-- introduced for migration 032 -- no new test infrastructure needed.
-- Run manually against a disposable/local Postgres instance, AFTER
-- applying supabase/schema.sql and every migration through 033, from
-- the repo root:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/033_profiles_acl.test.sql
--
-- (schema.sql already includes migration 033's final state -- this
-- suite doesn't separately apply 033_harden_profiles_acl.sql on top of
-- an older schema.sql; add that step first if testing the migration
-- file in isolation against a pre-033 database.)
--
-- Everything below runs inside one transaction and is rolled back at
-- the end, so this file is fully repeatable with no manual cleanup
-- between runs -- except the ACL assertions in part 1, which read
-- committed privilege state (has_table_privilege/has_column_privilege
-- and information_schema read what schema.sql itself already
-- committed, never anything this test writes).

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
-- Part 1: table- and column-level ACL, exactly per the required final
-- privilege model.
-- ============================================================
do $$
begin
  -- anon: SELECT only. has_table_privilege('UPDATE'/'INSERT'/etc.)
  -- returns true if the role holds that privilege on ANY column, not
  -- just the whole table -- so this is a valid, sufficient check for
  -- anon specifically (it holds zero UPDATE grants anywhere, unlike
  -- authenticated, whose column-scoped UPDATE grant means the
  -- equivalent table-level check would trivially pass and prove
  -- nothing -- see the column-level checks below for authenticated).
  perform pg_temp.assert(has_table_privilege('anon', 'public.profiles', 'SELECT'),
    'part1: anon must have SELECT on profiles');
  perform pg_temp.assert(not has_table_privilege('anon', 'public.profiles', 'INSERT'),
    'part1: anon must not have INSERT on profiles');
  perform pg_temp.assert(not has_table_privilege('anon', 'public.profiles', 'UPDATE'),
    'part1: anon must not have UPDATE on profiles (any column)');
  perform pg_temp.assert(not has_table_privilege('anon', 'public.profiles', 'DELETE'),
    'part1: anon must not have DELETE on profiles');
  perform pg_temp.assert(not has_table_privilege('anon', 'public.profiles', 'TRUNCATE'),
    'part1: anon must not have TRUNCATE on profiles');
  perform pg_temp.assert(not has_table_privilege('anon', 'public.profiles', 'REFERENCES'),
    'part1: anon must not have REFERENCES on profiles');
  perform pg_temp.assert(not has_table_privilege('anon', 'public.profiles', 'TRIGGER'),
    'part1: anon must not have TRIGGER on profiles');

  -- authenticated: SELECT + UPDATE on exactly three columns; no other
  -- table-wide privilege.
  perform pg_temp.assert(has_table_privilege('authenticated', 'public.profiles', 'SELECT'),
    'part1: authenticated must have SELECT on profiles');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.profiles', 'INSERT'),
    'part1: authenticated must not have INSERT on profiles');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.profiles', 'DELETE'),
    'part1: authenticated must not have DELETE on profiles');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.profiles', 'TRUNCATE'),
    'part1: authenticated must not have TRUNCATE on profiles');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.profiles', 'REFERENCES'),
    'part1: authenticated must not have REFERENCES on profiles');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.profiles', 'TRIGGER'),
    'part1: authenticated must not have TRIGGER on profiles');

  -- authenticated's UPDATE, column by column: exactly display_name,
  -- bio, avatar_path -- everything else, explicitly false.
  perform pg_temp.assert(has_column_privilege('authenticated', 'public.profiles', 'display_name', 'UPDATE'),
    'part1: authenticated must have UPDATE on display_name');
  perform pg_temp.assert(has_column_privilege('authenticated', 'public.profiles', 'bio', 'UPDATE'),
    'part1: authenticated must have UPDATE on bio');
  perform pg_temp.assert(has_column_privilege('authenticated', 'public.profiles', 'avatar_path', 'UPDATE'),
    'part1: authenticated must have UPDATE on avatar_path');
  perform pg_temp.assert(not has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE'),
    'part1: authenticated must NOT have UPDATE on role');
  perform pg_temp.assert(not has_column_privilege('authenticated', 'public.profiles', 'id', 'UPDATE'),
    'part1: authenticated must NOT have UPDATE on id');
  perform pg_temp.assert(not has_column_privilege('authenticated', 'public.profiles', 'created_at', 'UPDATE'),
    'part1: authenticated must NOT have UPDATE on created_at');
  perform pg_temp.assert(not has_column_privilege('authenticated', 'public.profiles', 'stripe_account_id', 'UPDATE'),
    'part1: authenticated must NOT have UPDATE on stripe_account_id');
  perform pg_temp.assert(not has_column_privilege('authenticated', 'public.profiles', 'stripe_payouts_enabled', 'UPDATE'),
    'part1: authenticated must NOT have UPDATE on stripe_payouts_enabled');

  -- service_role: untouched -- still has everything (this stub grants
  -- service_role broad default privileges on every table it creates,
  -- mirroring real Supabase; see 00_stub_supabase_platform.sql).
  perform pg_temp.assert(has_table_privilege('service_role', 'public.profiles', 'UPDATE'),
    'part1: service_role must retain UPDATE on profiles');
  perform pg_temp.assert(has_column_privilege('service_role', 'public.profiles', 'role', 'UPDATE'),
    'part1: service_role must retain UPDATE on role specifically');
  perform pg_temp.assert(has_column_privilege('service_role', 'public.profiles', 'stripe_account_id', 'UPDATE'),
    'part1: service_role must retain UPDATE on stripe_account_id specifically');

  -- PUBLIC: nothing. has_table_privilege can't isolate PUBLIC's own
  -- grant in isolation (every role implicitly includes whatever PUBLIC
  -- holds), so this checks information_schema directly instead --
  -- exactly what the production verification query does.
  perform pg_temp.assert(
    not exists (
      select 1 from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'profiles' and grantee = 'PUBLIC'
    ),
    'part1: PUBLIC must have zero explicit grants on profiles'
  );
end $$;

-- ============================================================
-- Part 2: RLS policy definition -- both USING and WITH CHECK present
-- and identical, per migration 033's ALTER POLICY.
-- ============================================================
do $$
declare
  pol record;
begin
  select polname, pg_get_expr(polqual, polrelid) as qual, pg_get_expr(polwithcheck, polrelid) as with_check
  into pol
  from pg_policy
  where polrelid = 'public.profiles'::regclass
    and polname = 'Users can update their own profile';

  perform pg_temp.assert(pol.polname is not null, 'part2: the UPDATE policy must exist');
  perform pg_temp.assert(pol.qual = '(auth.uid() = id)', format('part2: unexpected USING clause: %s', pol.qual));
  perform pg_temp.assert(pol.with_check is not null, 'part2: WITH CHECK must not be null (must not silently fall back to USING)');
  perform pg_temp.assert(pol.with_check = '(auth.uid() = id)', format('part2: unexpected WITH CHECK clause: %s', pol.with_check));
end $$;

-- ============================================================
-- Part 3: end-to-end functional checks, not just static ACL/policy
-- introspection -- exercised as the roles/identities that actually
-- issue these queries in production.
-- ============================================================
insert into auth.users (id, email, raw_user_meta_data) values
  ('55555555-5555-5555-5555-555555555555', 'p033-owner@test', '{"role":"reader","display_name":"Owner"}'),
  ('66666666-6666-6666-6666-666666666666', 'p033-other@test', '{"role":"reader","display_name":"Other"}');

do $$
begin
  -- authenticated, acting as the row's own owner: the exact
  -- updateProfile() payload shape must succeed.
  perform set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true);
  set local role authenticated;
  update public.profiles
  set display_name = 'Updated Name', bio = 'Updated bio', avatar_path = '55555555-5555-5555-5555-555555555555/avatar.jpg'
  where id = '55555555-5555-5555-5555-555555555555';
  reset role;

  perform pg_temp.assert(
    (select display_name from public.profiles where id = '55555555-5555-5555-5555-555555555555') = 'Updated Name',
    'part3: the legitimate updateProfile() payload must actually persist'
  );
end $$;

do $$
declare
  rows_matched integer;
begin
  -- authenticated, acting as a DIFFERENT user than the row being
  -- targeted: RLS's USING clause must match zero rows (this is the
  -- existing, unchanged protection -- reconfirmed here rather than
  -- assumed, since WITH CHECK was just added alongside it).
  perform set_config('request.jwt.claim.sub', '66666666-6666-6666-6666-666666666666', true);
  set local role authenticated;
  update public.profiles
  set display_name = 'Hijacked'
  where id = '55555555-5555-5555-5555-555555555555';
  get diagnostics rows_matched = row_count;
  reset role;

  perform pg_temp.assert(rows_matched = 0, 'part3: updating another user''s row must match zero rows');
  perform pg_temp.assert(
    (select display_name from public.profiles where id = '55555555-5555-5555-5555-555555555555') <> 'Hijacked',
    'part3: another user''s attempted update must not have taken effect'
  );
end $$;

-- No behavioral test attempts to trigger the WITH CHECK policy directly
-- (as opposed to Part 2's direct pg_policy introspection of its
-- definition): Postgres RLS exempts the table owner by default unless
-- FORCE ROW LEVEL SECURITY is set (it isn't, here or anywhere else in
-- this schema), so running an id-changing UPDATE as the owner never
-- reaches the policy at all; running it as authenticated hits the
-- column-level ACL first (id was never granted), before RLS is even
-- evaluated -- there is no reachable path through which the WITH CHECK
-- clause's own contribution could be observed in isolation from either
-- of those other two layers. This is expected and fine: the WITH CHECK
-- is explicitly defense-in-depth (see migration 033's own comment), not
-- a currently load-bearing protection -- Part 2's direct check that the
-- policy's SQL definition actually contains it is the correct and
-- sufficient proof that it exists and is wired up correctly.

do $$
begin
  -- Public SELECT behavior unchanged for both anon and authenticated.
  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
  perform pg_temp.assert(
    (select count(*) from public.profiles where id = '55555555-5555-5555-5555-555555555555') = 1,
    'part3: anon must still be able to SELECT profiles (public readability unchanged)'
  );
  reset role;

  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.profiles where id = '55555555-5555-5555-5555-555555555555') = 1,
    'part3: authenticated must still be able to SELECT profiles'
  );
  reset role;
end $$;

do $$
begin
  -- anon cannot UPDATE at all -- ACL blocks it before RLS is even
  -- reached (insufficient_privilege, not a zero-row match).
  set local role anon;
  begin
    update public.profiles set display_name = 'anon-write' where id = '55555555-5555-5555-5555-555555555555';
    perform pg_temp.assert(false, 'part3: anon must not be able to UPDATE profiles at all');
  exception when insufficient_privilege then
    null;
  end;
  reset role;
end $$;

delete from public.profiles where id in
  ('55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666');

select 'ALL PASSED: 033_profiles_acl.test.sql' as result;

rollback;
