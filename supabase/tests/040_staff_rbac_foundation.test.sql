-- Committed SQL regression suite for migration 040 (ADMIN-1A: staff/RBAC
-- foundation).
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql -- no new test
-- infrastructure needed, same as every other suite in this directory.
-- Run manually against a disposable/local Postgres instance, AFTER
-- applying supabase/schema.sql, from the repo root:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/040_staff_rbac_foundation.test.sql
--
-- (schema.sql already includes migration 040's final state -- this suite
-- doesn't separately apply 040_staff_rbac_foundation.sql on top of an
-- older schema.sql.)
--
-- This file was written and reviewed as part of ADMIN-1A's implementation
-- but has NOT been executed in this environment -- no local/CI Postgres
-- was available. It is a reviewed contract, not a confirmed-passing
-- result; run it before this migration is ever applied anywhere real.
--
-- IMPORTANT LIMITATION, discovered the hard way (production apply
-- failure, corrected in this migration file): everything below runs
-- against schema.sql's already-fully-applied END STATE, exactly like
-- every other suite in this directory. This can only prove the final
-- database is internally consistent -- it CANNOT prove that
-- 040_staff_rbac_foundation.sql's own internal statement ORDER is safe
-- to apply standalone (via `supabase db push`), because schema.sql is a
-- separately-maintained, hand-verified consolidated file, not a replay
-- of the migration files in sequence. That is exactly how the original
-- version of this migration passed a review of schema.sql's ordering
-- while still containing a real ordering bug in the standalone migration
-- file itself (a CREATE POLICY referencing staff_has_permission() before
-- that function was defined -- see this migration file's own header
-- comment for the full incident). The only test that actually exercises
-- 040_staff_rbac_foundation.sql's own statement order is applying it
-- standalone, in isolation, against a pre-040 baseline:
--
--   createdb librum_test_040
--   psql -d librum_test_040 -f supabase/tests/00_stub_supabase_platform.sql
--   <apply migrations 002 through 039, or an equivalent pre-040 schema>
--   psql -d librum_test_040 -v ON_ERROR_STOP=1 -f supabase/migrations/040_staff_rbac_foundation.sql
--
-- Run that standalone-replay command -- not just this file -- before
-- 040_staff_rbac_foundation.sql is ever applied to production again.
--
-- Everything below runs inside one transaction and is rolled back at the
-- end, so this file is fully repeatable with no manual cleanup between
-- runs.

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
-- Part 0: completeness check on staff_has_permission()-gated policies --
-- not a proof of statement ORDER (see the limitation documented in this
-- file's own header above), but a real, executable guard against a
-- different regression: a future edit accidentally dropping or
-- misnaming one of these policies without dropping its reference to
-- staff_has_permission(), or referencing it via a different, unreviewed
-- expression shape. Enumerates every policy across the four
-- staff_has_permission()-gated tables whose USING clause mentions the
-- function by name, and asserts the count is exactly the four this
-- migration is known to create (staff_members.staff.view,
-- book_reports.reports.view, refund_requests.refunds.view,
-- refund_request_items.refunds.view) -- Part 1/6/7 below each already
-- check one of these individually; this is the cross-cutting total.
-- ============================================================
do $$
declare
  gated_policy_count integer;
begin
  select count(*) into gated_policy_count
  from pg_policy
  where polrelid = any(array[
    'public.staff_members'::regclass,
    'public.book_reports'::regclass,
    'public.refund_requests'::regclass,
    'public.refund_request_items'::regclass
  ])
  and pg_get_expr(polqual, polrelid) like '%staff_has_permission%';

  perform pg_temp.assert(
    gated_policy_count = 4,
    format(
      'part0: expected exactly 4 staff_has_permission()-gated policies across staff_members/book_reports/refund_requests/refund_request_items, found %s',
      gated_policy_count
    )
  );
end $$;

-- ============================================================
-- Part 1: staff_members RLS policy definition -- exactly the two SELECT
-- policies the design brief calls for (self-view, staff.view-gated
-- view-all), and zero insert/update/delete policies for any role.
-- ============================================================
do $$
declare
  self_pol record;
  view_all_pol record;
  total_policy_count integer;
begin
  select polname, pg_get_expr(polqual, polrelid) as qual
  into self_pol
  from pg_policy
  where polrelid = 'public.staff_members'::regclass
    and polname = 'Staff can view their own staff_members row';

  perform pg_temp.assert(self_pol.polname is not null, 'part1: self-view policy must exist');
  perform pg_temp.assert(
    self_pol.qual = '(auth.uid() = user_id)',
    format('part1: unexpected self-view USING clause: %s', self_pol.qual)
  );

  select polname, pg_get_expr(polqual, polrelid) as qual
  into view_all_pol
  from pg_policy
  where polrelid = 'public.staff_members'::regclass
    and polname = 'Staff with staff.view can view all staff_members rows';

  perform pg_temp.assert(view_all_pol.polname is not null, 'part1: staff.view-gated view-all policy must exist');
  perform pg_temp.assert(
    view_all_pol.qual = 'staff_has_permission(''staff.view''::text)',
    format('part1: unexpected view-all USING clause: %s', view_all_pol.qual)
  );

  select count(*) into total_policy_count
  from pg_policy
  where polrelid = 'public.staff_members'::regclass;

  perform pg_temp.assert(
    total_policy_count = 2,
    format('part1: expected exactly two policies on staff_members (both SELECT), found %s', total_policy_count)
  );

  perform pg_temp.assert(
    not exists (
      select 1 from pg_policy
      where polrelid = 'public.staff_members'::regclass
        and polcmd in ('a', 'w', 'd') -- INSERT, UPDATE, DELETE
    ),
    'part1: staff_members must have zero insert/update/delete policies -- self-promotion must be structurally impossible'
  );
end $$;

-- Table-level ACL: no INSERT/UPDATE/DELETE grant to anon or authenticated
-- -- the second, independent half of "self-promotion impossible" (a
-- policy alone isn't enough; see the profiles/refund_requests precedent
-- this schema already established for why both layers are checked).
do $$
begin
  perform pg_temp.assert(
    has_table_privilege('authenticated', 'public.staff_members', 'SELECT'),
    'part1: authenticated must have table-level SELECT on staff_members'
  );
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.staff_members', 'INSERT'),
    'part1: authenticated must NOT have table-level INSERT on staff_members'
  );
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.staff_members', 'UPDATE'),
    'part1: authenticated must NOT have table-level UPDATE on staff_members'
  );
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.staff_members', 'DELETE'),
    'part1: authenticated must NOT have table-level DELETE on staff_members'
  );
  perform pg_temp.assert(
    not has_table_privilege('anon', 'public.staff_members', 'SELECT'),
    'part1: anon must have zero privileges on staff_members'
  );
