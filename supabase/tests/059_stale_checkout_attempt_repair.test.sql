-- Committed SQL regression suite for the STALE-CHECKOUT-1 repair
-- (migration 20260920081304_stale_checkout_attempt_repair).
--
-- The defect this suite exists to hold closed: a reader whose POK
-- checkout attempt died -- expired, cancelled, or abandoned mid-creation
-- -- could not start another one for the whole 23-hour life of the
-- intent, because nothing in the system could ever conclude "that
-- attempt is dead". The repair adds supersession to the intent, a
-- retired state to the mapping, and the rules that decide which
-- evidence is allowed to move an attempt to either.
--
-- What is asserted here is mostly what must NOT happen: a live attempt
-- must never be retired on a local clock, a superseded intent must never
-- lose a payment that arrives late, a mapping reason must never be
-- written into an intent's reason column, and a replacement must never
-- be minted for an attempt whose death was not proved.
--
-- Not run automatically by any CI/build step in this repo (there is no
-- SQL test framework or Postgres-in-CI setup here) -- run it manually
-- against a disposable/local Postgres instance, AFTER applying
-- supabase/schema.sql, from the repo root:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/059_stale_checkout_attempt_repair.test.sql
--
-- (supabase/schema.sql already carries this migration's objects; a
-- database built from base schema.sql plus the migration file is
-- equivalent and works identically.)
--
-- Everything runs inside one transaction and is rolled back at the end,
-- so the file is repeatable with no manual cleanup -- EXCEPT part 9's
-- privilege assertions, which read committed privilege state that the
-- migration itself already committed, never anything this test writes.

begin;

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

-- Report a statement that should have been REJECTED but was not.
--
-- Raises with a DISTINCT errcode on purpose. Written as
-- `assert(false, ...)` inside a `begin ... exception when
-- raise_exception` block, the failure report is itself a
-- raise_exception and the block's own handler swallows it -- so the
-- case would pass exactly when it should fail. This condition is not
-- one any of those handlers catch.
create function pg_temp.not_rejected(message text) returns void
  language plpgsql as $$
begin
  raise exception using errcode = 'triggered_action_exception',
    message = 'FAIL: ' || message;
end;
$$;

-- ============================================================
-- Fixtures
-- ============================================================
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'author-a@test', '{"role":"author","display_name":"Author A"}'),
  ('22222222-2222-2222-2222-222222222222', 'reader-r1@test', '{"role":"reader","display_name":"Reader R1"}'),
  ('33333333-3333-3333-3333-333333333333', 'reader-r2@test', '{"role":"reader","display_name":"Reader R2"}');

-- ALL-CHECKOUT-1: both books gain price_all, since the RPC now prices
-- from that column and refuses a null one. price_all is whole lek, so
-- Book One's minted amount is 999 * 100 = 99900 minor units, and
-- HALFOFF (50%) on it is 999 * 50 = 49950 -- exactly, with no rounding.
insert into public.books (id, author_id, title, status, price_cents, price_all) values
  ('b0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Book One', 'published', 999, 999),
  ('b0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Book Two', 'published', 500, 500);

insert into public.discount_codes (id, author_id, book_id, code, percent_off, active) values
  ('d0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'b0000000-0000-0000-0000-000000000001', 'HALFOFF', 50, true);

-- Mint a quote as a given reader.
--
-- ALL-CHECKOUT-1: the regime, currency and royalty arguments are gone.
-- This helper no longer asks for ledger_v1/ALL; it gets them because
-- they are the only values the function can produce, which is the
-- point. The royalty it used to pass (7000) is likewise gone: every
-- minted intent now carries 8000, set inside the function.
create function pg_temp.quote_as(
  p_reader uuid, p_book uuid, p_code text default null,
  p_accept boolean default false, p_expected uuid default null)
returns table (intent_id uuid, price_cents_at_checkout integer, discount_code_id uuid,
               expires_at timestamptz, quote_status text)
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_reader::text, true);
  set local role authenticated;
  return query select * from public.create_book_checkout_intent(
    p_book, p_code, p_accept, p_expected);
  reset role;
end;
$$;

-- Claim a POK attempt for an intent, as the service role does.
create function pg_temp.claim(p_intent uuid, p_minutes integer default 30)
returns table (outcome text, provider_window_ends_at timestamptz, granted_window_minutes integer)
language plpgsql as $$
begin
  set local role service_role;
  return query select * from public.claim_pok_book_checkout_order(
    p_intent, 'book:' || p_intent::text, gen_random_uuid(), gen_random_uuid(), p_minutes);
  reset role;
end;
$$;

create function pg_temp.retire(
  p_intent uuid, p_claim uuid, p_order text, p_state text, p_reason text)
returns text language plpgsql as $$
declare v_out text;
begin
  set local role service_role;
  select public.retire_book_checkout_attempt(p_intent, p_claim, p_order, p_state, p_reason)
    into v_out;
  reset role;
  return v_out;
end;
$$;

create function pg_temp.claim_id(p_intent uuid) returns uuid language sql as $$
  select creation_claim_id from public.pok_book_checkout_orders where intent_id = p_intent;
$$;

-- ============================================================
-- Part 1: the supersession columns and their pairing rules
-- ============================================================
do $$
declare
  v_intent uuid;
begin
  select intent_id into v_intent
    from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                          'b0000000-0000-0000-0000-000000000001');

  -- Half a supersession is never a state this table can hold: the
  -- timestamp and the reason are one fact.
  begin
    update public.book_checkout_intents set superseded_at = now() where id = v_intent;
    perform pg_temp.assert(false, 'part1: superseded_at without a reason must be rejected');
  exception when check_violation then null;
  end;

  begin
    update public.book_checkout_intents set superseded_reason = 'quote_stale' where id = v_intent;
    perform pg_temp.assert(false, 'part1: superseded_reason without a timestamp must be rejected');
  exception when check_violation then null;
  end;

  -- The INTENT's vocabulary only. A mapping-side reason in this column
  -- would make the two lifecycles indistinguishable in the audit trail.
  begin
    update public.book_checkout_intents
      set superseded_at = now(), superseded_reason = 'provider_attempt_expired'
      where id = v_intent;
    perform pg_temp.assert(false,
      'part1: a MAPPING retirement reason must never be accepted as an INTENT supersede reason');
  exception when check_violation then null;
  end;

  begin
    update public.book_checkout_intents
      set superseded_at = now(), superseded_reason = 'provider_window_elapsed_no_order_id'
      where id = v_intent;
    perform pg_temp.assert(false,
      'part1: provider_window_elapsed_no_order_id is a mapping reason, never an intent one');
  exception when check_violation then null;
  end;

  delete from public.book_checkout_intents where id = v_intent;
end $$;

-- ============================================================
-- Part 2: the transition trigger
--
-- A CHECK constraint cannot express any of this: it sees only the
-- post-state, and "superseded AND paid" is a legal post-state that must
-- be reachable in one direction (supersede first, pay later) and
-- unreachable in the other (arriving already both).
-- ============================================================
do $$
declare
  v_intent uuid;
  v_id uuid;
