-- Committed SQL regression suite for migration 054 (LEDGER-1E-D-D.1:
-- closed-run reservation barrier).
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql -- no new test
-- infrastructure needed, same as every other suite in this directory.
--
-- Run manually against a disposable/local Postgres instance, AFTER
-- applying supabase/schema.sql (which already includes migration 054's
-- final state), from the repo root:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/054_payout_run_reservation_barrier.test.sql
--
-- A SEPARATE script, 054_payout_run_completion_contention.sh, proves
-- the FOR SHARE / FOR UPDATE serialization against two REAL, concurrent
-- Postgres connections -- a single-transaction .sql file structurally
-- cannot exercise a genuine lock-wait race. See that script's own
-- header, and 051/053's own contention scripts, for why.
--
-- Everything below runs inside one transaction and is rolled back at
-- the end.

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
-- Shared fixture: one eligible author/currency (settings + available
-- ledger balance well above threshold), reused by every scenario
-- below via a fresh payout_run each time so reservations never
-- collide with each other via the active-reservation unique index.
-- ============================================================

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('05400100-0000-0000-0000-000000000001', 'p054-author@test', now(), '{"role":"author","display_name":"P054 Author"}'),
  ('05400200-0000-0000-0000-000000000001', 'p054-author2@test', now(), '{"role":"author","display_name":"P054 Author 2"}');

insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('05400100-0000-0000-0000-000000000002', '05400100-0000-0000-0000-000000000001', 'P054 Book', '', '', '', 100, 'published'),
  ('05400200-0000-0000-0000-000000000002', '05400200-0000-0000-0000-000000000001', 'P054 Book 2', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('05400100-0000-0000-0000-000000000003', '05400100-0000-0000-0000-000000000002', '05400100-0000-0000-0000-000000000001', 'cs_p054_a1', 100),
  ('05400200-0000-0000-0000-000000000003', '05400200-0000-0000-0000-000000000002', '05400200-0000-0000-0000-000000000001', 'cs_p054_a2', 100);
insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('05400100-0000-0000-0000-000000000004', '05400100-0000-0000-0000-000000000001',
   '05400100-0000-0000-0000-000000000003', 'sale', 100, 'USD', 8000, 100, 0, now() - interval '10 days', now() - interval '10 days'),
  ('05400200-0000-0000-0000-000000000004', '05400200-0000-0000-0000-000000000001',
   '05400200-0000-0000-0000-000000000003', 'sale', 100, 'USD', 8000, 100, 0, now() - interval '10 days', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('05400100-0000-0000-0000-000000000001', 50, 'USD'),
  ('05400200-0000-0000-0000-000000000001', 50, 'USD');

-- ============================================================
-- A: sequential closed-run invariant (Section 16) -- running -> complete
-- -> reserve against the now-completed run id must create NOTHING.
-- ============================================================
do $$
declare
  v_target_month date;
  v_run record;
  v_reserve record;
  v_payouts_before integer;
  v_payouts_after integer;
  v_run_status_after text;
begin
  v_target_month := date_trunc('month', now() - interval '13 months')::date;

  set local role service_role;
  select * into v_run from public.start_scheduled_payout_run(v_target_month);
  perform public.complete_scheduled_payout_run(v_run.payout_run_id);
  reset role;

  select count(*) into v_payouts_before from public.author_payouts;

  set local role service_role;
  select * into v_reserve from public.reserve_author_payout(
    '05400100-0000-0000-0000-000000000001', 'USD', v_run.payout_run_id
  );
  reset role;

  perform pg_temp.assert(v_reserve.payout_id is null, 'A: reserve against a COMPLETED run must return zero rows (payout_id null)');

  select count(*) into v_payouts_after from public.author_payouts;
  perform pg_temp.assert(v_payouts_before = v_payouts_after, 'A: reserve against a completed run must create no author_payouts row');

  select status into v_run_status_after from public.payout_runs where id = v_run.payout_run_id;
  perform pg_temp.assert(v_run_status_after = 'completed', 'A: the run itself must remain completed, never reopened');
end $$;

-- ============================================================
-- B: nonexistent payout_run_id -> deterministic rejection, before any
-- eligibility computation or mutation (Section 10).
-- ============================================================
do $$
declare
  v_payouts_before integer;
  v_payouts_after integer;
  v_bogus_run_id uuid := '00000000-0000-0000-0000-000000000099';
begin
  select count(*) into v_payouts_before from public.author_payouts;

  begin
    set local role service_role;
    perform * from public.reserve_author_payout('05400100-0000-0000-0000-000000000001', 'USD', v_bogus_run_id);
    reset role;
    perform pg_temp.assert(false, 'B: a nonexistent payout_run_id must be rejected');
  exception when others then
    reset role;
    perform pg_temp.assert(sqlerrm like '%does not exist%', format('B: expected a "does not exist" error, got %s', sqlerrm));
  end;

  select count(*) into v_payouts_after from public.author_payouts;
  perform pg_temp.assert(v_payouts_before = v_payouts_after, 'B: a rejected bogus run id must create no author_payouts row');
end $$;

-- ============================================================
-- C: an existing FAILED run -> zero rows, never a raised exception,
-- never a mutation, never reopened (Section 9 -- 'failed' is treated
-- identically to 'completed': deterministic no-op). No RPC in this
-- schema ever creates a 'failed' payout_runs row (migration 053's own
-- Part 5 comment) -- seeded directly via superuser fixture insert, the
-- same convention 053's own R9 test already established.
-- ============================================================
do $$
declare
  v_failed_run_id uuid;
  v_reserve record;
  v_payouts_before integer;
  v_payouts_after integer;
begin
  insert into public.payout_runs (run_type, run_key, scheduled_for, status, started_at)
  values ('scheduled', 'monthly:2015-06', '2015-06-01', 'failed', now() - interval '1 year')
  returning id into v_failed_run_id;

  select count(*) into v_payouts_before from public.author_payouts;

  set local role service_role;
  select * into v_reserve from public.reserve_author_payout(
    '05400100-0000-0000-0000-000000000001', 'USD', v_failed_run_id
  );
  reset role;

  perform pg_temp.assert(v_reserve.payout_id is null, 'C: reserve against a FAILED run must return zero rows');

  select count(*) into v_payouts_after from public.author_payouts;
  perform pg_temp.assert(v_payouts_before = v_payouts_after, 'C: reserve against a failed run must create no author_payouts row');

  perform pg_temp.assert(
    (select status from public.payout_runs where id = v_failed_run_id) = 'failed',
    'C: the failed run must remain failed, never reopened/mutated'
  );
end $$;

-- ============================================================
-- D: a genuinely RUNNING run -> reservation proceeds exactly as
-- before (regression -- the barrier must not block the legitimate
-- case).
-- ============================================================
do $$
declare
  v_target_month date;
  v_run record;
  v_reserve record;
begin
  v_target_month := date_trunc('month', now() - interval '14 months')::date;

  set local role service_role;
  select * into v_run from public.start_scheduled_payout_run(v_target_month);
  select * into v_reserve from public.reserve_author_payout(
    '05400200-0000-0000-0000-000000000001', 'USD', v_run.payout_run_id
  );
  reset role;

  perform pg_temp.assert(v_reserve.payout_id is not null, 'D: reserve against a RUNNING run must succeed');
  perform pg_temp.assert(v_reserve.amount_minor = 100, format('D: expected amount_minor 100, got %s', v_reserve.amount_minor));

  perform pg_temp.assert(
    (select payout_run_id from public.author_payouts where id = v_reserve.payout_id) = v_run.payout_run_id,
    'D: the created author_payouts row must reference the running run'
  );
end $$;

-- ============================================================
-- E: p_payout_run_id = NULL behavior is completely unchanged (Section
-- 12) -- the new run-validation block must be structurally skipped.
-- Reuses author 05400100 in EUR (untouched by the earlier USD
-- scenarios above) to avoid the active-reservation unique index.
-- ============================================================
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('05400100-0000-0000-0000-000000000005', '05400100-0000-0000-0000-000000000001', 'P054 EUR Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('05400100-0000-0000-0000-000000000006', '05400100-0000-0000-0000-000000000005', '05400100-0000-0000-0000-000000000001', 'cs_p054_eur', 100);
insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('05400100-0000-0000-0000-000000000007', '05400100-0000-0000-0000-000000000001',
   '05400100-0000-0000-0000-000000000006', 'sale', 100, 'EUR', 8000, 100, 0, now() - interval '10 days', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('05400100-0000-0000-0000-000000000001', 50, 'EUR');

do $$
declare
  v_reserve record;
begin
  set local role service_role;
  select * into v_reserve from public.reserve_author_payout('05400100-0000-0000-0000-000000000001', 'EUR');
  reset role;

  perform pg_temp.assert(v_reserve.payout_id is not null, 'E: reserve with NULL payout_run_id must succeed exactly as before');
  perform pg_temp.assert(
    (select payout_run_id from public.author_payouts where id = v_reserve.payout_id) is null,
    'E: the created author_payouts row must have a NULL payout_run_id, unchanged'
  );
end $$;

-- ============================================================
-- F: different-run isolation (Section 19) -- a completed run's
-- barrier must not affect a reservation against a DIFFERENT, still-
-- running run. Reuses author 05400200 in EUR.
-- ============================================================
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('05400200-0000-0000-0000-000000000005', '05400200-0000-0000-0000-000000000001', 'P054 EUR Book 2', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('05400200-0000-0000-0000-000000000006', '05400200-0000-0000-0000-000000000005', '05400200-0000-0000-0000-000000000001', 'cs_p054_eur2', 100);
insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('05400200-0000-0000-0000-000000000007', '05400200-0000-0000-0000-000000000001',
   '05400200-0000-0000-0000-000000000006', 'sale', 100, 'EUR', 8000, 100, 0, now() - interval '10 days', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('05400200-0000-0000-0000-000000000001', 50, 'EUR');

do $$
declare
  v_completed_month date;
  v_running_month date;
  v_completed_run record;
  v_running_run record;
  v_reserve record;
begin
  v_completed_month := date_trunc('month', now() - interval '15 months')::date;
  v_running_month := date_trunc('month', now() - interval '16 months')::date;

  set local role service_role;
  select * into v_completed_run from public.start_scheduled_payout_run(v_completed_month);
  perform public.complete_scheduled_payout_run(v_completed_run.payout_run_id);
  select * into v_running_run from public.start_scheduled_payout_run(v_running_month);

  -- A reservation against the COMPLETED run must still be blocked here...
  select * into v_reserve from public.reserve_author_payout(
    '05400200-0000-0000-0000-000000000001', 'EUR', v_completed_run.payout_run_id
  );
  perform pg_temp.assert(v_reserve.payout_id is null, 'F: reserve against the completed run must still be blocked');

  -- ...but the SAME author+currency against the DIFFERENT, still-
  -- running run must succeed normally -- the barrier is scoped to one
  -- payout_run, never a global scheduler lock.
  select * into v_reserve from public.reserve_author_payout(
    '05400200-0000-0000-0000-000000000001', 'EUR', v_running_run.payout_run_id
  );
  reset role;

  perform pg_temp.assert(v_reserve.payout_id is not null, 'F: reserve against a DIFFERENT running run must succeed, unaffected by the other run''s completed state');
  perform pg_temp.assert(
    (select payout_run_id from public.author_payouts where id = v_reserve.payout_id) = v_running_run.payout_run_id,
    'F: the created row must reference the running run, not the completed one'
  );
end $$;

-- ============================================================
-- G: security posture unchanged -- reserve_author_payout remains
-- service_role-only after this migration (regression against 053's
-- own Part 6 security suite, re-asserted here for this migration's own
-- record).
-- ============================================================
do $$
begin
  perform set_config('request.jwt.claim.sub', '05400100-0000-0000-0000-000000000001', true);
  set local role authenticated;
  begin
    perform * from public.reserve_author_payout('05400100-0000-0000-0000-000000000001', 'USD', null);
    perform pg_temp.assert(false, 'G: an ordinary authenticated author must not execute reserve_author_payout');
  exception when insufficient_privilege then null;
  end;
  reset role;
end $$;

select 'ALL PASSED: 054_payout_run_reservation_barrier.test.sql' as result;

rollback;