end $$;

-- ============================================================
-- Part 1b: static SECURITY DEFINER hardening on staff_has_permission()
-- itself -- same technique 039's own Part 1b established for
-- review_book_report().
-- ============================================================
do $$
declare
  func record;
begin
  select p.prosecdef, p.proconfig
  into func
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'staff_has_permission'
    and pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_permission text';

  perform pg_temp.assert(func.prosecdef is not null, 'part1b: staff_has_permission(text) must exist');
  perform pg_temp.assert(func.prosecdef = true, 'part1b: staff_has_permission must be SECURITY DEFINER');
  perform pg_temp.assert(
    exists (select 1 from unnest(coalesce(func.proconfig, '{}'::text[])) c where c = 'search_path='),
    'part1b: staff_has_permission must SET search_path = '''' (empty)'
  );

  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.staff_has_permission(text)', 'EXECUTE'),
    'part1b: authenticated must have EXECUTE on staff_has_permission'
  );
  perform pg_temp.assert(
    not has_function_privilege('anon', 'public.staff_has_permission(text)', 'EXECUTE'),
    'part1b: anon must NOT have EXECUTE on staff_has_permission'
  );
  perform pg_temp.assert(
    not exists (
      select 1 from information_schema.role_routine_grants
      where routine_schema = 'public'
        and routine_name = 'staff_has_permission'
        and grantee = 'PUBLIC'
    ),
    'part1b: PUBLIC must have zero explicit EXECUTE grant on staff_has_permission'
  );
end $$;

-- ============================================================
-- Part 2: staff_has_permission() full role x permission matrix -- the
-- actual safeguard against this SQL-side copy of the role->permission
-- matrix silently drifting from the canonical TypeScript copy in
-- src/lib/staff-permissions.ts. One fixture profile per role, one
-- assertion per (role, permission) cell -- 5 roles x 7 permissions = 35
-- assertions, mirroring src/lib/staff-permissions.test.ts's own
-- exhaustive coverage exactly.
-- ============================================================
insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-0000-0000-000000000001', 'p040-owner@test', '{"role":"reader","display_name":"Owner"}'),
  ('a0000000-0000-0000-0000-000000000002', 'p040-admin@test', '{"role":"reader","display_name":"Admin"}'),
  ('a0000000-0000-0000-0000-000000000003', 'p040-editor@test', '{"role":"reader","display_name":"Editor"}'),
  ('a0000000-0000-0000-0000-000000000004', 'p040-moderator@test', '{"role":"reader","display_name":"Moderator"}'),
  ('a0000000-0000-0000-0000-000000000005', 'p040-support@test', '{"role":"reader","display_name":"Support"}'),
  ('a0000000-0000-0000-0000-000000000006', 'p040-nonstaff@test', '{"role":"reader","display_name":"Non-staff"}');

insert into public.staff_members (user_id, role) values
  ('a0000000-0000-0000-0000-000000000001', 'owner'),
  ('a0000000-0000-0000-0000-000000000002', 'admin'),
  ('a0000000-0000-0000-0000-000000000003', 'editor'),
  ('a0000000-0000-0000-0000-000000000004', 'moderator'),
  ('a0000000-0000-0000-0000-000000000005', 'support');

do $$
declare
  matrix jsonb := '{
    "a0000000-0000-0000-0000-000000000001": {
      "admin.access": true, "reports.view": true, "reports.resolve": true,
      "refunds.view": true, "refunds.resolve": true, "staff.view": true, "staff.manage": true
    },
    "a0000000-0000-0000-0000-000000000002": {
      "admin.access": true, "reports.view": true, "reports.resolve": true,
      "refunds.view": true, "refunds.resolve": true, "staff.view": true, "staff.manage": false
    },
    "a0000000-0000-0000-0000-000000000003": {
      "admin.access": false, "reports.view": false, "reports.resolve": false,
      "refunds.view": false, "refunds.resolve": false, "staff.view": false, "staff.manage": false
    },
    "a0000000-0000-0000-0000-000000000004": {
      "admin.access": true, "reports.view": true, "reports.resolve": true,
      "refunds.view": false, "refunds.resolve": false, "staff.view": false, "staff.manage": false
    },
    "a0000000-0000-0000-0000-000000000005": {
      "admin.access": true, "reports.view": false, "reports.resolve": false,
      "refunds.view": true, "refunds.resolve": false, "staff.view": false, "staff.manage": false
    }
  }'::jsonb;
  uid text;
  perm text;
  expected boolean;
  actual boolean;
begin
  for uid in select jsonb_object_keys(matrix) loop
    perform set_config('request.jwt.claim.sub', uid, true);
    set local role authenticated;
    for perm in select jsonb_object_keys(matrix -> uid) loop
      expected := (matrix -> uid ->> perm)::boolean;
      select public.staff_has_permission(perm) into actual;
      perform pg_temp.assert(
        actual = expected,
        format('part2: staff_has_permission(%L) for user %s expected %s, got %s', perm, uid, expected, actual)
      );
    end loop;
    reset role;
  end loop;
end $$;

-- Non-staff and anon: staff_has_permission() must return false for
-- every permission, never null/error.
do $$
begin
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000006', true);
  set local role authenticated;
  perform pg_temp.assert(
    public.staff_has_permission('admin.access') = false,
    'part2: a non-staff authenticated user must get false, not null/error'
  );
  reset role;

  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
  perform pg_temp.assert(
    coalesce(public.staff_has_permission('admin.access'), false) = false,
    'part2: anon must get false (or a denied call), never true'
  );
  reset role;
end $$;

-- ============================================================
-- Part 3: staff_members RLS end-to-end.
-- ============================================================
do $$
begin
  -- Owner (has staff.view) sees every row, including others'.
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.staff_members) = 5,
    'part3: a staff.view holder (owner) must see every staff_members row'
  );
  reset role;

  -- Moderator (lacks staff.view) sees only their own row.
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000004', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.staff_members) = 1,
    'part3: a non-staff.view staff member must see only their own row via the self-view policy'
  );
  perform pg_temp.assert(
    (select user_id from public.staff_members limit 1) = 'a0000000-0000-0000-0000-000000000004',
    'part3: the one visible row must be the caller''s own'
  );
  reset role;

  -- Ordinary non-staff authenticated user: sees nothing.
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000006', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.staff_members) = 0,
    'part3: a non-staff authenticated user must see zero staff_members rows'
  );
  reset role;

  -- anon: sees nothing.
  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
  perform pg_temp.assert(
    (select count(*) from public.staff_members) = 0,
    'part3: anon must see zero staff_members rows'
  );
  reset role;
end $$;

-- ============================================================
-- Part 4: self-promotion impossible -- a raw INSERT/UPDATE/DELETE from
-- authenticated, even by a staff member attempting to modify their OWN
-- row or grant themselves a new one, must be rejected. No policy exists
-- for any of these commands (Part 1 already proved that statically);
-- this proves it behaviorally too.
-- ============================================================
do $$
begin
  -- A non-staff user attempting to insert themselves directly as 'owner'.
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000006', true);
  set local role authenticated;
  begin
    insert into public.staff_members (user_id, role)
    values ('a0000000-0000-0000-0000-000000000006', 'owner');
    perform pg_temp.assert(false, 'part4: a raw authenticated INSERT into staff_members must be rejected');
  exception when insufficient_privilege then
    null; -- expected: no table-level INSERT grant
  end;
  reset role;

  perform pg_temp.assert(
    not exists (
      select 1 from public.staff_members where user_id = 'a0000000-0000-0000-0000-000000000006'
    ),
    'part4: the rejected self-promotion attempt must not have created a row'
  );

  -- An existing 'moderator' attempting to UPDATE their own row to 'owner'.
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000004', true);
  set local role authenticated;
  begin
    update public.staff_members set role = 'owner'
    where user_id = 'a0000000-0000-0000-0000-000000000004';
    perform pg_temp.assert(false, 'part4: a raw authenticated UPDATE on staff_members must be rejected');
  exception when insufficient_privilege then
    null; -- expected: no table-level UPDATE grant
  end;
  reset role;

  perform pg_temp.assert(
    (select role from public.staff_members where user_id = 'a0000000-0000-0000-0000-000000000004') = 'moderator',
    'part4: the rejected self-escalation attempt must not have changed the row'
  );
end $$;

delete from public.staff_members where user_id in (
  'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002',
  'a0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000004',
  'a0000000-0000-0000-0000-000000000005'
);
delete from public.profiles where id in (
  'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002',
  'a0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000004',
  'a0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000006'
);

-- ============================================================
-- Part 5: owner-bootstrap backfill semantics. schema.sql's own backfill
-- INSERT only runs once, at schema-creation time, so it cannot be
-- re-observed against fixtures created after the fact -- this
-- re-executes the exact same statement shape the migration/schema.sql
-- uses, against a fresh fixture, to verify its actual logic: 'admin' ->
-- 'owner' (not 'admin'), created_by left null, and idempotent under
-- ON CONFLICT DO NOTHING. A non-admin profile must never be backfilled.
-- ============================================================
insert into auth.users (id, email, raw_user_meta_data) values
  ('b0000000-0000-0000-0000-000000000001', 'p040-legacyadmin@test', '{"role":"reader","display_name":"Legacy Admin"}'),
  ('b0000000-0000-0000-0000-000000000002', 'p040-legacyreader@test', '{"role":"reader","display_name":"Legacy Reader"}');

update public.profiles set role = 'admin' where id = 'b0000000-0000-0000-0000-000000000001';

insert into public.staff_members (user_id, role, created_by)
select id, 'owner', null
from public.profiles
where role = 'admin'
  and id = 'b0000000-0000-0000-0000-000000000001' -- scoped to this test's own fixture only
on conflict (user_id) do nothing;

do $$
begin
  perform pg_temp.assert(
    (select role from public.staff_members where user_id = 'b0000000-0000-0000-0000-000000000001') = 'owner',
    'part5: a legacy profiles.role = ''admin'' row must be backfilled as ''owner'', not ''admin'''
  );
  perform pg_temp.assert(
    (select created_by from public.staff_members where user_id = 'b0000000-0000-0000-0000-000000000001') is null,
    'part5: backfilled rows must have created_by = null (inherited from legacy state, not granted by a peer)'
  );
  perform pg_temp.assert(
    not exists (
      select 1 from public.staff_members where user_id = 'b0000000-0000-0000-0000-000000000002'
    ),
    'part5: a non-admin legacy profile must never be backfilled into staff_members'
  );