begin
  -- An INSERT may never introduce supersession and financial completion
  -- at once: that shape can only come from a caller inventing history.
  begin
    insert into public.book_checkout_intents
      (book_id, reader_id, price_cents_at_checkout, expires_at, regime, currency,
       royalty_rate_bps, superseded_at, superseded_reason, completed_at)
    values ('b0000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
            999, now() + interval '1 hour', 'librum_ledger_v1', 'ALL', 7000,
            now(), 'quote_stale', now())
    returning id into v_id;
    perform pg_temp.not_rejected(
      'part2: an insert may not arrive already superseded AND already complete');
  exception when raise_exception then null;
  end;

  select intent_id into v_intent
    from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                          'b0000000-0000-0000-0000-000000000001');

  -- The legitimate direction: supersede, THEN take a late payment.
  -- A verified payment on a superseded attempt must still be able to
  -- reach fulfilment -- discarding it is the one failure with no remedy.
  --
  -- completed_at and fulfilled_at move together here because a
  -- pre-existing constraint (book_checkout_intents_check3) requires a
  -- reconciliation_reason for any completed-but-unfulfilled row; the
  -- reconciliation shape is exercised on its own below.
  update public.book_checkout_intents
    set superseded_at = now(), superseded_reason = 'quote_stale' where id = v_intent;
  update public.book_checkout_intents
    set completed_at = now(), fulfilled_at = now() where id = v_intent;
  perform pg_temp.assert(
    (select fulfilled_at is not null and superseded_at is not null
       from public.book_checkout_intents where id = v_intent),
    'part2: a superseded intent MUST still be completable and fulfillable later');

  -- The other direction money can take on a superseded attempt: it
  -- arrives, cannot fulfil, and must land in RECONCILIATION rather than
  -- being silently dropped.
  declare v_recon uuid;
  begin
    select intent_id into v_recon
      from pg_temp.quote_as('33333333-3333-3333-3333-333333333333',
                            'b0000000-0000-0000-0000-000000000001');
    update public.book_checkout_intents
      set superseded_at = now(), superseded_reason = 'provider_attempt_retired'
      where id = v_recon;
    update public.book_checkout_intents
      set completed_at = now(), reconciliation_reason = 'active_other_session'
      where id = v_recon;
    perform pg_temp.assert(
      (select completed_at is not null and reconciliation_reason = 'active_other_session'
         from public.book_checkout_intents where id = v_recon),
      'part2: a late payment on a superseded attempt must be able to reach reconciliation');
    delete from public.book_checkout_intents where id = v_recon;
  end;

  -- Superseded state is permanent. Clearing it would resurrect a quote
  -- whose economics the reader never re-agreed to.
  begin
    update public.book_checkout_intents
      set superseded_at = null, superseded_reason = null where id = v_intent;
    perform pg_temp.not_rejected('part2: supersession must never be cleared');
  exception when raise_exception then null;
  end;

  begin
    update public.book_checkout_intents
      set superseded_reason = 'intent_expired' where id = v_intent;
    perform pg_temp.not_rejected('part2: a recorded supersede reason must never be rewritten');
  exception when raise_exception then null;
  end;

  begin
    update public.book_checkout_intents
      set superseded_at = now() + interval '1 day' where id = v_intent;
    perform pg_temp.not_rejected('part2: a recorded supersede timestamp must never be moved');
  exception when raise_exception then null;
  end;

  delete from public.book_checkout_intents where id = v_intent;
end $$;

-- ============================================================
-- Part 3: the mapping's retired state
-- ============================================================
do $$
declare
  v_intent uuid;
begin
  select intent_id into v_intent
    from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                          'b0000000-0000-0000-0000-000000000001');
  perform pg_temp.claim(v_intent);

  -- State and its timestamp are one fact, in both directions.
  begin
    update public.pok_book_checkout_orders set state = 'retired' where intent_id = v_intent;
    perform pg_temp.assert(false, 'part3: state=retired without retired_at must be rejected');
  exception when check_violation then null;
  end;

  begin
    update public.pok_book_checkout_orders
      set retired_at = now(), retired_reason = 'provider_attempt_expired'
      where intent_id = v_intent;
    perform pg_temp.assert(false, 'part3: retirement facts without state=retired must be rejected');
  exception when check_violation then null;
  end;

  -- The MAPPING's vocabulary only -- no value is shared with the intent's.
  begin
    update public.pok_book_checkout_orders
      set state = 'retired', retired_at = now(), retired_reason = 'quote_stale'
      where intent_id = v_intent;
    perform pg_temp.assert(false,
      'part3: an INTENT supersede reason must never be accepted as a MAPPING retirement reason');
  exception when check_violation then null;
  end;

  update public.pok_book_checkout_orders
    set state = 'retired', retired_at = now(), retired_reason = 'provider_attempt_expired'
    where intent_id = v_intent;

  -- Retired is terminal: an attempt that came back from the dead could
  -- be handed to a reader as live.
  begin
    update public.pok_book_checkout_orders set state = 'ready' where intent_id = v_intent;
    perform pg_temp.not_rejected('part3: a retired mapping must never return to a live state');
  exception when raise_exception then null;
  end;

  begin
    update public.pok_book_checkout_orders
      set retired_reason = 'provider_attempt_canceled' where intent_id = v_intent;
    perform pg_temp.not_rejected('part3: a recorded retirement reason must never be rewritten');
  exception when raise_exception then null;
  end;

  delete from public.pok_book_checkout_orders where intent_id = v_intent;
  delete from public.book_checkout_intents where id = v_intent;
end $$;

-- ============================================================
-- Part 4: claim_pok_book_checkout_order
-- ============================================================
do $$
declare
  v_intent uuid;
  v_other uuid;
  r record;
begin
  select intent_id into v_intent
    from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                          'b0000000-0000-0000-0000-000000000001');

  select * into r from pg_temp.claim(v_intent, 30);
  perform pg_temp.assert(r.outcome = 'claimed', 'part4: a fresh ledger quote must be claimable');
  perform pg_temp.assert(r.granted_window_minutes = 30,
    'part4: SQL must return the window it granted, not null');
  perform pg_temp.assert(r.provider_window_ends_at is not null,
    'part4: the granted window must be stored as an absolute instant');
  perform pg_temp.assert(
    (select provider_window_ends_at from public.pok_book_checkout_orders where intent_id = v_intent)
      = r.provider_window_ends_at,
    'part4: the returned window and the stored window must be the same value');

  -- The primary key, not a timing accident, is what makes a second
  -- claim lose. Exactly one provider order per intent, ever.
  select * into r from pg_temp.claim(v_intent, 30);
  perform pg_temp.assert(r.outcome = 'already_claimed', 'part4: a second claim must lose');
  perform pg_temp.assert(r.granted_window_minutes is null,
    'part4: a losing claim must be granted no window at all');

  -- The window is bounded by the intent's own expiry: an attempt may
  -- never outlive the quote it is paying for.
  select intent_id into v_other
    from pg_temp.quote_as('33333333-3333-3333-3333-333333333333',
                          'b0000000-0000-0000-0000-000000000001');
  update public.book_checkout_intents
    set expires_at = now() + interval '5 minutes' where id = v_other;
  select * into r from pg_temp.claim(v_other, 30);
  perform pg_temp.assert(r.outcome = 'claimed', 'part4: a short-lived quote is still claimable');
  perform pg_temp.assert(r.granted_window_minutes <= 5,
    'part4: the granted window must never exceed the intent''s own remaining life');
  delete from public.pok_book_checkout_orders where intent_id = v_other;

  -- Every rejection, by its own name.
  update public.book_checkout_intents
    set created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'
    where id = v_other;
  select * into r from pg_temp.claim(v_other);
  perform pg_temp.assert(r.outcome = 'intent_expired', 'part4: an expired intent must not be claimable');

  update public.book_checkout_intents
    set expires_at = now() + interval '1 hour',
        superseded_at = now(), superseded_reason = 'quote_stale' where id = v_other;
  select * into r from pg_temp.claim(v_other);
  perform pg_temp.assert(r.outcome = 'intent_not_claimable',
    'part4: a superseded intent must never receive a new provider order');

  select * into r from pg_temp.claim('00000000-0000-0000-0000-000000000000');
  perform pg_temp.assert(r.outcome = 'intent_not_found', 'part4: an unknown intent is not_found');

  -- A legacy/Stripe-bound or non-ledger quote may never carry a POK order.
  --
  -- ALL-CHECKOUT-1: this fixture used to be minted through the RPC with
  -- p_regime = 'legacy_stripe_connect_v1'. No authenticated caller can
  -- do that any more -- that is the capability the change removes -- so
  -- the row is inserted directly as the table owner instead. The
  -- behaviour under test is unchanged and is still worth proving: a
  -- legacy intent that EXISTS (every one in staging does) must never
  -- become claimable for a POK order. Deliberately NOT kept mintable
  -- through the RPC merely to make this fixture convenient.
  declare v_legacy uuid;
  begin
    insert into public.book_checkout_intents
      (book_id, reader_id, book_title, price_cents_at_checkout, expires_at,
       regime, currency, royalty_rate_bps)
    values ('b0000000-0000-0000-0000-000000000002', '33333333-3333-3333-3333-333333333333',
            'Book Two', 500, now() + interval '23 hours',
            'legacy_stripe_connect_v1', 'USD', null)
    returning id into v_legacy;
    select * into r from pg_temp.claim(v_legacy);
    perform pg_temp.assert(r.outcome = 'intent_not_claimable',
      'part4: a legacy/USD quote must never be claimable for a POK order');

    delete from public.book_checkout_intents where id = v_legacy;
  end;

  -- A ledger quote that picked up a Stripe session is refused by its own
  -- name, not lumped in with "not claimable": that session may still be
  -- payable and this code can no longer reach Stripe to find out.
  --
  -- The regime is NOT mutated into place here, because the immutability
  -- trigger correctly refuses that -- the quote is minted as ledger_v1
  -- and only the session id is attached.
  declare v_bound uuid;
  begin
    select intent_id into v_bound
      from pg_temp.quote_as('33333333-3333-3333-3333-333333333333',
                            'b0000000-0000-0000-0000-000000000002');
    update public.book_checkout_intents
      set stripe_checkout_session_id = 'cs_test' where id = v_bound;
    select * into r from pg_temp.claim(v_bound);
    perform pg_temp.assert(r.outcome = 'intent_stripe_bound',
      'part4: a Stripe-bound quote must be refused by its own name');
    delete from public.book_checkout_intents where id = v_bound;
  end;

  -- The reference is derived, never caller-chosen.
  declare v_ref uuid; v_out text;
  begin
    select intent_id into v_ref
      from pg_temp.quote_as('33333333-3333-3333-3333-333333333333',
                            'b0000000-0000-0000-0000-000000000002');
    set local role service_role;
    select c.outcome into v_out from public.claim_pok_book_checkout_order(
      v_ref, 'book:someone-else', gen_random_uuid(), gen_random_uuid(), 30) c;
    reset role;
    perform pg_temp.assert(v_out = 'reference_mismatch',
      'part4: a reference that is not book:<intent id> must be refused');
    delete from public.book_checkout_intents where id = v_ref;
  end;

  delete from public.pok_book_checkout_orders where intent_id = v_intent;
  delete from public.book_checkout_intents where id in (v_intent, v_other);
