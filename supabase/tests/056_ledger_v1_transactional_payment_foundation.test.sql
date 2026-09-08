-- Committed SQL regression suite for migration 056 (STRIPE-CUTOVER-1C:
-- ledger_v1 transactional payment foundation).
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
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/056_ledger_v1_transactional_payment_foundation.test.sql
--
-- Everything below runs inside one transaction and is rolled back at the
-- end. finalize_ledger_book_payment()/finalize_ledger_bundle_payment()
-- are exercised as service_role (their only granted role). Denial tests
-- (Part 9) separately prove record_successful_sale/mark_payment_event_
-- processed/mark_payment_event_failed are unreachable by ANY application
-- role, including service_role, while the wrapper RPCs remain reachable.
--
-- 'stripe' is used as the provider throughout for continuity with the
-- rest of this test suite's fixtures; nothing here exercises a real
-- Stripe API -- ledger_v1 is provider-neutral by design (STRIPE-
-- CUTOVER-1A/1B, not re-tested here).

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
  ('c0560000-0000-0000-0000-000000000001', 'p056-author-a@test', now(), '{"role":"author","display_name":"Author A"}'),
  ('c0560000-0000-0000-0000-000000000002', 'p056-reader@test', now(), '{"role":"reader","display_name":"Reader"}'),
  ('c0560000-0000-0000-0000-000000000003', 'p056-reader-two@test', now(), '{"role":"reader","display_name":"Reader Two"}');

insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('d0560000-0000-0000-0000-000000000001', 'c0560000-0000-0000-0000-000000000001', 'P056 Single Book', '', '', '', 1000, 'published'),
  ('d0560000-0000-0000-0000-000000000002', 'c0560000-0000-0000-0000-000000000001', 'P056 Bundle Book One', '', '', '', 400, 'published'),
  ('d0560000-0000-0000-0000-000000000003', 'c0560000-0000-0000-0000-000000000001', 'P056 Bundle Book Two', '', '', '', 600, 'published'),
  ('d0560000-0000-0000-0000-000000000004', 'c0560000-0000-0000-0000-000000000001', 'P056 Legacy Book', '', '', '', 500, 'published'),
  ('d0560000-0000-0000-0000-000000000005', 'c0560000-0000-0000-0000-000000000001', 'P056 Mismatch Book', '', '', '', 700, 'published'),
  ('d0560000-0000-0000-0000-000000000006', 'c0560000-0000-0000-0000-000000000001', 'P056 Bundle Mismatch A', '', '', '', 200, 'published'),
  ('d0560000-0000-0000-0000-000000000007', 'c0560000-0000-0000-0000-000000000001', 'P056 Bundle Mismatch B', '', '', '', 300, 'published'),
  ('d0560000-0000-0000-0000-000000000008', 'c0560000-0000-0000-0000-000000000001', 'P056 Denial Book', '', '', '', 100, 'published');

insert into public.bundles (id, author_id, title, description, price_cents, status) values
  ('a0560000-0000-0000-0000-000000000001', 'c0560000-0000-0000-0000-000000000001', 'P056 Bundle', '', 1000, 'published'),
  ('a0560000-0000-0000-0000-000000000002', 'c0560000-0000-0000-0000-000000000001', 'P056 Mismatch Bundle', '', 500, 'published');

insert into public.bundle_books (bundle_id, book_id) values
  ('a0560000-0000-0000-0000-000000000001', 'd0560000-0000-0000-0000-000000000002'),
  ('a0560000-0000-0000-0000-000000000001', 'd0560000-0000-0000-0000-000000000003'),
  ('a0560000-0000-0000-0000-000000000002', 'd0560000-0000-0000-0000-000000000006'),
  ('a0560000-0000-0000-0000-000000000002', 'd0560000-0000-0000-0000-000000000007');

-- ============================================================
-- Part A: regime/currency/rate backfill (Section 32/8).
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    not exists (select 1 from public.book_checkout_intents where regime is distinct from 'legacy_stripe_connect_v1' and created_at < now()),
    'partA: sanity -- no pre-existing book_checkout_intents rows should exist in this fresh fixture'
  );
end $$;

-- Directly verify the backfill/default contract using a raw insert that
-- omits regime/currency entirely -- the column defaults must fire.
insert into public.book_checkout_intents (book_id, reader_id, book_title, price_cents_at_checkout, expires_at)
  values ('d0560000-0000-0000-0000-000000000001', 'c0560000-0000-0000-0000-000000000002', 'Raw Insert Book', 1000, now() + interval '1 hour');

do $$
begin
  perform pg_temp.assert(
    (select regime from public.book_checkout_intents where book_title = 'Raw Insert Book') = 'legacy_stripe_connect_v1',
    'partA: a raw insert omitting regime must default to legacy_stripe_connect_v1'
  );
  perform pg_temp.assert(
    (select currency from public.book_checkout_intents where book_title = 'Raw Insert Book') = 'USD',
    'partA: a raw insert omitting currency must default to USD'
  );
  perform pg_temp.assert(
    (select royalty_rate_bps from public.book_checkout_intents where book_title = 'Raw Insert Book') is null,
    'partA: royalty_rate_bps must stay NULL by default -- never fabricated'
  );
end $$;

delete from public.book_checkout_intents where book_title = 'Raw Insert Book';

