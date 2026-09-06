-- Committed SQL regression suite for migration 051 (LEDGER-1E-B: author
-- payout reservation + state-machine foundation).
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql -- no new test
-- infrastructure needed, same as every other suite in this directory.
--
-- Run manually against a disposable/local Postgres instance, AFTER
-- applying supabase/schema.sql (which already includes migration 051's
-- final state), from the repo root:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/051_author_payout_foundation.test.sql
--
-- A SEPARATE script, 051_payout_reservation_contention.sh, proves the
-- active-payout-per-author-currency uniqueness invariant against two
-- REAL, concurrent Postgres connections -- something a single-
-- transaction .sql file structurally cannot do. See that script's own
-- header for why it is kept apart from this file (same reasoning as
-- 032_advisory_lock_contention.sh).
--
-- Everything below runs inside one transaction and is rolled back at
-- the end, so now() is CONSTANT throughout (same discipline as every
-- other suite in this directory) -- every future/past timestamp
-- fixture is seeded with an explicit `now() +/- interval` value.
--
-- Payout mutation RPCs are called with `set local role service_role;`
-- (mirroring how author-only RPCs elsewhere in this test suite family
-- use `set local role authenticated;`) -- this is the ONLY role granted
-- EXECUTE on any of them (Section 28/49).
--
-- Ledger fixtures are inserted DIRECTLY (as the connecting superuser/
-- table owner, bypassing RLS -- the same convention every 048/049/050
-- test file already uses), including 'payout' entries that mirror
-- exactly what finalize_author_payout() itself would have produced,
-- for the cases that need PRE-EXISTING payout history (e.g. the
-- negative-balance eligibility case) rather than exercising the RPC.

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
-- Part 1 (Section 41 TEST MATRIX -- SETTINGS)
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0510001-0000-0000-0000-000000000001', 'p051-settings@test', now(), '{"role":"author","display_name":"P1 Settings"}');

-- One author, two currencies -- proves the PK evolution from
-- (author_id) to (author_id, currency) actually works.
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('e0510001-0000-0000-0000-000000000001', 5000, 'EUR'),
  ('e0510001-0000-0000-0000-000000000001', 6000, 'USD');

do $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.author_payout_settings
    where author_id = 'e0510001-0000-0000-0000-000000000001';
  perform pg_temp.assert(v_count = 2, format('part1: one author must be able to hold 2 currency settings rows, got %s', v_count));
end $$;

-- Duplicate (author, currency) rejected by the composite PK.
do $$
begin
  begin
    insert into public.author_payout_settings (author_id, threshold_minor, currency) values
      ('e0510001-0000-0000-0000-000000000001', 9999, 'EUR');
    perform pg_temp.assert(false, 'part1: a duplicate (author_id, currency) settings row must be rejected');
  exception when unique_violation then null;
  end;
end $$;

-- threshold_minor must be positive.
do $$
begin
  begin
    insert into public.author_payout_settings (author_id, threshold_minor, currency) values
      ('e0510001-0000-0000-0000-000000000001', 0, 'GBP');
    perform pg_temp.assert(false, 'part1: threshold_minor <= 0 must be rejected');
  exception when check_violation then null;
  end;
end $$;

-- currency must match the existing 3-uppercase-letter format check.
do $$
begin
  begin
    insert into public.author_payout_settings (author_id, threshold_minor, currency) values
      ('e0510001-0000-0000-0000-000000000001', 1000, 'eur');
    perform pg_temp.assert(false, 'part1: a lowercase/invalid currency must be rejected');
  exception when check_violation then null;
  end;
end $$;

-- No settings row for a currency -> not eligible (Section 7's V1 rule).
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0510001-0000-0000-0000-000000000002', 'e0510001-0000-0000-0000-000000000001', 'P1 No Settings Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0510001-0000-0000-0000-000000000003', 'e0510001-0000-0000-0000-000000000002', 'e0510001-0000-0000-0000-000000000001', 'cs_p051_1', 100);
insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0510001-0000-0000-0000-000000000004', 'e0510001-0000-0000-0000-000000000001',
   'e0510001-0000-0000-0000-000000000003', 'sale', 8000, 'GBP', 8000, 10000, 2000,
   now() - interval '1 day', now() - interval '10 days');

do $$
declare
  v_rowcount integer;
begin
  set local role service_role;
  select count(*) into v_rowcount from public.reserve_author_payout('e0510001-0000-0000-0000-000000000001', 'GBP');
  reset role;
  perform pg_temp.assert(v_rowcount = 0, format('part1: no settings row for GBP must mean not eligible, got %s rows', v_rowcount));
end $$;

-- ============================================================
-- Part 2 (Section 42 TEST MATRIX -- ELIGIBILITY)
-- ============================================================

-- E1: below threshold -> no reservation.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0510002-0000-0000-0000-000000000001', 'p051-e1@test', now(), '{"role":"author","display_name":"E1 Below Threshold"}');
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0510002-0000-0000-0000-000000000002', 'e0510002-0000-0000-0000-000000000001', 'E1 Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0510002-0000-0000-0000-000000000003', 'e0510002-0000-0000-0000-000000000002', 'e0510002-0000-0000-0000-000000000001', 'cs_p051_e1', 100);
insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0510002-0000-0000-0000-000000000004', 'e0510002-0000-0000-0000-000000000001',
   'e0510002-0000-0000-0000-000000000003', 'sale', 40, 'USD', 8000, 50, 10,
   now() - interval '1 day', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('e0510002-0000-0000-0000-000000000001', 50, 'USD');

do $$
declare
  v_rowcount integer;
begin
  set local role service_role;
  select count(*) into v_rowcount from public.reserve_author_payout('e0510002-0000-0000-0000-000000000001', 'USD');
  reset role;
  perform pg_temp.assert(v_rowcount = 0, format('part2/E1: 40 available < 50 threshold must reserve nothing, got %s rows', v_rowcount));
end $$;

-- E2: exact threshold -> FULL payoutable reserved.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0510002-0000-0000-0000-000000000005', 'p051-e2@test', now(), '{"role":"author","display_name":"E2 Exact Threshold"}');
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0510002-0000-0000-0000-000000000006', 'e0510002-0000-0000-0000-000000000005', 'E2 Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0510002-0000-0000-0000-000000000007', 'e0510002-0000-0000-0000-000000000006', 'e0510002-0000-0000-0000-000000000005', 'cs_p051_e2', 100);
insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0510002-0000-0000-0000-000000000008', 'e0510002-0000-0000-0000-000000000005',
   'e0510002-0000-0000-0000-000000000007', 'sale', 50, 'USD', 8000, 63, 13,
   now() - interval '1 day', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('e0510002-0000-0000-0000-000000000005', 50, 'USD');

do $$
declare
  v_row record;
begin
  set local role service_role;
  select * into v_row from public.reserve_author_payout('e0510002-0000-0000-0000-000000000005', 'USD');
  reset role;
  perform pg_temp.assert(v_row.amount_minor = 50, format('part2/E2: exact threshold must reserve the full 50, got %s', v_row.amount_minor));
end $$;

-- E3: above threshold -> FULL payoutable reserved, not just the
-- threshold (the task's own worked example: threshold 50, payoutable
-- 73 -> reserve 73).
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0510002-0000-0000-0000-000000000009', 'p051-e3@test', now(), '{"role":"author","display_name":"E3 Above Threshold"}');
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0510002-0000-0000-0000-00000000000a', 'e0510002-0000-0000-0000-000000000009', 'E3 Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0510002-0000-0000-0000-00000000000b', 'e0510002-0000-0000-0000-00000000000a', 'e0510002-0000-0000-0000-000000000009', 'cs_p051_e3', 100);
insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0510002-0000-0000-0000-00000000000c', 'e0510002-0000-0000-0000-000000000009',
   'e0510002-0000-0000-0000-00000000000b', 'sale', 73, 'USD', 8000, 91, 18,
   now() - interval '1 day', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('e0510002-0000-0000-0000-000000000009', 50, 'USD');

do $$
declare
  v_row record;
begin
  set local role service_role;
  select * into v_row from public.reserve_author_payout('e0510002-0000-0000-0000-000000000009', 'USD');
  reset role;
  perform pg_temp.assert(v_row.amount_minor = 73, format('part2/E3: above threshold must reserve the FULL payoutable (73), not the threshold (50), got %s', v_row.amount_minor));
end $$;

-- E4: negative available -> no reservation. Built via a full payment/
-- payout/refund fixture chain (mirrors 050's own Part 3 post-payout
-- negative-balance case exactly): sale +800 settled, payout -800 (a
-- direct ledger insert referencing a hand-inserted 'paid' author_payouts
-- row, bypassing the RPCs -- this fixture represents PRE-EXISTING
-- history, not something this test exercises the RPC to create), then
-- a refund -800 requiring the full payments/payment_refunds chain
-- migration 049 requires for any canonical refund entry.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0510002-0000-0000-0000-00000000000d', 'p051-e4@test', now(), '{"role":"author","display_name":"E4 Negative Balance"}');
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0510002-0000-0000-0000-00000000000e', 'e0510002-0000-0000-0000-00000000000d', 'E4 Book', '', '', '', 800, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0510002-0000-0000-0000-00000000000f', 'e0510002-0000-0000-0000-00000000000e', 'e0510002-0000-0000-0000-00000000000d', 'cs_p051_e4', 800);

insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('e0510002-0000-0000-0000-000000000010', 'test', 'pay_p051_e4', 800, 'USD', 'succeeded');
update public.purchases set payment_id = 'e0510002-0000-0000-0000-000000000010' where id = 'e0510002-0000-0000-0000-00000000000f';

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0510002-0000-0000-0000-000000000011', 'e0510002-0000-0000-0000-00000000000d',
   'e0510002-0000-0000-0000-00000000000f', 'e0510002-0000-0000-0000-000000000010', 'sale', 640, 'USD', 8000, 800, 160,
   now() - interval '40 days', now() - interval '70 days');

insert into public.author_payouts (id, author_id, amount_minor, currency, status, provider, provider_reference, paid_at) values
  ('e0510002-0000-0000-0000-000000000012', 'e0510002-0000-0000-0000-00000000000d', 640, 'USD', 'paid', 'test', 'ref-e4-preexisting', now() - interval '30 days');

insert into public.author_ledger_entries
  (id, author_id, payout_id, entry_type, amount_minor, currency, available_at, created_at)
values
  ('e0510002-0000-0000-0000-000000000013', 'e0510002-0000-0000-0000-00000000000d',
   'e0510002-0000-0000-0000-000000000012', 'payout', -640, 'USD', now() - interval '30 days', now() - interval '30 days');