end $$;

-- ============================================================
-- Part 5: retire_book_checkout_attempt
--
-- The compare-and-set that stands between "the provider said this
-- attempt is dead" and actually retiring it. Every expectation is
-- checked against the row as it is NOW, so a mapping that moved while
-- the application was talking to POK is refused rather than overwritten.
-- ============================================================
do $$
declare
  v_intent uuid;
  v_claim uuid;
  v_out text;
begin
  select intent_id into v_intent
    from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                          'b0000000-0000-0000-0000-000000000001');
  perform pg_temp.claim(v_intent);
  v_claim := pg_temp.claim_id(v_intent);

  -- The intent's vocabulary is not accepted here either.
  v_out := pg_temp.retire(v_intent, v_claim, null, 'creating', 'quote_stale');
  perform pg_temp.assert(v_out = 'invalid_retired_reason',
    'part5: an intent supersede reason must be refused as a retirement reason');

  -- A mismatched expectation never mutates anything.
  v_out := pg_temp.retire(v_intent, gen_random_uuid(), null, 'creating', 'provider_attempt_expired');
  perform pg_temp.assert(v_out = 'mapping_changed',
    'part5: a different creation claim must be refused');
  v_out := pg_temp.retire(v_intent, v_claim, 'some-order-id', 'creating', 'provider_attempt_expired');
  perform pg_temp.assert(v_out = 'mapping_changed',
    'part5: an expected provider order id that does not match must be refused');
  v_out := pg_temp.retire(v_intent, v_claim, null, 'ready', 'provider_attempt_expired');
  perform pg_temp.assert(v_out = 'mapping_changed',
    'part5: an expected state that does not match must be refused');
  perform pg_temp.assert(
    (select state from public.pok_book_checkout_orders where intent_id = v_intent) = 'creating',
    'part5: a refused retirement must leave the mapping exactly as it was');
  perform pg_temp.assert(
    (select superseded_at is null from public.book_checkout_intents where id = v_intent),
    'part5: a refused retirement must leave the intent un-superseded');

  -- An expired/cancelled reason on an attempt with NO order id is not
  -- coherent: those two reasons are provider evidence, and there is no
  -- provider order to have evidence about.
  v_out := pg_temp.retire(v_intent, v_claim, null, 'creating', 'provider_attempt_canceled');
  perform pg_temp.assert(v_out = 'reason_not_coherent',
    'part5: provider evidence must not be claimed for an attempt with no provider order');

  -- The matching triple, with the reason the evidence supports.
  v_out := pg_temp.retire(v_intent, v_claim, null, 'creating', 'provider_window_elapsed_no_order_id');
  perform pg_temp.assert(v_out = 'retired_and_superseded',
    'part5: a matching compare-and-set with a coherent reason must retire');
  perform pg_temp.assert(
    (select state = 'retired' and retired_reason = 'provider_window_elapsed_no_order_id'
       from public.pok_book_checkout_orders where intent_id = v_intent),
    'part5: the mapping must carry its own reason');
  perform pg_temp.assert(
    (select superseded_reason = 'provider_attempt_retired'
       from public.book_checkout_intents where id = v_intent),
    'part5: the intent must carry the INTENT reason, never the mapping''s own');

  -- Atomic: the mapping and the intent moved in the same transaction.
  perform pg_temp.assert(
    (select superseded_at is not null from public.book_checkout_intents where id = v_intent),
    'part5: retirement and supersession must happen together or not at all');

  v_out := pg_temp.retire(v_intent, v_claim, null, 'retired', 'provider_attempt_expired');
  perform pg_temp.assert(v_out = 'not_retireable',
    'part5: an already-retired attempt must not be retired again');

  delete from public.pok_book_checkout_orders where intent_id = v_intent;
  delete from public.book_checkout_intents where id = v_intent;
end $$;

-- Money always outranks retirement.
do $$
declare
  v_intent uuid;
  v_claim uuid;
  v_out text;
begin
  select intent_id into v_intent
    from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                          'b0000000-0000-0000-0000-000000000001');
  perform pg_temp.claim(v_intent);
  v_claim := pg_temp.claim_id(v_intent);
  update public.pok_book_checkout_orders
    set provider_order_id = 'ord_1', state = 'ready', checkout_url = 'https://pay-staging.pokpay.io/sdk-orders/ord_1'
    where intent_id = v_intent;

  update public.book_checkout_intents
    set completed_at = now(), reconciliation_reason = 'active_other_session' where id = v_intent;
  v_out := pg_temp.retire(v_intent, v_claim, 'ord_1', 'ready', 'provider_attempt_expired');
  perform pg_temp.assert(v_out = 'already_completed',
    'part5: an attempt whose intent took money must never be retired');
  perform pg_temp.assert(
    (select state from public.pok_book_checkout_orders where intent_id = v_intent) = 'ready',
    'part5: a paid attempt''s mapping must be left alone');

  update public.book_checkout_intents
    set fulfilled_at = now(), reconciliation_reason = null where id = v_intent;
  v_out := pg_temp.retire(v_intent, v_claim, 'ord_1', 'ready', 'provider_attempt_expired');
  perform pg_temp.assert(v_out = 'already_fulfilled',
    'part5: a fulfilled intent''s attempt must never be retired');

  delete from public.pok_book_checkout_orders where intent_id = v_intent;
  delete from public.book_checkout_intents where id = v_intent;
end $$;

-- ============================================================
-- Part 6: create_book_checkout_intent's decision table
--
-- The heart of the repair. Given an existing quote and an attempt in
-- some state, which of the seven statuses comes back -- and, crucially,
-- when nothing is mutated at all.
-- ============================================================
do $$
declare
  v_first uuid;
  r record;
