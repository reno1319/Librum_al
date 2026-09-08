-- Committed SQL regression suite for migration 050 (LEDGER-1D:
-- author-facing financial reporting + safe read model).
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql -- no new test
-- infrastructure needed, same as every other suite in this directory.
--
-- Run manually against a disposable/local Postgres instance, AFTER
-- applying supabase/schema.sql (which already includes migration 050's
-- final state), from the repo root:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/050_author_financial_reporting.test.sql
--
-- Everything below runs inside one transaction and is rolled back at
-- the end, so now() is CONSTANT throughout (same discipline as
-- 043_finance_reconciliation_reads.test.sql) -- every future/past
-- available_at fixture is seeded with an explicit `now() +/- interval`
-- value, and get_author_financial_summary()'s own `available_at > now()`
-- comparison evaluates against that SAME frozen now() later in this
-- same transaction, so the arithmetic is exact and non-flaky.
--
-- Ledger fixtures are inserted DIRECTLY (as the connecting superuser/
-- table owner, bypassing RLS -- the same convention every migration
-- 048/049 test file already uses) rather than round-tripped through
-- record_successful_sale()/record_refund(), which are already
-- exhaustively tested by 049's own suite -- this file tests the
-- REPORTING layer in isolation, with full control over exact
-- available_at timestamps per scenario.

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
-- Part 0: fixtures -- one author per major scenario (P1-P7), kept
-- currency-isolated from each other so each summary row's aggregate can
-- be hand-verified independently, plus a reader, a non-author/non-staff
-- authenticated user, and a finance.view staff member.
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('c0500000-0000-0000-0000-000000000001', 'p050-p1@test', now(), '{"role":"author","display_name":"P1 Pending Case"}'),
  ('c0500000-0000-0000-0000-000000000002', 'p050-p2@test', now(), '{"role":"author","display_name":"P2 Post-Settlement"}'),
  ('c0500000-0000-0000-0000-000000000003', 'p050-p3@test', now(), '{"role":"author","display_name":"P3 Post-Payout"}'),
  ('c0500000-0000-0000-0000-000000000004', 'p050-p4@test', now(), '{"role":"author","display_name":"P4 Bundle"}'),
  ('c0500000-0000-0000-0000-000000000005', 'p050-p5@test', now(), '{"role":"author","display_name":"P5 Multi-Currency"}'),
  ('c0500000-0000-0000-0000-000000000006', 'p050-p6@test', now(), '{"role":"author","display_name":"P6 Adjustments"}'),
  ('c0500000-0000-0000-0000-000000000007', 'p050-p7@test', now(), '{"role":"author","display_name":"P7 Activity"}'),
  ('c0500000-0000-0000-0000-000000000008', 'p050-reader@test', now(), '{"role":"reader","display_name":"Reader"}'),
  ('c0500000-0000-0000-0000-000000000009', 'p050-finance-staff@test', now(), '{"role":"reader","display_name":"Finance Staff"}');

insert into public.staff_members (user_id, role) values
  ('c0500000-0000-0000-0000-000000000009', 'admin');

insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('d0500000-0000-0000-0000-000000000001', 'c0500000-0000-0000-0000-000000000001', 'P1 Book', '', '', '', 800, 'published'),
  ('d0500000-0000-0000-0000-000000000002', 'c0500000-0000-0000-0000-000000000002', 'P2 Book', '', '', '', 800, 'published'),
  ('d0500000-0000-0000-0000-000000000003', 'c0500000-0000-0000-0000-000000000003', 'P3 Book', '', '', '', 800, 'published'),
  ('d0500000-0000-0000-0000-000000000004', 'c0500000-0000-0000-0000-000000000004', 'P4 Bundle Book A', '', '', '', 100, 'published'),
  ('d0500000-0000-0000-0000-000000000005', 'c0500000-0000-0000-0000-000000000004', 'P4 Bundle Book B', '', '', '', 200, 'published'),
  ('d0500000-0000-0000-0000-000000000006', 'c0500000-0000-0000-0000-000000000004', 'P4 Bundle Book C', '', '', '', 301, 'published'),
  ('d0500000-0000-0000-0000-000000000007', 'c0500000-0000-0000-0000-000000000005', 'P5 USD Book', '', '', '', 500, 'published'),
  ('d0500000-0000-0000-0000-000000000008', 'c0500000-0000-0000-0000-000000000005', 'P5 EUR Book', '', '', '', 500, 'published'),
  ('d0500000-0000-0000-0000-000000000009', 'c0500000-0000-0000-0000-000000000006', 'P6 Book', '', '', '', 500, 'published'),
  ('d0500000-0000-0000-0000-00000000000a', 'c0500000-0000-0000-0000-000000000007', 'P7 Activity Book', '', '', '', 100, 'published');

insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0500000-0000-0000-0000-000000000001', 'd0500000-0000-0000-0000-000000000001', 'c0500000-0000-0000-0000-000000000008', 'cs_p050_p1', 800),
  ('e0500000-0000-0000-0000-000000000002', 'd0500000-0000-0000-0000-000000000002', 'c0500000-0000-0000-0000-000000000008', 'cs_p050_p2', 800),
  ('e0500000-0000-0000-0000-000000000003', 'd0500000-0000-0000-0000-000000000003', 'c0500000-0000-0000-0000-000000000008', 'cs_p050_p3', 800),
  ('e0500000-0000-0000-0000-000000000004', 'd0500000-0000-0000-0000-000000000004', 'c0500000-0000-0000-0000-000000000008', 'cs_p050_p4', 100),
  ('e0500000-0000-0000-0000-000000000005', 'd0500000-0000-0000-0000-000000000005', 'c0500000-0000-0000-0000-000000000008', 'cs_p050_p4', 200),
  ('e0500000-0000-0000-0000-000000000006', 'd0500000-0000-0000-0000-000000000006', 'c0500000-0000-0000-0000-000000000008', 'cs_p050_p4', 301),
  ('e0500000-0000-0000-0000-000000000007', 'd0500000-0000-0000-0000-000000000007', 'c0500000-0000-0000-0000-000000000008', 'cs_p050_p5_usd', 500),
  ('e0500000-0000-0000-0000-000000000008', 'd0500000-0000-0000-0000-000000000008', 'c0500000-0000-0000-0000-000000000008', 'cs_p050_p5_eur', 500),
  ('e0500000-0000-0000-0000-00000000000a', 'd0500000-0000-0000-0000-00000000000a', 'c0500000-0000-0000-0000-000000000008', 'cs_p050_p7', 100);

-- ============================================================
-- Part 1 (Section 4): THE CRITICAL PENDING-REFUND CASE.
-- P1: sale +800, available_at FUTURE, then refunded -800 before it
-- ever settles. Expected: pending=0, available=0, current_balance=0,
-- lifetime_refund=800.
--
-- A canonical refund entry requires payment_refund_id (migration 049's
-- own CHECK) -- every refund fixture below therefore first creates a
-- minimal payments + payment_refunds row pair, exactly mirroring what
-- record_refund() itself would have produced, rather than inserting a
-- refund ledger row in isolation.
-- ============================================================
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('a0500000-0000-0000-0000-000000000001', 'test', 'pay_p050_p1', 800, 'USD', 'succeeded');
update public.purchases set payment_id = 'a0500000-0000-0000-0000-000000000001' where id = 'e0500000-0000-0000-0000-000000000001';

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('f0500000-0000-0000-0000-000000000001', 'c0500000-0000-0000-0000-000000000001',
   'e0500000-0000-0000-0000-000000000001', 'a0500000-0000-0000-0000-000000000001', 'sale', 640, 'USD', 8000, 800, 160,
   now() + interval '25 days', now() - interval '5 days');

insert into public.payment_refunds (id, payment_id, purchase_id, provider, provider_refund_id, amount_minor, currency, refunded_at) values
  ('b0500000-0000-0000-0000-000000000001', 'a0500000-0000-0000-0000-000000000001', 'e0500000-0000-0000-0000-000000000001',
   'test', 'refund_p050_p1', 800, 'USD', now());

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, payment_refund_id, entry_type, amount_minor, currency, available_at, created_at)
values
  ('f0500000-0000-0000-0000-000000000002', 'c0500000-0000-0000-0000-000000000001',
   'e0500000-0000-0000-0000-000000000001', 'a0500000-0000-0000-0000-000000000001', 'b0500000-0000-0000-0000-000000000001',
   'refund', -640, 'USD', now(), now());

do $$
declare
  v_summary record;
begin
  perform set_config('request.jwt.claim.sub', 'c0500000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select * into v_summary from public.get_author_financial_summary() where currency = 'USD';
  reset role;

  perform pg_temp.assert(v_summary.currency = 'USD', 'part1: P1 must have a USD summary row');
  perform pg_temp.assert(v_summary.pending_minor = 0, format('part1: pending must be 0, got %s', v_summary.pending_minor));
  perform pg_temp.assert(v_summary.available_minor = 0, format('part1: available must be 0, got %s', v_summary.available_minor));
  perform pg_temp.assert(v_summary.current_balance_minor = 0, format('part1: current_balance must be 0, got %s', v_summary.current_balance_minor));
  perform pg_temp.assert(v_summary.lifetime_refund_minor = 640, format('part1: lifetime_refund must be 640, got %s', v_summary.lifetime_refund_minor));
  perform pg_temp.assert(v_summary.lifetime_sale_minor = 640, format('part1: lifetime_sale must be 640, got %s', v_summary.lifetime_sale_minor));
end $$;

-- ============================================================
-- Part 2 (Section 5): POST-SETTLEMENT REFUND CASE.
-- P2: sale +800 already settled (available_at in the PAST), then
-- refunded -800. Expected: pending=0, available=0.
-- ============================================================
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('a0500000-0000-0000-0000-000000000002', 'test', 'pay_p050_p2', 800, 'USD', 'succeeded');
update public.purchases set payment_id = 'a0500000-0000-0000-0000-000000000002' where id = 'e0500000-0000-0000-0000-000000000002';

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('f0500000-0000-0000-0000-000000000010', 'c0500000-0000-0000-0000-000000000002',
   'e0500000-0000-0000-0000-000000000002', 'a0500000-0000-0000-0000-000000000002', 'sale', 640, 'USD', 8000, 800, 160,
   now() - interval '10 days', now() - interval '40 days');

insert into public.payment_refunds (id, payment_id, purchase_id, provider, provider_refund_id, amount_minor, currency, refunded_at) values
  ('b0500000-0000-0000-0000-000000000002', 'a0500000-0000-0000-0000-000000000002', 'e0500000-0000-0000-0000-000000000002',
   'test', 'refund_p050_p2', 800, 'USD', now());

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, payment_refund_id, entry_type, amount_minor, currency, available_at, created_at)
values
  ('f0500000-0000-0000-0000-000000000011', 'c0500000-0000-0000-0000-000000000002',
   'e0500000-0000-0000-0000-000000000002', 'a0500000-0000-0000-0000-000000000002', 'b0500000-0000-0000-0000-000000000002',
   'refund', -640, 'USD', now(), now());

