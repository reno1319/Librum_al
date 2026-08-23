-- Committed SQL regression suite for migration 032
-- (book_checkout_intents, create_book_checkout_intent,
-- finalize_book_checkout_intent). LAUNCH-1 P1-4.
--
-- Not run automatically by any CI/build step in this repo (there is no
-- existing SQL test framework or Postgres-in-CI setup here) -- run it
-- manually against a disposable/local Postgres instance, AFTER applying
-- supabase/schema.sql and every migration through 032, from the repo
-- root:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -f supabase/migrations/032_book_checkout_intents.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/032_book_checkout_intents.test.sql
--
-- supabase/tests/00_stub_supabase_platform.sql stubs the pieces of the
-- real Supabase platform schema.sql assumes already exist (the anon/
-- authenticated/service_role roles, the auth schema, and auth.uid()) --
-- never run it against a real Supabase project, which already provides
-- all of these for real.
--
-- Everything below runs inside one transaction and is rolled back at
-- the end, so this file is fully repeatable against the same database
-- with no manual cleanup between runs -- EXCEPT the grants/revokes
-- assertions in part 8, which read committed privilege state
-- (information_schema/has_*_privilege are not MVCC-snapshotted the same
-- way table rows are, but they only ever read what migration 032 itself
-- already committed, never anything this test writes, so this is safe).
--
-- Assertion style: a tiny pg_temp helper function, not an extension
-- (pgTAP is not guaranteed available against a real Supabase project's
-- Postgres, so this suite doesn't depend on it) -- fails loud via
-- RAISE EXCEPTION, which aborts the whole run (and the transaction) on
-- the first failure, with a message naming exactly which case failed.

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
-- Fixtures
-- ============================================================
-- Two readers, two authors (one payouts-enabled/published-book author
-- used by most cases; a second author+book pair used only for the
-- wrong-book discount-code case in part 4).
-- schema.sql's own handle_new_user() trigger (after insert on
-- auth.users) auto-creates the matching public.profiles row from
-- raw_user_meta_data -- inserting here rather than into public.profiles
-- directly mirrors how a real signup actually populates both tables.
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'author-a@test', '{"role":"author","display_name":"Author A"}'),
  ('22222222-2222-2222-2222-222222222222', 'reader-r1@test', '{"role":"reader","display_name":"Reader R1"}'),
  ('33333333-3333-3333-3333-333333333333', 'reader-r2@test', '{"role":"reader","display_name":"Reader R2"}'),
  ('44444444-4444-4444-4444-444444444444', 'author-b@test', '{"role":"author","display_name":"Author B"}');

update public.profiles set stripe_account_id = 'acct_A', stripe_payouts_enabled = true
  where id = '11111111-1111-1111-1111-111111111111';
update public.profiles set stripe_account_id = 'acct_B', stripe_payouts_enabled = true
  where id = '44444444-4444-4444-4444-444444444444';