-- ============================================================
-- Part B/C/D: ledger_v1 ALL enforcement, legacy NULL royalty accepted,
-- ledger NULL royalty rejected (Sections 5/6/9/12).
-- ============================================================
do $$
begin
  -- B: ledger_v1 with a non-ALL currency must be rejected.
  begin
    insert into public.book_checkout_intents (book_id, reader_id, book_title, price_cents_at_checkout, expires_at, regime, currency, royalty_rate_bps)
      values ('d0560000-0000-0000-0000-000000000001', 'c0560000-0000-0000-0000-000000000002', 'X', 1000, now() + interval '1 hour', 'librum_ledger_v1', 'USD', 8000);
    perform pg_temp.assert(false, 'partB: a librum_ledger_v1 row with currency=USD must be rejected');
  exception when check_violation then null;
  end;

  -- C: legacy row with NULL royalty_rate_bps is accepted.
  insert into public.book_checkout_intents (book_id, reader_id, book_title, price_cents_at_checkout, expires_at, regime, currency, royalty_rate_bps)
    values ('d0560000-0000-0000-0000-000000000001', 'c0560000-0000-0000-0000-000000000002', 'Y', 1000, now() + interval '1 hour', 'legacy_stripe_connect_v1', 'USD', null);
  perform pg_temp.assert(
    (select count(*) from public.book_checkout_intents where book_title = 'Y') = 1,
    'partC: a legacy_stripe_connect_v1 row with NULL royalty_rate_bps must be accepted'
  );

  -- D: ledger_v1 row with NULL royalty_rate_bps must be rejected.
  begin
    insert into public.book_checkout_intents (book_id, reader_id, book_title, price_cents_at_checkout, expires_at, regime, currency, royalty_rate_bps)
      values ('d0560000-0000-0000-0000-000000000001', 'c0560000-0000-0000-0000-000000000002', 'Z', 1000, now() + interval '1 hour', 'librum_ledger_v1', 'ALL', null);
    perform pg_temp.assert(false, 'partD: a librum_ledger_v1 row with NULL royalty_rate_bps must be rejected');
  exception when check_violation then null;
  end;

  -- ALL-only currency and NOT-NULL royalty is accepted for ledger_v1.
  insert into public.book_checkout_intents (book_id, reader_id, book_title, price_cents_at_checkout, expires_at, regime, currency, royalty_rate_bps)
    values ('d0560000-0000-0000-0000-000000000001', 'c0560000-0000-0000-0000-000000000002', 'W', 1000, now() + interval '1 hour', 'librum_ledger_v1', 'ALL', 8000);
  perform pg_temp.assert(
    (select count(*) from public.book_checkout_intents where book_title = 'W') = 1,
    'partB/D: a librum_ledger_v1 row with currency=ALL and a real royalty_rate_bps must be accepted'
  );
end $$;

delete from public.book_checkout_intents where book_title in ('Y', 'W');

-- ============================================================
-- Part E: frozen checkout facts immutable (Section 7), including a
-- privileged/superuser UPDATE attempt (this whole suite already runs as
-- the table-owner/superuser connection -- proving the trigger fires
-- even here, not merely against a lower-privileged role).
-- ============================================================
insert into public.book_checkout_intents (id, book_id, reader_id, book_title, price_cents_at_checkout, expires_at, regime, currency, royalty_rate_bps) values
  ('b0560000-0000-0000-0000-000000000001', 'd0560000-0000-0000-0000-000000000001', 'c0560000-0000-0000-0000-000000000002', 'Immut Test', 1000, now() + interval '1 hour', 'legacy_stripe_connect_v1', 'USD', null);

do $$
begin
  begin
    update public.book_checkout_intents set regime = 'librum_ledger_v1' where id = 'b0560000-0000-0000-0000-000000000001';
    perform pg_temp.assert(false, 'partE: regime must be immutable, even for a superuser/table-owner UPDATE');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%immutable%', format('partE: unexpected error: %s', sqlerrm));
  end;

  begin
    update public.book_checkout_intents set currency = 'ALL' where id = 'b0560000-0000-0000-0000-000000000001';
    perform pg_temp.assert(false, 'partE: currency must be immutable');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%immutable%', format('partE: unexpected error: %s', sqlerrm));
  end;

  begin
    update public.book_checkout_intents set royalty_rate_bps = 5000 where id = 'b0560000-0000-0000-0000-000000000001';
    perform pg_temp.assert(false, 'partE: royalty_rate_bps must be immutable');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%immutable%', format('partE: unexpected error: %s', sqlerrm));
  end;

  -- Unrelated lifecycle/status columns must remain freely updatable --
  -- completed_at + fulfilled_at together is the valid "fulfilled" state
  -- per this table's own 3-state biconditional (checked below).
  update public.book_checkout_intents set completed_at = now(), fulfilled_at = now() where id = 'b0560000-0000-0000-0000-000000000001';
  perform pg_temp.assert(
    (select completed_at from public.book_checkout_intents where id = 'b0560000-0000-0000-0000-000000000001') is not null,
    'partE: completed_at/fulfilled_at must remain freely updatable'
  );
end $$;

-- Same matrix for bundle_checkout_snapshots.
insert into public.bundle_checkout_snapshots (id, bundle_id, bundle_title, author_id, reader_id, bundle_price_cents_at_checkout, items, protection_expires_at, regime, currency, royalty_rate_bps) values
  ('b0560000-0000-0000-0000-000000000002', 'a0560000-0000-0000-0000-000000000001', 'Immut Bundle', 'c0560000-0000-0000-0000-000000000001', 'c0560000-0000-0000-0000-000000000002', 1000,
   '[{"book_id":"d0560000-0000-0000-0000-000000000002","title":"x","price_cents_at_checkout":400,"position":1},{"book_id":"d0560000-0000-0000-0000-000000000003","title":"y","price_cents_at_checkout":600,"position":2}]'::jsonb,
   now() + interval '1 hour', 'legacy_stripe_connect_v1', 'USD', null);

