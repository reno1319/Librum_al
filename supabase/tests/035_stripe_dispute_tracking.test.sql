-- Committed SQL regression suite for migration 035 (LAUNCH-1 P1-7A:
-- Stripe dispute/chargeback tracking -- payment_disputes, the
-- user_owns_book() lost-dispute predicate, and the single-book
-- pre-fulfillment lost-dispute guard in finalize_book_checkout_intent).
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql -- no new test
-- infrastructure needed. Two equivalent ways to run this:
--
-- (a) Fresh schema.sql (already includes migration 035's final state):
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/035_stripe_dispute_tracking.test.sql
--
-- (b) The current through-034 schema with migration 035 applied on top:
--   createdb librum_test_035
--   psql -d librum_test_035 -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test_035 -f <through-034 schema snapshot>
--   psql -d librum_test_035 -v ON_ERROR_STOP=1 -f supabase/migrations/035_stripe_dispute_tracking.sql
--   psql -d librum_test_035 -v ON_ERROR_STOP=1 -f supabase/tests/035_stripe_dispute_tracking.test.sql
--
-- Everything below runs inside one transaction and is rolled back at
-- the end, so this file is fully repeatable with no manual cleanup
-- between runs -- except the ACL assertions, which read committed
-- privilege state.

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
-- Part 1: payment_disputes -- table-level ACL, exactly per the
-- required final privilege model (fully closed to anon/authenticated,
-- service_role untouched).
-- ============================================================
do $$
begin
  perform pg_temp.assert(not has_table_privilege('anon', 'public.payment_disputes', 'SELECT'),
    'part1: anon must not have SELECT on payment_disputes');
  perform pg_temp.assert(not has_table_privilege('anon', 'public.payment_disputes', 'INSERT'),
    'part1: anon must not have INSERT on payment_disputes');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.payment_disputes', 'SELECT'),
    'part1: authenticated must not have SELECT on payment_disputes');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.payment_disputes', 'INSERT'),
    'part1: authenticated must not have INSERT on payment_disputes');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.payment_disputes', 'UPDATE'),
    'part1: authenticated must not have UPDATE on payment_disputes');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.payment_disputes', 'DELETE'),
    'part1: authenticated must not have DELETE on payment_disputes');

  perform pg_temp.assert(has_table_privilege('service_role', 'public.payment_disputes', 'INSERT'),
    'part1: service_role must retain INSERT on payment_disputes');
  perform pg_temp.assert(has_table_privilege('service_role', 'public.payment_disputes', 'UPDATE'),
    'part1: service_role must retain UPDATE on payment_disputes');

  perform pg_temp.assert(
    not exists (
      select 1 from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'payment_disputes' and grantee = 'PUBLIC'
    ),
    'part1: PUBLIC must have zero explicit grants on payment_disputes'
  );

  perform pg_temp.assert(
    (select count(*) from pg_policy where polrelid = 'public.payment_disputes'::regclass) = 0,
    'part1: payment_disputes must have zero RLS policies (fully closed by ACL + RLS default-deny)'
  );

  perform pg_temp.assert(
    (select relrowsecurity from pg_class where oid = 'public.payment_disputes'::regclass),
    'part1: payment_disputes must have RLS enabled'
  );
end $$;

-- ============================================================
-- Part 2: payment_disputes -- stripe_dispute_id uniqueness (the
-- constraint the webhook's ON CONFLICT upsert relies on for atomicity).
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    exists (
      select 1 from pg_constraint
      where conrelid = 'public.payment_disputes'::regclass
        and contype = 'u'
        and conkey = (
          select array_agg(attnum) from pg_attribute
          where attrelid = 'public.payment_disputes'::regclass and attname = 'stripe_dispute_id'
        )
    ),
    'part2: stripe_dispute_id must have a unique constraint'
  );
end $$;

insert into public.payment_disputes (stripe_dispute_id, stripe_payment_intent_id, status, reason, amount_cents)
values ('dp_uniq_test', 'pi_uniq_test', 'needs_response', 'fraudulent', 500);

do $$
begin
  begin
    insert into public.payment_disputes (stripe_dispute_id, stripe_payment_intent_id, status, reason, amount_cents)
    values ('dp_uniq_test', 'pi_uniq_test', 'won', 'fraudulent', 500);
    perform pg_temp.assert(false, 'part2: a second row with the same stripe_dispute_id must be rejected');
  exception when unique_violation then
    null;
  end;