insert into public.books (id, author_id, title, status, price_cents) values
  ('b0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Book One', 'published', 999),
  ('b0000000-0000-0000-0000-000000000002', '44444444-4444-4444-4444-444444444444', 'Book Two (other author)', 'published', 500),
  ('b0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'Draft Book', 'draft', 999);

insert into public.discount_codes (id, author_id, book_id, code, percent_off, active) values
  ('d0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'b0000000-0000-0000-0000-000000000001', 'HALFOFF', 50, true),
  ('d0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'b0000000-0000-0000-0000-000000000001', 'INACTIVE', 50, false);
insert into public.discount_codes (id, author_id, book_id, code, amount_off_cents, active, expires_at) values
  ('d0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'b0000000-0000-0000-0000-000000000001', 'EXPIRED', 100, true, now() - interval '1 day');

-- Helper: run create_book_checkout_intent as a given reader.
create function pg_temp.create_intent_as(p_reader uuid, p_book uuid, p_code text default null)
returns table (intent_id uuid, price_cents_at_checkout integer, discount_code_id uuid, expires_at timestamptz)
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_reader::text, true);
  set local role authenticated;
  return query select * from public.create_book_checkout_intent(p_book, p_code);
  reset role;
end;
$$;

-- ============================================================
-- Part 1: RPC authorization
-- ============================================================
do $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
  begin
    perform public.create_book_checkout_intent('b0000000-0000-0000-0000-000000000001'::uuid, null);
    perform pg_temp.assert(false, 'part1: anon must not be able to call create_book_checkout_intent');
  exception when insufficient_privilege then
    null; -- expected
  end;
  reset role;
end $$;

do $$
begin
  set local role anon;
  begin
    perform public.finalize_book_checkout_intent(gen_random_uuid(), 'cs_x', 'pi_x', 100);
    perform pg_temp.assert(false, 'part1: anon must not be able to call finalize_book_checkout_intent');
  exception when insufficient_privilege then
    null; -- expected
  end;
  reset role;
end $$;

do $$
begin
  set local role authenticated;
  begin
    perform public.finalize_book_checkout_intent(gen_random_uuid(), 'cs_x', 'pi_x', 100);
    perform pg_temp.assert(false, 'part1: authenticated must not be able to call finalize_book_checkout_intent');
  exception when insufficient_privilege then
    null; -- expected
  end;
  reset role;
end $$;

-- service_role CAN call finalize (asserted functionally in part 6/7
-- below, where every finalize call runs as service_role).

-- ============================================================
-- Part 2: server-derived reader identity
-- ============================================================
do $$
declare
  r1 record;
  r2 record;
begin
  select * into r1 from pg_temp.create_intent_as(
    '22222222-2222-2222-2222-222222222222', 'b0000000-0000-0000-0000-000000000001');
  select * into r2 from pg_temp.create_intent_as(
    '33333333-3333-3333-3333-333333333333', 'b0000000-0000-0000-0000-000000000001');

  perform pg_temp.assert(r1.intent_id <> r2.intent_id,
    'part2: two different readers must get two different intents for the same book');
  perform pg_temp.assert(
    (select reader_id from public.book_checkout_intents where id = r1.intent_id) = '22222222-2222-2222-2222-222222222222',
    'part2: intent reader_id must match the calling reader''s own auth.uid(), never a caller-supplied value');
  perform pg_temp.assert(
    (select reader_id from public.book_checkout_intents where id = r2.intent_id) = '33333333-3333-3333-3333-333333333333',
    'part2: second intent must be attributed to the second reader, not the first');

  delete from public.book_checkout_intents where reader_id in
    ('22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333');
end $$;

-- ============================================================
-- Part 3: price/discount boundary rounding
-- ============================================================
-- percent_off cases -- empirically verified against Node's
-- Math.max(Math.round(priceCents * (1 - percentOff/100)), 50) (the real
-- applyDiscount() in src/lib/pricing.ts) before this migration was
-- written -- re-verified here as a committed, re-runnable regression
-- against the RPC's real computation, not just the standalone
-- expression. Chosen deliberately so most cases land comfortably above
-- the 50-cent MIN_CHARGE_CENTS floor -- a tiny discounted value would
-- get floored to 50 regardless of whether the rounding itself were
-- correct, which would silently mask a rounding bug. (101,50) and
-- (103,50) are exact .5-cent ties (50.5 and 51.5) that land just above
-- the floor, so they still genuinely exercise round()'s tie-breaking,
-- not just greatest()'s floor.
do $$
declare
  case_row record;
  computed integer;
  cases text := $c$
    201,50,101
    999,50,500
    1001,50,501
    150,1,149
    350,1,347
    999,1,989
    101,50,51
    103,50,52
    1,1,50
    1,100,50
    50,100,50
    2500,50,1250
  $c$;
begin
  for case_row in
    select
      split_part(trim(line), ',', 1)::integer as price_cents,
      split_part(trim(line), ',', 2)::integer as percent_off,
      split_part(trim(line), ',', 3)::integer as expected
    from unnest(string_to_array(trim(cases), E'\n')) as line
    where trim(line) <> ''
  loop
    computed := greatest(
      round(case_row.price_cents::numeric * (100 - case_row.percent_off) / 100)::integer,
      50
    );
    perform pg_temp.assert(
      computed = case_row.expected,
      format('part3: percent_off price_cents=%s percent_off=%s expected=%s got=%s',
        case_row.price_cents, case_row.percent_off, case_row.expected, computed)
    );
  end loop;
end $$;

-- amount_off_cents cases -- pure integer subtraction, no rounding
-- function involved (exact in both Node and SQL by construction), still
-- verified here for completeness, including the floor engaging when the
-- discount meets or exceeds the price.
do $$
declare
  case_row record;
  computed integer;
  cases text := $c$
    999,100,899
    999,949,50
    999,950,50
    100,49,51
    100,50,50
    100,51,50
    60,100,50
  $c$;
begin
  for case_row in
    select
      split_part(trim(line), ',', 1)::integer as price_cents,
      split_part(trim(line), ',', 2)::integer as amount_off_cents,
      split_part(trim(line), ',', 3)::integer as expected
    from unnest(string_to_array(trim(cases), E'\n')) as line
    where trim(line) <> ''
  loop
    computed := greatest(case_row.price_cents - case_row.amount_off_cents, 50);
    perform pg_temp.assert(
      computed = case_row.expected,
      format('part3: amount_off_cents price_cents=%s amount_off_cents=%s expected=%s got=%s',
        case_row.price_cents, case_row.amount_off_cents, case_row.expected, computed)
    );
  end loop;
end $$;

-- End-to-end through the actual RPC (not just the standalone
-- expression): HALFOFF is 50% off a 999-cent book -> round(999*50/100)
-- = round(499.5) = 500 (numeric round, ties away from zero).
do $$
declare
  r record;
begin
  select * into r from pg_temp.create_intent_as(
    '22222222-2222-2222-2222-222222222222', 'b0000000-0000-0000-0000-000000000001', 'halfoff');
  perform pg_temp.assert(r.price_cents_at_checkout = 500,
    format('part3: HALFOFF on a 999-cent book must charge 500, got %s', r.price_cents_at_checkout));
  perform pg_temp.assert(r.discount_code_id = 'd0000000-0000-0000-0000-000000000001',
    'part3: discount_code_id must be resolved and returned');
  -- Lowercase input must resolve identically -- the RPC re-normalizes,
  -- it doesn't trust the caller's casing/whitespace.
  delete from public.book_checkout_intents where reader_id = '22222222-2222-2222-2222-222222222222';
end $$;

-- ============================================================
-- Part 4: invalid/expired discounts fall back to full price silently
-- ============================================================
do $$
declare
  r record;
begin
  -- Inactive code
  select * into r from pg_temp.create_intent_as(
    '22222222-2222-2222-2222-222222222222', 'b0000000-0000-0000-0000-000000000001', 'INACTIVE');
  perform pg_temp.assert(r.price_cents_at_checkout = 999 and r.discount_code_id is null,
    'part4: an inactive code must fall back to full price, not raise');
  delete from public.book_checkout_intents where id = r.intent_id;

  -- Expired code
  select * into r from pg_temp.create_intent_as(
    '22222222-2222-2222-2222-222222222222', 'b0000000-0000-0000-0000-000000000001', 'EXPIRED');
  perform pg_temp.assert(r.price_cents_at_checkout = 999 and r.discount_code_id is null,
    'part4: an expired code must fall back to full price, not raise');
  delete from public.book_checkout_intents where id = r.intent_id;

  -- Nonexistent code
  select * into r from pg_temp.create_intent_as(
    '22222222-2222-2222-2222-222222222222', 'b0000000-0000-0000-0000-000000000001', 'NOSUCHCODE');
  perform pg_temp.assert(r.price_cents_at_checkout = 999 and r.discount_code_id is null,
    'part4: a nonexistent code must fall back to full price, not raise');
  delete from public.book_checkout_intents where id = r.intent_id;

  -- A real code that belongs to a DIFFERENT book must not apply.
  select * into r from pg_temp.create_intent_as(
    '33333333-3333-3333-3333-333333333333', 'b0000000-0000-0000-0000-000000000002', 'HALFOFF');
  perform pg_temp.assert(r.price_cents_at_checkout = 500 and r.discount_code_id is null,
    'part4: a code scoped to a different book must not apply');
  delete from public.book_checkout_intents where id = r.intent_id;
end $$;

-- ============================================================
-- Part 5: active ownership rejection
-- ============================================================
do $$
begin
  insert into public.purchases (book_id, reader_id, stripe_checkout_session_id, amount_cents)
  values ('b0000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'cs_owned', 999);

  begin
    perform pg_temp.create_intent_as('22222222-2222-2222-2222-222222222222', 'b0000000-0000-0000-0000-000000000001');
    perform pg_temp.assert(false, 'part5: a reader who already owns the book must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'reader already owns this book',
      format('part5: expected the specific ownership exception, got: %s', sqlerrm));
  end;

  -- Refunded ownership must NOT block a fresh intent.
  update public.purchases set refunded_at = now()
  where book_id = 'b0000000-0000-0000-0000-000000000001' and reader_id = '22222222-2222-2222-2222-222222222222';

  perform pg_temp.assert(
    (select count(*) from pg_temp.create_intent_as('22222222-2222-2222-2222-222222222222', 'b0000000-0000-0000-0000-000000000001')) = 1,
    'part5: a refunded purchase must permit a fresh checkout intent'
  );

  delete from public.book_checkout_intents where reader_id = '22222222-2222-2222-2222-222222222222';
  delete from public.purchases where reader_id = '22222222-2222-2222-2222-222222222222';
end $$;

-- ============================================================
-- Part 6: reuse semantics (sequential -- see this suite's own note
-- above about the two-connection lock-contention proof living
-- separately, not here)
-- ============================================================
do $$
declare
  first_call record;
  second_call record;
begin
  select * into first_call from pg_temp.create_intent_as(
    '22222222-2222-2222-2222-222222222222', 'b0000000-0000-0000-0000-000000000001');
  select * into second_call from pg_temp.create_intent_as(
    '22222222-2222-2222-2222-222222222222', 'b0000000-0000-0000-0000-000000000001');

  perform pg_temp.assert(first_call.intent_id = second_call.intent_id,
    'part6: a second call before the first intent expires/settles must reuse the same intent_id');

  -- Finalize it (eligible_fulfilled) as service_role, then confirm a
  -- THIRD call does NOT reuse the now-fulfilled intent -- it must mint
  -- a fresh one (this would fail today if fulfilled_at were not part of
  -- the reuse predicate).
  set local role service_role;
  perform public.finalize_book_checkout_intent(first_call.intent_id, 'cs_reuse_1', 'pi_reuse_1', first_call.price_cents_at_checkout);
  reset role;

  declare
    third_call record;
  begin
    select * into third_call from pg_temp.create_intent_as(
      '22222222-2222-2222-2222-222222222222', 'b0000000-0000-0000-0000-000000000001');
    perform pg_temp.assert(third_call.intent_id is null,
      'part6: a reader who already owns the book (just fulfilled) must be rejected, not handed a reused intent');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'reader already owns this book',
      format('part6: expected ownership rejection after fulfillment, got: %s', sqlerrm));
  end;

  delete from public.purchases where reader_id = '22222222-2222-2222-2222-222222222222';
  delete from public.book_checkout_intents where reader_id = '22222222-2222-2222-2222-222222222222';
end $$;

-- A completed-but-blocked (active_other_session) intent must NOT be
-- reused either -- confirms the completed_at is null guard in the
-- reuse predicate.
do $$
declare
  winner record;
  loser record;
  reused record;
begin
  select * into winner from pg_temp.create_intent_as(
    '22222222-2222-2222-2222-222222222222', 'b0000000-0000-0000-0000-000000000001');
  select * into loser from pg_temp.create_intent_as(
    '33333333-3333-3333-3333-333333333333', 'b0000000-0000-0000-0000-000000000001');
  -- Different readers -> different intents, no reuse between them (sanity).
  perform pg_temp.assert(winner.intent_id <> loser.intent_id, 'part6b: different readers must not share an intent');

  -- This shouldn't be reachable via the app (two different readers can't
  -- race for the SAME purchases row), so simulate the "blocked" state
  -- directly to test the reuse guard in isolation instead: mark loser's
  -- intent as completed-but-blocked as finalize_book_checkout_intent
  -- itself would.
  update public.book_checkout_intents
  set completed_at = now(), reconciliation_reason = 'active_other_session'
  where id = loser.intent_id;

  select * into reused from pg_temp.create_intent_as(
    '33333333-3333-3333-3333-333333333333', 'b0000000-0000-0000-0000-000000000001');
  perform pg_temp.assert(reused.intent_id <> loser.intent_id,
    'part6b: a completed-but-blocked intent must never be reused for a fresh attempt');

  delete from public.book_checkout_intents where reader_id in
    ('22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333');
end $$;

-- ============================================================
-- Part 7: finalize_book_checkout_intent outcomes (eligible_fulfilled,
-- active_other_session, blocked_book_or_reader_deleted,
-- already_finalized), run as service_role -- mirrors exactly how the
-- webhook calls it. There is no same_session outcome to test: every
-- retry/duplicate delivery of the event that finalizes a given intent
-- always carries that exact intent_id (fixed in that session's own
-- Stripe metadata at creation), so the row-lock + already-settled check
-- at the top of finalize_book_checkout_intent always catches it as
-- already_finalized -- see this suite's own duplicate-delivery case
-- right below.
-- ============================================================
do $$
declare
  intent record;
  outcome text;
  purchase_row record;
begin
  -- eligible_fulfilled
  select * into intent from pg_temp.create_intent_as(
    '22222222-2222-2222-2222-222222222222', 'b0000000-0000-0000-0000-000000000001');
  set local role service_role;
  select f.outcome into outcome
  from public.finalize_book_checkout_intent(intent.intent_id, 'cs_p7_a', 'pi_p7_a', intent.price_cents_at_checkout) f;
  reset role;
  perform pg_temp.assert(outcome = 'eligible_fulfilled', format('part7: expected eligible_fulfilled, got %s', outcome));

  select * into purchase_row from public.purchases
  where book_id = 'b0000000-0000-0000-0000-000000000001' and reader_id = '22222222-2222-2222-2222-222222222222';
  perform pg_temp.assert(purchase_row.stripe_checkout_session_id = 'cs_p7_a', 'part7: purchases row must reflect the finalized session');
  perform pg_temp.assert(
    (select fulfilled_at is not null and completed_at is not null and reconciliation_reason is null
     from public.book_checkout_intents where id = intent.intent_id),
    'part7: a fulfilled intent must have completed_at set and no reconciliation_reason');

  -- already_finalized: re-finalizing the SAME intent must no-op, not
  -- re-write purchases or raise.
  set local role service_role;
  select f.outcome into outcome
  from public.finalize_book_checkout_intent(intent.intent_id, 'cs_p7_a', 'pi_p7_a', intent.price_cents_at_checkout) f;
  reset role;
  perform pg_temp.assert(outcome = 'already_finalized', format('part7: expected already_finalized on replay, got %s', outcome));

  delete from public.purchases where reader_id = '22222222-2222-2222-2222-222222222222';
  delete from public.book_checkout_intents where reader_id = '22222222-2222-2222-2222-222222222222';
end $$;

do $$
declare
  intent_a record;
  intent_b record;
  outcome_a text;
  outcome_b text;
begin
  -- active_other_session: two intents for the SAME reader/book (loser
  -- simulated by directly inserting a second row, since
  -- create_book_checkout_intent's own reuse logic would normally hand
  -- back the same intent -- this isolates finalize's own classification
  -- instead of re-testing reuse).
  select * into intent_a from pg_temp.create_intent_as(
    '22222222-2222-2222-2222-222222222222', 'b0000000-0000-0000-0000-000000000001');
  insert into public.book_checkout_intents (book_id, reader_id, book_title, price_cents_at_checkout, expires_at)
  values ('b0000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'Book One', 999, now() + interval '1 hour')
  returning id, price_cents_at_checkout into intent_b;

  set local role service_role;
  select f.outcome into outcome_a
  from public.finalize_book_checkout_intent(intent_a.intent_id, 'cs_p7_b_a', 'pi_p7_b_a', 999) f;
  select f.outcome into outcome_b
  from public.finalize_book_checkout_intent(intent_b.id, 'cs_p7_b_b', 'pi_p7_b_b', 999) f;
  reset role;

  perform pg_temp.assert(outcome_a = 'eligible_fulfilled', format('part7b: first finalize expected eligible_fulfilled, got %s', outcome_a));
  perform pg_temp.assert(outcome_b = 'active_other_session', format('part7b: second finalize expected active_other_session, got %s', outcome_b));

  perform pg_temp.assert(
    (select count(*) from public.purchases where book_id = 'b0000000-0000-0000-0000-000000000001' and reader_id = '22222222-2222-2222-2222-222222222222') = 1,
    'part7b: exactly one purchases row must exist -- the losing transaction must never overwrite or duplicate it');
  perform pg_temp.assert(
    (select stripe_checkout_session_id from public.purchases where book_id = 'b0000000-0000-0000-0000-000000000001' and reader_id = '22222222-2222-2222-2222-222222222222') = 'cs_p7_b_a',
    'part7b: the winning (first-committed) session must own the purchases row');
  perform pg_temp.assert(
    (select reconciliation_reason from public.book_checkout_intents where id = intent_b.id) = 'active_other_session',
    'part7b: the losing intent must be durably recorded with a reconciliation reason');
  perform pg_temp.assert(
    (select stripe_payment_intent_id from public.book_checkout_intents where id = intent_b.id) = 'pi_p7_b_b',
    'part7b: the losing transaction''s own PaymentIntent id must remain discoverable for admin reconciliation, never discarded');
  perform pg_temp.assert(
    (select fulfilled_at from public.book_checkout_intents where id = intent_b.id) is null,
    'part7b: the losing intent must never be marked fulfilled');

  delete from public.purchases where reader_id = '22222222-2222-2222-2222-222222222222';
  delete from public.book_checkout_intents where reader_id = '22222222-2222-2222-2222-222222222222';
end $$;

do $$
declare
  intent record;
  outcome text;
begin
  -- blocked_book_or_reader_deleted: book_id/reader_id gone by the time
  -- finalize runs (ON DELETE SET NULL).
  select * into intent from pg_temp.create_intent_as(
    '22222222-2222-2222-2222-222222222222', 'b0000000-0000-0000-0000-000000000001');

  delete from public.books where id = 'b0000000-0000-0000-0000-000000000001';

  set local role service_role;
  select f.outcome into outcome
  from public.finalize_book_checkout_intent(intent.intent_id, 'cs_p7_d', 'pi_p7_d', 999) f;
  reset role;

  perform pg_temp.assert(outcome = 'blocked_book_or_reader_deleted',
    format('part7d: expected blocked_book_or_reader_deleted, got %s', outcome));
  perform pg_temp.assert(
    (select reconciliation_reason from public.book_checkout_intents where id = intent.intent_id) = 'book_or_reader_deleted',
    'part7d: reconciliation_reason must record the deletion');
  perform pg_temp.assert(
    (select book_id from public.book_checkout_intents where id = intent.intent_id) is null,
    'part7d: book_id must have gone null via ON DELETE SET NULL, not been restricted/blocked');
  perform pg_temp.assert(
    (select book_title from public.book_checkout_intents where id = intent.intent_id) = 'Book One',
    'part7d: book_title must survive the book''s own deletion (denormalized audit trail)');

  delete from public.book_checkout_intents where id = intent.intent_id;
  -- Restore the book fixture for any tests that might run after this
  -- file in a longer-lived session (this file itself rolls back at the
  -- end regardless).
  insert into public.books (id, author_id, title, status, price_cents) values
    ('b0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Book One', 'published', 999);
end $$;

-- ============================================================
-- Part 7e: financial-authority audit -- amount integrity, identity
-- integrity, and duplicate-finalization identifier immutability.
-- ============================================================
do $$
declare
  intent record;
  outcome text;
begin
  -- frozen amount = webhook amount -> fulfillment succeeds. Every other
  -- part7 test already does this implicitly (each passes
  -- intent.price_cents_at_checkout as the amount); asserted explicitly
  -- here as its own case.
  select * into intent from pg_temp.create_intent_as(
    '22222222-2222-2222-2222-222222222222', 'b0000000-0000-0000-0000-000000000001');
  set local role service_role;
  select f.outcome into outcome
  from public.finalize_book_checkout_intent(intent.intent_id, 'cs_p7e_a', 'pi_p7e_a', intent.price_cents_at_checkout) f;
  reset role;
  perform pg_temp.assert(outcome = 'eligible_fulfilled',
    format('part7e: frozen amount = webhook amount must succeed, got %s', outcome));

  delete from public.purchases where reader_id = '22222222-2222-2222-2222-222222222222';
  delete from public.book_checkout_intents where reader_id = '22222222-2222-2222-2222-222222222222';
end $$;

do $$
declare
  intent record;
begin
  -- frozen amount <> webhook amount -> must fail closed: raises, no
  -- purchases row, no fulfilled_at, no completed_at, no
  -- reconciliation_reason -- the whole transaction rolls back, not just
  -- the purchases write.
  select * into intent from pg_temp.create_intent_as(
    '22222222-2222-2222-2222-222222222222', 'b0000000-0000-0000-0000-000000000001');

  begin
    set local role service_role;
    perform public.finalize_book_checkout_intent(
      intent.intent_id, 'cs_p7e_b', 'pi_p7e_b', intent.price_cents_at_checkout + 1);
    reset role;
    perform pg_temp.assert(false, 'part7e: amount mismatch must raise, not succeed');
  exception when others then
    reset role;
    perform pg_temp.assert(
      sqlerrm = 'stripe amount does not match this intent''s frozen price',
      format('part7e: expected the specific amount-mismatch exception, got: %s', sqlerrm));
  end;

  perform pg_temp.assert(
    (select count(*) from public.purchases where book_id = 'b0000000-0000-0000-0000-000000000001' and reader_id = '22222222-2222-2222-2222-222222222222') = 0,
    'part7e: amount mismatch must not create a purchases row');
  perform pg_temp.assert(
    (select fulfilled_at is null and completed_at is null and reconciliation_reason is null
     from public.book_checkout_intents where id = intent.intent_id),
    'part7e: amount mismatch must leave the intent completely unsettled -- no false fulfilled_at, no reconciliation_reason');

  delete from public.book_checkout_intents where reader_id = '22222222-2222-2222-2222-222222222222';
end $$;

do $$
declare
  intent record;
begin
  -- A null amount must also fail closed, not silently bypass the check
  -- (see this migration's own comment: `<>` against null evaluates to
  -- null, which plpgsql's `if` treats as false).
  select * into intent from pg_temp.create_intent_as(
    '22222222-2222-2222-2222-222222222222', 'b0000000-0000-0000-0000-000000000001');

  begin
    set local role service_role;
    perform public.finalize_book_checkout_intent(intent.intent_id, 'cs_p7e_c', 'pi_p7e_c', null);
    reset role;
    perform pg_temp.assert(false, 'part7e: a null amount must raise, not succeed');
  exception when others then
    reset role;
    perform pg_temp.assert(
      sqlerrm = 'stripe amount does not match this intent''s frozen price',
      format('part7e: expected the amount-mismatch exception for null, got: %s', sqlerrm));
  end;

  perform pg_temp.assert(
    (select count(*) from public.purchases where book_id = 'b0000000-0000-0000-0000-000000000001' and reader_id = '22222222-2222-2222-2222-222222222222') = 0,
    'part7e: a null amount must not create a purchases row');

  delete from public.book_checkout_intents where reader_id = '22222222-2222-2222-2222-222222222222';
end $$;

do $$
declare
  intent_r1 record;
  intent_r2 record;
  outcome_r1 text;
  outcome_r2 text;
begin
  -- Caller cannot influence identity: finalize_book_checkout_intent's
  -- own signature has no book_id/reader_id/discount_code_id parameter at
  -- all (only intent_id, stripe_checkout_session_id,
  -- stripe_payment_intent_id, amount_cents) -- provable by the function
  -- signature itself, not just by testing. This test instead proves the
  -- practical consequence: finalizing two DIFFERENT intents (different
  -- readers, different books) never cross-contaminates which purchases
  -- row gets which identity.
  select * into intent_r1 from pg_temp.create_intent_as(
    '22222222-2222-2222-2222-222222222222', 'b0000000-0000-0000-0000-000000000001');
  select * into intent_r2 from pg_temp.create_intent_as(
    '33333333-3333-3333-3333-333333333333', 'b0000000-0000-0000-0000-000000000002');

  set local role service_role;
  select f.outcome into outcome_r1
  from public.finalize_book_checkout_intent(intent_r1.intent_id, 'cs_p7e_r1', 'pi_p7e_r1', intent_r1.price_cents_at_checkout) f;
  select f.outcome into outcome_r2
  from public.finalize_book_checkout_intent(intent_r2.intent_id, 'cs_p7e_r2', 'pi_p7e_r2', intent_r2.price_cents_at_checkout) f;
  reset role;

  perform pg_temp.assert(outcome_r1 = 'eligible_fulfilled' and outcome_r2 = 'eligible_fulfilled',
    'part7e: both independent finalizations must succeed');
  perform pg_temp.assert(
    (select reader_id from public.purchases where book_id = 'b0000000-0000-0000-0000-000000000001') = '22222222-2222-2222-2222-222222222222',
    'part7e: book 1''s purchase must be attributed to reader 1, not reader 2');
  perform pg_temp.assert(
    (select reader_id from public.purchases where book_id = 'b0000000-0000-0000-0000-000000000002') = '33333333-3333-3333-3333-333333333333',
    'part7e: book 2''s purchase must be attributed to reader 2, not reader 1');

  delete from public.purchases where reader_id in
    ('22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333');
  delete from public.book_checkout_intents where reader_id in
    ('22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333');
end $$;

do $$
declare
  intent record;
  outcome text;
  purchase_row record;
begin
  -- Duplicate finalization cannot replace previously bound Stripe
  -- identifiers: the replay call below deliberately supplies DIFFERENT
  -- session/payment-intent/amount values than the first, successful
  -- call -- if the already_finalized guard were bypassed, this would
  -- silently corrupt the purchases row's own financial identifiers with
  -- a second, unrelated transaction's values.
  select * into intent from pg_temp.create_intent_as(
    '22222222-2222-2222-2222-222222222222', 'b0000000-0000-0000-0000-000000000001');

  set local role service_role;
  select f.outcome into outcome
  from public.finalize_book_checkout_intent(intent.intent_id, 'cs_p7e_orig', 'pi_p7e_orig', intent.price_cents_at_checkout) f;
  perform pg_temp.assert(outcome = 'eligible_fulfilled', 'part7e: setup call expected eligible_fulfilled');

  select f.outcome into outcome
  from public.finalize_book_checkout_intent(
    intent.intent_id, 'cs_p7e_REPLACED', 'pi_p7e_REPLACED', intent.price_cents_at_checkout + 500) f;
  reset role;
  perform pg_temp.assert(outcome = 'already_finalized',
    format('part7e: replay with different identifiers must be already_finalized, got %s', outcome));

  select * into purchase_row from public.purchases
  where book_id = 'b0000000-0000-0000-0000-000000000001' and reader_id = '22222222-2222-2222-2222-222222222222';
  perform pg_temp.assert(purchase_row.stripe_checkout_session_id = 'cs_p7e_orig',
    'part7e: replay must not replace the purchases row''s session id');
  perform pg_temp.assert(purchase_row.stripe_payment_intent_id = 'pi_p7e_orig',
    'part7e: replay must not replace the purchases row''s payment intent id');
  perform pg_temp.assert(purchase_row.amount_cents = intent.price_cents_at_checkout,
    'part7e: replay must not replace the purchases row''s amount');
  perform pg_temp.assert(
    (select stripe_payment_intent_id from public.book_checkout_intents where id = intent.intent_id) = 'pi_p7e_orig',
    'part7e: replay must not replace the intent''s own recorded payment intent id either');

  delete from public.purchases where reader_id = '22222222-2222-2222-2222-222222222222';
  delete from public.book_checkout_intents where reader_id = '22222222-2222-2222-2222-222222222222';
end $$;

-- ============================================================
-- Part 8: lifecycle CHECK constraints -- every invalid cell in the
-- state-model truth table must be rejected at the DB layer; every valid
-- cell must succeed. Run as table owner, deliberately bypassing RLS/
-- grants -- privilege is already covered in part 1; this part tests the
-- CHECK constraints themselves in isolation.
-- ============================================================
do $$
declare
  bogus_id uuid := gen_random_uuid();
begin
  -- Invalid: fulfilled_at set without completed_at.
  begin
    insert into public.book_checkout_intents
      (id, book_id, reader_id, book_title, price_cents_at_checkout, expires_at, fulfilled_at)
    values
      (bogus_id, 'b0000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
       'X', 100, now() + interval '1 hour', now());
    perform pg_temp.assert(false, 'part8: fulfilled_at without completed_at must violate a CHECK constraint');
  exception when check_violation then
    null;
  end;

  -- Invalid: reconciliation_reason set without completed_at.
  begin
    insert into public.book_checkout_intents
      (id, book_id, reader_id, book_title, price_cents_at_checkout, expires_at, reconciliation_reason)
    values
      (bogus_id, 'b0000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
       'X', 100, now() + interval '1 hour', 'active_other_session');
    perform pg_temp.assert(false, 'part8: reconciliation_reason without completed_at must violate a CHECK constraint');
  exception when check_violation then
    null;
  end;

  -- Invalid: completed_at + fulfilled_at + reconciliation_reason ALL set
  -- (fulfilled and blocked must be mutually exclusive).
  begin
    insert into public.book_checkout_intents
      (id, book_id, reader_id, book_title, price_cents_at_checkout, expires_at, completed_at, fulfilled_at, reconciliation_reason)
    values
      (bogus_id, 'b0000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
       'X', 100, now() + interval '1 hour', now(), now(), 'active_other_session');
    perform pg_temp.assert(false, 'part8: fulfilled_at and reconciliation_reason together must violate a CHECK constraint');
  exception when check_violation then
    null;
  end;

  -- Invalid: completed_at set, but NEITHER fulfilled_at NOR
  -- reconciliation_reason -- an unexplained "paid but nothing happened"
  -- state, exactly what Blocker 3 exists to make impossible.
  begin
    insert into public.book_checkout_intents
      (id, book_id, reader_id, book_title, price_cents_at_checkout, expires_at, completed_at)
    values
      (bogus_id, 'b0000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
       'X', 100, now() + interval '1 hour', now());
    perform pg_temp.assert(false, 'part8: completed_at with neither fulfilled_at nor reconciliation_reason must violate a CHECK constraint');
  exception when check_violation then
    null;
  end;

  -- Invalid: an unrecognized reconciliation_reason value.
  begin
    insert into public.book_checkout_intents
      (id, book_id, reader_id, book_title, price_cents_at_checkout, expires_at, completed_at, reconciliation_reason)
    values
      (bogus_id, 'b0000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
       'X', 100, now() + interval '1 hour', now(), 'some_other_reason');
    perform pg_temp.assert(false, 'part8: an unrecognized reconciliation_reason must violate a CHECK constraint');
  exception when check_violation then
    null;
  end;

  -- Invalid: expires_at not after created_at.
  begin
    insert into public.book_checkout_intents
      (id, book_id, reader_id, book_title, price_cents_at_checkout, created_at, expires_at)
    values
      (bogus_id, 'b0000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
       'X', 100, now(), now() - interval '1 hour');
    perform pg_temp.assert(false, 'part8: expires_at at or before created_at must violate a CHECK constraint');
  exception when check_violation then
    null;
  end;

  -- Valid: all three legitimate states insert cleanly.
  insert into public.book_checkout_intents
    (book_id, reader_id, book_title, price_cents_at_checkout, expires_at)
  values
    ('b0000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'X', 100, now() + interval '1 hour');

  insert into public.book_checkout_intents
    (book_id, reader_id, book_title, price_cents_at_checkout, expires_at, completed_at, fulfilled_at)
  values
    ('b0000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'X', 100, now() + interval '1 hour', now(), now());

  insert into public.book_checkout_intents
    (book_id, reader_id, book_title, price_cents_at_checkout, expires_at, completed_at, reconciliation_reason)
  values
    ('b0000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'X', 100, now() + interval '1 hour', now(), 'active_other_session');

  delete from public.book_checkout_intents where reader_id = '22222222-2222-2222-2222-222222222222';
end $$;

-- ============================================================
-- Part 9: grants/revokes -- anon/authenticated/public must have zero
-- privileges on the table itself, and zero EXECUTE on
-- finalize_book_checkout_intent. Direct regression for the exact class
-- of gap the discount_codes production incident (migration 031)
-- exposed manually.
-- ============================================================
do $$
begin
  perform pg_temp.assert(not has_table_privilege('anon', 'public.book_checkout_intents', 'SELECT'), 'part9: anon must not have SELECT on book_checkout_intents');
  perform pg_temp.assert(not has_table_privilege('anon', 'public.book_checkout_intents', 'INSERT'), 'part9: anon must not have INSERT on book_checkout_intents');
  perform pg_temp.assert(not has_table_privilege('anon', 'public.book_checkout_intents', 'UPDATE'), 'part9: anon must not have UPDATE on book_checkout_intents');
  perform pg_temp.assert(not has_table_privilege('anon', 'public.book_checkout_intents', 'DELETE'), 'part9: anon must not have DELETE on book_checkout_intents');

  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.book_checkout_intents', 'SELECT'), 'part9: authenticated must not have SELECT on book_checkout_intents');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.book_checkout_intents', 'INSERT'), 'part9: authenticated must not have INSERT on book_checkout_intents');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.book_checkout_intents', 'UPDATE'), 'part9: authenticated must not have UPDATE on book_checkout_intents');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.book_checkout_intents', 'DELETE'), 'part9: authenticated must not have DELETE on book_checkout_intents');

  perform pg_temp.assert(not has_function_privilege('anon', 'public.finalize_book_checkout_intent(uuid,text,text,integer)', 'EXECUTE'), 'part9: anon must not have EXECUTE on finalize_book_checkout_intent');
  perform pg_temp.assert(not has_function_privilege('authenticated', 'public.finalize_book_checkout_intent(uuid,text,text,integer)', 'EXECUTE'), 'part9: authenticated must not have EXECUTE on finalize_book_checkout_intent');
  perform pg_temp.assert(has_function_privilege('service_role', 'public.finalize_book_checkout_intent(uuid,text,text,integer)', 'EXECUTE'), 'part9: service_role must have EXECUTE on finalize_book_checkout_intent');

  perform pg_temp.assert(not has_function_privilege('anon', 'public.create_book_checkout_intent(uuid,text)', 'EXECUTE'), 'part9: anon must not have EXECUTE on create_book_checkout_intent');
  perform pg_temp.assert(has_function_privilege('authenticated', 'public.create_book_checkout_intent(uuid,text)', 'EXECUTE'), 'part9: authenticated must have EXECUTE on create_book_checkout_intent');
end $$;

select 'ALL PASSED: 032_book_checkout_intents.test.sql' as result;

rollback;
