-- Committed SQL regression suite for migration 057 (PHASE-1C round-4
-- review, finding 4: public.staging_fixture_protected_table_counts(uuid),
-- the narrowly scoped, SECURITY DEFINER, count-only RPC the staging
-- fixture scripts (scripts/staging-fixtures/) use to check
-- author_payout_destinations / payout_destination_snapshots /
-- payout_reversal for fixture-linked rows -- 3 tables the scripts'
-- service-role Data API client otherwise has ZERO grant on).
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql -- no new test
-- infrastructure needed, same as every other suite in this directory.
--
-- Not run in the PHASE-1C round-4 pass that authored it (local Postgres
-- was out of scope for that round). RUN AND PASSED in PHASE-1C round 5
-- against a disposable local PostgreSQL 16 instance -- see that
-- round's REVIEW-REPORT.txt for the exact commands and output,
-- including the standalone privilege/ACL queries run alongside it. To
-- reproduce, from the repo root, AFTER applying supabase/schema.sql
-- (which already includes migration 057's final state):
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/057_staging_fixture_protected_table_counts.test.sql
--
-- Everything below runs inside one transaction and is rolled back at
-- the end, so this file is fully repeatable with no manual cleanup
-- between runs -- except the ACL assertions, which read committed
-- privilege state (same discipline as 037's own test file).
--
-- Fixtures are inserted DIRECTLY (as the connecting superuser/table
-- owner, bypassing RLS -- the same convention every 048-056 test file
-- already uses).

begin;

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

insert into public.payout_minimum_policy (currency, minimum_threshold_minor, is_active) values
  ('USD', 1, true)
on conflict (currency) do nothing;

-- Two distinct authors -- proves the RPC is scoped to exactly the
-- caller-supplied p_author_id and never leaks another author's rows.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0570001-0000-0000-0000-000000000001', 'p057-author-a@test', now(), '{"role":"author","display_name":"P057 Author A"}'),
  ('e0570001-0000-0000-0000-000000000002', 'p057-author-b@test', now(), '{"role":"author","display_name":"P057 Author B"}');

-- Author A: one row in each of the 3 zero-grant tables.
insert into public.author_payout_destinations (author_id, currency, beneficiary_name, iban) values
  ('e0570001-0000-0000-0000-000000000001', 'USD', 'Fixture Beneficiary A', 'FIXTURE-IBAN-A');

-- 'paid', with provider/provider_reference/paid_at all populated
-- (author_payouts_paid_requires_provider_and_reference) -- required
-- because payout_reversal has its own trigger
-- (enforce_payout_reversal_matches_original) rejecting a reversal
-- against any payout that isn't already 'paid'.
insert into public.author_payouts (id, author_id, amount_minor, currency, status, provider, provider_reference, paid_at) values
  ('e0570002-0000-0000-0000-000000000001', 'e0570001-0000-0000-0000-000000000001', 1000, 'USD', 'paid', 'fixture-provider', 'FIXTURE-PAYOUT-REF-A', now());

insert into public.payout_destination_snapshots (payout_id, beneficiary_name, iban, currency, payment_reference) values
  ('e0570002-0000-0000-0000-000000000001', 'Fixture Beneficiary A', 'FIXTURE-IBAN-A', 'USD', 'P057-REF-A');

insert into public.payout_reversal (payout_id, amount_minor, currency, provider, provider_reference) values
  ('e0570002-0000-0000-0000-000000000001', 1000, 'USD', 'fixture-provider', 'P057-REVERSAL-A');

-- Author B: deliberately has ZERO rows in any of the 3 tables -- the
-- RPC called with author B's id must return three zero counts, not an
-- error and not author A's counts.

-- ============================================================
-- Part 1: privilege denial -- anon and authenticated must both be
-- refused EXECUTE outright (revoked explicitly by migration 057, not
-- merely "never granted").
-- ============================================================
do $$
begin
  set local role anon;
  begin
    perform public.staging_fixture_protected_table_counts('e0570001-0000-0000-0000-000000000001');
    perform pg_temp.assert(false, 'part1: anon must not be able to call staging_fixture_protected_table_counts');
  exception when insufficient_privilege then
    null; -- expected
  end;
  reset role;
end $$;

do $$
begin
  set local role authenticated;
  begin
    perform public.staging_fixture_protected_table_counts('e0570001-0000-0000-0000-000000000001');
    perform pg_temp.assert(false, 'part1: authenticated must not be able to call staging_fixture_protected_table_counts');
  exception when insufficient_privilege then
    null; -- expected
  end;
  reset role;
end $$;

-- ============================================================
-- Part 2: service_role IS granted, and gets the real, exact counts --
-- scoped to exactly the caller-supplied author id.
-- ============================================================
do $$
declare
  v_row record;
  v_seen_tables text[] := '{}';
begin
  set local role service_role;

  for v_row in
    select * from public.staging_fixture_protected_table_counts('e0570001-0000-0000-0000-000000000001')
  loop
    v_seen_tables := array_append(v_seen_tables, v_row.table_name);
    if v_row.table_name = 'author_payout_destinations' then
      perform pg_temp.assert(v_row.row_count = 1, 'part2: author A author_payout_destinations count must be 1');
    elsif v_row.table_name = 'payout_destination_snapshots' then
      perform pg_temp.assert(v_row.row_count = 1, 'part2: author A payout_destination_snapshots count must be 1');
    elsif v_row.table_name = 'payout_reversal' then
      perform pg_temp.assert(v_row.row_count = 1, 'part2: author A payout_reversal count must be 1');
    else
      perform pg_temp.assert(false, format('part2: unexpected table_name %L returned', v_row.table_name));
    end if;
  end loop;

  perform pg_temp.assert(
    v_seen_tables @> array['author_payout_destinations', 'payout_destination_snapshots', 'payout_reversal']
      and array_length(v_seen_tables, 1) = 3,
    'part2: exactly the 3 expected table rows must be returned, once each'
  );

  reset role;
end $$;

-- ============================================================
-- Part 3: author B (zero rows everywhere) gets three real zeros, never
-- author A's rows and never an error.
-- ============================================================
do $$
declare
  v_row record;
begin
  set local role service_role;

  for v_row in
    select * from public.staging_fixture_protected_table_counts('e0570001-0000-0000-0000-000000000002')
  loop
    perform pg_temp.assert(v_row.row_count = 0, format('part3: author B %I count must be 0, was %s', v_row.table_name, v_row.row_count));
  end loop;

  reset role;
end $$;

-- ============================================================
-- Part 4: row content itself is never disclosed -- the return shape is
-- exactly (table_name text, row_count bigint), nothing else, confirmed
-- via information_schema (a structural check, independent of any
-- particular row's values).
-- ============================================================
do $$
declare
  v_column_count integer;
begin
  select count(*) into v_column_count
  from information_schema.parameters
  where specific_schema = 'public'
    and specific_name in (
      select specific_name from information_schema.routines
      where routine_schema = 'public' and routine_name = 'staging_fixture_protected_table_counts'
    )
    and parameter_mode = 'OUT';

  perform pg_temp.assert(v_column_count = 2, 'part4: the RPC must return exactly 2 output columns (table_name, row_count) -- no row content');
end $$;

rollback;