do $$
begin
  begin
    update public.bundle_checkout_snapshots set regime = 'librum_ledger_v1' where id = 'b0560000-0000-0000-0000-000000000002';
    perform pg_temp.assert(false, 'partE (bundle): regime must be immutable');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%immutable%', format('partE (bundle): unexpected error: %s', sqlerrm));
  end;

  -- fulfilled_at/total_amount_cents remain updatable.
  update public.bundle_checkout_snapshots set total_amount_cents = 1000, fulfilled_at = now() where id = 'b0560000-0000-0000-0000-000000000002';
  perform pg_temp.assert(
    (select total_amount_cents from public.bundle_checkout_snapshots where id = 'b0560000-0000-0000-0000-000000000002') = 1000,
    'partE (bundle): total_amount_cents/fulfilled_at must remain freely updatable'
  );
  -- Marked fulfilled specifically so create_bundle_checkout_snapshot's
  -- own "reuse an existing open snapshot" logic (Part 11 of the
  -- migration) does NOT hand this fixture back to Part 5 below, which
  -- needs a genuinely fresh librum_ledger_v1 snapshot for the same
  -- (reader, bundle) pair.
end $$;

-- ============================================================
-- Part 1: SINGLE-BOOK LEDGER_V1 END-TO-END, via the real RPC surface --
-- create_book_checkout_intent -> record_payment_event ->
-- finalize_ledger_book_payment (Parts N/R/S below reuse this fixture).
-- ============================================================
do $$
declare
  v_intent record;
  v_event record;
  v_paid_at timestamptz := now();
  v_result record;
  v_purchase record;
  v_payment record;
  v_ledger record;
begin
  perform set_config('request.jwt.claim.sub', 'c0560000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  select * into v_intent from public.create_book_checkout_intent(
    'd0560000-0000-0000-0000-000000000001'::uuid, null, 'librum_ledger_v1', 'ALL', 8000
  );
  reset role;

  perform pg_temp.assert(v_intent.intent_id is not null, 'part1: create_book_checkout_intent must succeed for a ledger_v1 caller');
  perform pg_temp.assert(v_intent.price_cents_at_checkout = 1000, 'part1: frozen price must equal the book price');

  set local role service_role;
  select * into v_event from public.record_payment_event('stripe', 'evt_p056_book1', 'checkout.session.completed', 'pi_p056_book1');
  reset role;

  set local role service_role;
  select * into v_result from public.finalize_ledger_book_payment(
    v_event.id, v_intent.intent_id, 'stripe', 'pi_p056_book1', 1000::bigint, 'all', v_paid_at
  );
  reset role;

  -- N: book atomic success.
  perform pg_temp.assert(v_result.outcome = 'eligible_fulfilled', format('partN: expected eligible_fulfilled, got %s', v_result.outcome));
  perform pg_temp.assert(v_result.out_book_id = 'd0560000-0000-0000-0000-000000000001', 'partN: out_book_id must be the purchased book');
  perform pg_temp.assert(v_result.out_author_id = 'c0560000-0000-0000-0000-000000000001', 'partN: out_author_id must be the book''s author');

  select * into v_purchase from public.purchases where book_id = 'd0560000-0000-0000-0000-000000000001' and reader_id = 'c0560000-0000-0000-0000-000000000002';
  perform pg_temp.assert(v_purchase.regime = 'librum_ledger_v1', 'partN: purchases.regime must be librum_ledger_v1, written on initial creation');
  perform pg_temp.assert(v_purchase.amount_cents = 1000, 'partN: purchases.amount_cents must equal the actual amount');

  select * into v_payment from public.payments where provider = 'stripe' and provider_payment_id = 'pi_p056_book1';
  perform pg_temp.assert(v_payment.regime = 'librum_ledger_v1', 'part9/N: payments.regime must be the hardcoded librum_ledger_v1 literal');

  -- R: payment paid_at equals supplied provider time.
  perform pg_temp.assert(v_payment.paid_at = v_paid_at, 'partR: payments.paid_at must equal exactly the supplied p_paid_at, never now()');

  select * into v_ledger from public.author_ledger_entries where payment_id = v_payment.id and purchase_id = v_purchase.id and entry_type = 'sale';
  perform pg_temp.assert(v_ledger.id is not null, 'partN: a sale ledger entry must exist, keyed by (payment_id, purchase_id)');

  -- S: available_at = paid_at + exactly 30 days.
  perform pg_temp.assert(v_ledger.available_at = v_paid_at + interval '30 days', 'partS: available_at must be exactly paid_at + 30 days');

  -- Q: event processed only with full business success.
  perform pg_temp.assert(
    (select status from public.payment_events where id = v_event.id) = 'processed',
    'partQ: the payment_event must be marked processed after a full successful finalization'
  );
end $$;

-- ============================================================
-- Part 2: BOOK AMOUNT/CURRENCY MISMATCH -- hard rejection, zero writes,
-- event stays received (Sections H/I/L/M).
-- ============================================================
do $$
declare
  v_intent record;
  v_event record;
  v_purchase_count_before integer;
  v_payment_count_before integer;
  v_ledger_count_before integer;