end $$;

-- Re-running the same backfill statement must be a no-op (idempotent),
-- never overwrite an existing row -- proves ON CONFLICT DO NOTHING
-- actually holds even if this statement were ever accidentally re-run.
update public.staff_members set role = 'admin' where user_id = 'b0000000-0000-0000-0000-000000000001';
insert into public.staff_members (user_id, role, created_by)
select id, 'owner', null
from public.profiles
where role = 'admin'
  and id = 'b0000000-0000-0000-0000-000000000001'
on conflict (user_id) do nothing;

do $$
begin
  perform pg_temp.assert(
    (select role from public.staff_members where user_id = 'b0000000-0000-0000-0000-000000000001') = 'admin',
    'part5: ON CONFLICT DO NOTHING must never overwrite an existing staff_members row''s role'
  );
end $$;

delete from public.staff_members where user_id = 'b0000000-0000-0000-0000-000000000001';
delete from public.profiles where id in (
  'b0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002'
);

-- ============================================================
-- Part 6: book_reports policy migration -- new policy name/qual, old
-- policy gone, end-to-end visibility by permission, not role name.
-- ============================================================
do $$
declare
  pol record;
begin
  perform pg_temp.assert(
    not exists (
      select 1 from pg_policy
      where polrelid = 'public.book_reports'::regclass
        and polname = 'Admins can view all book reports'
    ),
    'part6: the old is_admin()-based policy must no longer exist'
  );

  select polname, pg_get_expr(polqual, polrelid) as qual
  into pol
  from pg_policy
  where polrelid = 'public.book_reports'::regclass
    and polname = 'Staff with reports.view can view all book reports';

  perform pg_temp.assert(pol.polname is not null, 'part6: the new reports.view-gated policy must exist');
  perform pg_temp.assert(
    pol.qual = 'staff_has_permission(''reports.view''::text)',
    format('part6: unexpected USING clause: %s', pol.qual)
  );
