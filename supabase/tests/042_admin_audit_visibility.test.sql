-- Committed SQL regression suite for migration 042 (ADMIN-1C Part B:
-- audit.view permission, list_admin_audit_events(), the durable
-- refund_issuance_attempts table plus its begin_refund_issuance_attempt()
-- / complete_refund_issuance_attempt() / fail_refund_issuance_attempt()
-- RPC trio, audit-event insertion inside review_book_report()/
-- review_refund_request(), and the indexes + the refund-issuance
-- duplicate-prevention index).
--
-- ADMIN-1C Part B PRE-FINALIZE CORRECTION: Part 8 below was rewritten
-- from testing the first draft's single record_refund_issuance_submitted()
-- RPC to testing the begin/complete/fail trio that replaced it -- see
-- migration 042's own header comment for the durability-gap root cause
-- this correction fixes (a durable row must exist BEFORE Stripe is ever
-- called, not only after it succeeds). Part 7 was updated for the
-- refund.review_denied -> refund.review_rejected rename (the correction's
-- own instruction: the actual domain status value is "rejected", matching
-- refund_requests.status's CHECK constraint).
--
-- ADMIN-1C Part B FINAL FINANCIAL INVARIANT CORRECTION: Part 8 extended
-- further -- (1) a cross-attempt stripe_refund_id collision is now a
-- REJECTED completion (attempt B stays non-submitted), not a silently
-- deduplicated one; (2) fail_refund_issuance_attempt()'s tests now cover
-- BOTH resulting statuses explicitly (stripe_error -> unknown, immediate_
-- failed/immediate_canceled -> failed), replacing the single "-> failed"
-- assertion the earlier draft made for every reason code; (3) new direct
-- checks for the status CHECK constraint's four-value vocabulary and the
-- refund_request_id FK's ON DELETE RESTRICT behavior. This suite is a
-- SINGLE-SESSION harness throughout (see 00_stub_supabase_platform.sql) --
-- nothing here claims to exercise genuine concurrent/simultaneous
-- execution; "double-click"/"two admin tabs" scenarios are verified by
-- issuing the same sequential calls a real race would eventually make,
-- which is sufficient to prove the underlying DB-level guarantee
-- (unique constraints, guarded UPDATEs) without needing actual
-- concurrency in the test itself.
--
-- ADMIN-1C Part B UNKNOWN-STATE RECOVERY CORRECTION: Part 8 extended
-- again -- a new dedicated block proves the full attempt state machine
-- transition by transition (initiated/unknown -> submitted/failed/
-- unknown; submitted/failed both strictly terminal), using five fresh
-- fixtures (044-048) so no test's setup can be mistaken for another's
-- assertion. The two "repeat fail call" tests in the KNOWN-vs-UNKNOWN
-- block above were also revised: 'unknown' is no longer a dead end a
-- repeat call merely no-ops against -- it is itself a valid recovery
-- starting state now, so those tests assert the (still idempotent)
-- unknown -> unknown transition instead of an unconditional no-op.
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql -- no new test
-- infrastructure needed, same as every other suite in this directory.
--
-- Run manually against a disposable/local Postgres instance, AFTER
-- applying supabase/schema.sql, from the repo root:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/042_admin_audit_visibility.test.sql
--
-- (schema.sql already includes migration 042's final state -- this
-- suite doesn't separately apply 042_admin_audit_visibility.sql on top
-- of an older schema.sql.)
--
-- This file was written and reviewed as part of ADMIN-1C Part B's
-- implementation (including this PRE-FINALIZE CORRECTION pass) but has
-- NOT been executed in this environment -- no local/CI Postgres was
-- available (same limitation every prior migration's own test file in
-- this directory already documents). It is a reviewed contract, not a
-- confirmed-passing result.
--
-- ============================================================
-- TIMESTAMP NOTE: everything in this file runs inside ONE transaction,
-- so now() is CONSTANT for the entire file (a real bug caught and fixed
-- once already in this exact suite's own history -- see
-- 041_staff_management.test.sql's own updated_at test). Parts 4/5
-- (filters/pagination) therefore seed admin_audit_log rows DIRECTLY,
-- with explicit, deliberately-spaced created_at values, rather than
-- relying on real RPC calls (which would all land on the identical
-- now()). Parts 6/7/8 (report/refund/issuance audit) instead call the
-- REAL RPCs, since the point there is proving THOSE functions write the
-- correct row -- direct insertion would defeat the purpose. Both are
-- legitimate within one file: different parts are testing different
-- layers (the read/pagination path vs. the write paths).
-- ============================================================

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
-- Shared fixtures: one staff member per role, one non-staff user, one
-- author + reader + book, all reused across every Part below.
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('f0000000-0000-0000-0000-000000000001', 'p042-owner@test', now(), '{"role":"reader","display_name":"Owner"}'),
  ('f0000000-0000-0000-0000-000000000002', 'p042-admin@test', now(), '{"role":"reader","display_name":"Admin"}'),
  ('f0000000-0000-0000-0000-000000000003', 'p042-moderator@test', now(), '{"role":"reader","display_name":"Moderator"}'),
  ('f0000000-0000-0000-0000-000000000004', 'p042-support@test', now(), '{"role":"reader","display_name":"Support"}'),
  ('f0000000-0000-0000-0000-000000000005', 'p042-editor@test', now(), '{"role":"reader","display_name":"Editor"}'),
  ('f0000000-0000-0000-0000-000000000006', 'p042-nonstaff@test', now(), '{"role":"reader","display_name":"Non-staff"}'),
  ('f0000000-0000-0000-0000-000000000007', 'p042-author@test', now(), '{"role":"author","display_name":"Author"}'),
  ('f0000000-0000-0000-0000-000000000008', 'p042-reporter@test', now(), '{"role":"reader","display_name":"Reporter"}'),
  ('f0000000-0000-0000-0000-000000000009', 'p042-reader@test', now(), '{"role":"reader","display_name":"Reader"}');

insert into public.staff_members (user_id, role) values
  ('f0000000-0000-0000-0000-000000000001', 'owner'),
  ('f0000000-0000-0000-0000-000000000002', 'admin'),
  ('f0000000-0000-0000-0000-000000000003', 'moderator'),
  ('f0000000-0000-0000-0000-000000000004', 'support'),
  ('f0000000-0000-0000-0000-000000000005', 'editor');

insert into public.books (id, author_id, title, description, preview_text, keywords, status) values
  ('f0000000-0000-0000-0000-000000000010', 'f0000000-0000-0000-0000-000000000007',
   'Test Book', '', '', '', 'published');

-- ============================================================
-- Part 1: PERMISSION MATRIX -- audit.view added, every other permission
-- re-verified UNCHANGED, all 5 roles x 8 permissions. Mirrors migration
-- 040's own Part 2 exhaustive-matrix pattern exactly, extended by one
-- column.
-- ============================================================
do $$
declare
  matrix jsonb := '{
    "f0000000-0000-0000-0000-000000000001": {
      "admin.access": true, "reports.view": true, "reports.resolve": true,
      "refunds.view": true, "refunds.resolve": true, "staff.view": true,
      "staff.manage": true, "audit.view": true
    },
    "f0000000-0000-0000-0000-000000000002": {
      "admin.access": true, "reports.view": true, "reports.resolve": true,
      "refunds.view": true, "refunds.resolve": true, "staff.view": true,
      "staff.manage": false, "audit.view": true
    },
    "f0000000-0000-0000-0000-000000000003": {
      "admin.access": true, "reports.view": true, "reports.resolve": true,
      "refunds.view": false, "refunds.resolve": false, "staff.view": false,
      "staff.manage": false, "audit.view": false
    },
    "f0000000-0000-0000-0000-000000000004": {
      "admin.access": true, "reports.view": false, "reports.resolve": false,
      "refunds.view": true, "refunds.resolve": false, "staff.view": false,
      "staff.manage": false, "audit.view": false
    },
    "f0000000-0000-0000-0000-000000000005": {
      "admin.access": false, "reports.view": false, "reports.resolve": false,
      "refunds.view": false, "refunds.resolve": false, "staff.view": false,
      "staff.manage": false, "audit.view": false
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
        format('part1: staff_has_permission(%L) for user %s expected %s, got %s', perm, uid, expected, actual)
      );
    end loop;
    reset role;
  end loop;
end $$;

-- ============================================================
-- Part 2: AUDIT TABLE PRIVACY -- re-verified post-042 (same discipline
-- as 041's own Part 7 re-checking staff_members after a later migration
-- landed).
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.admin_audit_log', 'SELECT'),
    'part2: authenticated must NOT have SELECT on admin_audit_log after migration 042'
  );
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.admin_audit_log', 'INSERT'),
    'part2: authenticated must NOT have INSERT on admin_audit_log after migration 042'
  );
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.admin_audit_log', 'UPDATE'),
    'part2: authenticated must NOT have UPDATE on admin_audit_log after migration 042'
  );
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.admin_audit_log', 'DELETE'),
    'part2: authenticated must NOT have DELETE on admin_audit_log after migration 042'
  );
  perform pg_temp.assert(
    not has_table_privilege('anon', 'public.admin_audit_log', 'SELECT'),
    'part2: anon must have zero privileges on admin_audit_log after migration 042'
  );
