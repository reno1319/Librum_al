-- Committed SQL regression suite for migration 053 (LEDGER-1E-D-B:
-- payout scheduler database foundation -- canonical eligibility, pure
-- dry run, idempotent scheduled-run create/resume/complete, and the
-- reserve_author_payout() internal refactor).
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql -- no new test
-- infrastructure needed, same as every other suite in this directory.
--
-- Run manually against a disposable/local Postgres instance, AFTER
-- applying supabase/schema.sql (which already includes migration 053's
-- final state), from the repo root:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/053_payout_scheduler_foundation.test.sql
--
-- A SEPARATE script, 053_scheduled_run_creation_contention.sh, proves
-- the (run_type, run_key) uniqueness invariant against two REAL,
-- concurrent Postgres connections -- a single-transaction .sql file
-- structurally cannot do that. See that script's own header, and
-- 051_payout_reservation_contention.sh's, for why.
--
-- Everything below runs inside one transaction and is rolled back at
-- the end, so now() is CONSTANT throughout -- every future/past
-- timestamp fixture is seeded with an explicit `now() +/- interval`
-- value. `start_scheduled_payout_run()`'s own current-Europe/Tirane-
-- month comparison uses this SAME frozen now(), so every "retroactive
-- prior month" fixture below is computed relative to it (via
-- date_trunc('month', now()) minus an interval), never a hardcoded
-- literal date, so this suite is never flaky against the calendar date
-- it happens to be run on.
--
-- Ledger/payout/settings fixtures are inserted DIRECTLY (as the
-- connecting superuser/table owner, bypassing RLS -- the same
-- convention every 048/049/050/051/052 test file already uses).

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
-- chain -- S1's own "no_settings" scenario below is unaffected, since
-- that check fires before no_minimum_policy regardless of policy
-- presence). Seed a permissive policy (1 minor unit) for every
-- currency this suite's fixtures use, so none of THIS file's own
-- threshold/balance assertions (which predate 055) are affected.
insert into public.payout_minimum_policy (currency, minimum_threshold_minor, is_active) values
  ('EUR', 1, true),
  ('USD', 1, true);

-- ============================================================
-- Part 1: author_payout_eligibility() -- one dedicated author per
-- scenario, kept currency-isolated so each result can be hand-verified
-- independently.
-- ============================================================

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('05300100-0000-0000-0000-000000000001', 'p053-s01@test', now(), '{"role":"author","display_name":"S1 No Settings"}'),
  ('05300200-0000-0000-0000-000000000001', 'p053-s02@test', now(), '{"role":"author","display_name":"S2 No Available Balance"}'),
  ('05300300-0000-0000-0000-000000000001', 'p053-s03@test', now(), '{"role":"author","display_name":"S3 Below Threshold"}'),
  ('05300400-0000-0000-0000-000000000001', 'p053-s04@test', now(), '{"role":"author","display_name":"S4 Exact Threshold"}'),
  ('05300500-0000-0000-0000-000000000001', 'p053-s05@test', now(), '{"role":"author","display_name":"S5 Above Threshold"}'),
  ('05300600-0000-0000-0000-000000000001', 'p053-s06@test', now(), '{"role":"author","display_name":"S6 Pending Active"}'),
  ('05300700-0000-0000-0000-000000000001', 'p053-s07@test', now(), '{"role":"author","display_name":"S7 Processing Active"}'),
  ('05300800-0000-0000-0000-000000000001', 'p053-s08@test', now(), '{"role":"author","display_name":"S8 Reconciling Active"}'),
  ('05300900-0000-0000-0000-000000000001', 'p053-s09@test', now(), '{"role":"author","display_name":"S9 Terminal Not Active"}'),
  ('05301000-0000-0000-0000-000000000001', 'p053-s10@test', now(), '{"role":"author","display_name":"S10 Negative Payoutable"}'),
  ('05301100-0000-0000-0000-000000000001', 'p053-s11@test', now(), '{"role":"author","display_name":"S11 Multi Currency"}'),
  ('05301200-0000-0000-0000-000000000001', 'p053-s12@test', now(), '{"role":"author","display_name":"S12 Pending Settlement"}');