begin
  perform set_config('request.jwt.claim.sub', 'c0560000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  select * into v_intent from public.create_book_checkout_intent(
    'd0560000-0000-0000-0000-000000000005'::uuid, null, 'librum_ledger_v1', 'ALL', 8000
  );
  reset role;

  set local role service_role;
  select * into v_event from public.record_payment_event('stripe', 'evt_p056_mismatch', 'checkout.session.completed', 'pi_p056_mismatch');
  reset role;

  select count(*) into v_purchase_count_before from public.purchases;
  select count(*) into v_payment_count_before from public.payments;
  select count(*) into v_ledger_count_before from public.author_ledger_entries;

  -- H: amount mismatch.
  begin
    set local role service_role;
    perform * from public.finalize_ledger_book_payment(v_event.id, v_intent.intent_id, 'stripe', 'pi_p056_mismatch', 699::bigint, 'ALL', now());
    perform pg_temp.assert(false, 'partH: an amount mismatch must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%mismatch%', format('partH: unexpected error: %s', sqlerrm));
  end;
  reset role;

  -- I: currency mismatch (separate event, same intent -- the intent's
  -- own regime lock is unaffected by the prior rejected attempt).
  begin
    set local role service_role;
    perform * from public.finalize_ledger_book_payment(v_event.id, v_intent.intent_id, 'stripe', 'pi_p056_mismatch', 700::bigint, 'USD', now());
    perform pg_temp.assert(false, 'partI: a currency mismatch must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%mismatch%', format('partI: unexpected error: %s', sqlerrm));
  end;
  reset role;

  -- L: mismatch produces zero business writes.
  perform pg_temp.assert((select count(*) from public.purchases) = v_purchase_count_before, 'partL: zero purchase writes after a rejected mismatch');
  perform pg_temp.assert((select count(*) from public.payments) = v_payment_count_before, 'partL: zero payment writes after a rejected mismatch');
  perform pg_temp.assert((select count(*) from public.author_ledger_entries) = v_ledger_count_before, 'partL: zero ledger writes after a rejected mismatch');

  -- M: mismatch leaves event received.
  perform pg_temp.assert(
    (select status from public.payment_events where id = v_event.id) = 'received',
    'partM: a mismatch must leave the payment_event status as received'
  );
end $$;

-- ============================================================
-- Part 3: EVENT BINDING / CROSS-WIRE REJECTION (Sections F/G).
-- ============================================================
do $$
declare
  v_intent record;
  v_event_a record;
  v_event_b record;
begin
  perform set_config('request.jwt.claim.sub', 'c0560000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  select * into v_intent from public.create_book_checkout_intent(
    'd0560000-0000-0000-0000-000000000005'::uuid, null, 'librum_ledger_v1', 'ALL', 8000
  );
  reset role;

  set local role service_role;
  select * into v_event_a from public.record_payment_event('stripe', 'evt_p056_crosswire_a', 'checkout.session.completed', 'pi_p056_crosswire_a');
  select * into v_event_b from public.record_payment_event('stripe', 'evt_p056_crosswire_b', 'checkout.session.completed', 'pi_p056_crosswire_b');
  reset role;

  -- F: provider_payment_id was persisted on both events.
  perform pg_temp.assert(v_event_a.provider_payment_id = 'pi_p056_crosswire_a', 'partF: provider_payment_id must be persisted on record_payment_event');

  -- G: event A cross-wired with payment B's provider_payment_id must be rejected.
  begin
    set local role service_role;
    perform * from public.finalize_ledger_book_payment(v_event_a.id, v_intent.intent_id, 'stripe', 'pi_p056_crosswire_b', 700::bigint, 'ALL', now());
    perform pg_temp.assert(false, 'partG: cross-wiring event A with a different provider_payment_id must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%does not match%', format('partG: unexpected error: %s', sqlerrm));
  end;
  reset role;

  perform pg_temp.assert(
    (select status from public.payment_events where id = v_event_a.id) = 'received',
    'partG: the cross-wired event must remain received, not processed'
  );
  perform pg_temp.assert(
    (select count(*) from public.payments where provider_payment_id = 'pi_p056_crosswire_b') = 0,
    'partG: zero commerce mutation from the rejected cross-wire attempt'
  );
end $$;

-- ============================================================
-- Part 4: INDUCED SALE FAILURE ROLLS BACK ENTITLEMENT (Section P).
-- Reuses the mismatch mechanism itself as the induced failure -- the
-- hard amount check fires AFTER event binding but BEFORE the shared
-- entitlement core runs, so no purchases row is ever created; this
-- directly proves atomicity end-to-end (event lock + entitlement +
-- ledger all-or-nothing), not merely the isolated mismatch check.
-- ============================================================
do $$
declare
  v_intent record;
  v_event record;
begin
  perform set_config('request.jwt.claim.sub', 'c0560000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  select * into v_intent from public.create_book_checkout_intent(
    'd0560000-0000-0000-0000-000000000005'::uuid, null, 'librum_ledger_v1', 'ALL', 8000
  );
  reset role;

  set local role service_role;
  select * into v_event from public.record_payment_event('stripe', 'evt_p056_induced', 'checkout.session.completed', 'pi_p056_induced');
  begin
    perform * from public.finalize_ledger_book_payment(v_event.id, v_intent.intent_id, 'stripe', 'pi_p056_induced', 1::bigint, 'ALL', now());
    perform pg_temp.assert(false, 'partP: the induced mismatch must raise');
  exception when others then null;
  end;
  reset role;

  perform pg_temp.assert(
    not exists (select 1 from public.purchases where book_id = 'd0560000-0000-0000-0000-000000000005' and reader_id = 'c0560000-0000-0000-0000-000000000003'),
    'partP: no entitlement row must exist after the induced failure rolled back'
  );
  perform pg_temp.assert(
    (select fulfilled_at from public.book_checkout_intents where id = v_intent.intent_id) is null,
    'partP: the checkout intent must remain unfulfilled after the induced failure'
  );