end $$;

-- The webhook's real write path -- ON CONFLICT (stripe_dispute_id) DO
-- UPDATE -- correctly updates the existing row in place rather than
-- erroring, unlike the plain duplicate INSERT above.
insert into public.payment_disputes (stripe_dispute_id, stripe_payment_intent_id, status, reason, amount_cents)
values ('dp_uniq_test', 'pi_uniq_test', 'lost', 'fraudulent', 500)
on conflict (stripe_dispute_id) do update set status = excluded.status;

do $$
begin
  perform pg_temp.assert(
    (select count(*) from public.payment_disputes where stripe_dispute_id = 'dp_uniq_test') = 1,
    'part2: ON CONFLICT upsert must not create a second row'
  );
  perform pg_temp.assert(
    (select status from public.payment_disputes where stripe_dispute_id = 'dp_uniq_test') = 'lost',
    'part2: ON CONFLICT upsert must update the existing row''s status'
  );
end $$;

delete from public.payment_disputes where stripe_dispute_id = 'dp_uniq_test';

-- ============================================================
-- Part 3: book_checkout_intents.reconciliation_reason CHECK constraint
-- -- widened to accept 'disputed_lost', still rejects garbage.
-- ============================================================
do $$
begin
  begin
    insert into public.book_checkout_intents
      (book_id, reader_id, book_title, price_cents_at_checkout, expires_at, completed_at, reconciliation_reason)
    values
      (null, null, 'Constraint probe', 500, now() + interval '1 hour', now(), 'not_a_real_reason');
    perform pg_temp.assert(false, 'part3: an unrecognized reconciliation_reason must still be rejected');
  exception when check_violation then
    null;
  end;
end $$;

-- ============================================================
-- Part 4: functional fixtures -- profiles, a book, and purchases rows
-- covering every case user_owns_book() must distinguish.
-- ============================================================
insert into auth.users (id, email, raw_user_meta_data) values
  ('bbbbbbbb-1111-1111-1111-111111111111', 'p035-author@test', '{"role":"author","display_name":"Author"}'),
  ('bbbbbbbb-2222-2222-2222-222222222222', 'p035-reader@test', '{"role":"reader","display_name":"Reader"}');

insert into public.books (id, author_id, title, price_cents, status) values
  ('cccccccc-1111-1111-1111-111111111111', 'bbbbbbbb-1111-1111-1111-111111111111', 'Lost-Disputed Book', 500, 'published'),
  ('cccccccc-2222-2222-2222-222222222222', 'bbbbbbbb-1111-1111-1111-111111111111', 'Won-Disputed Book', 500, 'published'),
  ('cccccccc-3333-3333-3333-333333333333', 'bbbbbbbb-1111-1111-1111-111111111111', 'Free Book', 0, 'published'),
  ('cccccccc-4444-4444-4444-444444444444', 'bbbbbbbb-1111-1111-1111-111111111111', 'Undisputed Book', 500, 'published'),
  ('cccccccc-5555-5555-5555-555555555555', 'bbbbbbbb-1111-1111-1111-111111111111', 'Unknown-Status-Disputed Book', 500, 'published'),
  ('cccccccc-6666-6666-6666-666666666666', 'bbbbbbbb-1111-1111-1111-111111111111', 'No-Prior-Purchase Book', 900, 'published');

insert into public.purchases (book_id, reader_id, stripe_checkout_session_id, stripe_payment_intent_id, amount_cents) values
  ('cccccccc-1111-1111-1111-111111111111', 'bbbbbbbb-2222-2222-2222-222222222222', 'cs_test_lost', 'pi_test_lost', 500),
  ('cccccccc-2222-2222-2222-222222222222', 'bbbbbbbb-2222-2222-2222-222222222222', 'cs_test_won', 'pi_test_won', 500),
  ('cccccccc-3333-3333-3333-333333333333', 'bbbbbbbb-2222-2222-2222-222222222222', 'free_test_uuid', null, 0),
  ('cccccccc-4444-4444-4444-444444444444', 'bbbbbbbb-2222-2222-2222-222222222222', 'cs_test_none', 'pi_test_nodispute', 500),
  ('cccccccc-5555-5555-5555-555555555555', 'bbbbbbbb-2222-2222-2222-222222222222', 'cs_test_unknown', 'pi_test_unknown_status', 500);

