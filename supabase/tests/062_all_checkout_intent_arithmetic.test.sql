-- Committed SQL regression suite for migration
-- 20260922113721_all_checkout_intent_arithmetic (ALL-CHECKOUT-1): the
-- four-argument create_book_checkout_intent, its whole-lek pricing, its
-- exact discount arithmetic, and the typed rejections that replaced the
-- discount clamp.
--
-- Not run by CI. Run it manually against a disposable local Postgres 17
-- built either from supabase/schema.sql or from the base schema plus
-- this migration -- BOTH, ideally, since the whole point of the
-- companion 062_all_checkout_intent_catalog_equivalence.sh is that the
-- two build paths must be indistinguishable:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/062_all_checkout_intent_arithmetic.test.sql
--
-- WHAT THIS SUITE IS FOR, stated plainly. This function is unreachable
-- through the product: paid checkout is closed, and buyBook returns at
-- canStartPaidCheckout() before the RPC is called. Nothing in CI runs
-- any file in supabase/tests. So this file is the only verification
-- this change has, and it is written accordingly -- every rejection is
-- checked for its EFFECT on the database as well as its return value,
-- because "returned the right word and also superseded an intent" is
-- the failure that would otherwise pass.
--
-- Everything runs in one transaction and rolls back.

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
-- One author, three readers, and a book per price shape. price_cents is
-- given a deliberately MISLEADING legacy value on every priced book:
-- if the function ever read it again, these tests would report the
-- wrong amount rather than silently agreeing with price_all.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a0620000-0000-0000-0000-000000000001', 'p062-author@test', now(), '{"role":"author","display_name":"P062 Author"}'),
  ('a0620000-0000-0000-0000-000000000002', 'p062-reader-1@test', now(), '{"role":"reader","display_name":"P062 Reader One"}'),
  ('a0620000-0000-0000-0000-000000000003', 'p062-reader-2@test', now(), '{"role":"reader","display_name":"P062 Reader Two"}'),
  ('a0620000-0000-0000-0000-000000000004', 'p062-reader-3@test', now(), '{"role":"reader","display_name":"P062 Reader Three"}');

insert into public.books (id, author_id, title, status, price_cents, price_all) values
  -- NULL price_all: priced in the legacy column only. Not purchasable.
  ('b0620000-0000-0000-0000-000000000001', 'a0620000-0000-0000-0000-000000000001', 'P062 Legacy-Priced Book', 'published', 1299, null),
  -- Explicitly free.
  ('b0620000-0000-0000-0000-000000000002', 'a0620000-0000-0000-0000-000000000001', 'P062 Free Book', 'published', 0, 0),
  -- The minimum paid price.
  ('b0620000-0000-0000-0000-000000000003', 'a0620000-0000-0000-0000-000000000001', 'P062 Minimum Book', 'published', 4242, 99),
  -- The maximum permitted price.
  ('b0620000-0000-0000-0000-000000000004', 'a0620000-0000-0000-0000-000000000001', 'P062 Maximum Book', 'published', 4242, 100000),
  -- The discount workhorse.
  ('b0620000-0000-0000-0000-000000000005', 'a0620000-0000-0000-0000-000000000001', 'P062 Discount Book', 'published', 4242, 199),
  -- Exercises the inclusive floor: 100 lek less 1 lek is exactly 9900.
  ('b0620000-0000-0000-0000-000000000006', 'a0620000-0000-0000-0000-000000000001', 'P062 Floor Book', 'published', 4242, 100),
  -- Not published.
  ('b0620000-0000-0000-0000-000000000007', 'a0620000-0000-0000-0000-000000000001', 'P062 Draft Book', 'draft', 4242, 199),
  -- Ledger-conservation books: one reader each, one amount each.
  ('b0620000-0000-0000-0000-000000000008', 'a0620000-0000-0000-0000-000000000001', 'P062 Conservation 199', 'published', 4242, 199),
  ('b0620000-0000-0000-0000-000000000009', 'a0620000-0000-0000-0000-000000000001', 'P062 Conservation 199 B', 'published', 4242, 199);

insert into public.discount_codes (id, author_id, book_id, code, percent_off, active) values
  ('c0620000-0000-0000-0000-000000000001', 'a0620000-0000-0000-0000-000000000001', 'b0620000-0000-0000-0000-000000000005', 'PCT10', 10, true),
  ('c0620000-0000-0000-0000-000000000002', 'a0620000-0000-0000-0000-000000000001', 'b0620000-0000-0000-0000-000000000005', 'PCT100', 100, true),
  ('c0620000-0000-0000-0000-000000000003', 'a0620000-0000-0000-0000-000000000001', 'b0620000-0000-0000-0000-000000000003', 'MINPCT10', 10, true),
  ('c0620000-0000-0000-0000-000000000004', 'a0620000-0000-0000-0000-000000000001', 'b0620000-0000-0000-0000-000000000005', 'INACTIVE10', 10, false),
  ('c0620000-0000-0000-0000-000000000009', 'a0620000-0000-0000-0000-000000000001', 'b0620000-0000-0000-0000-000000000008', 'CONS7', 7, true),
  ('c062000a-0000-0000-0000-000000000001', 'a0620000-0000-0000-0000-000000000001', 'b0620000-0000-0000-0000-000000000009', 'CONS10', 10, true);