begin
  -- No attempt, same economics: the existing quote is reused, not
  -- re-minted. Price stability is the whole point of freezing it.
  select * into r from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                                        'b0000000-0000-0000-0000-000000000001');
  perform pg_temp.assert(r.quote_status = 'minted', 'part6: a first quote is minted');
  v_first := r.intent_id;

  select * into r from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                                        'b0000000-0000-0000-0000-000000000001');
  perform pg_temp.assert(r.quote_status = 'reused' and r.intent_id = v_first,
    'part6: an eligible quote with unchanged economics is reused');

  -- Changed economics with NO attempt: safe to supersede and re-mint,
  -- because nothing payable was ever created.
  select * into r from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                                        'b0000000-0000-0000-0000-000000000001', 'HALFOFF');
  perform pg_temp.assert(r.quote_status = 'minted' and r.intent_id <> v_first,
    'part6: a changed quote with no attempt supersedes and mints');
  perform pg_temp.assert(
    (select superseded_reason = 'quote_stale' from public.book_checkout_intents where id = v_first),
    'part6: the superseded quote must record quote_stale');

  delete from public.book_checkout_intents
    where reader_id = '22222222-2222-2222-2222-222222222222';
end $$;

do $$
declare
  v_intent uuid;
  r record;
begin
  -- Changed economics with a POSSIBLY LIVE attempt: the database refuses
  -- to decide. Only an authenticated POK retrieval may resolve it, and
  -- nothing is mutated here.
  select intent_id into v_intent
    from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                          'b0000000-0000-0000-0000-000000000001');
  perform pg_temp.claim(v_intent);
  update public.pok_book_checkout_orders
    set provider_order_id = 'ord_live', state = 'ready',
        checkout_url = 'https://pay-staging.pokpay.io/sdk-orders/ord_live'
    where intent_id = v_intent;

  select * into r from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                                        'b0000000-0000-0000-0000-000000000001', 'HALFOFF');
  perform pg_temp.assert(r.quote_status = 'conflict_attempt_unresolved',
    'part6: a changed quote over a live attempt must not be decided in SQL');
  perform pg_temp.assert(r.intent_id = v_intent,
    'part6: the conflict must name the intent the reader is actually held on');
  perform pg_temp.assert(r.price_cents_at_checkout = 99900,
    'part6: the conflict must report the FROZEN amount, not today''s');
  perform pg_temp.assert(
    (select superseded_at is null from public.book_checkout_intents where id = v_intent),
    'part6: an unresolved conflict must mutate nothing');
  perform pg_temp.assert(
    (select state from public.pok_book_checkout_orders where intent_id = v_intent) = 'ready',
    'part6: an unresolved conflict must leave the mapping untouched');

  -- LOCAL expiry is not PROVIDER expiry. An attempt with a recorded
  -- order id stays unresolved however old this intent is: only POK can
  -- say whether that order still takes money.
  update public.book_checkout_intents
    set created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'
    where id = v_intent;
  select * into r from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                                        'b0000000-0000-0000-0000-000000000001');
  perform pg_temp.assert(r.quote_status = 'blocked_expired_attempt_unresolved',
    'part6: a locally expired intent with a live attempt must still not be decided in SQL');
  perform pg_temp.assert(
    (select superseded_at is null from public.book_checkout_intents where id = v_intent),
    'part6: a blocked expired attempt must mutate nothing');

  delete from public.pok_book_checkout_orders where intent_id = v_intent;
  delete from public.book_checkout_intents where id = v_intent;
end $$;

do $$
declare
  v_intent uuid;
  r record;
begin
  -- The ID-LESS attempt whose locally requested window has elapsed: no
  -- checkout URL was ever disclosed, so nothing payable exists, and the
  -- window Librum itself asked for is sufficient evidence. Retire,
  -- supersede and mint, all in ONE transaction.
  select intent_id into v_intent
    from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                          'b0000000-0000-0000-0000-000000000001');
  perform pg_temp.claim(v_intent);
  update public.pok_book_checkout_orders
    set provider_window_ends_at = now() - interval '10 minutes' where intent_id = v_intent;

  select * into r from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                                        'b0000000-0000-0000-0000-000000000001');
  perform pg_temp.assert(r.quote_status = 'minted' and r.intent_id <> v_intent,
    'part6: an id-less elapsed attempt must be retired and replaced');
  perform pg_temp.assert(
    (select state = 'retired' and retired_reason = 'provider_window_elapsed_no_order_id'
       from public.pok_book_checkout_orders where intent_id = v_intent),
    'part6: the elapsed mapping must be retired with its own reason');
  perform pg_temp.assert(
    (select superseded_reason = 'provider_attempt_retired'
       from public.book_checkout_intents where id = v_intent),
    'part6: the superseded intent must record provider_attempt_retired');
  perform pg_temp.assert(
    (select count(*) from public.book_checkout_intents
      where reader_id = '22222222-2222-2222-2222-222222222222'
        and book_id = 'b0000000-0000-0000-0000-000000000001'
        and superseded_at is null) = 1,
    'part6: exactly one open intent may exist after a replacement');

  delete from public.pok_book_checkout_orders where intent_id = v_intent;
  delete from public.book_checkout_intents
    where reader_id = '22222222-2222-2222-2222-222222222222';
end $$;

do $$
declare
  v_intent uuid;
  r record;
begin
  -- An id-less attempt INSIDE its window is not evidence of anything:
  -- another request may be mid-creation right now.
  select intent_id into v_intent
    from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                          'b0000000-0000-0000-0000-000000000001');
  perform pg_temp.claim(v_intent);

  select * into r from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                                        'b0000000-0000-0000-0000-000000000001', 'HALFOFF');
  perform pg_temp.assert(r.quote_status = 'conflict_attempt_unresolved',
    'part6: an id-less attempt still inside its window must never be retired');
  perform pg_temp.assert(
    (select state from public.pok_book_checkout_orders where intent_id = v_intent) = 'creating',
    'part6: an in-window attempt must be left alone');

  delete from public.pok_book_checkout_orders where intent_id = v_intent;
  delete from public.book_checkout_intents where id = v_intent;
end $$;

do $$
declare
  v_intent uuid;
  r record;
begin
  -- A Stripe-bound quote is never superseded: its session may still be
  -- payable and this code can no longer reach Stripe to find out.
  select intent_id into v_intent
    from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                          'b0000000-0000-0000-0000-000000000001');
  update public.book_checkout_intents
    set stripe_checkout_session_id = 'cs_legacy' where id = v_intent;

  select * into r from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                                        'b0000000-0000-0000-0000-000000000001', 'HALFOFF');
  perform pg_temp.assert(r.quote_status = 'blocked_legacy_attempt',
    'part6: a Stripe-bound quote must block rather than be superseded');
  perform pg_temp.assert(
    (select superseded_at is null from public.book_checkout_intents where id = v_intent),
    'part6: a Stripe-bound quote must never be superseded');

  delete from public.book_checkout_intents where id = v_intent;
end $$;

-- ============================================================
-- Part 7: the deliberate accept path
--
-- The reader looked at a frozen amount and pressed Continue. This path
-- may resume THAT intent and nothing else -- it may never select
-- another, never supersede, and never auto-mint at a price the reader
-- has not seen.
-- ============================================================
do $$
declare
  v_intent uuid;
  v_other uuid;
  r record;