insert into public.payment_disputes (stripe_dispute_id, stripe_payment_intent_id, status, reason, amount_cents) values
  ('dp_test_lost', 'pi_test_lost', 'lost', 'fraudulent', 500),
  ('dp_test_won', 'pi_test_won', 'won', 'fraudulent', 500),
  ('dp_test_unknown', 'pi_test_unknown_status', 'some_future_stripe_status', 'general', 500);

-- ============================================================
-- Part 5: user_owns_book() -- functional, as the reader (RLS-scoped),
-- not catalog introspection.
-- ============================================================
do $$
begin
  perform set_config('request.jwt.claim.sub', 'bbbbbbbb-2222-2222-2222-222222222222', true);
  set local role authenticated;

  perform pg_temp.assert(
    public.user_owns_book('cccccccc-1111-1111-1111-111111111111') = false,
    'part5: a purchase whose payment intent has a lost dispute must NOT count as owned'
  );
  perform pg_temp.assert(
    public.user_owns_book('cccccccc-2222-2222-2222-222222222222') = true,
    'part5: a purchase whose payment intent has a WON dispute must still count as owned'
  );
  perform pg_temp.assert(
    public.user_owns_book('cccccccc-3333-3333-3333-333333333333') = true,
    'part5: a free acquisition (null payment_intent_id) must be unaffected by dispute checks entirely'
  );
  perform pg_temp.assert(
    public.user_owns_book('cccccccc-4444-4444-4444-444444444444') = true,
    'part5: a purchase with no dispute at all must count as owned'
  );
  perform pg_temp.assert(
    public.user_owns_book('cccccccc-5555-5555-5555-555555555555') = true,
    'part5: a purchase disputed with an UNRECOGNIZED/future status must still count as owned -- only the literal ''lost'' revokes'
  );

  reset role;
end $$;

-- ============================================================
-- Part 6: finalize_book_checkout_intent() -- dispute-before-fulfillment
-- guarantee, functional. A dispute already 'lost' for this exact
-- payment intent, recorded BEFORE this call, must block entitlement.
-- ============================================================
insert into public.book_checkout_intents
  (id, book_id, reader_id, book_title, price_cents_at_checkout, expires_at)
values
  ('dddddddd-1111-1111-1111-111111111111', 'cccccccc-1111-1111-1111-111111111111',
   'bbbbbbbb-2222-2222-2222-222222222222', 'Lost-Disputed Book', 700, now() + interval '1 hour');

insert into public.payment_disputes (stripe_dispute_id, stripe_payment_intent_id, status, reason, amount_cents)
values ('dp_test_pre_fulfillment', 'pi_test_pre_fulfillment_lost', 'lost', 'fraudulent', 700);

do $$
declare
  result record;
begin
  select outcome, out_book_id, out_reader_id
  into result
  from public.finalize_book_checkout_intent(
    'dddddddd-1111-1111-1111-111111111111',
    'cs_test_pre_fulfillment',
    'pi_test_pre_fulfillment_lost',
    700
  );

  perform pg_temp.assert(result.outcome = 'blocked_disputed_lost',
    format('part6: expected blocked_disputed_lost, got %s', result.outcome));
  perform pg_temp.assert(result.out_book_id = 'cccccccc-1111-1111-1111-111111111111',
    'part6: blocked_disputed_lost must still report the book_id for ops visibility');

  perform pg_temp.assert(
    not exists (
      select 1 from public.purchases
      where book_id = 'cccccccc-1111-1111-1111-111111111111'
        and reader_id = 'bbbbbbbb-2222-2222-2222-222222222222'
        and stripe_checkout_session_id = 'cs_test_pre_fulfillment'
    ),
    'part6: no purchases row may be written when blocked by an already-lost dispute'
  );

  perform pg_temp.assert(
    (select reconciliation_reason from public.book_checkout_intents
     where id = 'dddddddd-1111-1111-1111-111111111111') = 'disputed_lost',
    'part6: the intent must durably record reconciliation_reason = disputed_lost'
  );

  perform pg_temp.assert(
    (select fulfilled_at from public.book_checkout_intents
     where id = 'dddddddd-1111-1111-1111-111111111111') is null,
    'part6: a blocked intent must never be marked fulfilled'
  );