insert into public.discount_codes (id, author_id, book_id, code, percent_off, active, expires_at) values
  ('c0620000-0000-0000-0000-000000000005', 'a0620000-0000-0000-0000-000000000001', 'b0620000-0000-0000-0000-000000000005', 'EXPIRED10', 10, true, now() - interval '1 day');

insert into public.discount_codes (id, author_id, book_id, code, amount_off_all, active) values
  ('c0620000-0000-0000-0000-000000000006', 'a0620000-0000-0000-0000-000000000001', 'b0620000-0000-0000-0000-000000000005', 'OFF20ALL', 20, true),
  ('c0620000-0000-0000-0000-000000000007', 'a0620000-0000-0000-0000-000000000001', 'b0620000-0000-0000-0000-000000000005', 'OFF199ALL', 199, true),
  ('c0620000-0000-0000-0000-000000000008', 'a0620000-0000-0000-0000-000000000001', 'b0620000-0000-0000-0000-000000000005', 'OFF200ALL', 200, true),
  ('c062000b-0000-0000-0000-000000000001', 'a0620000-0000-0000-0000-000000000001', 'b0620000-0000-0000-0000-000000000006', 'OFF1ALL', 1, true);

-- A legacy USD discount code. It is STILL a legal row -- the catalog
-- constraint admits exactly one of the three discount types -- and the
-- point of T12 is that a legal, active, correctly-scoped legacy code is
-- refused rather than applied or ignored.
insert into public.discount_codes (id, author_id, book_id, code, amount_off_cents, active) values
  ('c062000c-0000-0000-0000-000000000001', 'a0620000-0000-0000-0000-000000000001', 'b0620000-0000-0000-0000-000000000005', 'CENTS500', 500, true);