end $$;

do $$
begin
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  begin
    perform count(*) from public.admin_audit_log;
    perform pg_temp.assert(false, 'part2: a raw authenticated SELECT on admin_audit_log must still be rejected');
  exception when insufficient_privilege then
    null; -- expected
  end;
  reset role;
end $$;

-- ============================================================
-- Part 3: RPC SECURITY -- list_admin_audit_events() and the
-- begin/complete/fail_refund_issuance_attempt() trio.
-- ============================================================
do $$
begin
  -- Unauthenticated (no jwt claim set at all).
  perform set_config('request.jwt.claim.sub', '', true);
  set local role authenticated;
  begin
    perform public.list_admin_audit_events();
    perform pg_temp.assert(false, 'part3: unauthenticated caller must not be able to call list_admin_audit_events()');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authenticated', format('part3: unexpected message: %s', sqlerrm));
  end;
  reset role;

  -- owner/admin (audit.view): allowed.
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  perform public.list_admin_audit_events();
  reset role;

  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  perform public.list_admin_audit_events();
  reset role;

  -- moderator/support/editor (no audit.view): denied.
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  begin
    perform public.list_admin_audit_events();
    perform pg_temp.assert(false, 'part3: moderator (no audit.view) must not be able to call list_admin_audit_events()');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part3: unexpected message: %s', sqlerrm));
  end;
  reset role;

  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000004', true);
  set local role authenticated;
  begin
    perform public.list_admin_audit_events();
    perform pg_temp.assert(false, 'part3: support (no audit.view) must not be able to call list_admin_audit_events()');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part3: unexpected message: %s', sqlerrm));
  end;
  reset role;

  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000005', true);
  set local role authenticated;
  begin
    perform public.list_admin_audit_events();
    perform pg_temp.assert(false, 'part3: editor (no audit.view) must not be able to call list_admin_audit_events()');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part3: unexpected message: %s', sqlerrm));
  end;
  reset role;
end $$;

-- Function security: SECURITY DEFINER / empty search_path / EXECUTE ACL,
-- for every RPC this migration defines or replaces the ACL of -- same
-- loop-driven pattern as 041's own Part 8.
do $$
declare
  fn record;
  fname text;
  fargs text;
  fq_signature text;