begin
  select intent_id into v_intent
    from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                          'b0000000-0000-0000-0000-000000000001');

  -- Accepting the exact intent resumes it, even with a code that would
  -- otherwise change the economics -- that is what "accept" means, and
  -- the amount returned is the FROZEN one.
  select * into r from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                                        'b0000000-0000-0000-0000-000000000001',
                                        'HALFOFF', true, v_intent);
  perform pg_temp.assert(r.quote_status = 'reused' and r.intent_id = v_intent,
    'part7: a deliberate accept resumes exactly the named intent');
  perform pg_temp.assert(r.price_cents_at_checkout = 99900,
    'part7: the resumed quote keeps its frozen amount, never today''s discounted one');

  -- A different id is never substituted.
  select intent_id into v_other
    from pg_temp.quote_as('33333333-3333-3333-3333-333333333333',
                          'b0000000-0000-0000-0000-000000000001');
  select * into r from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                                        'b0000000-0000-0000-0000-000000000001',
                                        null, true, v_other);
  perform pg_temp.assert(r.quote_status = 'expected_intent_changed',
    'part7: another reader''s intent must never be resumed');
  perform pg_temp.assert(
    (select superseded_at is null from public.book_checkout_intents where id = v_other),
    'part7: a refused accept must mutate nothing');

  -- Once the accepted quote has expired, the accept path reports the
  -- change rather than quietly minting a replacement at a new price.
  update public.book_checkout_intents
    set created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'
    where id = v_intent;
  select * into r from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                                        'b0000000-0000-0000-0000-000000000001',
                                        null, true, v_intent);
  perform pg_temp.assert(r.quote_status = 'expected_intent_changed',
    'part7: an expired accepted quote must never auto-mint a replacement');
  perform pg_temp.assert(
    (select count(*) from public.book_checkout_intents
      where reader_id = '22222222-2222-2222-2222-222222222222'
        and book_id = 'b0000000-0000-0000-0000-000000000001') = 1,
    'part7: the accept path must create no new intent');

  -- An unknown id is a change, never an invitation to pick something.
  select * into r from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                                        'b0000000-0000-0000-0000-000000000001',
                                        null, true, '00000000-0000-0000-0000-000000000000');
  perform pg_temp.assert(r.quote_status = 'expected_intent_changed',
    'part7: an unknown expected intent must not select anything');

  delete from public.book_checkout_intents
    where reader_id in ('22222222-2222-2222-2222-222222222222',
                        '33333333-3333-3333-3333-333333333333');
end $$;

-- ============================================================
-- Part 8: the supersession rate guard, and get_book_checkout_quote
-- ============================================================
do $$
declare
  v_last uuid;
  r record;
  i integer;
begin
  -- TEMPORARY DEFENCE ONLY -- a per-reader, per-book cap, not abuse
  -- prevention. What it bounds is the one new vector this function
  -- opens: alternating a discount code flips the economic comparison on
  -- every call, and each flip would otherwise supersede and mint.
  -- It must be a typed STATUS, never an exception: no caller should
  -- ever have to parse exception text.
  for i in 1..25 loop
    select * into r from pg_temp.quote_as(
      '22222222-2222-2222-2222-222222222222', 'b0000000-0000-0000-0000-000000000001',
      case when i % 2 = 0 then 'HALFOFF' else null end);
    exit when r.quote_status = 'supersession_rate_limited';
    v_last := r.intent_id;
  end loop;

  perform pg_temp.assert(r.quote_status = 'supersession_rate_limited',
    'part8: alternating economics must hit the supersession cap, not mint forever');
  perform pg_temp.assert(
    (select count(*) from public.book_checkout_intents
      where reader_id = '22222222-2222-2222-2222-222222222222'
        and book_id = 'b0000000-0000-0000-0000-000000000001'
        and superseded_at is not null) <= 20,
    'part8: the cap must bound supersessions at 20 per reader/book/hour');
  perform pg_temp.assert(
    (select superseded_at is null from public.book_checkout_intents where id = v_last),
    'part8: a rate-limited call must leave the last quote open, having mutated nothing');

  delete from public.book_checkout_intents
    where reader_id = '22222222-2222-2222-2222-222222222222';
end $$;

do $$
declare
  v_intent uuid;
  r record;
  n integer;
begin
  select intent_id into v_intent
    from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                          'b0000000-0000-0000-0000-000000000001');
  perform pg_temp.claim(v_intent);
  update public.pok_book_checkout_orders
    set provider_order_id = 'ord_q', state = 'ready',
        checkout_url = 'https://pay-staging.pokpay.io/sdk-orders/ord_q'
    where intent_id = v_intent;

  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  set local role authenticated;
  select * into r from public.get_book_checkout_quote(v_intent, 'b0000000-0000-0000-0000-000000000001');
  reset role;
  perform pg_temp.assert(r.quote_state = 'unresolved_conflict',
    'part8: a live attempt on an open intent reads as an unresolved conflict');
  perform pg_temp.assert(r.price_cents_at_checkout = 99900,
    'part8: the quote read must return the frozen amount');

  -- Foreign and mismatched reads return NO information at all -- not a
  -- different answer, not an error that distinguishes the two.
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  set local role authenticated;
  select count(*) into n from public.get_book_checkout_quote(
    v_intent, 'b0000000-0000-0000-0000-000000000001');
  reset role;
  perform pg_temp.assert(n = 0, 'part8: another reader''s quote must return zero rows');

  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  set local role authenticated;
  select count(*) into n from public.get_book_checkout_quote(
    v_intent, 'b0000000-0000-0000-0000-000000000002');
  reset role;
  perform pg_temp.assert(n = 0, 'part8: a mismatched book id must return zero rows');

  select count(*) into n from public.get_book_checkout_quote(
    '00000000-0000-0000-0000-000000000000', 'b0000000-0000-0000-0000-000000000001');
  perform pg_temp.assert(n = 0, 'part8: an unknown intent must return zero rows');

  -- Every terminal state reads as itself, so the page can decline to
  -- offer a resume without guessing.
  update public.pok_book_checkout_orders
    set state = 'retired', retired_at = now(), retired_reason = 'provider_attempt_expired'
    where intent_id = v_intent;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  set local role authenticated;
  select * into r from public.get_book_checkout_quote(v_intent, 'b0000000-0000-0000-0000-000000000001');
  reset role;
  perform pg_temp.assert(r.quote_state = 'not_conflicting',
    'part8: a retired attempt is no longer a conflict');

  update public.book_checkout_intents
    set superseded_at = now(), superseded_reason = 'provider_attempt_retired' where id = v_intent;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  set local role authenticated;
  select * into r from public.get_book_checkout_quote(v_intent, 'b0000000-0000-0000-0000-000000000001');
  reset role;
  perform pg_temp.assert(r.quote_state = 'superseded',
    'part8: a superseded intent reads as superseded');

  delete from public.pok_book_checkout_orders where intent_id = v_intent;
  delete from public.book_checkout_intents where id = v_intent;
end $$;

-- An anonymous caller gets nothing, by exception rather than by an
-- empty result -- there is no "everyone's quotes" answer to give.
--
-- The assertion is on the EXACT failure, not on "something went wrong".
-- A bare `when others then v_failed := true` passes for any exception at
-- all -- a typo in the function name, a missing column, a permission
-- error on some unrelated object -- so it would keep passing long after
-- the authentication check it is meant to police had been deleted.
-- Here the handler records the SQLSTATE and the message, and the test
-- demands both: SQLSTATE P0001 (raise_exception, what a bare
-- `raise exception 'not authenticated'` produces) and the message
-- exactly equal to 'not authenticated'. Any other exception fails.
do $$
declare
  v_state text := null;
  v_msg text := null;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  set local role authenticated;
  begin
    perform * from public.get_book_checkout_quote(
      '00000000-0000-0000-0000-000000000000', 'b0000000-0000-0000-0000-000000000001');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  reset role;
  perform pg_temp.assert(v_state is not null,
    'part8: an unauthenticated quote read must be refused, not answered');
  perform pg_temp.assert(v_state = 'P0001',
    'part8: the refusal must be raise_exception/P0001, got ' ||
    coalesce(v_state, '<none>') || ': ' || coalesce(v_msg, '<none>'));
  perform pg_temp.assert(v_msg = 'not authenticated',
    'part8: the refusal message must be exactly "not authenticated", got ' ||
    coalesce(v_msg, '<none>'));
end $$;

-- ============================================================
-- Part 9: privileges on every function this repair created
--
-- SECURITY DEFINER with an empty search_path, execute revoked from
-- PUBLIC/anon/authenticated, and granted only to the one role that is
-- meant to call it. A privileged function reachable by anon is the
-- whole attack surface of this design.
-- ============================================================
do $$
declare
  f text;