end $$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('c0000000-0000-0000-0000-000000000001', 'p040-moderator2@test', '{"role":"reader","display_name":"Moderator"}'),
  ('c0000000-0000-0000-0000-000000000002', 'p040-support2@test', '{"role":"reader","display_name":"Support"}'),
  ('c0000000-0000-0000-0000-000000000003', 'p040-reporter@test', '{"role":"reader","display_name":"Reporter"}'),
  ('c0000000-0000-0000-0000-000000000004', 'p040-bookauthor@test', '{"role":"author","display_name":"Author"}');

insert into public.staff_members (user_id, role) values
  ('c0000000-0000-0000-0000-000000000001', 'moderator'),
  ('c0000000-0000-0000-0000-000000000002', 'support');

insert into public.books (id, author_id, title, description, preview_text, keywords, status) values
  ('c0000000-0000-0000-0000-0000000000b1', 'c0000000-0000-0000-0000-000000000004',
   'Test Book (040)', '', '', '', 'published');

insert into public.book_reports (id, book_id, reporter_id, reason) values
  ('c0000000-0000-0000-0000-0000000000b2', 'c0000000-0000-0000-0000-0000000000b1',
   'c0000000-0000-0000-0000-000000000003', 'Spam or misleading listing');

do $$
begin
  -- moderator (reports.view): sees it.
  perform set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.book_reports where id = 'c0000000-0000-0000-0000-0000000000b2') = 1,
    'part6: a moderator (reports.view) must be able to SELECT any book report'
  );
  reset role;

  -- support (no reports.view): does not.
  perform set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.book_reports where id = 'c0000000-0000-0000-0000-0000000000b2') = 0,
    'part6: support (no reports.view) must NOT be able to SELECT a book report'
  );
  reset role;
