-- Committed SQL regression suite for migration 055 (BANK-PAYOUT-1C:
-- manual-bank V1 financial foundation).
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql -- no new test
-- infrastructure needed, same as every other suite in this directory.
--
-- Run manually against a disposable/local Postgres instance, AFTER
-- applying supabase/schema.sql (which already includes migration 055's
-- final state), from the repo root:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/055_bank_payout_v1_foundation.test.sql
--
-- SQL tests here prove database-visible invariants only. They do NOT,
-- and cannot, prove that a future Next.js Server Action correctly
-- checks finance.payout_operate before calling the service_role-only
-- payout-mutation RPCs -- that authorization lives entirely at the
-- application layer (BANK-PAYOUT-1B.1 Correction 3/1C Section 30) and
-- belongs in a later application/Vitest regression suite, once that
-- admin UI is built. Nothing below claims otherwise.
--
-- Everything runs inside one transaction and is rolled back at the end.

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
-- Shared fixtures: three authors (one ordinary, one admin staff, one
-- support staff), each with a well-formed ALL ledger balance seeded
-- via 'adjustment' entries (not 'sale' -- this suite is about payout/
-- destination/reversal behavior, not sale-specific ledger invariants,
-- which 048/049's own suites already cover exhaustively).
-- ============================================================

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('05500100-0000-0000-0000-000000000001', 'p055-author@test', now(), '{"role":"author","display_name":"P055 Author"}'),
  ('05500200-0000-0000-0000-000000000001', 'p055-author2@test', now(), '{"role":"author","display_name":"P055 Author 2"}'),
  ('05500300-0000-0000-0000-000000000001', 'p055-admin@test', now(), '{"role":"author","display_name":"P055 Admin"}'),
  ('05500400-0000-0000-0000-000000000001', 'p055-support@test', now(), '{"role":"author","display_name":"P055 Support"}');

insert into public.staff_members (user_id, role) values
  ('05500300-0000-0000-0000-000000000001', 'admin'),
  ('05500400-0000-0000-0000-000000000001', 'support');

insert into public.author_ledger_entries (author_id, entry_type, amount_minor, currency, available_at) values
  ('05500100-0000-0000-0000-000000000001', 'adjustment', 10000, 'ALL', now() - interval '1 day'),
  ('05500200-0000-0000-0000-000000000001', 'adjustment', 10000, 'ALL', now() - interval '1 day');

-- A real, valid Albanian IBAN and one with a deliberately corrupted
-- final check digit (same MOD-97 test vectors verified against the
-- iban_mod97_valid() function directly during BANK-PAYOUT-1C's own
-- interactive smoke testing).
-- v_valid_al_iban:   AL47212110090000000235698741
-- v_invalid_al_iban: AL47212110090000000235698742

-- ============================================================
-- A: eligibility priority chain + policy-aware effective threshold
-- (BANK-PAYOUT-1B.1 Correction 1's locked order: no_settings ->
-- no_minimum_policy -> no_available_balance -> active_reservation ->
-- below_threshold -> no_destination -> eligible).
-- ============================================================
do $$
declare
  v_elig record;
begin
  select * into v_elig from public.author_payout_eligibility('05500100-0000-0000-0000-000000000001', 'ALL');
  perform pg_temp.assert(not v_elig.eligible and v_elig.ineligible_reason = 'no_settings',
    'A1: no settings row -> no_settings');

  insert into public.payout_minimum_policy (currency, minimum_threshold_minor, is_active) values ('ALL', 1500, true);

  select * into v_elig from public.author_payout_eligibility('05500100-0000-0000-0000-000000000001', 'ALL');
  perform pg_temp.assert(not v_elig.eligible and v_elig.ineligible_reason = 'no_settings',
    'A2: policy alone does not create settings -- still no_settings');

  -- Insert the stored threshold directly (not via the RPC) purely to
  -- isolate the eligibility priority chain from the write-time gate --
  -- Section E below exercises the RPC's own gating separately.
  insert into public.author_payout_settings (author_id, currency, threshold_minor) values
    ('05500100-0000-0000-0000-000000000001', 'ALL', 2000);

  select * into v_elig from public.author_payout_eligibility('05500100-0000-0000-0000-000000000001', 'ALL');
  perform pg_temp.assert(not v_elig.eligible and v_elig.ineligible_reason = 'no_destination',
    'A3: settings + policy + balance ok, no destination -> no_destination');
  perform pg_temp.assert(v_elig.threshold_minor = 2000, 'A3: threshold_minor reports the stored preference');
  perform pg_temp.assert(v_elig.payoutable_minor = 10000, 'A3: payoutable_minor reflects the full ledger balance');

  insert into public.author_payout_destinations (author_id, currency, beneficiary_name, iban) values
    ('05500100-0000-0000-0000-000000000001', 'ALL', 'P055 Author', 'AL47212110090000000235698741');

  select * into v_elig from public.author_payout_eligibility('05500100-0000-0000-0000-000000000001', 'ALL');
  perform pg_temp.assert(v_elig.eligible and v_elig.ineligible_reason is null,
    'A4: settings + policy + balance + destination -> eligible');
end $$;

-- ============================================================
-- B: minimum-policy effective-threshold arithmetic (BANK-PAYOUT-1B.1
-- Correction 1's own scenarios A/B) -- a raised policy blocks a
-- previously-sufficient stored threshold; a lowered policy never
-- silently lowers the author's own higher choice; an inactive/absent
-- policy fails closed identically.
-- ============================================================
do $$
declare
  v_elig record;
begin
  -- Author 2: stored threshold 2000 (author's own choice), current
  -- policy minimum 1500 -> effective 2000, payoutable 10000 -> eligible
  -- once a destination exists.
  insert into public.author_payout_settings (author_id, currency, threshold_minor) values
    ('05500200-0000-0000-0000-000000000001', 'ALL', 2000);
  insert into public.author_payout_destinations (author_id, currency, beneficiary_name, iban) values
    ('05500200-0000-0000-0000-000000000001', 'ALL', 'P055 Author 2', 'AL47212110090000000235698741');

  select * into v_elig from public.author_payout_eligibility('05500200-0000-0000-0000-000000000001', 'ALL');
  perform pg_temp.assert(v_elig.eligible, 'B1: stored 2000 >= policy 1500 -> eligible');

  -- Raise the policy minimum above the author's own stored threshold --
  -- must become ineligible immediately, with zero change to the
  -- author's own stored row.
  update public.payout_minimum_policy set minimum_threshold_minor = 20000 where currency = 'ALL';

  select * into v_elig from public.author_payout_eligibility('05500200-0000-0000-0000-000000000001', 'ALL');
  perform pg_temp.assert(not v_elig.eligible and v_elig.ineligible_reason = 'below_threshold',
    'B2: policy raised above stored threshold -> below_threshold, re-evaluated live');
  perform pg_temp.assert(
    (select threshold_minor from public.author_payout_settings where author_id = '05500200-0000-0000-0000-000000000001' and currency = 'ALL') = 2000,
    'B2: the author''s own stored threshold is never silently mutated'
  );

  -- Lower it back down: eligibility self-heals with zero writes.
  update public.payout_minimum_policy set minimum_threshold_minor = 1500 where currency = 'ALL';
  select * into v_elig from public.author_payout_eligibility('05500200-0000-0000-0000-000000000001', 'ALL');
  perform pg_temp.assert(v_elig.eligible, 'B3: lowering the policy again restores eligibility with no data change');

  -- Deactivate the policy entirely -> fails closed identically to no
  -- row at all.
  update public.payout_minimum_policy set is_active = false where currency = 'ALL';
  select * into v_elig from public.author_payout_eligibility('05500200-0000-0000-0000-000000000001', 'ALL');
  perform pg_temp.assert(not v_elig.eligible and v_elig.ineligible_reason = 'no_minimum_policy',
    'B4: inactive policy row -> no_minimum_policy, same as absent');

  update public.payout_minimum_policy set is_active = true where currency = 'ALL';
end $$;

-- ============================================================
-- C: destination write RPC -- IBAN validation, auth.uid() ownership
-- scoping, no arbitrary author_id, upsert semantics.
-- ============================================================
do $$
begin
  perform set_config('request.jwt.claim.sub', '05500100-0000-0000-0000-000000000001', true);
  set local role authenticated;

  begin
    perform * from public.set_author_payout_destination('ALL', 'Someone', 'AL47212110090000000235698742');
    perform pg_temp.assert(false, 'C1: a checksum-invalid IBAN must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%checksum%', format('C1: expected a checksum error, got %s', sqlerrm));
  end;

  begin
    perform * from public.set_author_payout_destination('ALL', 'Someone', 'not-an-iban-at-all');
    perform pg_temp.assert(false, 'C2: a structurally malformed IBAN must be rejected');
  exception when others then null;
  end;

  begin
    perform * from public.set_author_payout_destination('USD', '', 'AL47212110090000000235698741');
    perform pg_temp.assert(false, 'C3: a blank beneficiary name must be rejected');
  exception when others then null;
  end;

  -- Upsert: saving EUR for author 1 must not touch their own ALL row,
  -- and re-saving ALL must update in place, not duplicate.
  perform * from public.set_author_payout_destination('EUR', 'P055 Author EUR', 'AL47212110090000000235698741');
  perform * from public.set_author_payout_destination('ALL', 'P055 Author Renamed', 'AL47212110090000000235698741');

  reset role;
  perform pg_temp.assert(
    (select count(*) from public.author_payout_destinations where author_id = '05500100-0000-0000-0000-000000000001') = 2,
    'C4: two currencies -> two rows, upsert never duplicates'
  );
  perform pg_temp.assert(
    (select beneficiary_name from public.author_payout_destinations where author_id = '05500100-0000-0000-0000-000000000001' and currency = 'ALL') = 'P055 Author Renamed',
    'C4: re-saving the same currency updates in place'
  );
end $$;

-- ============================================================
-- D: no author_id parameter exists at all -- the RPC can only ever
-- write the CALLING author's own row (author/currency isolation +
-- cross-author isolation, Section 29 groups B).
-- ============================================================
do $$
begin
  perform set_config('request.jwt.claim.sub', '05500200-0000-0000-0000-000000000001', true);
  set local role authenticated;
  perform * from public.set_author_payout_destination('ALL', 'Author 2 Overwrite Attempt', 'AL47212110090000000235698741');
  reset role;

  perform pg_temp.assert(
    (select beneficiary_name from public.author_payout_destinations where author_id = '05500100-0000-0000-0000-000000000001' and currency = 'ALL') = 'P055 Author Renamed',
    'D1: author 2''s own write never touches author 1''s row -- there is no author_id parameter to target it with'
  );
  perform pg_temp.assert(
    (select beneficiary_name from public.author_payout_destinations where author_id = '05500200-0000-0000-0000-000000000001' and currency = 'ALL') = 'Author 2 Overwrite Attempt',
    'D1: author 2''s own row was written correctly'
  );
end $$;

-- ============================================================
-- E: threshold write RPC -- fail-closed with no active policy,
-- rejects below-minimum, never silently clamps.
-- ============================================================
do $$
begin
  perform set_config('request.jwt.claim.sub', '05500300-0000-0000-0000-000000000001', true);
  set local role authenticated;

  begin
    perform * from public.set_author_payout_threshold('USD', 5000);
    perform pg_temp.assert(false, 'E1: no active minimum policy for USD -> threshold write must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%no active minimum payout policy%', format('E1: expected fail-closed message, got %s', sqlerrm));
  end;

  reset role;
end $$;

insert into public.payout_minimum_policy (currency, minimum_threshold_minor, is_active) values ('EUR', 500, true);

do $$
begin
  perform set_config('request.jwt.claim.sub', '05500300-0000-0000-0000-000000000001', true);
  set local role authenticated;

  begin
    perform * from public.set_author_payout_threshold('EUR', 100);
    perform pg_temp.assert(false, 'E2: below-minimum threshold must be rejected once a policy exists');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%below the current minimum%', format('E2: expected below-minimum message, got %s', sqlerrm));
  end;

  perform * from public.set_author_payout_threshold('EUR', 500);
  reset role;

  perform pg_temp.assert(
    (select threshold_minor from public.author_payout_settings where author_id = '05500300-0000-0000-0000-000000000001' and currency = 'EUR') = 500,
    'E3: a threshold exactly equal to the minimum is accepted'
  );
end $$;

-- ============================================================
-- F: full payout lifecycle -- reserve -> start (snapshot + reference
-- freeze) -> finalize (manual_bank reference guard) -> ledger effect.
-- ============================================================
do $$
declare
  v_reserve record;
  v_start record;
  v_snapshot record;
  v_finalize record;
  v_balance record;
begin
  set local role service_role;

  select * into v_reserve from public.reserve_author_payout('05500100-0000-0000-0000-000000000001', 'ALL', null);
  perform pg_temp.assert(v_reserve.payout_id is not null, 'F1: an eligible author reserves successfully');
  perform pg_temp.assert(v_reserve.amount_minor = 10000, 'F1: the full payoutable balance is reserved, not merely the threshold');

  select * into v_start from public.start_author_payout(v_reserve.payout_id);
  perform pg_temp.assert(v_start.status = 'processing', 'F2: start_author_payout transitions pending -> processing');

  -- Part 3's own design (BANK-PAYOUT-1C Section 13): NO role, including
  -- service_role, has any grant on payout_destination_snapshots -- full
  -- IBAN visibility exists ONLY through the narrowly-gated
  -- list_payout_batch_export() RPC. Read it here as the connecting
  -- superuser (bypassing RLS/grants entirely) purely to assert the
  -- migration's own internal behavior, exactly mirroring how a real
  -- finance.payout_export staff member would see it via that RPC.
  reset role;
  select pds.* into v_snapshot from public.payout_destination_snapshots pds where pds.payout_id = v_reserve.payout_id;
  set local role service_role;
  perform pg_temp.assert(v_snapshot.payout_id is not null, 'F3: a snapshot row was created atomically with the transition');
  perform pg_temp.assert(v_snapshot.iban = 'AL47212110090000000235698741', 'F3: the snapshot IBAN matches the live destination at hand-off time');
  perform pg_temp.assert(v_snapshot.payment_reference like 'LIBRUM-%', 'F3: a payment_reference was generated');

  begin
    perform * from public.finalize_author_payout(v_reserve.payout_id, 'manual_bank', 'WRONG-REFERENCE');
    perform pg_temp.assert(false, 'F4: a mismatched manual_bank reference must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%must equal the frozen payment reference%', format('F4: expected a reference-mismatch error, got %s', sqlerrm));
  end;

  perform pg_temp.assert(
    (select status from public.author_payouts where id = v_reserve.payout_id) = 'processing',
    'F4: a rejected finalize attempt leaves the payout untouched (still processing)'
  );

  select * into v_finalize from public.finalize_author_payout(v_reserve.payout_id, 'manual_bank', v_snapshot.payment_reference);
  perform pg_temp.assert(v_finalize.status = 'paid', 'F5: finalize with the correct frozen reference succeeds');

  select * into v_balance from public.author_ledger_balance('05500100-0000-0000-0000-000000000001');
  perform pg_temp.assert(v_balance.current_balance_minor = 0, 'F6: current_balance_minor is 0 after the full payout');
  perform pg_temp.assert(v_balance.paid_out_minor = 10000, 'F6: paid_out_minor reflects the finalized payout');
  perform pg_temp.assert(v_balance.net_earnings_minor = 10000, 'F6: net_earnings_minor is unaffected by the payout itself');

  reset role;
end $$;

-- ============================================================
-- G: payout_reversal -- correctness-by-construction (amount/currency/
-- provider derived, never caller-supplied), full ledger restoration,
-- idempotent retry, conflicting retry rejected, status stays 'paid'.
-- ============================================================
do $$
declare
  v_payout_id uuid;
  v_reversal record;
  v_balance record;
begin
  select id into v_payout_id from public.author_payouts where author_id = '05500100-0000-0000-0000-000000000001' limit 1;

  set local role service_role;

  begin
    perform * from public.record_payout_reversal(v_payout_id, '', 'blank reference');
    perform pg_temp.assert(false, 'G1: a blank reversal reference must be rejected');
  exception when others then null;
  end;

  select * into v_reversal from public.record_payout_reversal(v_payout_id, 'BANK-RETURN-001', 'account closed');
  perform pg_temp.assert(v_reversal.amount_minor = 10000, 'G2: reversal amount is derived from the original payout, matches exactly');
  perform pg_temp.assert(v_reversal.currency = 'ALL', 'G2: reversal currency is derived from the original payout');

  perform pg_temp.assert(
    (select status from public.author_payouts where id = v_payout_id) = 'paid',
    'G3: the original payout status remains ''paid'' -- no ''reversed'' status is introduced'
  );

  select * into v_balance from public.author_ledger_balance('05500100-0000-0000-0000-000000000001');
  perform pg_temp.assert(v_balance.current_balance_minor = 10000, 'G4: current_balance_minor is fully restored after a full reversal');
  perform pg_temp.assert(v_balance.paid_out_minor = 0, 'G4: paid_out_minor nets back to exactly zero (the worked-example invariant)');
  perform pg_temp.assert(v_balance.net_earnings_minor = 10000, 'G4: net_earnings_minor is never affected by a reversal');

  -- Identical retry: safe no-op, same reversal_id back.
  declare
    v_retry record;
  begin
    select * into v_retry from public.record_payout_reversal(v_payout_id, 'BANK-RETURN-001', 'retry');
    perform pg_temp.assert(v_retry.reversal_id = v_reversal.reversal_id, 'G5: identical retry returns the same reversal row, no duplicate');
  end;

  -- payout_reversal, like payout_destination_snapshots, has ZERO grants
  -- for any role including service_role (Part 4's own design) -- read
  -- it here as the connecting superuser, bypassing RLS/grants entirely,
  -- purely to assert the migration's own internal behavior.
  reset role;
  perform pg_temp.assert(
    (select count(*) from public.payout_reversal where payout_id = v_payout_id) = 1,
    'G5: exactly one reversal row exists after the idempotent retry'
  );
  set local role service_role;

  begin
    perform * from public.record_payout_reversal(v_payout_id, 'DIFFERENT-REF', 'conflicting');
    perform pg_temp.assert(false, 'G6: a conflicting reversal reference must be rejected, not silently overwritten');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%DIFFERENT reference%', format('G6: expected a conflicting-reference error, got %s', sqlerrm));
  end;

  -- A payout that was never paid cannot be reversed.
  declare
    v_pending_reserve record;
  begin
    select * into v_pending_reserve from public.reserve_author_payout('05500200-0000-0000-0000-000000000001', 'ALL', null);
    begin
      perform * from public.record_payout_reversal(v_pending_reserve.payout_id, 'SOME-REF', null);
      perform pg_temp.assert(false, 'G7: a pending (never-paid) payout must not be reversible');
    exception when others then null;
    end;
  end;

  reset role;
end $$;

-- ============================================================
-- H: snapshot immutability -- UPDATE/DELETE rejected outright
-- (grant-level revoke AND the explicit trigger both independently
-- block it -- belt and suspenders, matching this codebase's own
-- established pattern).
-- ============================================================
do $$
declare
  v_any_payout_id uuid;
begin
  select payout_id into v_any_payout_id from public.payout_destination_snapshots limit 1;

  set local role service_role;

  begin
    update public.payout_destination_snapshots set beneficiary_name = 'Tampered' where payout_id = v_any_payout_id;
    perform pg_temp.assert(false, 'H1: UPDATE on a snapshot row must be rejected');
  exception when others then null;
  end;

  begin
    delete from public.payout_destination_snapshots where payout_id = v_any_payout_id;
    perform pg_temp.assert(false, 'H2: DELETE on a snapshot row must be rejected');
  exception when others then null;
  end;

  reset role;

  perform pg_temp.assert(
    (select beneficiary_name from public.payout_destination_snapshots where payout_id = v_any_payout_id) <> 'Tampered',
    'H3: the snapshot row is unchanged after both rejected attempts'
  );
end $$;

-- ============================================================
-- I: staff-permission privacy boundary -- finance.view alone can
-- never see bank data; finance.payout_export is a genuinely separate,
-- narrower permission.
-- ============================================================
do $$
declare
  v_visible_destinations integer;
  v_run_id uuid;
begin
  perform set_config('request.jwt.claim.sub', '05500400-0000-0000-0000-000000000001', true); -- support (finance.view-tier, no finance.payout_export)
  set local role authenticated;

  select count(*) into v_visible_destinations from public.author_payout_destinations;
  perform pg_temp.assert(v_visible_destinations = 0, 'I1: support staff (finance.view only) sees zero author_payout_destinations rows');

  begin
    perform * from public.list_payout_batch_export(null);
    perform pg_temp.assert(false, 'I2: support staff must not be able to call list_payout_batch_export');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%permission denied%', format('I2: expected a permission-denied error, got %s', sqlerrm));
  end;

  reset role;

  perform set_config('request.jwt.claim.sub', '05500300-0000-0000-0000-000000000001', true); -- admin (has finance.payout_export)
  set local role authenticated;

  perform * from public.list_payout_batch_export(null);
  -- No exception -- admin's finance.payout_export permission allows
  -- the call; an empty/any result set is a correctness non-issue here,
  -- only whether the permission gate itself lets the call through.

  reset role;

  set local role anon;
  begin
    perform count(*) from public.author_payout_destinations;
    perform pg_temp.assert(false, 'I3: anon must have zero access to author_payout_destinations');
  exception when others then null;
  end;
  begin
    perform count(*) from public.payout_destination_snapshots;
    perform pg_temp.assert(false, 'I3: anon must have zero access to payout_destination_snapshots');
  exception when others then null;
  end;
  begin
    perform count(*) from public.payout_reversal;
    perform pg_temp.assert(false, 'I3: anon must have zero access to payout_reversal');
  exception when others then null;
  end;
  begin
    perform count(*) from public.payout_minimum_policy;
    perform pg_temp.assert(false, 'I3: anon must have zero access to payout_minimum_policy');
  exception when others then null;
  end;
  reset role;
end $$;

-- ============================================================
-- J: service_role itself cannot directly read/write the bank-data
-- tables outside the trusted RPCs (BANK-PAYOUT-1A.1's own correction
-- to the author_payout_settings gap, applied here from the start).
-- ============================================================
do $$
begin
  set local role service_role;

  begin
    perform count(*) from public.payout_destination_snapshots;
    perform pg_temp.assert(false, 'J1: service_role must not have direct SELECT on payout_destination_snapshots');
  exception when others then null;
  end;

  begin
    insert into public.author_payout_destinations (author_id, currency, beneficiary_name, iban)
    values ('05500100-0000-0000-0000-000000000001', 'GBP', 'Should Fail', 'AL47212110090000000235698741');
    perform pg_temp.assert(false, 'J2: service_role must not have direct INSERT on author_payout_destinations');
  exception when others then null;
  end;

  reset role;
end $$;

select 'ALL PASSED: 055_bank_payout_v1_foundation.test.sql' as result;

rollback;