begin
  foreach f in array array[
    'create_book_checkout_intent', 'claim_pok_book_checkout_order',
    'retire_book_checkout_attempt', 'get_book_checkout_quote']
  loop
    perform pg_temp.assert(
      (select bool_and(p.prosecdef) from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = f),
      format('part9: %s must be SECURITY DEFINER', f));
    perform pg_temp.assert(
      -- Postgres stores the empty search_path quoted, as search_path="".
      (select bool_and(p.proconfig @> array['search_path=""']) from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = f),
      format('part9: %s must pin an empty search_path', f));
    perform pg_temp.assert(
      not has_function_privilege('anon', (
        select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = f limit 1), 'execute'),
      format('part9: anon must not execute %s', f));
  end loop;

  -- The two service-role functions must be closed to authenticated
  -- callers: they are the ones that can retire an attempt or bind a
  -- provider order.
  foreach f in array array['claim_pok_book_checkout_order', 'retire_book_checkout_attempt']
  loop
    perform pg_temp.assert(
      not has_function_privilege('authenticated', (
        select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = f limit 1), 'execute'),
      format('part9: authenticated must not execute %s', f));
    perform pg_temp.assert(
      has_function_privilege('service_role', (
        select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = f limit 1), 'execute'),
      format('part9: service_role must execute %s', f));
  end loop;

  -- And the reader-facing quote read must be callable BY the reader.
  perform pg_temp.assert(
    has_function_privilege('authenticated', (
      select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'get_book_checkout_quote' limit 1), 'execute'),
    'part9: authenticated must execute get_book_checkout_quote');

  -- The mapping table itself stays closed to readers: the quote RPC is
  -- the only window onto it, and it returns a curated shape.
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.pok_book_checkout_orders', 'select'),
    'part9: authenticated must not select pok_book_checkout_orders directly');
  perform pg_temp.assert(
    not has_table_privilege('anon', 'public.pok_book_checkout_orders', 'select'),
    'part9: anon must not select pok_book_checkout_orders directly');

  -- POK-FULFILMENT-1: the transition trigger function, absolutely.
  --
  -- Both build paths issue `revoke all ... from public, anon,
  -- authenticated` on this function, and the catalog-equivalence harness
  -- proves the two ACLs match each other -- which is a relative claim.
  -- These are the absolute ones. A function whose proacl is NULL carries
  -- PostgreSQL's DEFAULT, and the default for a function is EXECUTE to
  -- PUBLIC, so "no explicit grant" is not the same fact as "not
  -- executable" and is asserted separately from it.
  perform pg_temp.assert(
    (select p.proacl is not null from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = 'enforce_pok_book_checkout_orders_transition_rules'),
    'part9: the transition trigger function must carry an explicit ACL, never the PUBLIC default');
  perform pg_temp.assert(
    not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
        lateral aclexplode(p.proacl) a
       where n.nspname = 'public'
         and p.proname = 'enforce_pok_book_checkout_orders_transition_rules'
         and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
    'part9: no PUBLIC EXECUTE grant may exist on the transition trigger function');
  -- has_function_privilege resolves PUBLIC grants and role inheritance,
  -- so these two cover the indirect route as well as the direct one.
  foreach f in array array['anon', 'authenticated']
  loop
    perform pg_temp.assert(
      not has_function_privilege(f, (
        select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname = 'enforce_pok_book_checkout_orders_transition_rules' limit 1), 'execute'),
      format('part9: %s must not execute the transition trigger function, by any route', f));
  end loop;
end $$;

-- ============================================================
-- Part 10: POK-FULFILMENT-1 -- the database-owned first-seen marker.
--
-- These are the LOAD-BEARING assertions for this repair. The application
-- decides how long to keep asking POK about a completed order that is
-- missing one of four optional fields, and it computes that from two
-- database timestamps: fulfilment_gap_first_seen_at (stamped once) and
-- updated_at (stamped on every write). Every property the bound depends
-- on lives in the trigger below, not in the application, so a Vitest mock
-- asserting them would only be asserting what the mock was told to say.
--
-- What is deliberately NOT claimed here: this file runs on ONE
-- connection, so it cannot race two real backends for the first
-- observation. What it proves instead is the MECHANISM that makes that
-- race converge -- an UPDATE that does not name the column carries OLD
-- into NEW, so the preserving branch fires and the first writer's value
-- survives any number of later writes. The row lock that serialises the
-- two writers is Postgres' own, and this repair does not change it.
-- ============================================================

-- Put a claimed mapping into the 'ready' shape a live attempt has: an
-- order id and a checkout URL, which the table's own CHECK requires
-- before state may read 'ready'.
create function pg_temp.make_ready(p_intent uuid, p_order text) returns void
language sql as $$
  update public.pok_book_checkout_orders
     set provider_order_id = p_order,
         checkout_url = 'https://pay-staging.pokpay.io/sdk-orders/' || p_order,
         state = 'ready'
   where intent_id = p_intent;
$$;

-- EXACTLY the statement src/lib/pok-repository.ts issues, including its
-- compare-and-set and its RETURNING list. Tests below assert on the row
-- count, so a CAS that silently matches nothing cannot pass as a write.
create function pg_temp.observe(p_intent uuid, p_code text)
returns table (matched integer, first_seen timestamptz, observed_at timestamptz)
language plpgsql as $$
begin
  return query
  update public.pok_book_checkout_orders m
     set state = 'needs_reconciliation', last_error_code = p_code
   where m.intent_id = p_intent
     and m.provider_order_id is not null
     and m.state in ('ready', 'needs_reconciliation')
  returning 1, m.fulfilment_gap_first_seen_at, m.updated_at;
end;
$$;

create function pg_temp.first_seen(p_intent uuid) returns timestamptz language sql as $$
  select fulfilment_gap_first_seen_at from public.pok_book_checkout_orders where intent_id = p_intent;
$$;

do $$
declare
  v_intent uuid;
  v_first timestamptz;
  v_second timestamptz;
  v_rows integer;
  v_created timestamptz;