do $$
declare
  v_summary record;
begin
  perform set_config('request.jwt.claim.sub', 'c0500000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  select * into v_summary from public.get_author_financial_summary() where currency = 'USD';
  reset role;

  perform pg_temp.assert(v_summary.pending_minor = 0, format('part2: pending must be 0, got %s', v_summary.pending_minor));
  perform pg_temp.assert(v_summary.available_minor = 0, format('part2: available must be 0, got %s', v_summary.available_minor));
end $$;

-- ============================================================
-- Part 3 (Section 6): POST-PAYOUT REFUND CASE -- negative balance must
-- remain visible, never clamped to zero.
-- sale +800 (settled) -> payout -800 -> later refund -800.
-- Expected: pending=0, available=current_balance=-800, paid_out=800.
-- ============================================================
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('a0500000-0000-0000-0000-000000000003', 'test', 'pay_p050_p3', 800, 'USD', 'succeeded');
update public.purchases set payment_id = 'a0500000-0000-0000-0000-000000000003' where id = 'e0500000-0000-0000-0000-000000000003';

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('f0500000-0000-0000-0000-000000000020', 'c0500000-0000-0000-0000-000000000003',
   'e0500000-0000-0000-0000-000000000003', 'a0500000-0000-0000-0000-000000000003', 'sale', 640, 'USD', 8000, 800, 160,
   now() - interval '40 days', now() - interval '70 days');

-- LEDGER-1E-C.1: provider/provider_reference/paid_at are populated here
-- (synthetic test values, no real provider involved) so this fixture
-- stays valid under migration 051's later-added
-- author_payouts_paid_requires_provider_and_reference CHECK -- a rule
-- that did not exist when this file was originally written. This is a
-- fixture-validity fix only: amount_minor/currency/status and every
-- downstream ledger entry/assertion below are unchanged from LEDGER-1D's
-- original POST-PAYOUT REFUND CASE.
insert into public.author_payouts (id, author_id, amount_minor, currency, status, paid_at, provider, provider_reference) values
  ('90500000-0000-0000-0000-000000000001', 'c0500000-0000-0000-0000-000000000003', 640, 'USD', 'paid',
   now() - interval '30 days', 'test', 'ref-p050-p3-001');

insert into public.author_ledger_entries
  (id, author_id, payout_id, entry_type, amount_minor, currency, available_at, created_at)
values
  ('f0500000-0000-0000-0000-000000000021', 'c0500000-0000-0000-0000-000000000003',
   '90500000-0000-0000-0000-000000000001', 'payout', -640, 'USD', now() - interval '30 days', now() - interval '30 days');

insert into public.payment_refunds (id, payment_id, purchase_id, provider, provider_refund_id, amount_minor, currency, refunded_at) values
  ('b0500000-0000-0000-0000-000000000003', 'a0500000-0000-0000-0000-000000000003', 'e0500000-0000-0000-0000-000000000003',
   'test', 'refund_p050_p3', 800, 'USD', now());

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, payment_refund_id, entry_type, amount_minor, currency, available_at, created_at)
values
  ('f0500000-0000-0000-0000-000000000022', 'c0500000-0000-0000-0000-000000000003',
   'e0500000-0000-0000-0000-000000000003', 'a0500000-0000-0000-0000-000000000003', 'b0500000-0000-0000-0000-000000000003',
   'refund', -640, 'USD', now(), now());

do $$
declare
  v_summary record;