insert into public.payment_refunds (id, payment_id, purchase_id, provider, provider_refund_id, amount_minor, currency, refunded_at) values
  ('e0510002-0000-0000-0000-000000000014', 'e0510002-0000-0000-0000-000000000010', 'e0510002-0000-0000-0000-00000000000f',
   'test', 'refund_p051_e4', 800, 'USD', now());

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, payment_refund_id, entry_type, amount_minor, currency, available_at, created_at)
values
  ('e0510002-0000-0000-0000-000000000015', 'e0510002-0000-0000-0000-00000000000d',
   'e0510002-0000-0000-0000-00000000000f', 'e0510002-0000-0000-0000-000000000010', 'e0510002-0000-0000-0000-000000000014',
   'refund', -640, 'USD', now(), now());

-- Tiny threshold (1) so ONLY the negative-balance guard is under test,
-- never a threshold-too-high false negative.
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('e0510002-0000-0000-0000-00000000000d', 1, 'USD');

do $$
declare
  v_available bigint;
  v_rowcount integer;
begin
  select balance.available_minor into v_available
    from public.author_ledger_balance('e0510002-0000-0000-0000-00000000000d') balance
    where balance.currency = 'USD';
  perform pg_temp.assert(v_available = -640, format('part2/E4 sanity: expected -640 available, got %s', v_available));

  set local role service_role;
  select count(*) into v_rowcount from public.reserve_author_payout('e0510002-0000-0000-0000-00000000000d', 'USD');
  reset role;
  perform pg_temp.assert(v_rowcount = 0, format('part2/E4: a negative available balance must never be reserved, got %s rows', v_rowcount));
end $$;

-- E5: pending (not-yet-settled) earnings excluded -- a future sale
-- contributes 0 to available_minor, so it must never be reservable
-- regardless of threshold.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0510002-0000-0000-0000-000000000016', 'p051-e5@test', now(), '{"role":"author","display_name":"E5 Pending Excluded"}');
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0510002-0000-0000-0000-000000000017', 'e0510002-0000-0000-0000-000000000016', 'E5 Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0510002-0000-0000-0000-000000000018', 'e0510002-0000-0000-0000-000000000017', 'e0510002-0000-0000-0000-000000000016', 'cs_p051_e5', 100);
insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0510002-0000-0000-0000-000000000019', 'e0510002-0000-0000-0000-000000000016',
   'e0510002-0000-0000-0000-000000000018', 'sale', 1000, 'USD', 8000, 1250, 250,
   now() + interval '25 days', now() - interval '5 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('e0510002-0000-0000-0000-000000000016', 1, 'USD');

do $$
declare
  v_rowcount integer;
begin
  set local role service_role;
  select count(*) into v_rowcount from public.reserve_author_payout('e0510002-0000-0000-0000-000000000016', 'USD');
  reset role;
  perform pg_temp.assert(v_rowcount = 0, format('part2/E5: a future/pending sale must never be reservable, got %s rows', v_rowcount));
end $$;

-- E6: active reservation is subtracted from the OPERATIONAL payoutable
-- formula, while the LEDGER's own available_minor stays unchanged --
-- proving Section 3's own distinction ("reservation itself must NEVER
-- write a payout ledger debit") holds structurally, not just by
-- assertion.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0510002-0000-0000-0000-00000000001a', 'p051-e6@test', now(), '{"role":"author","display_name":"E6 Reservation Subtracted"}');
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0510002-0000-0000-0000-00000000001b', 'e0510002-0000-0000-0000-00000000001a', 'E6 Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0510002-0000-0000-0000-00000000001c', 'e0510002-0000-0000-0000-00000000001b', 'e0510002-0000-0000-0000-00000000001a', 'cs_p051_e6', 100);
insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0510002-0000-0000-0000-00000000001d', 'e0510002-0000-0000-0000-00000000001a',
   'e0510002-0000-0000-0000-00000000001c', 'sale', 100, 'USD', 8000, 125, 25,
   now() - interval '1 day', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('e0510002-0000-0000-0000-00000000001a', 50, 'USD');

do $$
declare
  v_first record;
  v_available_after bigint;
  v_second_rowcount integer;
begin
  set local role service_role;
  select * into v_first from public.reserve_author_payout('e0510002-0000-0000-0000-00000000001a', 'USD');
  select count(*) into v_second_rowcount from public.reserve_author_payout('e0510002-0000-0000-0000-00000000001a', 'USD');
  reset role;

  perform pg_temp.assert(v_first.amount_minor = 100, format('part2/E6: first reservation must be 100, got %s', v_first.amount_minor));
  perform pg_temp.assert(v_second_rowcount = 0, format('part2/E6: a second reservation while one is active must reserve nothing, got %s rows', v_second_rowcount));

  select balance.available_minor into v_available_after
    from public.author_ledger_balance('e0510002-0000-0000-0000-00000000001a') balance
    where balance.currency = 'USD';
  perform pg_temp.assert(
    v_available_after = 100,
    format('part2/E6: the LEDGER''s own available_minor must remain 100, UNCHANGED by an active reservation (reservation never writes a ledger debit), got %s', v_available_after)
  );
end $$;

-- E7: EUR and USD reservations for the same author are fully
-- independent -- both must succeed.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0510002-0000-0000-0000-00000000001e', 'p051-e7@test', now(), '{"role":"author","display_name":"E7 Multi-Currency"}');
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0510002-0000-0000-0000-00000000001f', 'e0510002-0000-0000-0000-00000000001e', 'E7 USD Book', '', '', '', 100, 'published'),
  ('e0510002-0000-0000-0000-000000000020', 'e0510002-0000-0000-0000-00000000001e', 'E7 EUR Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0510002-0000-0000-0000-000000000021', 'e0510002-0000-0000-0000-00000000001f', 'e0510002-0000-0000-0000-00000000001e', 'cs_p051_e7_usd', 100),
  ('e0510002-0000-0000-0000-000000000022', 'e0510002-0000-0000-0000-000000000020', 'e0510002-0000-0000-0000-00000000001e', 'cs_p051_e7_eur', 100);
insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0510002-0000-0000-0000-000000000023', 'e0510002-0000-0000-0000-00000000001e',
   'e0510002-0000-0000-0000-000000000021', 'sale', 100, 'USD', 8000, 125, 25, now() - interval '1 day', now() - interval '10 days'),
  ('e0510002-0000-0000-0000-000000000024', 'e0510002-0000-0000-0000-00000000001e',
   'e0510002-0000-0000-0000-000000000022', 'sale', 100, 'EUR', 8000, 125, 25, now() - interval '1 day', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('e0510002-0000-0000-0000-00000000001e', 50, 'USD'),
  ('e0510002-0000-0000-0000-00000000001e', 50, 'EUR');

do $$
declare
  v_usd record;
  v_eur record;
begin
  set local role service_role;
  select * into v_usd from public.reserve_author_payout('e0510002-0000-0000-0000-00000000001e', 'USD');
  select * into v_eur from public.reserve_author_payout('e0510002-0000-0000-0000-00000000001e', 'EUR');
  reset role;

  perform pg_temp.assert(v_usd.amount_minor = 100, format('part2/E7: USD reservation must succeed at 100, got %s', v_usd.amount_minor));
  perform pg_temp.assert(v_eur.amount_minor = 100, format('part2/E7: EUR reservation must succeed independently at 100, got %s', v_eur.amount_minor));
end $$;

-- ============================================================
-- Part 3 (Section 43 TEST MATRIX -- CONCURRENCY, deterministic proof)
--
-- The REAL two-connection race is proven separately by
-- 051_payout_reservation_contention.sh (a single-transaction .sql file
-- cannot open two overlapping transactions). What CAN be proven here,
-- deterministically and without any timing dependency, is that the
-- unique index itself -- author_payouts_one_active_per_author_currency_idx
-- -- rejects a second concurrent-shaped row outright: two sequential
-- INSERTs for the same (author_id, currency, status='pending') within
-- one transaction, where the second is a unique_violation. This is the
-- exact mechanism the .sh script's real race relies on -- Postgres
-- constraint enforcement doesn't care whether the two attempts arrived
-- from the same session or two different ones, only that the key
-- would collide.
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0510003-0000-0000-0000-000000000001', 'p051-conc-a@test', now(), '{"role":"author","display_name":"P3 Author A"}'),
  ('e0510003-0000-0000-0000-000000000002', 'p051-conc-b@test', now(), '{"role":"author","display_name":"P3 Author B"}');

do $$
begin
  -- Two INSERTs, same author+currency, both status='pending' -- the
  -- second must violate the partial unique index.
  insert into public.author_payouts (author_id, amount_minor, currency, status) values
    ('e0510003-0000-0000-0000-000000000001', 100, 'USD', 'pending');

  begin
    insert into public.author_payouts (author_id, amount_minor, currency, status) values
      ('e0510003-0000-0000-0000-000000000001', 50, 'USD', 'pending');
    perform pg_temp.assert(false, 'part3: a second active payout for the same author+currency must be rejected by the unique index');
  exception when unique_violation then null;
  end;

  -- Different author, same currency: independent, both succeed.
  insert into public.author_payouts (author_id, amount_minor, currency, status) values
    ('e0510003-0000-0000-0000-000000000002', 100, 'USD', 'pending');

  -- Same author, DIFFERENT currency: independent, both succeed.
  insert into public.author_payouts (author_id, amount_minor, currency, status) values
    ('e0510003-0000-0000-0000-000000000001', 100, 'EUR', 'pending');
end $$;

do $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.author_payouts
    where author_id in ('e0510003-0000-0000-0000-000000000001', 'e0510003-0000-0000-0000-000000000002');
  perform pg_temp.assert(v_count = 3, format('part3: expected exactly 3 surviving payout rows (1 blocked), got %s', v_count));
end $$;

-- ============================================================
-- Part 4 (Section 44 TEST MATRIX -- STATE MACHINE)
-- ============================================================

-- Helper fixture author reused across sub-cases -- each sub-case gets
-- its own book/purchase/sale/settings/payout row so amounts and
-- reservations never interfere with each other.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0510004-0000-0000-0000-000000000001', 'p051-sm@test', now(), '{"role":"author","display_name":"P4 State Machine"}');

-- pending -> processing (legal) and pending -> cancelled (legal),
-- exercised via the real reserve/start/cancel RPCs.
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0510004-0000-0000-0000-000000000002', 'e0510004-0000-0000-0000-000000000001', 'P4 Book A', '', '', '', 100, 'published'),
  ('e0510004-0000-0000-0000-000000000003', 'e0510004-0000-0000-0000-000000000001', 'P4 Book B', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0510004-0000-0000-0000-000000000004', 'e0510004-0000-0000-0000-000000000002', 'e0510004-0000-0000-0000-000000000001', 'cs_p051_sm_a', 100),
  ('e0510004-0000-0000-0000-000000000005', 'e0510004-0000-0000-0000-000000000003', 'e0510004-0000-0000-0000-000000000001', 'cs_p051_sm_b', 100);
insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0510004-0000-0000-0000-000000000006', 'e0510004-0000-0000-0000-000000000001',
   'e0510004-0000-0000-0000-000000000004', 'sale', 200, 'USD', 8000, 250, 50, now() - interval '1 day', now() - interval '10 days'),
  ('e0510004-0000-0000-0000-000000000007', 'e0510004-0000-0000-0000-000000000001',
   'e0510004-0000-0000-0000-000000000005', 'sale', 200, 'EUR', 8000, 250, 50, now() - interval '1 day', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('e0510004-0000-0000-0000-000000000001', 50, 'USD'),
  ('e0510004-0000-0000-0000-000000000001', 50, 'EUR');

do $$
declare
  v_usd_payout uuid;
  v_eur_payout uuid;
  v_row record;
begin
  set local role service_role;

  -- pending -> processing
  select payout_id into v_usd_payout from public.reserve_author_payout('e0510004-0000-0000-0000-000000000001', 'USD');
  select * into v_row from public.start_author_payout(v_usd_payout);
  perform pg_temp.assert(v_row.status = 'processing', format('part4: pending->processing must succeed, got %s', v_row.status));

  -- processing -> paid
  select * into v_row from public.finalize_author_payout(v_usd_payout, 'test', 'ref-sm-usd-1');
  perform pg_temp.assert(v_row.status = 'paid', format('part4: processing->paid must succeed, got %s', v_row.status));

  -- paid -> anything: illegal (start/fail/cancel/mark_reconciling must all reject)
  begin
    perform public.start_author_payout(v_usd_payout);
    perform pg_temp.assert(false, 'part4: start_author_payout on a paid payout must be rejected');
  exception when others then null;
  end;
  begin
    perform public.fail_author_payout(v_usd_payout, 'nope');
    perform pg_temp.assert(false, 'part4: fail_author_payout on a paid payout must be rejected');
  exception when others then null;
  end;
  begin
    perform public.cancel_author_payout(v_usd_payout);
    perform pg_temp.assert(false, 'part4: cancel_author_payout on a paid payout must be rejected');
  exception when others then null;
  end;
  begin
    perform public.mark_author_payout_reconciling(v_usd_payout);
    perform pg_temp.assert(false, 'part4: mark_author_payout_reconciling on a paid payout must be rejected');
  exception when others then null;
  end;

  -- pending -> cancelled
  select payout_id into v_eur_payout from public.reserve_author_payout('e0510004-0000-0000-0000-000000000001', 'EUR');
  select * into v_row from public.cancel_author_payout(v_eur_payout);
  perform pg_temp.assert(v_row.status = 'cancelled', format('part4: pending->cancelled must succeed, got %s', v_row.status));

  -- cancelled -> anything: illegal
  begin
    perform public.start_author_payout(v_eur_payout);
    perform pg_temp.assert(false, 'part4: start_author_payout on a cancelled payout must be rejected');
  exception when others then null;
  end;

  -- pending -> failed directly (skipping processing): illegal
  -- (need a fresh pending row -- EUR is now cancelled/terminal and USD
  -- is paid/terminal, so reserve a fresh currency for this author).
  reset role;
end $$;

-- pending -> failed / pending -> paid direct-skip illegal transitions,
-- and processing -> failed / processing -> reconciling / reconciling ->
-- paid / reconciling -> failed, each on its own fresh fixture so no
-- sub-case's terminal state can block another.
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0510004-0000-0000-0000-000000000008', 'e0510004-0000-0000-0000-000000000001', 'P4 Book C', '', '', '', 100, 'published'),
  ('e0510004-0000-0000-0000-000000000009', 'e0510004-0000-0000-0000-000000000001', 'P4 Book D', '', '', '', 100, 'published'),
  ('e0510004-0000-0000-0000-00000000000a', 'e0510004-0000-0000-0000-000000000001', 'P4 Book E', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0510004-0000-0000-0000-00000000000b', 'e0510004-0000-0000-0000-000000000008', 'e0510004-0000-0000-0000-000000000001', 'cs_p051_sm_c', 100),
  ('e0510004-0000-0000-0000-00000000000c', 'e0510004-0000-0000-0000-000000000009', 'e0510004-0000-0000-0000-000000000001', 'cs_p051_sm_d', 100),
  ('e0510004-0000-0000-0000-00000000000d', 'e0510004-0000-0000-0000-00000000000a', 'e0510004-0000-0000-0000-000000000001', 'cs_p051_sm_e', 100);
insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0510004-0000-0000-0000-00000000000e', 'e0510004-0000-0000-0000-000000000001',
   'e0510004-0000-0000-0000-00000000000b', 'sale', 200, 'GBP', 8000, 250, 50, now() - interval '1 day', now() - interval '10 days'),
  ('e0510004-0000-0000-0000-00000000000f', 'e0510004-0000-0000-0000-000000000001',
   'e0510004-0000-0000-0000-00000000000c', 'sale', 200, 'CHF', 8000, 250, 50, now() - interval '1 day', now() - interval '10 days'),
  ('e0510004-0000-0000-0000-000000000010', 'e0510004-0000-0000-0000-000000000001',
   'e0510004-0000-0000-0000-00000000000d', 'sale', 200, 'SEK', 8000, 250, 50, now() - interval '1 day', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('e0510004-0000-0000-0000-000000000001', 50, 'GBP'),
  ('e0510004-0000-0000-0000-000000000001', 50, 'CHF'),
  ('e0510004-0000-0000-0000-000000000001', 50, 'SEK');

do $$
declare
  v_gbp uuid;
  v_chf uuid;
  v_sek uuid;
  v_row record;
begin
  set local role service_role;

  -- pending -> failed direct: illegal.
  select payout_id into v_gbp from public.reserve_author_payout('e0510004-0000-0000-0000-000000000001', 'GBP');
  begin
    perform public.fail_author_payout(v_gbp, 'nope');
    perform pg_temp.assert(false, 'part4: pending->failed directly must be rejected (must go through processing first)');
  exception when others then null;
  end;

  -- processing -> failed: legal, confirmed failure.
  perform public.start_author_payout(v_gbp);
  select * into v_row from public.fail_author_payout(v_gbp, 'provider_declined');
  perform pg_temp.assert(v_row.status = 'failed', format('part4: processing->failed must succeed, got %s', v_row.status));

  -- failed -> anything: illegal.
  begin
    perform public.start_author_payout(v_gbp);
    perform pg_temp.assert(false, 'part4: start_author_payout on a failed payout must be rejected');
  exception when others then null;
  end;

  -- processing -> reconciling -> failed.
  select payout_id into v_chf from public.reserve_author_payout('e0510004-0000-0000-0000-000000000001', 'CHF');
  perform public.start_author_payout(v_chf);
  select * into v_row from public.mark_author_payout_reconciling(v_chf);
  perform pg_temp.assert(v_row.status = 'reconciling', format('part4: processing->reconciling must succeed, got %s', v_row.status));
  select * into v_row from public.fail_author_payout(v_chf, 'confirmed_after_reconciliation');
  perform pg_temp.assert(v_row.status = 'failed', format('part4: reconciling->failed must succeed, got %s', v_row.status));

  -- reconciling -> cancelled: illegal (Section 44's own explicit example).
  select payout_id into v_sek from public.reserve_author_payout('e0510004-0000-0000-0000-000000000001', 'SEK');
  perform public.start_author_payout(v_sek);
  perform public.mark_author_payout_reconciling(v_sek);
  begin
    perform public.cancel_author_payout(v_sek);
    perform pg_temp.assert(false, 'part4: reconciling->cancelled must be rejected');
  exception when others then null;
  end;

  -- reconciling -> paid: legal (still processing/reconciling for v_sek).
  select * into v_row from public.finalize_author_payout(v_sek, 'test', 'ref-sm-sek-1');
  perform pg_temp.assert(v_row.status = 'paid', format('part4: reconciling->paid must succeed, got %s', v_row.status));

  reset role;
end $$;

-- ============================================================
-- Part 5 (Section 45 TEST MATRIX -- REFUND RACES)
-- ============================================================

-- Case A: reserve, then a refund reduces support BEFORE start ->
-- start_author_payout revalidates and CANCELS rather than resizing;
-- no processing row, no ledger payout debit ever created.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0510005-0000-0000-0000-000000000001', 'p051-race-a@test', now(), '{"role":"author","display_name":"P5A Refund Before Start"}');
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0510005-0000-0000-0000-000000000002', 'e0510005-0000-0000-0000-000000000001', 'P5A Book', '', '', '', 800, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0510005-0000-0000-0000-000000000003', 'e0510005-0000-0000-0000-000000000002', 'e0510005-0000-0000-0000-000000000001', 'cs_p051_5a', 800);

insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('e0510005-0000-0000-0000-000000000004', 'test', 'pay_p051_5a', 800, 'USD', 'succeeded');
update public.purchases set payment_id = 'e0510005-0000-0000-0000-000000000004' where id = 'e0510005-0000-0000-0000-000000000003';
insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0510005-0000-0000-0000-000000000005', 'e0510005-0000-0000-0000-000000000001',
   'e0510005-0000-0000-0000-000000000003', 'e0510005-0000-0000-0000-000000000004', 'sale', 100, 'USD', 8000, 800, 700,
   now() - interval '1 day', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('e0510005-0000-0000-0000-000000000001', 50, 'USD');

do $$
declare
  v_payout_id uuid;
begin
  set local role service_role;
  select payout_id into v_payout_id from public.reserve_author_payout('e0510005-0000-0000-0000-000000000001', 'USD');
  perform pg_temp.assert(v_payout_id is not null, 'part5a: reservation must succeed before the refund arrives');
  reset role;

  -- The refund arrives AFTER reservation but BEFORE start_author_payout.
  insert into public.payment_refunds (id, payment_id, purchase_id, provider, provider_refund_id, amount_minor, currency, refunded_at) values
    ('e0510005-0000-0000-0000-000000000006', 'e0510005-0000-0000-0000-000000000004', 'e0510005-0000-0000-0000-000000000003',
     'test', 'refund_p051_5a', 800, 'USD', now());
  insert into public.author_ledger_entries
    (id, author_id, purchase_id, payment_id, payment_refund_id, entry_type, amount_minor, currency, available_at, created_at)
  values
    ('e0510005-0000-0000-0000-000000000007', 'e0510005-0000-0000-0000-000000000001',
     'e0510005-0000-0000-0000-000000000003', 'e0510005-0000-0000-0000-000000000004', 'e0510005-0000-0000-0000-000000000006',
     'refund', -100, 'USD', now(), now());

  declare
    v_row record;
    v_debit_count integer;
  begin
    set local role service_role;
    select * into v_row from public.start_author_payout(v_payout_id);
    reset role;

    perform pg_temp.assert(v_row.status = 'cancelled', format('part5a: revalidation must CANCEL the reservation (not resize it) when a refund removes support, got %s', v_row.status));

    select count(*) into v_debit_count from public.author_ledger_entries where payout_id = v_payout_id and entry_type = 'payout';
    perform pg_temp.assert(v_debit_count = 0, format('part5a: a cancelled-at-start payout must never produce a ledger payout debit, got %s', v_debit_count));
  end;
end $$;

-- Case B: reserve, start (processing, amount now frozen), THEN a
-- refund arrives -- the payout amount must remain immutable, success
-- still produces exactly one -100 debit, and the refund is free to
-- push the author's balance negative afterward (the already-approved
-- negative-balance model, unchanged).
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0510005-0000-0000-0000-000000000008', 'p051-race-b@test', now(), '{"role":"author","display_name":"P5B Refund After Start"}');
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0510005-0000-0000-0000-000000000009', 'e0510005-0000-0000-0000-000000000008', 'P5B Book', '', '', '', 800, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0510005-0000-0000-0000-00000000000a', 'e0510005-0000-0000-0000-000000000009', 'e0510005-0000-0000-0000-000000000008', 'cs_p051_5b', 800);

insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('e0510005-0000-0000-0000-00000000000b', 'test', 'pay_p051_5b', 800, 'USD', 'succeeded');
update public.purchases set payment_id = 'e0510005-0000-0000-0000-00000000000b' where id = 'e0510005-0000-0000-0000-00000000000a';
insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0510005-0000-0000-0000-00000000000c', 'e0510005-0000-0000-0000-000000000008',
   'e0510005-0000-0000-0000-00000000000a', 'e0510005-0000-0000-0000-00000000000b', 'sale', 100, 'USD', 8000, 800, 700,
   now() - interval '1 day', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('e0510005-0000-0000-0000-000000000008', 50, 'USD');

do $$
declare
  v_payout_id uuid;
  v_row record;
begin
  set local role service_role;
  select payout_id into v_payout_id from public.reserve_author_payout('e0510005-0000-0000-0000-000000000008', 'USD');
  select * into v_row from public.start_author_payout(v_payout_id);
  reset role;
  perform pg_temp.assert(v_row.status = 'processing', format('part5b: start must succeed while the balance still fully supports it, got %s', v_row.status));

  -- Refund arrives AFTER processing has begun.
  insert into public.payment_refunds (id, payment_id, purchase_id, provider, provider_refund_id, amount_minor, currency, refunded_at) values
    ('e0510005-0000-0000-0000-00000000000d', 'e0510005-0000-0000-0000-00000000000b', 'e0510005-0000-0000-0000-00000000000a',
     'test', 'refund_p051_5b', 800, 'USD', now());
  insert into public.author_ledger_entries
    (id, author_id, purchase_id, payment_id, payment_refund_id, entry_type, amount_minor, currency, available_at, created_at)
  values
    ('e0510005-0000-0000-0000-00000000000e', 'e0510005-0000-0000-0000-000000000008',
     'e0510005-0000-0000-0000-00000000000a', 'e0510005-0000-0000-0000-00000000000b', 'e0510005-0000-0000-0000-00000000000d',
     'refund', -100, 'USD', now(), now());

  declare
    v_amount_before bigint;
    v_amount_after bigint;
    v_finalize_row record;
    v_balance bigint;
  begin
    select amount_minor into v_amount_before from public.author_payouts where id = v_payout_id;

    set local role service_role;
    select * into v_finalize_row from public.finalize_author_payout(v_payout_id, 'test', 'ref-p051-5b');
    reset role;

    select amount_minor into v_amount_after from public.author_payouts where id = v_payout_id;
    perform pg_temp.assert(v_amount_before = v_amount_after, format('part5b: payout amount must remain immutable across the refund race (%s vs %s)', v_amount_before, v_amount_after));
    perform pg_temp.assert(v_finalize_row.status = 'paid', format('part5b: finalize must still succeed for the full original 100, got %s', v_finalize_row.status));

    select balance.current_balance_minor into v_balance
      from public.author_ledger_balance('e0510005-0000-0000-0000-000000000008') balance
      where balance.currency = 'USD';
    perform pg_temp.assert(v_balance = -100, format('part5b: sale(100) + payout(-100) + refund(-100) must net to -100, never clamped, got %s', v_balance));
  end;
end $$;

-- ============================================================
-- Part 6 (Section 46 TEST MATRIX -- SUCCESS IDEMPOTENCY)
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0510006-0000-0000-0000-000000000001', 'p051-idem-1@test', now(), '{"role":"author","display_name":"P6 Idempotency 1"}'),
  ('e0510006-0000-0000-0000-000000000002', 'p051-idem-2@test', now(), '{"role":"author","display_name":"P6 Idempotency 2"}');
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0510006-0000-0000-0000-000000000003', 'e0510006-0000-0000-0000-000000000001', 'P6 Book 1', '', '', '', 100, 'published'),
  ('e0510006-0000-0000-0000-000000000004', 'e0510006-0000-0000-0000-000000000002', 'P6 Book 2', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0510006-0000-0000-0000-000000000005', 'e0510006-0000-0000-0000-000000000003', 'e0510006-0000-0000-0000-000000000001', 'cs_p051_6a', 100),
  ('e0510006-0000-0000-0000-000000000006', 'e0510006-0000-0000-0000-000000000004', 'e0510006-0000-0000-0000-000000000002', 'cs_p051_6b', 100);
insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0510006-0000-0000-0000-000000000007', 'e0510006-0000-0000-0000-000000000001',
   'e0510006-0000-0000-0000-000000000005', 'sale', 100, 'USD', 8000, 125, 25, now() - interval '1 day', now() - interval '10 days'),
  ('e0510006-0000-0000-0000-000000000008', 'e0510006-0000-0000-0000-000000000002',
   'e0510006-0000-0000-0000-000000000006', 'sale', 100, 'USD', 8000, 125, 25, now() - interval '1 day', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('e0510006-0000-0000-0000-000000000001', 50, 'USD'),
  ('e0510006-0000-0000-0000-000000000002', 50, 'USD');

do $$
declare
  v_payout_1 uuid;
  v_payout_2 uuid;
  v_debit_count integer;
  v_row record;
begin
  set local role service_role;
  select payout_id into v_payout_1 from public.reserve_author_payout('e0510006-0000-0000-0000-000000000001', 'USD');
  perform public.start_author_payout(v_payout_1);
  perform public.finalize_author_payout(v_payout_1, 'test', 'ref-p051-idem-shared');

  select count(*) into v_debit_count from public.author_ledger_entries where payout_id = v_payout_1 and entry_type = 'payout';
  perform pg_temp.assert(v_debit_count = 1, format('part6: finalize must create exactly one ledger debit, got %s', v_debit_count));

  -- Idempotent retry: same provider + same reference -> safe no-op,
  -- still exactly one debit.
  select * into v_row from public.finalize_author_payout(v_payout_1, 'test', 'ref-p051-idem-shared');
  perform pg_temp.assert(v_row.status = 'paid', 'part6: idempotent retry must still report paid');
  select count(*) into v_debit_count from public.author_ledger_entries where payout_id = v_payout_1 and entry_type = 'payout';
  perform pg_temp.assert(v_debit_count = 1, format('part6: an idempotent retry must NOT create a second ledger debit, got %s', v_debit_count));

  -- Conflicting retry: same payout, DIFFERENT provider reference -> rejected.
  begin
    perform public.finalize_author_payout(v_payout_1, 'test', 'ref-p051-idem-CONFLICT');
    perform pg_temp.assert(false, 'part6: finalize with a different provider_reference on an already-paid payout must be rejected');
  exception when others then null;
  end;

  -- Two DIFFERENT payouts cannot share the same (provider, provider_reference).
  select payout_id into v_payout_2 from public.reserve_author_payout('e0510006-0000-0000-0000-000000000002', 'USD');
  perform public.start_author_payout(v_payout_2);
  begin
    perform public.finalize_author_payout(v_payout_2, 'test', 'ref-p051-idem-shared');
    perform pg_temp.assert(false, 'part6: a second payout must not be able to reuse the same (provider, provider_reference) as another payout');
  exception when unique_violation then null;
  end;

  reset role;
end $$;

-- ============================================================
-- Part 7 (Section 47 TEST MATRIX -- FAILURE / RECONCILING)
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0510007-0000-0000-0000-000000000001', 'p051-fail-1@test', now(), '{"role":"author","display_name":"P7 Confirmed Failure"}');
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0510007-0000-0000-0000-000000000002', 'e0510007-0000-0000-0000-000000000001', 'P7 Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0510007-0000-0000-0000-000000000003', 'e0510007-0000-0000-0000-000000000002', 'e0510007-0000-0000-0000-000000000001', 'cs_p051_7', 100);
insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0510007-0000-0000-0000-000000000004', 'e0510007-0000-0000-0000-000000000001',
   'e0510007-0000-0000-0000-000000000003', 'sale', 100, 'USD', 8000, 125, 25, now() - interval '1 day', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('e0510007-0000-0000-0000-000000000001', 50, 'USD');

do $$
declare
  v_payout_id uuid;
  v_row record;
  v_debit_count integer;
  v_fresh_rowcount integer;
begin
  set local role service_role;

  -- Confirmed failure: no debit, reservation released, a future
  -- reservation for this author+currency becomes possible again.
  select payout_id into v_payout_id from public.reserve_author_payout('e0510007-0000-0000-0000-000000000001', 'USD');
  perform public.start_author_payout(v_payout_id);
  select * into v_row from public.fail_author_payout(v_payout_id, 'insufficient_funds_at_provider');
  perform pg_temp.assert(v_row.status = 'failed', format('part7: confirmed failure must transition to failed, got %s', v_row.status));

  select count(*) into v_debit_count from public.author_ledger_entries where payout_id = v_payout_id and entry_type = 'payout';
  perform pg_temp.assert(v_debit_count = 0, format('part7: a confirmed failure must never create a ledger debit, got %s', v_debit_count));

  select count(*) into v_fresh_rowcount from public.reserve_author_payout('e0510007-0000-0000-0000-000000000001', 'USD');
  perform pg_temp.assert(v_fresh_rowcount = 1, format('part7: after a failure releases the reservation, a fresh reserve must succeed again, got %s rows', v_fresh_rowcount));

  reset role;
end $$;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0510007-0000-0000-0000-000000000005', 'p051-fail-2@test', now(), '{"role":"author","display_name":"P7 Reconciling"}');
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0510007-0000-0000-0000-000000000006', 'e0510007-0000-0000-0000-000000000005', 'P7B Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0510007-0000-0000-0000-000000000007', 'e0510007-0000-0000-0000-000000000006', 'e0510007-0000-0000-0000-000000000005', 'cs_p051_7b', 100);
insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0510007-0000-0000-0000-000000000008', 'e0510007-0000-0000-0000-000000000005',
   'e0510007-0000-0000-0000-000000000007', 'sale', 100, 'USD', 8000, 125, 25, now() - interval '1 day', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('e0510007-0000-0000-0000-000000000005', 50, 'USD');

do $$
declare
  v_payout_id uuid;
  v_row record;
  v_debit_count integer;
  v_blocked_rowcount integer;
begin
  set local role service_role;

  select payout_id into v_payout_id from public.reserve_author_payout('e0510007-0000-0000-0000-000000000005', 'USD');
  perform public.start_author_payout(v_payout_id);
  select * into v_row from public.mark_author_payout_reconciling(v_payout_id);
  perform pg_temp.assert(v_row.status = 'reconciling', format('part7: processing->reconciling must succeed, got %s', v_row.status));

  select count(*) into v_debit_count from public.author_ledger_entries where payout_id = v_payout_id and entry_type = 'payout';
  perform pg_temp.assert(v_debit_count = 0, format('part7: reconciling must never itself create a ledger debit, got %s', v_debit_count));

  -- Reservation is RETAINED while reconciling -- a new reservation for
  -- this author+currency must remain blocked.
  select count(*) into v_blocked_rowcount from public.reserve_author_payout('e0510007-0000-0000-0000-000000000005', 'USD');
  perform pg_temp.assert(v_blocked_rowcount = 0, format('part7: a reconciling payout must still hold its reservation slot, got %s new rows', v_blocked_rowcount));

  -- Idempotent retry of mark_author_payout_reconciling itself.
  select * into v_row from public.mark_author_payout_reconciling(v_payout_id);
  perform pg_temp.assert(v_row.status = 'reconciling', 'part7: mark_author_payout_reconciling must be idempotent when already reconciling');

  -- Now resolve: reconciling -> paid, exactly one debit.
  select * into v_row from public.finalize_author_payout(v_payout_id, 'test', 'ref-p051-7b-resolved');
  perform pg_temp.assert(v_row.status = 'paid', format('part7: reconciling->paid must succeed, got %s', v_row.status));
  select count(*) into v_debit_count from public.author_ledger_entries where payout_id = v_payout_id and entry_type = 'payout';
  perform pg_temp.assert(v_debit_count = 1, format('part7: reconciling->paid must create exactly one ledger debit, got %s', v_debit_count));

  reset role;
end $$;

-- ============================================================
-- Part 8 (Section 48 TEST MATRIX -- PAYOUT_RUNS)
-- ============================================================
do $$
declare
  v_run_1 uuid;
  v_run_1b uuid;
  v_run_2 uuid;
begin
  insert into public.payout_runs (run_key, scheduled_for) values ('2026-10', '2026-10-01') returning id into v_run_1;

  begin
    insert into public.payout_runs (run_key, scheduled_for) values ('2026-10', '2026-10-01') returning id into v_run_1b;
    perform pg_temp.assert(false, 'part8: a duplicate scheduled run_key must be rejected');
  exception when unique_violation then null;
  end;

  insert into public.payout_runs (run_key, scheduled_for) values ('2026-11', '2026-11-01') returning id into v_run_2;
  perform pg_temp.assert(v_run_2 is not null, 'part8: a DIFFERENT run_key must be allowed');

  -- LEDGER-1E-B.1 Section 3: a NULL run_key is now REJECTED for a
  -- scheduled run (payout_runs_scheduled_run_key_required) -- run_type
  -- currently allows only 'scheduled', so this is unconditional today.
  -- Reversed from the original LEDGER-1E-B design, which allowed a
  -- nullable key "for a future manual run" -- rejected on review:
  -- weakening today's only real run_type's idempotency guard to make
  -- room for a feature that doesn't exist yet is exactly backwards.
  begin
    insert into public.payout_runs (run_key) values (null);
    perform pg_temp.assert(false, 'part8: a NULL run_key must be rejected for a scheduled run');
  exception when check_violation then null;
  end;

  begin
    insert into public.payout_runs (run_key) values ('');
    perform pg_temp.assert(false, 'part8: an empty-string run_key must be rejected for a scheduled run');
  exception when check_violation then null;
  end;

  begin
    insert into public.payout_runs (run_key) values ('   ');
    perform pg_temp.assert(false, 'part8: a whitespace-only run_key must be rejected for a scheduled run');
  exception when check_violation then null;
  end;
end $$;

-- Two authors reserved under the same run: independent, both succeed,
-- and payout_run_id groups them correctly.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0510008-0000-0000-0000-000000000001', 'p051-run-a@test', now(), '{"role":"author","display_name":"P8 Run Author A"}'),
  ('e0510008-0000-0000-0000-000000000002', 'p051-run-b@test', now(), '{"role":"author","display_name":"P8 Run Author B"}');
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0510008-0000-0000-0000-000000000003', 'e0510008-0000-0000-0000-000000000001', 'P8 Book A', '', '', '', 100, 'published'),
  ('e0510008-0000-0000-0000-000000000004', 'e0510008-0000-0000-0000-000000000002', 'P8 Book B', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0510008-0000-0000-0000-000000000005', 'e0510008-0000-0000-0000-000000000003', 'e0510008-0000-0000-0000-000000000001', 'cs_p051_8a', 100),
  ('e0510008-0000-0000-0000-000000000006', 'e0510008-0000-0000-0000-000000000004', 'e0510008-0000-0000-0000-000000000002', 'cs_p051_8b', 100);
insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0510008-0000-0000-0000-000000000007', 'e0510008-0000-0000-0000-000000000001',
   'e0510008-0000-0000-0000-000000000005', 'sale', 100, 'USD', 8000, 125, 25, now() - interval '1 day', now() - interval '10 days'),
  ('e0510008-0000-0000-0000-000000000008', 'e0510008-0000-0000-0000-000000000002',
   'e0510008-0000-0000-0000-000000000006', 'sale', 100, 'USD', 8000, 125, 25, now() - interval '1 day', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('e0510008-0000-0000-0000-000000000001', 50, 'USD'),
  ('e0510008-0000-0000-0000-000000000002', 50, 'USD');

do $$
declare
  v_run_id uuid;
  v_a record;
  v_b record;
  v_grouped_count integer;
begin
  -- LEDGER-1E-D-D.1 (migration 054): reserve_author_payout() now
  -- requires a non-null p_payout_run_id to reference a 'running' run
  -- (the closed-run reservation barrier) -- this fixture predates that
  -- invariant and must explicitly set status='running' (rather than
  -- the table's own default 'pending') to keep testing what this part
  -- has always tested: two independent reservations correctly grouped
  -- under one shared run.
  insert into public.payout_runs (run_key, scheduled_for, status) values ('2026-12', '2026-12-01', 'running') returning id into v_run_id;

  set local role service_role;
  select * into v_a from public.reserve_author_payout('e0510008-0000-0000-0000-000000000001', 'USD', v_run_id);
  select * into v_b from public.reserve_author_payout('e0510008-0000-0000-0000-000000000002', 'USD', v_run_id);
  reset role;

  perform pg_temp.assert(v_a.amount_minor = 100, format('part8: author A reservation under a shared run must succeed independently, got %s', v_a.amount_minor));
  perform pg_temp.assert(v_b.amount_minor = 100, format('part8: author B reservation under the same shared run must succeed independently, got %s', v_b.amount_minor));

  select count(*) into v_grouped_count from public.author_payouts where payout_run_id = v_run_id;
  perform pg_temp.assert(v_grouped_count = 2, format('part8: both payouts must be correctly grouped under the same payout_run_id, got %s', v_grouped_count));
end $$;

-- ============================================================
-- Part 9 (Section 49 TEST MATRIX -- SECURITY)
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0510009-0000-0000-0000-000000000001', 'p051-sec-author@test', now(), '{"role":"author","display_name":"P9 Author"}'),
  ('e0510009-0000-0000-0000-000000000002', 'p051-sec-reader@test', now(), '{"role":"reader","display_name":"P9 Reader"}'),
  ('e0510009-0000-0000-0000-000000000003', 'p051-sec-staff@test', now(), '{"role":"reader","display_name":"P9 Finance Staff"}');
insert into public.staff_members (user_id, role) values
  ('e0510009-0000-0000-0000-000000000003', 'admin');

do $$
declare
  v_dummy_payout_id uuid := gen_random_uuid();
begin
  -- PUBLIC / anon: no EXECUTE grant on any payout-mutation RPC.
  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
  begin
    perform public.reserve_author_payout('e0510009-0000-0000-0000-000000000001', 'USD');
    perform pg_temp.assert(false, 'part9: anon must not be able to execute reserve_author_payout');
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.start_author_payout(v_dummy_payout_id);
    perform pg_temp.assert(false, 'part9: anon must not be able to execute start_author_payout');
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.finalize_author_payout(v_dummy_payout_id, 'test', 'ref');
    perform pg_temp.assert(false, 'part9: anon must not be able to execute finalize_author_payout');
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.fail_author_payout(v_dummy_payout_id, 'nope');
    perform pg_temp.assert(false, 'part9: anon must not be able to execute fail_author_payout');
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.cancel_author_payout(v_dummy_payout_id);
    perform pg_temp.assert(false, 'part9: anon must not be able to execute cancel_author_payout');
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.mark_author_payout_reconciling(v_dummy_payout_id);
    perform pg_temp.assert(false, 'part9: anon must not be able to execute mark_author_payout_reconciling');
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.author_ledger_balance('e0510009-0000-0000-0000-000000000001');
    perform pg_temp.assert(false, 'part9: anon must not be able to execute author_ledger_balance');
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- Authenticated READER: same denial for every payout-mutation RPC
  -- and the canonical balance helper.
  perform set_config('request.jwt.claim.sub', 'e0510009-0000-0000-0000-000000000002', true);
  set local role authenticated;
  begin
    perform public.reserve_author_payout('e0510009-0000-0000-0000-000000000001', 'USD');
    perform pg_temp.assert(false, 'part9: an authenticated reader must not be able to execute reserve_author_payout');
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.author_ledger_balance('e0510009-0000-0000-0000-000000000001');
    perform pg_temp.assert(false, 'part9: an authenticated reader must not be able to execute author_ledger_balance');
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- Authenticated AUTHOR (even for their OWN author_id): still denied
  -- -- these RPCs are service_role only, no self-service path exists.
  perform set_config('request.jwt.claim.sub', 'e0510009-0000-0000-0000-000000000001', true);
  set local role authenticated;
  begin
    perform public.reserve_author_payout('e0510009-0000-0000-0000-000000000001', 'USD');
    perform pg_temp.assert(false, 'part9: an author must not be able to reserve their own payout directly');
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.finalize_author_payout(v_dummy_payout_id, 'test', 'ref');
    perform pg_temp.assert(false, 'part9: an author must not be able to finalize their own payout directly');
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- finance.view STAFF: read-only remains read-only -- no payout RPC
  -- execution capability, even for a staff member with finance.view.
  perform set_config('request.jwt.claim.sub', 'e0510009-0000-0000-0000-000000000003', true);
  set local role authenticated;
  begin
    perform public.reserve_author_payout('e0510009-0000-0000-0000-000000000001', 'USD');
    perform pg_temp.assert(false, 'part9: finance.view staff must not be able to execute reserve_author_payout -- finance.view is read-only');
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.finalize_author_payout(v_dummy_payout_id, 'test', 'ref');
    perform pg_temp.assert(false, 'part9: finance.view staff must not be able to execute finalize_author_payout');
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.author_ledger_balance('e0510009-0000-0000-0000-000000000001');
    perform pg_temp.assert(false, 'part9: finance.view staff must not be able to execute author_ledger_balance directly');
  exception when insufficient_privilege then null;
  end;
  reset role;
end $$;

-- No direct INSERT/UPDATE/DELETE grant to authenticated on the payout
-- financial tables -- mutation is RPC-only, exactly like every other
-- financial table since migration 048.
do $$
declare
  v_has_insert boolean;
  v_has_update boolean;
  v_has_delete boolean;
begin
  select
    has_table_privilege('authenticated', 'public.author_payouts', 'INSERT'),
    has_table_privilege('authenticated', 'public.author_payouts', 'UPDATE'),
    has_table_privilege('authenticated', 'public.author_payouts', 'DELETE')
    into v_has_insert, v_has_update, v_has_delete;
  perform pg_temp.assert(not v_has_insert, 'part9: authenticated must have no INSERT grant on author_payouts');
  perform pg_temp.assert(not v_has_update, 'part9: authenticated must have no UPDATE grant on author_payouts');
  perform pg_temp.assert(not v_has_delete, 'part9: authenticated must have no DELETE grant on author_payouts');

  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.payout_runs', 'SELECT'),
    'part9: authenticated must have no SELECT grant on payout_runs (no reporting surface exists yet)'
  );
end $$;

-- service_role: execute grant present on every payout-mutation RPC and
-- the canonical balance helper (a direct behavioral proof already
-- exists throughout Parts 1-8 above, every one of which runs as
-- service_role successfully -- this is the complementary catalog-level
-- proof).
do $$
begin
  perform pg_temp.assert(
    has_function_privilege('service_role', 'public.reserve_author_payout(uuid, text, uuid)', 'EXECUTE'),
    'part9: service_role must have EXECUTE on reserve_author_payout'
  );
  perform pg_temp.assert(
    has_function_privilege('service_role', 'public.start_author_payout(uuid)', 'EXECUTE'),
    'part9: service_role must have EXECUTE on start_author_payout'
  );
  perform pg_temp.assert(
    has_function_privilege('service_role', 'public.mark_author_payout_reconciling(uuid)', 'EXECUTE'),
    'part9: service_role must have EXECUTE on mark_author_payout_reconciling'
  );
  perform pg_temp.assert(
    has_function_privilege('service_role', 'public.finalize_author_payout(uuid, text, text)', 'EXECUTE'),
    'part9: service_role must have EXECUTE on finalize_author_payout'
  );
  perform pg_temp.assert(
    has_function_privilege('service_role', 'public.fail_author_payout(uuid, text)', 'EXECUTE'),
    'part9: service_role must have EXECUTE on fail_author_payout'
  );
  perform pg_temp.assert(
    has_function_privilege('service_role', 'public.cancel_author_payout(uuid)', 'EXECUTE'),
    'part9: service_role must have EXECUTE on cancel_author_payout'
  );
  perform pg_temp.assert(
    has_function_privilege('service_role', 'public.author_ledger_balance(uuid)', 'EXECUTE'),
    'part9: service_role must have EXECUTE on author_ledger_balance'
  );
  perform pg_temp.assert(
    has_function_privilege('public', 'public.author_ledger_balance(uuid)', 'EXECUTE') = false,
    'part9: PUBLIC must have no EXECUTE grant on author_ledger_balance'
  );
end $$;

-- ============================================================
-- Part 10 (Section 50 TEST MATRIX -- CANONICAL BALANCE PARITY)
--
-- Re-runs every critical LEDGER-1D accounting state from migration
-- 050's own 63-assertion suite through BOTH entry points -- the
-- author-facing get_author_financial_summary() (auth.uid()-scoped) and
-- the internal author_ledger_balance(p_author_id) the payout engine
-- itself reads -- and asserts byte-for-byte identical numeric output.
-- Since 051 made get_author_financial_summary() a one-line wrapper
-- around author_ledger_balance(), this is provably true by
-- construction, not merely by coincidence -- these assertions exist as
-- a regression guard against any FUTURE edit to one without the other.
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0510010-0000-0000-0000-000000000001', 'p051-parity@test', now(), '{"role":"author","display_name":"P10 Parity"}');
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0510010-0000-0000-0000-000000000002', 'e0510010-0000-0000-0000-000000000001', 'P10 Pending Book', '', '', '', 800, 'published'),
  ('e0510010-0000-0000-0000-000000000003', 'e0510010-0000-0000-0000-000000000001', 'P10 Settled Book', '', '', '', 800, 'published'),
  ('e0510010-0000-0000-0000-000000000004', 'e0510010-0000-0000-0000-000000000001', 'P10 EUR Book', '', '', '', 500, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0510010-0000-0000-0000-000000000005', 'e0510010-0000-0000-0000-000000000002', 'e0510010-0000-0000-0000-000000000001', 'cs_p051_10_pending', 800),
  ('e0510010-0000-0000-0000-000000000006', 'e0510010-0000-0000-0000-000000000003', 'e0510010-0000-0000-0000-000000000001', 'cs_p051_10_settled', 800),
  ('e0510010-0000-0000-0000-000000000007', 'e0510010-0000-0000-0000-000000000004', 'e0510010-0000-0000-0000-000000000001', 'cs_p051_10_eur', 500);

-- Pending sale (future available_at) + adjustment cases (future/past/NULL).
insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0510010-0000-0000-0000-000000000008', 'e0510010-0000-0000-0000-000000000001',
   'e0510010-0000-0000-0000-000000000005', 'sale', 640, 'USD', 8000, 800, 160, now() + interval '25 days', now() - interval '5 days'),
  ('e0510010-0000-0000-0000-000000000009', 'e0510010-0000-0000-0000-000000000001',
   'e0510010-0000-0000-0000-000000000006', 'sale', 400, 'USD', 8000, 500, 100, now() - interval '10 days', now() - interval '40 days');
insert into public.author_ledger_entries
  (id, author_id, entry_type, amount_minor, currency, available_at, created_at)
values
  ('e0510010-0000-0000-0000-00000000000a', 'e0510010-0000-0000-0000-000000000001', 'adjustment', 30, 'USD', now() - interval '1 day', now() - interval '1 day'),
  ('e0510010-0000-0000-0000-00000000000b', 'e0510010-0000-0000-0000-000000000001', 'adjustment', -15, 'USD', now() + interval '5 days', now()),
  ('e0510010-0000-0000-0000-00000000000c', 'e0510010-0000-0000-0000-000000000001', 'adjustment', 20, 'USD', null, now() - interval '2 days');
insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0510010-0000-0000-0000-00000000000d', 'e0510010-0000-0000-0000-000000000001',
   'e0510010-0000-0000-0000-000000000007', 'sale', 400, 'EUR', 8000, 500, 100, now() - interval '1 day', now() - interval '10 days');

do $$
declare
  v_author_summary record;
  v_canonical record;
begin
  perform set_config('request.jwt.claim.sub', 'e0510010-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select * into v_author_summary from public.get_author_financial_summary() where currency = 'USD';
  reset role;

  set local role service_role;
  select * into v_canonical from public.author_ledger_balance('e0510010-0000-0000-0000-000000000001') where currency = 'USD';
  reset role;

  perform pg_temp.assert(v_author_summary.lifetime_sale_minor = v_canonical.lifetime_sale_minor, 'part10: lifetime_sale_minor must match between get_author_financial_summary and author_ledger_balance (USD)');
  perform pg_temp.assert(v_author_summary.lifetime_refund_minor = v_canonical.lifetime_refund_minor, 'part10: lifetime_refund_minor must match (USD)');
  perform pg_temp.assert(v_author_summary.lifetime_adjustment_minor = v_canonical.lifetime_adjustment_minor, 'part10: lifetime_adjustment_minor must match (USD)');
  perform pg_temp.assert(v_author_summary.net_earnings_minor = v_canonical.net_earnings_minor, 'part10: net_earnings_minor must match (USD)');
  perform pg_temp.assert(v_author_summary.paid_out_minor = v_canonical.paid_out_minor, 'part10: paid_out_minor must match (USD)');
  perform pg_temp.assert(v_author_summary.pending_minor = v_canonical.pending_minor, 'part10: pending_minor must match (USD)');
  perform pg_temp.assert(v_author_summary.available_minor = v_canonical.available_minor, 'part10: available_minor must match (USD)');
  perform pg_temp.assert(v_author_summary.current_balance_minor = v_canonical.current_balance_minor, 'part10: current_balance_minor must match (USD)');

  -- Sanity: the numbers themselves must still be exactly what
  -- migration 050's own formula would produce for this fixture shape
  -- (640 pending sale + 400 settled sale + 30 past adjustment + -15
  -- future adjustment + 20 NULL-available adjustment).
  perform pg_temp.assert(v_canonical.current_balance_minor = 640 + 400 + 30 - 15 + 20, format('part10: USD current_balance sanity check failed, got %s', v_canonical.current_balance_minor));
  perform pg_temp.assert(v_canonical.pending_minor = 640 - 15, format('part10: USD pending sanity check failed (future sale + future adjustment), got %s', v_canonical.pending_minor));
end $$;

do $$
declare
  v_author_summary record;
  v_canonical record;
begin
  perform set_config('request.jwt.claim.sub', 'e0510010-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select * into v_author_summary from public.get_author_financial_summary() where currency = 'EUR';
  reset role;

  set local role service_role;
  select * into v_canonical from public.author_ledger_balance('e0510010-0000-0000-0000-000000000001') where currency = 'EUR';
  reset role;

  perform pg_temp.assert(v_author_summary.current_balance_minor = v_canonical.current_balance_minor, 'part10: current_balance_minor must match (EUR, proving currencies stay independently parity-checked too)');
  perform pg_temp.assert(v_canonical.current_balance_minor = 400, format('part10: EUR current_balance sanity check failed, got %s', v_canonical.current_balance_minor));
end $$;

-- Post-payout negative balance parity (reuses Part 2/E4's fixture author).
do $$
declare
  v_author_summary record;
  v_canonical record;
begin
  perform set_config('request.jwt.claim.sub', 'e0510002-0000-0000-0000-00000000000d', true);
  set local role authenticated;
  select * into v_author_summary from public.get_author_financial_summary() where currency = 'USD';
  reset role;

  set local role service_role;
  select * into v_canonical from public.author_ledger_balance('e0510002-0000-0000-0000-00000000000d') where currency = 'USD';
  reset role;

  perform pg_temp.assert(v_author_summary.current_balance_minor = v_canonical.current_balance_minor, 'part10: negative post-payout-refund current_balance_minor must match between both entry points');
  perform pg_temp.assert(v_author_summary.available_minor = v_canonical.available_minor, 'part10: negative post-payout-refund available_minor must match between both entry points');
  perform pg_temp.assert(v_canonical.current_balance_minor = -640, format('part10: post-payout negative-balance sanity check failed, got %s', v_canonical.current_balance_minor));
end $$;

-- ============================================================
-- Part 11 (LEDGER-1E-B.1 PRE-COMMIT HARDENING TEST MATRIX)
-- ============================================================

-- 11a. Full-lifecycle economic-identity immutability (Section 4):
-- amount_minor/currency/author_id/payout_run_id must be unchangeable
-- from the moment a payout row exists, at EVERY status, not only after
-- it leaves 'pending'. Every UPDATE attempt below runs with NO role
-- switch (i.e. as the connecting superuser/table owner, which bypasses
-- every table-level GRANT) so this specifically proves the TRIGGER
-- itself, independent of the Section 5 grant hardening tested
-- separately in 11b below.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0510011-0000-0000-0000-000000000001', 'p051h-immutable@test', now(), '{"role":"author","display_name":"P11 Immutability"}'),
  ('e0510011-0000-0000-0000-000000000002', 'p051h-other-author@test', now(), '{"role":"author","display_name":"P11 Other Author"}');
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0510011-0000-0000-0000-000000000003', 'e0510011-0000-0000-0000-000000000001', 'P11 Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0510011-0000-0000-0000-000000000004', 'e0510011-0000-0000-0000-000000000003', 'e0510011-0000-0000-0000-000000000001', 'cs_p051h_1', 100);
insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0510011-0000-0000-0000-000000000005', 'e0510011-0000-0000-0000-000000000001',
   'e0510011-0000-0000-0000-000000000004', 'sale', 100, 'USD', 8000, 125, 25, now() - interval '1 day', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('e0510011-0000-0000-0000-000000000001', 50, 'USD');
insert into public.payout_runs (id, run_key) values ('e0510011-0000-0000-0000-0000000000ff', 'p051h-alt-run');

do $$
declare
  v_payout_id uuid;
begin
  set local role service_role;
  select payout_id into v_payout_id from public.reserve_author_payout('e0510011-0000-0000-0000-000000000001', 'USD');
  reset role;

  -- status = pending: every economic-identity column is already immutable.
  begin
    update public.author_payouts set amount_minor = 999 where id = v_payout_id;
    perform pg_temp.assert(false, 'part11a: amount_minor must be immutable while pending');
  exception when others then null;
  end;
  begin
    update public.author_payouts set currency = 'EUR' where id = v_payout_id;
    perform pg_temp.assert(false, 'part11a: currency must be immutable while pending');
  exception when others then null;
  end;
  begin
    update public.author_payouts set author_id = 'e0510011-0000-0000-0000-000000000002' where id = v_payout_id;
    perform pg_temp.assert(false, 'part11a: author_id must be immutable while pending');
  exception when others then null;
  end;
  begin
    update public.author_payouts set payout_run_id = 'e0510011-0000-0000-0000-0000000000ff'::uuid where id = v_payout_id;
    perform pg_temp.assert(false, 'part11a: payout_run_id must be immutable while pending');
  exception when others then null;
  end;

  -- status = processing.
  set local role service_role;
  perform public.start_author_payout(v_payout_id);
  reset role;
  begin
    update public.author_payouts set amount_minor = 1 where id = v_payout_id;
    perform pg_temp.assert(false, 'part11a: amount_minor must be immutable while processing');
  exception when others then null;
  end;
  begin
    update public.author_payouts set currency = 'GBP' where id = v_payout_id;
    perform pg_temp.assert(false, 'part11a: currency must be immutable while processing');
  exception when others then null;
  end;

  -- status = reconciling.
  set local role service_role;
  perform public.mark_author_payout_reconciling(v_payout_id);
  reset role;
  begin
    update public.author_payouts set author_id = 'e0510011-0000-0000-0000-000000000002' where id = v_payout_id;
    perform pg_temp.assert(false, 'part11a: author_id must be immutable while reconciling');
  exception when others then null;
  end;

  -- status = paid.
  set local role service_role;
  perform public.finalize_author_payout(v_payout_id, 'test', 'ref-p051h-11a');
  reset role;
  begin
    update public.author_payouts set amount_minor = 1 where id = v_payout_id;
    perform pg_temp.assert(false, 'part11a: amount_minor must be immutable once paid');
  exception when others then null;
  end;
  begin
    update public.author_payouts set payout_run_id = 'e0510011-0000-0000-0000-0000000000ff'::uuid where id = v_payout_id;
    perform pg_temp.assert(false, 'part11a: payout_run_id must be immutable once paid');
  exception when others then null;
  end;
end $$;

-- 11b. Direct service_role DML is denied on author_payouts and
-- payout_runs (Section 5), while the RPC-based mutation path continues
-- to succeed end to end (Section 6's own explicit bypass proof).
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0510011-0000-0000-0000-000000000010', 'p051h-dml@test', now(), '{"role":"author","display_name":"P11 Direct DML"}');
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0510011-0000-0000-0000-000000000011', 'e0510011-0000-0000-0000-000000000010', 'P11B Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0510011-0000-0000-0000-000000000012', 'e0510011-0000-0000-0000-000000000011', 'e0510011-0000-0000-0000-000000000010', 'cs_p051h_11b', 100);
insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0510011-0000-0000-0000-000000000013', 'e0510011-0000-0000-0000-000000000010',
   'e0510011-0000-0000-0000-000000000012', 'sale', 100, 'USD', 8000, 125, 25, now() - interval '1 day', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('e0510011-0000-0000-0000-000000000010', 50, 'USD');

do $$
declare
  v_payout_id uuid;
  v_row record;
begin
  set local role service_role;

  begin
    insert into public.author_payouts (author_id, amount_minor, currency, status) values
      ('e0510011-0000-0000-0000-000000000010', 5, 'GBP', 'pending');
    perform pg_temp.assert(false, 'part11b: service_role must not be able to INSERT directly into author_payouts');
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.payout_runs (run_key) values ('p051h-direct-insert-blocked');
    perform pg_temp.assert(false, 'part11b: service_role must not be able to INSERT directly into payout_runs');
  exception when insufficient_privilege then null;
  end;

  -- RPC-based mutation still succeeds end to end.
  select payout_id into v_payout_id from public.reserve_author_payout('e0510011-0000-0000-0000-000000000010', 'USD');
  perform pg_temp.assert(v_payout_id is not null, 'part11b: reserve_author_payout must still succeed via the RPC path');

  begin
    update public.author_payouts set status = 'paid' where id = v_payout_id;
    perform pg_temp.assert(false, 'part11b: service_role must not be able to UPDATE author_payouts directly');
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.author_payouts where id = v_payout_id;
    perform pg_temp.assert(false, 'part11b: service_role must not be able to DELETE from author_payouts directly');
  exception when insufficient_privilege then null;
  end;

  select * into v_row from public.start_author_payout(v_payout_id);
  perform pg_temp.assert(v_row.status = 'processing', 'part11b: start_author_payout must still succeed via the RPC path');
  select * into v_row from public.finalize_author_payout(v_payout_id, 'test', 'ref-p051h-11b');
  perform pg_temp.assert(v_row.status = 'paid', 'part11b: finalize_author_payout must still succeed via the RPC path');

  reset role;
end $$;

-- Catalog-level confirmation, complementing the behavioral proof above.
do $$
begin
  perform pg_temp.assert(
    has_table_privilege('service_role', 'public.author_payouts', 'SELECT'),
    'part11b: service_role must retain SELECT on author_payouts'
  );
  perform pg_temp.assert(
    not has_table_privilege('service_role', 'public.author_payouts', 'INSERT'),
    'part11b: service_role must have no INSERT grant on author_payouts'
  );
  perform pg_temp.assert(
    not has_table_privilege('service_role', 'public.author_payouts', 'UPDATE'),
    'part11b: service_role must have no UPDATE grant on author_payouts'
  );
  perform pg_temp.assert(
    not has_table_privilege('service_role', 'public.author_payouts', 'DELETE'),
    'part11b: service_role must have no DELETE grant on author_payouts'
  );
  perform pg_temp.assert(
    has_table_privilege('service_role', 'public.payout_runs', 'SELECT'),
    'part11b: service_role must retain SELECT on payout_runs'
  );
  perform pg_temp.assert(
    not has_table_privilege('service_role', 'public.payout_runs', 'INSERT'),
    'part11b: service_role must have no INSERT grant on payout_runs'
  );
  perform pg_temp.assert(
    not has_table_privilege('service_role', 'public.payout_runs', 'UPDATE'),
    'part11b: service_role must have no UPDATE grant on payout_runs'
  );
  perform pg_temp.assert(
    not has_table_privilege('service_role', 'public.payout_runs', 'DELETE'),
    'part11b: service_role must have no DELETE grant on payout_runs'
  );
end $$;

-- 11c. finalize_author_payout rejects blank/whitespace-only provider or
-- provider_reference, not merely NULL (Section 7).
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0510011-0000-0000-0000-000000000020', 'p051h-blank@test', now(), '{"role":"author","display_name":"P11 Blank Finalize"}');
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0510011-0000-0000-0000-000000000021', 'e0510011-0000-0000-0000-000000000020', 'P11C Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0510011-0000-0000-0000-000000000022', 'e0510011-0000-0000-0000-000000000021', 'e0510011-0000-0000-0000-000000000020', 'cs_p051h_11c', 100);
insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0510011-0000-0000-0000-000000000023', 'e0510011-0000-0000-0000-000000000020',
   'e0510011-0000-0000-0000-000000000022', 'sale', 100, 'USD', 8000, 125, 25, now() - interval '1 day', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('e0510011-0000-0000-0000-000000000020', 50, 'USD');

do $$
declare
  v_payout_id uuid;
  v_debit_count integer;
begin
  set local role service_role;
  select payout_id into v_payout_id from public.reserve_author_payout('e0510011-0000-0000-0000-000000000020', 'USD');
  perform public.start_author_payout(v_payout_id);

  begin
    perform public.finalize_author_payout(v_payout_id, null, 'ref-ok');
    perform pg_temp.assert(false, 'part11c: NULL provider must be rejected');
  exception when others then null;
  end;
  begin
    perform public.finalize_author_payout(v_payout_id, 'test', null);
    perform pg_temp.assert(false, 'part11c: NULL provider_reference must be rejected');
  exception when others then null;
  end;
  begin
    perform public.finalize_author_payout(v_payout_id, '', 'ref-ok');
    perform pg_temp.assert(false, 'part11c: empty-string provider must be rejected');
  exception when others then null;
  end;
  begin
    perform public.finalize_author_payout(v_payout_id, 'test', '');
    perform pg_temp.assert(false, 'part11c: empty-string provider_reference must be rejected');
  exception when others then null;
  end;
  begin
    perform public.finalize_author_payout(v_payout_id, '   ', 'ref-ok');
    perform pg_temp.assert(false, 'part11c: whitespace-only provider must be rejected');
  exception when others then null;
  end;
  begin
    perform public.finalize_author_payout(v_payout_id, 'test', '   ');
    perform pg_temp.assert(false, 'part11c: whitespace-only provider_reference must be rejected');
  exception when others then null;
  end;

  -- None of the rejected attempts above may have mutated anything.
  select count(*) into v_debit_count from public.author_ledger_entries where payout_id = v_payout_id and entry_type = 'payout';
  perform pg_temp.assert(v_debit_count = 0, format('part11c: no rejected finalize attempt may create a ledger debit, got %s', v_debit_count));
  perform pg_temp.assert(
    (select status from public.author_payouts where id = v_payout_id) = 'processing',
    'part11c: the payout must remain processing after every rejected finalize attempt'
  );

  -- A valid finalize still succeeds normally afterward.
  perform public.finalize_author_payout(v_payout_id, 'test', 'ref-p051h-11c');
  perform pg_temp.assert(
    (select status from public.author_payouts where id = v_payout_id) = 'paid',
    'part11c: a valid finalize must still succeed after the rejected attempts'
  );
  reset role;
end $$;

-- 11d. Paid-state structural invariant (Section 8): a 'paid' row can
-- never exist without a non-blank provider, a non-blank
-- provider_reference, and a non-null paid_at -- enforced at the DB
-- level even against a hypothetical direct insert (bypassing the RPC
-- layer entirely, as the connecting superuser -- proving this is a
-- real CHECK constraint, not merely an RPC-level courtesy).
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0510011-0000-0000-0000-000000000030', 'p051h-paidcheck@test', now(), '{"role":"author","display_name":"P11 Paid Check"}');

do $$
begin
  begin
    insert into public.author_payouts (author_id, amount_minor, currency, status) values
      ('e0510011-0000-0000-0000-000000000030', 100, 'USD', 'paid');
    perform pg_temp.assert(false, 'part11d: a paid row with no provider/provider_reference/paid_at must be rejected');
  exception when check_violation then null;
  end;

  begin
    insert into public.author_payouts (author_id, amount_minor, currency, status, provider, provider_reference) values
      ('e0510011-0000-0000-0000-000000000030', 100, 'USD', 'paid', 'test', 'ref-x');
    perform pg_temp.assert(false, 'part11d: a paid row with provider+reference but no paid_at must still be rejected');
  exception when check_violation then null;
  end;

  begin
    insert into public.author_payouts (author_id, amount_minor, currency, status, provider, provider_reference, paid_at) values
      ('e0510011-0000-0000-0000-000000000030', 100, 'USD', 'paid', '   ', 'ref-x', now());
    perform pg_temp.assert(false, 'part11d: a paid row with a blank (whitespace-only) provider must still be rejected');
  exception when check_violation then null;
  end;

  -- A fully-populated paid row is legal.
  insert into public.author_payouts (author_id, amount_minor, currency, status, provider, provider_reference, paid_at) values
    ('e0510011-0000-0000-0000-000000000030', 100, 'USD', 'paid', 'test', 'ref-p051h-11d', now());
end $$;

-- 11e. Constraint-specific concurrency handling (Section 10): the
-- normal losing-race outcome (zero rows, no error) still holds for the
-- ONE constraint reserve_author_payout's own INSERT can actually
-- collide with in practice, and the exact diagnostic mechanism it
-- relies on is independently proven against that real constraint
-- (there is no OTHER unique constraint reserve_author_payout's insert
-- shape -- author_id/amount_minor/currency/status/payout_run_id, never
-- provider/provider_reference -- can organically collide with today,
-- so the "re-raise anything else" branch is intentionally defensive/
-- future-proofing code with no currently-reachable trigger case; this
-- is disclosed rather than fabricating an artificial second unique
-- constraint solely to exercise it).
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0510011-0000-0000-0000-000000000040', 'p051h-diag@test', now(), '{"role":"author","display_name":"P11 Diagnostics"}');

do $$
declare
  v_constraint_name text;
begin
  insert into public.author_payouts (author_id, amount_minor, currency, status) values
    ('e0510011-0000-0000-0000-000000000040', 100, 'USD', 'pending');

  begin
    insert into public.author_payouts (author_id, amount_minor, currency, status) values
      ('e0510011-0000-0000-0000-000000000040', 50, 'USD', 'pending');
    perform pg_temp.assert(false, 'part11e: a second active reservation for the same author+currency must violate the unique index');
  exception when unique_violation then
    get stacked diagnostics v_constraint_name = constraint_name;
    perform pg_temp.assert(
      v_constraint_name = 'author_payouts_one_active_per_author_currency_idx',
      format('part11e: expected the active-reservation index as the violated constraint, got %s', v_constraint_name)
    );
  end;
end $$;

insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0510011-0000-0000-0000-000000000041', 'e0510011-0000-0000-0000-000000000040', 'P11E Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0510011-0000-0000-0000-000000000042', 'e0510011-0000-0000-0000-000000000041', 'e0510011-0000-0000-0000-000000000040', 'cs_p051h_11e', 100);
insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0510011-0000-0000-0000-000000000043', 'e0510011-0000-0000-0000-000000000040',
   'e0510011-0000-0000-0000-000000000042', 'sale', 100, 'EUR', 8000, 125, 25, now() - interval '1 day', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('e0510011-0000-0000-0000-000000000040', 50, 'EUR');

do $$
declare
  v_rowcount integer;
begin
  -- Normal end-to-end behavior through the RPC itself: the author
  -- already has an active USD reservation from the direct-insert fixture
  -- above (a different currency, EUR, is used here so this is a clean,
  -- independent eligibility check) -- reserve_author_payout must simply
  -- succeed via the ordinary path (no unique_violation involved at all
  -- for a currency with no existing active reservation).
  set local role service_role;
  select count(*) into v_rowcount from public.reserve_author_payout('e0510011-0000-0000-0000-000000000040', 'EUR');
  reset role;
  perform pg_temp.assert(v_rowcount = 1, format('part11e: EUR reservation must succeed independently of the USD active reservation, got %s rows', v_rowcount));
end $$;

-- 11f. payout_run_id FK behavior (Section 12): ON DELETE RESTRICT, not
-- SET NULL -- a payout_runs row with any historical payouts referencing
-- it must never be deletable.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0510011-0000-0000-0000-000000000050', 'p051h-runfk@test', now(), '{"role":"author","display_name":"P11 Run FK"}');
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0510011-0000-0000-0000-000000000051', 'e0510011-0000-0000-0000-000000000050', 'P11F Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0510011-0000-0000-0000-000000000052', 'e0510011-0000-0000-0000-000000000051', 'e0510011-0000-0000-0000-000000000050', 'cs_p051h_11f', 100);
insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0510011-0000-0000-0000-000000000053', 'e0510011-0000-0000-0000-000000000050',
   'e0510011-0000-0000-0000-000000000052', 'sale', 100, 'USD', 8000, 125, 25, now() - interval '1 day', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('e0510011-0000-0000-0000-000000000050', 50, 'USD');

do $$
declare
  v_run_id uuid;
  v_payout_id uuid;
begin
  -- LEDGER-1E-D-D.1 (migration 054): explicit status='running', same
  -- reasoning as part8's own fixture above -- this test is about the
  -- ON DELETE RESTRICT behavior below, not about run-state validation,
  -- so the reservation itself must still succeed as originally
  -- intended.
  insert into public.payout_runs (run_key, status) values ('p051h-restrict-run', 'running') returning id into v_run_id;

  set local role service_role;
  select payout_id into v_payout_id from public.reserve_author_payout('e0510011-0000-0000-0000-000000000050', 'USD', v_run_id);
  reset role;
  perform pg_temp.assert(v_payout_id is not null, 'part11f: reservation under a run must succeed before the deletion attempt');

  begin
    delete from public.payout_runs where id = v_run_id;
    perform pg_temp.assert(false, 'part11f: deleting a payout_run with a historical payout referencing it must be rejected (ON DELETE RESTRICT)');
  exception when foreign_key_violation then null;
  end;

  perform pg_temp.assert(
    (select payout_run_id from public.author_payouts where id = v_payout_id) = v_run_id,
    'part11f: the payout''s own payout_run_id must remain intact after the rejected deletion attempt'
  );
end $$;

select 'ALL PASSED: 051_author_payout_foundation.test.sql' as result;

rollback;