begin
  select intent_id into v_intent
    from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                          'b0000000-0000-0000-0000-000000000001');
  perform pg_temp.claim(v_intent);

  -- A fresh mapping has never observed a gap.
  perform pg_temp.assert(pg_temp.first_seen(v_intent) is null,
    'part10: a newly claimed mapping must carry no first-seen marker');

  -- ---- A 'creating' mapping: what each guard actually covers ----
  --
  -- Two independent guards, asserted separately because they fail for
  -- different reasons. First the application's own CAS, which excludes
  -- 'creating' precisely because the order id is recorded several
  -- statements BEFORE repo.ready() runs: flagging the row in that window
  -- would make ready() match zero rows and the reader would never receive
  -- a checkout URL at all.
  update public.pok_book_checkout_orders
     set provider_order_id = 'ord_p060_creating' where intent_id = v_intent;
  select count(*) into v_rows from pg_temp.observe(v_intent, 'fulfilment_gap_transaction_id_absent');
  perform pg_temp.assert(v_rows = 0,
    'part10: the application CAS must match ZERO rows against a creating mapping');
  perform pg_temp.assert(pg_temp.first_seen(v_intent) is null,
    'part10: a creating mapping must not acquire the marker through the CAS');

  -- Second the trigger itself, reached by a direct write that ignores the
  -- CAS entirely. The stamping branch requires the RESULTING state to be
  -- ready or needs_reconciliation, so the database refuses independently
  -- of what the application does.
  update public.pok_book_checkout_orders
     set last_error_code = 'fulfilment_gap_transaction_id_absent' where intent_id = v_intent;
  perform pg_temp.assert(pg_temp.first_seen(v_intent) is null,
    'part10: the trigger must not stamp a mapping whose resulting state is creating');

  -- The specified stamping condition is about the RESULTING row, not
  -- about which column the statement names, so a transition that carries
  -- a lingering gap code into an eligible state does stamp the marker.
  -- That is the rule as written, and it is asserted rather than left to
  -- be discovered: it is unreachable in production because the CAS never
  -- writes a gap code onto a creating row in the first place.
  perform pg_temp.make_ready(v_intent, 'ord_p060_creating');
  perform pg_temp.assert(pg_temp.first_seen(v_intent) is not null,
    'part10: a transition into an eligible state with a gap code present must stamp the marker');

  -- ---- The first eligible observation stamps it ----
  --
  -- Restart from a clean mapping, so what is measured below is the
  -- observation itself rather than the transition above.
  delete from public.pok_book_checkout_orders where intent_id = v_intent;
  delete from public.book_checkout_intents where id = v_intent;
  select intent_id into v_intent
    from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                          'b0000000-0000-0000-0000-000000000001');
  perform pg_temp.claim(v_intent);
  perform pg_temp.make_ready(v_intent, 'ord_p060_first');
  perform pg_temp.assert(pg_temp.first_seen(v_intent) is null,
    'part10: becoming ready with no error code must not create a marker');

  select count(*), min(first_seen) into v_rows, v_first
    from pg_temp.observe(v_intent, 'fulfilment_gap_transaction_id_absent');
  perform pg_temp.assert(v_rows = 1, 'part10: the CAS must match a ready mapping');
  perform pg_temp.assert(v_first is not null,
    'part10: the first eligible gap observation must stamp the marker in the SAME statement');
  -- Necessary but NOT sufficient: every statement in this file shares one
  -- transaction timestamp, so this equality also holds for an
  -- implementation that stamped the marker from the row's pre-existing
  -- updated_at. The dedicated block below separates the two.
  perform pg_temp.assert(v_first = now(),
    'part10: the marker must be stamped from the database transaction clock');

  select created_at into v_created from public.pok_book_checkout_orders where intent_id = v_intent;
  perform pg_temp.assert(v_first >= v_created,
    'part10: the marker must not predate the mapping');

  -- ---- A DIFFERENT gap code preserves it (A -> B) ----
  select min(first_seen) into v_second
    from pg_temp.observe(v_intent, 'fulfilment_gap_captured_amount_absent');
  perform pg_temp.assert(v_second = v_first,
    'part10: a second, different gap code must not move the marker');

  -- ---- A -> B -> A -> B alternation cannot extend the window ----
  --
  -- This is the case that killed updated_at as a first-seen marker: its
  -- stamp trigger is unconditional, so alternating codes reset it on
  -- every callback and the retry would never end.
  perform pg_temp.observe(v_intent, 'fulfilment_gap_transaction_id_absent');
  perform pg_temp.observe(v_intent, 'fulfilment_gap_captured_amount_absent');
  perform pg_temp.assert(pg_temp.first_seen(v_intent) = v_first,
    'part10: alternating gap codes must never move the marker');
  perform pg_temp.assert(
    (select last_error_code from public.pok_book_checkout_orders where intent_id = v_intent)
      = 'fulfilment_gap_captured_amount_absent',
    'part10: the LATEST observation must still be recorded -- the marker exists so that it can be');

  -- ---- An unrelated update preserves it ----
  update public.pok_book_checkout_orders
     set checkout_url = 'https://pay-staging.pokpay.io/sdk-orders/ord_p060_other'
   where intent_id = v_intent;
  perform pg_temp.assert(pg_temp.first_seen(v_intent) = v_first,
    'part10: an unrelated update must not move the marker');

  -- ---- Rewriting or clearing it RAISES, never silently coerces ----
  begin
    update public.pok_book_checkout_orders
       set fulfilment_gap_first_seen_at = now() + interval '1 hour' where intent_id = v_intent;
    perform pg_temp.not_rejected('part10: rewriting the marker must be rejected');
  exception when raise_exception then null;
  end;
  begin
    update public.pok_book_checkout_orders
       set fulfilment_gap_first_seen_at = null where intent_id = v_intent;
    perform pg_temp.not_rejected('part10: clearing the marker must be rejected');
  exception when raise_exception then null;
  end;
  perform pg_temp.assert(pg_temp.first_seen(v_intent) = v_first,
    'part10: a rejected write must leave the marker exactly as it was');

  -- ---- The named CHECK rejects a marker predating created_at ----
  --
  -- Reached by moving created_at forward rather than by writing the
  -- marker, because the trigger refuses the latter before any constraint
  -- is evaluated. Same invariant, and it is the direction a BACKWARD
  -- database-system clock adjustment would produce.
  begin
    update public.pok_book_checkout_orders
       set created_at = now() + interval '1 hour' where intent_id = v_intent;
    perform pg_temp.assert(false,
      'part10: a marker earlier than created_at must violate the named CHECK');
  exception when check_violation then null;
  end;

  delete from public.pok_book_checkout_orders where intent_id = v_intent;
  delete from public.book_checkout_intents where id = v_intent;
end $$;

-- ---- The marker is the DATABASE CLOCK, not the row's own updated_at ----
--
-- Why this needs its own fixture. The enforce trigger runs BEFORE
-- pok_book_checkout_orders_set_updated_at -- trigger order is
-- alphabetical and 'enforce' precedes 'set' -- so at the moment the
-- marker is stamped, new.updated_at still carries whatever the PREVIOUS
-- statement wrote. Inside this file's single transaction that value is
-- also now(), which means every assertion above passes unchanged for an
-- implementation that stamped the marker from new.updated_at instead of
-- pg_catalog.now(). The only shape that separates them is a mapping
-- whose last write happened BEFORE this transaction, built by inserting
-- the row directly with backdated timestamps: set_updated_at is a BEFORE
-- UPDATE trigger only, so an INSERT may supply updated_at and no UPDATE
-- ever can.
--
-- What the distinction costs if it is wrong. The application's retry
-- bound is (updated_at - fulfilment_gap_first_seen_at), both read from
-- the same returned row. A marker inherited from the pre-existing
-- updated_at would date the gap from the last unrelated write to the
-- mapping, so an attempt that had been sitting in 'ready' for an hour
-- would be born already past the window and its FIRST transient gap --
-- exactly the case this repair exists to retry -- would be reported
-- terminal on the spot.
do $$
declare
  v_intent uuid;
  v_first timestamptz;
  v_observed timestamptz;
  v_stale constant timestamptz := now() - interval '90 minutes';
begin
  select intent_id into v_intent
    from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                          'b0000000-0000-0000-0000-000000000001');
  -- Inserted rather than claimed: claim_pok_book_checkout_order
  -- necessarily writes now() into both timestamps. Every value here is a
  -- local fixture; none of it came from a provider.
  insert into public.pok_book_checkout_orders
    (intent_id, merchant_custom_reference, provider_order_id, checkout_url,
     creation_claim_id, state, created_at, updated_at)
  values (v_intent, 'book:' || v_intent::text, 'ord_p060_clock',
          'https://pay-staging.pokpay.io/sdk-orders/ord_p060_clock',
          gen_random_uuid(), 'ready',
          now() - interval '2 hours', v_stale);

  select min(first_seen), min(observed_at) into v_first, v_observed
    from pg_temp.observe(v_intent, 'fulfilment_gap_auto_capture_absent');

  perform pg_temp.assert(v_first is not null,
    'part10: an eligible observation on a backdated mapping must stamp the marker');
  perform pg_temp.assert(v_first = now(),
    'part10: the marker must be the database transaction clock');
  perform pg_temp.assert(v_first > v_stale,
    'part10: the marker must NOT be inherited from the row''s previous updated_at');
  -- The companion fact the elapsed computation rests on: the same
  -- statement refreshes updated_at, so a FIRST observation always
  -- measures an elapsed window of exactly zero, however old the row is.
  perform pg_temp.assert(v_observed = now(),
    'part10: the returned updated_at must be refreshed to the database clock');
  perform pg_temp.assert(v_observed = v_first,
    'part10: a first observation must measure a zero elapsed window');

  delete from public.pok_book_checkout_orders where intent_id = v_intent;
  delete from public.book_checkout_intents where id = v_intent;
end $$;

-- ---- A TERMINAL observation never creates the marker ----
--
-- The whole reason last_error_code carries two prefixes. Everything that
-- cannot be resolved by asking POK again is fulfilment_blocked_*, and the
-- trigger keys only on the literal fulfilment_gap_ prefix -- so "a
-- terminal observation never starts a retry clock" is readable from the
-- code vocabulary alone.
do $$
declare
  v_intent uuid;
  v_code text;