end $$;

-- review_book_report(): moderator (reports.resolve) succeeds; support
-- (no reports.resolve) is rejected with 'not authorized', same message
-- is_admin()-based rejection used, unchanged by this migration.
do $$
begin
  perform set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  begin
    perform public.review_book_report('c0000000-0000-0000-0000-0000000000b2', 'resolved', null);
    perform pg_temp.assert(false, 'part6: support (no reports.resolve) must not be able to review a report');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part6: unexpected message: %s', sqlerrm));
  end;
  reset role;

  perform set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  perform public.review_book_report('c0000000-0000-0000-0000-0000000000b2', 'resolved', null);
  reset role;

  perform pg_temp.assert(
    (select status from public.book_reports where id = 'c0000000-0000-0000-0000-0000000000b2') = 'resolved',
    'part6: a moderator (reports.resolve) must be able to resolve a report'
  );
  perform pg_temp.assert(
    (select reviewed_by from public.book_reports where id = 'c0000000-0000-0000-0000-0000000000b2')
      = 'c0000000-0000-0000-0000-000000000001',
    'part6: reviewed_by must equal the acting moderator''s own auth.uid()'
  );
end $$;

delete from public.book_reports where id = 'c0000000-0000-0000-0000-0000000000b2';
delete from public.books where id = 'c0000000-0000-0000-0000-0000000000b1';
delete from public.staff_members where user_id in (
  'c0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002'
);
delete from public.profiles where id in (
  'c0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002',
  'c0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000004'
);