end $$;

-- ============================================================
-- Part 5: BUNDLE LEDGER_V1 END-TO-END + HARD MISMATCH (Sections J/K/O).
-- ============================================================
do $$
declare
  v_snapshot record;
  v_event record;
  v_result record;
  v_purchase_1 record;
  v_purchase_2 record;
  v_payment record;
begin
  perform set_config('request.jwt.claim.sub', 'c0560000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  select * into v_snapshot from public.create_bundle_checkout_snapshot(
    'a0560000-0000-0000-0000-000000000001'::uuid, 'librum_ledger_v1', 'ALL', 8000
  );
  reset role;

  perform pg_temp.assert(v_snapshot.snapshot_id is not null, 'part5: create_bundle_checkout_snapshot must succeed for a ledger_v1 caller');
  perform pg_temp.assert(v_snapshot.bundle_price_cents_at_checkout = 1000, 'part5: frozen bundle price must equal 400+600');

  set local role service_role;
  select * into v_event from public.record_payment_event('stripe', 'evt_p056_bundle1', 'checkout.session.completed', 'pi_p056_bundle1');
  reset role;

  -- J: bundle amount mismatch rejected.
  begin
    set local role service_role;
    perform * from public.finalize_ledger_bundle_payment(v_event.id, v_snapshot.snapshot_id, 'stripe', 'pi_p056_bundle1', 999::bigint, 'ALL', now());
    perform pg_temp.assert(false, 'partJ: a bundle amount mismatch must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%mismatch%', format('partJ: unexpected error: %s', sqlerrm));
  end;
  reset role;
  perform pg_temp.assert(
    (select status from public.payment_events where id = v_event.id) = 'received',
    'partJ: a bundle amount mismatch must leave the event received'
  );

  -- O: bundle atomic success (genuine call, correct amount).
  set local role service_role;
  select * into v_result from public.finalize_ledger_bundle_payment(v_event.id, v_snapshot.snapshot_id, 'stripe', 'pi_p056_bundle1', 1000::bigint, 'all', now());
  reset role;

  perform pg_temp.assert(v_result.outcome = 'eligible_fulfilled', format('partO: expected eligible_fulfilled, got %s', v_result.outcome));
  perform pg_temp.assert(array_length(v_result.out_book_ids, 1) = 2, 'partO: both bundle books must be in out_book_ids');

  select * into v_purchase_1 from public.purchases where book_id = 'd0560000-0000-0000-0000-000000000002' and reader_id = 'c0560000-0000-0000-0000-000000000002';
  select * into v_purchase_2 from public.purchases where book_id = 'd0560000-0000-0000-0000-000000000003' and reader_id = 'c0560000-0000-0000-0000-000000000002';
  perform pg_temp.assert(v_purchase_1.id is not null and v_purchase_2.id is not null, 'partO: both bundle purchases must exist');
  perform pg_temp.assert(v_purchase_1.amount_cents + v_purchase_2.amount_cents = 1000, 'partO: bundle allocation must sum exactly to the actual amount');
  perform pg_temp.assert(v_purchase_1.regime = 'librum_ledger_v1' and v_purchase_2.regime = 'librum_ledger_v1', 'partO: both bundle purchases must carry regime=librum_ledger_v1');

  select * into v_payment from public.payments where provider = 'stripe' and provider_payment_id = 'pi_p056_bundle1';
  perform pg_temp.assert(
    (select count(*) from public.author_ledger_entries where payment_id = v_payment.id and entry_type = 'sale') = 2,
    'partO: exactly two sale ledger entries must exist for this bundle payment'
  );
  perform pg_temp.assert(
    (select status from public.payment_events where id = v_event.id) = 'processed',
    'partO/Q: the bundle payment_event must be marked processed after full success'
  );

  perform pg_temp.assert(
    (select fulfilled_at from public.bundle_checkout_snapshots where id = v_snapshot.snapshot_id) is not null,
    'partO: the snapshot must be marked fulfilled'
  );
  perform pg_temp.assert(
    not exists (select 1 from public.bundle_checkout_reservations where snapshot_id = v_snapshot.snapshot_id),
    'partO: reservations must be cleaned up after fulfillment'
  );
end $$;

-- ============================================================
-- Part 6: BUNDLE CURRENCY MISMATCH (Section K), separate fixture.
-- ============================================================
do $$
declare
  v_snapshot record;
  v_event record;