begin
  perform set_config('request.jwt.claim.sub', 'c0500000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  select * into v_summary from public.get_author_financial_summary() where currency = 'USD';
  reset role;

  perform pg_temp.assert(v_summary.pending_minor = 0, format('part3: pending must be 0, got %s', v_summary.pending_minor));
  perform pg_temp.assert(v_summary.available_minor = -640, format('part3: available must be NEGATIVE -640 (never clamped to zero), got %s', v_summary.available_minor));
  perform pg_temp.assert(v_summary.current_balance_minor = -640, format('part3: current_balance must be -640, got %s', v_summary.current_balance_minor));
  perform pg_temp.assert(v_summary.paid_out_minor = 640, format('part3: paid_out must be 640, got %s', v_summary.paid_out_minor));
  perform pg_temp.assert(v_summary.lifetime_refund_minor = 640, format('part3: lifetime_refund must be 640, got %s', v_summary.lifetime_refund_minor));
end $$;

-- ============================================================
-- Part 4 (Section 7): PARTIAL PAYMENT REFUND / BUNDLE CASE.
-- One payment funds purchases A(100->80), B(200->160), C(301->~241);
-- only B is refunded. A and C's sale credits must remain intact.
-- ============================================================
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('a0500000-0000-0000-0000-000000000004', 'test', 'pay_p050_p4', 601, 'USD', 'succeeded');
update public.purchases set payment_id = 'a0500000-0000-0000-0000-000000000004'
  where id in ('e0500000-0000-0000-0000-000000000004', 'e0500000-0000-0000-0000-000000000005', 'e0500000-0000-0000-0000-000000000006');

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('f0500000-0000-0000-0000-000000000030', 'c0500000-0000-0000-0000-000000000004',
   'e0500000-0000-0000-0000-000000000004', 'a0500000-0000-0000-0000-000000000004', 'sale', 80, 'USD', 8000, 100, 20,
   now() - interval '10 days', now() - interval '10 days'),
  ('f0500000-0000-0000-0000-000000000031', 'c0500000-0000-0000-0000-000000000004',
   'e0500000-0000-0000-0000-000000000005', 'a0500000-0000-0000-0000-000000000004', 'sale', 160, 'USD', 8000, 200, 40,
   now() - interval '10 days', now() - interval '10 days'),
  ('f0500000-0000-0000-0000-000000000032', 'c0500000-0000-0000-0000-000000000004',
   'e0500000-0000-0000-0000-000000000006', 'a0500000-0000-0000-0000-000000000004', 'sale', 241, 'USD', 8000, 301, 60,
   now() - interval '10 days', now() - interval '10 days');

insert into public.payment_refunds (id, payment_id, purchase_id, provider, provider_refund_id, amount_minor, currency, refunded_at) values
  ('b0500000-0000-0000-0000-000000000004', 'a0500000-0000-0000-0000-000000000004', 'e0500000-0000-0000-0000-000000000005',
   'test', 'refund_p050_p4', 200, 'USD', now());

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, payment_refund_id, entry_type, amount_minor, currency, available_at, created_at)
values
  ('f0500000-0000-0000-0000-000000000033', 'c0500000-0000-0000-0000-000000000004',
   'e0500000-0000-0000-0000-000000000005', 'a0500000-0000-0000-0000-000000000004', 'b0500000-0000-0000-0000-000000000004',
   'refund', -160, 'USD', now(), now());

do $$
declare
  v_summary record;
  v_sale_a bigint;
  v_sale_c bigint;
begin
  perform set_config('request.jwt.claim.sub', 'c0500000-0000-0000-0000-000000000004', true);
  set local role authenticated;
  select * into v_summary from public.get_author_financial_summary() where currency = 'USD';
  reset role;

  select amount_minor into v_sale_a from public.author_ledger_entries where id = 'f0500000-0000-0000-0000-000000000030';
  select amount_minor into v_sale_c from public.author_ledger_entries where id = 'f0500000-0000-0000-0000-000000000032';

  perform pg_temp.assert(v_sale_a = 80, 'part4: purchase A''s sale credit must remain untouched at 80');
  perform pg_temp.assert(v_sale_c = 241, 'part4: purchase C''s sale credit must remain untouched at 241');
  perform pg_temp.assert(v_summary.lifetime_sale_minor = 80 + 160 + 241, format('part4: lifetime_sale must be 481, got %s', v_summary.lifetime_sale_minor));
  perform pg_temp.assert(v_summary.lifetime_refund_minor = 160, format('part4: lifetime_refund must be exactly B''s 160, got %s', v_summary.lifetime_refund_minor));
  perform pg_temp.assert(
    v_summary.net_earnings_minor = 80 + 241,
    format('part4: net_earnings must reflect only A+C remaining (321), got %s', v_summary.net_earnings_minor)
  );
end $$;

-- ============================================================
-- Part 5 (Section 8): MULTI-CURRENCY -- EUR and USD must never be
-- summed into one balance; two separate rows.
-- ============================================================
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('a0500000-0000-0000-0000-000000000005', 'test', 'pay_p050_p5_usd', 500, 'USD', 'succeeded'),
  ('a0500000-0000-0000-0000-000000000006', 'test', 'pay_p050_p5_eur', 500, 'EUR', 'succeeded');

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('f0500000-0000-0000-0000-000000000040', 'c0500000-0000-0000-0000-000000000005',
   'e0500000-0000-0000-0000-000000000007', 'a0500000-0000-0000-0000-000000000005', 'sale', 400, 'USD', 8000, 500, 100,
   now() - interval '10 days', now() - interval '10 days'),
  ('f0500000-0000-0000-0000-000000000041', 'c0500000-0000-0000-0000-000000000005',
   'e0500000-0000-0000-0000-000000000008', 'a0500000-0000-0000-0000-000000000006', 'sale', 400, 'EUR', 8000, 500, 100,
   now() - interval '10 days', now() - interval '10 days');