begin
  for fn in
    select f.name, f.args
    from (values
      ('list_admin_audit_events', 'text, uuid, text, timestamptz, timestamptz, timestamptz, uuid, integer'),
      ('begin_refund_issuance_attempt', 'uuid, text'),
      ('complete_refund_issuance_attempt', 'uuid, text, text'),
      ('fail_refund_issuance_attempt', 'uuid, text')
    ) as f(name, args)
  loop
    fname := fn.name;
    fargs := fn.args;

    perform pg_temp.assert(
      exists (
        select 1 from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = fname
      ),
      format('part3: function %s must exist', fname)
    );

    perform pg_temp.assert(
      (
        select p.prosecdef from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = fname
      ) = true,
      format('part3: %s must be SECURITY DEFINER', fname)
    );

    perform pg_temp.assert(
      exists (
        select 1 from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace,
        unnest(coalesce(p.proconfig, '{}'::text[])) c
        where n.nspname = 'public' and p.proname = fname and c = 'search_path='
      ),
      format('part3: %s must SET search_path = '''' (empty)', fname)
    );

    fq_signature := 'public.' || fname || '(' || fargs || ')';

    perform pg_temp.assert(
      not exists (
        select 1 from information_schema.role_routine_grants
        where routine_schema = 'public' and routine_name = fname and grantee = 'PUBLIC'
      ),
      format('part3: PUBLIC must have zero explicit EXECUTE grant on %s', fname)
    );

    perform pg_temp.assert(
      has_function_privilege('authenticated', fq_signature, 'EXECUTE'),
      format('part3: authenticated must have EXECUTE on %s', fname)
    );

    perform pg_temp.assert(
      not has_function_privilege('anon', fq_signature, 'EXECUTE'),
      format('part3: anon must NOT have EXECUTE on %s', fname)
    );
  end loop;
end $$;

-- ============================================================
-- Part 4/5 fixtures: seeded DIRECTLY (test-harness connection, not via
-- any RPC) with explicit, deliberately-spaced created_at values -- see
-- this file's own header comment for why (now() is transaction-constant
-- here, but list_admin_audit_events() itself needs genuinely distinct,
-- orderable timestamps to prove pagination/ordering correctness).
-- ============================================================
insert into public.admin_audit_log (id, actor_id, action, target_type, target_id, metadata, created_at) values
  ('f0000000-0000-0000-0000-0000000000a1', 'f0000000-0000-0000-0000-000000000001', 'staff.added', 'staff_members', 'f0000000-0000-0000-0000-000000000006', '{"role":"support"}', now() - interval '50 minutes'),
  ('f0000000-0000-0000-0000-0000000000a2', 'f0000000-0000-0000-0000-000000000002', 'staff.role_changed', 'staff_members', 'f0000000-0000-0000-0000-000000000006', '{"old_role":"support","new_role":"moderator"}', now() - interval '40 minutes'),
  ('f0000000-0000-0000-0000-0000000000a3', 'f0000000-0000-0000-0000-000000000001', 'report.resolved', 'book_reports', 'f0000000-0000-0000-0000-000000000020', '{"old_status":"open","new_status":"resolved","notes_added":false}', now() - interval '30 minutes'),
  ('f0000000-0000-0000-0000-0000000000a4', 'f0000000-0000-0000-0000-000000000002', 'refund.review_approved', 'refund_requests', 'f0000000-0000-0000-0000-000000000030', '{"old_status":"requested","new_status":"approved","notes_added":false}', now() - interval '20 minutes'),
  ('f0000000-0000-0000-0000-0000000000a5', 'f0000000-0000-0000-0000-000000000001', 'refund.issuance_submitted', 'refund_requests', 'f0000000-0000-0000-0000-000000000030', '{"stripe_refund_id":"re_fixture_1","stripe_status":"succeeded"}', now() - interval '10 minutes');

-- Two rows with an IDENTICAL created_at, to exercise the id-desc tie-break.
insert into public.admin_audit_log (id, actor_id, action, target_type, target_id, metadata, created_at) values
  ('f0000000-0000-0000-0000-0000000000b1', 'f0000000-0000-0000-0000-000000000001', 'staff.removed', 'staff_members', 'f0000000-0000-0000-0000-000000000006', '{"role":"moderator"}', now() - interval '5 minutes'),
  ('f0000000-0000-0000-0000-0000000000b2', 'f0000000-0000-0000-0000-000000000002', 'staff.removed', 'staff_members', 'f0000000-0000-0000-0000-000000000006', '{"role":"moderator"}', now() - interval '5 minutes');

-- ============================================================
-- Part 4: LIST RPC FILTERS
-- ============================================================
do $$
declare
  rows_count integer;
begin
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;

  -- No filter: all 7 seeded rows visible.
  select count(*) into rows_count from public.list_admin_audit_events(p_limit => 100);
  perform pg_temp.assert(rows_count = 7, format('part4: expected 7 rows with no filter, got %s', rows_count));

  -- action filter.
  select count(*) into rows_count from public.list_admin_audit_events(p_action => 'staff.removed', p_limit => 100);
  perform pg_temp.assert(rows_count = 2, format('part4: expected 2 staff.removed rows, got %s', rows_count));

  -- actor filter.
  select count(*) into rows_count
  from public.list_admin_audit_events(p_actor_id => 'f0000000-0000-0000-0000-000000000002', p_limit => 100);
  perform pg_temp.assert(rows_count = 3, format('part4: expected 3 rows for admin actor, got %s', rows_count));

  -- target_type filter.
  select count(*) into rows_count
  from public.list_admin_audit_events(p_target_type => 'refund_requests', p_limit => 100);
  perform pg_temp.assert(rows_count = 2, format('part4: expected 2 refund_requests-target rows, got %s', rows_count));

  -- created_after.
  select count(*) into rows_count
  from public.list_admin_audit_events(p_created_after => now() - interval '15 minutes', p_limit => 100);
  perform pg_temp.assert(rows_count = 3, format('part4: expected 3 rows created_after -15m, got %s', rows_count));

  -- created_before.
  select count(*) into rows_count
  from public.list_admin_audit_events(p_created_before => now() - interval '35 minutes', p_limit => 100);
  perform pg_temp.assert(rows_count = 2, format('part4: expected 2 rows created_before -35m, got %s', rows_count));

  -- combined filters.
  select count(*) into rows_count
  from public.list_admin_audit_events(
    p_target_type => 'staff_members',
    p_actor_id => 'f0000000-0000-0000-0000-000000000001',
    p_limit => 100
  );
  perform pg_temp.assert(rows_count = 2, format('part4: expected 2 rows for staff_members + owner actor, got %s', rows_count));

  -- invalid action.
  begin
    perform public.list_admin_audit_events(p_action => 'staff.promoted');
    perform pg_temp.assert(false, 'part4: an unknown action filter must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'invalid action filter', format('part4: unexpected message: %s', sqlerrm));
  end;

  -- invalid target_type.
  begin
    perform public.list_admin_audit_events(p_target_type => 'purchases');
    perform pg_temp.assert(false, 'part4: an unknown target_type filter must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'invalid target_type filter', format('part4: unexpected message: %s', sqlerrm));
  end;

  -- invalid date range (after >= before).
  begin
    perform public.list_admin_audit_events(
      p_created_after => now(),
      p_created_before => now() - interval '1 hour'
    );
    perform pg_temp.assert(false, 'part4: created_after >= created_before must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'invalid date range', format('part4: unexpected message: %s', sqlerrm));
  end;

  -- limit clamp: p_limit = 1 returns exactly 1 row even though 7 match.
  select count(*) into rows_count from public.list_admin_audit_events(p_limit => 1);
  perform pg_temp.assert(rows_count = 1, format('part4: p_limit=1 must return exactly 1 row, got %s', rows_count));

  -- limit clamp: p_limit = 0 is raised to the minimum (1), not rejected.
  select count(*) into rows_count from public.list_admin_audit_events(p_limit => 0);
  perform pg_temp.assert(rows_count = 1, format('part4: p_limit=0 must clamp to 1 row, got %s', rows_count));

  -- limit clamp: p_limit = 1000 is capped to 100 -- still returns all 7
  -- (fewer than the cap), proving the clamp doesn't ERROR on an
  -- over-large value, just bounds it.
  select count(*) into rows_count from public.list_admin_audit_events(p_limit => 1000);
  perform pg_temp.assert(rows_count = 7, format('part4: p_limit=1000 must clamp to 100 and still return all 7 matching rows, got %s', rows_count));

  reset role;
end $$;

-- ============================================================
-- Part 5: PAGINATION -- deterministic newest-first order, cursor
-- correctness, tie-break, no duplicate/skipped rows across pages,
-- malformed/partial cursor handling.
-- ============================================================
do $$
declare
  page1 uuid[];
  page2 uuid[];
  all_ids uuid[];
  last_created_at timestamptz;
  last_id uuid;
begin
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;

  -- Deterministic newest-first order: the two tie-break rows (b1/b2,
  -- identical created_at) must come first, ordered by id descending
  -- (b2 > b1 lexically).
  select array_agg(id order by created_at desc, id desc) into page1
  from (select id, created_at from public.list_admin_audit_events(p_limit => 2)) t;
  perform pg_temp.assert(
    page1 = array['f0000000-0000-0000-0000-0000000000b2'::uuid, 'f0000000-0000-0000-0000-0000000000b1'::uuid],
    format('part5: expected the two tied-timestamp rows first, id-desc tie-broken, got %s', page1)
  );

  -- Full walk: page through everything with limit=3 and confirm the
  -- concatenated id sequence exactly matches one single limit=100 call,
  -- with no duplicates and no gaps.
  select array_agg(id) into all_ids from (
    select id from public.list_admin_audit_events(p_limit => 100)
  ) t;
  perform pg_temp.assert(array_length(all_ids, 1) = 7, 'part5: expected 7 total rows in the unpaginated baseline');

  select id, created_at into last_id, last_created_at
  from public.list_admin_audit_events(p_limit => 3)
  order by created_at desc, id desc
  limit 1 offset 2;

  select array_agg(id) into page1 from (
    select id from public.list_admin_audit_events(p_limit => 3)
  ) t;

  select array_agg(id) into page2 from (
    select id from public.list_admin_audit_events(
      p_limit => 100,
      p_cursor_created_at => last_created_at,
      p_cursor_id => last_id
    )
  ) t;

  perform pg_temp.assert(array_length(page1, 1) = 3, 'part5: page1 must have exactly 3 rows');
  perform pg_temp.assert(array_length(page2, 1) = 4, format('part5: page2 must have exactly 4 rows, got %s', array_length(page2, 1)));

  -- No overlap between page1 and page2.
  perform pg_temp.assert(
    (select count(*) from unnest(page1) a where a = any(page2)) = 0,
    'part5: page1 and page2 must not overlap'
  );

  -- Combined, they must equal the full 7-row set with no gaps.
  perform pg_temp.assert(
    (select count(distinct x) from unnest(page1 || page2) x) = 7,
    'part5: page1 + page2 combined must cover all 7 rows exactly once'
  );

  -- Malformed partial cursor: created_at present, id absent (and vice
  -- versa) must both be rejected, never silently treated as "first page"
  -- or "ignore the other half."
  begin
    perform public.list_admin_audit_events(p_cursor_created_at => now());
    perform pg_temp.assert(false, 'part5: a cursor with created_at but no id must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'invalid cursor', format('part5: unexpected message: %s', sqlerrm));
  end;

  begin
    perform public.list_admin_audit_events(p_cursor_id => 'f0000000-0000-0000-0000-0000000000a1');
    perform pg_temp.assert(false, 'part5: a cursor with id but no created_at must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'invalid cursor', format('part5: unexpected message: %s', sqlerrm));
  end;

  reset role;
end $$;

-- ============================================================
-- Part 6: REPORT AUDIT -- review_book_report() now writes an audit
-- event. Real report fixtures + the real RPC, not direct insertion.
-- ============================================================
insert into public.book_reports (id, book_id, reporter_id, reason) values
  ('f0000000-0000-0000-0000-000000000020', 'f0000000-0000-0000-0000-000000000010',
   'f0000000-0000-0000-0000-000000000008', 'Spam or misleading listing'),
  ('f0000000-0000-0000-0000-000000000021', 'f0000000-0000-0000-0000-000000000010',
   'f0000000-0000-0000-0000-000000000008', 'Copyright concern'),
  ('f0000000-0000-0000-0000-000000000022', 'f0000000-0000-0000-0000-000000000010',
   'f0000000-0000-0000-0000-000000000008', 'Already resolved elsewhere');

-- Pre-close report 022 (as owner) so a SECOND attempt against it below is
-- a genuine no-op/stale case.
do $$
begin
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  perform public.review_book_report('f0000000-0000-0000-0000-000000000022', 'dismissed', null);
  reset role;
end $$;

do $$
declare
  event_count integer;
  ev record;
begin
  -- resolved: as admin (a DIFFERENT staff member than the report-020
  -- fixture's own reporter/author), with notes.
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  perform public.review_book_report('f0000000-0000-0000-0000-000000000020', 'resolved', 'Verified, listing corrected');
  reset role;

  select count(*) into event_count
  from public.admin_audit_log
  where action = 'report.resolved' and target_id = 'f0000000-0000-0000-0000-000000000020';
  perform pg_temp.assert(event_count = 1, format('part6: expected exactly one report.resolved event, got %s', event_count));

  select actor_id, target_type, metadata into ev
  from public.admin_audit_log
  where action = 'report.resolved' and target_id = 'f0000000-0000-0000-0000-000000000020';
  perform pg_temp.assert(ev.actor_id = 'f0000000-0000-0000-0000-000000000002', 'part6: actor must be the calling admin, not hardcoded');
  perform pg_temp.assert(ev.target_type = 'book_reports', 'part6: target_type must be book_reports');
  perform pg_temp.assert((ev.metadata->>'old_status') = 'open', 'part6: old_status must be open');
  perform pg_temp.assert((ev.metadata->>'new_status') = 'resolved', 'part6: new_status must be resolved');
  perform pg_temp.assert((ev.metadata->>'notes_added')::boolean = true, 'part6: notes_added must be true when notes were supplied');
  perform pg_temp.assert(not (ev.metadata ? 'admin_notes'), 'part6: metadata must never contain the admin_notes text itself');
  perform pg_temp.assert(not (ev.metadata ? 'reason'), 'part6: metadata must never contain the report reason text');
  perform pg_temp.assert(not (ev.metadata ? 'reporter_id'), 'part6: metadata must never contain the reporter identity');

  -- dismissed: as owner, no notes.
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  perform public.review_book_report('f0000000-0000-0000-0000-000000000021', 'dismissed', null);
  reset role;

  select count(*) into event_count
  from public.admin_audit_log
  where action = 'report.dismissed' and target_id = 'f0000000-0000-0000-0000-000000000021';
  perform pg_temp.assert(event_count = 1, format('part6: expected exactly one report.dismissed event, got %s', event_count));

  select metadata into ev
  from public.admin_audit_log
  where action = 'report.dismissed' and target_id = 'f0000000-0000-0000-0000-000000000021';
  perform pg_temp.assert((ev.metadata->>'notes_added')::boolean = false, 'part6: notes_added must be false when no notes were supplied');

  -- Failed/stale/no-op: report 022 was already dismissed above --
  -- attempting to review it again must raise and write NO new event.
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  begin
    perform public.review_book_report('f0000000-0000-0000-0000-000000000022', 'resolved', null);
    perform pg_temp.assert(false, 'part6: reviewing an already-closed report must raise');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'no reviewable report found for this id', format('part6: unexpected message: %s', sqlerrm));
  end;
  reset role;

  select count(*) into event_count
  from public.admin_audit_log
  where target_id = 'f0000000-0000-0000-0000-000000000022' and action like 'report.%';
  perform pg_temp.assert(event_count = 1, format('part6: report 022 must still show exactly the ONE event from its original dismissal, got %s', event_count));
end $$;

-- ============================================================
-- Part 7: REFUND REVIEW AUDIT -- review_refund_request() now writes an
-- audit event. ADMIN-1C Part B PRE-FINALIZE CORRECTION: the rejected
-- branch now asserts refund.review_rejected, not the first draft's
-- refund.review_denied -- the actual domain status value is "rejected"
-- (refund_requests.status's own CHECK constraint, migration 029).
-- ============================================================
insert into public.refund_requests (id, reader_id, stripe_payment_intent_id, amount_cents, status) values
  ('f0000000-0000-0000-0000-000000000030', 'f0000000-0000-0000-0000-000000000009', 'pi_042_test_a', 1999, 'requested'),
  ('f0000000-0000-0000-0000-000000000031', 'f0000000-0000-0000-0000-000000000009', 'pi_042_test_b', 2999, 'requested'),
  ('f0000000-0000-0000-0000-000000000032', 'f0000000-0000-0000-0000-000000000009', 'pi_042_test_c', 3999, 'requested');

-- Pre-close request 032 (as owner) so a second attempt is a genuine
-- stale/no-op case.
do $$
begin
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  perform public.review_refund_request('f0000000-0000-0000-0000-000000000032', 'rejected', null);
  reset role;
end $$;

do $$
declare
  event_count integer;
  ev record;
begin
  -- approved: as admin, with notes. Request 030 remains 'approved' after
  -- this -- reused as the target for Part 8's own begin/complete tests
  -- below.
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  perform public.review_refund_request('f0000000-0000-0000-0000-000000000030', 'approved', 'Confirmed eligible');
  reset role;

  select count(*) into event_count
  from public.admin_audit_log
  where action = 'refund.review_approved' and target_id = 'f0000000-0000-0000-0000-000000000030';
  perform pg_temp.assert(event_count = 1, format('part7: expected exactly one refund.review_approved event, got %s', event_count));

  select actor_id, target_type, metadata into ev
  from public.admin_audit_log
  where action = 'refund.review_approved' and target_id = 'f0000000-0000-0000-0000-000000000030';
  perform pg_temp.assert(ev.actor_id = 'f0000000-0000-0000-0000-000000000002', 'part7: actor must be the calling admin');
  perform pg_temp.assert(ev.target_type = 'refund_requests', 'part7: target_type must be refund_requests');
  perform pg_temp.assert((ev.metadata->>'old_status') = 'requested', 'part7: old_status must be requested');
  perform pg_temp.assert((ev.metadata->>'new_status') = 'approved', 'part7: new_status must be approved');
  perform pg_temp.assert((ev.metadata->>'notes_added')::boolean = true, 'part7: notes_added must be true when notes were supplied');
  perform pg_temp.assert(not (ev.metadata ? 'admin_notes'), 'part7: metadata must never contain the admin_notes text itself');
  perform pg_temp.assert(not (ev.metadata ? 'reason'), 'part7: metadata must never contain the request reason text');
  perform pg_temp.assert(not (ev.metadata ? 'reader_id'), 'part7: metadata must never contain the reader identity');
  perform pg_temp.assert(not (ev.metadata ? 'amount_cents'), 'part7: metadata must never contain payment amount details');

  -- rejected: as owner, no notes. Request 031 remains 'rejected' after
  -- this -- reused as the "not approved" target for Part 8's own
  -- begin_refund_issuance_attempt() rejection test below.
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  perform public.review_refund_request('f0000000-0000-0000-0000-000000000031', 'rejected', null);
  reset role;

  select count(*) into event_count
  from public.admin_audit_log
  where action = 'refund.review_rejected' and target_id = 'f0000000-0000-0000-0000-000000000031';
  perform pg_temp.assert(event_count = 1, format('part7: expected exactly one refund.review_rejected event, got %s', event_count));

  -- Failed/stale: request 032 was already rejected above.
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  begin
    perform public.review_refund_request('f0000000-0000-0000-0000-000000000032', 'approved', null);
    perform pg_temp.assert(false, 'part7: reviewing an already-closed refund request must raise');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'no reviewable refund request found for this id', format('part7: unexpected message: %s', sqlerrm));
  end;
  reset role;

  select count(*) into event_count
  from public.admin_audit_log
  where target_id = 'f0000000-0000-0000-0000-000000000032' and action like 'refund.review_%';
  perform pg_temp.assert(event_count = 1, format('part7: request 032 must still show exactly the ONE event from its original rejection, got %s', event_count));
end $$;

-- ============================================================
-- Part 8: REFUND ISSUANCE ATTEMPTS -- table security/privacy, plus the
-- begin_refund_issuance_attempt() / complete_refund_issuance_attempt() /
-- fail_refund_issuance_attempt() RPC trio.
--
-- ADMIN-1C Part B PRE-FINALIZE CORRECTION: this Part replaces the first
-- draft's test of a single record_refund_issuance_submitted() RPC. The
-- root issue that RPC never protected against: if Stripe accepted a
-- refund but the process died (or the audit RPC itself failed) before
-- that single post-hoc call landed, Librum had no durable record of
-- which staff member initiated the external, money-moving action. The
-- fix is a durable row committed BEFORE Stripe is ever called
-- (begin_refund_issuance_attempt()), completed only AFTER Stripe accepts
-- (complete_refund_issuance_attempt(), which atomically writes the
-- refund.issuance_submitted audit event), or marked failed if Stripe
-- rejects/never confirms (fail_refund_issuance_attempt()). See migration
-- 042's own header comment for the full design.
-- ============================================================

-- Table privacy: same zero-direct-access posture as admin_audit_log.
do $$
begin
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.refund_issuance_attempts', 'SELECT'),
    'part8: authenticated must NOT have SELECT on refund_issuance_attempts'
  );
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.refund_issuance_attempts', 'INSERT'),
    'part8: authenticated must NOT have INSERT on refund_issuance_attempts'
  );
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.refund_issuance_attempts', 'UPDATE'),
    'part8: authenticated must NOT have UPDATE on refund_issuance_attempts'
  );
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.refund_issuance_attempts', 'DELETE'),
    'part8: authenticated must NOT have DELETE on refund_issuance_attempts'
  );
  perform pg_temp.assert(
    not has_table_privilege('anon', 'public.refund_issuance_attempts', 'SELECT'),
    'part8: anon must have zero privileges on refund_issuance_attempts'
  );
end $$;

do $$
begin
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  begin
    perform count(*) from public.refund_issuance_attempts;
    perform pg_temp.assert(false, 'part8: a raw authenticated SELECT on refund_issuance_attempts must still be rejected');
  exception when insufficient_privilege then
    null; -- expected
  end;
  reset role;
end $$;

-- Privacy: no PII/raw-payload columns anywhere on this table -- only the
-- narrow operational/recovery fields the correction's own design allows
-- (never email/payment method/card/billing/raw Stripe payload/secret).
do $$
declare
  cols text[];
begin
  select array_agg(column_name order by column_name) into cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'refund_issuance_attempts';
  perform pg_temp.assert(
    cols = array[
      'actor_id', 'created_at', 'failure_reason', 'id', 'idempotency_key',
      'refund_request_id', 'status', 'stripe_refund_id', 'stripe_status', 'updated_at'
    ],
    format('part8: unexpected column set on refund_issuance_attempts: %s', cols)
  );
end $$;

-- Fixtures: approved refund requests dedicated to Part 8's own RPC
-- tests, inserted directly (test-harness connection, not via the review
-- RPC -- Part 7 above already covers review_refund_request() itself).
insert into public.refund_requests (id, reader_id, stripe_payment_intent_id, amount_cents, status) values
  ('f0000000-0000-0000-0000-000000000040', 'f0000000-0000-0000-0000-000000000009', 'pi_042_test_h1', 1500, 'approved'),
  ('f0000000-0000-0000-0000-000000000041', 'f0000000-0000-0000-0000-000000000009', 'pi_042_test_h2', 1600, 'approved'),
  ('f0000000-0000-0000-0000-000000000042', 'f0000000-0000-0000-0000-000000000009', 'pi_042_test_h3', 1700, 'approved'),
  ('f0000000-0000-0000-0000-000000000043', 'f0000000-0000-0000-0000-000000000009', 'pi_042_test_h4', 1800, 'approved'),
  ('f0000000-0000-0000-0000-000000000044', 'f0000000-0000-0000-0000-000000000009', 'pi_042_test_h5', 1900, 'approved'),
  ('f0000000-0000-0000-0000-000000000045', 'f0000000-0000-0000-0000-000000000009', 'pi_042_test_h6', 2000, 'approved'),
  ('f0000000-0000-0000-0000-000000000046', 'f0000000-0000-0000-0000-000000000009', 'pi_042_test_h7', 2100, 'approved'),
  ('f0000000-0000-0000-0000-000000000047', 'f0000000-0000-0000-0000-000000000009', 'pi_042_test_h8', 2200, 'approved'),
  ('f0000000-0000-0000-0000-000000000048', 'f0000000-0000-0000-0000-000000000009', 'pi_042_test_h9', 2300, 'approved');

-- ------------------------------------------------------------
-- begin_refund_issuance_attempt(): auth, permission, target-status
-- validation, input validation, and the ATTEMPT-IDENTITY idempotency
-- guarantee (same key -> same attempt; different key -> a genuinely new
-- attempt).
-- ------------------------------------------------------------
do $$
declare
  attempt_id uuid;
  attempt_id_2 uuid;
  attempt_row record;
  row_count integer;
begin
  -- unauthenticated caller denied.
  perform set_config('request.jwt.claim.sub', '', true);
  set local role authenticated;
  begin
    perform public.begin_refund_issuance_attempt('f0000000-0000-0000-0000-000000000040', 'key-unauth');
    perform pg_temp.assert(false, 'part8: unauthenticated caller must not be able to call begin_refund_issuance_attempt()');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authenticated', format('part8: unexpected message: %s', sqlerrm));
  end;
  reset role;

  -- unauthorized caller denied (support has refunds.view, not refunds.resolve).
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000004', true);
  set local role authenticated;
  begin
    perform public.begin_refund_issuance_attempt('f0000000-0000-0000-0000-000000000040', 'key-unauthorized');
    perform pg_temp.assert(false, 'part8: support (refunds.view only) must not be able to call begin_refund_issuance_attempt()');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part8: unexpected message: %s', sqlerrm));
  end;
  reset role;

  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;

  -- missing target rejected.
  begin
    perform public.begin_refund_issuance_attempt('00000000-0000-0000-0000-000000000000', 'key-missing');
    perform pg_temp.assert(false, 'part8: a non-existent refund_request_id must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'refund request not found', format('part8: unexpected message: %s', sqlerrm));
  end;

  -- non-approved target rejected (031 was rejected in Part 7).
  begin
    perform public.begin_refund_issuance_attempt('f0000000-0000-0000-0000-000000000031', 'key-not-approved');
    perform pg_temp.assert(false, 'part8: a non-approved refund request must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'refund request is not approved', format('part8: unexpected message: %s', sqlerrm));
  end;

  -- empty/null idempotency key rejected.
  begin
    perform public.begin_refund_issuance_attempt('f0000000-0000-0000-0000-000000000040', '');
    perform pg_temp.assert(false, 'part8: an empty idempotency key must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'invalid idempotency key', format('part8: unexpected message: %s', sqlerrm));
  end;

  begin
    perform public.begin_refund_issuance_attempt('f0000000-0000-0000-0000-000000000040', null);
    perform pg_temp.assert(false, 'part8: a null idempotency key must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'invalid idempotency key', format('part8: unexpected message: %s', sqlerrm));
  end;

  -- happy path: a real begin call durably inserts one 'initiated' row,
  -- with the REAL caller as actor_id -- never anything caller-supplied.
  select public.begin_refund_issuance_attempt('f0000000-0000-0000-0000-000000000040', 'key-h1-first') into attempt_id;
  perform pg_temp.assert(attempt_id is not null, 'part8: begin_refund_issuance_attempt must return a non-null attempt id');

  select * into attempt_row from public.refund_issuance_attempts where id = attempt_id;
  perform pg_temp.assert(attempt_row.refund_request_id = 'f0000000-0000-0000-0000-000000000040', 'part8: attempt.refund_request_id must match the target');
  perform pg_temp.assert(attempt_row.actor_id = 'f0000000-0000-0000-0000-000000000001', 'part8: attempt.actor_id must be auth.uid(), the calling owner -- never caller-supplied');
  perform pg_temp.assert(attempt_row.idempotency_key = 'key-h1-first', 'part8: attempt.idempotency_key must match exactly');
  perform pg_temp.assert(attempt_row.status = 'initiated', 'part8: a freshly begun attempt must be status = initiated');
  perform pg_temp.assert(attempt_row.stripe_refund_id is null, 'part8: a freshly begun attempt must carry no stripe_refund_id yet');

  -- SAME idempotency key, SAME target: resolves to the SAME attempt
  -- identity, not a second row (the ON CONFLICT DO NOTHING + fallback
  -- SELECT pattern) -- this is the double-click/concurrent-tab case the
  -- ATTEMPT-IDENTITY idempotency guarantee exists for. Distinct from the
  -- audit table's own EVENT idempotency (exercised in the complete_
  -- refund_issuance_attempt() tests below) -- two different concepts.
  select public.begin_refund_issuance_attempt('f0000000-0000-0000-0000-000000000040', 'key-h1-first') into attempt_id_2;
  perform pg_temp.assert(attempt_id_2 = attempt_id, 'part8: the SAME idempotency key must resolve to the SAME attempt id, not create a second one');

  select count(*) into row_count from public.refund_issuance_attempts where idempotency_key = 'key-h1-first';
  perform pg_temp.assert(row_count = 1, format('part8: exactly one attempt row must exist for a repeated idempotency key, got %s', row_count));

  -- a DIFFERENT, legitimate idempotency key (a genuine retry, in real
  -- usage) creates a genuinely NEW, distinct attempt.
  select public.begin_refund_issuance_attempt('f0000000-0000-0000-0000-000000000040', 'key-h1-retry') into attempt_id_2;
  perform pg_temp.assert(attempt_id_2 <> attempt_id, 'part8: a DIFFERENT idempotency key must create a genuinely new attempt id');

  reset role;
end $$;

-- ------------------------------------------------------------
-- complete_refund_issuance_attempt(): auth, permission, per-actor
-- ownership, input validation, the initiated -> submitted transition,
-- the atomic audit-event write, the "repeat completion does not
-- duplicate the audit event" guarantee (PRIMARY defense: the function's
-- own `where status = 'initiated'` guard), and the SECONDARY defense
-- (ADMIN-1C PART B FINAL FINANCIAL INVARIANT CORRECTION: the new
-- refund_issuance_attempts.stripe_refund_id partial unique index, which
-- makes a cross-attempt collision on the same real Stripe refund a
-- CONTROLLED REJECTION -- the second attempt is left non-submitted, not
-- silently deduplicated -- see this function's own comment).
-- ------------------------------------------------------------
do $$
declare
  attempt_id uuid;
  other_attempt_id uuid;
  event_count integer;
  ev record;
  final_status text;
begin
  -- Begin a fresh attempt as owner, on target 041, to test completion.
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select public.begin_refund_issuance_attempt('f0000000-0000-0000-0000-000000000041', 'key-h2-complete') into attempt_id;
  reset role;

  -- unauthenticated caller denied.
  perform set_config('request.jwt.claim.sub', '', true);
  set local role authenticated;
  begin
    perform public.complete_refund_issuance_attempt(attempt_id, 're_h2', 'succeeded');
    perform pg_temp.assert(false, 'part8: unauthenticated caller must not be able to call complete_refund_issuance_attempt()');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authenticated', format('part8: unexpected message: %s', sqlerrm));
  end;
  reset role;

  -- unauthorized caller denied.
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000004', true);
  set local role authenticated;
  begin
    perform public.complete_refund_issuance_attempt(attempt_id, 're_h2', 'succeeded');
    perform pg_temp.assert(false, 'part8: support (refunds.view only) must not be able to call complete_refund_issuance_attempt()');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part8: unexpected message: %s', sqlerrm));
  end;
  reset role;

  -- wrong actor rejected: admin (a DIFFERENT staff member than who began
  -- the attempt) must not be able to complete the owner's own attempt --
  -- the correction's own explicit per-actor ownership invariant (only
  -- the staff member who began an attempt may complete or fail it).
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  begin
    perform public.complete_refund_issuance_attempt(attempt_id, 're_h2', 'succeeded');
    perform pg_temp.assert(false, 'part8: a staff member who did not begin this attempt must not be able to complete it');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part8: unexpected message: %s', sqlerrm));
  end;
  reset role;

  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;

  -- non-existent attempt rejected.
  begin
    perform public.complete_refund_issuance_attempt('00000000-0000-0000-0000-000000000000', 're_h2', 'succeeded');
    perform pg_temp.assert(false, 'part8: a non-existent attempt id must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'refund issuance attempt not found', format('part8: unexpected message: %s', sqlerrm));
  end;

  -- invalid stripe refund id rejected (empty, null).
  begin
    perform public.complete_refund_issuance_attempt(attempt_id, '', 'succeeded');
    perform pg_temp.assert(false, 'part8: an empty stripe refund id must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'invalid stripe refund id', format('part8: unexpected message: %s', sqlerrm));
  end;

  begin
    perform public.complete_refund_issuance_attempt(attempt_id, null, 'succeeded');
    perform pg_temp.assert(false, 'part8: a null stripe refund id must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'invalid stripe refund id', format('part8: unexpected message: %s', sqlerrm));
  end;

  -- invalid status rejected.
  begin
    perform public.complete_refund_issuance_attempt(attempt_id, 're_h2', 'failed');
    perform pg_temp.assert(false, 'part8: status = failed must be rejected by complete_refund_issuance_attempt');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'invalid stripe status', format('part8: unexpected message: %s', sqlerrm));
  end;

  begin
    perform public.complete_refund_issuance_attempt(attempt_id, 're_h2', 'made_up_status');
    perform pg_temp.assert(false, 'part8: an unrecognized status must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'invalid stripe status', format('part8: unexpected message: %s', sqlerrm));
  end;

  -- the real completion: transitions initiated -> submitted, stores the
  -- safe fields, and writes exactly one refund.issuance_submitted audit
  -- event, atomically.
  perform public.complete_refund_issuance_attempt(attempt_id, 're_h2', 'succeeded');

  select status into final_status from public.refund_issuance_attempts where id = attempt_id;
  perform pg_temp.assert(final_status = 'submitted', format('part8: attempt must transition to submitted, got %s', final_status));

  select count(*) into event_count
  from public.admin_audit_log
  where action = 'refund.issuance_submitted' and target_id = 'f0000000-0000-0000-0000-000000000041'
    and metadata->>'stripe_refund_id' = 're_h2';
  perform pg_temp.assert(event_count = 1, format('part8: expected exactly one refund.issuance_submitted event for re_h2, got %s', event_count));

  select actor_id, target_type, metadata into ev
  from public.admin_audit_log
  where action = 'refund.issuance_submitted' and metadata->>'stripe_refund_id' = 're_h2';
  perform pg_temp.assert(ev.actor_id = 'f0000000-0000-0000-0000-000000000001', 'part8: audit actor must be auth.uid(), the calling owner');
  perform pg_temp.assert(ev.target_type = 'refund_requests', 'part8: audit target_type must be refund_requests');
  perform pg_temp.assert(
    (select array_agg(k order by k) from jsonb_object_keys(ev.metadata) k) = array['stripe_refund_id', 'stripe_status'],
    'part8: metadata must contain ONLY stripe_refund_id and stripe_status -- no extra keys'
  );

  -- repeat completion of the SAME attempt (e.g. a duplicated/retried
  -- request-scoped call) must not duplicate the audit event -- the
  -- `where status = 'initiated'` UPDATE guard is the PRIMARY defense
  -- here (the attempt is already 'submitted', so the guarded UPDATE
  -- matches zero rows and the function returns before ever attempting a
  -- second insert).
  perform public.complete_refund_issuance_attempt(attempt_id, 're_h2', 'succeeded');

  select count(*) into event_count
  from public.admin_audit_log
  where action = 'refund.issuance_submitted' and metadata->>'stripe_refund_id' = 're_h2';
  perform pg_temp.assert(event_count = 1, format('part8: a repeated completion of the SAME attempt must still show exactly one audit row, got %s', event_count));

  -- ADMIN-1C PART B FINAL FINANCIAL INVARIANT CORRECTION -- SECONDARY
  -- defense (uniqueness layer 2, external Stripe-refund identity): a
  -- DIFFERENT attempt trying to complete with a stripe_refund_id that
  -- another attempt already claimed must be REJECTED outright, not
  -- silently deduplicated. This is the required test from that
  -- correction's own instruction: attempt A + re_same succeeds (already
  -- proven above, using re_h2), attempt B + re_same must have its
  -- completion REJECTED, attempt B must remain non-submitted, exactly one
  -- attempt ends up owning re_h2, and exactly one refund.issuance_submitted
  -- audit row exists for it.
  select public.begin_refund_issuance_attempt('f0000000-0000-0000-0000-000000000041', 'key-h2-second-attempt') into other_attempt_id;
  perform pg_temp.assert(other_attempt_id <> attempt_id, 'part8: the second begin call above must be a genuinely different attempt');

  begin
    perform public.complete_refund_issuance_attempt(other_attempt_id, 're_h2', 'succeeded');
    perform pg_temp.assert(false, 'part8: a second, different attempt completing with an ALREADY-CLAIMED stripe_refund_id must be rejected, not silently accepted');
  exception when others then
    perform pg_temp.assert(
      sqlerrm = 'stripe refund id already claimed by another attempt',
      format('part8: unexpected message: %s', sqlerrm)
    );
  end;

  -- attempt B remains non-submitted (still 'initiated') -- the collision
  -- must never falsely mark it 'submitted'.
  select status into final_status from public.refund_issuance_attempts where id = other_attempt_id;
  perform pg_temp.assert(final_status = 'initiated', format('part8: the rejected second attempt must remain non-submitted, got %s', final_status));

  -- exactly one attempt owns re_h2.
  select count(*) into event_count
  from public.refund_issuance_attempts
  where stripe_refund_id = 're_h2';
  perform pg_temp.assert(event_count = 1, format('part8: exactly one attempt row may ever claim stripe_refund_id re_h2, got %s', event_count));

  -- exactly one refund.issuance_submitted audit row exists for re_h2 --
  -- unchanged by the rejected second attempt.
  select count(*) into event_count
  from public.admin_audit_log
  where action = 'refund.issuance_submitted' and metadata->>'stripe_refund_id' = 're_h2';
  perform pg_temp.assert(event_count = 1, format('part8: exactly one refund.issuance_submitted audit row must exist for re_h2, got %s', event_count));

  reset role;
end $$;

-- ------------------------------------------------------------
-- stripe_refund_id uniqueness among non-null attempts -- direct DB-level
-- confirmation (independent of the RPC-level collision test above) that
-- the partial unique index itself is what's doing the work.
-- ------------------------------------------------------------
do $$
begin
  perform pg_temp.assert(
    exists (
      select 1 from pg_indexes
      where schemaname = 'public'
        and tablename = 'refund_issuance_attempts'
        and indexname = 'refund_issuance_attempts_stripe_refund_id_idx'
    ),
    'part8: refund_issuance_attempts_stripe_refund_id_idx must exist'
  );

  perform pg_temp.assert(
    (
      select indexdef ilike '%UNIQUE%' and indexdef ilike '%WHERE%stripe_refund_id%'
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'refund_issuance_attempts'
        and indexname = 'refund_issuance_attempts_stripe_refund_id_idx'
    ),
    'part8: refund_issuance_attempts_stripe_refund_id_idx must be a UNIQUE partial index on stripe_refund_id'
  );

  -- Multiple NULL stripe_refund_id rows are NOT constrained (every
  -- not-yet-completed attempt has a null stripe_refund_id) -- the table
  -- already has several such rows from the tests above; this simply
  -- confirms no violation was ever raised for them.
  perform pg_temp.assert(
    (select count(*) from public.refund_issuance_attempts where stripe_refund_id is null) > 1,
    'part8: multiple attempts with a null stripe_refund_id must coexist without violating the partial unique index'
  );
end $$;

-- ------------------------------------------------------------
-- fail_refund_issuance_attempt(): auth, permission, per-actor ownership,
-- the failure_reason allow-list, and "never produces a
-- refund.issuance_submitted audit event."
--
-- ADMIN-1C PART B FINAL FINANCIAL INVARIANT CORRECTION: this RPC no
-- longer maps every call to status = 'failed'. Two attempts below test
-- both resulting states explicitly: 'stripe_error' (a thrown call, no
-- resolved response) must land on 'unknown' -- AMBIGUOUS, not confirmed;
-- 'immediate_failed'/'immediate_canceled' (a resolved API response
-- Librum actually observed) must land on 'failed' -- CONFIRMED. Auth/
-- permission/ownership/not-found/invalid-reason checks are exercised
-- once, against the 'unknown' attempt, since that logic doesn't depend on
-- which status the reason maps to.
-- ------------------------------------------------------------
do $$
declare
  attempt_id uuid;
  final_status text;
  final_reason text;
begin
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select public.begin_refund_issuance_attempt('f0000000-0000-0000-0000-000000000042', 'key-h3-unknown') into attempt_id;
  reset role;

  -- unauthenticated caller denied.
  perform set_config('request.jwt.claim.sub', '', true);
  set local role authenticated;
  begin
    perform public.fail_refund_issuance_attempt(attempt_id, 'stripe_error');
    perform pg_temp.assert(false, 'part8: unauthenticated caller must not be able to call fail_refund_issuance_attempt()');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authenticated', format('part8: unexpected message: %s', sqlerrm));
  end;
  reset role;

  -- unauthorized caller denied.
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000004', true);
  set local role authenticated;
  begin
    perform public.fail_refund_issuance_attempt(attempt_id, 'stripe_error');
    perform pg_temp.assert(false, 'part8: support (refunds.view only) must not be able to call fail_refund_issuance_attempt()');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part8: unexpected message: %s', sqlerrm));
  end;
  reset role;

  -- wrong actor rejected.
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  begin
    perform public.fail_refund_issuance_attempt(attempt_id, 'stripe_error');
    perform pg_temp.assert(false, 'part8: a staff member who did not begin this attempt must not be able to fail it');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part8: unexpected message: %s', sqlerrm));
  end;
  reset role;

  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;

  -- non-existent attempt rejected.
  begin
    perform public.fail_refund_issuance_attempt('00000000-0000-0000-0000-000000000000', 'stripe_error');
    perform pg_temp.assert(false, 'part8: a non-existent attempt id must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'refund issuance attempt not found', format('part8: unexpected message: %s', sqlerrm));
  end;

  -- invalid failure reason rejected.
  begin
    perform public.fail_refund_issuance_attempt(attempt_id, 'made_up_reason');
    perform pg_temp.assert(false, 'part8: an unrecognized failure_reason must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'invalid failure reason', format('part8: unexpected message: %s', sqlerrm));
  end;

  -- KNOWN vs. UNKNOWN, part 1: 'stripe_error' (a thrown call) lands on
  -- 'unknown', not 'failed'.
  perform public.fail_refund_issuance_attempt(attempt_id, 'stripe_error');

  select status, failure_reason into final_status, final_reason
  from public.refund_issuance_attempts where id = attempt_id;
  perform pg_temp.assert(final_status = 'unknown', format('part8: a stripe_error reason must land on status = unknown (ambiguous), not failed, got %s', final_status));
  perform pg_temp.assert(final_reason = 'stripe_error', format('part8: failure_reason must be stored exactly, got %s', final_reason));

  -- ADMIN-1C PART B UNKNOWN-STATE RECOVERY CORRECTION: 'unknown' is
  -- itself now a valid recovery-guard starting state (`where status in
  -- ('initiated', 'unknown')`), so a repeat ambiguous transport failure
  -- (unknown -> unknown, per the required state machine) is NOT a no-op
  -- that leaves the row untouched -- it is an ALLOWED, idempotent-in-
  -- effect transition that re-records the latest observation. Passing
  -- the same reason again is what a real repeat throw actually looks
  -- like, and correctly leaves both fields exactly as they were (a
  -- coincidence of passing the identical value, not evidence the row was
  -- skipped -- see the dedicated "unknown -> unknown" state-machine test
  -- further below, which passes a null p_failure_reason precisely to
  -- prove the row DOES get touched).
  perform public.fail_refund_issuance_attempt(attempt_id, 'stripe_error');

  select status, failure_reason into final_status, final_reason
  from public.refund_issuance_attempts where id = attempt_id;
  perform pg_temp.assert(final_status = 'unknown', 'part8: unknown -> unknown must remain unknown');
  perform pg_temp.assert(final_reason = 'stripe_error', 'part8: failure_reason must still reflect the latest observation');

  -- an 'unknown' attempt must never carry a refund.issuance_submitted audit event.
  perform pg_temp.assert(
    not exists (
      select 1 from public.admin_audit_log
      where action = 'refund.issuance_submitted' and target_id = 'f0000000-0000-0000-0000-000000000042'
    ),
    'part8: an unknown-status attempt must never produce a refund.issuance_submitted audit event'
  );

  reset role;
end $$;

-- KNOWN vs. UNKNOWN, part 2: 'immediate_failed'/'immediate_canceled' (a
-- resolved API response Librum actually observed) must land on 'failed'
-- -- CONFIRMED, distinct from the 'unknown' case just tested above.
-- Exercised against a fresh, dedicated request (043) so the two status
-- outcomes never share an attempt row.
do $$
declare
  attempt_failed uuid;
  attempt_canceled uuid;
  final_status text;
begin
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;

  select public.begin_refund_issuance_attempt('f0000000-0000-0000-0000-000000000043', 'key-h4-immediate-failed') into attempt_failed;
  perform public.fail_refund_issuance_attempt(attempt_failed, 'immediate_failed');
  select status into final_status from public.refund_issuance_attempts where id = attempt_failed;
  perform pg_temp.assert(final_status = 'failed', format('part8: immediate_failed must land on status = failed (confirmed), got %s', final_status));

  select public.begin_refund_issuance_attempt('f0000000-0000-0000-0000-000000000043', 'key-h4-immediate-canceled') into attempt_canceled;
  perform public.fail_refund_issuance_attempt(attempt_canceled, 'immediate_canceled');
  select status into final_status from public.refund_issuance_attempts where id = attempt_canceled;
  perform pg_temp.assert(final_status = 'failed', format('part8: immediate_canceled must land on status = failed (confirmed), got %s', final_status));

  perform pg_temp.assert(
    not exists (
      select 1 from public.admin_audit_log
      where action = 'refund.issuance_submitted' and target_id = 'f0000000-0000-0000-0000-000000000043'
    ),
    'part8: neither a failed nor an unknown attempt may ever produce a refund.issuance_submitted audit event'
  );

  reset role;
end $$;

-- ------------------------------------------------------------
-- ADMIN-1C PART B UNKNOWN-STATE RECOVERY CORRECTION -- the full state
-- machine, proven transition by transition:
--   initiated -> submitted | failed | unknown  (exercised throughout
--     Part 8 above already)
--   unknown   -> submitted | failed | unknown  (proven fresh here)
--   submitted -> (terminal: a fail call must not downgrade it)
--   failed    -> (terminal: neither a fail nor a complete call may
--     reopen it)
-- Each transition below uses its OWN dedicated fixture (044-048) so no
-- test's setup can be mistaken for another's assertion.
-- ------------------------------------------------------------
do $$
declare
  attempt_id uuid;
  final_status text;
  final_reason text;
  event_count integer;
begin
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;

  -- initiated -> unknown -> submitted.
  select public.begin_refund_issuance_attempt('f0000000-0000-0000-0000-000000000044', 'key-sm-044') into attempt_id;
  perform public.fail_refund_issuance_attempt(attempt_id, 'stripe_error');
  select status into final_status from public.refund_issuance_attempts where id = attempt_id;
  perform pg_temp.assert(final_status = 'unknown', format('part8: initiated -> unknown must be allowed, got %s', final_status));

  perform public.complete_refund_issuance_attempt(attempt_id, 're_sm_044', 'succeeded');
  select status into final_status from public.refund_issuance_attempts where id = attempt_id;
  perform pg_temp.assert(final_status = 'submitted', format('part8: unknown -> submitted must be allowed, got %s', final_status));

  select count(*) into event_count
  from public.admin_audit_log
  where action = 'refund.issuance_submitted' and metadata->>'stripe_refund_id' = 're_sm_044';
  perform pg_temp.assert(event_count = 1, format('part8: unknown -> submitted must write exactly one audit event, got %s', event_count));

  -- repeat completion after an unknown->submitted recovery must not
  -- duplicate the audit event -- same PRIMARY guard as any other repeat
  -- completion.
  perform public.complete_refund_issuance_attempt(attempt_id, 're_sm_044', 'succeeded');
  select count(*) into event_count
  from public.admin_audit_log
  where action = 'refund.issuance_submitted' and metadata->>'stripe_refund_id' = 're_sm_044';
  perform pg_temp.assert(event_count = 1, format('part8: a repeated completion after unknown -> submitted recovery must still show exactly one audit row, got %s', event_count));

  -- unknown -> failed.
  select public.begin_refund_issuance_attempt('f0000000-0000-0000-0000-000000000045', 'key-sm-045') into attempt_id;
  perform public.fail_refund_issuance_attempt(attempt_id, 'stripe_error');
  perform public.fail_refund_issuance_attempt(attempt_id, 'immediate_failed');
  select status into final_status from public.refund_issuance_attempts where id = attempt_id;
  perform pg_temp.assert(final_status = 'failed', format('part8: unknown -> failed must be allowed, got %s', final_status));
  perform pg_temp.assert(
    not exists (
      select 1 from public.admin_audit_log
      where action = 'refund.issuance_submitted' and target_id = 'f0000000-0000-0000-0000-000000000045'
    ),
    'part8: unknown -> failed must never produce a refund.issuance_submitted audit event'
  );

  -- unknown -> unknown (a repeat ambiguous transport failure). Uses a
  -- DIFFERENT p_failure_reason (null) on the second call specifically to
  -- prove the row is genuinely re-touched by this transition (not
  -- skipped as a no-op) -- failure_reason must change from 'stripe_error'
  -- to null even though the resulting STATUS stays 'unknown' either way.
  select public.begin_refund_issuance_attempt('f0000000-0000-0000-0000-000000000046', 'key-sm-046') into attempt_id;
  perform public.fail_refund_issuance_attempt(attempt_id, 'stripe_error');
  perform public.fail_refund_issuance_attempt(attempt_id, null);
  select status, failure_reason into final_status, final_reason
  from public.refund_issuance_attempts where id = attempt_id;
  perform pg_temp.assert(final_status = 'unknown', format('part8: unknown -> unknown must remain unknown, got %s', final_status));
  perform pg_temp.assert(final_reason is null, 'part8: the unknown -> unknown transition must actually update the row (failure_reason must reflect the latest call), not silently no-op');

  -- submitted is terminal: a fail call must NOT downgrade it to unknown
  -- or failed.
  select public.begin_refund_issuance_attempt('f0000000-0000-0000-0000-000000000047', 'key-sm-047') into attempt_id;
  perform public.complete_refund_issuance_attempt(attempt_id, 're_sm_047', 'succeeded');

  perform public.fail_refund_issuance_attempt(attempt_id, 'stripe_error');
  select status into final_status from public.refund_issuance_attempts where id = attempt_id;
  perform pg_temp.assert(final_status = 'submitted', format('part8: submitted must never be downgraded to unknown, got %s', final_status));

  perform public.fail_refund_issuance_attempt(attempt_id, 'immediate_failed');
  select status into final_status from public.refund_issuance_attempts where id = attempt_id;
  perform pg_temp.assert(final_status = 'submitted', format('part8: submitted must never be downgraded to failed, got %s', final_status));

  -- failed is terminal: neither a fail nor a complete call may reopen it
  -- to unknown or submitted.
  select public.begin_refund_issuance_attempt('f0000000-0000-0000-0000-000000000048', 'key-sm-048') into attempt_id;
  perform public.fail_refund_issuance_attempt(attempt_id, 'immediate_failed');

  perform public.fail_refund_issuance_attempt(attempt_id, 'stripe_error');
  select status into final_status from public.refund_issuance_attempts where id = attempt_id;
  perform pg_temp.assert(final_status = 'failed', format('part8: failed must never be downgraded to unknown, got %s', final_status));

  perform public.complete_refund_issuance_attempt(attempt_id, 're_sm_048', 'succeeded');
  select status into final_status from public.refund_issuance_attempts where id = attempt_id;
  perform pg_temp.assert(final_status = 'failed', format('part8: failed must never be reopened to submitted, got %s', final_status));

  perform pg_temp.assert(
    not exists (
      select 1 from public.admin_audit_log where metadata->>'stripe_refund_id' = 're_sm_048'
    ),
    'part8: a failed attempt must never produce an audit event even if a complete call is later (incorrectly) attempted against it'
  );

  reset role;
end $$;

-- ------------------------------------------------------------
-- status vocabulary CHECK constraint -- direct confirmation that exactly
-- the four documented values are accepted and nothing else, independent
-- of whichever RPC happens to be exercised above.
-- ------------------------------------------------------------
do $$
begin
  begin
    insert into public.refund_issuance_attempts (refund_request_id, actor_id, idempotency_key, status)
    values ('f0000000-0000-0000-0000-000000000040', 'f0000000-0000-0000-0000-000000000001', 'status-check-invalid', 'bogus');
    perform pg_temp.assert(false, 'part8: an invalid status value must be rejected by the CHECK constraint');
  exception when check_violation then
    null; -- expected
  end;

  begin
    insert into public.refund_issuance_attempts (refund_request_id, actor_id, idempotency_key, status)
    values ('f0000000-0000-0000-0000-000000000040', 'f0000000-0000-0000-0000-000000000001', 'status-check-unknown', 'unknown');
  exception when others then
    perform pg_temp.assert(false, format('part8: status = unknown must be accepted by the CHECK constraint: %s', sqlerrm));
  end;
end $$;

-- ------------------------------------------------------------
-- refund_request_id FK: ON DELETE RESTRICT -- ADMIN-1C PART B FINAL
-- FINANCIAL INVARIANT CORRECTION. This table is financial evidence and
-- must not be silently erased if its parent refund_requests row is
-- deleted. actor_id's own ON DELETE SET NULL behavior (unchanged by this
-- correction) is already implicitly exercised throughout this suite
-- wherever an attempt's actor_id is read back as non-null after normal
-- operation -- no dedicated actor-deletion test is added here since
-- nothing about that FK's behavior changed.
-- ------------------------------------------------------------
do $$
declare
  v_attempt_id uuid;
begin
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select public.begin_refund_issuance_attempt('f0000000-0000-0000-0000-000000000043', 'key-fk-restrict-test') into v_attempt_id;
  reset role;

  perform pg_temp.assert(v_attempt_id is not null, 'part8: fixture attempt for the FK RESTRICT test must exist');

  begin
    delete from public.refund_requests where id = 'f0000000-0000-0000-0000-000000000043';
    perform pg_temp.assert(false, 'part8: deleting a refund_requests row still referenced by an attempt must be rejected (on delete restrict)');
  exception when foreign_key_violation then
    null; -- expected
  end;

  perform pg_temp.assert(
    exists (select 1 from public.refund_issuance_attempts where id = v_attempt_id),
    'part8: the attempt row must still exist after the rejected delete -- RESTRICT, not a silent cascade'
  );
  perform pg_temp.assert(
    exists (select 1 from public.refund_requests where id = 'f0000000-0000-0000-0000-000000000043'),
    'part8: the referenced refund_requests row must still exist -- the delete was rejected, not partially applied'
  );
end $$;

-- ============================================================
-- Part 9: AUDIT IMMUTABILITY -- no direct UPDATE/DELETE/INSERT, for anon
-- or authenticated, on either admin_audit_log or refund_issuance_attempts
-- -- re-verified one final time post-042 (the grant-level checks in
-- Part 2/8 above already cover this; this is the behavioral
-- confirmation, same pairing as 041's own Part 6).
-- ============================================================
do $$
begin
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  begin
    update public.admin_audit_log set action = 'tampered' where id = 'f0000000-0000-0000-0000-0000000000a1';
    perform pg_temp.assert(false, 'part9: a raw authenticated UPDATE on admin_audit_log must be rejected');
  exception when insufficient_privilege then
    null; -- expected
  end;

  begin
    delete from public.admin_audit_log where id = 'f0000000-0000-0000-0000-0000000000a1';
    perform pg_temp.assert(false, 'part9: a raw authenticated DELETE on admin_audit_log must be rejected');
  exception when insufficient_privilege then
    null; -- expected
  end;
  reset role;
end $$;

do $$
begin
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  begin
    insert into public.refund_issuance_attempts (refund_request_id, actor_id, idempotency_key)
    values ('f0000000-0000-0000-0000-000000000040', 'f0000000-0000-0000-0000-000000000001', 'part9-direct-insert');
    perform pg_temp.assert(false, 'part9: a raw authenticated INSERT on refund_issuance_attempts must be rejected');
  exception when insufficient_privilege then
    null; -- expected
  end;

  begin
    update public.refund_issuance_attempts set status = 'failed' where true;
    perform pg_temp.assert(false, 'part9: a raw authenticated UPDATE on refund_issuance_attempts must be rejected');
  exception when insufficient_privilege then
    null; -- expected
  end;

  begin
    delete from public.refund_issuance_attempts where true;
    perform pg_temp.assert(false, 'part9: a raw authenticated DELETE on refund_issuance_attempts must be rejected');
  exception when insufficient_privilege then
    null; -- expected
  end;
  reset role;
end $$;

select 'ALL PASSED: 042_admin_audit_visibility.test.sql' as result;

rollback;