end $$;

-- A retry/duplicate delivery of the SAME event, after the block above
-- already committed, must be a clean no-op (already_finalized) -- the
-- existing fulfilled_at/reconciliation_reason short-circuit at the top
-- of the function already covers this; re-confirmed here specifically
-- for the disputed_lost path, not merely assumed to generalize.
do $$
declare
  result record;
begin
  select outcome, out_book_id, out_reader_id
  into result
  from public.finalize_book_checkout_intent(
    'dddddddd-1111-1111-1111-111111111111',
    'cs_test_pre_fulfillment',
    'pi_test_pre_fulfillment_lost',
    700
  );

  perform pg_temp.assert(result.outcome = 'already_finalized',
    format('part6b: a redelivery after a disputed_lost block must report already_finalized, got %s', result.outcome));
end $$;

-- Regression check: an intent with NO dispute at all still fulfills
-- normally -- confirms migration 035's new guard clause does not
-- interfere with the existing, unmodified happy path.
insert into public.book_checkout_intents
  (id, book_id, reader_id, book_title, price_cents_at_checkout, expires_at)
values
  ('dddddddd-2222-2222-2222-222222222222', 'cccccccc-6666-6666-6666-666666666666',
   'bbbbbbbb-2222-2222-2222-222222222222', 'No-Prior-Purchase Book', 900, now() + interval '1 hour');

do $$
declare
  result record;
begin
  select outcome, out_book_id, out_reader_id
  into result
  from public.finalize_book_checkout_intent(
    'dddddddd-2222-2222-2222-222222222222',
    'cs_test_no_dispute_regression',
    'pi_test_no_dispute_regression',
    900
  );

  perform pg_temp.assert(result.outcome = 'eligible_fulfilled',
    format('part6c: an undisputed intent must still fulfill normally, got %s', result.outcome));
  perform pg_temp.assert(
    (select fulfilled_at from public.book_checkout_intents
     where id = 'dddddddd-2222-2222-2222-222222222222') is not null,
    'part6c: an undisputed intent must be marked fulfilled'
  );
end $$;

-- ============================================================
-- Part 7: PRE-PRODUCTION CORRECTION -- canonical active-entitlement
-- predicate reused consistently across every repurchase-prevention
-- path (create_book_checkout_intent, create_bundle_checkout_snapshot),
-- not merely inside user_owns_book() itself. Fixtures: six books
-- covering every case point 9 of the correction requires.
-- ============================================================
insert into public.books (id, author_id, title, price_cents, status) values
  ('eeeeeeee-1111-1111-1111-111111111111', 'bbbbbbbb-1111-1111-1111-111111111111', 'Ordinary Active Purchase', 500, 'published'),
  ('eeeeeeee-2222-2222-2222-222222222222', 'bbbbbbbb-1111-1111-1111-111111111111', 'Refunded Purchase', 500, 'published'),
  ('eeeeeeee-3333-3333-3333-333333333333', 'bbbbbbbb-1111-1111-1111-111111111111', 'Lost-Dispute Repurchase', 500, 'published'),
  ('eeeeeeee-4444-4444-4444-444444444444', 'bbbbbbbb-1111-1111-1111-111111111111', 'Under-Review-Dispute Purchase', 500, 'published'),
  ('eeeeeeee-5555-5555-5555-555555555555', 'bbbbbbbb-1111-1111-1111-111111111111', 'Won-Dispute Purchase', 500, 'published'),
  ('eeeeeeee-6666-6666-6666-666666666666', 'bbbbbbbb-1111-1111-1111-111111111111', 'Unknown-Status-Dispute Purchase', 500, 'published');