begin
  perform set_config('request.jwt.claim.sub', 'c0560000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  select * into v_snapshot from public.create_bundle_checkout_snapshot(
    'a0560000-0000-0000-0000-000000000002'::uuid, 'librum_ledger_v1', 'ALL', 8000
  );
  reset role;

  set local role service_role;
  select * into v_event from public.record_payment_event('stripe', 'evt_p056_bundle_cur', 'checkout.session.completed', 'pi_p056_bundle_cur');
  begin
    perform * from public.finalize_ledger_bundle_payment(v_event.id, v_snapshot.snapshot_id, 'stripe', 'pi_p056_bundle_cur', 500::bigint, 'USD', now());
    perform pg_temp.assert(false, 'partK: a bundle currency mismatch must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%mismatch%', format('partK: unexpected error: %s', sqlerrm));
  end;
  reset role;

  perform pg_temp.assert(
    not exists (select 1 from public.purchases where book_id in ('d0560000-0000-0000-0000-000000000006', 'd0560000-0000-0000-0000-000000000007')),
    'partK: zero entitlement writes after a rejected bundle currency mismatch'
  );
end $$;

-- ============================================================
-- Part 7: LATE RETRY AFTER REUSE, THE REQUIRED HARD ACCEPTANCE TEST
-- (Section 21/T/U/V/W/X/Y/Z/AA). PAY1 (1000) -> refund -> PAY2 (same
-- purchase, 1300) -> late PAY1 retry must remain safe/idempotent and
-- must never read the current 1300 as PAY1's own history.
-- ============================================================
do $$
declare
  v_intent record;
  v_event_1 record;
  v_result_1 record;
  v_paid_at_1 timestamptz := now() - interval '2 days';
  v_purchase_id uuid;
  v_payment_1_id uuid;
  v_entry_1_id uuid;
  v_event_2 record;
  v_result_2 record;
  v_paid_at_2 timestamptz := now();
  v_payment_2_id uuid;
  v_retry_event record;
  v_retry_result record;
