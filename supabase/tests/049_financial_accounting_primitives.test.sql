-- Committed SQL regression suite for migration 049 (LEDGER-1C /
-- LEDGER-1C.1: provider-neutral transactional sale/refund accounting
-- primitives, with payment->purchase-set immutability, derived buyer
-- identity, and the canonical payment_refunds table), REPAIRED for
-- migration 056 (STRIPE-CUTOVER-1C).
--
-- STRIPE-CUTOVER-1C intentionally changed the contract this suite
-- tests, in three ways this file's own repair reflects throughout:
--
-- 1. record_successful_sale()'s 6th parameter was renamed
--    p_available_at -> p_paid_at, and available_at is now DERIVED
--    internally as p_paid_at + interval '30 days' (migration 056 Part
--    13) -- every call below now passes a paid_at moment and every
--    assertion that inspects available_at compares against paid_at +
--    30 days, not against the value passed in directly.
--
-- 2. record_successful_sale() and mark_payment_event_processed()/
--    mark_payment_event_failed() are now INTERNAL financial primitives
--    -- EXECUTE was revoked from service_role, not just anon/
--    authenticated (migration 056 Parts 13/14, STRIPE-CUTOVER-1B.6
--    Section 24/25). Calls to these three functions below run as the
--    ambient migration-owner connection this whole suite already runs
--    under (no `set local role service_role` wrapper for THESE THREE
--    -- owner/superuser retains implicit EXECUTE regardless of that
--    revoke, which is the entire mechanism the new ledger wrapper RPCs
--    rely on; see 056_ledger_v1_transactional_payment_foundation.
--    test.sql for the actual proof that service_role itself is denied).
--    record_refund() and record_payment_event() are UNCHANGED
--    service_role grants -- their calls below still use `set local
--    role service_role`.
--
-- 3. record_refund()'s signature changed to require the payment's own
--    (provider, provider_payment_id) as new LEADING arguments --
--    resolving via purchases.payment_id was removed (migration 056
--    Part 15, STRIPE-CUTOVER-1B.5 Section G). Every call below supplies
--    the correct provider/provider_payment_id pair for the purchase
--    being refunded.
--
-- Former "matrix case F" (STRIPE-CUTOVER-1B.4/1B.5's central finding:
-- purchases is a REUSABLE entitlement row, so a purchase already linked
-- to one payment must remain claimable by a genuinely later, different
-- payment) is corrected below to assert the new, intentionally-changed
-- behavior instead of the old one -- see Part 5 Case F'.
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql -- no new test
-- infrastructure needed, same as every other suite in this directory.
--
-- Run manually against a disposable/local Postgres instance, AFTER
-- applying supabase/schema.sql (which already includes migration 056's
-- final state), from the repo root:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/049_financial_accounting_primitives.test.sql
--
-- Everything below runs inside one transaction and is rolled back at
-- the end. Denial tests separately exercise anon/authenticated/staff to
-- prove they cannot reach these functions, or the raw payment_refunds
-- table, at all.
--
-- NOTHING in this suite exercises real Stripe/PayPal/Paysera APIs --
-- 'paypal'/'paysera' below are plain open-text provider values proving
-- provider-neutrality, never real integrations.

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
-- Part 0: fixtures.
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('c0490000-0000-0000-0000-000000000001', 'p049-author-a@test', now(), '{"role":"author","display_name":"Author A"}'),
  ('c0490000-0000-0000-0000-000000000002', 'p049-author-b@test', now(), '{"role":"author","display_name":"Author B"}'),
  ('c0490000-0000-0000-0000-000000000003', 'p049-finance-staff@test', now(), '{"role":"reader","display_name":"Finance Staff"}'),
  ('c0490000-0000-0000-0000-000000000004', 'p049-reader@test', now(), '{"role":"reader","display_name":"Reader"}'),
  ('c0490000-0000-0000-0000-000000000005', 'p049-reader-two@test', now(), '{"role":"reader","display_name":"Reader Two"}');

insert into public.staff_members (user_id, role) values
  ('c0490000-0000-0000-0000-000000000003', 'admin');

insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('d0490000-0000-0000-0000-000000000001', 'c0490000-0000-0000-0000-000000000001', 'Single Sale Book', '', '', '', 999, 'published'),
  ('d0490000-0000-0000-0000-000000000002', 'c0490000-0000-0000-0000-000000000001', 'Bundle Book One', '', '', '', 100, 'published'),
  ('d0490000-0000-0000-0000-000000000003', 'c0490000-0000-0000-0000-000000000001', 'Bundle Book Two', '', '', '', 200, 'published'),
  ('d0490000-0000-0000-0000-000000000004', 'c0490000-0000-0000-0000-000000000001', 'Bundle Book Three', '', '', '', 301, 'published'),
  ('d0490000-0000-0000-0000-000000000005', 'c0490000-0000-0000-0000-000000000001', 'Edge Book 1c', '', '', '', 1, 'published'),
  ('d0490000-0000-0000-0000-000000000006', 'c0490000-0000-0000-0000-000000000001', 'Edge Book 2c', '', '', '', 2, 'published'),
  ('d0490000-0000-0000-0000-000000000007', 'c0490000-0000-0000-0000-000000000001', 'Edge Book 3c', '', '', '', 3, 'published'),
  ('d0490000-0000-0000-0000-000000000008', 'c0490000-0000-0000-0000-000000000001', 'Edge Book 99c', '', '', '', 99, 'published'),
  ('d0490000-0000-0000-0000-000000000009', 'c0490000-0000-0000-0000-000000000001', 'Edge Book 101c', '', '', '', 101, 'published'),
  ('d0490000-0000-0000-0000-00000000000a', 'c0490000-0000-0000-0000-000000000001', 'PayPal Provider Book', '', '', '', 500, 'published'),
  ('d0490000-0000-0000-0000-00000000000b', 'c0490000-0000-0000-0000-000000000001', 'Paysera Provider Book', '', '', '', 500, 'published'),
  ('d0490000-0000-0000-0000-00000000000c', 'c0490000-0000-0000-0000-000000000001', 'Payout Balance Book', '', '', '', 1000, 'published'),
  ('d0490000-0000-0000-0000-00000000000d', 'c0490000-0000-0000-0000-000000000001', 'Never-Linked Book', '', '', '', 1234, 'published'),
  ('d0490000-0000-0000-0000-000000000040', 'c0490000-0000-0000-0000-000000000001', 'Immut Single X', '', '', '', 150, 'published'),
  ('d0490000-0000-0000-0000-000000000041', 'c0490000-0000-0000-0000-000000000001', 'Immut Single Y (same gross)', '', '', '', 150, 'published'),
  ('d0490000-0000-0000-0000-000000000042', 'c0490000-0000-0000-0000-000000000001', 'Immut Bundle P', '', '', '', 120, 'published'),
  ('d0490000-0000-0000-0000-000000000043', 'c0490000-0000-0000-0000-000000000001', 'Immut Bundle Q', '', '', '', 130, 'published'),
  ('d0490000-0000-0000-0000-000000000044', 'c0490000-0000-0000-0000-000000000001', 'Immut Bundle R', '', '', '', 140, 'published'),
  ('d0490000-0000-0000-0000-000000000045', 'c0490000-0000-0000-0000-000000000001', 'Mixed Buyer Book One', '', '', '', 160, 'published'),
  ('d0490000-0000-0000-0000-000000000046', 'c0490000-0000-0000-0000-000000000001', 'Mixed Buyer Book Two', '', '', '', 170, 'published'),
  ('d0490000-0000-0000-0000-000000000047', 'c0490000-0000-0000-0000-000000000001', 'Buyer Mismatch Book', '', '', '', 180, 'published');