insert into public.purchases (book_id, reader_id, stripe_checkout_session_id, stripe_payment_intent_id, amount_cents, refunded_at) values
  ('eeeeeeee-1111-1111-1111-111111111111', 'bbbbbbbb-2222-2222-2222-222222222222', 'cs_p7_active', 'pi_p7_active', 500, null),
  ('eeeeeeee-2222-2222-2222-222222222222', 'bbbbbbbb-2222-2222-2222-222222222222', 'cs_p7_refunded', 'pi_p7_refunded', 500, now()),
  ('eeeeeeee-3333-3333-3333-333333333333', 'bbbbbbbb-2222-2222-2222-222222222222', 'cs_p7_lost', 'pi_p7_lost', 500, null),
  ('eeeeeeee-4444-4444-4444-444444444444', 'bbbbbbbb-2222-2222-2222-222222222222', 'cs_p7_under_review', 'pi_p7_under_review', 500, null),
  ('eeeeeeee-5555-5555-5555-555555555555', 'bbbbbbbb-2222-2222-2222-222222222222', 'cs_p7_won', 'pi_p7_won', 500, null),
  ('eeeeeeee-6666-6666-6666-666666666666', 'bbbbbbbb-2222-2222-2222-222222222222', 'cs_p7_unknown', 'pi_p7_unknown', 500, null);

insert into public.payment_disputes (stripe_dispute_id, stripe_payment_intent_id, status, reason, amount_cents) values
  ('dp_p7_lost', 'pi_p7_lost', 'lost', 'fraudulent', 500),
  ('dp_p7_under_review', 'pi_p7_under_review', 'under_review', 'fraudulent', 500),
  ('dp_p7_won', 'pi_p7_won', 'won', 'fraudulent', 500),
  ('dp_p7_unknown', 'pi_p7_unknown', 'some_future_stripe_status', 'general', 500);

-- --- create_book_checkout_intent(): repurchase-prevention, all six cases ---
do $$
begin
  perform set_config('request.jwt.claim.sub', 'bbbbbbbb-2222-2222-2222-222222222222', true);
  set local role authenticated;

  -- Ordinary active purchase: repurchase must still be blocked.
  begin
    perform public.create_book_checkout_intent('eeeeeeee-1111-1111-1111-111111111111', null);
    perform pg_temp.assert(false, 'part7: an ordinary active purchase must still block repurchase');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'reader already owns this book',
      format('part7: unexpected error for active purchase: %s', sqlerrm));
  end;

  -- Refunded purchase: repurchase allowed (unchanged, pre-existing behavior).
  perform pg_temp.assert(
    (select count(*) from public.create_book_checkout_intent('eeeeeeee-2222-2222-2222-222222222222', null)) = 1,
    'part7: a refunded purchase must still allow repurchase'
  );

  -- Lost-dispute purchase: repurchase must now be ALLOWED.
  perform pg_temp.assert(
    (select count(*) from public.create_book_checkout_intent('eeeeeeee-3333-3333-3333-333333333333', null)) = 1,
    'part7: a lost-dispute purchase must allow repurchase'
  );

  -- under_review dispute: repurchase must remain BLOCKED.
  begin
    perform public.create_book_checkout_intent('eeeeeeee-4444-4444-4444-444444444444', null);
    perform pg_temp.assert(false, 'part7: an under_review dispute must still block repurchase');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'reader already owns this book',
      format('part7: unexpected error for under_review dispute: %s', sqlerrm));
  end;

  -- won dispute: repurchase must remain BLOCKED.
  begin
    perform public.create_book_checkout_intent('eeeeeeee-5555-5555-5555-555555555555', null);
    perform pg_temp.assert(false, 'part7: a won dispute must still block repurchase');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'reader already owns this book',
      format('part7: unexpected error for won dispute: %s', sqlerrm));
  end;

  -- Unknown/future dispute status: repurchase must remain BLOCKED --
  -- only the literal 'lost' ever permits reacquisition.
  begin
    perform public.create_book_checkout_intent('eeeeeeee-6666-6666-6666-666666666666', null);
    perform pg_temp.assert(false, 'part7: an unrecognized dispute status must still block repurchase');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'reader already owns this book',
      format('part7: unexpected error for unknown-status dispute: %s', sqlerrm));
  end;

  reset role;
end $$;

