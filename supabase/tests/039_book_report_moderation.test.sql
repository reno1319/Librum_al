-- Committed SQL regression suite for migration 039 (LAUNCH-FIX-1B
-- MOD-1: minimum book-report moderation queue).
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql -- no new test
-- infrastructure needed, same as every other suite in this directory.
-- Run manually against a disposable/local Postgres instance, AFTER
-- applying supabase/schema.sql, from the repo root:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/039_book_report_moderation.test.sql
--
-- (schema.sql already includes migration 039's final state -- this
-- suite doesn't separately apply 039_book_report_moderation.sql on top
-- of an older schema.sql.)
--
-- This file was written and reviewed as part of MOD-1's implementation
-- but has NOT been executed in this environment -- no local/CI Postgres
-- was available. It is a reviewed contract, not a confirmed-passing
-- result; run it before this migration is ever applied anywhere real.
--
-- Everything below runs inside one transaction and is rolled back at
-- the end, so this file is fully repeatable with no manual cleanup
-- between runs.

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
-- Part 1: RLS policy definition -- exactly one admin-only SELECT
-- policy exists on book_reports, referencing is_admin(). No ordinary-
-- authenticated (reporter or otherwise) SELECT policy exists -- MOD-1's
-- brief explicitly requires reports stay invisible to anonymous users,
-- ordinary readers, and the reported book's own author.
-- ============================================================
do $$
declare
  pol record;
  select_policy_count integer;
begin
  select polname, pg_get_expr(polqual, polrelid) as qual
  into pol
  from pg_policy
  where polrelid = 'public.book_reports'::regclass
    and polname = 'Admins can view all book reports';

  perform pg_temp.assert(pol.polname is not null, 'part1: the admin SELECT policy must exist');
  perform pg_temp.assert(
    pol.qual = 'public.is_admin()',
    format('part1: unexpected USING clause: %s', pol.qual)
  );

  select count(*) into select_policy_count
  from pg_policy
  where polrelid = 'public.book_reports'::regclass
    and polcmd = 'r'; -- SELECT

  perform pg_temp.assert(
    select_policy_count = 1,
    format('part1: expected exactly one SELECT policy on book_reports, found %s', select_policy_count)
  );
end $$;

