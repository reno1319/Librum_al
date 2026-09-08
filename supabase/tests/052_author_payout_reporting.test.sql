-- Committed SQL regression suite for migration 052 (LEDGER-1E-C: author
-- payout reporting + safe payout history read model).
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql -- no new test
-- infrastructure needed, same as every other suite in this directory.
--
-- Run manually against a disposable/local Postgres instance, AFTER
-- applying supabase/schema.sql (which already includes migration 052's
-- final state), from the repo root:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/052_author_payout_reporting.test.sql
--
-- Everything below runs inside one transaction and is rolled back at the
-- end, so now() is CONSTANT throughout (same discipline as every other
-- suite in this directory) -- every future/past timestamp fixture is
-- seeded with an explicit `now() +/- interval` value.
--
-- Ledger/payout fixtures are inserted DIRECTLY (as the connecting
-- superuser/table owner, bypassing RLS -- the same convention every
-- 048/049/050/051 test file already uses), including 'payout'-type
-- ledger debit entries and terminal author_payouts rows that mirror
-- exactly what finalize_author_payout()/fail_author_payout()/
-- cancel_author_payout() themselves would have produced -- this file
-- tests the REPORTING layer in isolation, with full control over exact
-- status/timestamp combinations per scenario. The state MACHINE itself
-- (legal transitions, concurrency, immutability) is already exhaustively
-- tested by 051's own suite and is not re-tested here.
--
-- One dedicated author per scenario, kept currency-isolated from each
-- other so each overview row can be hand-verified independently.

begin;

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

-- Migration 055 fail-closed gate: author_payout_eligibility() now
-- requires an active payout_minimum_policy row before it will ever
-- report a numeric threshold/payoutable comparison (no_minimum_policy
-- sits between no_settings and no_available_balance in the priority
-- chain). Seed a permissive policy (1 minor unit) for every currency
-- this suite's fixtures use, so none of THIS file's own
-- threshold/balance assertions (which predate 055) are affected.
insert into public.payout_minimum_policy (currency, minimum_threshold_minor, is_active) values
  ('EUR', 1, true),
  ('USD', 1, true);

-- ============================================================
-- Fixtures -- Scenarios 1-17. Every author/book/purchase/ledger/payout
-- id below is prefixed 'e052<NN>00-...' where NN is the two-digit
-- scenario number, so every row's scenario is legible from its own id.
-- ============================================================

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0520100-0000-0000-0000-000000000001', 'p052-s01@test', now(), '{"role":"author","display_name":"S1 Pending"}'),
  ('e0520200-0000-0000-0000-000000000001', 'p052-s02@test', now(), '{"role":"author","display_name":"S2 Processing"}'),
  ('e0520300-0000-0000-0000-000000000001', 'p052-s03@test', now(), '{"role":"author","display_name":"S3 Reconciling"}'),
  ('e0520400-0000-0000-0000-000000000001', 'p052-s04@test', now(), '{"role":"author","display_name":"S4 Failed Release"}'),
  ('e0520500-0000-0000-0000-000000000001', 'p052-s05@test', now(), '{"role":"author","display_name":"S5 Cancelled Release"}'),
  ('e0520600-0000-0000-0000-000000000001', 'p052-s06@test', now(), '{"role":"author","display_name":"S6 Paid No Double Sub"}'),
  ('e0520700-0000-0000-0000-000000000001', 'p052-s07@test', now(), '{"role":"author","display_name":"S7 Debit After Processing"}'),
  ('e0520800-0000-0000-0000-000000000001', 'p052-s08@test', now(), '{"role":"author","display_name":"S8 Multi Currency"}'),
  ('e0520900-0000-0000-0000-000000000001', 'p052-s09@test', now(), '{"role":"author","display_name":"S9 Settings No Ledger"}'),
  ('e0521000-0000-0000-0000-000000000001', 'p052-s10@test', now(), '{"role":"author","display_name":"S10 Threshold Reached"}'),
  ('e0521100-0000-0000-0000-000000000001', 'p052-s11@test', now(), '{"role":"author","display_name":"S11 Threshold Unconfigured"}'),
  ('e0521200-0000-0000-0000-000000000001', 'p052-s12@test', now(), '{"role":"author","display_name":"S12 Zero Balance History"}'),
  ('e0521300-0000-0000-0000-000000000001', 'p052-s13@test', now(), '{"role":"author","display_name":"S13 Empty Control"}'),
  ('e0521400-0000-0000-0000-000000000001', 'p052-s14@test', now(), '{"role":"reader","display_name":"S14 Reader"}'),
  ('e0521500-0000-0000-0000-000000000001', 'p052-s15@test', now(), '{"role":"reader","display_name":"S15 Finance Staff"}'),
  ('e0521600-0000-0000-0000-000000000001', 'p052-s16@test', now(), '{"role":"author","display_name":"S16 Pagination"}'),
  ('e0521700-0000-0000-0000-000000000001', 'p052-s17@test', now(), '{"role":"author","display_name":"S17 Canonical Regression"}');

insert into public.staff_members (user_id, role) values
  ('e0521500-0000-0000-0000-000000000001', 'admin');

-- S1: PENDING reservation. USD sale 100 (settled), pending payout 100.
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0520100-0000-0000-0000-000000000002', 'e0520100-0000-0000-0000-000000000001', 'S1 Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0520100-0000-0000-0000-000000000003', 'e0520100-0000-0000-0000-000000000002', 'e0520100-0000-0000-0000-000000000001', 'cs_p052_s01', 100);
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('122f4fdc-b568-a86f-61bf-4847b9923302', 'test', 'pay_auto_122f4fdc', 100, 'USD', 'succeeded');

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0520100-0000-0000-0000-000000000004', 'e0520100-0000-0000-0000-000000000001',
   'e0520100-0000-0000-0000-000000000003', '122f4fdc-b568-a86f-61bf-4847b9923302', 'sale', 100, 'USD', 8000, 100, 0,
   now() - interval '10 days', now() - interval '10 days');