-- ============================================================
-- Part 8: checkout-intent idempotency/collision verification (point 8
-- of the correction) -- explicitly checked, not assumed. A repurchase
-- after a lost dispute must mint a genuinely FRESH intent, never reuse
-- or collide with the OLD, already-fulfilled intent that led to the
-- now-disputed purchase.
--
-- Uses its OWN book/purchase/dispute, deliberately separate from Part
-- 7's eeeeeeee-3333 fixture: Part 7 already minted an unfulfilled
-- intent for that book (still open, still reusable by design -- that's
-- the pre-existing, unrelated "reuse an active intent" behavior), and
-- reusing it here would conflate that with the property this part
-- actually verifies: no collision with the OLD, ALREADY-FULFILLED
-- intent specifically.
-- ============================================================
insert into public.books (id, author_id, title, price_cents, status) values
  ('eeeeeeee-9999-9999-9999-999999999999', 'bbbbbbbb-1111-1111-1111-111111111111', 'Idempotency Check Book', 500, 'published');

insert into public.purchases (book_id, reader_id, stripe_checkout_session_id, stripe_payment_intent_id, amount_cents, refunded_at) values
  ('eeeeeeee-9999-9999-9999-999999999999', 'bbbbbbbb-2222-2222-2222-222222222222', 'cs_p8_lost', 'pi_p8_lost', 500, null);

insert into public.payment_disputes (stripe_dispute_id, stripe_payment_intent_id, status, reason, amount_cents) values
  ('dp_p8_lost', 'pi_p8_lost', 'lost', 'fraudulent', 500);

insert into public.book_checkout_intents
  (id, book_id, reader_id, book_title, price_cents_at_checkout, expires_at,
   stripe_payment_intent_id, completed_at, fulfilled_at)
values
  ('ffffffff-1111-1111-1111-111111111111', 'eeeeeeee-9999-9999-9999-999999999999',
   'bbbbbbbb-2222-2222-2222-222222222222', 'Idempotency Check Book', 500,
   now() + interval '1 hour', 'pi_p8_lost', now() - interval '1 day', now() - interval '1 day');

do $$
declare
  new_intent record;
  new_intent_count integer;
begin
  perform set_config('request.jwt.claim.sub', 'bbbbbbbb-2222-2222-2222-222222222222', true);
  set local role authenticated;

  select intent_id, price_cents_at_checkout, discount_code_id, expires_at
  into new_intent
  from public.create_book_checkout_intent('eeeeeeee-9999-9999-9999-999999999999', null);

  reset role;

  perform pg_temp.assert(new_intent.intent_id is not null,
    'part8: a repurchase after a lost dispute must return a usable fresh intent');
  perform pg_temp.assert(new_intent.intent_id <> 'ffffffff-1111-1111-1111-111111111111',
    'part8: the fresh intent must NOT be the old, already-fulfilled intent -- no reuse/collision');

  select count(*) into new_intent_count
  from public.book_checkout_intents
  where book_id = 'eeeeeeee-9999-9999-9999-999999999999'
    and reader_id = 'bbbbbbbb-2222-2222-2222-222222222222';

  -- Exactly two rows now exist for this (book, reader) pair: the old,
  -- historical, fulfilled intent (left completely untouched -- it is
  -- durable audit history, never rewritten) and the brand-new one just
  -- minted. book_checkout_intents has no unique(book_id, reader_id)
  -- constraint precisely so this can coexist.
  perform pg_temp.assert(new_intent_count = 2,
    format('part8: expected exactly 2 intents (old fulfilled + new fresh), found %s', new_intent_count));

  perform pg_temp.assert(
    (select fulfilled_at from public.book_checkout_intents where id = 'ffffffff-1111-1111-1111-111111111111') is not null,
    'part8: the old, historical intent must remain untouched, not rewritten or cleared'
  );
end $$;

-- ============================================================
-- Part 9: create_bundle_checkout_snapshot() -- the same corrections,
-- bundle-shaped. Reuses the reader/author from Parts 4-8.
-- ============================================================
insert into public.books (id, author_id, title, price_cents, status) values
  ('eeeeeeee-7777-7777-7777-777777777777', 'bbbbbbbb-1111-1111-1111-111111111111', 'Bundle Book: Not Yet Owned', 400, 'published'),
  ('eeeeeeee-8888-8888-8888-888888888888', 'bbbbbbbb-1111-1111-1111-111111111111', 'Bundle Book: Ordinary Active', 400, 'published');

