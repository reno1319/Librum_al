-- Committed SQL regression suite for ALL-TXN-CURRENCY-4
-- (supabase/migrations/20260923160231_all_transaction_currency_provenance.sql):
-- every displayed transaction amount can be given the currency of THAT
-- transaction, from authoritative evidence only, without guessing,
-- converting, or writing a row.
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql -- no new test
-- infrastructure, same as every other suite in this directory.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance (17 or newer: schema.sql uses the MAINTAIN privilege):
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/065_all_transaction_currency_provenance.test.sql
--
-- It must also pass against the OTHER build path -- base schema.sql plus
-- the migration -- and
-- supabase/tests/065_all_transaction_currency_provenance_catalog_equivalence.sh
-- is what proves those two paths agree in the first place (and that the
-- four widened finance RPCs return the same rows, in the same order, as
-- before). Against the BASE schema alone it must FAIL: none of the
-- functions it calls exist there.
--
-- Everything below runs inside one transaction and is rolled back at the
-- end, so the file is repeatable and leaves no rows behind.
--
--   part 1  function metadata: security mode, volatility, search_path,
--           result shape and EXECUTE privileges, per role
--   part 2  provenance classification, one fixture per evidence path
--   part 3  list_purchase_currencies(): caller scoping and ordering
--   part 4  list_refund_request_currencies(): permission and results
--   part 5  the four finance RPCs: permission, and each row's currency
--   part 6  no row was written by any of the above

\set ON_ERROR_STOP on

begin;