-- ============================================================
-- Part 1: SINGLE BOOK SALE -- payment inserted, purchase linked, one
-- ledger credit, exact economics, available_at derived, retry does not
-- duplicate. Also case A of the immutability matrix (Section 20).
-- ============================================================
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0490000-0000-0000-0000-000000000001', 'd0490000-0000-0000-0000-000000000001', 'c0490000-0000-0000-0000-000000000004', 'cs_p049_single', 999);

do $$
declare
  v_paid_at timestamptz := now();
  v_result record;
  v_first_entry_id uuid;
begin
  select * into v_result from public.record_successful_sale(
    'stripe', 'pay_p049_single', 'USD',
    array['e0490000-0000-0000-0000-000000000001'::uuid], 8000, v_paid_at
  );

  perform pg_temp.assert(v_result.created, 'part1: first call must create a new sale ledger entry');
  v_first_entry_id := v_result.ledger_entry_id;

  perform pg_temp.assert(
    (select payment_id from public.purchases where id = 'e0490000-0000-0000-0000-000000000001') is not null,
    'part1: purchase must now be linked to a payment'
  );
  perform pg_temp.assert(
    (select buyer_id from public.payments where provider = 'stripe' and provider_payment_id = 'pay_p049_single') = 'c0490000-0000-0000-0000-000000000004',
    'part1: payments.buyer_id must be derived from the purchase''s own reader_id'
  );
  perform pg_temp.assert(
    (select amount_minor from public.payments where provider = 'stripe' and provider_payment_id = 'pay_p049_single') = 999,
    'part1: payment amount_minor must equal the purchase gross'
  );
  perform pg_temp.assert(
    (select paid_at from public.payments where provider = 'stripe' and provider_payment_id = 'pay_p049_single') = v_paid_at,
    'part1: payments.paid_at must equal exactly the value the caller supplied, never now()'
  );
  perform pg_temp.assert(
    (select regime from public.payments where provider = 'stripe' and provider_payment_id = 'pay_p049_single') = 'librum_ledger_v1',
    'part1: payments.regime must be the hardcoded librum_ledger_v1 literal'
  );
  perform pg_temp.assert(
    (select amount_minor from public.author_ledger_entries where id = v_first_entry_id) = 799,
    'part1: author sale credit must be 999 - round(999*0.20) = 799'
  );
  perform pg_temp.assert(
    (select available_at from public.author_ledger_entries where id = v_first_entry_id) = v_paid_at + interval '30 days',
    'part1: available_at must be derived internally as paid_at + exactly 30 days'
  );

  -- Case A: identical retry (same set, same economics) must be a safe no-op.
  select * into v_result from public.record_successful_sale(
    'stripe', 'pay_p049_single', 'USD',
    array['e0490000-0000-0000-0000-000000000001'::uuid], 8000, v_paid_at
  );

  perform pg_temp.assert(not v_result.created, 'part1 (matrix A): identical retry must be recognized as already-recorded');
  perform pg_temp.assert(v_result.ledger_entry_id = v_first_entry_id, 'part1 (matrix A): retry must return the SAME ledger entry id');
  perform pg_temp.assert(
    (select count(*) from public.payments where provider = 'stripe' and provider_payment_id = 'pay_p049_single') = 1,
    'part1 (matrix A): retry must not create a second payment row'
  );
end $$;