create function pg_temp.quote(
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

-- A fingerprint of everything a rejection is forbidden to touch. Taken
-- before and after each rejecting call and compared whole, so a
-- rejection that supersedes, mints or retires something is caught even
-- if no individual assertion below happens to look at that row.
create function pg_temp.mutation_fingerprint() returns text
language sql as $$
  select coalesce(string_agg(x, '|' order by x), '<empty>') from (
    select 'intent:' || i.id::text || ':' || i.price_cents_at_checkout::text || ':' ||
           coalesce(i.superseded_reason, '-') || ':' ||
           coalesce(i.completed_at::text, '-') || ':' ||
           coalesce(i.fulfilled_at::text, '-') || ':' ||
           coalesce(i.discount_code_id::text, '-') as x
      from public.book_checkout_intents i
    union all
    select 'map:' || m.intent_id::text || ':' || m.state || ':' ||
           coalesce(m.retired_reason, '-')
      from public.pok_book_checkout_orders m
    union all
    select 'purchase:' || p.id::text || ':' || p.amount_cents::text
      from public.purchases p
    union all
    select 'count:intents:' || (select count(*) from public.book_checkout_intents)::text
    union all
    select 'count:maps:' || (select count(*) from public.pok_book_checkout_orders)::text
  ) s;
$$;

-- ============================================================
-- T1 / T2: a book with no ALL price, and a free book, are both
-- unavailable -- and refused identically, so the RPC discloses nothing
-- about which it is.
-- ============================================================
do $$
declare
  v_before text;
  v_msg_null text;
  v_msg_zero text;
begin
  v_before := pg_temp.mutation_fingerprint();

  begin
    perform pg_temp.quote('a0620000-0000-0000-0000-000000000002', 'b0620000-0000-0000-0000-000000000001');
    perform pg_temp.assert(false, 'T1: a null price_all book must not mint an intent');
  exception when others then
    v_msg_null := sqlerrm;
  end;
  perform pg_temp.assert(v_msg_null = 'book not available for purchase',
    format('T1: expected the generic unavailable message, got: %s', v_msg_null));

  begin
    perform pg_temp.quote('a0620000-0000-0000-0000-000000000002', 'b0620000-0000-0000-0000-000000000002');
    perform pg_temp.assert(false, 'T2: a price_all = 0 book must not mint an intent');
  exception when others then
    v_msg_zero := sqlerrm;
  end;
  perform pg_temp.assert(v_msg_zero = 'book not available for purchase',
    format('T2: expected the generic unavailable message, got: %s', v_msg_zero));

  -- One message for both, and for the draft book too: a per-cause
  -- message would turn this RPC into an enumeration oracle.
  begin
    perform pg_temp.quote('a0620000-0000-0000-0000-000000000002', 'b0620000-0000-0000-0000-000000000007');
    perform pg_temp.assert(false, 'T1/T2: a draft book must not mint an intent');
  exception when others then
    perform pg_temp.assert(sqlerrm = v_msg_null,
      'T1/T2: an unpublished book must be refused with the SAME message as an unpriced one');
  end;

  -- The author's own book, likewise.
  begin
    perform pg_temp.quote('a0620000-0000-0000-0000-000000000001', 'b0620000-0000-0000-0000-000000000005');
    perform pg_temp.assert(false, 'T1/T2: an author must not be able to buy their own book');
  exception when others then
    perform pg_temp.assert(sqlerrm = v_msg_null,
      'T1/T2: the author''s own book must be refused with the SAME message');
  end;

  perform pg_temp.assert((select count(*) from public.book_checkout_intents) = 0,
    'T1/T2: no intent row may exist after four refusals');
  perform pg_temp.assert(pg_temp.mutation_fingerprint() = v_before,
    'T1/T2: a refusal must leave the database byte-identical');
end $$;

-- ============================================================
-- T3: the minimum price, and the three facts the caller no longer
-- chooses.
-- ============================================================
do $$
declare
  r record;
  i record;
begin
  select * into r from pg_temp.quote(
    'a0620000-0000-0000-0000-000000000002', 'b0620000-0000-0000-0000-000000000003');
  perform pg_temp.assert(r.quote_status = 'minted', format('T3: expected minted, got %s', r.quote_status));
  perform pg_temp.assert(r.price_cents_at_checkout = 9900,
    format('T3: 99 lek must freeze exactly 9900 minor units, got %s', r.price_cents_at_checkout));
  perform pg_temp.assert(r.discount_code_id is null, 'T3: no code was supplied, so none may be recorded');

  select * into i from public.book_checkout_intents where id = r.intent_id;
  perform pg_temp.assert(i.regime = 'librum_ledger_v1',
    format('T3: regime must be librum_ledger_v1, got %s', i.regime));
  perform pg_temp.assert(i.currency = 'ALL', format('T3: currency must be ALL, got %s', i.currency));
  -- The royalty assertion that pins the constant. Its Vitest twin is
  -- src/lib/pricing.test.ts's "equals 8000 bps (80%) at the current 20%
  -- platform fee"; the two name the same literal from opposite sides,
  -- so a change to either without the other turns one of them red.
  perform pg_temp.assert(i.royalty_rate_bps = 8000,
    format('T3: every minted intent must freeze royalty_rate_bps = 8000, got %s', i.royalty_rate_bps));
  perform pg_temp.assert(i.reader_id = 'a0620000-0000-0000-0000-000000000002',
    'T3: the intent must belong to auth.uid(), never to a caller-supplied id');

  delete from public.book_checkout_intents where id = r.intent_id;
end $$;

-- ============================================================
-- T4: the maximum permitted price converts without overflow.
--
-- 100000 lek is 10,000,000 minor units. price_cents_at_checkout is an
-- `integer`, so this is the value that would break first if the column
-- or the arithmetic were ever narrowed.
-- ============================================================
do $$
declare
  r record;
begin
  select * into r from pg_temp.quote(
    'a0620000-0000-0000-0000-000000000002', 'b0620000-0000-0000-0000-000000000004');
  perform pg_temp.assert(r.quote_status = 'minted' and r.price_cents_at_checkout = 10000000,
    format('T4: 100000 lek must freeze 10000000 minor units, got %s / %s', r.quote_status, r.price_cents_at_checkout));
  delete from public.book_checkout_intents where id = r.intent_id;
end $$;

-- ============================================================
-- T5 / T7 / T11: discounts that are accepted, and are exact.
-- ============================================================
do $$
declare
  r record;
begin
  -- 199 lek less 10% -> 199 * 90 = 17910. No rounding participates.
  select * into r from pg_temp.quote(
    'a0620000-0000-0000-0000-000000000002', 'b0620000-0000-0000-0000-000000000005', 'PCT10');
  perform pg_temp.assert(r.quote_status = 'minted' and r.price_cents_at_checkout = 17910,
    format('T5: 199 lek -10%% must be 17910, got %s / %s', r.quote_status, r.price_cents_at_checkout));
  perform pg_temp.assert(r.discount_code_id = 'c0620000-0000-0000-0000-000000000001',
    'T5: the applied code must be recorded on the intent');
  delete from public.book_checkout_intents where id = r.intent_id;

  -- 199 lek less 20 lek -> 179 lek -> 17900.
  select * into r from pg_temp.quote(
    'a0620000-0000-0000-0000-000000000002', 'b0620000-0000-0000-0000-000000000005', 'OFF20ALL');
  perform pg_temp.assert(r.quote_status = 'minted' and r.price_cents_at_checkout = 17900,
    format('T7: 199 lek less 20 lek must be 17900, got %s / %s', r.quote_status, r.price_cents_at_checkout));
  delete from public.book_checkout_intents where id = r.intent_id;

  -- The floor is INCLUSIVE: exactly 9900 is accepted, not rejected.
  select * into r from pg_temp.quote(
    'a0620000-0000-0000-0000-000000000002', 'b0620000-0000-0000-0000-000000000006', 'OFF1ALL');
  perform pg_temp.assert(r.quote_status = 'minted' and r.price_cents_at_checkout = 9900,
    format('T11: a result of exactly 9900 must be accepted, got %s / %s', r.quote_status, r.price_cents_at_checkout));
  delete from public.book_checkout_intents where id = r.intent_id;

  -- Case and surrounding whitespace are normalised by the function, not
  -- trusted from the caller.
  select * into r from pg_temp.quote(
    'a0620000-0000-0000-0000-000000000002', 'b0620000-0000-0000-0000-000000000005', '  pct10 ');
  perform pg_temp.assert(r.price_cents_at_checkout = 17910,
    'T5: a lowercase, padded code must resolve identically');
  delete from public.book_checkout_intents where id = r.intent_id;
end $$;

-- ============================================================
-- T6 / T8 / T9 / T10: every below-floor result is REJECTED, and the
-- rejection changes nothing.
--
-- This is the block that would catch a restored clamp. Under
-- greatest(v_price_minor, 9900) every case here would return `minted`
-- at 9900 -- and T6's reader would then pay 9900 WITH a valid 10% code
-- on a 99-lek book, having paid 9900 without one. Under the original
-- greatest(v_price_minor, 50) they would pay 50 minor units, which is
-- the other direction of wrong.
-- ============================================================
do $$
declare
  r record;
  v_before text;
  cases text := $c$
    b0620000-0000-0000-0000-000000000003,MINPCT10,T6
    b0620000-0000-0000-0000-000000000005,OFF199ALL,T8
    b0620000-0000-0000-0000-000000000005,OFF200ALL,T9
    b0620000-0000-0000-0000-000000000005,PCT100,T10
  $c$;
  case_row record;
begin
  for case_row in
    select split_part(trim(line), ',', 1) as book,
           split_part(trim(line), ',', 2) as code,
           split_part(trim(line), ',', 3) as label
      from unnest(string_to_array(trim(cases), E'\n')) as line
     where trim(line) <> ''
  loop
    v_before := pg_temp.mutation_fingerprint();
    select * into r from pg_temp.quote(
      'a0620000-0000-0000-0000-000000000002', case_row.book::uuid, case_row.code);
    perform pg_temp.assert(r.quote_status = 'discount_below_minimum',
      format('%s: expected discount_below_minimum for %s, got %s', case_row.label, case_row.code, r.quote_status));
    perform pg_temp.assert(r.intent_id is null and r.price_cents_at_checkout is null
                           and r.discount_code_id is null and r.expires_at is null,
      format('%s: a rejection must return no intent and no amount', case_row.label));
    perform pg_temp.assert(pg_temp.mutation_fingerprint() = v_before,
      format('%s: a rejection must not mint, supersede, retire or write anything', case_row.label));
  end loop;

  perform pg_temp.assert((select count(*) from public.book_checkout_intents) = 0,
    'T6/T8/T9/T10: four rejections must leave zero intents');
end $$;

-- The same rejection, but with an OPEN INTENT ALREADY IN THE WAY.
--
-- This is the case that pins WHERE the rejection happens, not merely
-- that it happens. The reader below already holds an undiscounted
-- quote; the economics of the rejected call differ from it, so a
-- rejection placed after the supersession loop would supersede that
-- quote first and only then decline -- leaving the reader with no live
-- quote and an audit row saying it went stale, in return for a call
-- that was refused. Nothing above would notice, because nothing above
-- has a predecessor to lose.
do $$
declare
  a record;
  r record;
  v_before text;
begin
  select * into a from pg_temp.quote(
    'a0620000-0000-0000-0000-000000000002', 'b0620000-0000-0000-0000-000000000005');
  perform pg_temp.assert(a.quote_status = 'minted' and a.price_cents_at_checkout = 19900,
    'T6b: the predecessor quote must mint first');

  v_before := pg_temp.mutation_fingerprint();

  select * into r from pg_temp.quote(
    'a0620000-0000-0000-0000-000000000002', 'b0620000-0000-0000-0000-000000000005', 'OFF199ALL');
  perform pg_temp.assert(r.quote_status = 'discount_below_minimum',
    format('T6b: expected discount_below_minimum, got %s', r.quote_status));
  perform pg_temp.assert(
    (select superseded_at is null and superseded_reason is null
       from public.book_checkout_intents where id = a.intent_id),
    'T6b: the rejection must happen BEFORE the supersession loop -- the reader''s live quote must survive intact');
  perform pg_temp.assert(pg_temp.mutation_fingerprint() = v_before,
    'T6b: a rejection with a predecessor present must still change nothing at all');

  -- And the same for the legacy-code rejection, which sits on the same
  -- path and would move with it.
  select * into r from pg_temp.quote(
    'a0620000-0000-0000-0000-000000000002', 'b0620000-0000-0000-0000-000000000005', 'CENTS500');
  perform pg_temp.assert(r.quote_status = 'discount_not_applicable',
    format('T6b: expected discount_not_applicable, got %s', r.quote_status));
  perform pg_temp.assert(pg_temp.mutation_fingerprint() = v_before,
    'T6b: the legacy-code rejection must not supersede the predecessor either');

  delete from public.book_checkout_intents where reader_id = 'a0620000-0000-0000-0000-000000000002';
end $$;

-- ============================================================
-- T12: a legacy amount_off_cents code is REJECTED, not applied and not
-- ignored.
--
-- Ignoring it would charge the reader the full 19900 on a call in which
-- they supplied a code the database still considers active, which is
-- the quiet version of the same harm as applying it.
-- ============================================================
do $$
declare
  r record;
  v_before text;
begin
  v_before := pg_temp.mutation_fingerprint();
  select * into r from pg_temp.quote(
    'a0620000-0000-0000-0000-000000000002', 'b0620000-0000-0000-0000-000000000005', 'CENTS500');
  perform pg_temp.assert(r.quote_status = 'discount_not_applicable',
    format('T12: expected discount_not_applicable, got %s', r.quote_status));
  perform pg_temp.assert(r.intent_id is null and r.price_cents_at_checkout is null,
    'T12: a legacy code must not produce an intent at any price');
  perform pg_temp.assert(pg_temp.mutation_fingerprint() = v_before,
    'T12: the legacy-code rejection must change nothing');
  perform pg_temp.assert((select count(*) from public.book_checkout_intents) = 0,
    'T12: no intent may exist -- in particular not one at the undiscounted 19900');
end $$;

-- ============================================================
-- T13: a code that is not SELECTED (inactive, expired, wrong book,
-- unknown) is a different thing from a code that is rejected: the call
-- mints at the undiscounted price with no code recorded.
-- ============================================================
do $$
declare
  r record;
  c text;
begin
  foreach c in array array['INACTIVE10', 'EXPIRED10', 'NOSUCHCODE', 'MINPCT10']
  loop
    select * into r from pg_temp.quote(
      'a0620000-0000-0000-0000-000000000002', 'b0620000-0000-0000-0000-000000000005', c);
    perform pg_temp.assert(r.quote_status = 'minted' and r.price_cents_at_checkout = 19900
                           and r.discount_code_id is null,
      format('T13: %s must mint undiscounted at 19900 with no code, got %s / %s / %s',
             c, r.quote_status, r.price_cents_at_checkout, r.discount_code_id));
    delete from public.book_checkout_intents where id = r.intent_id;
  end loop;
end $$;

-- ============================================================
-- T14 / T15: reuse and supersession, decided by the economics this
-- function now derives entirely by itself.
-- ============================================================
do $$
declare
  a record;
  b record;
  c record;
begin
  select * into a from pg_temp.quote(
    'a0620000-0000-0000-0000-000000000002', 'b0620000-0000-0000-0000-000000000005');
  perform pg_temp.assert(a.quote_status = 'minted' and a.price_cents_at_checkout = 19900, 'T14: first call mints');

  select * into b from pg_temp.quote(
    'a0620000-0000-0000-0000-000000000002', 'b0620000-0000-0000-0000-000000000005');
  perform pg_temp.assert(b.quote_status = 'reused' and b.intent_id = a.intent_id
                         and b.price_cents_at_checkout = a.price_cents_at_checkout,
    format('T14: identical economics must reuse, got %s', b.quote_status));

  -- The author repriced the book. The old quote is superseded with a
  -- reason and a new one is minted at the new amount.
  update public.books set price_all = 299 where id = 'b0620000-0000-0000-0000-000000000005';

  select * into c from pg_temp.quote(
    'a0620000-0000-0000-0000-000000000002', 'b0620000-0000-0000-0000-000000000005');
  perform pg_temp.assert(c.quote_status = 'minted' and c.intent_id <> a.intent_id
                         and c.price_cents_at_checkout = 29900,
    format('T15: a repriced book must mint a new intent at 29900, got %s / %s', c.quote_status, c.price_cents_at_checkout));
  perform pg_temp.assert(
    (select superseded_reason from public.book_checkout_intents where id = a.intent_id) = 'quote_stale',
    'T15: the displaced quote must record quote_stale');
  perform pg_temp.assert(
    (select price_cents_at_checkout from public.book_checkout_intents where id = a.intent_id) = 19900,
    'T15: a superseded quote is never rewritten -- its own frozen amount stands');

  update public.books set price_all = 199 where id = 'b0620000-0000-0000-0000-000000000005';
  delete from public.book_checkout_intents where reader_id = 'a0620000-0000-0000-0000-000000000002';
end $$;

-- ============================================================
-- T16: a repricing that lands on a LIVE provider attempt is not decided
-- in SQL at all.
-- ============================================================
do $$
declare
  a record;
  b record;
  v_claim record;
  v_before text;
begin
  select * into a from pg_temp.quote(
    'a0620000-0000-0000-0000-000000000002', 'b0620000-0000-0000-0000-000000000005');

  set local role service_role;
  select * into v_claim from public.claim_pok_book_checkout_order(
    a.intent_id, 'book:' || a.intent_id::text, gen_random_uuid(), gen_random_uuid(), 30);
  reset role;
  perform pg_temp.assert(v_claim.outcome = 'claimed',
    format('T16: the attempt fixture must claim cleanly, got %s', v_claim.outcome));

  update public.books set price_all = 299 where id = 'b0620000-0000-0000-0000-000000000005';
  v_before := pg_temp.mutation_fingerprint();

  select * into b from pg_temp.quote(
    'a0620000-0000-0000-0000-000000000002', 'b0620000-0000-0000-0000-000000000005');
  perform pg_temp.assert(b.quote_status = 'conflict_attempt_unresolved',
    format('T16: expected conflict_attempt_unresolved, got %s', b.quote_status));
  perform pg_temp.assert(b.intent_id = a.intent_id and b.price_cents_at_checkout = 19900,
    'T16: the conflict must report the FROZEN amount, never today''s');
  perform pg_temp.assert(pg_temp.mutation_fingerprint() = v_before,
    'T16: an unresolved conflict must mutate nothing -- not the intent, not the mapping');

  update public.books set price_all = 199 where id = 'b0620000-0000-0000-0000-000000000005';
  delete from public.pok_book_checkout_orders where intent_id = a.intent_id;
  delete from public.book_checkout_intents where reader_id = 'a0620000-0000-0000-0000-000000000002';
end $$;

-- ============================================================
-- The deliberate accept path, and the supersession rate limit -- both
-- unchanged by this patch, both re-proved here because the discount
-- rejections were inserted ahead of them and an ordering mistake would
-- show up as one of these breaking.
-- ============================================================
do $$
declare
  a record;
  r record;
  v_before text;
  n integer;
begin
  select * into a from pg_temp.quote(
    'a0620000-0000-0000-0000-000000000002', 'b0620000-0000-0000-0000-000000000005');

  select * into r from pg_temp.quote(
    'a0620000-0000-0000-0000-000000000002', 'b0620000-0000-0000-0000-000000000005', null, true, a.intent_id);
  perform pg_temp.assert(r.quote_status = 'reused' and r.intent_id = a.intent_id,
    format('accept: a deliberate accept resumes exactly the named intent, got %s', r.quote_status));

  select * into r from pg_temp.quote(
    'a0620000-0000-0000-0000-000000000002', 'b0620000-0000-0000-0000-000000000005', null, true, gen_random_uuid());
  perform pg_temp.assert(r.quote_status = 'expected_intent_changed' and r.intent_id is null,
    format('accept: a different expected id must never be substituted, got %s', r.quote_status));

  delete from public.book_checkout_intents where reader_id = 'a0620000-0000-0000-0000-000000000002';

  -- Rate limit: 20 supersessions in the last hour for this (reader,
  -- book) pair, then one open intent to displace.
  for n in 1..20 loop
    insert into public.book_checkout_intents
      (book_id, reader_id, book_title, price_cents_at_checkout, expires_at,
       regime, currency, royalty_rate_bps, superseded_at, superseded_reason)
    values ('b0620000-0000-0000-0000-000000000005', 'a0620000-0000-0000-0000-000000000002',
            'P062 Discount Book', 19900, now() + interval '1 hour',
            'librum_ledger_v1', 'ALL', 8000, now() - interval '1 minute', 'quote_stale');
  end loop;
  insert into public.book_checkout_intents
    (book_id, reader_id, book_title, price_cents_at_checkout, expires_at,
     regime, currency, royalty_rate_bps)
  values ('b0620000-0000-0000-0000-000000000005', 'a0620000-0000-0000-0000-000000000002',
          'P062 Discount Book', 12345, now() + interval '1 hour',
          'librum_ledger_v1', 'ALL', 8000);

  v_before := pg_temp.mutation_fingerprint();
  select * into r from pg_temp.quote(
    'a0620000-0000-0000-0000-000000000002', 'b0620000-0000-0000-0000-000000000005');
  perform pg_temp.assert(r.quote_status = 'supersession_rate_limited',
    format('rate limit: expected supersession_rate_limited, got %s', r.quote_status));
  perform pg_temp.assert(pg_temp.mutation_fingerprint() = v_before,
    'rate limit: the limited outcome must leave nothing changed');

  delete from public.book_checkout_intents where reader_id = 'a0620000-0000-0000-0000-000000000002';
end $$;

-- ============================================================
-- T17 / T18: who may call it.
-- ============================================================
do $$
begin
  -- The catalog assertions come FIRST, deliberately. If anon or PUBLIC
  -- held EXECUTE, the call below would no longer be refused for lack of
  -- privilege -- it would get INTO the function and raise 'not
  -- authenticated' instead, and the suite would go red with a confusing
  -- message about authentication rather than about the grant that
  -- actually moved.
  perform pg_temp.assert(
    not has_function_privilege('anon', 'public.create_book_checkout_intent(uuid,text,boolean,uuid)', 'EXECUTE'),
    'T17: anon must hold no EXECUTE');
  perform pg_temp.assert(
    not has_function_privilege('public', 'public.create_book_checkout_intent(uuid,text,boolean,uuid)', 'EXECUTE'),
    'T18: PUBLIC must hold no EXECUTE -- a freshly created function is granted to PUBLIC by default, so this is the assertion that proves the revoke ran');
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.create_book_checkout_intent(uuid,text,boolean,uuid)', 'EXECUTE'),
    'T18: authenticated must hold EXECUTE');

  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
  begin
    perform public.create_book_checkout_intent('b0620000-0000-0000-0000-000000000005'::uuid, null);
    perform pg_temp.assert(false, 'T17: anon must not be able to call create_book_checkout_intent');
  exception
    when insufficient_privilege then
      null;
    when others then
      reset role;
      perform pg_temp.assert(false,
        format('T17: anon must be refused for LACK OF PRIVILEGE, not for any other reason -- got: %s', sqlerrm));
  end;
  reset role;

  -- An authenticated caller with no JWT subject gets a different, and
  -- correct, refusal: the grant lets them in, auth.uid() stops them.
  perform set_config('request.jwt.claim.sub', '', true);
  set local role authenticated;
  begin
    perform public.create_book_checkout_intent('b0620000-0000-0000-0000-000000000005'::uuid, null);
    perform pg_temp.assert(false, 'T17: a subject-less authenticated caller must be refused');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authenticated',
      format('T17: expected the not-authenticated refusal, got: %s', sqlerrm));
  end;
  reset role;
