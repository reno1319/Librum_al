-- Committed SQL regression suite for migration 043 (ADMIN-1D Part B:
-- finance.view permission, refund_reconciliation_rows() private helper,
-- list_refund_reconciliation_states(), list_finance_disputes(),
-- list_finance_checkout_exceptions(),
-- list_finance_refund_entitlement_mismatches(), get_finance_summary_
-- counts()). Read-only additions only -- no test here ever calls
-- begin_/complete_/fail_refund_issuance_attempt(), review_refund_
-- request(), or any Stripe-mutating path; every refund_issuance_
-- attempts/payment_disputes/book_checkout_intents/bundle_checkout_
-- snapshots row this suite needs is inserted directly.
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
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/043_finance_reconciliation_reads.test.sql
--
-- This file was written and reviewed as part of ADMIN-1D Part B's
-- implementation but has NOT been executed in this environment -- no
-- local/CI Postgres was available (same limitation every prior
-- migration's own test file in this directory already documents). It is
-- a reviewed contract, not a confirmed-passing result.
--
-- ============================================================
-- TIMESTAMP NOTE (same discipline as 042_admin_audit_visibility.test.sql):
-- everything in this file runs inside ONE transaction, so now() is
-- CONSTANT throughout. Every staleness/threshold fixture below is seeded
-- with an EXPLICIT `now() - interval '...'` value at INSERT time -- since
-- the RPCs under test evaluate their own `now() - interval '...'`
-- comparisons against that SAME frozen now() later in this same
-- transaction, the arithmetic is exact and deterministic, not
-- approximate or timing-sensitive.
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
-- Shared fixtures: one staff member per role, a non-staff user, one
-- author, one reader, one book, one bundle -- reused across every Part
-- below. Distinct UUID prefix (a0430000-...) from 042's own fixtures
-- (f0000000-...) purely for readability; each suite runs in its own
-- disposable database per the documented workflow above, so collision
-- is not actually possible either way.
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a0430000-0000-0000-0000-000000000001', 'p043-owner@test', now(), '{"role":"reader","display_name":"Owner"}'),
  ('a0430000-0000-0000-0000-000000000002', 'p043-admin@test', now(), '{"role":"reader","display_name":"Admin"}'),
  ('a0430000-0000-0000-0000-000000000003', 'p043-moderator@test', now(), '{"role":"reader","display_name":"Moderator"}'),
  ('a0430000-0000-0000-0000-000000000004', 'p043-support@test', now(), '{"role":"reader","display_name":"Support"}'),
  ('a0430000-0000-0000-0000-000000000005', 'p043-editor@test', now(), '{"role":"reader","display_name":"Editor"}'),
  ('a0430000-0000-0000-0000-000000000006', 'p043-nonstaff@test', now(), '{"role":"reader","display_name":"Non-staff"}'),
  ('a0430000-0000-0000-0000-000000000007', 'p043-author@test', now(), '{"role":"author","display_name":"Author"}'),
  ('a0430000-0000-0000-0000-000000000008', 'p043-reader@test', now(), '{"role":"reader","display_name":"Reader"}');

insert into public.staff_members (user_id, role) values
  ('a0430000-0000-0000-0000-000000000001', 'owner'),
  ('a0430000-0000-0000-0000-000000000002', 'admin'),
  ('a0430000-0000-0000-0000-000000000003', 'moderator'),
  ('a0430000-0000-0000-0000-000000000004', 'support'),
  ('a0430000-0000-0000-0000-000000000005', 'editor');

insert into public.books (id, author_id, title, description, preview_text, keywords, status) values
  ('a0430000-0000-0000-0000-000000000010', 'a0430000-0000-0000-0000-000000000007',
   'Test Book', '', '', '', 'published');

insert into public.bundles (id, author_id, title, description, price_cents, status) values
  ('a0430000-0000-0000-0000-000000000011', 'a0430000-0000-0000-0000-000000000007',
   'Test Bundle', '', 2999, 'published');

-- ============================================================
-- Part 1: PERMISSION MATRIX -- finance.view added, every other
-- permission re-verified UNCHANGED, all 5 roles x 9 permissions.
-- Mirrors 042's own Part 1 exhaustive-matrix pattern exactly, extended
-- by one column.
-- ============================================================
do $$
declare
  matrix jsonb := '{
    "a0430000-0000-0000-0000-000000000001": {
      "admin.access": true, "reports.view": true, "reports.resolve": true,
      "refunds.view": true, "refunds.resolve": true, "staff.view": true,
      "staff.manage": true, "audit.view": true, "finance.view": true
    },
    "a0430000-0000-0000-0000-000000000002": {
      "admin.access": true, "reports.view": true, "reports.resolve": true,
      "refunds.view": true, "refunds.resolve": true, "staff.view": true,
      "staff.manage": false, "audit.view": true, "finance.view": true
    },
    "a0430000-0000-0000-0000-000000000003": {
      "admin.access": true, "reports.view": true, "reports.resolve": true,
      "refunds.view": false, "refunds.resolve": false, "staff.view": false,
      "staff.manage": false, "audit.view": false, "finance.view": false
    },
    "a0430000-0000-0000-0000-000000000004": {
      "admin.access": true, "reports.view": false, "reports.resolve": false,
      "refunds.view": true, "refunds.resolve": false, "staff.view": false,
      "staff.manage": false, "audit.view": false, "finance.view": false
    },
    "a0430000-0000-0000-0000-000000000005": {
      "admin.access": false, "reports.view": false, "reports.resolve": false,
      "refunds.view": false, "refunds.resolve": false, "staff.view": false,
      "staff.manage": false, "audit.view": false, "finance.view": false
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
-- Part 2: RPC SECURITY -- every new RPC: unauthenticated denied, owner
-- allowed, admin allowed, moderator/support/editor denied. Plus catalog
-- checks: SECURITY DEFINER, search_path = '', EXECUTE grants hardened
-- (anon/public denied, authenticated granted -- except the private
-- helper, which nobody but another SECURITY DEFINER function may call).
-- ============================================================
do $$
declare
  fn_oid oid;
begin
  -- refund_reconciliation_rows(): the PRIVATE helper -- no grant to
  -- anon/authenticated/public at all.
  select p.oid into fn_oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'refund_reconciliation_rows';
  perform pg_temp.assert(fn_oid is not null, 'part2: refund_reconciliation_rows() must exist');
  perform pg_temp.assert((select prosecdef from pg_proc where oid = fn_oid), 'part2: refund_reconciliation_rows() must be SECURITY DEFINER');
  perform pg_temp.assert((select proconfig from pg_proc where oid = fn_oid) @> array['search_path='], 'part2: refund_reconciliation_rows() must set search_path = empty');
  perform pg_temp.assert(not has_function_privilege('authenticated', fn_oid, 'EXECUTE'), 'part2: authenticated must NOT have EXECUTE on the private helper');
  perform pg_temp.assert(not has_function_privilege('anon', fn_oid, 'EXECUTE'), 'part2: anon must NOT have EXECUTE on the private helper');
  perform pg_temp.assert(not has_function_privilege('public', fn_oid, 'EXECUTE'), 'part2: public must NOT have EXECUTE on the private helper');

  for fn_oid in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'list_refund_reconciliation_states', 'list_finance_disputes',
      'list_finance_checkout_exceptions', 'list_finance_refund_entitlement_mismatches',
      'get_finance_summary_counts'
    )
  loop
    perform pg_temp.assert((select prosecdef from pg_proc where oid = fn_oid), format('part2: %s must be SECURITY DEFINER', fn_oid::regprocedure));
    perform pg_temp.assert((select proconfig from pg_proc where oid = fn_oid) @> array['search_path='], format('part2: %s must set search_path = empty', fn_oid::regprocedure));
    perform pg_temp.assert(has_function_privilege('authenticated', fn_oid, 'EXECUTE'), format('part2: authenticated must have EXECUTE on %s', fn_oid::regprocedure));
    perform pg_temp.assert(not has_function_privilege('anon', fn_oid, 'EXECUTE'), format('part2: anon must NOT have EXECUTE on %s', fn_oid::regprocedure));
    perform pg_temp.assert(not has_function_privilege('public', fn_oid, 'EXECUTE'), format('part2: public must NOT have EXECUTE on %s', fn_oid::regprocedure));
  end loop;
end $$;

-- Behavioral auth/permission gate, exercised against one representative
-- RPC (list_refund_reconciliation_states) -- the other four share the
-- identical `if auth.uid() is null ... if not staff_has_permission(
-- 'finance.view') ...` guard, verified once here is sufficient given
-- Part 1 already independently proves the permission matrix itself.
do $$
begin
  -- unauthenticated denied.
  perform set_config('request.jwt.claim.sub', '', true);
  set local role authenticated;
  begin
    perform * from public.list_refund_reconciliation_states();
    perform pg_temp.assert(false, 'part2: unauthenticated caller must be denied');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authenticated', format('part2: unexpected message: %s', sqlerrm));
  end;
  reset role;

  -- owner allowed.
  perform set_config('request.jwt.claim.sub', 'a0430000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  perform * from public.list_refund_reconciliation_states();
  reset role;

  -- admin allowed.
  perform set_config('request.jwt.claim.sub', 'a0430000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  perform * from public.list_refund_reconciliation_states();
  reset role;

  -- moderator denied.
  perform set_config('request.jwt.claim.sub', 'a0430000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  begin
    perform * from public.list_refund_reconciliation_states();
    perform pg_temp.assert(false, 'part2: moderator must be denied finance.view');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part2: unexpected message: %s', sqlerrm));
  end;
  reset role;

  -- support denied.
  perform set_config('request.jwt.claim.sub', 'a0430000-0000-0000-0000-000000000004', true);
  set local role authenticated;
  begin
    perform * from public.list_refund_reconciliation_states();
    perform pg_temp.assert(false, 'part2: support must be denied finance.view');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part2: unexpected message: %s', sqlerrm));
  end;
  reset role;

  -- editor denied.
  perform set_config('request.jwt.claim.sub', 'a0430000-0000-0000-0000-000000000005', true);
  set local role authenticated;
  begin
    perform * from public.list_refund_reconciliation_states();
    perform pg_temp.assert(false, 'part2: editor must be denied finance.view');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part2: unexpected message: %s', sqlerrm));
  end;
  reset role;
end $$;

-- ============================================================
-- Part 3: REFUND OPERATIONAL-STATE CLASSIFICATION -- one fixture per
-- required scenario, exact assertions on both operational_state and
-- needs_attention. Explicitly proves 'initiated' is NEVER read as "Stripe
-- was never called" -- both a fresh and a stale 'initiated' row are
-- tested, and the stale one is asserted to be flagged for reconciliation
-- (needs_attention = true), never silently treated as safe.
-- ============================================================
insert into public.refund_requests (id, reader_id, stripe_payment_intent_id, amount_cents, status, requested_at, reviewed_at) values
  -- terminal/base states
  ('a0430000-0000-0000-0000-000000000100', 'a0430000-0000-0000-0000-000000000008', 'pi_043_requested', 1000, 'requested', now(), null),
  ('a0430000-0000-0000-0000-000000000101', 'a0430000-0000-0000-0000-000000000008', 'pi_043_rejected', 1000, 'rejected', now(), now()),
  ('a0430000-0000-0000-0000-000000000102', 'a0430000-0000-0000-0000-000000000008', 'pi_043_refunded', 1000, 'refunded', now(), now()),
  ('a0430000-0000-0000-0000-000000000103', 'a0430000-0000-0000-0000-000000000008', 'pi_043_cancelled', 1000, 'cancelled', now(), null),
  -- approved, zero attempts, approved SECONDS ago -- ADMIN-1D PART B
  -- FINAL PRE-COMMIT CLASSIFICATION CORRECTION: needs_attention must be
  -- true IMMEDIATELY, no grace period. "Fresh" no longer means "not
  -- flagged" for this state -- issuing an approved refund is the last
  -- step of a workflow Librum itself already decided to complete.
  ('a0430000-0000-0000-0000-000000000104', 'a0430000-0000-0000-0000-000000000008', 'pi_043_unattempted_just_now', 1000, 'approved', now(), now()),
  -- approved, zero attempts, approved 25 hours ago -- proves there is NO
  -- 24-hour (or any other) dependency: this must classify and flag
  -- IDENTICALLY to the "just now" fixture above, not differently by age.
  ('a0430000-0000-0000-0000-000000000105', 'a0430000-0000-0000-0000-000000000008', 'pi_043_unattempted_long_ago', 1000, 'approved', now() - interval '2 days', now() - interval '25 hours'),
  -- approved, recent initiated attempt (2 minutes old, under the 5-minute threshold)
  ('a0430000-0000-0000-0000-000000000106', 'a0430000-0000-0000-0000-000000000008', 'pi_043_initiated_fresh', 1000, 'approved', now(), now()),
  -- approved, stale initiated attempt (10 minutes old, well past the 5-minute threshold)
  ('a0430000-0000-0000-0000-000000000107', 'a0430000-0000-0000-0000-000000000008', 'pi_043_initiated_stale', 1000, 'approved', now(), now()),
  -- approved, initiated attempt EXACTLY at the 5-minute boundary -- proves
  -- the inclusive-stale boundary semantics precisely (operational_state
  -- and needs_attention must agree at this exact instant).
  ('a0430000-0000-0000-0000-00000000010e', 'a0430000-0000-0000-0000-000000000008', 'pi_043_initiated_boundary', 1000, 'approved', now(), now()),
  -- approved, unknown attempt
  ('a0430000-0000-0000-0000-000000000108', 'a0430000-0000-0000-0000-000000000008', 'pi_043_unknown', 1000, 'approved', now(), now()),
  -- approved, failed attempt
  ('a0430000-0000-0000-0000-000000000109', 'a0430000-0000-0000-0000-000000000008', 'pi_043_failed', 1000, 'approved', now(), now()),
  -- approved, submitted attempt, fresh (10 minutes since transition, under the 1h threshold)
  ('a0430000-0000-0000-0000-00000000010a', 'a0430000-0000-0000-0000-000000000008', 'pi_043_submitted_fresh', 1000, 'approved', now(), now()),
  -- approved, submitted attempt, stale (2 hours since transition, past the 1h threshold)
  ('a0430000-0000-0000-0000-00000000010b', 'a0430000-0000-0000-0000-000000000008', 'pi_043_submitted_stale', 1000, 'approved', now(), now()),
  -- approved with MULTIPLE attempts (a genuine retry after a failed attempt) -- the
  -- classification must reflect the LATEST attempt (submitted), never the earlier failed one.
  ('a0430000-0000-0000-0000-00000000010c', 'a0430000-0000-0000-0000-000000000008', 'pi_043_multi_attempt', 1000, 'approved', now(), now());

insert into public.refund_issuance_attempts (id, refund_request_id, actor_id, idempotency_key, status, stripe_refund_id, stripe_status, created_at, updated_at) values
  ('a0430000-0000-0000-0000-000000000200', 'a0430000-0000-0000-0000-000000000106', 'a0430000-0000-0000-0000-000000000001', 'key-initiated-fresh', 'initiated', null, null, now() - interval '2 minutes', now() - interval '2 minutes'),
  ('a0430000-0000-0000-0000-000000000201', 'a0430000-0000-0000-0000-000000000107', 'a0430000-0000-0000-0000-000000000001', 'key-initiated-stale', 'initiated', null, null, now() - interval '10 minutes', now() - interval '10 minutes'),
  -- EXACTLY at the 5-minute boundary: created_at = now() - interval '5 minutes' precisely.
  ('a0430000-0000-0000-0000-000000000208', 'a0430000-0000-0000-0000-00000000010e', 'a0430000-0000-0000-0000-000000000001', 'key-initiated-boundary', 'initiated', null, null, now() - interval '5 minutes', now() - interval '5 minutes'),
  ('a0430000-0000-0000-0000-000000000202', 'a0430000-0000-0000-0000-000000000108', 'a0430000-0000-0000-0000-000000000001', 'key-unknown', 'unknown', null, null, now() - interval '1 minute', now() - interval '1 minute'),
  ('a0430000-0000-0000-0000-000000000203', 'a0430000-0000-0000-0000-000000000109', 'a0430000-0000-0000-0000-000000000001', 'key-failed', 'failed', null, null, now() - interval '1 minute', now() - interval '1 minute'),
  ('a0430000-0000-0000-0000-000000000204', 'a0430000-0000-0000-0000-00000000010a', 'a0430000-0000-0000-0000-000000000001', 'key-submitted-fresh', 'submitted', 're_test_fresh', 'succeeded', now() - interval '15 minutes', now() - interval '10 minutes'),
  ('a0430000-0000-0000-0000-000000000205', 'a0430000-0000-0000-0000-00000000010b', 'a0430000-0000-0000-0000-000000000001', 'key-submitted-stale', 'submitted', 're_test_stale', 'succeeded', now() - interval '3 hours', now() - interval '2 hours'),
  -- multi-attempt: an EARLIER failed attempt, then a LATER (higher created_at) submitted attempt
  ('a0430000-0000-0000-0000-000000000206', 'a0430000-0000-0000-0000-00000000010c', 'a0430000-0000-0000-0000-000000000001', 'key-multi-1', 'failed', null, null, now() - interval '30 minutes', now() - interval '30 minutes'),
  ('a0430000-0000-0000-0000-000000000207', 'a0430000-0000-0000-0000-00000000010c', 'a0430000-0000-0000-0000-000000000001', 'key-multi-2-after-failed', 'submitted', 're_test_multi', 'succeeded', now() - interval '5 minutes', now() - interval '5 minutes');

do $$
declare
  r record;
begin
  perform set_config('request.jwt.claim.sub', 'a0430000-0000-0000-0000-000000000001', true);
  set local role authenticated;

  select * into r from public.list_refund_reconciliation_states(p_limit := 100) x where x.refund_request_id = 'a0430000-0000-0000-0000-000000000100';
  perform pg_temp.assert(r.operational_state = 'requested', format('part3: requested expected, got %s', r.operational_state));
  perform pg_temp.assert(r.needs_attention = false, 'part3: requested must not need attention');

  select * into r from public.list_refund_reconciliation_states(p_limit := 100) x where x.refund_request_id = 'a0430000-0000-0000-0000-000000000101';
  perform pg_temp.assert(r.operational_state = 'rejected', format('part3: rejected expected, got %s', r.operational_state));
  perform pg_temp.assert(r.needs_attention = false, 'part3: rejected must not need attention');

  select * into r from public.list_refund_reconciliation_states(p_limit := 100) x where x.refund_request_id = 'a0430000-0000-0000-0000-000000000102';
  perform pg_temp.assert(r.operational_state = 'refunded', format('part3: refunded expected, got %s', r.operational_state));
  perform pg_temp.assert(r.needs_attention = false, 'part3: refunded (completed) must not need attention');

  select * into r from public.list_refund_reconciliation_states(p_limit := 100) x where x.refund_request_id = 'a0430000-0000-0000-0000-000000000103';
  perform pg_temp.assert(r.operational_state = 'cancelled', format('part3: cancelled expected, got %s', r.operational_state));

  -- A + B: approved, zero attempts -- needs_attention = true IMMEDIATELY,
  -- with NO 24-hour (or any) dependency. Both the "just now" fixture and
  -- the "25 hours ago" fixture must classify and flag IDENTICALLY --
  -- proving age plays no role in this state's needs_attention at all.
  select * into r from public.list_refund_reconciliation_states(p_limit := 100) x where x.refund_request_id = 'a0430000-0000-0000-0000-000000000104';
  perform pg_temp.assert(r.operational_state = 'approved_unattempted', format('part3: approved_unattempted (just now) expected, got %s', r.operational_state));
  perform pg_temp.assert(r.needs_attention = true, 'part3: an approved, never-attempted refund MUST need attention immediately -- no grace period');

  select * into r from public.list_refund_reconciliation_states(p_limit := 100) x where x.refund_request_id = 'a0430000-0000-0000-0000-000000000105';
  perform pg_temp.assert(r.operational_state = 'approved_unattempted', format('part3: approved_unattempted (25h ago) expected, got %s', r.operational_state));
  perform pg_temp.assert(r.needs_attention = true, 'part3: an approved-25h-ago, never-attempted refund must ALSO need attention -- proving no 24-hour dependency exists');

  select * into r from public.list_refund_reconciliation_states(p_limit := 100) x where x.refund_request_id = 'a0430000-0000-0000-0000-000000000106';
  perform pg_temp.assert(r.operational_state = 'approved_attempt_initiated', format('part3: approved_attempt_initiated expected, got %s', r.operational_state));
  perform pg_temp.assert(r.needs_attention = false, 'part3: a 2-minute-old initiated attempt must NOT be flagged -- still plausibly in flight');

  select * into r from public.list_refund_reconciliation_states(p_limit := 100) x where x.refund_request_id = 'a0430000-0000-0000-0000-000000000107';
  perform pg_temp.assert(r.operational_state = 'approved_attempt_stale_initiated', format('part3: approved_attempt_stale_initiated expected, got %s', r.operational_state));
  perform pg_temp.assert(r.needs_attention = true, 'part3: a 10-minute-old initiated attempt MUST be flagged as ambiguous/unresolved -- never treated as "Stripe was never called"');

  -- D (boundary): an attempt EXACTLY 5 minutes old must classify as
  -- STALE (inclusive boundary), and operational_state/needs_attention
  -- must agree with each other at this exact instant -- never "fresh" in
  -- one field and "needs attention" in the other.
  select * into r from public.list_refund_reconciliation_states(p_limit := 100) x where x.refund_request_id = 'a0430000-0000-0000-0000-00000000010e';
  perform pg_temp.assert(r.operational_state = 'approved_attempt_stale_initiated', format('part3: an attempt exactly 5 minutes old must classify as stale (inclusive boundary), got %s', r.operational_state));
  perform pg_temp.assert(r.needs_attention = true, 'part3: an attempt exactly 5 minutes old must need attention -- consistent with its own stale operational_state');

  select * into r from public.list_refund_reconciliation_states(p_limit := 100) x where x.refund_request_id = 'a0430000-0000-0000-0000-000000000108';
  perform pg_temp.assert(r.operational_state = 'approved_attempt_unknown', format('part3: approved_attempt_unknown expected, got %s', r.operational_state));
  perform pg_temp.assert(r.needs_attention = true, 'part3: an unknown attempt always needs attention, regardless of age');

  select * into r from public.list_refund_reconciliation_states(p_limit := 100) x where x.refund_request_id = 'a0430000-0000-0000-0000-000000000109';
  perform pg_temp.assert(r.operational_state = 'approved_attempt_failed', format('part3: approved_attempt_failed expected, got %s', r.operational_state));
  perform pg_temp.assert(r.needs_attention = true, 'part3: a failed attempt always needs attention (retry candidate)');

  select * into r from public.list_refund_reconciliation_states(p_limit := 100) x where x.refund_request_id = 'a0430000-0000-0000-0000-00000000010a';
  perform pg_temp.assert(r.operational_state = 'approved_attempt_submitted', format('part3: approved_attempt_submitted (fresh) expected, got %s', r.operational_state));
  perform pg_temp.assert(r.needs_attention = false, 'part3: a submitted attempt only 10 minutes old must NOT be flagged -- normal webhook-settlement window');
  perform pg_temp.assert(r.stripe_refund_id = 're_test_fresh', 'part3: stripe_refund_id must be surfaced from the latest attempt');

  select * into r from public.list_refund_reconciliation_states(p_limit := 100) x where x.refund_request_id = 'a0430000-0000-0000-0000-00000000010b';
  perform pg_temp.assert(r.operational_state = 'approved_attempt_submitted', format('part3: approved_attempt_submitted (stale) expected, got %s', r.operational_state));
  perform pg_temp.assert(r.needs_attention = true, 'part3: a submitted attempt 2 hours old with no settlement MUST be flagged');

  -- MULTIPLE ATTEMPTS: the classification must reflect the LATEST attempt
  -- (submitted, created 5 minutes ago), never the earlier failed one
  -- (created 30 minutes ago) -- proves deterministic latest-attempt
  -- selection, not "first attempt found" or "any failed attempt wins."
  select * into r from public.list_refund_reconciliation_states(p_limit := 100) x where x.refund_request_id = 'a0430000-0000-0000-0000-00000000010c';
  perform pg_temp.assert(r.operational_state = 'approved_attempt_submitted', format('part3: multi-attempt must classify from the LATEST (submitted) attempt, got %s', r.operational_state));
  perform pg_temp.assert(r.latest_attempt_id = 'a0430000-0000-0000-0000-000000000207', 'part3: latest_attempt_id must be the newer submitted attempt, not the earlier failed one');
  perform pg_temp.assert(r.stripe_refund_id = 're_test_multi', 'part3: stripe_refund_id must come from the latest attempt');

  reset role;
end $$;

-- ============================================================
-- Part 3b: DETERMINISTIC TIE-BREAK -- two attempts with an IDENTICAL
-- created_at (a genuine race is not reproducible in a single-session
-- harness, but the tie-break itself -- id DESC -- is directly testable
-- by inserting two rows sharing one timestamp).
-- ============================================================
insert into public.refund_requests (id, reader_id, stripe_payment_intent_id, amount_cents, status, requested_at, reviewed_at) values
  ('a0430000-0000-0000-0000-00000000010d', 'a0430000-0000-0000-0000-000000000008', 'pi_043_tie_break', 1000, 'approved', now(), now());

do $$
declare
  tied_ts timestamptz := now() - interval '1 minute';
  lower_id uuid := 'a0430000-0000-0000-0000-000000000210';
  higher_id uuid := 'a0430000-0000-0000-0000-000000000211';
  r record;
begin
  insert into public.refund_issuance_attempts (id, refund_request_id, actor_id, idempotency_key, status, created_at, updated_at) values
    (lower_id, 'a0430000-0000-0000-0000-00000000010d', 'a0430000-0000-0000-0000-000000000001', 'key-tie-lower', 'failed', tied_ts, tied_ts),
    (higher_id, 'a0430000-0000-0000-0000-00000000010d', 'a0430000-0000-0000-0000-000000000001', 'key-tie-higher', 'unknown', tied_ts, tied_ts);

  perform set_config('request.jwt.claim.sub', 'a0430000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select * into r from public.list_refund_reconciliation_states(p_limit := 100) x where x.refund_request_id = 'a0430000-0000-0000-0000-00000000010d';
  reset role;

  perform pg_temp.assert(r.latest_attempt_id = higher_id, format('part3b: tie on created_at must break deterministically on id DESC -- expected %s, got %s', higher_id, r.latest_attempt_id));
  perform pg_temp.assert(r.operational_state = 'approved_attempt_unknown', 'part3b: the higher-id attempt (unknown) must win the tie, not the lower-id one (failed)');
end $$;

-- ============================================================
-- Part 4: FILTERING + PAGINATION
-- ============================================================
do $$
declare
  cnt integer;
begin
  perform set_config('request.jwt.claim.sub', 'a0430000-0000-0000-0000-000000000001', true);
  set local role authenticated;

  select count(*) into cnt from public.list_refund_reconciliation_states(p_operational_state := 'approved_attempt_unknown', p_limit := 100);
  perform pg_temp.assert(cnt = 1, format('part4: exactly one approved_attempt_unknown row expected, got %s', cnt));

  select count(*) into cnt from public.list_refund_reconciliation_states(p_needs_attention := true, p_limit := 100);
  perform pg_temp.assert(cnt >= 5, format('part4: at least 5 needs_attention rows expected from Part 3''s fixtures, got %s', cnt));

  select count(*) into cnt from public.list_refund_reconciliation_states(p_needs_attention := false, p_limit := 100)
    where refund_request_status = 'requested';
  perform pg_temp.assert(cnt = 1, 'part4: requested/rejected/refunded/cancelled rows must still appear when needs_attention filter is false -- this is a COMPLETE state list, not exceptions-only');

  begin
    perform * from public.list_refund_reconciliation_states(p_operational_state := 'not_a_real_state');
    perform pg_temp.assert(false, 'part4: an invalid operational_state filter must raise');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'invalid operational_state filter', format('part4: unexpected message: %s', sqlerrm));
  end;

  reset role;
end $$;

-- ============================================================
-- Part 5: DISPUTE RPC -- terminal vs non-terminal, reversal
-- failed/attempting-stale/succeeded, no invented evidence deadline, no
-- raw failure_message leakage.
-- ============================================================
insert into public.payment_disputes (
  id, stripe_dispute_id, stripe_payment_intent_id, status, reason, amount_cents,
  transfer_reversal_status, transfer_reversal_attempted_at, transfer_reversal_failure_code, transfer_reversal_failure_message
) values
  -- non-terminal, no reversal work needed yet (not lost)
  ('a0430000-0000-0000-0000-000000000300', 'dp_043_open', 'pi_043_dispute_open', 'needs_response', 'fraudulent', 5000, 'not_attempted', null, null, null),
  -- terminal, won -- must NOT need attention
  ('a0430000-0000-0000-0000-000000000301', 'dp_043_won', 'pi_043_dispute_won', 'won', 'fraudulent', 5000, 'not_attempted', null, null, null),
  -- terminal, lost, reversal succeeded -- must NOT need attention
  ('a0430000-0000-0000-0000-000000000302', 'dp_043_lost_ok', 'pi_043_dispute_lost_ok', 'lost', 'product_not_received', 4000, 'succeeded', now() - interval '1 day', null, null),
  -- terminal, lost, reversal FAILED -- must need attention
  ('a0430000-0000-0000-0000-000000000303', 'dp_043_lost_failed', 'pi_043_dispute_lost_failed', 'lost', 'product_not_received', 4000, 'failed', now() - interval '1 hour', 'balance_insufficient', 'a raw, unbounded Stripe SDK error string that must never be returned by this RPC'),
  -- terminal, lost, reversal attempting but STALE (>10 minutes) -- must need attention
  ('a0430000-0000-0000-0000-000000000304', 'dp_043_lost_stale_attempting', 'pi_043_dispute_lost_stale', 'lost', 'fraudulent', 4000, 'attempting', now() - interval '20 minutes', null, null),
  -- terminal, lost, reversal attempting but FRESH (<10 minutes) -- must NOT need attention
  ('a0430000-0000-0000-0000-000000000305', 'dp_043_lost_fresh_attempting', 'pi_043_dispute_lost_fresh', 'lost', 'fraudulent', 4000, 'attempting', now() - interval '2 minutes', null, null),
  -- unrecognized future Stripe status -- must FAIL CLOSED (needs_attention = true)
  ('a0430000-0000-0000-0000-000000000306', 'dp_043_unrecognized', 'pi_043_dispute_unrecognized', 'some_future_stripe_status', 'other', 4000, 'not_attempted', null, null, null);

do $$
declare
  r record;
begin
  perform set_config('request.jwt.claim.sub', 'a0430000-0000-0000-0000-000000000001', true);
  set local role authenticated;

  select * into r from public.list_finance_disputes(p_limit := 100) x where x.id = 'a0430000-0000-0000-0000-000000000300';
  perform pg_temp.assert(r.needs_attention = true, 'part5: a non-terminal dispute status must need attention');

  select * into r from public.list_finance_disputes(p_limit := 100) x where x.id = 'a0430000-0000-0000-0000-000000000301';
  perform pg_temp.assert(r.needs_attention = false, 'part5: a WON dispute must not need attention');

  select * into r from public.list_finance_disputes(p_limit := 100) x where x.id = 'a0430000-0000-0000-0000-000000000302';
  perform pg_temp.assert(r.needs_attention = false, 'part5: a LOST dispute whose reversal already succeeded must not need attention');

  select * into r from public.list_finance_disputes(p_limit := 100) x where x.id = 'a0430000-0000-0000-0000-000000000303';
  perform pg_temp.assert(r.needs_attention = true, 'part5: a LOST dispute with a FAILED reversal must need attention');
  perform pg_temp.assert(r.transfer_reversal_failure_code = 'balance_insufficient', 'part5: the bounded failure CODE must be returned');

  select * into r from public.list_finance_disputes(p_limit := 100) x where x.id = 'a0430000-0000-0000-0000-000000000304';
  perform pg_temp.assert(r.needs_attention = true, 'part5: a LOST dispute with a STALE attempting reversal (>10min) must need attention');

  select * into r from public.list_finance_disputes(p_limit := 100) x where x.id = 'a0430000-0000-0000-0000-000000000305';
  perform pg_temp.assert(r.needs_attention = false, 'part5: a LOST dispute with a FRESH attempting reversal (<10min) must NOT need attention yet');

  select * into r from public.list_finance_disputes(p_limit := 100) x where x.id = 'a0430000-0000-0000-0000-000000000306';
  perform pg_temp.assert(r.needs_attention = true, 'part5: an UNRECOGNIZED future Stripe status must fail closed (needs_attention = true), never silently treated as terminal/safe');

  reset role;
end $$;

-- Privacy: transfer_reversal_failure_message must never be a column this
-- RPC returns, even though the underlying table stores it (and the fixture
-- above deliberately seeded a raw-looking error string into it).
do $$
declare
  out_cols text[];
begin
  select array_agg(a.name order by a.name) into out_cols
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral unnest(p.proargnames, p.proargmodes) as a(name, mode)
  where n.nspname = 'public' and p.proname = 'list_finance_disputes' and a.mode = 't';

  perform pg_temp.assert(
    not (out_cols @> array['transfer_reversal_failure_message']),
    'part5: list_finance_disputes() must NEVER return transfer_reversal_failure_message -- it can carry a raw, unbounded Stripe SDK error string'
  );
  perform pg_temp.assert(out_cols @> array['reason'], 'part5: sanity -- reason (a short, bounded Stripe-controlled string) IS expected to be present');
end $$;

-- ============================================================
-- Part 6: CHECKOUT EXCEPTIONS -- every surfaceable reconciliation_reason,
-- proving a deliberate business-decision reason is preserved as
-- authoritative context, never collapsed into a generic "replay" signal.
-- Also proves a fulfilled or never-completed intent is correctly
-- EXCLUDED (not every checkout intent is an exception).
-- ============================================================
insert into public.book_checkout_intents (
  id, book_id, reader_id, book_title, price_cents_at_checkout,
  stripe_checkout_session_id, stripe_payment_intent_id,
  expires_at, completed_at, fulfilled_at, reconciliation_reason, created_at
) values
  -- exception: active_other_session
  ('a0430000-0000-0000-0000-000000000400', 'a0430000-0000-0000-0000-000000000010', 'a0430000-0000-0000-0000-000000000008',
   'Test Book', 999, 'cs_043_a', 'pi_043_intent_a', now() + interval '1 hour', now() - interval '10 minutes', null, 'active_other_session', now() - interval '20 minutes'),
  -- exception: book_or_reader_deleted
  ('a0430000-0000-0000-0000-000000000401', null, null,
   'Deleted Book Title', 999, 'cs_043_b', 'pi_043_intent_b', now() + interval '1 hour', now() - interval '5 minutes', null, 'book_or_reader_deleted', now() - interval '15 minutes'),
  -- exception: disputed_lost
  ('a0430000-0000-0000-0000-000000000402', 'a0430000-0000-0000-0000-000000000010', 'a0430000-0000-0000-0000-000000000008',
   'Test Book', 999, 'cs_043_c', 'pi_043_intent_c', now() + interval '1 hour', now() - interval '2 minutes', null, 'disputed_lost', now() - interval '12 minutes'),
  -- NOT an exception: fulfilled normally
  ('a0430000-0000-0000-0000-000000000403', 'a0430000-0000-0000-0000-000000000010', 'a0430000-0000-0000-0000-000000000008',
   'Test Book', 999, 'cs_043_d', 'pi_043_intent_d', now() + interval '1 hour', now() - interval '30 minutes', now() - interval '29 minutes', null, now() - interval '40 minutes'),
  -- NOT an exception: never completed (ordinary abandoned checkout, ongoing/expired)
  ('a0430000-0000-0000-0000-000000000404', 'a0430000-0000-0000-0000-000000000010', 'a0430000-0000-0000-0000-000000000008',
   'Test Book', 999, null, null, now() + interval '1 hour', null, null, null, now());

do $$
declare
  r record;
  cnt integer;
begin
  perform set_config('request.jwt.claim.sub', 'a0430000-0000-0000-0000-000000000001', true);
  set local role authenticated;

  select count(*) into cnt from public.list_finance_checkout_exceptions(p_limit := 100);
  perform pg_temp.assert(cnt = 3, format('part6: exactly 3 checkout exceptions expected (fulfilled and never-completed rows must be excluded), got %s', cnt));

  select * into r from public.list_finance_checkout_exceptions(p_limit := 100) x where x.intent_id = 'a0430000-0000-0000-0000-000000000400';
  perform pg_temp.assert(r.reconciliation_reason = 'active_other_session', 'part6: active_other_session must be preserved verbatim as authoritative context');

  select * into r from public.list_finance_checkout_exceptions(p_limit := 100) x where x.intent_id = 'a0430000-0000-0000-0000-000000000401';
  perform pg_temp.assert(r.reconciliation_reason = 'book_or_reader_deleted', 'part6: book_or_reader_deleted must be preserved verbatim');
  perform pg_temp.assert(r.book_title = 'Deleted Book Title', 'part6: the FROZEN book_title column must be used, not a live join, so a deleted book''s title still renders');

  select * into r from public.list_finance_checkout_exceptions(p_limit := 100) x where x.intent_id = 'a0430000-0000-0000-0000-000000000402';
  perform pg_temp.assert(r.reconciliation_reason = 'disputed_lost', 'part6: disputed_lost must be preserved verbatim -- this is a deliberate business decision, not a bug to surface as "click replay"');

  select count(*) into cnt from public.list_finance_checkout_exceptions(p_limit := 100) x where x.intent_id in
    ('a0430000-0000-0000-0000-000000000403', 'a0430000-0000-0000-0000-000000000404');
  perform pg_temp.assert(cnt = 0, 'part6: a fulfilled intent and a never-completed (ordinary abandoned) intent must never appear as exceptions');

  reset role;
end $$;

-- ============================================================
-- Part 7: REFUND/ENTITLEMENT CONSISTENCY -- one instance of each of the
-- three safe-direction checks, plus proof that a CONSISTENT case
-- produces zero rows (the healthy/expected case).
-- ============================================================

-- Consistent baseline (must NOT appear as a mismatch): a normal refunded
-- purchase whose refund_requests row agrees.
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, stripe_payment_intent_id, amount_cents, refunded_at) values
  ('a0430000-0000-0000-0000-000000000500', 'a0430000-0000-0000-0000-000000000010', 'a0430000-0000-0000-0000-000000000008', 'cs_043_consistent', 'pi_043_consistent', 999, now());
insert into public.refund_requests (id, reader_id, stripe_payment_intent_id, amount_cents, status, refunded_at) values
  ('a0430000-0000-0000-0000-000000000501', 'a0430000-0000-0000-0000-000000000008', 'pi_043_consistent', 999, 'refunded', now());

-- Mismatch 1: refund_requests says refunded, but the linked purchase is
-- still active (refunded_at is null).
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, stripe_payment_intent_id, amount_cents, refunded_at) values
  ('a0430000-0000-0000-0000-000000000502', 'a0430000-0000-0000-0000-000000000010', 'a0430000-0000-0000-0000-000000000008', 'cs_043_mismatch1', 'pi_043_mismatch1', 999, null);
insert into public.refund_requests (id, reader_id, stripe_payment_intent_id, amount_cents, status, refunded_at) values
  ('a0430000-0000-0000-0000-000000000503', 'a0430000-0000-0000-0000-000000000008', 'pi_043_mismatch1', 999, 'refunded', now());

-- Mismatch 2: refund_requests says refunded (snapshot-based), but the
-- linked bundle_checkout_snapshots row is still active.
insert into public.bundle_checkout_snapshots (id, stripe_checkout_session_id, stripe_payment_intent_id, bundle_id, bundle_title, author_id, reader_id, bundle_price_cents_at_checkout, total_amount_cents, items, protection_expires_at, fulfilled_at, refunded_at) values
  ('a0430000-0000-0000-0000-000000000504', 'cs_043_mismatch2', 'pi_043_mismatch2', 'a0430000-0000-0000-0000-000000000011', 'Test Bundle', 'a0430000-0000-0000-0000-000000000007', 'a0430000-0000-0000-0000-000000000008', 2999, 2999, '[]'::jsonb, now() + interval '1 hour', now() - interval '1 day', null);
insert into public.refund_requests (id, reader_id, stripe_payment_intent_id, bundle_checkout_snapshot_id, amount_cents, status, refunded_at) values
  ('a0430000-0000-0000-0000-000000000505', 'a0430000-0000-0000-0000-000000000008', 'pi_043_mismatch2', 'a0430000-0000-0000-0000-000000000504', 2999, 'refunded', now());

-- Mismatch 3: a purchase shows refunded_at set, but its matching
-- refund_requests row is still 'approved' (not yet 'refunded').
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, stripe_payment_intent_id, amount_cents, refunded_at) values
  ('a0430000-0000-0000-0000-000000000506', 'a0430000-0000-0000-0000-000000000010', 'a0430000-0000-0000-0000-000000000008', 'cs_043_mismatch3', 'pi_043_mismatch3', 999, now());
insert into public.refund_requests (id, reader_id, stripe_payment_intent_id, amount_cents, status) values
  ('a0430000-0000-0000-0000-000000000507', 'a0430000-0000-0000-0000-000000000008', 'pi_043_mismatch3', 999, 'approved');

-- Legitimate, NOT-a-mismatch case: a purchase refunded directly via
-- Stripe Dashboard, with NO corresponding refund_requests row at all --
-- must never be flagged (explicitly documented as expected in
-- refund_requests.reviewed_at's own column comment, migration 029).
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, stripe_payment_intent_id, amount_cents, refunded_at) values
  ('a0430000-0000-0000-0000-000000000508', 'a0430000-0000-0000-0000-000000000010', 'a0430000-0000-0000-0000-000000000008', 'cs_043_direct_stripe', 'pi_043_direct_stripe', 999, now());

do $$
declare
  cnt integer;
  found_types text[];
begin
  perform set_config('request.jwt.claim.sub', 'a0430000-0000-0000-0000-000000000001', true);
  set local role authenticated;

  select array_agg(distinct mismatch_type) into found_types from public.list_finance_refund_entitlement_mismatches(p_limit := 100);

  perform pg_temp.assert('refunded_request_active_purchase' = any(found_types), 'part7: mismatch 1 (refunded request, active purchase) must be detected');
  perform pg_temp.assert('refunded_request_active_bundle_snapshot' = any(found_types), 'part7: mismatch 2 (refunded request, active bundle snapshot) must be detected');
  perform pg_temp.assert('purchase_refunded_request_unresolved' = any(found_types), 'part7: mismatch 3 (refunded purchase, unresolved request) must be detected');

  select count(*) into cnt from public.list_finance_refund_entitlement_mismatches(p_limit := 100) x
    where x.stripe_payment_intent_id = 'pi_043_consistent';
  perform pg_temp.assert(cnt = 0, 'part7: a consistent refunded purchase + refunded request must NEVER appear as a mismatch');

  select count(*) into cnt from public.list_finance_refund_entitlement_mismatches(p_limit := 100) x
    where x.stripe_payment_intent_id = 'pi_043_direct_stripe';
  perform pg_temp.assert(cnt = 0, 'part7: a direct-Stripe-Dashboard refund with no refund_requests row at all must NEVER be flagged -- this is documented as a legitimate, expected state');

  reset role;
end $$;

-- ============================================================
-- Part 8: SUMMARY COUNTS -- must agree exactly with the list RPCs'
-- own row counts for the same predicates.
-- ============================================================
do $$
declare
  s record;
  refund_cnt integer;
  dispute_cnt integer;
  checkout_cnt integer;
  mismatch_cnt integer;
begin
  perform set_config('request.jwt.claim.sub', 'a0430000-0000-0000-0000-000000000001', true);
  set local role authenticated;

  select * into s from public.get_finance_summary_counts();
  select count(*) into refund_cnt from public.list_refund_reconciliation_states(p_needs_attention := true, p_limit := 100);
  select count(*) into dispute_cnt from public.list_finance_disputes(p_needs_attention := true, p_limit := 100);
  select count(*) into checkout_cnt from public.list_finance_checkout_exceptions(p_limit := 100);
  select count(*) into mismatch_cnt from public.list_finance_refund_entitlement_mismatches(p_limit := 100);

  perform pg_temp.assert(s.refund_needs_attention_count = refund_cnt, format('part8: refund_needs_attention_count (%s) must match list RPC count (%s)', s.refund_needs_attention_count, refund_cnt));
  perform pg_temp.assert(s.dispute_needs_attention_count = dispute_cnt, format('part8: dispute_needs_attention_count (%s) must match list RPC count (%s)', s.dispute_needs_attention_count, dispute_cnt));
  perform pg_temp.assert(s.checkout_exception_count = checkout_cnt, format('part8: checkout_exception_count (%s) must match list RPC count (%s)', s.checkout_exception_count, checkout_cnt));
  perform pg_temp.assert(s.refund_entitlement_mismatch_count = mismatch_cnt, format('part8: refund_entitlement_mismatch_count (%s) must match list RPC count (%s)', s.refund_entitlement_mismatch_count, mismatch_cnt));

  reset role;
end $$;

-- ============================================================
-- Part 9: PRIVACY -- no forbidden fields anywhere in the new RPCs'
-- output column sets (email, card/payment data, billing, raw webhook
-- payloads, secrets/tokens).
-- ============================================================
do $$
declare
  fn text;
  out_cols text[];
  forbidden text[] := array['email', 'card', 'payment_method', 'billing', 'secret', 'token', 'access_token', 'raw_payload', 'webhook_payload'];
  f text;
begin
  foreach fn in array array[
    'list_refund_reconciliation_states', 'list_finance_disputes',
    'list_finance_checkout_exceptions', 'list_finance_refund_entitlement_mismatches'
  ] loop
    select array_agg(lower(a.name)) into out_cols
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral unnest(p.proargnames, p.proargmodes) as a(name, mode)
    where n.nspname = 'public' and p.proname = fn and a.mode = 't';

    foreach f in array forbidden loop
      perform pg_temp.assert(
        not (out_cols @> array[f]),
        format('part9: %s must not return a column named %s', fn, f)
      );
    end loop;
  end loop;
end $$;

rollback;