do $$
declare
  v_count integer;
  v_usd record;
  v_eur record;
begin
  perform set_config('request.jwt.claim.sub', 'c0500000-0000-0000-0000-000000000005', true);
  set local role authenticated;
  select count(*) into v_count from public.get_author_financial_summary();
  select * into v_usd from public.get_author_financial_summary() where currency = 'USD';
  select * into v_eur from public.get_author_financial_summary() where currency = 'EUR';
  reset role;

  perform pg_temp.assert(v_count = 2, format('part5: P5 must have exactly 2 currency rows (USD and EUR), got %s', v_count));
  perform pg_temp.assert(v_usd.current_balance_minor = 400, format('part5: USD balance must be 400 alone, got %s', v_usd.current_balance_minor));
  perform pg_temp.assert(v_eur.current_balance_minor = 400, format('part5: EUR balance must be 400 alone, got %s', v_eur.current_balance_minor));
end $$;

-- ============================================================
-- Part 6 (Section 16): ADJUSTMENTS -- positive and negative, timing
-- semantics via available_at (an adjustment uses its OWN available_at,
-- exactly like a sale -- no sibling re-attribution applies to it).
-- ============================================================
insert into public.author_ledger_entries
  (id, author_id, entry_type, amount_minor, currency, available_at, created_at, description)
values
  ('f0500000-0000-0000-0000-000000000050', 'c0500000-0000-0000-0000-000000000006',
   'adjustment', 50, 'USD', now() - interval '1 day', now() - interval '1 day', 'goodwill credit, already available'),
  ('f0500000-0000-0000-0000-000000000051', 'c0500000-0000-0000-0000-000000000006',
   'adjustment', -20, 'USD', now() + interval '5 days', now(), 'future-dated correction, still pending');

do $$
declare
  v_summary record;
begin
  perform set_config('request.jwt.claim.sub', 'c0500000-0000-0000-0000-000000000006', true);
  set local role authenticated;
  select * into v_summary from public.get_author_financial_summary() where currency = 'USD';
  reset role;

  perform pg_temp.assert(v_summary.lifetime_adjustment_minor = 30, format('part6: lifetime_adjustment must be 50 + (-20) = 30, got %s', v_summary.lifetime_adjustment_minor));
  perform pg_temp.assert(v_summary.current_balance_minor = 30, format('part6: current_balance must be 30, got %s', v_summary.current_balance_minor));
  perform pg_temp.assert(v_summary.pending_minor = -20, format('part6: pending must be exactly the future-dated -20 adjustment, got %s', v_summary.pending_minor));
  perform pg_temp.assert(v_summary.available_minor = 50, format('part6: available must be exactly the already-available +50 adjustment, got %s', v_summary.available_minor));
end $$;

-- ============================================================
-- Part 6B (LEDGER-1D.1 Sections 3/4): THE EXPLICIT ADJUSTMENT MATRIX --
-- effective_at(adjustment) = COALESCE(available_at, created_at); a
-- future effective_at is pending, a past-or-NULL effective_at is
-- available -- applied IDENTICALLY regardless of the adjustment's own
-- sign. Part 6 above already covers past-dated (not NULL) positive and
-- future-dated negative; this part covers all four cells of the matrix
-- explicitly, including the two NULL-available_at cases Part 6 doesn't
-- exercise, on a dedicated author so none of these rows can be confused
-- with Part 6's own.
--
--   Case A: +50, available_at NULL       -> available (NULL coalesces
--                                            to created_at, which is
--                                            already in the past)
--   Case B: +30, available_at future     -> pending
--   Case C: -20, available_at NULL       -> available
--   Case D: -15, available_at future     -> pending
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('c0500000-0000-0000-0000-00000000000b', 'p050-p6b@test', now(), '{"role":"author","display_name":"P6B Adjustment Matrix"}');

insert into public.author_ledger_entries
  (id, author_id, entry_type, amount_minor, currency, available_at, created_at, description)
values
  ('f0500000-0000-0000-0000-000000000052', 'c0500000-0000-0000-0000-00000000000b',
   'adjustment', 50, 'USD', null, now() - interval '2 days', 'case A: positive, NULL available_at -> available'),
  ('f0500000-0000-0000-0000-000000000053', 'c0500000-0000-0000-0000-00000000000b',
   'adjustment', 30, 'USD', now() + interval '10 days', now(), 'case B: positive, future available_at -> pending'),
  ('f0500000-0000-0000-0000-000000000054', 'c0500000-0000-0000-0000-00000000000b',
   'adjustment', -20, 'USD', null, now() - interval '2 days', 'case C: negative, NULL available_at -> available'),
  ('f0500000-0000-0000-0000-000000000055', 'c0500000-0000-0000-0000-00000000000b',
   'adjustment', -15, 'USD', now() + interval '10 days', now(), 'case D: negative, future available_at -> pending');

do $$
declare
  v_summary record;