-- ============================================================
-- Part 1B: LATE-RETRY-AFTER-REUSE (STRIPE-CUTOVER-1B.6's own required
-- proof scenario, carried into this suite's own single-book coverage).
-- The purchase from Part 1 is refunded, then legitimately repurchased
-- by a second, entirely independent payment at a DIFFERENT amount, then
-- the FIRST payment is retried -- it must remain safe/idempotent and
-- must never read the purchase's now-changed current amount_cents.
-- ============================================================
do $$
declare
  v_paid_at_1 timestamptz;
  v_result record;
  v_pay1_entry_id uuid;
  v_pay1_payment_id uuid;
begin
  select paid_at into v_paid_at_1 from public.payments where provider = 'stripe' and provider_payment_id = 'pay_p049_single';
  select id into v_pay1_payment_id from public.payments where provider = 'stripe' and provider_payment_id = 'pay_p049_single';
  select id into v_pay1_entry_id from public.author_ledger_entries
    where payment_id = v_pay1_payment_id and purchase_id = 'e0490000-0000-0000-0000-000000000001' and entry_type = 'sale';

  -- Refund PAY1, then simulate a legitimate repurchase under PAY2 at a
  -- DIFFERENT amount by directly reusing the same purchases row (the
  -- same upsert-onto-the-same-row mechanism finalize_book_checkout_
  -- intent_entitlement_core performs, exercised directly here since
  -- this suite tests the ledger primitives in isolation, not the
  -- checkout-intent layer).
  update public.purchases set refunded_at = now() where id = 'e0490000-0000-0000-0000-000000000001';
  update public.purchases set refunded_at = null, amount_cents = 1300 where id = 'e0490000-0000-0000-0000-000000000001';

  perform * from public.record_successful_sale(
    'stripe', 'pay_p049_single_v2', 'USD',
    array['e0490000-0000-0000-0000-000000000001'::uuid], 8000, now()
  );

  perform pg_temp.assert(
    (select payment_id from public.purchases where id = 'e0490000-0000-0000-0000-000000000001')
      = (select id from public.payments where provider = 'stripe' and provider_payment_id = 'pay_p049_single_v2'),
    'part1B: after a genuine repurchase, purchases.payment_id must now point to the NEW payment'
  );
  perform pg_temp.assert(
    (select amount_minor from public.payments where provider = 'stripe' and provider_payment_id = 'pay_p049_single_v2') = 1300,
    'part1B: the new payment must reflect the new 1300 amount'
  );

  -- Late retry of PAY1 -- must remain a safe no-op, using ONLY PAY1's
  -- own frozen paid_at/economics, never the purchase's current 1300.
  select * into v_result from public.record_successful_sale(
    'stripe', 'pay_p049_single', 'USD',
    array['e0490000-0000-0000-0000-000000000001'::uuid], 8000, v_paid_at_1
  );

  perform pg_temp.assert(not v_result.created, 'part1B: PAY1''s late retry after reuse must still be recognized as already-recorded');
  perform pg_temp.assert(v_result.ledger_entry_id = v_pay1_entry_id, 'part1B: PAY1''s late retry must return PAY1''s own original ledger entry id');
  perform pg_temp.assert(
    (select amount_minor from public.payments where provider = 'stripe' and provider_payment_id = 'pay_p049_single') = 999,
    'part1B: PAY1''s own payment row must remain frozen at 999, unaffected by the 1300 reuse'
  );
  perform pg_temp.assert(
    (select gross_amount_minor from public.author_ledger_entries where id = v_pay1_entry_id) = 999,
    'part1B: PAY1''s own sale ledger row must remain frozen at gross=999'
  );
  perform pg_temp.assert(
    (select payment_id from public.purchases where id = 'e0490000-0000-0000-0000-000000000001')
      = (select id from public.payments where provider = 'stripe' and provider_payment_id = 'pay_p049_single_v2'),
    'part1B: PAY1''s late retry must NOT reset purchases.payment_id back from PAY2 to PAY1'
  );

  -- PAY2 remains independently refundable.
  perform public.record_refund('stripe', 'pay_p049_single_v2', 'e0490000-0000-0000-0000-000000000001', 'refund_p049_single_v2');
  perform pg_temp.assert(
    (select status from public.payments where provider = 'stripe' and provider_payment_id = 'pay_p049_single_v2') = 'refunded',
    'part1B: PAY2 must be independently refundable, unaffected by PAY1''s own already-refunded history'
  );

  -- Restore state for Part 2 onward (which still assumes purchase
  -- 000001 is linked to the ORIGINAL pay_p049_single payment at 999).
  update public.purchases
    set refunded_at = null, amount_cents = 999, payment_id = v_pay1_payment_id
    where id = 'e0490000-0000-0000-0000-000000000001';
end $$;

-- ============================================================
-- Part 2: CONFLICTING ECONOMICS RETRY.
-- ============================================================
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0490000-0000-0000-0000-000000000099', 'd0490000-0000-0000-0000-00000000000d', 'c0490000-0000-0000-0000-000000000004', 'cs_p049_conflict', 1234);

do $$
begin
  begin
    perform * from public.record_successful_sale(
      'stripe', 'pay_p049_single', 'USD',
      array['e0490000-0000-0000-0000-000000000001'::uuid], 5000, now()
    );
    perform pg_temp.assert(false, 'part2: a retry with a different royalty_rate_bps must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%royalty_rate_bps%' or sqlerrm like '%does not match%', format('part2: unexpected error: %s', sqlerrm));
  end;

  perform pg_temp.assert(
    (select amount_minor from public.author_ledger_entries
       where payment_id = (select id from public.payments where provider = 'stripe' and provider_payment_id = 'pay_p049_single')
         and purchase_id = 'e0490000-0000-0000-0000-000000000001' and entry_type = 'sale') = 799,
    'part2: the original sale entry must be completely unchanged after the rejected conflicting retry'
  );
end $$;

-- ============================================================
-- Part 3: BUNDLE -- one payment, multiple purchases, one sale ledger
-- entry per purchase, allocations sum exactly to gross.
-- ============================================================
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0490000-0000-0000-0000-000000000002', 'd0490000-0000-0000-0000-000000000002', 'c0490000-0000-0000-0000-000000000004', 'cs_p049_bundle', 100),
  ('e0490000-0000-0000-0000-000000000003', 'd0490000-0000-0000-0000-000000000003', 'c0490000-0000-0000-0000-000000000004', 'cs_p049_bundle', 200),
  ('e0490000-0000-0000-0000-000000000004', 'd0490000-0000-0000-0000-000000000004', 'c0490000-0000-0000-0000-000000000004', 'cs_p049_bundle', 301);

do $$
declare
  v_total_author bigint;
  v_total_librum bigint;
begin
  perform * from public.record_successful_sale(
    'stripe', 'pay_p049_bundle', 'USD',
    array[
      'e0490000-0000-0000-0000-000000000002'::uuid,
      'e0490000-0000-0000-0000-000000000003'::uuid,
      'e0490000-0000-0000-0000-000000000004'::uuid
    ], 8000, now()
  );

  perform pg_temp.assert(
    (select amount_minor from public.payments where provider = 'stripe' and provider_payment_id = 'pay_p049_bundle') = 601,
    'part3: bundle payment amount_minor must equal 100+200+301 = 601'
  );
  perform pg_temp.assert(
    (select count(*) from public.author_ledger_entries
       where entry_type = 'sale'
         and purchase_id in ('e0490000-0000-0000-0000-000000000002','e0490000-0000-0000-0000-000000000003','e0490000-0000-0000-0000-000000000004')) = 3,
    'part3: exactly one sale ledger entry per bundle purchase must exist'
  );

  select sum(amount_minor), sum(librum_amount_minor) into v_total_author, v_total_librum
    from public.author_ledger_entries
    where entry_type = 'sale'
      and purchase_id in ('e0490000-0000-0000-0000-000000000002','e0490000-0000-0000-0000-000000000003','e0490000-0000-0000-0000-000000000004');

  perform pg_temp.assert(v_total_author + v_total_librum = 601, format('part3: total author + librum shares must equal 601 exactly, got %s', v_total_author + v_total_librum));

  -- Case B of the immutability matrix: identical retry with the SAME
  -- set supplied in a DIFFERENT array order must be a safe no-op.
  perform * from public.record_successful_sale(
    'stripe', 'pay_p049_bundle', 'USD',
    array[
      'e0490000-0000-0000-0000-000000000004'::uuid,
      'e0490000-0000-0000-0000-000000000002'::uuid,
      'e0490000-0000-0000-0000-000000000003'::uuid
    ], 8000, now()
  );
  perform pg_temp.assert(
    (select count(*) from public.author_ledger_entries
       where entry_type = 'sale'
         and purchase_id in ('e0490000-0000-0000-0000-000000000002','e0490000-0000-0000-0000-000000000003','e0490000-0000-0000-0000-000000000004')) = 3,
    'part3 (matrix B): a reordered identical retry must not create duplicate ledger entries'
  );
end $$;

-- ============================================================
-- Part 4: MONEY EDGE CASES -- 1, 2, 3, 99, 101 minor units.
-- ============================================================
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0490000-0000-0000-0000-000000000010', 'd0490000-0000-0000-0000-000000000005', 'c0490000-0000-0000-0000-000000000004', 'cs_p049_edge1', 1),
  ('e0490000-0000-0000-0000-000000000011', 'd0490000-0000-0000-0000-000000000006', 'c0490000-0000-0000-0000-000000000004', 'cs_p049_edge2', 2),
  ('e0490000-0000-0000-0000-000000000012', 'd0490000-0000-0000-0000-000000000007', 'c0490000-0000-0000-0000-000000000004', 'cs_p049_edge3', 3),
  ('e0490000-0000-0000-0000-000000000013', 'd0490000-0000-0000-0000-000000000008', 'c0490000-0000-0000-0000-000000000004', 'cs_p049_edge99', 99),
  ('e0490000-0000-0000-0000-000000000014', 'd0490000-0000-0000-0000-000000000009', 'c0490000-0000-0000-0000-000000000004', 'cs_p049_edge101', 101);

do $$
declare
  v_case record;
  v_result record;
  v_actual_librum bigint;
  v_actual_author bigint;
begin
  for v_case in
    select * from (values
      ('e0490000-0000-0000-0000-000000000010'::uuid, 'pay_p049_edge1', 1::bigint, 0::bigint, 1::bigint),
      ('e0490000-0000-0000-0000-000000000011'::uuid, 'pay_p049_edge2', 2::bigint, 0::bigint, 2::bigint),
      ('e0490000-0000-0000-0000-000000000012'::uuid, 'pay_p049_edge3', 3::bigint, 1::bigint, 2::bigint),
      ('e0490000-0000-0000-0000-000000000013'::uuid, 'pay_p049_edge99', 99::bigint, 20::bigint, 79::bigint),
      ('e0490000-0000-0000-0000-000000000014'::uuid, 'pay_p049_edge101', 101::bigint, 20::bigint, 81::bigint)
    ) as t(purchase_id, provider_payment_id, gross, expected_librum, expected_author)
  loop
    select * into v_result from public.record_successful_sale(
      'stripe', v_case.provider_payment_id, 'USD',
      array[v_case.purchase_id], 8000, now()
    );

    select librum_amount_minor, amount_minor into v_actual_librum, v_actual_author
      from public.author_ledger_entries where id = v_result.ledger_entry_id;

    perform pg_temp.assert(v_actual_librum = v_case.expected_librum, format('part4: gross=%s expected librum=%s got %s', v_case.gross, v_case.expected_librum, v_actual_librum));
    perform pg_temp.assert(v_actual_author = v_case.expected_author, format('part4: gross=%s expected author=%s got %s', v_case.gross, v_case.expected_author, v_actual_author));
    perform pg_temp.assert(v_actual_librum + v_actual_author = v_case.gross, format('part4: gross=%s author+librum must reconcile exactly, got %s', v_case.gross, v_actual_librum + v_actual_author));
  end loop;
end $$;

-- ============================================================
-- Part 5: PURCHASE-SET IMMUTABILITY MATRIX (cases C, D, E, F').
-- ============================================================
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0490000-0000-0000-0000-000000000040', 'd0490000-0000-0000-0000-000000000040', 'c0490000-0000-0000-0000-000000000004', 'cs_p049_immut_x', 150),
  ('e0490000-0000-0000-0000-000000000041', 'd0490000-0000-0000-0000-000000000041', 'c0490000-0000-0000-0000-000000000004', 'cs_p049_immut_y', 150),
  ('e0490000-0000-0000-0000-000000000042', 'd0490000-0000-0000-0000-000000000042', 'c0490000-0000-0000-0000-000000000004', 'cs_p049_immut_p', 120),
  ('e0490000-0000-0000-0000-000000000043', 'd0490000-0000-0000-0000-000000000043', 'c0490000-0000-0000-0000-000000000004', 'cs_p049_immut_q', 130),
  ('e0490000-0000-0000-0000-000000000044', 'd0490000-0000-0000-0000-000000000044', 'c0490000-0000-0000-0000-000000000004', 'cs_p049_immut_r', 140);

do $$
begin
  perform * from public.record_successful_sale(
    'stripe', 'pay_immut_single', 'USD',
    array['e0490000-0000-0000-0000-000000000040'::uuid], 8000, now()
  );

  -- Case C: same payment, a DIFFERENT purchase of the SAME gross value
  -- ("substitute equal-value purchase") -- must be rejected.
  begin
    perform * from public.record_successful_sale(
      'stripe', 'pay_immut_single', 'USD',
      array['e0490000-0000-0000-0000-000000000041'::uuid], 8000, now()
    );
    perform pg_temp.assert(false, 'part5 (matrix C): substituting an equal-value purchase for an already-accounted payment must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%different set of purchases%', format('part5 (matrix C): unexpected error: %s', sqlerrm));
  end;
  perform pg_temp.assert(
    (select payment_id from public.purchases where id = 'e0490000-0000-0000-0000-000000000041') is null,
    'part5 (matrix C): the substitute purchase must remain unlinked after the rejected attempt'
  );

  -- Establish a bundle payment funding P and Q.
  perform * from public.record_successful_sale(
    'stripe', 'pay_immut_bundle', 'USD',
    array['e0490000-0000-0000-0000-000000000042'::uuid, 'e0490000-0000-0000-0000-000000000043'::uuid],
    8000, now()
  );

  -- Case D: same payment, a SUBSET (just P) -- must be rejected.
  begin
    perform * from public.record_successful_sale(
      'stripe', 'pay_immut_bundle', 'USD',
      array['e0490000-0000-0000-0000-000000000042'::uuid], 8000, now()
    );
    perform pg_temp.assert(false, 'part5 (matrix D): a subset of an already-accounted payment''s purchase set must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%different set of purchases%', format('part5 (matrix D): unexpected error: %s', sqlerrm));
  end;

  -- Case E: same payment, a SUPERSET (P, Q, and R) -- must be rejected.
  begin
    perform * from public.record_successful_sale(
      'stripe', 'pay_immut_bundle', 'USD',
      array['e0490000-0000-0000-0000-000000000042'::uuid, 'e0490000-0000-0000-0000-000000000043'::uuid, 'e0490000-0000-0000-0000-000000000044'::uuid],
      8000, now()
    );
    perform pg_temp.assert(false, 'part5 (matrix E): a superset of an already-accounted payment''s purchase set must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%different set of purchases%', format('part5 (matrix E): unexpected error: %s', sqlerrm));
  end;
  perform pg_temp.assert(
    (select payment_id from public.purchases where id = 'e0490000-0000-0000-0000-000000000044') is null,
    'part5 (matrix E): R must remain unlinked -- the rejected superset attempt must not have partially applied'
  );

  -- Case F' (STRIPE-CUTOVER-1B.4/1B.5/1B.6 correction -- was "must be
  -- rejected" pre-056; now the INTENDED, correct behavior): P is
  -- already linked to pay_immut_bundle, but purchases is a REUSABLE
  -- entitlement row -- a genuinely NEW, different payment attempting to
  -- claim it must SUCCEED (this is exactly the repeat-purchase-after-
  -- reuse scenario the whole 1B.4-1B.6 correction chain exists for).
  -- The wrapper layer (finalize_ledger_book_payment, tested in
  -- 056_ledger_v1_transactional_payment_foundation.test.sql) is what
  -- actually prevents this from ever double-selling an ACTIVELY-owned
  -- book in production -- record_successful_sale itself, now callable
  -- only via that wrapper, no longer needs or performs this check.
  perform * from public.record_successful_sale(
    'stripe', 'pay_immut_other', 'USD',
    array['e0490000-0000-0000-0000-000000000042'::uuid], 8000, now()
  );
  perform pg_temp.assert(
    (select payment_id from public.purchases where id = 'e0490000-0000-0000-0000-000000000042')
      = (select id from public.payments where provider = 'stripe' and provider_payment_id = 'pay_immut_other'),
    'part5 (matrix F''): a genuinely new payment MUST now be able to claim a purchase previously linked to a different payment'
  );
  perform pg_temp.assert(
    (select count(*) from public.author_ledger_entries
       where purchase_id = 'e0490000-0000-0000-0000-000000000042' and entry_type = 'sale') = 2,
    'part5 (matrix F''): the purchase now has two independent, coexisting historical sale ledger entries -- one per payment'
  );
end $$;

-- ============================================================
-- Part 6: BUYER IDENTITY (matrix cases G, H).
-- ============================================================
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0490000-0000-0000-0000-000000000045', 'd0490000-0000-0000-0000-000000000045', 'c0490000-0000-0000-0000-000000000004', 'cs_p049_mixed_a', 160),
  ('e0490000-0000-0000-0000-000000000046', 'd0490000-0000-0000-0000-000000000046', 'c0490000-0000-0000-0000-000000000005', 'cs_p049_mixed_b', 170),
  ('e0490000-0000-0000-0000-000000000047', 'd0490000-0000-0000-0000-000000000047', 'c0490000-0000-0000-0000-000000000004', 'cs_p049_buyer_mismatch', 180);

do $$
begin
  -- Case G: mixed readers in one payment -- rejected outright.
  begin
    perform * from public.record_successful_sale(
      'stripe', 'pay_mixed_buyers', 'USD',
      array['e0490000-0000-0000-0000-000000000045'::uuid, 'e0490000-0000-0000-0000-000000000046'::uuid],
      8000, now()
    );
    perform pg_temp.assert(false, 'part6 (matrix G): a purchase set spanning two different readers must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%mixed buyers%', format('part6 (matrix G): unexpected error: %s', sqlerrm));
  end;
  perform pg_temp.assert(
    (select count(*) from public.payments where provider = 'stripe' and provider_payment_id = 'pay_mixed_buyers') = 0,
    'part6 (matrix G): the rejected mixed-buyer payment must not have been created'
  );

  -- Case H: reader A's purchase, but the caller asserts buyer = reader
  -- B -- rejected outright, never silently overridden.
  begin
    perform * from public.record_successful_sale(
      'stripe', 'pay_buyer_mismatch', 'USD',
      array['e0490000-0000-0000-0000-000000000047'::uuid], 8000, now(),
      'c0490000-0000-0000-0000-000000000005'
    );
    perform pg_temp.assert(false, 'part6 (matrix H): a caller-supplied buyer_id that disagrees with the derived reader must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%does not match the reader derived%', format('part6 (matrix H): unexpected error: %s', sqlerrm));
  end;

  -- Sanity: the SAME call with the CORRECT buyer_id (matching the
  -- derived reader) succeeds normally.
  perform * from public.record_successful_sale(
    'stripe', 'pay_buyer_match', 'USD',
    array['e0490000-0000-0000-0000-000000000047'::uuid], 8000, now(),
    'c0490000-0000-0000-0000-000000000004'
  );
  perform pg_temp.assert(
    (select buyer_id from public.payments where provider = 'stripe' and provider_payment_id = 'pay_buyer_match') = 'c0490000-0000-0000-0000-000000000004',
    'part6: a correctly-matching caller-supplied buyer_id must succeed and store the derived reader'
  );
end $$;

-- ============================================================
-- Part 7: FULL REFUND -- canonical payment_refunds row, exact negative
-- reversal, original sale untouched, duplicate provider_refund_id
-- rejected/no-op safely, refund immediately effective, payment status
-- becomes refunded for a single-purchase payment.
-- ============================================================
do $$
declare
  v_original_sale_amount bigint;
  v_result record;
  v_first_refund_id uuid;
begin
  select amount_minor into v_original_sale_amount
    from public.author_ledger_entries
    where payment_id = (select id from public.payments where provider = 'stripe' and provider_payment_id = 'pay_p049_single')
      and purchase_id = 'e0490000-0000-0000-0000-000000000001' and entry_type = 'sale';

  set local role service_role;
  select * into v_result from public.record_refund('stripe', 'pay_p049_single', 'e0490000-0000-0000-0000-000000000001', 'refund_p049_single');
  reset role;

  perform pg_temp.assert(v_result.created, 'part7: first refund call must create a new payment_refunds row and ledger entry');
  v_first_refund_id := v_result.payment_refund_id;

  perform pg_temp.assert(
    (select provider from public.payment_refunds where id = v_first_refund_id) = 'stripe',
    'part7: payment_refunds.provider must be derived from the original payment, never separately supplied'
  );
  perform pg_temp.assert(
    (select payment_id from public.payment_refunds where id = v_first_refund_id)
      = (select id from public.payments where provider = 'stripe' and provider_payment_id = 'pay_p049_single'),
    'part7: payment_refunds.payment_id must match the payment resolved via (provider, provider_payment_id)'
  );
  perform pg_temp.assert(
    (select amount_minor from public.payment_refunds where id = v_first_refund_id) = 999,
    'part7: payment_refunds.amount_minor must equal the original frozen sale gross (999), not a caller-supplied value'
  );
  perform pg_temp.assert(
    (select payment_refund_id from public.author_ledger_entries where id = v_result.ledger_entry_id) = v_first_refund_id,
    'part7: the ledger refund entry must be correlated to the canonical payment_refunds row via payment_refund_id'
  );
  perform pg_temp.assert(
    (select amount_minor from public.author_ledger_entries where id = v_result.ledger_entry_id) = -v_original_sale_amount,
    'part7: refund amount must be exactly the negation of the original sale author amount'
  );
  perform pg_temp.assert(
    (select amount_minor from public.author_ledger_entries
       where payment_id = (select id from public.payments where provider = 'stripe' and provider_payment_id = 'pay_p049_single')
         and purchase_id = 'e0490000-0000-0000-0000-000000000001' and entry_type = 'sale') = v_original_sale_amount,
    'part7: the original sale entry must remain completely unchanged'
  );
  perform pg_temp.assert(
    (select available_at from public.author_ledger_entries where id = v_result.ledger_entry_id)
      = (select created_at from public.author_ledger_entries where id = v_result.ledger_entry_id),
    'part7: a refund must be immediately available (available_at = created_at)'
  );
  perform pg_temp.assert(
    (select status from public.payments where provider = 'stripe' and provider_payment_id = 'pay_p049_single') = 'refunded',
    'part7: the single-purchase payment status must become refunded (100% of its total is now refunded)'
  );

  -- Duplicate refund with the SAME provider_refund_id: safe no-op.
  set local role service_role;
  select * into v_result from public.record_refund('stripe', 'pay_p049_single', 'e0490000-0000-0000-0000-000000000001', 'refund_p049_single');
  reset role;
  perform pg_temp.assert(not v_result.created, 'part7: a retry with the same provider_refund_id must be recognized as already-recorded');
  perform pg_temp.assert(v_result.payment_refund_id = v_first_refund_id, 'part7: retry must return the same payment_refund_id');
  perform pg_temp.assert(
    (select count(*) from public.payment_refunds
       where payment_id = (select id from public.payments where provider = 'stripe' and provider_payment_id = 'pay_p049_single')
         and purchase_id = 'e0490000-0000-0000-0000-000000000001') = 1,
    'part7: retry must not create a second payment_refunds row for THIS payment (Part 1B already legitimately created an independent one for pay_p049_single_v2)'
  );

  -- A genuinely different provider_refund_id for an already-refunded
  -- purchase: full-refund-only V1 rejects it outright.
  set local role service_role;
  begin
    perform * from public.record_refund('stripe', 'pay_p049_single', 'e0490000-0000-0000-0000-000000000001', 'refund_p049_single_DIFFERENT');
    perform pg_temp.assert(false, 'part7: a second refund for an already-refunded purchase under a different provider_refund_id must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%already been refunded%', format('part7: unexpected error: %s', sqlerrm));
  end;
  reset role;
end $$;

-- A purchase with no sale entry at all (or no such payment) cannot be
-- refunded.
do $$
begin
  set local role service_role;
  begin
    perform * from public.record_refund('stripe', 'pay_p049_single', 'e0490000-0000-0000-0000-000000000099', 'refund_no_payment');
    perform pg_temp.assert(false, 'part7: refunding a purchase with no sale ledger entry for the named payment must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%no sale ledger entry found%', format('part7: unexpected error: %s', sqlerrm));
  end;
  reset role;
end $$;

-- A provider_refund_id already used for one purchase cannot be reused
-- for a genuinely different purchase.
do $$
begin
  set local role service_role;
  begin
    perform * from public.record_refund('stripe', 'pay_p049_edge1', 'e0490000-0000-0000-0000-000000000010', 'refund_p049_single');
    perform pg_temp.assert(false, 'part7: reusing a provider_refund_id already recorded against a different purchase must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%different payment/purchase%', format('part7: unexpected error: %s', sqlerrm));
  end;
  reset role;
end $$;

-- ============================================================
-- Part 8: BUNDLE PARTIAL REFUND -- exactly the task's own worked
-- example: payment = 601 (100/200/301); refund the 200 item first
-- (partially_refunded), then the remaining two (refunded), with no
-- rounding drift.
-- ============================================================
do $$
declare
  v_result record;
begin
  set local role service_role;
  select * into v_result from public.record_refund('stripe', 'pay_p049_bundle', 'e0490000-0000-0000-0000-000000000003', 'refund_p049_bundle_200');
  reset role;

  perform pg_temp.assert(v_result.created, 'part8: refunding the 200-unit bundle item must succeed');
  perform pg_temp.assert(
    (select amount_minor from public.payment_refunds where id = v_result.payment_refund_id) = 200,
    'part8: the payment_refunds row for this item must record exactly 200'
  );
  perform pg_temp.assert(
    (select status from public.payments where provider = 'stripe' and provider_payment_id = 'pay_p049_bundle') = 'partially_refunded',
    'part8: refunding one of three bundle items must leave the payment partially_refunded, not refunded'
  );
  perform pg_temp.assert(
    (select amount_minor from public.author_ledger_entries where purchase_id = 'e0490000-0000-0000-0000-000000000002' and entry_type = 'sale') is not null,
    'part8: the OTHER bundle purchases'' sale entries must be untouched'
  );
  perform pg_temp.assert(
    (select count(*) from public.author_ledger_entries where purchase_id = 'e0490000-0000-0000-0000-000000000002' and entry_type = 'refund') = 0,
    'part8: the other bundle purchases must not have been refunded'
  );

  -- Refund the remaining two items.
  set local role service_role;
  perform * from public.record_refund('stripe', 'pay_p049_bundle', 'e0490000-0000-0000-0000-000000000002', 'refund_p049_bundle_100');
  perform * from public.record_refund('stripe', 'pay_p049_bundle', 'e0490000-0000-0000-0000-000000000004', 'refund_p049_bundle_301');
  reset role;

  perform pg_temp.assert(
    (select status from public.payments where provider = 'stripe' and provider_payment_id = 'pay_p049_bundle') = 'refunded',
    'part8: once all three items are refunded, the payment must become fully refunded'
  );
  perform pg_temp.assert(
    (select coalesce(sum(amount_minor), 0) from public.payment_refunds
       where payment_id = (select id from public.payments where provider = 'stripe' and provider_payment_id = 'pay_p049_bundle')) = 601,
    'part8: the sum of all payment_refunds for this payment must equal 601 exactly -- no rounding drift'
  );
end $$;

-- ============================================================
-- Part 9: REFUND AFTER "PAYOUT" -- proves a negative net author balance
-- is structurally permitted even after money has already been paid
-- out.
-- ============================================================
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0490000-0000-0000-0000-000000000020', 'd0490000-0000-0000-0000-00000000000c', 'c0490000-0000-0000-0000-000000000004', 'cs_p049_payout_balance', 1000);

do $$
declare
  v_result record;
  v_author_sale_amount bigint;
  v_payout_id uuid;
  v_net_balance bigint;
begin
  select * into v_result from public.record_successful_sale(
    'stripe', 'pay_p049_payout_balance', 'USD',
    array['e0490000-0000-0000-0000-000000000020'::uuid], 8000, now()
  );

  select amount_minor into v_author_sale_amount
    from public.author_ledger_entries where id = v_result.ledger_entry_id;

  -- LEDGER-1E-C.1: provider/provider_reference/paid_at are populated
  -- here (synthetic test values) so this fixture stays valid under
  -- migration 051's later-added
  -- author_payouts_paid_requires_provider_and_reference CHECK -- a rule
  -- that did not exist when this file was originally written. Fixture-
  -- validity fix only: amount_minor/currency/status and the net-balance
  -- assertion below are unchanged.
  insert into public.author_payouts (id, author_id, amount_minor, currency, status, paid_at, provider, provider_reference)
    values (gen_random_uuid(), 'c0490000-0000-0000-0000-000000000001', v_author_sale_amount, 'USD', 'paid',
      now(), 'test', 'ref-p049-payout-balance-001')
    returning id into v_payout_id;

  insert into public.author_ledger_entries (author_id, payout_id, entry_type, amount_minor, currency, available_at)
    values ('c0490000-0000-0000-0000-000000000001', v_payout_id, 'payout', -v_author_sale_amount, 'USD', now());

  set local role service_role;
  perform * from public.record_refund('stripe', 'pay_p049_payout_balance', 'e0490000-0000-0000-0000-000000000020', 'refund_after_payout');
  reset role;

  select coalesce(sum(amount_minor), 0) into v_net_balance
    from public.author_ledger_entries
    where author_id = 'c0490000-0000-0000-0000-000000000001'
      and (purchase_id = 'e0490000-0000-0000-0000-000000000020' or payout_id = v_payout_id);

  perform pg_temp.assert(
    v_net_balance = -v_author_sale_amount,
    format('part9: sale + payout + refund for this one purchase/payout pair must net to exactly -%s, got %s', v_author_sale_amount, v_net_balance)
  );
end $$;

-- ============================================================
-- Part 10: PROVIDER NEUTRALITY -- identical sale AND refund behavior
-- for arbitrary open-text provider strings.
-- ============================================================
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0490000-0000-0000-0000-000000000030', 'd0490000-0000-0000-0000-00000000000a', 'c0490000-0000-0000-0000-000000000004', 'cs_p049_paypal', 500),
  ('e0490000-0000-0000-0000-000000000031', 'd0490000-0000-0000-0000-00000000000b', 'c0490000-0000-0000-0000-000000000004', 'cs_p049_paysera', 500);

do $$
declare
  v_result record;
  v_refund_result record;
begin
  select * into v_result from public.record_successful_sale(
    'paypal', 'PAYID-P049', 'USD',
    array['e0490000-0000-0000-0000-000000000030'::uuid], 8000, now()
  );
  perform pg_temp.assert(v_result.created, 'part10: provider=paypal must work identically to provider=stripe');

  select * into v_result from public.record_successful_sale(
    'paysera', 'PAYID-P049', 'USD',
    array['e0490000-0000-0000-0000-000000000031'::uuid], 8000, now()
  );
  perform pg_temp.assert(v_result.created, 'part10: provider=paysera must work identically, reusing the same provider_payment_id string as paypal above');
  perform pg_temp.assert(
    (select count(*) from public.payments where provider_payment_id = 'PAYID-P049') = 2,
    'part10: two DIFFERENT providers may share the same provider_payment_id string'
  );

  -- Refund the paypal purchase -- payment_refunds.provider must be
  -- derived as 'paypal', never hardcoded.
  set local role service_role;
  select * into v_refund_result from public.record_refund('paypal', 'PAYID-P049', 'e0490000-0000-0000-0000-000000000030', 'REFUNDID-P049-PAYPAL');
  reset role;
  perform pg_temp.assert(
    (select provider from public.payment_refunds where id = v_refund_result.payment_refund_id) = 'paypal',
    'part10: a refund on a paypal-provider purchase must derive provider=paypal, not stripe'
  );
end $$;

-- ============================================================
-- Part 11: PAYMENT EVENT INGESTION/IDEMPOTENCY, INCLUDING CONFLICT
-- SAFETY (a retry with a different event_type must fail, not silently
-- return the previous row). Also STRIPE-CUTOVER-1B.3's new
-- provider_payment_id binding column.
-- ============================================================
do $$
declare
  v_event record;
  v_event_id uuid;
begin
  set local role service_role;
  select * into v_event from public.record_payment_event('paypal', 'evt_p049_123', 'CHECKOUT.ORDER.COMPLETED', 'PAYID-P049-EVT');
  reset role;
  perform pg_temp.assert(not v_event.already_existed, 'part11: the first record_payment_event call must not report already_existed');
  perform pg_temp.assert(v_event.provider_payment_id = 'PAYID-P049-EVT', 'part11: provider_payment_id must be persisted on the fresh insert');
  v_event_id := v_event.id;

  set local role service_role;
  select * into v_event from public.record_payment_event('paypal', 'evt_p049_123', 'CHECKOUT.ORDER.COMPLETED', 'PAYID-P049-EVT');
  reset role;
  perform pg_temp.assert(v_event.already_existed, 'part11: a repeat call with the same (provider, provider_event_id, event_type) must report already_existed');
  perform pg_temp.assert(v_event.id = v_event_id, 'part11: a repeat call must return the SAME canonical event row');

  -- CONFLICT SAFETY: same (provider, provider_event_id), DIFFERENT
  -- event_type -- must fail, not silently return the previous row.
  set local role service_role;
  begin
    perform * from public.record_payment_event('paypal', 'evt_p049_123', 'CHECKOUT.ORDER.VOIDED', 'PAYID-P049-EVT');
    perform pg_temp.assert(false, 'part11: a retry with a different event_type for the same (provider, provider_event_id) must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%different event_type%', format('part11: unexpected error: %s', sqlerrm));
  end;
  reset role;
  perform pg_temp.assert(
    (select event_type from public.payment_events where id = v_event_id) = 'CHECKOUT.ORDER.COMPLETED',
    'part11: the original event_type must remain unchanged after the rejected conflicting retry'
  );

  -- CONFLICT SAFETY: same (provider, provider_event_id), DIFFERENT
  -- provider_payment_id -- must also fail.
  set local role service_role;
  begin
    perform * from public.record_payment_event('paypal', 'evt_p049_123', 'CHECKOUT.ORDER.COMPLETED', 'PAYID-DIFFERENT');
    perform pg_temp.assert(false, 'part11: a retry with a different provider_payment_id for the same (provider, provider_event_id) must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%different provider_payment_id%', format('part11: unexpected error: %s', sqlerrm));
  end;
  reset role;

  -- Backfill: an existing NULL provider_payment_id may be filled in by
  -- a later call; never the reverse.
  set local role service_role;
  select * into v_event from public.record_payment_event('stripe', 'evt_p049_backfill', 'checkout.session.completed');
  reset role;
  perform pg_temp.assert(v_event.provider_payment_id is null, 'part11: an event recorded without a provider_payment_id stays null on creation');

  set local role service_role;
  select * into v_event from public.record_payment_event('stripe', 'evt_p049_backfill', 'checkout.session.completed', 'pi_p049_backfilled');
  reset role;
  perform pg_temp.assert(v_event.already_existed, 'part11: the backfill call is still recognized as the same event');
  perform pg_temp.assert(v_event.provider_payment_id = 'pi_p049_backfilled', 'part11: a null provider_payment_id may be backfilled by a later call');

  -- Same event id STRING under a DIFFERENT provider is a genuinely
  -- distinct row.
  set local role service_role;
  select * into v_event from public.record_payment_event('paysera', 'evt_p049_123', 'payment.completed', 'PAYID-PAYSERA-EVT');
  reset role;
  perform pg_temp.assert(not v_event.already_existed, 'part11: the same event id string under a different provider must be a new, distinct event');
  perform pg_temp.assert(
    (select count(*) from public.payment_events where provider_event_id = 'evt_p049_123') = 2,
    'part11: two distinct providers reusing the same provider_event_id string must yield two rows'
  );

  -- Processing state transitions (unchanged from LEDGER-1C, now called
  -- as the ambient owner connection since these two functions are
  -- internal-only after migration 056 -- STRIPE-CUTOVER-1B.6 Section 25).
  perform public.mark_payment_event_processed(v_event_id);
  perform pg_temp.assert(
    (select status from public.payment_events where id = v_event_id) = 'processed',
    'part11: mark_payment_event_processed must set status to processed'
  );

  perform public.mark_payment_event_failed(v_event_id, 'some_late_error');
  perform pg_temp.assert(
    (select status from public.payment_events where id = v_event_id) = 'processed',
    'part11: a processed event must NEVER regress to failed'
  );

  set local role service_role;
  select * into v_event from public.record_payment_event('paypal', 'evt_p049_456', 'CHECKOUT.ORDER.COMPLETED');
  reset role;
  perform public.mark_payment_event_failed(v_event.id, 'processing_error');
  perform pg_temp.assert(
    (select status from public.payment_events where id = v_event.id) = 'failed',
    'part11: a received event must transition to failed'
  );

  begin
    perform public.mark_payment_event_processed(gen_random_uuid());
    perform pg_temp.assert(false, 'part11: marking a non-existent event id as processed must raise');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%not found%', format('part11: unexpected error: %s', sqlerrm));
  end;
end $$;

-- ============================================================
-- Part 12: RLS / EXECUTE -- anon, ordinary reader, author, and staff
-- with finance.view must ALL be denied at the privilege layer for
-- every accounting RPC still reachable at all from an application
-- role. record_successful_sale/mark_payment_event_processed/
-- mark_payment_event_failed are no longer reachable by ANY application
-- role, including service_role -- see
-- 056_ledger_v1_transactional_payment_foundation.test.sql for that
-- specific proof. record_refund and record_payment_event remain
-- service_role-only, unchanged from migration 049.
-- ============================================================
do $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
  begin
    perform * from public.record_refund('stripe', 'pay_deny_anon', 'e0490000-0000-0000-0000-000000000001', 'x');
    perform pg_temp.assert(false, 'part12: anon must not be able to call record_refund');
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.record_payment_event('stripe', 'evt_deny_anon', 'x');
    perform pg_temp.assert(false, 'part12: anon must not be able to call record_payment_event');
  exception when insufficient_privilege then null;
  end;
  reset role;

  perform set_config('request.jwt.claim.sub', 'c0490000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  begin
    perform * from public.record_refund('stripe', 'pay_deny_author', 'e0490000-0000-0000-0000-000000000001', 'x');
    perform pg_temp.assert(false, 'part12: an author must not be able to call record_refund');
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- staff WITH finance.view -- finance.view is a READ permission only,
  -- never equivalent to permission to mint or refund money.
  perform set_config('request.jwt.claim.sub', 'c0490000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  begin
    perform * from public.record_refund('stripe', 'pay_deny_staff', 'e0490000-0000-0000-0000-000000000001', 'x');
    perform pg_temp.assert(false, 'part12: staff with finance.view must NOT be able to call record_refund');
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.record_payment_event('stripe', 'evt_deny_staff', 'x');
    perform pg_temp.assert(false, 'part12: staff with finance.view must NOT be able to call record_payment_event');
  exception when insufficient_privilege then null;
  end;
  reset role;
end $$;

-- ============================================================
-- Part 13: PAYMENT_REFUNDS RLS -- private payment infrastructure: anon
-- none, ordinary reader/author no raw access, staff finance.view reads.
-- ============================================================
do $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
  begin
    perform count(*) from public.payment_refunds;
    perform pg_temp.assert(false, 'part13: anon must not have any privilege to read payment_refunds');
  exception when insufficient_privilege then null;
  end;
  reset role;

  perform set_config('request.jwt.claim.sub', 'c0490000-0000-0000-0000-000000000004', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.payment_refunds) = 0,
    'part13: an ordinary authenticated reader must see zero payment_refunds rows'
  );
  reset role;

  perform set_config('request.jwt.claim.sub', 'c0490000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.payment_refunds) = 0,
    'part13: an author must see zero payment_refunds rows -- no provider refund identifiers are author-visible'
  );
  reset role;

  perform set_config('request.jwt.claim.sub', 'c0490000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) > 0 from public.payment_refunds),
    'part13: staff with finance.view must be able to read payment_refunds'
  );
  reset role;
end $$;

-- ============================================================
-- Part 14: PAYMENT/PURCHASE FK BEHAVIOR.
-- ============================================================
do $$
declare
  v_bogus_payment_id uuid := gen_random_uuid();
  v_real_payment_id uuid;
begin
  begin
    update public.purchases set payment_id = v_bogus_payment_id where id = 'e0490000-0000-0000-0000-000000000010';
    perform pg_temp.assert(false, 'part14: a purchase must not be able to reference a non-existent payment id');
  exception when foreign_key_violation then null;
  end;

  select payment_id into v_real_payment_id from public.purchases where id = 'e0490000-0000-0000-0000-000000000001';
  perform pg_temp.assert(v_real_payment_id is not null, 'part14: sanity -- this purchase must already be linked to a payment');
  begin
    delete from public.payments where id = v_real_payment_id;
    perform pg_temp.assert(false, 'part14: deleting a payment still referenced by a purchase must be blocked');
  exception when foreign_key_violation then null;
  end;

  perform pg_temp.assert(
    (select payment_id from public.purchases where id = 'e0490000-0000-0000-0000-000000000099') is null,
    'part14: a purchase never passed to record_successful_sale must keep a NULL payment_id, with no error'
  );

  perform pg_temp.assert(
    (select count(*) from public.purchases where payment_id = (select id from public.payments where provider = 'stripe' and provider_payment_id = 'pay_p049_bundle')) = 3,
    'part14: three purchases must share exactly one payment_id from the bundle sale'
  );

  -- An ordinary authenticated caller (reader, author, or staff alike --
  -- all connect as the same 'authenticated' database role) has no
  -- INSERT/UPDATE/DELETE grant on payment_refunds at all -- the same
  -- doubly-enforced append-only-style posture as every other table in
  -- this migration.
  perform set_config('request.jwt.claim.sub', 'c0490000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  begin
    delete from public.payment_refunds where purchase_id = 'e0490000-0000-0000-0000-000000000001';
    perform pg_temp.assert(false, 'part14: an ordinary authenticated caller must not be able to DELETE from payment_refunds');
  exception when insufficient_privilege then null;
  end;
  reset role;
end $$;

select 'ALL PASSED: 049_financial_accounting_primitives.test.sql' as result;

rollback;
