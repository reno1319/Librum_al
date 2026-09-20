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

insert into public.books (id, author_id, title, status, price_cents) values
  ('b0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Book One', 'published', 999),
  ('b0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Book Two', 'published', 500);

insert into public.discount_codes (id, author_id, book_id, code, percent_off, active) values
  ('d0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'b0000000-0000-0000-0000-000000000001', 'HALFOFF', 50, true);

-- Mint a ledger_v1/ALL quote as a given reader -- the only regime a POK
-- attempt may ever be claimed for.
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
    p_book, p_code, 'librum_ledger_v1', 'ALL', 7000, p_accept, p_expected);
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
  declare v_legacy uuid;
  begin
    perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
    set local role authenticated;
    select i.intent_id into v_legacy from public.create_book_checkout_intent(
      'b0000000-0000-0000-0000-000000000002', null, 'legacy_stripe_connect_v1', 'USD', null) i;
    reset role;
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
  perform pg_temp.assert(r.price_cents_at_checkout = 999,
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
  perform pg_temp.assert(r.price_cents_at_checkout = 999,
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
  perform pg_temp.assert(r.price_cents_at_checkout = 999,
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
end $$;

do $$
begin
  raise notice 'PASS: 059_stale_checkout_attempt_repair.test.sql -- all assertions held';
end $$;

rollback;