insert into public.purchases (book_id, reader_id, stripe_checkout_session_id, stripe_payment_intent_id, amount_cents, refunded_at) values
  ('eeeeeeee-8888-8888-8888-888888888888', 'bbbbbbbb-2222-2222-2222-222222222222', 'cs_p9_active', 'pi_p9_active', 400, null);

insert into public.bundles (id, author_id, title, price_cents, status) values
  ('11111111-9999-9999-9999-999999999999', 'bbbbbbbb-1111-1111-1111-111111111111', 'Mixed Ownership Bundle', 700, 'published'),
  ('11111111-8888-8888-8888-888888888888', 'bbbbbbbb-1111-1111-1111-111111111111', 'Fully-Owned Bundle', 800, 'published');

-- "Mixed Ownership Bundle": one book already lost-disputed (should
-- count as NOT owned, per the corrected predicate), one genuinely new.
insert into public.bundle_books (bundle_id, book_id) values
  ('11111111-9999-9999-9999-999999999999', 'eeeeeeee-3333-3333-3333-333333333333'),
  ('11111111-9999-9999-9999-999999999999', 'eeeeeeee-7777-7777-7777-777777777777');

-- "Fully-Owned Bundle": one ordinary active purchase, one under_review
-- disputed purchase -- neither is a lost dispute, so both must still
-- count as owned, and checkout must still be correctly refused.
insert into public.bundle_books (bundle_id, book_id) values
  ('11111111-8888-8888-8888-888888888888', 'eeeeeeee-8888-8888-8888-888888888888'),
  ('11111111-8888-8888-8888-888888888888', 'eeeeeeee-4444-4444-4444-444444444444');

-- NOTE: bundle_checkout_snapshots/bundle_checkout_reservations both
-- carry RLS policies scoped to auth.uid() -- and, for snapshots,
-- additionally to `fulfilled_at is not null` (see schema.sql) -- so a
-- freshly-created, still-UNFULFILLED snapshot is correctly invisible to
-- a plain `authenticated`-role SELECT, even for its own reader. Every
-- introspection query below therefore runs AFTER `reset role` (back to
-- the table owner, which bypasses RLS), never while role=authenticated
-- is still active from the RPC call -- only the two create_bundle_
-- checkout_snapshot() calls themselves need that role set.
do $$
declare
  snapshot_result record;
  reservation_count integer;
  item_count integer;
begin
  perform set_config('request.jwt.claim.sub', 'bbbbbbbb-2222-2222-2222-222222222222', true);
  set local role authenticated;

  -- Mixed-ownership bundle: must succeed (the lost-disputed book no
  -- longer blocks checkout), and must freeze BOTH books.
  select snapshot_id, bundle_title, bundle_price_cents_at_checkout, protection_expires_at
  into snapshot_result
  from public.create_bundle_checkout_snapshot('11111111-9999-9999-9999-999999999999');

  reset role;

  perform pg_temp.assert(snapshot_result.snapshot_id is not null,
    'part9: a bundle containing a lost-disputed prior purchase must be checkout-able');

  select jsonb_array_length(items) into item_count
  from public.bundle_checkout_snapshots
  where id = snapshot_result.snapshot_id;
  perform pg_temp.assert(item_count = 2,
    'part9: the snapshot must freeze BOTH books, including the previously lost-disputed one'
  );

  select count(*) into reservation_count
  from public.bundle_checkout_reservations
  where snapshot_id = snapshot_result.snapshot_id;
  perform pg_temp.assert(reservation_count = 2,
    'part9: no regression to the reservation mechanism -- one reservation row per frozen book');

  -- Fully-owned bundle (active + under_review, neither lost): must
  -- still be correctly refused -- regression check, unchanged behavior.
  perform set_config('request.jwt.claim.sub', 'bbbbbbbb-2222-2222-2222-222222222222', true);
  set local role authenticated;
  begin
    perform public.create_bundle_checkout_snapshot('11111111-8888-8888-8888-888888888888');
    perform pg_temp.assert(false, 'part9: a bundle with no lost disputes and full ownership must still be refused');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'reader already owns every book in this bundle',
      format('part9: unexpected error for fully-owned bundle: %s', sqlerrm));
  end;

  reset role;
end $$;

select 'ALL PASSED: 035_stripe_dispute_tracking.test.sql' as result;

rollback;