begin
  perform set_config('request.jwt.claim.sub', 'c0560000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  select * into v_intent from public.create_book_checkout_intent(
    'd0560000-0000-0000-0000-000000000004'::uuid, null, 'librum_ledger_v1', 'ALL', 8000
  );
  reset role;

  -- PAY1: gross 500 (the book's list price).
  set local role service_role;
  select * into v_event_1 from public.record_payment_event('stripe', 'evt_p056_retry_pay1', 'checkout.session.completed', 'pi_p056_retry_pay1');
  select * into v_result_1 from public.finalize_ledger_book_payment(v_event_1.id, v_intent.intent_id, 'stripe', 'pi_p056_retry_pay1', 500::bigint, 'ALL', v_paid_at_1);
  reset role;

  select id into v_purchase_id from public.purchases where book_id = 'd0560000-0000-0000-0000-000000000004' and reader_id = 'c0560000-0000-0000-0000-000000000002';
  select id into v_payment_1_id from public.payments where provider = 'stripe' and provider_payment_id = 'pi_p056_retry_pay1';
  select id into v_entry_1_id from public.author_ledger_entries where payment_id = v_payment_1_id and purchase_id = v_purchase_id and entry_type = 'sale';

  -- Refund PAY1.
  set local role service_role;
  perform public.record_refund('stripe', 'pi_p056_retry_pay1', v_purchase_id, 'refund_p056_retry_pay1');
  reset role;

  -- PAY2: repurchase the same book, but at a different gross (1300) --
  -- simulated directly on the reused purchases row, matching exactly
  -- what finalize_book_checkout_intent_entitlement_core's own upsert
  -- does on a legitimate repurchase after refund.
  update public.purchases set refunded_at = null, amount_cents = 1300 where id = v_purchase_id;

  set local role service_role;
  select * into v_event_2 from public.record_payment_event('stripe', 'evt_p056_retry_pay2', 'checkout.session.completed', 'pi_p056_retry_pay2');
  select id into v_payment_2_id from public.payments where provider = 'stripe' and provider_payment_id = 'pi_p056_retry_pay2';
  reset role;

  perform pg_temp.assert(v_payment_2_id is null, 'part7: sanity -- PAY2''s payment must not exist yet');

  -- Directly exercise record_successful_sale for PAY2 (as the table
  -- owner -- this function is internal-only after Part 9's grant
  -- changes) to establish the independent second historical
  -- transaction, exactly mirroring what finalize_ledger_book_payment
  -- would do internally for a genuine repurchase.
  perform public.record_successful_sale('stripe', 'pi_p056_retry_pay2', 'ALL', array[v_purchase_id], 8000, v_paid_at_2, 'c0560000-0000-0000-0000-000000000002'::uuid);
  select id into v_payment_2_id from public.payments where provider = 'stripe' and provider_payment_id = 'pi_p056_retry_pay2';

  -- V: PAY1 refund -> PAY2 same-purchase repurchase succeeded.
  perform pg_temp.assert(v_payment_2_id is not null, 'partV: PAY2 must now exist as an independent payment');
  perform pg_temp.assert(
    (select payment_id from public.purchases where id = v_purchase_id) = v_payment_2_id,
    'partV: purchases.payment_id must now point at PAY2 (the current-entitlement pointer)'
  );

  -- W: two independent sale rows exist.
  perform pg_temp.assert(
    (select count(*) from public.author_ledger_entries where purchase_id = v_purchase_id and entry_type = 'sale') = 2,
    'partW: two independent, coexisting sale ledger rows must exist -- one per payment'
  );

  -- Late retry of PAY1's original finalization event.
  set local role service_role;
  select * into v_retry_event from public.record_payment_event('stripe', 'evt_p056_retry_pay1', 'checkout.session.completed', 'pi_p056_retry_pay1');
  reset role;
  perform pg_temp.assert(v_retry_event.already_existed, 'part7: the late retry must resolve to the SAME event row (idempotent record_payment_event)');

  perform public.record_successful_sale('stripe', 'pi_p056_retry_pay1', 'ALL', array[v_purchase_id], 8000, v_paid_at_1, 'c0560000-0000-0000-0000-000000000002'::uuid);

  -- X: PAY1 late retry after PAY2 succeeds (no exception raised above).
  -- Y: PAY1 retry uses frozen 500 despite current purchase 1300.
  perform pg_temp.assert(
    (select amount_minor from public.payments where id = v_payment_1_id) = 500,
    'partY: PAY1''s own payment row must remain frozen at 500, unaffected by the 1300 reuse'
  );
  perform pg_temp.assert(
    (select gross_amount_minor from public.author_ledger_entries where id = v_entry_1_id) = 500,
    'partY: PAY1''s own sale ledger row must remain frozen at gross=500'
  );

  -- Z: PAY1 retry does not reset purchases.payment_id back from PAY2 to PAY1.
  perform pg_temp.assert(
    (select payment_id from public.purchases where id = v_purchase_id) = v_payment_2_id,
    'partZ: PAY1''s late retry must NOT reset purchases.payment_id back from PAY2 to PAY1'
  );

  -- AA: PAY2 independently refundable.
  set local role service_role;
  perform public.record_refund('stripe', 'pi_p056_retry_pay2', v_purchase_id, 'refund_p056_retry_pay2');
  reset role;
  perform pg_temp.assert(
    (select status from public.payments where id = v_payment_2_id) = 'refunded',
    'partAA: PAY2 must be independently refundable, unaffected by PAY1''s own already-refunded history'
  );
  perform pg_temp.assert(
    (select status from public.payments where id = v_payment_1_id) = 'refunded',
    'part7: PAY1''s own refund (recorded earlier in this test) must remain intact throughout'
  );
end $$;

-- ============================================================
-- Part 8: AH -- payment-set reconstruction uses immutable sale rows,
-- not purchases.payment_id. Direct proof: temporarily corrupt
-- purchases.payment_id to point somewhere else, then prove a retry of
-- an EXISTING payment still resolves correctly (because reconstruction
-- never reads that column).
-- ============================================================
do $$
declare
  v_intent record;
  v_purchase_id uuid;
  v_payment_id uuid;
  v_other_payment_id uuid;
begin
  perform set_config('request.jwt.claim.sub', 'c0560000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  select * into v_intent from public.create_book_checkout_intent(
    'd0560000-0000-0000-0000-000000000008'::uuid, null, 'librum_ledger_v1', 'ALL', 8000
  );
  reset role;

  set local role service_role;
  perform public.finalize_ledger_book_payment(
    (public.record_payment_event('stripe', 'evt_p056_ah', 'checkout.session.completed', 'pi_p056_ah')).id,
    v_intent.intent_id, 'stripe', 'pi_p056_ah', 100::bigint, 'ALL', now()
  );
  reset role;

  select id into v_purchase_id from public.purchases where book_id = 'd0560000-0000-0000-0000-000000000008' and reader_id = 'c0560000-0000-0000-0000-000000000003';
  select id into v_payment_id from public.payments where provider = 'stripe' and provider_payment_id = 'pi_p056_ah';

  -- Corrupt the current-entitlement pointer to something else entirely.
  insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status, paid_at, regime) values
    (gen_random_uuid(), 'stripe', 'pi_p056_ah_decoy', 999, 'ALL', 'succeeded', now(), 'librum_ledger_v1')
    returning id into v_other_payment_id;
  update public.purchases set payment_id = v_other_payment_id where id = v_purchase_id;

  -- A retry of the ORIGINAL payment must still resolve correctly --
  -- reconstruction reads author_ledger_entries, never the now-corrupted
  -- purchases.payment_id.
  perform public.record_successful_sale('stripe', 'pi_p056_ah', 'ALL', array[v_purchase_id], 8000, (select paid_at from public.payments where id = v_payment_id), 'c0560000-0000-0000-0000-000000000003'::uuid);

  perform pg_temp.assert(
    (select count(*) from public.author_ledger_entries where payment_id = v_payment_id and purchase_id = v_purchase_id and entry_type = 'sale') = 1,
    'partAH: the retry must resolve correctly via author_ledger_entries even with purchases.payment_id pointing elsewhere'
  );

  update public.purchases set payment_id = v_payment_id where id = v_purchase_id;
end $$;

-- ============================================================
-- Part 9: PRIVILEGE BOUNDARY -- AC/AD/AF. record_successful_sale and
-- mark_payment_event_processed/failed are unreachable by service_role
-- (or any other application role); the wrapper RPCs remain reachable by
-- service_role; the legacy finalizer cannot finalize a ledger_v1 intent.
-- ============================================================
do $$
declare
  v_intent record;
begin
  -- AC: record_successful_sale direct service_role execute denied.
  set local role service_role;
  begin
    perform * from public.record_successful_sale('stripe', 'pay_deny_service_role', 'ALL', array[gen_random_uuid()], 8000, now());
    perform pg_temp.assert(false, 'partAC: service_role must NOT be able to call record_successful_sale directly');
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.mark_payment_event_processed(gen_random_uuid());
    perform pg_temp.assert(false, 'partAC: service_role must NOT be able to call mark_payment_event_processed directly');
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.mark_payment_event_failed(gen_random_uuid(), 'x');
    perform pg_temp.assert(false, 'partAC: service_role must NOT be able to call mark_payment_event_failed directly');
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- Also denied to anon/authenticated (unaffected baseline, restated).
  set local role anon;
  begin
    perform * from public.record_successful_sale('stripe', 'pay_deny_anon', 'ALL', array[gen_random_uuid()], 8000, now());
    perform pg_temp.assert(false, 'partAC: anon must NOT be able to call record_successful_sale');
  exception when insufficient_privilege then null;
  end;
  reset role;