begin
  foreach v_code in array array[
    'fulfilment_blocked_refunded',
    'fulfilment_blocked_captured_amount_mismatch',
    'fulfilment_blocked_active_other_session',
    -- The rollback-era code: the ONLY last_error_code any release before
    -- this one writes. A database carrying this migration while the old
    -- application is still deployed must leave the marker null, which is
    -- what makes the migration-first deployment order safe.
    'creation_unconfirmed',
    -- Near misses for the LIKE pattern. `_` is escaped in the trigger, so
    -- it is a literal underscore rather than a single-character wildcard.
    'fulfilment5gap9transaction_id_absent',
    'fulfilment_gap',
    'gap_transaction_id_absent']
  loop
    select intent_id into v_intent
      from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                            'b0000000-0000-0000-0000-000000000001');
    perform pg_temp.claim(v_intent);
    perform pg_temp.make_ready(v_intent, 'ord_p060_' || md5(v_code));
    perform pg_temp.observe(v_intent, v_code);
    perform pg_temp.assert(pg_temp.first_seen(v_intent) is null,
      format('part10: last_error_code %L must not create the first-seen marker', v_code));
    delete from public.pok_book_checkout_orders where intent_id = v_intent;
    delete from public.book_checkout_intents where id = v_intent;
  end loop;
end $$;

-- ---- A RETIRED mapping, both guards ----
--
-- Stated precisely, because an earlier draft of this suite claimed
-- something false: the retirement-facts guard above does NOT fire on an
-- update that changes only last_error_code, so it is not what protects a
-- retired row here. Two other things are, and both are asserted.
do $$
declare
  v_intent uuid;
  v_rows integer;
begin
  select intent_id into v_intent
    from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                          'b0000000-0000-0000-0000-000000000001');
  perform pg_temp.claim(v_intent);
  perform pg_temp.make_ready(v_intent, 'ord_p060_retired');
  update public.pok_book_checkout_orders
     set state = 'retired', retired_at = now(), retired_reason = 'provider_attempt_expired'
   where intent_id = v_intent;

  -- 1. The application's CAS matches ZERO retired rows. This is the
  --    guarantee production actually runs on.
  select count(*) into v_rows
    from pg_temp.observe(v_intent, 'fulfilment_gap_transaction_id_absent');
  perform pg_temp.assert(v_rows = 0,
    'part10: the application CAS must match ZERO retired rows');
  perform pg_temp.assert(pg_temp.first_seen(v_intent) is null,
    'part10: no retired row may receive the marker through the application path');
  perform pg_temp.assert(
    (select state from public.pok_book_checkout_orders where intent_id = v_intent) = 'retired',
    'part10: the retired row must be left exactly as it was');

  -- 2. The trigger refuses independently, through the stamping branch's
  --    own state condition, even for a direct last_error_code-only write
  --    that never goes near the CAS.
  update public.pok_book_checkout_orders
     set last_error_code = 'fulfilment_gap_transaction_id_absent' where intent_id = v_intent;
  perform pg_temp.assert(pg_temp.first_seen(v_intent) is null,
    'part10: the trigger must not stamp a retired mapping even on a direct write');

  delete from public.pok_book_checkout_orders where intent_id = v_intent;
  delete from public.book_checkout_intents where id = v_intent;
end $$;

-- ---- INSERT may not supply the marker ----
do $$
declare
  v_intent uuid;
begin
  select intent_id into v_intent
    from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                          'b0000000-0000-0000-0000-000000000001');
  begin
    insert into public.pok_book_checkout_orders
      (intent_id, merchant_custom_reference, creation_claim_id, fulfilment_gap_first_seen_at)
    values (v_intent, 'book:' || v_intent::text, gen_random_uuid(), now());
    perform pg_temp.not_rejected('part10: an INSERT supplying the marker must be rejected');
  exception when raise_exception then null;
  end;
  perform pg_temp.assert(
    not exists (select 1 from public.pok_book_checkout_orders where intent_id = v_intent),
    'part10: the rejected INSERT must have created no row');

  -- An ordinary INSERT is unaffected, and stamps nothing: a brand-new
  -- mapping has by definition never observed a gap.
  perform pg_temp.claim(v_intent);
  perform pg_temp.assert(pg_temp.first_seen(v_intent) is null,
    'part10: an ordinary claim must insert with a null marker');

  delete from public.pok_book_checkout_orders where intent_id = v_intent;
  delete from public.book_checkout_intents where id = v_intent;
end $$;

-- ---- An explicitly supplied value is rejected even alongside a gap code ----
--
-- The branch ORDER is what this asserts. If the stamping branch ran
-- first, this statement would be accepted and its timestamp quietly
-- replaced -- indistinguishable, from the row afterwards, from a correct
-- write, and the author would never learn they wrote to a column they do
-- not own.
do $$
declare
  v_intent uuid;
begin
  select intent_id into v_intent
    from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                          'b0000000-0000-0000-0000-000000000001');
  perform pg_temp.claim(v_intent);
  perform pg_temp.make_ready(v_intent, 'ord_p060_supplied');

  begin
    update public.pok_book_checkout_orders
       set state = 'needs_reconciliation',
           last_error_code = 'fulfilment_gap_transaction_id_absent',
           fulfilment_gap_first_seen_at = now() - interval '1 second'
     where intent_id = v_intent;
    perform pg_temp.not_rejected(
      'part10: supplying the marker must be rejected even when the error code is a gap code');
  exception when raise_exception then null;
  end;
  perform pg_temp.assert(pg_temp.first_seen(v_intent) is null,
    'part10: the rejected write must have stamped nothing');

  delete from public.pok_book_checkout_orders where intent_id = v_intent;
  delete from public.book_checkout_intents where id = v_intent;
end $$;

-- ---- A flagged mapping never unlocks a replacement quote ----
--
-- The marker and the needs_reconciliation state are DIAGNOSTICS. They
-- must not become a route to minting a second payable order, and they
-- must not block a legitimate one either. Both directions, because a
-- one-sided assertion here would be satisfied by a system that simply
-- refuses everything.
do $$
declare
  v_intent uuid;
  v_status text;
  v_replacement uuid;
begin
  select intent_id into v_intent
    from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                          'b0000000-0000-0000-0000-000000000001');
  perform pg_temp.claim(v_intent);
  perform pg_temp.make_ready(v_intent, 'ord_p060_live');
  perform pg_temp.observe(v_intent, 'fulfilment_gap_transaction_id_absent');

  -- The attempt still has an order id and is not retired, so SQL still
  -- classifies it 'possibly_live'. A flag is not proof of death.
  select intent_id, quote_status into v_replacement, v_status
    from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                          'b0000000-0000-0000-0000-000000000001');
  perform pg_temp.assert(v_replacement = v_intent,
    'part10: a flagged but unretired attempt must return the SAME intent, never a replacement');
  perform pg_temp.assert(
    (select superseded_at from public.book_checkout_intents where id = v_intent) is null,
    'part10: a diagnostic flag must never supersede the intent');

  -- Once the payment has actually been fulfilled, the candidate loop
  -- skips the intent entirely on fulfilled_at -- the mapping's own state
  -- and marker are never consulted, and the retained diagnostic history
  -- changes nothing.
  update public.book_checkout_intents
     set completed_at = now(), fulfilled_at = now() where id = v_intent;
  perform pg_temp.assert(pg_temp.first_seen(v_intent) is not null,
    'part10: a later fulfilment must NOT erase the diagnostic history');

  select intent_id into v_replacement
    from pg_temp.quote_as('22222222-2222-2222-2222-222222222222',
                          'b0000000-0000-0000-0000-000000000001');
  perform pg_temp.assert(v_replacement is distinct from v_intent,
    'part10: a fulfilled intent must not be returned again as a live quote');
  perform pg_temp.assert(
    (select superseded_at from public.book_checkout_intents where id = v_intent) is null,
    'part10: a fulfilled intent must never be superseded by the minting path');

  delete from public.pok_book_checkout_orders where intent_id in (v_intent, v_replacement);
  delete from public.book_checkout_intents where id in (v_intent, v_replacement);
end $$;

do $$
begin
  raise notice 'PASS: 059_stale_checkout_attempt_repair.test.sql -- all assertions held';
end $$;

rollback;