insert into public.author_payouts (id, author_id, amount_minor, currency, status, created_at) values
  ('e0520100-0000-0000-0000-000000000005', 'e0520100-0000-0000-0000-000000000001', 100, 'USD', 'pending', now() - interval '1 day');

-- S2: PROCESSING reservation. Identical shape to S1, status=processing.
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0520200-0000-0000-0000-000000000002', 'e0520200-0000-0000-0000-000000000001', 'S2 Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0520200-0000-0000-0000-000000000003', 'e0520200-0000-0000-0000-000000000002', 'e0520200-0000-0000-0000-000000000001', 'cs_p052_s02', 100);
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('eaf37699-0943-8416-b9a4-f52b4387c380', 'test', 'pay_auto_eaf37699', 100, 'USD', 'succeeded');

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0520200-0000-0000-0000-000000000004', 'e0520200-0000-0000-0000-000000000001',
   'e0520200-0000-0000-0000-000000000003', 'eaf37699-0943-8416-b9a4-f52b4387c380', 'sale', 100, 'USD', 8000, 100, 0,
   now() - interval '10 days', now() - interval '10 days');
insert into public.author_payouts (id, author_id, amount_minor, currency, status, created_at, processing_at) values
  ('e0520200-0000-0000-0000-000000000005', 'e0520200-0000-0000-0000-000000000001', 100, 'USD', 'processing', now() - interval '1 day', now() - interval '12 hours');

-- S3: RECONCILING reservation. Identical shape, status=reconciling.
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0520300-0000-0000-0000-000000000002', 'e0520300-0000-0000-0000-000000000001', 'S3 Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0520300-0000-0000-0000-000000000003', 'e0520300-0000-0000-0000-000000000002', 'e0520300-0000-0000-0000-000000000001', 'cs_p052_s03', 100);
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('42e1ef09-1f9b-bc01-7c0b-6d9fe8434d37', 'test', 'pay_auto_42e1ef09', 100, 'USD', 'succeeded');

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0520300-0000-0000-0000-000000000004', 'e0520300-0000-0000-0000-000000000001',
   'e0520300-0000-0000-0000-000000000003', '42e1ef09-1f9b-bc01-7c0b-6d9fe8434d37', 'sale', 100, 'USD', 8000, 100, 0,
   now() - interval '10 days', now() - interval '10 days');
insert into public.author_payouts (id, author_id, amount_minor, currency, status, created_at, processing_at) values
  ('e0520300-0000-0000-0000-000000000005', 'e0520300-0000-0000-0000-000000000001', 100, 'USD', 'reconciling', now() - interval '1 day', now() - interval '12 hours');

-- S4: FAILED release. Same ledger shape, payout FAILED (with a
-- deliberately non-blank failure_code, to prove the safe history RPC
-- omits it even though the underlying row genuinely has one).
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0520400-0000-0000-0000-000000000002', 'e0520400-0000-0000-0000-000000000001', 'S4 Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0520400-0000-0000-0000-000000000003', 'e0520400-0000-0000-0000-000000000002', 'e0520400-0000-0000-0000-000000000001', 'cs_p052_s04', 100);
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('86a03d57-dcf3-4ff1-b2e2-d8529547e312', 'test', 'pay_auto_86a03d57', 100, 'USD', 'succeeded');

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0520400-0000-0000-0000-000000000004', 'e0520400-0000-0000-0000-000000000001',
   'e0520400-0000-0000-0000-000000000003', '86a03d57-dcf3-4ff1-b2e2-d8529547e312', 'sale', 100, 'USD', 8000, 100, 0,
   now() - interval '10 days', now() - interval '10 days');
insert into public.author_payouts (id, author_id, amount_minor, currency, status, created_at, processing_at, failed_at, failure_code) values
  ('e0520400-0000-0000-0000-000000000005', 'e0520400-0000-0000-0000-000000000001', 100, 'USD', 'failed',
   now() - interval '2 days', now() - interval '1 day', now(), 'provider_declined_test_only');

-- S5: CANCELLED release. Same ledger shape, payout CANCELLED.
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0520500-0000-0000-0000-000000000002', 'e0520500-0000-0000-0000-000000000001', 'S5 Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0520500-0000-0000-0000-000000000003', 'e0520500-0000-0000-0000-000000000002', 'e0520500-0000-0000-0000-000000000001', 'cs_p052_s05', 100);
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('32dc3dec-7d24-edf7-3da2-307119b16e50', 'test', 'pay_auto_32dc3dec', 100, 'USD', 'succeeded');

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0520500-0000-0000-0000-000000000004', 'e0520500-0000-0000-0000-000000000001',
   'e0520500-0000-0000-0000-000000000003', '32dc3dec-7d24-edf7-3da2-307119b16e50', 'sale', 100, 'USD', 8000, 100, 0,
   now() - interval '10 days', now() - interval '10 days');
insert into public.author_payouts (id, author_id, amount_minor, currency, status, created_at) values
  ('e0520500-0000-0000-0000-000000000005', 'e0520500-0000-0000-0000-000000000001', 100, 'USD', 'cancelled', now() - interval '2 days');

-- S6: PAID -- the critical no-double-subtraction case. Ledger sale 100,
-- payout reserved 100 (asserted BEFORE finalize, below), then finalized
-- exactly as finalize_author_payout() itself would (one ledger debit
-- entry + status='paid'/provider/provider_reference/paid_at, all set
-- together) -- with a deliberately non-blank provider/provider_reference,
-- to prove the safe history RPC omits them even though the underlying
-- row genuinely has them.
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0520600-0000-0000-0000-000000000002', 'e0520600-0000-0000-0000-000000000001', 'S6 Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0520600-0000-0000-0000-000000000003', 'e0520600-0000-0000-0000-000000000002', 'e0520600-0000-0000-0000-000000000001', 'cs_p052_s06', 100);
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('ecdfe717-b6c8-f0dc-7298-e5511128ea6d', 'test', 'pay_auto_ecdfe717', 100, 'USD', 'succeeded');

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0520600-0000-0000-0000-000000000004', 'e0520600-0000-0000-0000-000000000001',
   'e0520600-0000-0000-0000-000000000003', 'ecdfe717-b6c8-f0dc-7298-e5511128ea6d', 'sale', 100, 'USD', 8000, 100, 0,
   now() - interval '10 days', now() - interval '10 days');