-- ============================================================
-- Part 1b: static SECURITY DEFINER hardening on review_book_report()
-- itself -- prosecdef/proconfig/EXECUTE ACL introspection, the same
-- kind of static contract Part 1 above already applies to the RLS
-- policy, and the same technique 033_profiles_acl.test.sql already
-- uses for table-level ACL (has_table_privilege/has_column_privilege)
-- -- has_function_privilege is that same family's function-level
-- equivalent. Added specifically because a PRE-COMMIT DATABASE
-- SECURITY CHECK asked this file to statically contract security mode,
-- search_path, and EXECUTE ACL, not just the function's functional
-- behavior (which Part 3 below already covers).
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
    and p.proname = 'review_book_report'
    and pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_id uuid, p_decision text, p_admin_notes text';

  perform pg_temp.assert(func.prosecdef is not null, 'part1b: review_book_report(uuid, text, text) must exist');
  perform pg_temp.assert(func.prosecdef = true, 'part1b: review_book_report must be SECURITY DEFINER');
  perform pg_temp.assert(
    exists (select 1 from unnest(coalesce(func.proconfig, '{}'::text[])) c where c = 'search_path='),
    'part1b: review_book_report must SET search_path = '''' (empty), matching is_admin()/review_refund_request()'
  );

  -- EXECUTE ACL: matches review_refund_request()'s own hardened
  -- pattern exactly -- revoked from PUBLIC/anon/authenticated, then
  -- re-granted only to authenticated. This is the SECURITY DEFINER-
  -- specific defense-in-depth the PRE-COMMIT check asked to confirm:
  -- the internal is_admin() recheck is the real authority, but the
  -- EXECUTE grant itself is independently narrowed too, so an anon
  -- caller is rejected at the privilege layer before ever reaching
  -- that internal check.
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.review_book_report(uuid, text, text)', 'EXECUTE'),
    'part1b: authenticated must have EXECUTE on review_book_report'
  );
  perform pg_temp.assert(
    not has_function_privilege('anon', 'public.review_book_report(uuid, text, text)', 'EXECUTE'),
    'part1b: anon must NOT have EXECUTE on review_book_report'
  );
  perform pg_temp.assert(
    not exists (
      select 1 from information_schema.role_routine_grants
      where routine_schema = 'public'
        and routine_name = 'review_book_report'
        and grantee = 'PUBLIC'
    ),
    'part1b: PUBLIC must have zero explicit EXECUTE grant on review_book_report'
  );
end $$;

-- ============================================================
-- Part 2: end-to-end RLS visibility, exercised as the roles/identities
-- that actually issue these queries in production.
-- ============================================================
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'p039-admin@test', '{"role":"reader","display_name":"Admin"}'),
  ('22222222-2222-2222-2222-222222222222', 'p039-reporter@test', '{"role":"reader","display_name":"Reporter"}'),
  ('33333333-3333-3333-3333-333333333333', 'p039-author@test', '{"role":"author","display_name":"Author"}');

-- Promoted directly, the only legitimate way (see migration 028) --
-- mirrors how every other admin-focused test in this directory
-- establishes an admin fixture.
update public.profiles set role = 'admin' where id = '11111111-1111-1111-1111-111111111111';

insert into public.books (id, author_id, title, description, preview_text, keywords, status) values
  ('44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333',
   'Test Book', '', '', '', 'published');

insert into public.book_reports (id, book_id, reporter_id, reason) values
  ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444444',
   '22222222-2222-2222-2222-222222222222', 'Spam or misleading listing');

do $$
begin
  -- Admin: sees the report.
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.book_reports where id = '55555555-5555-5555-5555-555555555555') = 1,
    'part2: an admin must be able to SELECT any book report'
  );
  reset role;

  -- The reporter themself: does NOT see it back (no reader-facing
  -- SELECT policy exists -- write-only from a reader's perspective,
  -- unchanged by MOD-1).
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.book_reports where id = '55555555-5555-5555-5555-555555555555') = 0,
    'part2: the reporter must NOT be able to SELECT their own submitted report'
  );
  reset role;

  -- The reported book's own author: does NOT see it either.
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.book_reports where id = '55555555-5555-5555-5555-555555555555') = 0,
    'part2: the reported book''s own author must NOT be able to SELECT the report'
  );
  reset role;

  -- anon: does NOT see it.
  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
  perform pg_temp.assert(
    (select count(*) from public.book_reports where id = '55555555-5555-5555-5555-555555555555') = 0,
    'part2: anon must NOT be able to SELECT any book report'
  );
  reset role;
end $$;

-- ============================================================
-- Part 3: review_book_report() RPC -- identity derivation, decision
-- validation, and race-safe status transition.
-- ============================================================

do $$
begin
  -- Unauthenticated (no jwt claim at all): 'not authenticated'.
  perform set_config('request.jwt.claim.sub', '', true);
  set local role authenticated;
  begin
    perform public.review_book_report('55555555-5555-5555-5555-555555555555', 'resolved', null);
    perform pg_temp.assert(false, 'part3: unauthenticated call must raise an exception');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authenticated', format('part3: unexpected message: %s', sqlerrm));
  end;
  reset role;
end $$;

do $$
begin
  -- Authenticated but not an admin (the reporter themself): 'not authorized'.
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  set local role authenticated;
  begin
    perform public.review_book_report('55555555-5555-5555-5555-555555555555', 'resolved', null);
    perform pg_temp.assert(false, 'part3: non-admin call must raise an exception');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part3: unexpected message: %s', sqlerrm));
  end;
  reset role;
end $$;

do $$
begin
  -- Admin, invalid decision value: rejected before any write.
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  begin
    perform public.review_book_report('55555555-5555-5555-5555-555555555555', 'banned', null);
    perform pg_temp.assert(false, 'part3: an invalid decision must raise an exception');
  exception when others then
    perform pg_temp.assert(
      sqlerrm = 'p_decision must be ''resolved'' or ''dismissed''',
      format('part3: unexpected message: %s', sqlerrm)
    );
  end;
  reset role;

  perform pg_temp.assert(
    (select status from public.book_reports where id = '55555555-5555-5555-5555-555555555555') = 'open',
    'part3: an invalid-decision attempt must not have changed the report''s status'
  );