end $$;

-- ============================================================
-- T19: the removed surface is really gone.
--
-- Two separate claims, because they fail differently: no overload of
-- any other arity exists in the catalog, AND a call written against one
-- of the removed signatures fails outright rather than resolving to
-- something else. The second is the one that matters operationally --
-- "the argument disappeared but the call still worked" is exactly how a
-- caller-chosen royalty rate would survive this change.
-- ============================================================
do $$
declare
  v_sig text;
  v_ok boolean;
begin
  perform pg_temp.assert(
    (select count(*) from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname = 'create_book_checkout_intent') = 1,
    'T19: exactly one create_book_checkout_intent must exist');
  perform pg_temp.assert(
    not exists (
      select 1 from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.proname = 'create_book_checkout_intent'
         and p.pronargs <> 4),
    'T19: no overload of any other arity may survive');
  perform pg_temp.assert(
    (select array_to_string(p.proargnames, ',') from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname = 'create_book_checkout_intent' and p.pronargs = 4)
    like 'book_id,p_discount_code,p_accept_existing_quote,p_expected_intent_id,%',
    'T19: the four argument names must be exactly the new surface, in order');
  perform pg_temp.assert(
    not exists (
      select 1 from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.proname = 'create_book_checkout_intent'
         and 'p_royalty_rate_bps' = any(p.proargnames)),
    'T19: no p_royalty_rate_bps parameter may exist anywhere on this function');
  perform pg_temp.assert(
    not exists (
      select 1 from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.proname = 'create_book_checkout_intent'
         and ('p_regime' = any(p.proargnames) or 'p_currency' = any(p.proargnames))),
    'T19: no p_regime or p_currency parameter may exist anywhere on this function');

  -- Each removed signature, looked up by regprocedure: absent.
  foreach v_sig in array array[
    'public.create_book_checkout_intent(uuid,text,text,text,integer)',
    'public.create_book_checkout_intent(uuid,text,text,text,integer,boolean,uuid)']
  loop
    v_ok := false;
    begin
      perform v_sig::regprocedure;
    exception when undefined_function then
      v_ok := true;
    end;
    perform pg_temp.assert(v_ok, format('T19: %s must no longer exist', v_sig));
  end loop;

  -- And a real call written the old way must FAIL, for either the
  -- five-argument positional form or the seven-argument one, and for a
  -- named p_royalty_rate_bps. Executed dynamically so the failure is
  -- catchable rather than a parse error for the whole block.
  perform set_config('request.jwt.claim.sub', 'a0620000-0000-0000-0000-000000000002', true);
  foreach v_sig in array array[
    'select * from public.create_book_checkout_intent(''b0620000-0000-0000-0000-000000000005''::uuid, null, ''librum_ledger_v1'', ''ALL'', 8000)',
    'select * from public.create_book_checkout_intent(''b0620000-0000-0000-0000-000000000005''::uuid, null, ''legacy_stripe_connect_v1'', ''USD'', null, false, null)',
    'select * from public.create_book_checkout_intent(book_id => ''b0620000-0000-0000-0000-000000000005''::uuid, p_royalty_rate_bps => 0)',
    'select * from public.create_book_checkout_intent(book_id => ''b0620000-0000-0000-0000-000000000005''::uuid, p_regime => ''legacy_stripe_connect_v1'')']
  loop
    v_ok := false;
    begin
      set local role authenticated;
      execute v_sig;
      reset role;
    exception when undefined_function or undefined_parameter or syntax_error then
      v_ok := true;
      reset role;
    end;
    perform pg_temp.assert(v_ok,
      format('T19: a call on a removed signature must fail, not resolve to another overload: %s', v_sig));
  end loop;

  perform pg_temp.assert((select count(*) from public.book_checkout_intents) = 0,
    'T19: none of the failed legacy calls may have minted anything');