-- ============================================================
-- Part 7: refund_requests / refund_request_items policy migration --
-- same treatment as Part 6, for refunds.view/refunds.resolve.
-- ============================================================
do $$
declare
  pol record;
begin
  perform pg_temp.assert(
    not exists (
      select 1 from pg_policy
      where polrelid = 'public.refund_requests'::regclass
        and polname = 'Admins can view all refund requests'
    ),
    'part7: the old is_admin()-based refund_requests policy must no longer exist'
  );
  perform pg_temp.assert(
    not exists (
      select 1 from pg_policy
      where polrelid = 'public.refund_request_items'::regclass
        and polname = 'Admins can view all refund request items'
    ),
    'part7: the old is_admin()-based refund_request_items policy must no longer exist'
  );

  select polname, pg_get_expr(polqual, polrelid) as qual
  into pol
  from pg_policy
  where polrelid = 'public.refund_requests'::regclass
    and polname = 'Staff with refunds.view can view all refund requests';
  perform pg_temp.assert(pol.polname is not null, 'part7: the new refunds.view-gated refund_requests policy must exist');
  perform pg_temp.assert(
    pol.qual = 'staff_has_permission(''refunds.view''::text)',
    format('part7: unexpected refund_requests USING clause: %s', pol.qual)
  );