insert into public.author_payouts (id, author_id, amount_minor, currency, status, created_at, processing_at) values
  ('e0520600-0000-0000-0000-000000000005', 'e0520600-0000-0000-0000-000000000001', 100, 'USD', 'processing', now() - interval '2 days', now() - interval '1 day');

-- S7: a ledger debit posted AFTER a payout enters processing --
-- modeled as a negative ADJUSTMENT entry rather than a full canonical
-- refund fixture (payments + payment_refunds + refund entry): 049/050's
-- own suites already exhaustively test refund-specific ledger mechanics
-- (sibling re-attribution, payment_refund_id requirements); this test
-- only needs a generic post-reservation ledger debit to exercise the
-- overview formula's own refund-after-processing arithmetic (Section 23
-- of LEDGER-1E-C), and a negative adjustment is the minimal fixture that
-- produces exactly that.
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0520700-0000-0000-0000-000000000002', 'e0520700-0000-0000-0000-000000000001', 'S7 Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0520700-0000-0000-0000-000000000003', 'e0520700-0000-0000-0000-000000000002', 'e0520700-0000-0000-0000-000000000001', 'cs_p052_s07', 100);
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('439a9761-12cf-0e57-df4d-570c040d2ec5', 'test', 'pay_auto_439a9761', 100, 'USD', 'succeeded');

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0520700-0000-0000-0000-000000000004', 'e0520700-0000-0000-0000-000000000001',
   'e0520700-0000-0000-0000-000000000003', '439a9761-12cf-0e57-df4d-570c040d2ec5', 'sale', 100, 'USD', 8000, 100, 0,
   now() - interval '10 days', now() - interval '10 days');
insert into public.author_payouts (id, author_id, amount_minor, currency, status, created_at, processing_at) values
  ('e0520700-0000-0000-0000-000000000005', 'e0520700-0000-0000-0000-000000000001', 100, 'USD', 'processing', now() - interval '2 days', now() - interval '1 day');
insert into public.author_ledger_entries
  (id, author_id, entry_type, amount_minor, currency, available_at, created_at)
values
  ('e0520700-0000-0000-0000-000000000006', 'e0520700-0000-0000-0000-000000000001', 'adjustment', -20, 'USD', now(), now());

-- S8: MULTI-CURRENCY. EUR sale 100 (settled) + pending payout 50; USD
-- sale 200 (settled), no payout at all.
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0520800-0000-0000-0000-000000000002', 'e0520800-0000-0000-0000-000000000001', 'S8 EUR Book', '', '', '', 100, 'published'),
  ('e0520800-0000-0000-0000-000000000006', 'e0520800-0000-0000-0000-000000000001', 'S8 USD Book', '', '', '', 200, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0520800-0000-0000-0000-000000000003', 'e0520800-0000-0000-0000-000000000002', 'e0520800-0000-0000-0000-000000000001', 'cs_p052_s08_eur', 100),
  ('e0520800-0000-0000-0000-000000000007', 'e0520800-0000-0000-0000-000000000006', 'e0520800-0000-0000-0000-000000000001', 'cs_p052_s08_usd', 200);
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('f34804ba-1904-59f4-9475-5b4b1854f08c', 'test', 'pay_auto_f34804ba', 100, 'EUR', 'succeeded'),
  ('a2f4be06-a988-be5a-3d5e-71bb541748bc', 'test', 'pay_auto_a2f4be06', 200, 'USD', 'succeeded');

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0520800-0000-0000-0000-000000000004', 'e0520800-0000-0000-0000-000000000001',
   'e0520800-0000-0000-0000-000000000003', 'f34804ba-1904-59f4-9475-5b4b1854f08c', 'sale', 100, 'EUR', 8000, 100, 0,
   now() - interval '10 days', now() - interval '10 days'),
  ('e0520800-0000-0000-0000-000000000008', 'e0520800-0000-0000-0000-000000000001',
   'e0520800-0000-0000-0000-000000000007', 'a2f4be06-a988-be5a-3d5e-71bb541748bc', 'sale', 200, 'USD', 8000, 200, 0,
   now() - interval '10 days', now() - interval '10 days');
insert into public.author_payouts (id, author_id, amount_minor, currency, status, created_at) values
  ('e0520800-0000-0000-0000-000000000005', 'e0520800-0000-0000-0000-000000000001', 50, 'EUR', 'pending', now() - interval '1 day');

-- S9: settings configured, ZERO ledger activity for that currency.
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('e0520900-0000-0000-0000-000000000001', 50, 'EUR');

-- S10: threshold configured and REACHED (ledger 100 >= threshold 50).
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0521000-0000-0000-0000-000000000002', 'e0521000-0000-0000-0000-000000000001', 'S10 Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0521000-0000-0000-0000-000000000003', 'e0521000-0000-0000-0000-000000000002', 'e0521000-0000-0000-0000-000000000001', 'cs_p052_s10', 100);
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('3d07c711-9835-f8e3-0c1c-55ffac5823e4', 'test', 'pay_auto_3d07c711', 100, 'USD', 'succeeded');

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0521000-0000-0000-0000-000000000004', 'e0521000-0000-0000-0000-000000000001',
   'e0521000-0000-0000-0000-000000000003', '3d07c711-9835-f8e3-0c1c-55ffac5823e4', 'sale', 100, 'USD', 8000, 100, 0,
   now() - interval '10 days', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('e0521000-0000-0000-0000-000000000001', 50, 'USD');