end $$;

-- ============================================================
-- T20 / T21: history is readable, finalizable and untouched.
--
-- The legacy intent below is inserted directly as the table owner --
-- the only way one can be produced now, and deliberately so. It stands
-- in for the legacy_stripe_connect_v1 rows that already exist in
-- staging.
-- ============================================================
do $$
declare
  v_legacy uuid;
  v_xmin text;
  v_q record;
  v_out record;
  r record;
begin
  insert into public.book_checkout_intents
    (book_id, reader_id, book_title, price_cents_at_checkout, expires_at,
     regime, currency, royalty_rate_bps)
  values ('b0620000-0000-0000-0000-000000000005', 'a0620000-0000-0000-0000-000000000003',
          'P062 Discount Book', 799, now() + interval '23 hours',
          'legacy_stripe_connect_v1', 'USD', null)
  returning id into v_legacy;

  select xmin::text into v_xmin from public.book_checkout_intents where id = v_legacy;

  -- T21a: still readable by its own reader, at its own frozen amount,
  -- in its own currency.
  perform set_config('request.jwt.claim.sub', 'a0620000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  select * into v_q from public.get_book_checkout_quote(v_legacy, 'b0620000-0000-0000-0000-000000000005');
  reset role;
  perform pg_temp.assert(v_q.intent_id = v_legacy and v_q.price_cents_at_checkout = 799
                         and v_q.currency = 'USD',
    format('T21: a legacy intent must stay readable at its own amount and currency, got %s / %s',
           v_q.price_cents_at_checkout, v_q.currency));

  -- T20: an unrelated reader minting a new ALL quote must not touch it.
  select * into r from pg_temp.quote(
    'a0620000-0000-0000-0000-000000000002', 'b0620000-0000-0000-0000-000000000005');
  perform pg_temp.assert(r.quote_status = 'minted' and r.price_cents_at_checkout = 19900,
    'T20: the unrelated new quote must mint normally');
  perform pg_temp.assert(
    (select xmin::text from public.book_checkout_intents where id = v_legacy) = v_xmin,
    'T20: the pre-existing legacy row must not have been written at all -- its xmin must be unchanged');

  -- T21b: still finalizable through the legacy finalizer, unchanged.
  set local role service_role;
  select * into v_out from public.finalize_book_checkout_intent(v_legacy, 'cs_p062_legacy', 'pi_p062_legacy', 799);
  reset role;
  perform pg_temp.assert(v_out.outcome = 'eligible_fulfilled',
    format('T21: a legacy intent must still finalize, got %s', v_out.outcome));
  perform pg_temp.assert(
    (select amount_cents from public.purchases
      where book_id = 'b0620000-0000-0000-0000-000000000005'
        and reader_id = 'a0620000-0000-0000-0000-000000000003') = 799,
    'T21: the legacy purchase must carry its own USD amount, untouched by ALL arithmetic');

  delete from public.purchases where reader_id = 'a0620000-0000-0000-0000-000000000003';
  delete from public.book_checkout_intents
   where reader_id in ('a0620000-0000-0000-0000-000000000002', 'a0620000-0000-0000-0000-000000000003');
end $$;

-- ============================================================
-- T22: ledger conservation on the amounts this function now produces.
--
-- Run end to end through the real ledger path -- record_payment_event
-- then finalize_ledger_book_payment -- rather than by re-implementing
-- the royalty split here, which would prove only that this file agrees
-- with itself. 18507 is the case that matters: 20% of it is 3701.4, a
-- fractional pre-rounded platform share, which is the NORM at 8000 bps
-- rather than an edge case.
-- ============================================================
do $$
declare
  cases text := $c$
    b0620000-0000-0000-0000-000000000003,a0620000-0000-0000-0000-000000000002,,9900
    b0620000-0000-0000-0000-000000000005,a0620000-0000-0000-0000-000000000003,OFF20ALL,17900
    b0620000-0000-0000-0000-000000000009,a0620000-0000-0000-0000-000000000002,CONS10,17910
    b0620000-0000-0000-0000-000000000008,a0620000-0000-0000-0000-000000000004,CONS7,18507
  $c$;
  case_row record;
  r record;
  v_event record;
  v_result record;
  v_purchase_id uuid;
  v_payment_id uuid;
  v_entry record;
  v_key text;
begin
  for case_row in
    select split_part(trim(line), ',', 1) as book,
           split_part(trim(line), ',', 2) as reader,
           nullif(split_part(trim(line), ',', 3), '') as code,
           split_part(trim(line), ',', 4)::integer as expected
      from unnest(string_to_array(trim(cases), E'\n')) as line
     where trim(line) <> ''
  loop
    v_key := 'p062_cons_' || case_row.expected::text;

    select * into r from pg_temp.quote(case_row.reader::uuid, case_row.book::uuid, case_row.code);
    perform pg_temp.assert(r.quote_status = 'minted' and r.price_cents_at_checkout = case_row.expected,
      format('T22: expected a minted %s, got %s / %s', case_row.expected, r.quote_status, r.price_cents_at_checkout));

    set local role service_role;
    select * into v_event from public.record_payment_event('pok', 'evt_' || v_key, 'pok.order.payment_verified', 'pi_' || v_key);
    select * into v_result from public.finalize_ledger_book_payment(
      v_event.id, r.intent_id, 'pok', 'pi_' || v_key, case_row.expected::bigint, 'ALL', now());
    reset role;
    perform pg_temp.assert(v_result.outcome = 'eligible_fulfilled',
      format('T22: finalization at %s must succeed, got %s', case_row.expected, v_result.outcome));

    select id into v_purchase_id from public.purchases
     where book_id = case_row.book::uuid and reader_id = case_row.reader::uuid;
    select id into v_payment_id from public.payments
     where provider = 'pok' and provider_payment_id = 'pi_' || v_key;
    select * into v_entry from public.author_ledger_entries
     where payment_id = v_payment_id and purchase_id = v_purchase_id and entry_type = 'sale';

    perform pg_temp.assert(v_entry.gross_amount_minor = case_row.expected,
      format('T22: the ledger gross must equal the frozen amount %s, got %s', case_row.expected, v_entry.gross_amount_minor));
    perform pg_temp.assert(
      v_entry.gross_amount_minor = v_entry.amount_minor + v_entry.librum_amount_minor,
      format('T22: gross must equal author + librum at %s (%s <> %s + %s)',
             case_row.expected, v_entry.gross_amount_minor, v_entry.amount_minor, v_entry.librum_amount_minor));
    perform pg_temp.assert(v_entry.currency = 'ALL',
      format('T22: the ledger entry currency must be ALL at %s, got %s', case_row.expected, v_entry.currency));
    perform pg_temp.assert(
      (select amount_minor from public.payments where id = v_payment_id) = case_row.expected,
      format('T22: the payment amount must equal the frozen amount at %s', case_row.expected));
  end loop;

  -- The one fractional case, named explicitly so a future reader sees
  -- which way the half lands: 20% of 18507 is 3701.4, so Librum takes
  -- 3701 and the author takes the exact remainder, 14806.
  perform pg_temp.assert(
    (select librum_amount_minor from public.author_ledger_entries
      where gross_amount_minor = 18507 and entry_type = 'sale') = 3701,
    'T22: at gross 18507 the platform share must be 3701, the author 14806');
end $$;

select 'ALL PASSED: 062_all_checkout_intent_arithmetic.test.sql' as result;

rollback;