begin
  perform set_config('request.jwt.claim.sub', 'c0500000-0000-0000-0000-00000000000b', true);
  set local role authenticated;
  select * into v_summary from public.get_author_financial_summary() where currency = 'USD';
  reset role;

  perform pg_temp.assert(v_summary.lifetime_adjustment_minor = 45, format('part6b: lifetime_adjustment must be 50+30-20-15=45, got %s', v_summary.lifetime_adjustment_minor));
  perform pg_temp.assert(v_summary.net_earnings_minor = 45, format('part6b: net_earnings must equal 45 (adjustments only), got %s', v_summary.net_earnings_minor));
  perform pg_temp.assert(v_summary.available_minor = 30, format('part6b: available must be cases A+C = 50-20=30 (NULL -> available), got %s', v_summary.available_minor));
  perform pg_temp.assert(v_summary.pending_minor = 15, format('part6b: pending must be cases B+D = 30-15=15 (future -> pending), got %s', v_summary.pending_minor));
  perform pg_temp.assert(v_summary.current_balance_minor = 45, format('part6b: current_balance must be 45, got %s', v_summary.current_balance_minor));
  perform pg_temp.assert(
    v_summary.current_balance_minor = v_summary.pending_minor + v_summary.available_minor,
    format('part6b: reconciliation invariant violated: current=%s pending=%s available=%s',
      v_summary.current_balance_minor, v_summary.pending_minor, v_summary.available_minor)
  );
end $$;

-- ============================================================
-- Part 7 (Sections 9/12/13): ACTIVITY -- bounded pagination, own-only,
-- keyset (created_at, id) ordering, no internal identifiers.
-- ============================================================
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('a0500000-0000-0000-0000-000000000007', 'test', 'pay_p050_p7', 100, 'USD', 'succeeded');

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('f0500000-0000-0000-0000-000000000060', 'c0500000-0000-0000-0000-000000000007',
   'e0500000-0000-0000-0000-00000000000a', 'a0500000-0000-0000-0000-000000000007', 'sale', 80, 'USD', 8000, 100, 20,
   now() - interval '10 days', now() - interval '10 days');
insert into public.author_ledger_entries
  (id, author_id, entry_type, amount_minor, currency, available_at, created_at)
values
  ('f0500000-0000-0000-0000-000000000061', 'c0500000-0000-0000-0000-000000000007',
   'adjustment', 5, 'USD', now() - interval '9 days', now() - interval '9 days'),
  ('f0500000-0000-0000-0000-000000000062', 'c0500000-0000-0000-0000-000000000007',
   'adjustment', 3, 'USD', now() - interval '8 days', now() - interval '8 days'),
  ('f0500000-0000-0000-0000-000000000063', 'c0500000-0000-0000-0000-000000000007',
   'adjustment', 2, 'USD', now() - interval '7 days', now() - interval '7 days'),
  ('f0500000-0000-0000-0000-000000000064', 'c0500000-0000-0000-0000-000000000007',
   'adjustment', 1, 'USD', now() - interval '6 days', now() - interval '6 days');

do $$
declare
  v_page record;
  v_all_ids uuid[] := array[]::uuid[];
  v_cursor_created_at timestamptz := null;
  v_cursor_id uuid := null;
  v_row record;
  v_page_count integer;
  v_result_text text;