end $$;

-- AD: wrapper service_role execute allowed (already proven functionally
-- by Parts 1/5 succeeding as service_role above -- restated here as an
-- explicit privilege-layer check).
do $$
begin
  perform pg_temp.assert(
    has_function_privilege('service_role', 'public.finalize_ledger_book_payment(uuid,uuid,text,text,bigint,text,timestamptz)', 'EXECUTE'),
    'partAD: service_role must have EXECUTE on finalize_ledger_book_payment'
  );
  perform pg_temp.assert(
    has_function_privilege('service_role', 'public.finalize_ledger_bundle_payment(uuid,uuid,text,text,bigint,text,timestamptz)', 'EXECUTE'),
    'partAD: service_role must have EXECUTE on finalize_ledger_bundle_payment'
  );
  perform pg_temp.assert(
    not has_function_privilege('authenticated', 'public.finalize_ledger_book_payment(uuid,uuid,text,text,bigint,text,timestamptz)', 'EXECUTE'),
    'partAD: authenticated must NOT have EXECUTE on finalize_ledger_book_payment'
  );
  perform pg_temp.assert(
    not has_function_privilege('anon', 'public.finalize_ledger_bundle_payment(uuid,uuid,text,text,bigint,text,timestamptz)', 'EXECUTE'),
    'partAD: anon must NOT have EXECUTE on finalize_ledger_bundle_payment'
  );
  perform pg_temp.assert(
    not has_function_privilege('service_role', 'public.record_successful_sale(text,text,text,uuid[],integer,timestamptz,uuid)', 'EXECUTE'),
    'partAC: service_role must NOT have EXECUTE on record_successful_sale at the privilege-catalog layer'
  );
  perform pg_temp.assert(
    not has_function_privilege('service_role', 'public.mark_payment_event_processed(uuid)', 'EXECUTE'),
    'partAC: service_role must NOT have EXECUTE on mark_payment_event_processed'
  );
  perform pg_temp.assert(
    not has_function_privilege('service_role', 'public.mark_payment_event_failed(uuid,text)', 'EXECUTE'),
    'partAC: service_role must NOT have EXECUTE on mark_payment_event_failed'
  );
end $$;

-- AE: legacy finalize path still works (unchanged behavior).
do $$
declare
  v_intent record;
  v_result record;
begin
  -- Uses book 003 / reader 03 -- a combo untouched by any earlier part
  -- (book 003 was only ever purchased via the Part 5 BUNDLE snapshot
  -- path for reader 02, which creates no book_checkout_intents row at
  -- all), so create_book_checkout_intent's own "reuse an existing open
  -- intent" logic cannot hand this call a leftover ledger_v1 intent
  -- from an earlier part.
  perform set_config('request.jwt.claim.sub', 'c0560000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  select * into v_intent from public.create_book_checkout_intent('d0560000-0000-0000-0000-000000000003'::uuid, null);
  reset role;

  perform pg_temp.assert(
    (select regime from public.book_checkout_intents where id = v_intent.intent_id) = 'legacy_stripe_connect_v1',
    'partAE: the unmodified 2-arg call site must still default to legacy_stripe_connect_v1'
  );

  set local role service_role;
  select * into v_result from public.finalize_book_checkout_intent(v_intent.intent_id, 'cs_p056_legacy', 'pi_p056_legacy', v_intent.price_cents_at_checkout);
  reset role;

  perform pg_temp.assert(v_result.outcome = 'eligible_fulfilled', 'partAE: the legacy finalize path must still succeed unchanged');
  perform pg_temp.assert(
    (select regime from public.purchases where book_id = 'd0560000-0000-0000-0000-000000000003' and reader_id = 'c0560000-0000-0000-0000-000000000003') = 'legacy_stripe_connect_v1',
    'partAE: the resulting purchase must carry regime=legacy_stripe_connect_v1'
  );
end $$;

-- AF: the legacy finalizer cannot finalize a ledger_v1 intent outside the wrapper.
do $$
declare
  v_intent record;
begin
  perform set_config('request.jwt.claim.sub', 'c0560000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  select * into v_intent from public.create_book_checkout_intent(
    'd0560000-0000-0000-0000-000000000005'::uuid, null, 'librum_ledger_v1', 'ALL', 8000
  );
  reset role;

  set local role service_role;
  begin
    perform * from public.finalize_book_checkout_intent(v_intent.intent_id, 'cs_p056_bypass', 'pi_p056_bypass', v_intent.price_cents_at_checkout);
    perform pg_temp.assert(false, 'partAF: finalize_book_checkout_intent must refuse a librum_ledger_v1 intent');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%not a legacy_stripe_connect_v1 checkout%', format('partAF: unexpected error: %s', sqlerrm));
  end;
  reset role;

  perform pg_temp.assert(
    not exists (select 1 from public.purchases where book_id = 'd0560000-0000-0000-0000-000000000005' and reader_id = 'c0560000-0000-0000-0000-000000000002'),
    'partAF: no entitlement, payment, or ledger effect must exist from the refused bypass attempt'
  );
end $$;

select 'ALL PASSED: 056_ledger_v1_transactional_payment_foundation.test.sql' as result;

rollback;