-- S11: ledger activity, threshold UNCONFIGURED (no settings row at all).
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0521100-0000-0000-0000-000000000002', 'e0521100-0000-0000-0000-000000000001', 'S11 Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0521100-0000-0000-0000-000000000003', 'e0521100-0000-0000-0000-000000000002', 'e0521100-0000-0000-0000-000000000001', 'cs_p052_s11', 100);
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('0d8648cf-f221-37fc-63da-84648160c8fd', 'test', 'pay_auto_0d8648cf', 100, 'USD', 'succeeded');

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0521100-0000-0000-0000-000000000004', 'e0521100-0000-0000-0000-000000000001',
   'e0521100-0000-0000-0000-000000000003', '0d8648cf-f221-37fc-63da-84648160c8fd', 'sale', 100, 'USD', 8000, 100, 0,
   now() - interval '10 days', now() - interval '10 days');

-- S12: a PAID historical payout that nets the currency's ledger balance
-- to exactly zero -- the overview and history must still report EUR.
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0521200-0000-0000-0000-000000000002', 'e0521200-0000-0000-0000-000000000001', 'S12 Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0521200-0000-0000-0000-000000000003', 'e0521200-0000-0000-0000-000000000002', 'e0521200-0000-0000-0000-000000000001', 'cs_p052_s12', 100);
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('155166a7-0ba7-1ad4-de82-125ec2db015e', 'test', 'pay_auto_155166a7', 100, 'EUR', 'succeeded');

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0521200-0000-0000-0000-000000000004', 'e0521200-0000-0000-0000-000000000001',
   'e0521200-0000-0000-0000-000000000003', '155166a7-0ba7-1ad4-de82-125ec2db015e', 'sale', 100, 'EUR', 8000, 100, 0,
   now() - interval '30 days', now() - interval '30 days');
insert into public.author_payouts (id, author_id, amount_minor, currency, status, created_at, processing_at, paid_at, provider, provider_reference) values
  ('e0521200-0000-0000-0000-000000000005', 'e0521200-0000-0000-0000-000000000001', 100, 'EUR', 'paid',
   now() - interval '20 days', now() - interval '15 days', now() - interval '14 days', 'test-provider', 'ref-s12-001');
insert into public.author_ledger_entries
  (id, author_id, payout_id, entry_type, amount_minor, currency, available_at, created_at)
values
  ('e0521200-0000-0000-0000-000000000006', 'e0521200-0000-0000-0000-000000000001',
   'e0521200-0000-0000-0000-000000000005', 'payout', -100, 'EUR', now() - interval '14 days', now() - interval '14 days');

-- S13: nothing at all -- pure control.
-- (no fixtures beyond the auth.users row above)

-- S16: pagination -- 30 terminal (cancelled) payout rows, staggered
-- created_at, one minute apart, oldest first.
do $$
declare
  i integer;
begin
  for i in 1..30 loop
    insert into public.author_payouts (id, author_id, amount_minor, currency, status, created_at)
    values (
      ('e0521600-0000-0000-0000-0000000001' || lpad(i::text, 2, '0'))::uuid,
      'e0521600-0000-0000-0000-000000000001',
      100 + i,
      'USD',
      'cancelled',
      now() - (interval '1 minute' * (31 - i))
    );
  end loop;
end $$;

-- S17: CANONICAL REGRESSION -- the exact P1 case from 050's own suite
-- (sale +100, available_at FUTURE, refunded -100 before it ever
-- settles), replayed here to prove migration 052 does not alter
-- author_ledger_balance()/get_author_financial_summary() semantics.
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('e0521700-0000-0000-0000-000000000002', 'e0521700-0000-0000-0000-000000000001', 'S17 Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0521700-0000-0000-0000-000000000003', 'e0521700-0000-0000-0000-000000000002', 'e0521700-0000-0000-0000-000000000001', 'cs_p052_s17', 100);
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('e0521700-0000-0000-0000-000000000009', 'test', 'pay_p052_s17', 100, 'USD', 'succeeded');
update public.purchases set payment_id = 'e0521700-0000-0000-0000-000000000009' where id = 'e0521700-0000-0000-0000-000000000003';
insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('e0521700-0000-0000-0000-000000000004', 'e0521700-0000-0000-0000-000000000001',
   'e0521700-0000-0000-0000-000000000003', 'e0521700-0000-0000-0000-000000000009',
   'sale', 100, 'USD', 8000, 100, 0, now() + interval '20 days', now() - interval '1 day');
insert into public.payment_refunds (id, payment_id, purchase_id, provider, provider_refund_id, amount_minor, currency, refunded_at) values
  ('e0521700-0000-0000-0000-00000000000a', 'e0521700-0000-0000-0000-000000000009', 'e0521700-0000-0000-0000-000000000003',
   'test', 'refund_p052_s17', 100, 'USD', now());
insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, payment_refund_id, entry_type, amount_minor, currency, available_at, created_at)
values
  ('e0521700-0000-0000-0000-00000000000b', 'e0521700-0000-0000-0000-000000000001',
   'e0521700-0000-0000-0000-000000000003', 'e0521700-0000-0000-0000-000000000009', 'e0521700-0000-0000-0000-00000000000a',
   'refund', -100, 'USD', now(), now());

-- ============================================================
-- Part A: OVERVIEW FORMULA -- pending/processing/reconciling all
-- reserve identically (Sections 17-19).
-- ============================================================

do $$
declare
  v_row record;