end $$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('d0000000-0000-0000-0000-000000000001', 'p040-admin3@test', '{"role":"reader","display_name":"Admin"}'),
  ('d0000000-0000-0000-0000-000000000002', 'p040-moderator3@test', '{"role":"reader","display_name":"Moderator"}'),
  ('d0000000-0000-0000-0000-000000000003', 'p040-reader@test', '{"role":"reader","display_name":"Reader"}'),
  ('d0000000-0000-0000-0000-000000000004', 'p040-bookauthor2@test', '{"role":"author","display_name":"Author"}');

insert into public.staff_members (user_id, role) values
  ('d0000000-0000-0000-0000-000000000001', 'admin'),
  ('d0000000-0000-0000-0000-000000000002', 'moderator');

insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('d0000000-0000-0000-0000-00000000000b', 'd0000000-0000-0000-0000-000000000004',
   'Test Book (040 refunds)', '', '', '', 999, 'published');

insert into public.purchases (id, book_id, reader_id, amount_cents, stripe_payment_intent_id, created_at) values
  ('d0000000-0000-0000-0000-00000000000c', 'd0000000-0000-0000-0000-00000000000b',
   'd0000000-0000-0000-0000-000000000003', 999, 'pi_040_test', now());

insert into public.refund_requests (id, reader_id, stripe_payment_intent_id, amount_cents, status) values
  ('d0000000-0000-0000-0000-00000000000d', 'd0000000-0000-0000-0000-000000000003', 'pi_040_test', 999, 'requested');

do $$
begin
  -- admin (refunds.view): sees it.
  perform set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.refund_requests where id = 'd0000000-0000-0000-0000-00000000000d') = 1,
    'part7: an admin (refunds.view) must be able to SELECT any refund request'
  );
  reset role;

  -- moderator (no refunds.view): does not.
  perform set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.refund_requests where id = 'd0000000-0000-0000-0000-00000000000d') = 0,
    'part7: a moderator (no refunds.view) must NOT be able to SELECT a refund request'
  );
  reset role;
end $$;

-- review_refund_request(): admin (refunds.resolve) succeeds; moderator
-- (no refunds.resolve) is rejected with 'not authorized'.
do $$
begin
  perform set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  begin
    perform public.review_refund_request('d0000000-0000-0000-0000-00000000000d', 'approved', null);
    perform pg_temp.assert(false, 'part7: a moderator (no refunds.resolve) must not be able to review a refund request');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part7: unexpected message: %s', sqlerrm));
  end;
  reset role;

  perform set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  perform public.review_refund_request('d0000000-0000-0000-0000-00000000000d', 'approved', null);
  reset role;

  perform pg_temp.assert(
    (select status from public.refund_requests where id = 'd0000000-0000-0000-0000-00000000000d') = 'approved',
    'part7: an admin (refunds.resolve) must be able to approve a refund request'
  );
end $$;

delete from public.refund_requests where id = 'd0000000-0000-0000-0000-00000000000d';
delete from public.purchases where id = 'd0000000-0000-0000-0000-00000000000c';
delete from public.books where id = 'd0000000-0000-0000-0000-00000000000b';
delete from public.staff_members where user_id in (
  'd0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002'
);
delete from public.profiles where id in (
  'd0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002',
  'd0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000004'
);

select 'ALL PASSED: 040_staff_rbac_foundation.test.sql' as result;

rollback;