create function pg_temp.assert_eq(p_label text, p_actual text, p_expected text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL: %: expected [%], got [%]', p_label, p_expected, p_actual;
  end if;
  raise notice 'ok: %', p_label;
end $$;

-- Runs one query as `authenticated` with auth.uid() = p_uid (null for no
-- JWT) and returns its rows as 'col|col|...' lines joined by ',' in the
-- order the query produced them, or 'ERROR:<sqlstate>:<message>'.
create function pg_temp.as_user(p_uid uuid, p_sql text) returns text
language plpgsql as $$
declare
  v_result text;
  v_state text;
  v_message text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  set local role authenticated;
  begin
    execute format(
      'select coalesce(string_agg(t::text, %L), %L) from (%s) t',
      ',', '<none>', p_sql
    ) into v_result;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
    v_result := 'ERROR:' || v_state || ':' || v_message;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  return v_result;
end $$;

-- Same, as `anon`, to prove EXECUTE is refused before any body runs.
create function pg_temp.as_anon(p_sql text) returns text
language plpgsql as $$
declare
  v_result text;
  v_state text;
begin
  set local role anon;
  begin
    execute p_sql;
    v_result := 'OK';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    v_result := 'ERROR:' || v_state;
  end;
  reset role;
  return v_result;
end $$;

-- ============================================================
-- Part 1: function metadata.
-- ============================================================
do $$
declare
  r record;
begin
  -- Internal helpers: SECURITY INVOKER, pinned search_path, and not
  -- executable by any client-facing role (they read payments and
  -- book_checkout_intents, so they are reachable only through the
  -- SECURITY DEFINER RPCs below).
  for r in
    select * from (values
      ('public.transaction_currency_evidence(text)', 's'),
      ('public.classify_transaction_currency(text[])', 'i'),
      ('public.transaction_currency_provenance(text, uuid)', 's'),
      ('public.purchase_currency_provenance(text, integer)', 's')
    ) v(sig, volatility)
  loop
    perform pg_temp.assert_eq(
      'part1: ' || r.sig || ' is security invoker, search_path pinned, volatility ' || r.volatility,
      (select p.prosecdef::text || '|' || array_to_string(p.proconfig, ',') || '|' || p.provolatile::text
         from pg_proc p where p.oid = r.sig::regprocedure),
      'false|search_path=""|' || r.volatility
    );
    perform pg_temp.assert_eq(
      'part1: ' || r.sig || ' is not executable by public/anon/authenticated/service_role',
      (select string_agg(has_function_privilege(role_name, r.sig::regprocedure, 'EXECUTE')::text, ',' order by role_name)
         from unnest(array['anon','authenticated','public','service_role']) role_name),
      'false,false,false,false'
    );
  end loop;

  -- The two new read RPCs and the four widened finance RPCs: SECURITY
  -- DEFINER, STABLE, search_path pinned, EXECUTE for authenticated and
  -- never for anon or PUBLIC.
  for r in
    select * from (values
      ('public.list_purchase_currencies(uuid[])'),
      ('public.list_refund_request_currencies(uuid[])'),
      ('public.list_refund_reconciliation_states(text, boolean, timestamptz, uuid, integer)'),
      ('public.list_finance_disputes(boolean, timestamptz, uuid, integer)'),
      ('public.list_finance_checkout_exceptions(timestamptz, uuid, integer)'),
      ('public.list_finance_refund_entitlement_mismatches(integer)')
    ) v(sig)
  loop
    perform pg_temp.assert_eq(
      'part1: ' || r.sig || ' is security definer, stable, search_path pinned',
      (select p.prosecdef::text || '|' || p.provolatile::text || '|' || array_to_string(p.proconfig, ',')
         from pg_proc p where p.oid = r.sig::regprocedure),
      'true|s|search_path=""'
    );
    perform pg_temp.assert_eq(
      'part1: ' || r.sig || ' EXECUTE: anon no, authenticated yes, public no',
      (select string_agg(has_function_privilege(role_name, r.sig::regprocedure, 'EXECUTE')::text, ',' order by role_name)
         from unnest(array['anon','authenticated','public']) role_name),
      'false,true,false'
    );
  end loop;

  -- service_role keeps EXECUTE on the four recreated finance RPCs (on
  -- staging it holds it today; the migration re-grants it explicitly).
  perform pg_temp.assert_eq(
    'part1: service_role keeps EXECUTE on the four finance RPCs',
    (select string_agg(has_function_privilege('service_role', sig::regprocedure, 'EXECUTE')::text, ',')
       from unnest(array[
         'public.list_refund_reconciliation_states(text, boolean, timestamptz, uuid, integer)',
         'public.list_finance_disputes(boolean, timestamptz, uuid, integer)',
         'public.list_finance_checkout_exceptions(timestamptz, uuid, integer)',
         'public.list_finance_refund_entitlement_mismatches(integer)'
       ]) sig),
    'true,true,true,true'
  );

  -- The finance RPCs changed ONLY by two trailing result columns.
  for r in
    select * from (values
      ('public.list_refund_reconciliation_states(text, boolean, timestamptz, uuid, integer)',
       'TABLE(refund_request_id uuid, reader_id uuid, reader_display_name text, amount_cents integer, refund_request_status text, requested_at timestamp with time zone, reviewed_at timestamp with time zone, latest_attempt_id uuid, latest_attempt_status text, latest_attempt_created_at timestamp with time zone, latest_attempt_updated_at timestamp with time zone, stripe_refund_id text, stripe_status text, operational_state text, needs_attention boolean, currency_state text, currency text)'),
      ('public.list_finance_disputes(boolean, timestamptz, uuid, integer)',
       'TABLE(id uuid, stripe_dispute_id text, stripe_payment_intent_id text, reader_id uuid, reader_display_name text, status text, reason text, amount_cents integer, created_at timestamp with time zone, updated_at timestamp with time zone, transfer_reversal_status text, stripe_transfer_reversal_id text, transfer_reversal_attempt_count integer, transfer_reversal_attempted_at timestamp with time zone, transfer_reversal_succeeded_at timestamp with time zone, transfer_reversal_failure_code text, needs_attention boolean, currency_state text, currency text)'),
      ('public.list_finance_checkout_exceptions(timestamptz, uuid, integer)',
       'TABLE(intent_id uuid, book_id uuid, book_title text, reader_id uuid, reader_display_name text, price_cents_at_checkout integer, stripe_checkout_session_id text, stripe_payment_intent_id text, completed_at timestamp with time zone, reconciliation_reason text, created_at timestamp with time zone, currency_state text, currency text)'),
      ('public.list_finance_refund_entitlement_mismatches(integer)',
       'TABLE(mismatch_type text, refund_request_id uuid, purchase_id uuid, bundle_checkout_snapshot_id uuid, reader_id uuid, reader_display_name text, stripe_payment_intent_id text, amount_cents integer, currency_state text, currency text)')
    ) v(sig, result)
  loop
    perform pg_temp.assert_eq('part1: result shape of ' || r.sig,
      pg_get_function_result(r.sig::regprocedure), r.result);
  end loop;

  -- The caller-facing RPCs return currency facts only: no amount, no
  -- payment reference, no provider, no buyer.
  perform pg_temp.assert_eq('part1: list_purchase_currencies result shape',
    pg_get_function_result('public.list_purchase_currencies(uuid[])'::regprocedure),
    'TABLE(purchase_id uuid, currency_state text, currency text)');
  perform pg_temp.assert_eq('part1: list_refund_request_currencies result shape',
    pg_get_function_result('public.list_refund_request_currencies(uuid[])'::regprocedure),
    'TABLE(refund_request_id uuid, currency_state text, currency text)');

  -- The old finance signatures are gone (DROP + CREATE, no overload left).
  perform pg_temp.assert_eq('part1: exactly one overload of each finance RPC',
    (select string_agg(proname || '=' || n, ',' order by proname) from (
       select proname, count(*)::text n from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname in ('list_refund_reconciliation_states', 'list_finance_disputes',
                          'list_finance_checkout_exceptions', 'list_finance_refund_entitlement_mismatches')
        group by proname) s),
    'list_finance_checkout_exceptions=1,list_finance_disputes=1,list_finance_refund_entitlement_mismatches=1,list_refund_reconciliation_states=1');
end $$;

-- ============================================================
-- Fixtures.
--
--   users  01 reader R1, 02 reader R2, 03 author A, 04 author B,
--          05 finance admin, 06 support (refunds.view only),
--          07 plain signed-in user
--   books  b1..b5 by A, b6 by B
--
-- purchases, one per evidence path:
--   c01 R1/b1 legacy USD row (payment_id null, legacy regime)  -> USD
--   c02 R1/b2 ledger ALL: payment + intent, both ALL            -> ALL
--   c03 R1/b3 free acquisition (no reference, amount 0)         -> free
--   c04 R2/b1 ledger row, reference with no evidence at all     -> unknown
--   c05 R2/b2 payment says USD, intent says ALL                 -> conflict
--   c06 R2/b6 legacy USD on author B's book                     -> USD
--   c07 R1/b4 REUSED row: payment_id still points at an OLD USD
--             payment, reference is a new ALL intent            -> ALL
--   c08 R2/b3 non-zero amount, no reference                     -> unknown
--   c09 R1/b5 legacy bundle row + its USD snapshot              -> USD
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0650000-0000-0000-0000-000000000001', 'p065-r1@test', now(), '{"role":"reader","display_name":"P065 R1"}'),
  ('e0650000-0000-0000-0000-000000000002', 'p065-r2@test', now(), '{"role":"reader","display_name":"P065 R2"}'),
  ('e0650000-0000-0000-0000-000000000003', 'p065-a@test',  now(), '{"role":"author","display_name":"P065 A"}'),
  ('e0650000-0000-0000-0000-000000000004', 'p065-b@test',  now(), '{"role":"author","display_name":"P065 B"}'),
  ('e0650000-0000-0000-0000-000000000005', 'p065-fin@test', now(), '{"role":"reader","display_name":"P065 Finance"}'),
  ('e0650000-0000-0000-0000-000000000006', 'p065-sup@test', now(), '{"role":"reader","display_name":"P065 Support"}'),
  ('e0650000-0000-0000-0000-000000000007', 'p065-n@test',  now(), '{"role":"reader","display_name":"P065 N"}');

update public.profiles set role = 'author'
  where id in ('e0650000-0000-0000-0000-000000000003', 'e0650000-0000-0000-0000-000000000004');

insert into public.staff_members (user_id, role) values
  ('e0650000-0000-0000-0000-000000000005', 'admin'),
  ('e0650000-0000-0000-0000-000000000006', 'support');

insert into public.books (id, author_id, title, status) values
  ('e0650b00-0000-0000-0000-000000000001', 'e0650000-0000-0000-0000-000000000003', 'P065 b1', 'published'),
  ('e0650b00-0000-0000-0000-000000000002', 'e0650000-0000-0000-0000-000000000003', 'P065 b2', 'published'),
  ('e0650b00-0000-0000-0000-000000000003', 'e0650000-0000-0000-0000-000000000003', 'P065 b3', 'published'),
  ('e0650b00-0000-0000-0000-000000000004', 'e0650000-0000-0000-0000-000000000003', 'P065 b4', 'published'),
  ('e0650b00-0000-0000-0000-000000000005', 'e0650000-0000-0000-0000-000000000003', 'P065 b5', 'published'),
  ('e0650b00-0000-0000-0000-000000000006', 'e0650000-0000-0000-0000-000000000004', 'P065 b6', 'published');

insert into public.payments (id, provider, provider_payment_id, buyer_id, amount_minor, currency, status, paid_at, regime) values
  ('e0650d00-0000-0000-0000-000000000002', 'pok', 'p065_pok_ledger_2', 'e0650000-0000-0000-0000-000000000001', 79920, 'ALL', 'succeeded', now(), 'librum_ledger_v1'),
  ('e0650d00-0000-0000-0000-000000000005', 'stripe', 'p065_pi_conflict_5', 'e0650000-0000-0000-0000-000000000002', 500, 'USD', 'succeeded', now(), 'legacy_stripe_connect_v1'),
  ('e0650d00-0000-0000-0000-000000000007', 'stripe', 'p065_pi_old_7', 'e0650000-0000-0000-0000-000000000001', 699, 'USD', 'succeeded', now(), 'legacy_stripe_connect_v1'),
  ('e0650d00-0000-0000-0000-000000000017', 'stripe', 'p065_pi_mixsnap_17', 'e0650000-0000-0000-0000-000000000002', 900, 'USD', 'succeeded', now(), 'legacy_stripe_connect_v1');

insert into public.book_checkout_intents
  (id, book_id, reader_id, book_title, price_cents_at_checkout, stripe_payment_intent_id,
   expires_at, completed_at, fulfilled_at, reconciliation_reason, regime, currency, royalty_rate_bps, created_at) values
  -- fulfilled ledger intents (evidence for c02, c05, c07)
  ('e0650e00-0000-0000-0000-000000000002', 'e0650b00-0000-0000-0000-000000000002', 'e0650000-0000-0000-0000-000000000001',
   'P065 b2', 79920, 'p065_pok_ledger_2', now() + interval '1 hour', now(), now(), null, 'librum_ledger_v1', 'ALL', 8000, now() - interval '1 minute'),
  ('e0650e00-0000-0000-0000-000000000005', 'e0650b00-0000-0000-0000-000000000002', 'e0650000-0000-0000-0000-000000000002',
   'P065 b2', 500, 'p065_pi_conflict_5', now() + interval '1 hour', now(), now(), null, 'librum_ledger_v1', 'ALL', 8000, now() - interval '1 minute'),
  ('e0650e00-0000-0000-0000-000000000007', 'e0650b00-0000-0000-0000-000000000004', 'e0650000-0000-0000-0000-000000000001',
   'P065 b4', 45000, 'p065_pok_new_7', now() + interval '1 hour', now(), now(), null, 'librum_ledger_v1', 'ALL', 8000, now() - interval '1 minute'),
  -- checkout exceptions (completed, never fulfilled): one ledger ALL,
  -- one legacy USD; their own immutable currency is authoritative
  ('e0650e00-0000-0000-0000-0000000000e1', 'e0650b00-0000-0000-0000-000000000001', 'e0650000-0000-0000-0000-000000000002',
   'P065 b1', 12345, 'p065_exc_all', now() + interval '1 hour', '2026-09-20T10:00:00Z', null, 'active_other_session', 'librum_ledger_v1', 'ALL', 8000, '2026-09-20T09:00:00Z'),
  ('e0650e00-0000-0000-0000-0000000000e2', 'e0650b00-0000-0000-0000-000000000003', 'e0650000-0000-0000-0000-000000000001',
   'P065 b3', 699, 'p065_exc_usd', now() + interval '1 hour', '2026-09-19T10:00:00Z', null, 'book_or_reader_deleted', 'legacy_stripe_connect_v1', 'USD', null, '2026-09-19T09:00:00Z');

insert into public.bundle_checkout_snapshots
  (id, stripe_checkout_session_id, stripe_payment_intent_id, bundle_title, author_id, reader_id,
   bundle_price_cents_at_checkout, total_amount_cents, items, protection_expires_at, fulfilled_at, regime, currency, royalty_rate_bps) values
  ('e0650f00-0000-0000-0000-000000000009', 'p065_cs_bundle_9', 'p065_pi_bundle_9', 'P065 legacy bundle',
   'e0650000-0000-0000-0000-000000000003', 'e0650000-0000-0000-0000-000000000001', 400, 400, '[]'::jsonb,
   now() + interval '1 day', now(), 'legacy_stripe_connect_v1', 'USD', null),
  ('e0650f00-0000-0000-0000-000000000010', null, null, 'P065 snapshot-only bundle',
   'e0650000-0000-0000-0000-000000000003', 'e0650000-0000-0000-0000-000000000002', 50000, 50000, '[]'::jsonb,
   now() + interval '1 day', now(), 'librum_ledger_v1', 'ALL', 8000),
  ('e0650f00-0000-0000-0000-000000000011', 'p065_cs_mixsnap_11', 'p065_pi_mixsnap_11', 'P065 ALL bundle',
   'e0650000-0000-0000-0000-000000000003', 'e0650000-0000-0000-0000-000000000002', 900, 900, '[]'::jsonb,
   now() + interval '1 day', now(), 'librum_ledger_v1', 'ALL', 8000);

insert into public.purchases (id, book_id, reader_id, stripe_payment_intent_id, amount_cents, regime, payment_id, refunded_at, created_at) values
  ('e0650c00-0000-0000-0000-000000000001', 'e0650b00-0000-0000-0000-000000000001', 'e0650000-0000-0000-0000-000000000001', 'p065_pi_legacy_1', 699, 'legacy_stripe_connect_v1', null, null, '2026-09-01T00:00:00Z'),
  ('e0650c00-0000-0000-0000-000000000002', 'e0650b00-0000-0000-0000-000000000002', 'e0650000-0000-0000-0000-000000000001', 'p065_pok_ledger_2', 79920, 'librum_ledger_v1', 'e0650d00-0000-0000-0000-000000000002', '2026-09-10T00:00:00Z', '2026-09-02T00:00:00Z'),
  ('e0650c00-0000-0000-0000-000000000003', 'e0650b00-0000-0000-0000-000000000003', 'e0650000-0000-0000-0000-000000000001', null, 0, 'legacy_stripe_connect_v1', null, null, '2026-09-03T00:00:00Z'),
  ('e0650c00-0000-0000-0000-000000000004', 'e0650b00-0000-0000-0000-000000000001', 'e0650000-0000-0000-0000-000000000002', 'p065_pi_unknown_4', 500, 'librum_ledger_v1', null, null, '2026-09-04T00:00:00Z'),
  ('e0650c00-0000-0000-0000-000000000005', 'e0650b00-0000-0000-0000-000000000002', 'e0650000-0000-0000-0000-000000000002', 'p065_pi_conflict_5', 500, 'librum_ledger_v1', null, null, '2026-09-05T00:00:00Z'),
  ('e0650c00-0000-0000-0000-000000000006', 'e0650b00-0000-0000-0000-000000000006', 'e0650000-0000-0000-0000-000000000002', 'p065_pi_legacy_6', 1000, 'legacy_stripe_connect_v1', null, null, '2026-09-06T00:00:00Z'),
  ('e0650c00-0000-0000-0000-000000000007', 'e0650b00-0000-0000-0000-000000000004', 'e0650000-0000-0000-0000-000000000001', 'p065_pok_new_7', 45000, 'librum_ledger_v1', 'e0650d00-0000-0000-0000-000000000007', null, '2026-09-07T00:00:00Z'),
  ('e0650c00-0000-0000-0000-000000000008', 'e0650b00-0000-0000-0000-000000000003', 'e0650000-0000-0000-0000-000000000002', null, 250, 'legacy_stripe_connect_v1', null, null, '2026-09-08T00:00:00Z'),
  ('e0650c00-0000-0000-0000-000000000009', 'e0650b00-0000-0000-0000-000000000005', 'e0650000-0000-0000-0000-000000000001', 'p065_pi_bundle_9', 400, 'legacy_stripe_connect_v1', null, null, '2026-09-09T00:00:00Z');

update public.purchases set stripe_checkout_session_id = 'p065_cs_bundle_9'
  where id = 'e0650c00-0000-0000-0000-000000000009';

-- refund requests, one per evidence path (r16 and r17 exercise the
-- request's own frozen bundle snapshot as evidence)
insert into public.refund_requests (id, reader_id, stripe_payment_intent_id, bundle_checkout_snapshot_id, amount_cents, status, requested_at) values
  ('e0651000-0000-0000-0000-000000000011', 'e0650000-0000-0000-0000-000000000001', 'p065_pi_legacy_1', null, 699, 'refunded', '2026-09-11T00:00:00Z'),
  ('e0651000-0000-0000-0000-000000000012', 'e0650000-0000-0000-0000-000000000001', 'p065_pok_ledger_2', null, 79920, 'approved', '2026-09-12T00:00:00Z'),
  ('e0651000-0000-0000-0000-000000000013', 'e0650000-0000-0000-0000-000000000002', 'p065_pi_unknown_4', null, 500, 'requested', '2026-09-13T00:00:00Z'),
  ('e0651000-0000-0000-0000-000000000014', 'e0650000-0000-0000-0000-000000000002', 'p065_pi_conflict_5', null, 500, 'requested', '2026-09-14T00:00:00Z'),
  ('e0651000-0000-0000-0000-000000000015', 'e0650000-0000-0000-0000-000000000001', 'p065_pi_bundle_9', 'e0650f00-0000-0000-0000-000000000009', 400, 'refunded', '2026-09-15T00:00:00Z'),
  ('e0651000-0000-0000-0000-000000000016', 'e0650000-0000-0000-0000-000000000002', 'p065_pi_snaponly_16', 'e0650f00-0000-0000-0000-000000000010', 50000, 'requested', '2026-09-16T00:00:00Z'),
  ('e0651000-0000-0000-0000-000000000017', 'e0650000-0000-0000-0000-000000000002', 'p065_pi_mixsnap_17', 'e0650f00-0000-0000-0000-000000000011', 900, 'requested', '2026-09-17T00:00:00Z');

insert into public.refund_request_items (refund_request_id, purchase_id, book_id, amount_cents) values
  ('e0651000-0000-0000-0000-000000000011', 'e0650c00-0000-0000-0000-000000000001', 'e0650b00-0000-0000-0000-000000000001', 699),
  ('e0651000-0000-0000-0000-000000000012', 'e0650c00-0000-0000-0000-000000000002', 'e0650b00-0000-0000-0000-000000000002', 79920);

insert into public.payment_disputes (id, stripe_dispute_id, stripe_payment_intent_id, status, reason, amount_cents, created_at, updated_at) values
  ('e0651100-0000-0000-0000-000000000001', 'p065_dp_1', 'p065_pi_legacy_1', 'needs_response', 'fraudulent', 699, '2026-09-21T00:00:00Z', '2026-09-21T00:00:00Z'),
  ('e0651100-0000-0000-0000-000000000002', 'p065_dp_2', 'p065_pok_ledger_2', 'needs_response', 'fraudulent', 79920, '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z'),
  ('e0651100-0000-0000-0000-000000000003', 'p065_dp_3', 'p065_pi_nothing_3', 'won', 'fraudulent', 300, '2026-09-20T00:00:00Z', '2026-09-20T00:00:00Z');

-- Fingerprint of every table any function under test could read or
-- write, taken BEFORE part 2; part 6 proves it is unchanged.
create function pg_temp.financial_fingerprint() returns text
language sql as $$
  select concat_ws('|',
    (select md5(coalesce(string_agg(row_to_json(t)::text, ',' order by t.id), '')) from public.purchases t),
    (select md5(coalesce(string_agg(row_to_json(t)::text, ',' order by t.id), '')) from public.payments t),
    (select md5(coalesce(string_agg(row_to_json(t)::text, ',' order by t.id), '')) from public.book_checkout_intents t),
    (select md5(coalesce(string_agg(row_to_json(t)::text, ',' order by t.id), '')) from public.bundle_checkout_snapshots t),
    (select md5(coalesce(string_agg(row_to_json(t)::text, ',' order by t.id), '')) from public.refund_requests t),
    (select md5(coalesce(string_agg(row_to_json(t)::text, ',' order by t.id), '')) from public.refund_request_items t),
    (select md5(coalesce(string_agg(row_to_json(t)::text, ',' order by t.id), '')) from public.payment_disputes t),
    (select count(*)::text from public.author_ledger_entries),
    (select count(*)::text from public.purchases),
    (select count(*)::text from public.refund_requests))
$$;

create temp table p065_fingerprint_before as select pg_temp.financial_fingerprint() as fp;

-- ============================================================
-- Part 2: provenance classification (called as the owner; the helpers
-- are not client-callable, see part 1).
-- ============================================================
do $$
begin
  perform pg_temp.assert_eq('part2: classify none -> unknown',
    (select currency_state || '|' || coalesce(currency, '-') from public.classify_transaction_currency('{}')), 'unknown|-');
  perform pg_temp.assert_eq('part2: classify null array -> unknown',
    (select currency_state || '|' || coalesce(currency, '-') from public.classify_transaction_currency(null)), 'unknown|-');
  perform pg_temp.assert_eq('part2: classify nulls only -> unknown',
    (select currency_state || '|' || coalesce(currency, '-') from public.classify_transaction_currency(array[null, null]::text[])), 'unknown|-');
  perform pg_temp.assert_eq('part2: classify one ALL -> resolved ALL',
    (select currency_state || '|' || coalesce(currency, '-') from public.classify_transaction_currency(array['ALL'])), 'resolved|ALL');
  perform pg_temp.assert_eq('part2: classify repeated USD -> resolved USD',
    (select currency_state || '|' || coalesce(currency, '-') from public.classify_transaction_currency(array['USD', 'USD', null])), 'resolved|USD');
  perform pg_temp.assert_eq('part2: classify USD+ALL -> conflict, no currency picked',
    (select currency_state || '|' || coalesce(currency, '-') from public.classify_transaction_currency(array['USD', 'ALL'])), 'conflict|-');
  perform pg_temp.assert_eq('part2: classify always returns exactly one row',
    (select count(*)::text from public.classify_transaction_currency(array['USD', 'ALL', 'EUR'])), '1');

  perform pg_temp.assert_eq('part2: legacy USD row class -> USD',
    (select currency_state || '|' || coalesce(currency, '-') from public.transaction_currency_provenance('p065_pi_legacy_1')), 'resolved|USD');
  perform pg_temp.assert_eq('part2: payment + intent, both ALL -> ALL',
    (select currency_state || '|' || coalesce(currency, '-') from public.transaction_currency_provenance('p065_pok_ledger_2')), 'resolved|ALL');
  perform pg_temp.assert_eq('part2: ledger row, no evidence -> unknown (never defaulted)',
    (select currency_state || '|' || coalesce(currency, '-') from public.transaction_currency_provenance('p065_pi_unknown_4')), 'unknown|-');
  perform pg_temp.assert_eq('part2: payment USD vs intent ALL -> conflict',
    (select currency_state || '|' || coalesce(currency, '-') from public.transaction_currency_provenance('p065_pi_conflict_5')), 'conflict|-');
  perform pg_temp.assert_eq('part2: reused row follows its REFERENCE, not its stale payment_id',
    (select currency_state || '|' || coalesce(currency, '-') from public.transaction_currency_provenance('p065_pok_new_7')), 'resolved|ALL');
  perform pg_temp.assert_eq('part2: legacy bundle row + USD snapshot -> USD',
    (select currency_state || '|' || coalesce(currency, '-') from public.transaction_currency_provenance('p065_pi_bundle_9')), 'resolved|USD');
  perform pg_temp.assert_eq('part2: null reference -> unknown',
    (select currency_state || '|' || coalesce(currency, '-') from public.transaction_currency_provenance(null)), 'unknown|-');
  perform pg_temp.assert_eq('part2: unmatched reference -> unknown',
    (select currency_state || '|' || coalesce(currency, '-') from public.transaction_currency_provenance('p065_no_such_reference')), 'unknown|-');
  perform pg_temp.assert_eq('part2: frozen snapshot id alone is evidence',
    (select currency_state || '|' || coalesce(currency, '-') from public.transaction_currency_provenance('p065_pi_snaponly_16', 'e0650f00-0000-0000-0000-000000000010')), 'resolved|ALL');
  perform pg_temp.assert_eq('part2: payment USD vs frozen snapshot ALL -> conflict',
    (select currency_state || '|' || coalesce(currency, '-') from public.transaction_currency_provenance('p065_pi_mixsnap_17', 'e0650f00-0000-0000-0000-000000000011')), 'conflict|-');
  perform pg_temp.assert_eq('part2: the same reference without its snapshot is USD',
    (select currency_state || '|' || coalesce(currency, '-') from public.transaction_currency_provenance('p065_pi_mixsnap_17')), 'resolved|USD');

  perform pg_temp.assert_eq('part2: free acquisition -> free, no currency',
    (select currency_state || '|' || coalesce(currency, '-') from public.purchase_currency_provenance(null, 0)), 'free|-');
  perform pg_temp.assert_eq('part2: non-zero amount without reference -> unknown, not free, not USD',
    (select currency_state || '|' || coalesce(currency, '-') from public.purchase_currency_provenance(null, 250)), 'unknown|-');
  perform pg_temp.assert_eq('part2: null amount without reference -> unknown',
    (select currency_state || '|' || coalesce(currency, '-') from public.purchase_currency_provenance(null, null)), 'unknown|-');
  perform pg_temp.assert_eq('part2: a zero amount WITH a reference is classified by the reference',
    (select currency_state || '|' || coalesce(currency, '-') from public.purchase_currency_provenance('p065_pi_legacy_1', 0)), 'resolved|USD');
  perform pg_temp.assert_eq('part2: purchase provenance always one row',
    (select count(*)::text from public.purchase_currency_provenance(null, 0))
      || (select count(*)::text from public.purchase_currency_provenance('p065_pi_conflict_5', 500)), '11');
end $$;

-- ============================================================
-- Part 3: list_purchase_currencies() -- scoped to purchases the caller
-- could already SELECT (own, or of books the caller authors), ordered
-- by purchase id, currency facts only.
-- ============================================================
do $$
declare
  v_all text := $q$select * from public.list_purchase_currencies(array(select id from public.purchases where id::text like 'e0650c00-%' order by id desc))$q$;
begin
  perform pg_temp.assert_eq('part3: no JWT -> not authenticated',
    pg_temp.as_user(null, v_all), 'ERROR:P0001:not authenticated');
  perform pg_temp.assert_eq('part3: anon cannot execute',
    pg_temp.as_anon('select * from public.list_purchase_currencies(null)'), 'ERROR:42501');

  perform pg_temp.assert_eq('part3: reader R1 sees only their own purchases, ordered by id',
    pg_temp.as_user('e0650000-0000-0000-0000-000000000001', v_all),
    '(e0650c00-0000-0000-0000-000000000001,resolved,USD),'
    '(e0650c00-0000-0000-0000-000000000002,resolved,ALL),'
    '(e0650c00-0000-0000-0000-000000000003,free,),'
    '(e0650c00-0000-0000-0000-000000000007,resolved,ALL),'
    '(e0650c00-0000-0000-0000-000000000009,resolved,USD)');

  perform pg_temp.assert_eq('part3: reader R2 sees only their own purchases',
    pg_temp.as_user('e0650000-0000-0000-0000-000000000002', v_all),
    '(e0650c00-0000-0000-0000-000000000004,unknown,),'
    '(e0650c00-0000-0000-0000-000000000005,conflict,),'
    '(e0650c00-0000-0000-0000-000000000006,resolved,USD),'
    '(e0650c00-0000-0000-0000-000000000008,unknown,)');

  perform pg_temp.assert_eq('part3: author A sees every purchase of their books, never author B''s',
    pg_temp.as_user('e0650000-0000-0000-0000-000000000003', v_all),
    '(e0650c00-0000-0000-0000-000000000001,resolved,USD),'
    '(e0650c00-0000-0000-0000-000000000002,resolved,ALL),'
    '(e0650c00-0000-0000-0000-000000000003,free,),'
    '(e0650c00-0000-0000-0000-000000000004,unknown,),'
    '(e0650c00-0000-0000-0000-000000000005,conflict,),'
    '(e0650c00-0000-0000-0000-000000000007,resolved,ALL),'
    '(e0650c00-0000-0000-0000-000000000008,unknown,),'
    '(e0650c00-0000-0000-0000-000000000009,resolved,USD)');

  perform pg_temp.assert_eq('part3: author B sees only the purchase of their own book',
    pg_temp.as_user('e0650000-0000-0000-0000-000000000004', v_all),
    '(e0650c00-0000-0000-0000-000000000006,resolved,USD)');

  perform pg_temp.assert_eq('part3: an unrelated signed-in user sees nothing (no existence disclosure)',
    pg_temp.as_user('e0650000-0000-0000-0000-000000000007', v_all), '<none>');
  perform pg_temp.assert_eq('part3: finance staff get no special reach through this function',
    pg_temp.as_user('e0650000-0000-0000-0000-000000000005', v_all), '<none>');
  perform pg_temp.assert_eq('part3: a null id array returns nothing',
    pg_temp.as_user('e0650000-0000-0000-0000-000000000001', 'select * from public.list_purchase_currencies(null)'), '<none>');
  perform pg_temp.assert_eq('part3: an unknown id returns nothing',
    pg_temp.as_user('e0650000-0000-0000-0000-000000000001',
      $q$select * from public.list_purchase_currencies(array['e0650c00-0000-0000-0000-0000000000ff'::uuid])$q$), '<none>');
end $$;

-- ============================================================
-- Part 4: list_refund_request_currencies() -- refunds.view only; each
-- request from its OWN frozen reference and snapshot.
-- ============================================================
do $$
declare
  v_all text := $q$select * from public.list_refund_request_currencies(array(select id from public.refund_requests where id::text like 'e0651000-%'))$q$;
  v_expected text :=
    '(e0651000-0000-0000-0000-000000000011,resolved,USD),'
    '(e0651000-0000-0000-0000-000000000012,resolved,ALL),'
    '(e0651000-0000-0000-0000-000000000013,unknown,),'
    '(e0651000-0000-0000-0000-000000000014,conflict,),'
    '(e0651000-0000-0000-0000-000000000015,resolved,USD),'
    '(e0651000-0000-0000-0000-000000000016,resolved,ALL),'
    '(e0651000-0000-0000-0000-000000000017,conflict,)';
begin
  perform pg_temp.assert_eq('part4: no JWT -> not authenticated',
    pg_temp.as_user(null, v_all), 'ERROR:P0001:not authenticated');
  perform pg_temp.assert_eq('part4: anon cannot execute',
    pg_temp.as_anon('select * from public.list_refund_request_currencies(null)'), 'ERROR:42501');
  perform pg_temp.assert_eq('part4: the requesting reader is not authorized',
    pg_temp.as_user('e0650000-0000-0000-0000-000000000001', v_all), 'ERROR:P0001:not authorized');
  perform pg_temp.assert_eq('part4: an author is not authorized',
    pg_temp.as_user('e0650000-0000-0000-0000-000000000003', v_all), 'ERROR:P0001:not authorized');
  perform pg_temp.assert_eq('part4: support (refunds.view) sees every request''s currency, ordered by id',
    pg_temp.as_user('e0650000-0000-0000-0000-000000000006', v_all), v_expected);
  perform pg_temp.assert_eq('part4: finance admin (refunds.view) sees the same',
    pg_temp.as_user('e0650000-0000-0000-0000-000000000005', v_all), v_expected);

  -- Items were copied from the request's own reference, so an item's
  -- purchase -- where it still carries that reference -- classifies the
  -- same as its parent. Parent and items never disagree.
  perform pg_temp.assert_eq('part4: every item''s purchase agrees with its parent request',
    (select string_agg(
        (select currency_state || coalesce(currency, '') from public.transaction_currency_provenance(rr.stripe_payment_intent_id, rr.bundle_checkout_snapshot_id))
        || '=' ||
        (select currency_state || coalesce(currency, '') from public.purchase_currency_provenance(pu.stripe_payment_intent_id, pu.amount_cents)),
        ',' order by rr.id)
       from public.refund_request_items ri
       join public.refund_requests rr on rr.id = ri.refund_request_id
       join public.purchases pu on pu.id = ri.purchase_id and pu.stripe_payment_intent_id = rr.stripe_payment_intent_id
      where rr.id::text like 'e0651000-%'),
    'resolvedUSD=resolvedUSD,resolvedALL=resolvedALL');
end $$;

-- ============================================================
-- Part 5: the four finance RPCs -- finance.view only, and each row
-- carries its own transaction's currency.
-- ============================================================
do $$
begin
  perform pg_temp.assert_eq('part5: support (no finance.view) cannot read reconciliation states',
    pg_temp.as_user('e0650000-0000-0000-0000-000000000006', 'select * from public.list_refund_reconciliation_states()'),
    'ERROR:P0001:not authorized');
  perform pg_temp.assert_eq('part5: support cannot read disputes',
    pg_temp.as_user('e0650000-0000-0000-0000-000000000006', 'select * from public.list_finance_disputes()'),
    'ERROR:P0001:not authorized');
  perform pg_temp.assert_eq('part5: support cannot read checkout exceptions',
    pg_temp.as_user('e0650000-0000-0000-0000-000000000006', 'select * from public.list_finance_checkout_exceptions()'),
    'ERROR:P0001:not authorized');
  perform pg_temp.assert_eq('part5: support cannot read entitlement mismatches',
    pg_temp.as_user('e0650000-0000-0000-0000-000000000006', 'select * from public.list_finance_refund_entitlement_mismatches()'),
    'ERROR:P0001:not authorized');
  perform pg_temp.assert_eq('part5: no JWT -> not authenticated',
    pg_temp.as_user(null, 'select * from public.list_finance_disputes()'),
    'ERROR:P0001:not authenticated');

  perform pg_temp.assert_eq('part5: reconciliation states, newest first, each in its own currency',
    pg_temp.as_user('e0650000-0000-0000-0000-000000000005',
      $q$select refund_request_id, amount_cents, currency_state, currency from public.list_refund_reconciliation_states() where refund_request_id::text like 'e0651000-%'$q$),
    '(e0651000-0000-0000-0000-000000000017,900,conflict,),'
    '(e0651000-0000-0000-0000-000000000016,50000,resolved,ALL),'
    '(e0651000-0000-0000-0000-000000000015,400,resolved,USD),'
    '(e0651000-0000-0000-0000-000000000014,500,conflict,),'
    '(e0651000-0000-0000-0000-000000000013,500,unknown,),'
    '(e0651000-0000-0000-0000-000000000012,79920,resolved,ALL),'
    '(e0651000-0000-0000-0000-000000000011,699,resolved,USD)');

  perform pg_temp.assert_eq('part5: disputes, newest first, each in its own currency',
    pg_temp.as_user('e0650000-0000-0000-0000-000000000005',
      $q$select id, amount_cents, currency_state, currency from public.list_finance_disputes() where stripe_dispute_id like 'p065_%'$q$),
    '(e0651100-0000-0000-0000-000000000002,79920,resolved,ALL),'
    '(e0651100-0000-0000-0000-000000000001,699,resolved,USD),'
    '(e0651100-0000-0000-0000-000000000003,300,unknown,)');

  perform pg_temp.assert_eq('part5: checkout exceptions carry the intent''s own immutable currency',
    pg_temp.as_user('e0650000-0000-0000-0000-000000000005',
      $q$select intent_id, price_cents_at_checkout, currency_state, currency from public.list_finance_checkout_exceptions()$q$),
    '(e0650e00-0000-0000-0000-0000000000e1,12345,resolved,ALL),'
    '(e0650e00-0000-0000-0000-0000000000e2,699,resolved,USD)');

  perform pg_temp.assert_eq('part5: entitlement mismatches, each in its transaction''s currency',
    pg_temp.as_user('e0650000-0000-0000-0000-000000000005',
      $q$select mismatch_type, refund_request_id, amount_cents, currency_state, currency from public.list_finance_refund_entitlement_mismatches() order by mismatch_type, refund_request_id$q$),
    '(purchase_refunded_request_unresolved,e0651000-0000-0000-0000-000000000012,79920,resolved,ALL),'
    '(refunded_request_active_bundle_snapshot,e0651000-0000-0000-0000-000000000015,400,resolved,USD),'
    '(refunded_request_active_purchase,e0651000-0000-0000-0000-000000000011,699,resolved,USD)');

  -- Widening added columns, not rows: exactly one row per underlying
  -- record, even for rows whose currency is unknown or conflicting.
  perform pg_temp.assert_eq('part5: one reconciliation row per refund request',
    pg_temp.as_user('e0650000-0000-0000-0000-000000000005',
      $q$select count(*) from public.list_refund_reconciliation_states(p_limit => 100)$q$),
    '(' || (select count(*) from public.refund_requests)::text || ')');
  perform pg_temp.assert_eq('part5: one dispute row per dispute',
    pg_temp.as_user('e0650000-0000-0000-0000-000000000005',
      $q$select count(*) from public.list_finance_disputes(p_limit => 100)$q$),
    '(' || (select count(*) from public.payment_disputes)::text || ')');
end $$;

-- ============================================================
-- Part 6: nothing above wrote a row.
-- ============================================================
do $$
begin
  perform pg_temp.assert_eq('part6: no financial row changed',
    pg_temp.financial_fingerprint(), (select fp from p065_fingerprint_before));
end $$;

rollback;