begin
  perform set_config('request.jwt.claim.sub', 'e0520100-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select * into v_row from public.get_author_payout_overview() where currency = 'USD';
  reset role;

  perform pg_temp.assert(v_row.ledger_available_minor = 100, format('S1 pending: ledger_available must be 100, got %s', v_row.ledger_available_minor));
  perform pg_temp.assert(v_row.reserved_minor = 100, format('S1 pending: reserved must be 100, got %s', v_row.reserved_minor));
  perform pg_temp.assert(v_row.available_for_payout_minor = 0, format('S1 pending: available_for_payout must be 0, got %s', v_row.available_for_payout_minor));
  perform pg_temp.assert(v_row.ledger_available_minor = v_row.reserved_minor + v_row.available_for_payout_minor, 'S1: reconciliation invariant must hold');
end $$;

do $$
declare
  v_row record;
begin
  perform set_config('request.jwt.claim.sub', 'e0520200-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select * into v_row from public.get_author_payout_overview() where currency = 'USD';
  reset role;

  perform pg_temp.assert(v_row.reserved_minor = 100, format('S2 processing: reserved must be 100, got %s', v_row.reserved_minor));
  perform pg_temp.assert(v_row.available_for_payout_minor = 0, format('S2 processing: available_for_payout must be 0, got %s', v_row.available_for_payout_minor));
end $$;

do $$
declare
  v_row record;
begin
  perform set_config('request.jwt.claim.sub', 'e0520300-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select * into v_row from public.get_author_payout_overview() where currency = 'USD';
  reset role;

  perform pg_temp.assert(v_row.reserved_minor = 100, format('S3 reconciling: reserved must be 100, got %s', v_row.reserved_minor));
  perform pg_temp.assert(v_row.available_for_payout_minor = 0, format('S3 reconciling: available_for_payout must be 0, got %s', v_row.available_for_payout_minor));
end $$;

-- ============================================================
-- Part B: TERMINAL PAYOUTS -- failed/cancelled release the reservation
-- (Section 20-21); paid does NOT double-subtract (Section 22).
-- ============================================================

do $$
declare
  v_row record;
begin
  perform set_config('request.jwt.claim.sub', 'e0520400-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select * into v_row from public.get_author_payout_overview() where currency = 'USD';
  reset role;

  perform pg_temp.assert(v_row.reserved_minor = 0, format('S4 failed: reserved must be 0, got %s', v_row.reserved_minor));
  perform pg_temp.assert(v_row.available_for_payout_minor = 100, format('S4 failed: available_for_payout must be released back to 100, got %s', v_row.available_for_payout_minor));
end $$;

do $$
declare
  v_row record;
begin
  perform set_config('request.jwt.claim.sub', 'e0520500-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select * into v_row from public.get_author_payout_overview() where currency = 'USD';
  reset role;

  perform pg_temp.assert(v_row.reserved_minor = 0, format('S5 cancelled: reserved must be 0, got %s', v_row.reserved_minor));
  perform pg_temp.assert(v_row.available_for_payout_minor = 100, format('S5 cancelled: available_for_payout must be released back to 100, got %s', v_row.available_for_payout_minor));
end $$;

-- S6, BEFORE finalize: reserved=100, available_for_payout=0.
do $$
declare
  v_row record;
begin
  perform set_config('request.jwt.claim.sub', 'e0520600-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select * into v_row from public.get_author_payout_overview() where currency = 'USD';
  reset role;

  perform pg_temp.assert(v_row.ledger_available_minor = 100, format('S6 before finalize: ledger_available must be 100, got %s', v_row.ledger_available_minor));
  perform pg_temp.assert(v_row.reserved_minor = 100, format('S6 before finalize: reserved must be 100, got %s', v_row.reserved_minor));
  perform pg_temp.assert(v_row.available_for_payout_minor = 0, format('S6 before finalize: available_for_payout must be 0, got %s', v_row.available_for_payout_minor));
end $$;

-- Now finalize S6 exactly as finalize_author_payout() itself would:
-- one ledger debit + status='paid'/provider/provider_reference/paid_at.
insert into public.author_ledger_entries
  (id, author_id, payout_id, entry_type, amount_minor, currency, available_at, created_at)
values
  ('e0520600-0000-0000-0000-000000000006', 'e0520600-0000-0000-0000-000000000001',
   'e0520600-0000-0000-0000-000000000005', 'payout', -100, 'USD', now(), now());
update public.author_payouts
  set status = 'paid', paid_at = now(), provider = 'test-provider-n6', provider_reference = 'ref-s06-001'
  where id = 'e0520600-0000-0000-0000-000000000005';

-- S6, AFTER finalize: THE CRITICAL no-double-subtraction proof.
do $$
declare
  v_row record;
begin
  perform set_config('request.jwt.claim.sub', 'e0520600-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select * into v_row from public.get_author_payout_overview() where currency = 'USD';
  reset role;

  perform pg_temp.assert(v_row.ledger_available_minor = 0, format('S6 after finalize: ledger_available must be 0 (100 sale - 100 payout debit), got %s', v_row.ledger_available_minor));
  perform pg_temp.assert(v_row.reserved_minor = 0, format('S6 after finalize: reserved must be 0 (paid is terminal, no longer active), got %s', v_row.reserved_minor));
  perform pg_temp.assert(v_row.available_for_payout_minor = 0, format('S6 after finalize: available_for_payout must be 0 -- NOT -100 (that would be double-subtraction), got %s', v_row.available_for_payout_minor));
end $$;

-- ============================================================
-- Part C: NEGATIVE PAYOUTABLE -- a debit posted after a payout enters
-- processing must NOT be clamped to zero (Section 23).
-- ============================================================

do $$
declare
  v_row record;
begin
  perform set_config('request.jwt.claim.sub', 'e0520700-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select * into v_row from public.get_author_payout_overview() where currency = 'USD';
  reset role;

  perform pg_temp.assert(v_row.ledger_available_minor = 80, format('S7: ledger_available must be 80 (100 sale - 20 debit), got %s', v_row.ledger_available_minor));
  perform pg_temp.assert(v_row.reserved_minor = 100, format('S7: reserved must remain 100 (still processing), got %s', v_row.reserved_minor));
  perform pg_temp.assert(v_row.available_for_payout_minor = -20, format('S7: available_for_payout must be -20, NOT clamped to 0, got %s', v_row.available_for_payout_minor));
  perform pg_temp.assert(v_row.ledger_available_minor = v_row.reserved_minor + v_row.available_for_payout_minor, 'S7: reconciliation invariant must hold even when negative');
end $$;

-- ============================================================
-- Part D: MULTI-CURRENCY -- never combined (Section 24).
-- ============================================================

do $$
declare
  v_eur record;
  v_usd record;
  v_count integer;
begin
  perform set_config('request.jwt.claim.sub', 'e0520800-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select count(*) into v_count from public.get_author_payout_overview();
  select * into v_eur from public.get_author_payout_overview() where currency = 'EUR';
  select * into v_usd from public.get_author_payout_overview() where currency = 'USD';
  reset role;

  perform pg_temp.assert(v_count = 2, format('S8: exactly 2 currency rows expected, got %s', v_count));
  perform pg_temp.assert(v_eur.available_for_payout_minor = 50, format('S8 EUR: available_for_payout must be 50, got %s', v_eur.available_for_payout_minor));
  perform pg_temp.assert(v_usd.available_for_payout_minor = 200, format('S8 USD: available_for_payout must be 200 (no reservation), got %s', v_usd.available_for_payout_minor));
  perform pg_temp.assert(v_eur.ledger_available_minor = v_eur.reserved_minor + v_eur.available_for_payout_minor, 'S8 EUR: reconciliation invariant must hold');
  perform pg_temp.assert(v_usd.ledger_available_minor = v_usd.reserved_minor + v_usd.available_for_payout_minor, 'S8 USD: reconciliation invariant must hold');
end $$;

-- ============================================================
-- Part E: THRESHOLD SEMANTICS (Section 6/7/25).
-- ============================================================

-- S9: settings configured, zero ledger activity -- still reportable.
do $$
declare
  v_row record;
begin
  perform set_config('request.jwt.claim.sub', 'e0520900-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select * into v_row from public.get_author_payout_overview() where currency = 'EUR';
  reset role;

  perform pg_temp.assert(v_row.currency = 'EUR', 'S9: EUR row must be present despite zero ledger activity');
  perform pg_temp.assert(v_row.ledger_available_minor = 0, format('S9: ledger_available must be 0, got %s', v_row.ledger_available_minor));
  perform pg_temp.assert(v_row.reserved_minor = 0, format('S9: reserved must be 0, got %s', v_row.reserved_minor));
  perform pg_temp.assert(v_row.available_for_payout_minor = 0, format('S9: available_for_payout must be 0, got %s', v_row.available_for_payout_minor));
  perform pg_temp.assert(v_row.threshold_configured = true, 'S9: threshold_configured must be true');
  perform pg_temp.assert(v_row.threshold_minor = 50, format('S9: threshold_minor must be 50, got %s', v_row.threshold_minor));
  perform pg_temp.assert(v_row.threshold_reached = false, 'S9: threshold_reached must be false (0 < 50)');
end $$;

-- S10: threshold configured and REACHED.
do $$
declare
  v_row record;
begin
  perform set_config('request.jwt.claim.sub', 'e0521000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select * into v_row from public.get_author_payout_overview() where currency = 'USD';
  reset role;

  perform pg_temp.assert(v_row.threshold_configured = true, 'S10: threshold_configured must be true');
  perform pg_temp.assert(v_row.threshold_minor = 50, format('S10: threshold_minor must be 50, got %s', v_row.threshold_minor));
  perform pg_temp.assert(v_row.available_for_payout_minor = 100, format('S10: available_for_payout must be 100, got %s', v_row.available_for_payout_minor));
  perform pg_temp.assert(v_row.threshold_reached = true, 'S10: threshold_reached must be true (100 >= 50)');
end $$;

-- S11: ledger activity, NO settings row -- never a fabricated default.
do $$
declare
  v_row record;
begin
  perform set_config('request.jwt.claim.sub', 'e0521100-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select * into v_row from public.get_author_payout_overview() where currency = 'USD';
  reset role;

  perform pg_temp.assert(v_row.threshold_configured = false, 'S11: threshold_configured must be false');
  perform pg_temp.assert(v_row.threshold_minor is null, 'S11: threshold_minor must be NULL, never a fabricated default');
  perform pg_temp.assert(v_row.threshold_reached = false, 'S11: threshold_reached must be false (never NULL) when unconfigured');
end $$;

-- ============================================================
-- Part F: HISTORICAL PAYOUT WITH ZERO NET BALANCE (Section 26) --
-- currency must remain reportable in both the overview and history.
-- ============================================================

do $$
declare
  v_row record;
  v_history_count integer;
  v_history_status text;
begin
  perform set_config('request.jwt.claim.sub', 'e0521200-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select * into v_row from public.get_author_payout_overview() where currency = 'EUR';
  select count(*) into v_history_count from public.list_author_payout_history();
  select status into v_history_status from public.list_author_payout_history() where id = 'e0521200-0000-0000-0000-000000000005';
  reset role;

  perform pg_temp.assert(v_row.currency = 'EUR', 'S12: EUR row must be present despite zero net balance');
  perform pg_temp.assert(v_row.ledger_available_minor = 0, format('S12: ledger_available must be 0, got %s', v_row.ledger_available_minor));
  perform pg_temp.assert(v_row.reserved_minor = 0, format('S12: reserved must be 0 (paid is terminal), got %s', v_row.reserved_minor));
  perform pg_temp.assert(v_history_count = 1, format('S12: payout history must still show the historical paid payout, got %s rows', v_history_count));
  perform pg_temp.assert(v_history_status = 'paid', format('S12: historical payout status must be paid, got %s', v_history_status));
end $$;

-- ============================================================
-- Part G: EMPTY / CONTROL CASES -- zero rows is a normal outcome, not
-- an error.
-- ============================================================

do $$
declare
  v_overview_count integer;
  v_history_count integer;
begin
  perform set_config('request.jwt.claim.sub', 'e0521300-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select count(*) into v_overview_count from public.get_author_payout_overview();
  select count(*) into v_history_count from public.list_author_payout_history();
  reset role;

  perform pg_temp.assert(v_overview_count = 0, format('S13: an author with nothing at all must get 0 overview rows, got %s', v_overview_count));
  perform pg_temp.assert(v_history_count = 0, format('S13: an author with nothing at all must get 0 history rows, got %s', v_history_count));
end $$;

-- READER: no financial data of any kind, no error.
do $$
declare
  v_overview_count integer;
  v_history_count integer;
begin
  perform set_config('request.jwt.claim.sub', 'e0521400-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select count(*) into v_overview_count from public.get_author_payout_overview();
  select count(*) into v_history_count from public.list_author_payout_history();
  reset role;

  perform pg_temp.assert(v_overview_count = 0, format('S14 reader: must get 0 overview rows, got %s', v_overview_count));
  perform pg_temp.assert(v_history_count = 0, format('S14 reader: must get 0 history rows, got %s', v_history_count));
end $$;

-- ============================================================
-- Part H: SECURITY -- ownership isolation, raw-table lockdown,
-- finance.view preservation, safe-output field omission, anon denial.
-- ============================================================

-- Author A (S1) cannot see author B's (S2) payout via either RPC --
-- there is no p_author_id parameter to abuse, and this proves it
-- behaviorally: S1's own history contains exactly its own payout id and
-- never S2's.
do $$
declare
  v_count_own integer;
  v_count_other integer;
begin
  perform set_config('request.jwt.claim.sub', 'e0520100-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select count(*) into v_count_own from public.list_author_payout_history() where id = 'e0520100-0000-0000-0000-000000000005';
  select count(*) into v_count_other from public.list_author_payout_history() where id = 'e0520200-0000-0000-0000-000000000005';
  reset role;

  perform pg_temp.assert(v_count_own = 1, 'security: S1 must see its own payout row in history');
  perform pg_temp.assert(v_count_other = 0, 'security: S1 must NOT see S2''s payout row in history');
end $$;

-- Raw author_payouts is inaccessible to an ordinary author (the
-- author-own policy migration 052 dropped) -- their only path is now
-- the safe RPCs above.
do $$
declare
  v_raw_count integer;
begin
  perform set_config('request.jwt.claim.sub', 'e0520100-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select count(*) into v_raw_count from public.author_payouts;
  reset role;

  perform pg_temp.assert(v_raw_count = 0, format('security: an ordinary author must see 0 rows via raw author_payouts SELECT, got %s', v_raw_count));
end $$;

-- finance.view staff raw read is fully preserved -- can see EVERY
-- author's payout rows, including the internal fields the safe RPCs
-- omit.
do $$
declare
  v_raw_count integer;
  v_provider text;
  v_provider_reference text;
  v_failure_code text;
begin
  perform set_config('request.jwt.claim.sub', 'e0521500-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select count(*) into v_raw_count from public.author_payouts;
  select provider, provider_reference into v_provider, v_provider_reference from public.author_payouts where id = 'e0520600-0000-0000-0000-000000000005';
  select failure_code into v_failure_code from public.author_payouts where id = 'e0520400-0000-0000-0000-000000000005';
  reset role;

  perform pg_temp.assert(v_raw_count > 30, format('security: finance.view staff must see every author''s raw payout rows, got %s', v_raw_count));
  perform pg_temp.assert(v_provider = 'test-provider-n6', 'security: finance.view staff must see the raw provider field');
  perform pg_temp.assert(v_provider_reference = 'ref-s06-001', 'security: finance.view staff must see the raw provider_reference field');
  perform pg_temp.assert(v_failure_code = 'provider_declined_test_only', 'security: finance.view staff must see the raw failure_code field');
end $$;

-- Safe output fields: list_author_payout_history() must never surface
-- provider/provider_reference/failure_code/payout_run_id, even for rows
-- where the underlying data genuinely has them populated.
do $$
declare
  v_json jsonb;
begin
  perform set_config('request.jwt.claim.sub', 'e0520600-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select to_jsonb(h) into v_json from public.list_author_payout_history() h where h.id = 'e0520600-0000-0000-0000-000000000005';
  reset role;

  perform pg_temp.assert(not (v_json ? 'provider'), 'security: safe history output must never include provider');
  perform pg_temp.assert(not (v_json ? 'provider_reference'), 'security: safe history output must never include provider_reference');
  perform pg_temp.assert(not (v_json ? 'payout_run_id'), 'security: safe history output must never include payout_run_id');
  perform pg_temp.assert(v_json ? 'status', 'security: safe history output must include status');
  perform pg_temp.assert((v_json ->> 'status') = 'paid', 'security: S6''s history status must read paid');
end $$;

do $$
declare
  v_json jsonb;
begin
  perform set_config('request.jwt.claim.sub', 'e0520400-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select to_jsonb(h) into v_json from public.list_author_payout_history() h where h.id = 'e0520400-0000-0000-0000-000000000005';
  reset role;

  perform pg_temp.assert(not (v_json ? 'failure_code'), 'security: safe history output must never include failure_code, even for a failed row');
  perform pg_temp.assert((v_json ->> 'status') = 'failed', 'security: S4''s history status must read failed, never relabeled');
end $$;

-- anon cannot execute either RPC.
do $$
begin
  set local role anon;
  begin
    perform * from public.get_author_payout_overview();
    perform pg_temp.assert(false, 'security: anon must not be able to execute get_author_payout_overview');
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.list_author_payout_history();
    perform pg_temp.assert(false, 'security: anon must not be able to execute list_author_payout_history');
  exception when insufficient_privilege then null;
  end;
  reset role;
end $$;

-- author_ledger_balance() remains service_role-only -- not broadened by
-- this migration, even though get_author_payout_overview() calls it
-- internally.
do $$
begin
  perform set_config('request.jwt.claim.sub', 'e0520100-0000-0000-0000-000000000001', true);
  set local role authenticated;
  begin
    perform * from public.author_ledger_balance('e0520100-0000-0000-0000-000000000001');
    perform pg_temp.assert(false, 'security: authenticated must not be able to execute author_ledger_balance directly');
  exception when insufficient_privilege then null;
  end;
  reset role;
end $$;

-- ============================================================
-- Part I: STATUS VOCABULARY -- all 6 statuses pass through verbatim,
-- never collapsed or relabeled (Section 16).
-- ============================================================

do $$
declare
  v_status text;
begin
  perform set_config('request.jwt.claim.sub', 'e0520100-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select status into v_status from public.list_author_payout_history() where id = 'e0520100-0000-0000-0000-000000000005';
  reset role;
  perform pg_temp.assert(v_status = 'pending', format('S1: status must read pending, got %s', v_status));
end $$;

do $$
declare
  v_status text;
begin
  perform set_config('request.jwt.claim.sub', 'e0520200-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select status into v_status from public.list_author_payout_history() where id = 'e0520200-0000-0000-0000-000000000005';
  reset role;
  perform pg_temp.assert(v_status = 'processing', format('S2: status must read processing, got %s', v_status));
end $$;

do $$
declare
  v_status text;
begin
  perform set_config('request.jwt.claim.sub', 'e0520300-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select status into v_status from public.list_author_payout_history() where id = 'e0520300-0000-0000-0000-000000000005';
  reset role;
  perform pg_temp.assert(v_status = 'reconciling', format('S3: status must read reconciling, NEVER collapsed to failed, got %s', v_status));
end $$;

do $$
declare
  v_status text;
begin
  perform set_config('request.jwt.claim.sub', 'e0520500-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select status into v_status from public.list_author_payout_history() where id = 'e0520500-0000-0000-0000-000000000005';
  reset role;
  perform pg_temp.assert(v_status = 'cancelled', format('S5: status must read cancelled, got %s', v_status));
end $$;

-- ============================================================
-- Part J: PAGINATION -- bounded keyset pagination (Section 15).
-- ============================================================

do $$
declare
  v_page1_count integer;
  v_page2_count integer;
  v_last_created_at timestamptz;
  v_last_id uuid;
  v_overlap_count integer;
  v_clamped_high integer;
  v_clamped_low integer;
begin
  perform set_config('request.jwt.claim.sub', 'e0521600-0000-0000-0000-000000000001', true);
  set local role authenticated;

  -- Default page size: 25.
  select count(*) into v_page1_count from public.list_author_payout_history();
  perform pg_temp.assert(v_page1_count = 25, format('pagination: default page size must be 25, got %s', v_page1_count));

  -- p_limit clamps to [1, 100].
  select count(*) into v_clamped_high from public.list_author_payout_history(p_limit => 1000);
  perform pg_temp.assert(v_clamped_high = 30, format('pagination: p_limit=1000 must clamp to at most all 30 rows (max 100), got %s', v_clamped_high));
  select count(*) into v_clamped_low from public.list_author_payout_history(p_limit => 0);
  perform pg_temp.assert(v_clamped_low = 1, format('pagination: p_limit=0 must clamp to 1, got %s', v_clamped_low));

  -- Walk page 1 (limit 10), capture the keyset cursor from the last row.
  select h.created_at, h.id into v_last_created_at, v_last_id
  from public.list_author_payout_history(p_limit => 10) h
  order by h.created_at desc, h.id desc
  limit 1 offset 9;

  select count(*) into v_page1_count from public.list_author_payout_history(p_limit => 10);
  perform pg_temp.assert(v_page1_count = 10, format('pagination: page 1 must return exactly 10 rows, got %s', v_page1_count));

  -- Page 2, using that cursor, must return the next 10 with zero overlap.
  select count(*) into v_page2_count
  from public.list_author_payout_history(p_limit => 10, p_cursor_created_at => v_last_created_at, p_cursor_id => v_last_id);
  perform pg_temp.assert(v_page2_count = 10, format('pagination: page 2 must return exactly 10 rows, got %s', v_page2_count));

  select count(*) into v_overlap_count
  from public.list_author_payout_history(p_limit => 10) p1
  where p1.id in (
    select id from public.list_author_payout_history(p_limit => 10, p_cursor_created_at => v_last_created_at, p_cursor_id => v_last_id)
  );
  perform pg_temp.assert(v_overlap_count = 0, format('pagination: page 1 and page 2 must never overlap, got %s shared rows', v_overlap_count));

  reset role;
end $$;

-- Malformed half-cursor is rejected.
do $$
begin
  perform set_config('request.jwt.claim.sub', 'e0521600-0000-0000-0000-000000000001', true);
  set local role authenticated;
  begin
    perform * from public.list_author_payout_history(p_limit => 10, p_cursor_created_at => now());
    perform pg_temp.assert(false, 'pagination: a half-cursor (created_at set, id missing) must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'invalid cursor', format('pagination: expected ''invalid cursor'', got %s', sqlerrm));
  end;
  reset role;
end $$;

-- ============================================================
-- Part K: CANONICAL-BALANCE REGRESSION (Section 42) -- migration 052
-- must not alter author_ledger_balance()/get_author_financial_summary()
-- semantics in any way.
-- ============================================================

do $$
declare
  v_summary record;
begin
  perform set_config('request.jwt.claim.sub', 'e0521700-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select * into v_summary from public.get_author_financial_summary() where currency = 'USD';
  reset role;

  perform pg_temp.assert(v_summary.pending_minor = 0, format('regression: pending must be 0 (sale reversed before settlement), got %s', v_summary.pending_minor));
  perform pg_temp.assert(v_summary.available_minor = 0, format('regression: available must be 0, got %s', v_summary.available_minor));
  perform pg_temp.assert(v_summary.current_balance_minor = 0, format('regression: current_balance must be 0, got %s', v_summary.current_balance_minor));
  perform pg_temp.assert(v_summary.lifetime_refund_minor = 100, format('regression: lifetime_refund must be 100, got %s', v_summary.lifetime_refund_minor));
  perform pg_temp.assert(v_summary.lifetime_sale_minor = 100, format('regression: lifetime_sale must be 100, got %s', v_summary.lifetime_sale_minor));
end $$;

select 'ALL PASSED: 052_author_payout_reporting.test.sql' as result;

rollback;