end $$;

do $$
begin
  -- Admin, notes over the 2000-character cap: rejected before any write.
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  begin
    perform public.review_book_report(
      '55555555-5555-5555-5555-555555555555', 'resolved', repeat('x', 2001)
    );
    perform pg_temp.assert(false, 'part3: notes over 2000 characters must raise an exception');
  exception when others then
    perform pg_temp.assert(
      sqlerrm = 'p_admin_notes must be 2000 characters or fewer',
      format('part3: unexpected message: %s', sqlerrm)
    );
  end;
  reset role;
end $$;

do $$
begin
  -- Admin, legitimate resolve: succeeds. reviewed_by must equal the
  -- ACTING admin's own auth.uid() -- there is no parameter through
  -- which a caller could supply a different reviewer id; this proves
  -- the persisted value actually comes from auth.uid(), not merely
  -- that the function signature lacks such a parameter.
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  perform public.review_book_report(
    '55555555-5555-5555-5555-555555555555', 'resolved', '  Listing looks fine, no action needed.  '
  );
  reset role;

  perform pg_temp.assert(
    (select status from public.book_reports where id = '55555555-5555-5555-5555-555555555555') = 'resolved',
    'part3: status must be resolved after a legitimate resolve'
  );
  perform pg_temp.assert(
    (select reviewed_by from public.book_reports where id = '55555555-5555-5555-5555-555555555555')
      = '11111111-1111-1111-1111-111111111111',
    'part3: reviewed_by must equal the acting admin''s own auth.uid()'
  );
  perform pg_temp.assert(
    (select reviewed_at from public.book_reports where id = '55555555-5555-5555-5555-555555555555') is not null,
    'part3: reviewed_at must be set'
  );
  perform pg_temp.assert(
    (select admin_notes from public.book_reports where id = '55555555-5555-5555-5555-555555555555')
      = 'Listing looks fine, no action needed.',
    'part3: admin_notes must be trimmed and persisted'
  );
end $$;

do $$
begin
  -- A second admin attempting to re-review the now-resolved report:
  -- race-safety / idempotency -- the RPC's own `where status = 'open'`
  -- clause matches zero rows, so this must NOT silently overwrite the
  -- first admin's decision, and must surface as a distinct,
  -- specifically-mapped "already reviewed" condition, not a generic
  -- failure.
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  begin
    perform public.review_book_report('55555555-5555-5555-5555-555555555555', 'dismissed', null);
    perform pg_temp.assert(false, 'part3: reviewing an already-resolved report must raise an exception');
  exception when others then
    perform pg_temp.assert(
      sqlerrm = 'no reviewable report found for this id',
      format('part3: unexpected message: %s', sqlerrm)
    );
  end;
  reset role;

  perform pg_temp.assert(
    (select status from public.book_reports where id = '55555555-5555-5555-5555-555555555555') = 'resolved',
    'part3: the first admin''s resolution must not have been overwritten by the second attempt'
  );
end $$;

do $$
begin
  -- A fresh open report, dismissed this time -- proves both terminal
  -- decisions work, not just 'resolved'.
  insert into public.book_reports (id, book_id, reporter_id, reason) values
    ('66666666-6666-6666-6666-666666666666', '44444444-4444-4444-4444-444444444444',
     '22222222-2222-2222-2222-222222222222', 'Other');

  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  set local role authenticated;
  perform public.review_book_report('66666666-6666-6666-6666-666666666666', 'dismissed', null);
  reset role;

  perform pg_temp.assert(
    (select status from public.book_reports where id = '66666666-6666-6666-6666-666666666666') = 'dismissed',
    'part3: status must be dismissed after a legitimate dismiss'
  );
  perform pg_temp.assert(
    (select admin_notes from public.book_reports where id = '66666666-6666-6666-6666-666666666666') is null,
    'part3: admin_notes must be null when no notes were supplied'
  );
end $$;

delete from public.book_reports where id in
  ('55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666');
delete from public.books where id = '44444444-4444-4444-4444-444444444444';
delete from public.profiles where id in
  ('11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222',
   '33333333-3333-3333-3333-333333333333');

select 'ALL PASSED: 039_book_report_moderation.test.sql' as result;

rollback;