begin
  perform set_config('request.jwt.claim.sub', 'c0500000-0000-0000-0000-000000000007', true);
  set local role authenticated;

  -- Page through with limit=2, three pages, expecting exactly 5 total,
  -- strictly descending, no duplicates.
  loop
    v_page_count := 0;
    for v_row in
      select * from public.list_author_financial_activity(2, v_cursor_created_at, v_cursor_id)
    loop
      v_page_count := v_page_count + 1;
      v_all_ids := array_append(v_all_ids, v_row.id);
      v_cursor_created_at := v_row.created_at;
      v_cursor_id := v_row.id;
    end loop;
    exit when v_page_count = 0;
  end loop;
  reset role;

  perform pg_temp.assert(array_length(v_all_ids, 1) = 5, format('part7: paginating through all pages must yield exactly 5 rows total, got %s', coalesce(array_length(v_all_ids, 1), 0)));
  perform pg_temp.assert(
    (select count(distinct x) from unnest(v_all_ids) x) = 5,
    'part7: pagination must not return any duplicate row across pages'
  );

  -- Book context: the one 'sale' entry must carry its book id/title;
  -- adjustments (no purchase_id) must have null book context.
  perform pg_temp.assert(
    (select book_title from public.list_author_financial_activity(10, null, null) where id = 'f0500000-0000-0000-0000-000000000060') = 'P7 Activity Book',
    'part7: the sale entry must resolve its safe book title'
  );
  perform pg_temp.assert(
    (select book_id from public.list_author_financial_activity(10, null, null) where id = 'f0500000-0000-0000-0000-000000000061') is null,
    'part7: an adjustment entry with no purchase_id must have null book context'
  );

  -- Static contract: neither function's declared return shape may name
  -- any internal correlation identifier or buyer-related column.
  select pg_get_function_result('public.list_author_financial_activity(integer, timestamptz, uuid)'::regprocedure) into v_result_text;
  perform pg_temp.assert(v_result_text not like '%payment_id%', 'part7: list_author_financial_activity must never return payment_id');
  perform pg_temp.assert(v_result_text not like '%payout_id%', 'part7: list_author_financial_activity must never return payout_id');
  perform pg_temp.assert(v_result_text not like '%payment_refund_id%', 'part7: list_author_financial_activity must never return payment_refund_id');
  perform pg_temp.assert(v_result_text not like '%reference_id%', 'part7: list_author_financial_activity must never return reference_id');
  perform pg_temp.assert(v_result_text not like '%reference_type%', 'part7: list_author_financial_activity must never return reference_type');
  perform pg_temp.assert(v_result_text not like '%buyer%', 'part7: list_author_financial_activity must never return buyer identity');

  select pg_get_function_result('public.get_author_financial_summary()'::regprocedure) into v_result_text;
  perform pg_temp.assert(v_result_text not like '%payment_id%', 'part7: get_author_financial_summary must never return payment_id');
  perform pg_temp.assert(v_result_text not like '%provider%', 'part7: get_author_financial_summary must never return a provider identifier');

  -- Invalid cursor (one half supplied, not the other) must raise.
  set local role authenticated;
  begin
    perform * from public.list_author_financial_activity(10, now(), null);
    perform pg_temp.assert(false, 'part7: an invalid half-supplied cursor must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'invalid cursor', format('part7: unexpected error: %s', sqlerrm));
  end;
  reset role;
end $$;

-- ============================================================
-- Part 8 (Section 26 AUTHOR SECURITY / LEDGER-1D.1 Sections 6-8 RPC
-- GRANT MATRIX): own summary works; cross-author isolation, including a
-- direct row-level check that Author B can never obtain Author A's own
-- rows; reader gets empty; anon denied at both the behavioral AND the
-- catalog level; authenticated's EXECUTE grant confirmed directly.
-- ============================================================
do $$
declare
  v_p1_count integer;
  v_reader_count integer;
  v_p1_activity_ids uuid[];
  v_p2_activity_ids uuid[];
  v_cross_contamination integer;
begin
  -- P1 sees only their own single USD row, never P2/P3/etc.
  perform set_config('request.jwt.claim.sub', 'c0500000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select count(*) into v_p1_count from public.get_author_financial_summary();
  select array_agg(id) into v_p1_activity_ids from public.list_author_financial_activity(50, null, null);
  reset role;
  perform pg_temp.assert(v_p1_count = 1, format('part8: P1 must see exactly their own 1 currency row, got %s', v_p1_count));

  -- LEDGER-1D.1 Section 7/8: Author B (P2) must never be able to obtain
  -- Author A's (P1's) own rows -- a direct row-id-level check, stronger
  -- than merely observing that P2's aggregate numbers differ from P1's.
  perform set_config('request.jwt.claim.sub', 'c0500000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  select array_agg(id) into v_p2_activity_ids from public.list_author_financial_activity(50, null, null);
  reset role;
  select count(*) into v_cross_contamination
    from unnest(v_p1_activity_ids) p1_id
    where p1_id = any(v_p2_activity_ids);
  perform pg_temp.assert(
    v_cross_contamination = 0,
    format('part8: Author B (P2) must not receive any of Author A''s (P1''s) own activity row ids, found %s overlapping', v_cross_contamination)
  );
  perform pg_temp.assert(
    v_p1_activity_ids is not null and array_length(v_p1_activity_ids, 1) > 0,
    'part8: sanity check -- P1 must actually have activity rows for the isolation check above to mean anything'
  );

  -- A reader with zero ledger rows gets an empty summary and empty activity.
  perform set_config('request.jwt.claim.sub', 'c0500000-0000-0000-0000-000000000008', true);
  set local role authenticated;
  select count(*) into v_reader_count from public.get_author_financial_summary();
  reset role;
  perform pg_temp.assert(v_reader_count = 0, format('part8: a reader must see zero summary rows, got %s', v_reader_count));

  perform set_config('request.jwt.claim.sub', 'c0500000-0000-0000-0000-000000000008', true);
  set local role authenticated;
  select count(*) into v_reader_count from public.list_author_financial_activity(10, null, null);
  reset role;
  perform pg_temp.assert(v_reader_count = 0, format('part8: a reader must see zero activity rows, got %s', v_reader_count));

  -- anon is denied outright (EXECUTE never granted) -- behavioral proof.
  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
  begin
    perform * from public.get_author_financial_summary();
    perform pg_temp.assert(false, 'part8: anon must not be able to call get_author_financial_summary');
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.list_author_financial_activity(10, null, null);
    perform pg_temp.assert(false, 'part8: anon must not be able to call list_author_financial_activity');
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- LEDGER-1D.1 Section 6: direct catalog-level proof of the grant
  -- state itself, not just its behavioral consequence. Postgres treats
  -- the literal role name 'public' passed to has_function_privilege as
  -- a query against the PUBLIC pseudo-grant specifically (the implicit
  -- grant that would otherwise apply to every role) -- this is the
  -- precise thing Section 6 asks to confirm was explicitly revoked,
  -- independent of anon's own specific grant state.
  perform pg_temp.assert(
    has_function_privilege('public', 'public.get_author_financial_summary()', 'EXECUTE') = false,
    'part8: PUBLIC must have no EXECUTE grant on get_author_financial_summary'
  );
  perform pg_temp.assert(
    has_function_privilege('public', 'public.list_author_financial_activity(integer, timestamptz, uuid)', 'EXECUTE') = false,
    'part8: PUBLIC must have no EXECUTE grant on list_author_financial_activity'
  );
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.get_author_financial_summary()', 'EXECUTE') = true,
    'part8: authenticated must have an EXECUTE grant on get_author_financial_summary'
  );
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.list_author_financial_activity(integer, timestamptz, uuid)', 'EXECUTE') = true,
    'part8: authenticated must have an EXECUTE grant on list_author_financial_activity'
  );
  perform pg_temp.assert(
    has_function_privilege('anon', 'public.get_author_financial_summary()', 'EXECUTE') = false,
    'part8: anon must have no EXECUTE grant on get_author_financial_summary'
  );
  perform pg_temp.assert(
    has_function_privilege('anon', 'public.list_author_financial_activity(integer, timestamptz, uuid)', 'EXECUTE') = false,
    'part8: anon must have no EXECUTE grant on list_author_financial_activity'
  );