-- S1: ledger activity exists, but NO settings row at all.
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('05300100-0000-0000-0000-000000000002', '05300100-0000-0000-0000-000000000001', 'S1 Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('05300100-0000-0000-0000-000000000003', '05300100-0000-0000-0000-000000000002', '05300100-0000-0000-0000-000000000001', 'cs_p053_s01', 100);
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('53395df2-2aa3-21fc-3f46-dc6b02f33737', 'test', 'pay_auto_53395df2', 100, 'USD', 'succeeded');

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('05300100-0000-0000-0000-000000000004', '05300100-0000-0000-0000-000000000001',
   '05300100-0000-0000-0000-000000000003', '53395df2-2aa3-21fc-3f46-dc6b02f33737', 'sale', 100, 'USD', 8000, 100, 0,
   now() - interval '10 days', now() - interval '10 days');

do $$
declare
  v_row record;
begin
  select * into v_row from public.author_payout_eligibility('05300100-0000-0000-0000-000000000001', 'USD');
  perform pg_temp.assert(v_row.eligible = false, 'S1: no settings row must be ineligible');
  perform pg_temp.assert(v_row.ineligible_reason = 'no_settings', format('S1: reason must be no_settings, got %s', v_row.ineligible_reason));
  perform pg_temp.assert(v_row.threshold_configured = false, 'S1: threshold_configured must be false');
  perform pg_temp.assert(v_row.threshold_minor is null, 'S1: threshold_minor must be null, never a fabricated default');
end $$;

-- S2: settings configured, but ZERO ledger activity for that currency
-- at all (no author_ledger_entries row exists).
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('05300200-0000-0000-0000-000000000001', 50, 'USD');
-- Migration 055 fail-closed gate: author_payout_eligibility() now
-- also requires a saved payout destination (no_destination sits
-- between below_threshold and eligible). Give every author/currency
-- pair from the settings insert immediately above a matching
-- destination fixture so none of THIS file's own
-- eligibility/reservation-success assertions (which predate 055) are
-- affected; a destination configured but not reached in the
-- priority chain is harmless to any ineligibility-reason assertion.
insert into public.author_payout_destinations (author_id, currency, beneficiary_name, iban) values
  ('05300200-0000-0000-0000-000000000001', 'USD', 'Fixture Beneficiary', 'FIXTURE-IBAN-NOT-VALIDATED');

do $$
declare
  v_row record;
begin
  select * into v_row from public.author_payout_eligibility('05300200-0000-0000-0000-000000000001', 'USD');
  perform pg_temp.assert(v_row.eligible = false, 'S2: no ledger activity must be ineligible');
  perform pg_temp.assert(v_row.ineligible_reason = 'no_available_balance', format('S2: reason must be no_available_balance, got %s', v_row.ineligible_reason));
  perform pg_temp.assert(v_row.ledger_available_minor is null, 'S2: ledger_available_minor must be null, distinct from a real zero balance');
  perform pg_temp.assert(v_row.payoutable_minor is null, 'S2: payoutable_minor must be null when there is no ledger truth to compute from');
end $$;

-- S3: below threshold (40 available, 50 threshold).
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('05300300-0000-0000-0000-000000000002', '05300300-0000-0000-0000-000000000001', 'S3 Book', '', '', '', 40, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('05300300-0000-0000-0000-000000000003', '05300300-0000-0000-0000-000000000002', '05300300-0000-0000-0000-000000000001', 'cs_p053_s03', 40);
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('d5badc63-d045-4daf-3cb4-1cd0fba28a73', 'test', 'pay_auto_d5badc63', 40, 'USD', 'succeeded');

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('05300300-0000-0000-0000-000000000004', '05300300-0000-0000-0000-000000000001',
   '05300300-0000-0000-0000-000000000003', 'd5badc63-d045-4daf-3cb4-1cd0fba28a73', 'sale', 40, 'USD', 8000, 40, 0,
   now() - interval '10 days', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('05300300-0000-0000-0000-000000000001', 50, 'USD');
-- Migration 055 fail-closed gate: author_payout_eligibility() now
-- also requires a saved payout destination (no_destination sits
-- between below_threshold and eligible). Give every author/currency
-- pair from the settings insert immediately above a matching
-- destination fixture so none of THIS file's own
-- eligibility/reservation-success assertions (which predate 055) are
-- affected; a destination configured but not reached in the
-- priority chain is harmless to any ineligibility-reason assertion.
insert into public.author_payout_destinations (author_id, currency, beneficiary_name, iban) values
  ('05300300-0000-0000-0000-000000000001', 'USD', 'Fixture Beneficiary', 'FIXTURE-IBAN-NOT-VALIDATED');

do $$
declare
  v_row record;
begin
  select * into v_row from public.author_payout_eligibility('05300300-0000-0000-0000-000000000001', 'USD');
  perform pg_temp.assert(v_row.eligible = false, 'S3: 40 available < 50 threshold must be ineligible');
  perform pg_temp.assert(v_row.ineligible_reason = 'below_threshold', format('S3: reason must be below_threshold, got %s', v_row.ineligible_reason));
  perform pg_temp.assert(v_row.payoutable_minor = 40, format('S3: payoutable_minor must be 40, got %s', v_row.payoutable_minor));
end $$;

-- S4: exactly threshold (50 available, 50 threshold) -> eligible, full
-- payoutable reserved.
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('05300400-0000-0000-0000-000000000002', '05300400-0000-0000-0000-000000000001', 'S4 Book', '', '', '', 50, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('05300400-0000-0000-0000-000000000003', '05300400-0000-0000-0000-000000000002', '05300400-0000-0000-0000-000000000001', 'cs_p053_s04', 50);
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('e9cfa35e-d9f1-5ca5-be24-96f63251dc94', 'test', 'pay_auto_e9cfa35e', 50, 'USD', 'succeeded');

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('05300400-0000-0000-0000-000000000004', '05300400-0000-0000-0000-000000000001',
   '05300400-0000-0000-0000-000000000003', 'e9cfa35e-d9f1-5ca5-be24-96f63251dc94', 'sale', 50, 'USD', 8000, 50, 0,
   now() - interval '10 days', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('05300400-0000-0000-0000-000000000001', 50, 'USD');
-- Migration 055 fail-closed gate: author_payout_eligibility() now
-- also requires a saved payout destination (no_destination sits
-- between below_threshold and eligible). Give every author/currency
-- pair from the settings insert immediately above a matching
-- destination fixture so none of THIS file's own
-- eligibility/reservation-success assertions (which predate 055) are
-- affected; a destination configured but not reached in the
-- priority chain is harmless to any ineligibility-reason assertion.
insert into public.author_payout_destinations (author_id, currency, beneficiary_name, iban) values
  ('05300400-0000-0000-0000-000000000001', 'USD', 'Fixture Beneficiary', 'FIXTURE-IBAN-NOT-VALIDATED');

do $$
declare
  v_row record;
begin
  select * into v_row from public.author_payout_eligibility('05300400-0000-0000-0000-000000000001', 'USD');
  perform pg_temp.assert(v_row.eligible = true, 'S4: exactly-at-threshold must be eligible');
  perform pg_temp.assert(v_row.ineligible_reason is null, 'S4: ineligible_reason must be null when eligible');
  perform pg_temp.assert(v_row.payoutable_minor = 50, format('S4: payoutable_minor must be 50, got %s', v_row.payoutable_minor));
end $$;

-- S5: above threshold (73 available, 50 threshold) -> FULL payoutable
-- reserved, not just the threshold.
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('05300500-0000-0000-0000-000000000002', '05300500-0000-0000-0000-000000000001', 'S5 Book', '', '', '', 73, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('05300500-0000-0000-0000-000000000003', '05300500-0000-0000-0000-000000000002', '05300500-0000-0000-0000-000000000001', 'cs_p053_s05', 73);
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('85b63fc1-63cd-2d81-5c04-5215b6f83121', 'test', 'pay_auto_85b63fc1', 73, 'USD', 'succeeded');

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('05300500-0000-0000-0000-000000000004', '05300500-0000-0000-0000-000000000001',
   '05300500-0000-0000-0000-000000000003', '85b63fc1-63cd-2d81-5c04-5215b6f83121', 'sale', 73, 'USD', 8000, 73, 0,
   now() - interval '10 days', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('05300500-0000-0000-0000-000000000001', 50, 'USD');
-- Migration 055 fail-closed gate: author_payout_eligibility() now
-- also requires a saved payout destination (no_destination sits
-- between below_threshold and eligible). Give every author/currency
-- pair from the settings insert immediately above a matching
-- destination fixture so none of THIS file's own
-- eligibility/reservation-success assertions (which predate 055) are
-- affected; a destination configured but not reached in the
-- priority chain is harmless to any ineligibility-reason assertion.
insert into public.author_payout_destinations (author_id, currency, beneficiary_name, iban) values
  ('05300500-0000-0000-0000-000000000001', 'USD', 'Fixture Beneficiary', 'FIXTURE-IBAN-NOT-VALIDATED');

do $$
declare
  v_row record;
begin
  select * into v_row from public.author_payout_eligibility('05300500-0000-0000-0000-000000000001', 'USD');
  perform pg_temp.assert(v_row.eligible = true, 'S5: above threshold must be eligible');
  perform pg_temp.assert(v_row.payoutable_minor = 73, format('S5: payoutable_minor must be the FULL 73, not the 50 threshold, got %s', v_row.payoutable_minor));
end $$;

-- S6/S7/S8: an existing active reservation (pending/processing/
-- reconciling) is an ABSOLUTE blocker, even though remaining
-- arithmetic payoutable (120 available - 50 reserved = 70) would
-- otherwise exceed the 50 threshold.
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('05300600-0000-0000-0000-000000000002', '05300600-0000-0000-0000-000000000001', 'S6 Book', '', '', '', 120, 'published'),
  ('05300700-0000-0000-0000-000000000002', '05300700-0000-0000-0000-000000000001', 'S7 Book', '', '', '', 120, 'published'),
  ('05300800-0000-0000-0000-000000000002', '05300800-0000-0000-0000-000000000001', 'S8 Book', '', '', '', 120, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('05300600-0000-0000-0000-000000000003', '05300600-0000-0000-0000-000000000002', '05300600-0000-0000-0000-000000000001', 'cs_p053_s06', 120),
  ('05300700-0000-0000-0000-000000000003', '05300700-0000-0000-0000-000000000002', '05300700-0000-0000-0000-000000000001', 'cs_p053_s07', 120),
  ('05300800-0000-0000-0000-000000000003', '05300800-0000-0000-0000-000000000002', '05300800-0000-0000-0000-000000000001', 'cs_p053_s08', 120);
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('38f577a6-0efe-8746-f54a-fcc715cb4e52', 'test', 'pay_auto_38f577a6', 120, 'USD', 'succeeded'),
  ('02419349-c84e-21a6-2b7b-584ca42a9c60', 'test', 'pay_auto_02419349', 120, 'USD', 'succeeded'),
  ('399905f8-3780-b3d5-aa9a-767eac4008c7', 'test', 'pay_auto_399905f8', 120, 'USD', 'succeeded');

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('05300600-0000-0000-0000-000000000004', '05300600-0000-0000-0000-000000000001',
   '05300600-0000-0000-0000-000000000003', '38f577a6-0efe-8746-f54a-fcc715cb4e52', 'sale', 120, 'USD', 8000, 120, 0, now() - interval '10 days', now() - interval '10 days'),
  ('05300700-0000-0000-0000-000000000004', '05300700-0000-0000-0000-000000000001',
   '05300700-0000-0000-0000-000000000003', '02419349-c84e-21a6-2b7b-584ca42a9c60', 'sale', 120, 'USD', 8000, 120, 0, now() - interval '10 days', now() - interval '10 days'),
  ('05300800-0000-0000-0000-000000000004', '05300800-0000-0000-0000-000000000001',
   '05300800-0000-0000-0000-000000000003', '399905f8-3780-b3d5-aa9a-767eac4008c7', 'sale', 120, 'USD', 8000, 120, 0, now() - interval '10 days', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('05300600-0000-0000-0000-000000000001', 50, 'USD'),
  ('05300700-0000-0000-0000-000000000001', 50, 'USD'),
  ('05300800-0000-0000-0000-000000000001', 50, 'USD');
-- Migration 055 fail-closed gate: author_payout_eligibility() now
-- also requires a saved payout destination (no_destination sits
-- between below_threshold and eligible). Give every author/currency
-- pair from the settings insert immediately above a matching
-- destination fixture so none of THIS file's own
-- eligibility/reservation-success assertions (which predate 055) are
-- affected; a destination configured but not reached in the
-- priority chain is harmless to any ineligibility-reason assertion.
insert into public.author_payout_destinations (author_id, currency, beneficiary_name, iban) values
  ('05300600-0000-0000-0000-000000000001', 'USD', 'Fixture Beneficiary', 'FIXTURE-IBAN-NOT-VALIDATED'),
  ('05300700-0000-0000-0000-000000000001', 'USD', 'Fixture Beneficiary', 'FIXTURE-IBAN-NOT-VALIDATED'),
  ('05300800-0000-0000-0000-000000000001', 'USD', 'Fixture Beneficiary', 'FIXTURE-IBAN-NOT-VALIDATED');
insert into public.author_payouts (author_id, amount_minor, currency, status) values
  ('05300600-0000-0000-0000-000000000001', 50, 'USD', 'pending');
insert into public.author_payouts (author_id, amount_minor, currency, status, processing_at) values
  ('05300700-0000-0000-0000-000000000001', 50, 'USD', 'processing', now() - interval '1 hour');
insert into public.author_payouts (author_id, amount_minor, currency, status, processing_at) values
  ('05300800-0000-0000-0000-000000000001', 50, 'USD', 'reconciling', now() - interval '1 hour');

do $$
declare
  v_row record;
begin
  select * into v_row from public.author_payout_eligibility('05300600-0000-0000-0000-000000000001', 'USD');
  perform pg_temp.assert(v_row.eligible = false, 'S6: an existing PENDING reservation must be an absolute blocker');
  perform pg_temp.assert(v_row.ineligible_reason = 'active_reservation', format('S6: reason must be active_reservation, got %s', v_row.ineligible_reason));
  perform pg_temp.assert(v_row.active_reservation = true, 'S6: active_reservation flag must be true');
  perform pg_temp.assert(v_row.payoutable_minor = 70, format('S6: payoutable_minor is still reported (70) even though ineligible, got %s', v_row.payoutable_minor));
end $$;

do $$
declare
  v_row record;
begin
  select * into v_row from public.author_payout_eligibility('05300700-0000-0000-0000-000000000001', 'USD');
  perform pg_temp.assert(v_row.eligible = false, 'S7: an existing PROCESSING reservation must be an absolute blocker');
  perform pg_temp.assert(v_row.ineligible_reason = 'active_reservation', format('S7: reason must be active_reservation, got %s', v_row.ineligible_reason));
end $$;

do $$
declare
  v_row record;
begin
  select * into v_row from public.author_payout_eligibility('05300800-0000-0000-0000-000000000001', 'USD');
  perform pg_temp.assert(v_row.eligible = false, 'S8: an existing RECONCILING reservation must be an absolute blocker');
  perform pg_temp.assert(v_row.ineligible_reason = 'active_reservation', format('S8: reason must be active_reservation, got %s', v_row.ineligible_reason));
end $$;

-- S9: TERMINAL payouts (paid/failed/cancelled) are NOT active -- an
-- author with only terminal history remains eligible on their own
-- remaining balance.
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('05300900-0000-0000-0000-000000000002', '05300900-0000-0000-0000-000000000001', 'S9 Book', '', '', '', 200, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('05300900-0000-0000-0000-000000000003', '05300900-0000-0000-0000-000000000002', '05300900-0000-0000-0000-000000000001', 'cs_p053_s09', 200);
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('d48d3fe0-c161-5e36-7822-9e301ebf6dab', 'test', 'pay_auto_d48d3fe0', 200, 'USD', 'succeeded');

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('05300900-0000-0000-0000-000000000004', '05300900-0000-0000-0000-000000000001',
   '05300900-0000-0000-0000-000000000003', 'd48d3fe0-c161-5e36-7822-9e301ebf6dab', 'sale', 200, 'USD', 8000, 200, 0, now() - interval '10 days', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('05300900-0000-0000-0000-000000000001', 50, 'USD');
-- Migration 055 fail-closed gate: author_payout_eligibility() now
-- also requires a saved payout destination (no_destination sits
-- between below_threshold and eligible). Give every author/currency
-- pair from the settings insert immediately above a matching
-- destination fixture so none of THIS file's own
-- eligibility/reservation-success assertions (which predate 055) are
-- affected; a destination configured but not reached in the
-- priority chain is harmless to any ineligibility-reason assertion.
insert into public.author_payout_destinations (author_id, currency, beneficiary_name, iban) values
  ('05300900-0000-0000-0000-000000000001', 'USD', 'Fixture Beneficiary', 'FIXTURE-IBAN-NOT-VALIDATED');
insert into public.author_payouts (author_id, amount_minor, currency, status, paid_at, provider, provider_reference) values
  ('05300900-0000-0000-0000-000000000001', 30, 'USD', 'paid', now() - interval '5 days', 'test', 'ref-s09-paid');
insert into public.author_payouts (author_id, amount_minor, currency, status, failed_at, failure_code) values
  ('05300900-0000-0000-0000-000000000001', 30, 'USD', 'failed', now() - interval '4 days', 'test_failure');
insert into public.author_payouts (author_id, amount_minor, currency, status) values
  ('05300900-0000-0000-0000-000000000001', 30, 'USD', 'cancelled');
-- The 'paid' row's ledger debit, mirroring exactly what
-- finalize_author_payout() itself would have produced.
insert into public.author_ledger_entries
  (author_id, payout_id, entry_type, amount_minor, currency, available_at, created_at)
select '05300900-0000-0000-0000-000000000001', id, 'payout', -30, 'USD', now() - interval '5 days', now() - interval '5 days'
from public.author_payouts
where author_id = '05300900-0000-0000-0000-000000000001' and status = 'paid';

do $$
declare
  v_row record;
begin
  select * into v_row from public.author_payout_eligibility('05300900-0000-0000-0000-000000000001', 'USD');
  perform pg_temp.assert(v_row.active_reservation = false, 'S9: paid/failed/cancelled payouts must NOT count as an active reservation');
  perform pg_temp.assert(v_row.reserved_minor = 0, format('S9: reserved_minor must be 0 (no active rows), got %s', v_row.reserved_minor));
  perform pg_temp.assert(v_row.ledger_available_minor = 170, format('S9: ledger_available_minor must be 200 - 30 (paid debit) = 170, got %s', v_row.ledger_available_minor));
  perform pg_temp.assert(v_row.eligible = true, 'S9: must remain eligible on the remaining 170 balance');
  perform pg_temp.assert(v_row.payoutable_minor = 170, format('S9: payoutable_minor must be 170, got %s', v_row.payoutable_minor));
end $$;

-- S10: negative payoutable (post-payout refund, mirroring 050's own
-- Part 3 / 051's own E4 case) -> ineligible via below_threshold, never
-- clamped.
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('05301000-0000-0000-0000-000000000002', '05301000-0000-0000-0000-000000000001', 'S10 Book', '', '', '', 800, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('05301000-0000-0000-0000-000000000003', '05301000-0000-0000-0000-000000000002', '05301000-0000-0000-0000-000000000001', 'cs_p053_s10', 800);
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('05301000-0000-0000-0000-000000000009', 'test', 'pay_p053_s10', 800, 'USD', 'succeeded');
update public.purchases set payment_id = '05301000-0000-0000-0000-000000000009' where id = '05301000-0000-0000-0000-000000000003';
insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('05301000-0000-0000-0000-000000000004', '05301000-0000-0000-0000-000000000001',
   '05301000-0000-0000-0000-000000000003', '05301000-0000-0000-0000-000000000009', 'sale', 640, 'USD', 8000, 800, 160,
   now() - interval '40 days', now() - interval '70 days');
insert into public.author_payouts (id, author_id, amount_minor, currency, status, provider, provider_reference, paid_at) values
  ('05301000-0000-0000-0000-000000000005', '05301000-0000-0000-0000-000000000001', 640, 'USD', 'paid', 'test', 'ref-s10-preexisting', now() - interval '30 days');
insert into public.author_ledger_entries
  (id, author_id, payout_id, entry_type, amount_minor, currency, available_at, created_at)
values
  ('05301000-0000-0000-0000-000000000006', '05301000-0000-0000-0000-000000000001',
   '05301000-0000-0000-0000-000000000005', 'payout', -640, 'USD', now() - interval '30 days', now() - interval '30 days');
insert into public.payment_refunds (id, payment_id, purchase_id, provider, provider_refund_id, amount_minor, currency, refunded_at) values
  ('05301000-0000-0000-0000-000000000007', '05301000-0000-0000-0000-000000000009', '05301000-0000-0000-0000-000000000003',
   'test', 'refund_p053_s10', 800, 'USD', now());
insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, payment_refund_id, entry_type, amount_minor, currency, available_at, created_at)
values
  ('05301000-0000-0000-0000-000000000008', '05301000-0000-0000-0000-000000000001',
   '05301000-0000-0000-0000-000000000003', '05301000-0000-0000-0000-000000000009', '05301000-0000-0000-0000-000000000007',
   'refund', -640, 'USD', now(), now());
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('05301000-0000-0000-0000-000000000001', 50, 'USD');
-- Migration 055 fail-closed gate: author_payout_eligibility() now
-- also requires a saved payout destination (no_destination sits
-- between below_threshold and eligible). Give every author/currency
-- pair from the settings insert immediately above a matching
-- destination fixture so none of THIS file's own
-- eligibility/reservation-success assertions (which predate 055) are
-- affected; a destination configured but not reached in the
-- priority chain is harmless to any ineligibility-reason assertion.
insert into public.author_payout_destinations (author_id, currency, beneficiary_name, iban) values
  ('05301000-0000-0000-0000-000000000001', 'USD', 'Fixture Beneficiary', 'FIXTURE-IBAN-NOT-VALIDATED');

do $$
declare
  v_row record;
begin
  select * into v_row from public.author_payout_eligibility('05301000-0000-0000-0000-000000000001', 'USD');
  perform pg_temp.assert(v_row.ledger_available_minor = -640, format('S10: ledger_available_minor must be NEGATIVE -640, never clamped, got %s', v_row.ledger_available_minor));
  perform pg_temp.assert(v_row.payoutable_minor = -640, format('S10: payoutable_minor must be NEGATIVE -640, never clamped, got %s', v_row.payoutable_minor));
  perform pg_temp.assert(v_row.eligible = false, 'S10: negative payoutable must be ineligible');
  perform pg_temp.assert(v_row.ineligible_reason = 'below_threshold', format('S10: reason must be below_threshold, got %s', v_row.ineligible_reason));
end $$;

-- S11: multi-currency independence -- EUR eligible, USD not, same
-- author, never combined.
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('05301100-0000-0000-0000-000000000002', '05301100-0000-0000-0000-000000000001', 'S11 EUR Book', '', '', '', 100, 'published'),
  ('05301100-0000-0000-0000-000000000006', '05301100-0000-0000-0000-000000000001', 'S11 USD Book', '', '', '', 10, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('05301100-0000-0000-0000-000000000003', '05301100-0000-0000-0000-000000000002', '05301100-0000-0000-0000-000000000001', 'cs_p053_s11_eur', 100),
  ('05301100-0000-0000-0000-000000000007', '05301100-0000-0000-0000-000000000006', '05301100-0000-0000-0000-000000000001', 'cs_p053_s11_usd', 10);
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('0e7f2ea1-c61f-713e-78e0-f188518d8d65', 'test', 'pay_auto_0e7f2ea1', 100, 'EUR', 'succeeded'),
  ('6aafec27-5504-2c3a-7117-7b69aa08bf17', 'test', 'pay_auto_6aafec27', 10, 'USD', 'succeeded');

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('05301100-0000-0000-0000-000000000004', '05301100-0000-0000-0000-000000000001',
   '05301100-0000-0000-0000-000000000003', '0e7f2ea1-c61f-713e-78e0-f188518d8d65', 'sale', 100, 'EUR', 8000, 100, 0, now() - interval '10 days', now() - interval '10 days'),
  ('05301100-0000-0000-0000-000000000008', '05301100-0000-0000-0000-000000000001',
   '05301100-0000-0000-0000-000000000007', '6aafec27-5504-2c3a-7117-7b69aa08bf17', 'sale', 10, 'USD', 8000, 10, 0, now() - interval '10 days', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('05301100-0000-0000-0000-000000000001', 50, 'EUR'),
  ('05301100-0000-0000-0000-000000000001', 50, 'USD');
-- Migration 055 fail-closed gate: author_payout_eligibility() now
-- also requires a saved payout destination (no_destination sits
-- between below_threshold and eligible). Give every author/currency
-- pair from the settings insert immediately above a matching
-- destination fixture so none of THIS file's own
-- eligibility/reservation-success assertions (which predate 055) are
-- affected; a destination configured but not reached in the
-- priority chain is harmless to any ineligibility-reason assertion.
insert into public.author_payout_destinations (author_id, currency, beneficiary_name, iban) values
  ('05301100-0000-0000-0000-000000000001', 'EUR', 'Fixture Beneficiary', 'FIXTURE-IBAN-NOT-VALIDATED'),
  ('05301100-0000-0000-0000-000000000001', 'USD', 'Fixture Beneficiary', 'FIXTURE-IBAN-NOT-VALIDATED');

do $$
declare
  v_eur record;
  v_usd record;
begin
  select * into v_eur from public.author_payout_eligibility('05301100-0000-0000-0000-000000000001', 'EUR');
  select * into v_usd from public.author_payout_eligibility('05301100-0000-0000-0000-000000000001', 'USD');
  perform pg_temp.assert(v_eur.eligible = true, 'S11: EUR (100 >= 50) must be eligible');
  perform pg_temp.assert(v_eur.payoutable_minor = 100, format('S11: EUR payoutable must be 100, got %s', v_eur.payoutable_minor));
  perform pg_temp.assert(v_usd.eligible = false, 'S11: USD (10 < 50) must be ineligible');
  perform pg_temp.assert(v_usd.ineligible_reason = 'below_threshold', 'S11: USD reason must be below_threshold');
  perform pg_temp.assert(v_usd.payoutable_minor = 10, format('S11: USD payoutable must be 10, never combined with EUR, got %s', v_usd.payoutable_minor));
end $$;

-- S12: a FUTURE-dated sale (not yet settled) does not count as
-- available -- ledger_available_minor is 0 (a real row exists, unlike
-- S2), payoutable is 0, ineligible via below_threshold.
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('05301200-0000-0000-0000-000000000002', '05301200-0000-0000-0000-000000000001', 'S12 Book', '', '', '', 100, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('05301200-0000-0000-0000-000000000003', '05301200-0000-0000-0000-000000000002', '05301200-0000-0000-0000-000000000001', 'cs_p053_s12', 100);
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('c7dd0852-9e44-f9e0-e7ec-d9bfd6d8691c', 'test', 'pay_auto_c7dd0852', 100, 'USD', 'succeeded');

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('05301200-0000-0000-0000-000000000004', '05301200-0000-0000-0000-000000000001',
   '05301200-0000-0000-0000-000000000003', 'c7dd0852-9e44-f9e0-e7ec-d9bfd6d8691c', 'sale', 100, 'USD', 8000, 100, 0,
   now() + interval '20 days', now() - interval '1 day');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('05301200-0000-0000-0000-000000000001', 50, 'USD');
-- Migration 055 fail-closed gate: author_payout_eligibility() now
-- also requires a saved payout destination (no_destination sits
-- between below_threshold and eligible). Give every author/currency
-- pair from the settings insert immediately above a matching
-- destination fixture so none of THIS file's own
-- eligibility/reservation-success assertions (which predate 055) are
-- affected; a destination configured but not reached in the
-- priority chain is harmless to any ineligibility-reason assertion.
insert into public.author_payout_destinations (author_id, currency, beneficiary_name, iban) values
  ('05301200-0000-0000-0000-000000000001', 'USD', 'Fixture Beneficiary', 'FIXTURE-IBAN-NOT-VALIDATED');

do $$
declare
  v_row record;
begin
  select * into v_row from public.author_payout_eligibility('05301200-0000-0000-0000-000000000001', 'USD');
  perform pg_temp.assert(v_row.ledger_available_minor = 0, format('S12: pending settlement must not count as available yet, got %s', v_row.ledger_available_minor));
  perform pg_temp.assert(v_row.payoutable_minor = 0, format('S12: payoutable_minor must be 0, got %s', v_row.payoutable_minor));
  perform pg_temp.assert(v_row.eligible = false, 'S12: must be ineligible while settlement is still pending');
  perform pg_temp.assert(v_row.ineligible_reason = 'below_threshold', 'S12: reason must be below_threshold (a real ledger row exists, distinct from S2)');
end $$;

-- ============================================================
-- Part 2: dry_run_scheduled_payouts() -- purity + candidate-universe +
-- output-parity checks.
-- ============================================================

do $$
declare
  v_before_runs integer;
  v_before_payouts integer;
  v_before_ledger integer;
  v_after_runs integer;
  v_after_payouts integer;
  v_after_ledger integer;
  v_row record;
  v_count integer;
begin
  select count(*) into v_before_runs from public.payout_runs;
  select count(*) into v_before_payouts from public.author_payouts;
  select count(*) into v_before_ledger from public.author_ledger_entries;

  -- D1: only settings-bearing candidates appear. S1 (ledger activity,
  -- NO settings row) must be entirely absent from the bulk scan.
  select count(*) into v_count from public.dry_run_scheduled_payouts()
    where author_id = '05300100-0000-0000-0000-000000000001';
  perform pg_temp.assert(v_count = 0, format('D1: an author with no settings row must not appear in the bulk dry-run scan, got %s rows', v_count));

  -- D1b: an author WITH a settings row does appear (S4).
  select count(*) into v_count from public.dry_run_scheduled_payouts()
    where author_id = '05300400-0000-0000-0000-000000000001' and currency = 'USD';
  perform pg_temp.assert(v_count = 1, format('D1b: an author with a settings row must appear exactly once, got %s', v_count));

  -- D2/D3/D4: zero mutation of any kind.
  select count(*) into v_after_runs from public.payout_runs;
  select count(*) into v_after_payouts from public.author_payouts;
  select count(*) into v_after_ledger from public.author_ledger_entries;
  perform pg_temp.assert(v_before_runs = v_after_runs, 'D2: dry run must never mutate payout_runs');
  perform pg_temp.assert(v_before_payouts = v_after_payouts, 'D3: dry run must never mutate author_payouts');
  perform pg_temp.assert(v_before_ledger = v_after_ledger, 'D4: dry run must never mutate author_ledger_entries');

  -- D6: threshold/full-payout semantics match the eligibility helper's
  -- own output exactly (reuses S5's above-threshold fixture).
  select * into v_row from public.dry_run_scheduled_payouts()
    where author_id = '05300500-0000-0000-0000-000000000001' and currency = 'USD';
  perform pg_temp.assert(v_row.eligible = true, 'D6: S5 candidate must show eligible in the dry-run output');
  perform pg_temp.assert(v_row.payoutable_minor = 73, format('D6: S5 candidate must show payoutable 73 (full amount, not threshold), got %s', v_row.payoutable_minor));

  -- D7: active-reservation reason surfaces in dry-run output too.
  select * into v_row from public.dry_run_scheduled_payouts()
    where author_id = '05300600-0000-0000-0000-000000000001' and currency = 'USD';
  perform pg_temp.assert(v_row.eligible = false, 'D7: S6 candidate (active pending payout) must show ineligible in dry-run');
  perform pg_temp.assert(v_row.ineligible_reason = 'active_reservation', 'D7: S6 candidate must show active_reservation reason in dry-run');

  -- D8: multi-currency -- both S11 rows present, independent values.
  select count(*) into v_count from public.dry_run_scheduled_payouts()
    where author_id = '05301100-0000-0000-0000-000000000001';
  perform pg_temp.assert(v_count = 2, format('D8: an author with 2 currency settings rows must yield 2 dry-run rows, got %s', v_count));

  -- D9: no cross-author/currency mixing -- S11's EUR row must not leak
  -- USD's own payoutable value or vice versa.
  select * into v_row from public.dry_run_scheduled_payouts()
    where author_id = '05301100-0000-0000-0000-000000000001' and currency = 'EUR';
  perform pg_temp.assert(v_row.payoutable_minor = 100, format('D9: EUR row must show its own 100, got %s', v_row.payoutable_minor));
end $$;

-- D5: same output on repeated call with unchanged state.
do $$
declare
  v_first record;
  v_second record;
begin
  select * into v_first from public.dry_run_scheduled_payouts()
    where author_id = '05300500-0000-0000-0000-000000000001' and currency = 'USD';
  select * into v_second from public.dry_run_scheduled_payouts()
    where author_id = '05300500-0000-0000-0000-000000000001' and currency = 'USD';
  perform pg_temp.assert(v_first.payoutable_minor = v_second.payoutable_minor, 'D5: repeated calls with unchanged state must return identical payoutable_minor');
  perform pg_temp.assert(v_first.eligible = v_second.eligible, 'D5: repeated calls with unchanged state must return identical eligible');
end $$;

-- ============================================================
-- Part 3: DRY-RUN / RESERVATION PARITY (Section 10/44) -- the single
-- most important test in this file.
-- ============================================================

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('05301300-0000-0000-0000-000000000001', 'p053-parity@test', now(), '{"role":"author","display_name":"Parity Author"}');
insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('05301300-0000-0000-0000-000000000002', '05301300-0000-0000-0000-000000000001', 'Parity Book', '', '', '', 91, 'published');
insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('05301300-0000-0000-0000-000000000003', '05301300-0000-0000-0000-000000000002', '05301300-0000-0000-0000-000000000001', 'cs_p053_parity', 91);
insert into public.payments (id, provider, provider_payment_id, amount_minor, currency, status) values
  ('7a7133ce-0b83-53fe-7eaa-7bc92b2def66', 'test', 'pay_auto_7a7133ce', 91, 'EUR', 'succeeded');

insert into public.author_ledger_entries
  (id, author_id, purchase_id, payment_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at, created_at)
values
  ('05301300-0000-0000-0000-000000000004', '05301300-0000-0000-0000-000000000001',
   '05301300-0000-0000-0000-000000000003', '7a7133ce-0b83-53fe-7eaa-7bc92b2def66', 'sale', 91, 'EUR', 8000, 91, 0,
   now() - interval '10 days', now() - interval '10 days');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('05301300-0000-0000-0000-000000000001', 50, 'EUR');
-- Migration 055 fail-closed gate: author_payout_eligibility() now
-- also requires a saved payout destination (no_destination sits
-- between below_threshold and eligible). Give every author/currency
-- pair from the settings insert immediately above a matching
-- destination fixture so none of THIS file's own
-- eligibility/reservation-success assertions (which predate 055) are
-- affected; a destination configured but not reached in the
-- priority chain is harmless to any ineligibility-reason assertion.
insert into public.author_payout_destinations (author_id, currency, beneficiary_name, iban) values
  ('05301300-0000-0000-0000-000000000001', 'EUR', 'Fixture Beneficiary', 'FIXTURE-IBAN-NOT-VALIDATED');

do $$
declare
  v_dry_run_amount bigint;
  v_reserve_row record;
begin
  select payoutable_minor into v_dry_run_amount
  from public.dry_run_scheduled_payouts()
  where author_id = '05301300-0000-0000-0000-000000000001' and currency = 'EUR';

  set local role service_role;
  select * into v_reserve_row from public.reserve_author_payout('05301300-0000-0000-0000-000000000001', 'EUR');
  reset role;

  perform pg_temp.assert(v_reserve_row.amount_minor = v_dry_run_amount, format('PARITY: reserved amount (%s) must exactly equal the prior dry-run payoutable amount (%s)', v_reserve_row.amount_minor, v_dry_run_amount));
  perform pg_temp.assert(v_reserve_row.amount_minor = 91, format('PARITY: sanity check, both must be exactly 91, got %s', v_reserve_row.amount_minor));
end $$;

-- ============================================================
-- Part 4: start_scheduled_payout_run() -- validation, canonical
-- run-key derivation, idempotent create-or-fetch, retroactive/future
-- month behavior.
-- ============================================================

-- R1/R2: valid first-of-month creates a running run; same target month
-- retried returns the SAME row (same id).
do $$
declare
  v_target_month date;
  v_first record;
  v_second record;
begin
  v_target_month := date_trunc('month', now())::date;

  set local role service_role;
  select * into v_first from public.start_scheduled_payout_run(v_target_month);
  reset role;

  perform pg_temp.assert(v_first.is_new = true, 'R1: first call for this target month must be is_new = true');
  perform pg_temp.assert(v_first.payout_run_status = 'running', format('R1: a freshly-created run must be status=running, got %s', v_first.payout_run_status));
  perform pg_temp.assert(v_first.payout_run_started_at is not null, 'R1: started_at must be set on creation');
  perform pg_temp.assert(v_first.payout_run_key = 'monthly:' || to_char(v_target_month, 'YYYY-MM'), format('R1: run_key must be the canonical monthly:YYYY-MM form, got %s', v_first.payout_run_key));

  set local role service_role;
  select * into v_second from public.start_scheduled_payout_run(v_target_month);
  reset role;

  perform pg_temp.assert(v_second.payout_run_id = v_first.payout_run_id, 'R2: retrying the SAME target month must return the SAME run id, not a duplicate');
  perform pg_temp.assert(v_second.is_new = false, 'R2: a retry against an existing run must report is_new = false');
  perform pg_temp.assert(v_second.payout_run_started_at = v_first.payout_run_started_at, 'R2: retrying must NEVER mutate the existing row (started_at unchanged)');
end $$;

-- R3: a DIFFERENT month creates an independent row.
do $$
declare
  v_this_month date;
  v_prior_month date;
  v_this_row record;
  v_prior_row record;
begin
  v_this_month := date_trunc('month', now())::date;
  v_prior_month := date_trunc('month', now() - interval '1 month')::date;

  set local role service_role;
  select * into v_this_row from public.start_scheduled_payout_run(v_this_month);
  select * into v_prior_row from public.start_scheduled_payout_run(v_prior_month);
  reset role;

  perform pg_temp.assert(v_this_row.payout_run_id <> v_prior_row.payout_run_id, 'R3: different target months must create independent payout_runs rows');
  perform pg_temp.assert(v_this_row.payout_run_key <> v_prior_row.payout_run_key, 'R3: different target months must have different run keys');
end $$;

-- R4: a non-first-of-month target must be REJECTED, never silently
-- normalized.
do $$
declare
  v_bad_month date;
begin
  v_bad_month := date_trunc('month', now())::date + interval '16 days';
  begin
    set local role service_role;
    perform * from public.start_scheduled_payout_run(v_bad_month);
    reset role;
    perform pg_temp.assert(false, 'R4: a non-first-of-month target_month must be rejected');
  exception when others then
    reset role;
    perform pg_temp.assert(sqlerrm like '%first day of a month%', format('R4: expected a first-day-of-month error, got %s', sqlerrm));
  end;
end $$;

-- R4b: NULL target month rejected.
do $$
begin
  begin
    set local role service_role;
    perform * from public.start_scheduled_payout_run(null);
    reset role;
    perform pg_temp.assert(false, 'R4b: a NULL target_month must be rejected');
  exception when others then
    reset role;
    perform pg_temp.assert(sqlerrm like '%is required%', format('R4b: expected a "is required" error, got %s', sqlerrm));
  end;
end $$;

-- R6: a COMPLETED run's target month, retried, returns the existing
-- completed row UNCHANGED -- never reopened.
do $$
declare
  v_target_month date;
  v_created record;
  v_completed record;
  v_retried record;
begin
  v_target_month := date_trunc('month', now() - interval '3 months')::date;

  set local role service_role;
  select * into v_created from public.start_scheduled_payout_run(v_target_month);
  select * into v_completed from public.complete_scheduled_payout_run(v_created.payout_run_id);
  select * into v_retried from public.start_scheduled_payout_run(v_target_month);
  reset role;

  perform pg_temp.assert(v_retried.payout_run_id = v_created.payout_run_id, 'R6: retrying a completed month must return the SAME run id');
  perform pg_temp.assert(v_retried.payout_run_status = 'completed', format('R6: retrying a completed month must show status=completed, got %s', v_retried.payout_run_status));
  perform pg_temp.assert(v_retried.payout_run_completed_at = v_completed.payout_run_completed_at, 'R6: retrying must never reset completed_at -- the run stays CLOSED');
  perform pg_temp.assert(v_retried.is_new = false, 'R6: retrying an existing (completed) run must report is_new = false');
end $$;

-- R7: retroactive prior-month target produces the correct canonical
-- key regardless of "now."
do $$
declare
  v_prior_month date;
  v_row record;
begin
  v_prior_month := date_trunc('month', now() - interval '5 months')::date;

  set local role service_role;
  select * into v_row from public.start_scheduled_payout_run(v_prior_month);
  reset role;

  perform pg_temp.assert(v_row.payout_run_key = 'monthly:' || to_char(v_prior_month, 'YYYY-MM'), format('R7: retroactive run must derive the correct canonical key for its OWN target month, got %s', v_row.payout_run_key));
  perform pg_temp.assert(v_row.payout_run_scheduled_for = v_prior_month, 'R7: scheduled_for must reflect the target month, not the invocation time');
end $$;

-- R8: a FUTURE month (beyond the current Europe/Tirane month) must be
-- rejected.
do $$
declare
  v_future_month date;
begin
  v_future_month := date_trunc('month', now())::date + interval '1 month';
  begin
    set local role service_role;
    perform * from public.start_scheduled_payout_run(v_future_month);
    reset role;
    perform pg_temp.assert(false, 'R8: a future target_month must be rejected');
  exception when others then
    reset role;
    perform pg_temp.assert(sqlerrm like '%is in the future%', format('R8: expected a future-month error, got %s', sqlerrm));
  end;
end $$;

-- R9: an existing FAILED run for the target month must be REJECTED,
-- never silently reopened/resumed/completed/duplicated, and the
-- existing row must never be mutated. Nothing in this migration ever
-- WRITES a 'failed' status (see Part 5's own comment -- there is no
-- fail_scheduled_payout_run() RPC), so this fixture seeds one
-- directly, as the connecting superuser, exactly as a hypothetical
-- future out-of-band recovery process might leave behind -- never via
-- any RPC, since none exists to create a failed run.
do $$
declare
  v_target_month date;
  v_run_key text;
  v_failed_id uuid;
  v_failed_started_at timestamptz;
  v_row_after record;
  v_count_after integer;
  v_payouts_before integer;
  v_payouts_after integer;
  v_ledger_before integer;
  v_ledger_after integer;
begin
  v_target_month := date_trunc('month', now() - interval '9 months')::date;
  v_run_key := 'monthly:' || to_char(v_target_month, 'YYYY-MM');
  v_failed_started_at := now() - interval '9 months';

  insert into public.payout_runs (run_type, run_key, scheduled_for, status, started_at, completed_at)
  values ('scheduled', v_run_key, v_target_month, 'failed', v_failed_started_at, null)
  returning id into v_failed_id;

  select count(*) into v_payouts_before from public.author_payouts;
  select count(*) into v_ledger_before from public.author_ledger_entries;

  begin
    set local role service_role;
    perform * from public.start_scheduled_payout_run(v_target_month);
    reset role;
    perform pg_temp.assert(false, 'R9: an existing FAILED run for this target month must be rejected, never silently resumed');
  exception when others then
    reset role;
    perform pg_temp.assert(sqlerrm like '%is failed and requires explicit recovery%', format('R9: expected a failed-run-requires-explicit-recovery error, got %s', sqlerrm));
  end;

  select * into v_row_after from public.payout_runs where id = v_failed_id;
  perform pg_temp.assert(v_row_after.status = 'failed', format('R9: the existing failed row must remain status=failed, unchanged, got %s', v_row_after.status));
  perform pg_temp.assert(v_row_after.started_at = v_failed_started_at, 'R9: the existing failed row''s started_at must be byte-unchanged');
  perform pg_temp.assert(v_row_after.completed_at is null, 'R9: the existing failed row''s completed_at must remain null, unchanged');

  select count(*) into v_count_after from public.payout_runs where run_type = 'scheduled' and run_key = v_run_key;
  perform pg_temp.assert(v_count_after = 1, format('R9: rejecting a failed run must never create a second payout_runs row for the same target month, got %s rows', v_count_after));

  select count(*) into v_payouts_after from public.author_payouts;
  select count(*) into v_ledger_after from public.author_ledger_entries;
  perform pg_temp.assert(v_payouts_before = v_payouts_after, 'R9: rejecting a failed run must never mutate author_payouts');
  perform pg_temp.assert(v_ledger_before = v_ledger_after, 'R9: rejecting a failed run must never mutate author_ledger_entries');
end $$;

-- ============================================================
-- Part 5: complete_scheduled_payout_run() -- allowed transition,
-- idempotency, no side effects.
-- ============================================================

do $$
declare
  v_target_month date;
  v_run record;
  v_completed_first record;
  v_completed_second record;
  v_payouts_before integer;
  v_payouts_after integer;
  v_ledger_before integer;
  v_ledger_after integer;
begin
  v_target_month := date_trunc('month', now() - interval '7 months')::date;

  set local role service_role;
  select * into v_run from public.start_scheduled_payout_run(v_target_month);
  reset role;

  perform pg_temp.assert(v_run.payout_run_status = 'running', 'C-setup: a freshly created run must be running before completion');

  select count(*) into v_payouts_before from public.author_payouts;
  select count(*) into v_ledger_before from public.author_ledger_entries;

  set local role service_role;
  select * into v_completed_first from public.complete_scheduled_payout_run(v_run.payout_run_id);
  reset role;

  perform pg_temp.assert(v_completed_first.payout_run_status = 'completed', format('C1: running -> completed must succeed, got %s', v_completed_first.payout_run_status));
  perform pg_temp.assert(v_completed_first.payout_run_completed_at is not null, 'C1: completed_at must be set');

  select count(*) into v_payouts_after from public.author_payouts;
  select count(*) into v_ledger_after from public.author_ledger_entries;
  perform pg_temp.assert(v_payouts_before = v_payouts_after, 'C5: completing a run must never mutate author_payouts');
  perform pg_temp.assert(v_ledger_before = v_ledger_after, 'C5: completing a run must never mutate author_ledger_entries');

  -- C2/C3: idempotent retry, completed_at set exactly once.
  set local role service_role;
  select * into v_completed_second from public.complete_scheduled_payout_run(v_run.payout_run_id);
  reset role;

  perform pg_temp.assert(v_completed_second.payout_run_status = 'completed', 'C2: completed retry must remain completed');
  perform pg_temp.assert(v_completed_second.payout_run_completed_at = v_completed_first.payout_run_completed_at, 'C3: completed_at must never change on a repeat call');
end $$;

-- Reject completing a run that was never started (not found).
do $$
begin
  begin
    set local role service_role;
    perform * from public.complete_scheduled_payout_run('00000000-0000-0000-0000-000000000000');
    reset role;
    perform pg_temp.assert(false, 'complete: a nonexistent run id must be rejected');
  exception when others then
    reset role;
    perform pg_temp.assert(sqlerrm like '%not found%', format('complete: expected a not-found error, got %s', sqlerrm));
  end;
end $$;

-- ============================================================
-- Part 6: SECURITY -- service_role-only across all four new functions;
-- anon/authenticated (including finance.view staff) denied outright.
-- ============================================================

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('05309900-0000-0000-0000-000000000001', 'p053-staff@test', now(), '{"role":"reader","display_name":"Finance Staff"}');
insert into public.staff_members (user_id, role) values
  ('05309900-0000-0000-0000-000000000001', 'admin');

do $$
declare
  v_target_month date;
begin
  v_target_month := date_trunc('month', now())::date;

  -- anon: no privilege on any of the four.
  set local role anon;
  begin
    perform * from public.author_payout_eligibility('05300400-0000-0000-0000-000000000001', 'USD');
    perform pg_temp.assert(false, 'security: anon must not execute author_payout_eligibility');
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.dry_run_scheduled_payouts();
    perform pg_temp.assert(false, 'security: anon must not execute dry_run_scheduled_payouts');
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.start_scheduled_payout_run(v_target_month);
    perform pg_temp.assert(false, 'security: anon must not execute start_scheduled_payout_run');
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.complete_scheduled_payout_run('00000000-0000-0000-0000-000000000000');
    perform pg_temp.assert(false, 'security: anon must not execute complete_scheduled_payout_run');
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- ordinary authenticated caller: no privilege on any of the four.
  perform set_config('request.jwt.claim.sub', '05300400-0000-0000-0000-000000000001', true);
  set local role authenticated;
  begin
    perform * from public.author_payout_eligibility('05300400-0000-0000-0000-000000000001', 'USD');
    perform pg_temp.assert(false, 'security: an ordinary author must not execute author_payout_eligibility');
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.dry_run_scheduled_payouts();
    perform pg_temp.assert(false, 'security: an ordinary author must not execute dry_run_scheduled_payouts');
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.start_scheduled_payout_run(v_target_month);
    perform pg_temp.assert(false, 'security: an ordinary author must not execute start_scheduled_payout_run');
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- finance.view staff: read-only remains read-only -- finance.view
  -- must NOT grant execution of any of these four merely by
  -- permission (Section 34's own explicit requirement).
  perform set_config('request.jwt.claim.sub', '05309900-0000-0000-0000-000000000001', true);
  set local role authenticated;
  begin
    perform * from public.author_payout_eligibility('05300400-0000-0000-0000-000000000001', 'USD');
    perform pg_temp.assert(false, 'security: finance.view staff must not execute author_payout_eligibility');
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.dry_run_scheduled_payouts();
    perform pg_temp.assert(false, 'security: finance.view staff must not execute dry_run_scheduled_payouts');
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.start_scheduled_payout_run(v_target_month);
    perform pg_temp.assert(false, 'security: finance.view staff must not execute start_scheduled_payout_run');
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.complete_scheduled_payout_run('00000000-0000-0000-0000-000000000000');
    perform pg_temp.assert(false, 'security: finance.view staff must not execute complete_scheduled_payout_run');
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- reserve_author_payout itself must remain service_role-only,
  -- unaffected by the refactor.
  perform set_config('request.jwt.claim.sub', '05300400-0000-0000-0000-000000000001', true);
  set local role authenticated;
  begin
    perform * from public.reserve_author_payout('05300400-0000-0000-0000-000000000001', 'USD');
    perform pg_temp.assert(false, 'security: an ordinary author must not execute reserve_author_payout');
  exception when insufficient_privilege then null;
  end;
  reset role;
end $$;

-- payout_runs direct DML boundary (migration 051) remains untouched:
-- service_role still has SELECT only, never direct INSERT/UPDATE.
do $$
begin
  begin
    set local role service_role;
    insert into public.payout_runs (run_type, run_key, status) values ('scheduled', 'monthly:2099-01', 'running');
    reset role;
    perform pg_temp.assert(false, 'security: service_role must not have direct INSERT on payout_runs -- the new RPCs are the only legal path');
  exception when insufficient_privilege then
    reset role;
  end;
end $$;

select 'ALL PASSED: 053_payout_scheduler_foundation.test.sql' as result;

rollback;