end $$;

-- ============================================================
-- Part 9 (Section 10 RAW TABLE ACCESS): an author can no longer read
-- author_ledger_entries directly (RLS filters to zero rows -- the
-- table grant is untouched, so this is NOT a privilege exception,
-- exactly the same "grant present, no matching policy -> empty result"
-- behavior migration 048's own suite already established); staff with
-- finance.view still reads the raw table in full, completely unaffected.
-- ============================================================
do $$
declare
  v_raw_count integer;
  v_staff_count integer;
begin
  perform set_config('request.jwt.claim.sub', 'c0500000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select count(*) into v_raw_count from public.author_ledger_entries;
  reset role;
  perform pg_temp.assert(v_raw_count = 0, format('part9: an author must see zero rows querying the raw table directly, got %s', v_raw_count));

  perform set_config('request.jwt.claim.sub', 'c0500000-0000-0000-0000-000000000009', true);
  set local role authenticated;
  select count(*) into v_staff_count from public.author_ledger_entries;
  reset role;
  perform pg_temp.assert(v_staff_count > 0, format('part9: staff with finance.view must still see raw ledger rows across all authors, got %s', v_staff_count));
end $$;

-- ============================================================
-- Part 10 (LEDGER-1D.1 Section 5): RECONCILIATION INVARIANT, SWEPT
-- ACROSS EVERY FIXTURE AUTHOR -- current_balance_minor = pending_minor
-- + available_minor must hold for every (author, currency) row this
-- reporting layer can produce. Individual parts above already prove
-- this case-by-case (including Part 3's negative-balance position and
-- Part 6B's four-way adjustment matrix); this sweep re-checks the same
-- invariant directly against the RPC's own live output for every
-- fixture author in this file, rather than trusting the per-part
-- arithmetic alone.
-- ============================================================
do $$
declare
  v_author_id uuid;
  v_row record;
  v_checked_count integer := 0;
begin
  foreach v_author_id in array array[
    'c0500000-0000-0000-0000-000000000001'::uuid, -- Part 1: pending-refund
    'c0500000-0000-0000-0000-000000000002'::uuid, -- Part 2: post-settlement refund
    'c0500000-0000-0000-0000-000000000003'::uuid, -- Part 3: post-payout negative balance
    'c0500000-0000-0000-0000-000000000004'::uuid, -- Part 4: bundle partial refund
    'c0500000-0000-0000-0000-000000000005'::uuid, -- Part 5: multi-currency (USD + EUR)
    'c0500000-0000-0000-0000-000000000006'::uuid, -- Part 6: adjustments
    'c0500000-0000-0000-0000-00000000000b'::uuid  -- Part 6B: adjustment matrix
  ]
  loop
    perform set_config('request.jwt.claim.sub', v_author_id::text, true);
    set local role authenticated;
    for v_row in select * from public.get_author_financial_summary() loop
      v_checked_count := v_checked_count + 1;
      perform pg_temp.assert(
        v_row.current_balance_minor = v_row.pending_minor + v_row.available_minor,
        format(
          'part10: reconciliation invariant violated for author %s currency %s: current=%s pending=%s available=%s',
          v_author_id, v_row.currency, v_row.current_balance_minor, v_row.pending_minor, v_row.available_minor
        )
      );
    end loop;
    reset role;
  end loop;

  -- Sanity check on the sweep itself: 6 single-currency authors + P5's
  -- 2 currency rows = 8 total summary rows expected across this loop.
  -- A lower count here would silently mean the invariant check above
  -- never actually ran against some author's real data.
  perform pg_temp.assert(
    v_checked_count = 8,
    format('part10: expected to check exactly 8 summary rows across all fixture authors, got %s', v_checked_count)
  );
end $$;

select 'ALL PASSED: 050_author_financial_reporting.test.sql' as result;

rollback;
