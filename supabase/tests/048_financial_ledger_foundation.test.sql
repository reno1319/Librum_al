-- Committed SQL regression suite for migration 048 (LEDGER-1B: provider-
-- neutral financial ledger foundation -- payments, payment_events,
-- author_payouts, author_payout_settings, author_ledger_entries).
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql -- no new test
-- infrastructure needed, same as every other suite in this directory.
--
-- Run manually against a disposable/local Postgres instance, AFTER
-- applying supabase/schema.sql, from the repo root:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/048_financial_ledger_foundation.test.sql
--
-- (schema.sql already includes migration 048's final state -- this
-- suite doesn't separately apply 048_financial_ledger_foundation.sql on
-- top of an older schema.sql.)
--
-- Everything below runs inside one transaction and is rolled back at
-- the end, so this file is fully repeatable with no manual cleanup
-- between runs. A statement expected to raise (a CHECK violation, a
-- unique violation, a privilege denial, or the account-deletion FK
-- restriction) is wrapped in its own `do $$ begin ... exception when
-- others then ... end $$;` block so the surrounding transaction is
-- never aborted by an expected failure -- the same technique
-- 039_book_report_moderation.test.sql already uses for its RPC
-- rejection-path assertions.

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
-- Part 0: fixtures. Two authors, one staff member with finance.view
-- (granted via the 'admin' staff role, migration 043's own permission
-- matrix), one reader/buyer, one book (owned by Author A), and one
-- PRE-EXISTING purchase -- inserted BEFORE any of this suite's own
-- inserts into the five new tables, so the no-backfill assertion
-- immediately below is a real proof, not a vacuous one: this purchase
-- row already exists at the moment migration 048's own tables are
-- queried, exactly mirroring the real synthetic pre-launch purchases
-- already sitting in production.
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a0480000-0000-0000-0000-000000000001', 'p048-author-a@test', now(), '{"role":"author","display_name":"Author A"}'),
  ('a0480000-0000-0000-0000-000000000002', 'p048-author-b@test', now(), '{"role":"author","display_name":"Author B"}'),
  ('a0480000-0000-0000-0000-000000000003', 'p048-finance-staff@test', now(), '{"role":"reader","display_name":"Finance Staff"}'),
  ('a0480000-0000-0000-0000-000000000004', 'p048-reader@test', now(), '{"role":"reader","display_name":"Reader"}');

insert into public.staff_members (user_id, role) values
  ('a0480000-0000-0000-0000-000000000003', 'admin');

insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
  ('b0480000-0000-0000-0000-000000000001', 'a0480000-0000-0000-0000-000000000001', 'P048 Test Book', '', '', '', 999, 'published');

insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, stripe_payment_intent_id, amount_cents) values
  ('c0480000-0000-0000-0000-000000000001', 'b0480000-0000-0000-0000-000000000001', 'a0480000-0000-0000-0000-000000000004', 'cs_p048_synthetic', 'pi_p048_synthetic', 999);

-- ============================================================
-- Part 1: NO BACKFILL -- immediately after schema.sql/migration 048
-- has been applied against a database that already contains the
-- "synthetic pre-launch" purchase above, every new financial table must
-- have exactly zero rows. This must run BEFORE any later Part in this
-- file inserts test fixtures into these tables.
-- ============================================================
do $$
begin
  perform pg_temp.assert((select count(*) from public.payments) = 0, 'part1: payments must have zero rows immediately after migration (no backfill)');
  perform pg_temp.assert((select count(*) from public.payment_events) = 0, 'part1: payment_events must have zero rows immediately after migration (no backfill)');
  perform pg_temp.assert((select count(*) from public.author_ledger_entries) = 0, 'part1: author_ledger_entries must have zero rows immediately after migration (no backfill)');
  perform pg_temp.assert((select count(*) from public.author_payouts) = 0, 'part1: author_payouts must have zero rows immediately after migration (no backfill)');
  perform pg_temp.assert((select count(*) from public.author_payout_settings) = 0, 'part1: author_payout_settings must have zero rows immediately after migration (no backfill)');
end $$;

-- ============================================================
-- Part 2: table existence -- catalog-level proof, independent of RLS
-- or any fixture.
-- ============================================================
do $$
begin
  perform pg_temp.assert(to_regclass('public.payments') is not null, 'part2: public.payments must exist');
  perform pg_temp.assert(to_regclass('public.payment_events') is not null, 'part2: public.payment_events must exist');
  perform pg_temp.assert(to_regclass('public.author_ledger_entries') is not null, 'part2: public.author_ledger_entries must exist');
  perform pg_temp.assert(to_regclass('public.author_payouts') is not null, 'part2: public.author_payouts must exist');
  perform pg_temp.assert(to_regclass('public.author_payout_settings') is not null, 'part2: public.author_payout_settings must exist');
end $$;

-- ============================================================
-- Part 3: payments -- CHECK constraints and cross-provider uniqueness.
-- Fixtures inserted as the connecting (superuser/table-owner) role,
-- exactly as every other append-only-style table's test fixtures in
-- this directory are seeded -- see migration 048's own comment on why
-- the table owner is unaffected by RLS/the anon/authenticated revoke.
-- ============================================================
insert into public.payments (id, provider, provider_payment_id, buyer_id, amount_minor, currency, status) values
  ('d0480000-0000-0000-0000-000000000001', 'stripe', 'pi_p048_one', 'a0480000-0000-0000-0000-000000000004', 999, 'USD', 'succeeded');

do $$
begin
  -- positive amount
  begin
    insert into public.payments (provider, provider_payment_id, amount_minor, currency)
      values ('stripe', 'pi_p048_zero', 0, 'USD');
    perform pg_temp.assert(false, 'part3: a payment with amount_minor = 0 must be rejected');
  exception when check_violation then null;
  end;

  -- currency format
  begin
    insert into public.payments (provider, provider_payment_id, amount_minor, currency)
      values ('stripe', 'pi_p048_badcur', 500, 'usd');
    perform pg_temp.assert(false, 'part3: a lowercase currency code must be rejected');
  exception when check_violation then null;
  end;

  -- provider/provider_payment_id uniqueness
  begin
    insert into public.payments (provider, provider_payment_id, amount_minor, currency)
      values ('stripe', 'pi_p048_one', 500, 'USD');
    perform pg_temp.assert(false, 'part3: a duplicate (provider, provider_payment_id) must be rejected');
  exception when unique_violation then null;
  end;

  -- open provider text -- a never-before-seen provider name must be
  -- accepted with no schema change, proving provider-neutrality.
  insert into public.payments (provider, provider_payment_id, amount_minor, currency)
    values ('paysera', 'txn_p048_one', 750, 'EUR');
  perform pg_temp.assert(
    (select count(*) from public.payments where provider = 'paysera') = 1,
    'part3: an arbitrary open-text provider name must be accepted'
  );
end $$;

-- ============================================================
-- Part 4: payment_events -- uniqueness, and complete inaccessibility to
-- ordinary app roles (no anon, no ordinary authenticated, no author
-- access -- staff finance.view only).
-- ============================================================
insert into public.payment_events (id, provider, provider_event_id, event_type) values
  ('e0480000-0000-0000-0000-000000000001', 'stripe', 'evt_p048_one', 'checkout.session.completed');

do $$
begin
  -- uniqueness
  begin
    insert into public.payment_events (provider, provider_event_id, event_type)
      values ('stripe', 'evt_p048_one', 'checkout.session.completed');
    perform pg_temp.assert(false, 'part4: a duplicate (provider, provider_event_id) must be rejected');
  exception when unique_violation then null;
  end;

  -- an ordinary (non-staff) authenticated app user cannot read: with
  -- select granted to authenticated and RLS enabled, a non-matching
  -- policy yields an EMPTY result set, not an exception -- see
  -- migration 048's own RLS comment.
  perform set_config('request.jwt.claim.sub', 'a0480000-0000-0000-0000-000000000004', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.payment_events) = 0,
    'part4: an ordinary authenticated user must see zero payment_events rows'
  );
  begin
    insert into public.payment_events (provider, provider_event_id, event_type)
      values ('stripe', 'evt_p048_forbidden', 'x');
    perform pg_temp.assert(false, 'part4: an ordinary authenticated user must not be able to INSERT into payment_events');
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- anon cannot read at all (no grant).
  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
  begin
    perform count(*) from public.payment_events;
    perform pg_temp.assert(false, 'part4: anon must not have any privilege to read payment_events');
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- staff with finance.view can read.
  perform set_config('request.jwt.claim.sub', 'a0480000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.payment_events) = 1,
    'part4: staff with finance.view must be able to read payment_events'
  );
  reset role;
end $$;

-- ============================================================
-- Part 5: author_ledger_entries -- one complete, valid sale entry per
-- author, used as the shared baseline fixture for Parts 5-8 below.
-- Author A's is a real sale (999 gross, 799 to author, 200 to Librum,
-- 8000 bps = 80%). Author B gets a lone negative adjustment only (no
-- purchase at all) -- used later to prove both the negative-balance and
-- the account-deletion-without-a-purchase invariants.
-- ============================================================
insert into public.author_ledger_entries
  (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at)
values
  ('f0480000-0000-0000-0000-000000000001', 'a0480000-0000-0000-0000-000000000001',
   'c0480000-0000-0000-0000-000000000001', 'sale', 799, 'USD', 8000, 999, 200, now());

insert into public.author_ledger_entries
  (id, author_id, entry_type, amount_minor, currency, reference_type, reference_id, available_at)
values
  ('f0480000-0000-0000-0000-000000000002', 'a0480000-0000-0000-0000-000000000002',
   'adjustment', -150, 'USD', 'manual_note', 'p048-goodwill-debit', now());

-- ============================================================
-- Part 6: author_ledger_entries RLS -- author-own read, cross-author
-- denial, anon denial, and staff finance read.
-- ============================================================
do $$
begin
  -- Author A sees their own row.
  perform set_config('request.jwt.claim.sub', 'a0480000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.author_ledger_entries) = 1,
    'part6: Author A must see exactly their own one ledger row'
  );
  perform pg_temp.assert(
    (select count(*) from public.author_ledger_entries where author_id = 'a0480000-0000-0000-0000-000000000002') = 0,
    'part6: Author A must NOT be able to see Author B''s ledger row'
  );
  reset role;

  -- Author B sees only their own.
  perform set_config('request.jwt.claim.sub', 'a0480000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.author_ledger_entries) = 1,
    'part6: Author B must see exactly their own one ledger row'
  );
  reset role;

  -- anon sees nothing (no grant at all).
  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
  begin
    perform count(*) from public.author_ledger_entries;
    perform pg_temp.assert(false, 'part6: anon must not have any privilege to read author_ledger_entries');
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- staff with finance.view sees both authors' rows.
  perform set_config('request.jwt.claim.sub', 'a0480000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.author_ledger_entries) = 2,
    'part6: staff with finance.view must see all ledger rows across authors'
  );
  reset role;
end $$;

-- ============================================================
-- Part 7: append-only enforcement -- an ordinary author (owner of the
-- row) can neither INSERT, UPDATE, nor DELETE, and neither can staff
-- with finance.view (that permission only ever grants SELECT). No
-- INSERT/UPDATE/DELETE privilege is granted to authenticated at all --
-- this is denied at the PRIVILEGE layer (insufficient_privilege), not
-- merely filtered by RLS.
-- ============================================================
do $$
begin
  perform set_config('request.jwt.claim.sub', 'a0480000-0000-0000-0000-000000000001', true);
  set local role authenticated;

  begin
    insert into public.author_ledger_entries
      (author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at)
      values ('a0480000-0000-0000-0000-000000000001', 'c0480000-0000-0000-0000-000000000001', 'sale', 1, 'USD', 8000, 5, 4, now());
    perform pg_temp.assert(false, 'part7: an author must not be able to INSERT into author_ledger_entries');
  exception when insufficient_privilege then null;
  end;

  begin
    update public.author_ledger_entries set amount_minor = 1 where id = 'f0480000-0000-0000-0000-000000000001';
    perform pg_temp.assert(false, 'part7: an author must not be able to UPDATE author_ledger_entries');
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.author_ledger_entries where id = 'f0480000-0000-0000-0000-000000000001';
    perform pg_temp.assert(false, 'part7: an author must not be able to DELETE from author_ledger_entries');
  exception when insufficient_privilege then null;
  end;

  reset role;

  -- staff with finance.view: SELECT-only, direct mutation remains denied.
  perform set_config('request.jwt.claim.sub', 'a0480000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  begin
    update public.author_ledger_entries set amount_minor = 1 where id = 'f0480000-0000-0000-0000-000000000001';
    perform pg_temp.assert(false, 'part7: staff with finance.view must NOT be able to mutate author_ledger_entries directly');
  exception when insufficient_privilege then null;
  end;
  reset role;

  perform pg_temp.assert(
    (select amount_minor from public.author_ledger_entries where id = 'f0480000-0000-0000-0000-000000000001') = 799,
    'part7: the original sale row must be completely unchanged after every rejected mutation attempt'
  );
end $$;

-- ============================================================
-- Part 8: sign/type CHECKs -- sale positive, refund negative, payout
-- negative, adjustment non-zero, sale requires purchase_id.
-- ============================================================
do $$
begin
  begin
    insert into public.author_ledger_entries
      (author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at)
      values ('a0480000-0000-0000-0000-000000000001', 'c0480000-0000-0000-0000-000000000001', 'sale', -5, 'USD', 8000, 5, 10, now());
    perform pg_temp.assert(false, 'part8: a sale with a negative amount_minor must be rejected');
  exception when check_violation then null;
  end;

  begin
    insert into public.author_ledger_entries (author_id, entry_type, amount_minor, currency, available_at)
      values ('a0480000-0000-0000-0000-000000000001', 'refund', 5, 'USD', now());
    perform pg_temp.assert(false, 'part8: a refund with a positive amount_minor must be rejected');
  exception when check_violation then null;
  end;

  begin
    insert into public.author_ledger_entries (author_id, entry_type, amount_minor, currency, available_at)
      values ('a0480000-0000-0000-0000-000000000001', 'payout', 5, 'USD', now());
    perform pg_temp.assert(false, 'part8: a payout with a positive amount_minor must be rejected');
  exception when check_violation then null;
  end;

  begin
    insert into public.author_ledger_entries (author_id, entry_type, amount_minor, currency, available_at)
      values ('a0480000-0000-0000-0000-000000000001', 'adjustment', 0, 'USD', now());
    perform pg_temp.assert(false, 'part8: an adjustment with amount_minor = 0 must be rejected');
  exception when check_violation then null;
  end;

  begin
    insert into public.author_ledger_entries
      (author_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at)
      values ('a0480000-0000-0000-0000-000000000001', 'sale', 5, 'USD', 8000, 10, 5, now());
    perform pg_temp.assert(false, 'part8: a sale with no purchase_id must be rejected');
  exception when check_violation then null;
  end;
end $$;

-- ============================================================
-- Part 9: sale snapshot completeness (LEDGER-1B.1) -- a sale is
-- rejected when any single required snapshot component is missing or
-- invalid, and accepted only when the full snapshot is present and
-- reconciles exactly. Each case below changes exactly ONE field away
-- from an otherwise-valid, complete sale insert.
-- ============================================================
do $$
begin
  -- missing purchase_id (already covered by part8 above, restated here
  -- for completeness against the snapshot checklist).
  begin
    insert into public.author_ledger_entries
      (author_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at)
      values ('a0480000-0000-0000-0000-000000000001', 'sale', 799, 'USD', 8000, 999, 200, now());
    perform pg_temp.assert(false, 'part9: a sale missing purchase_id must be rejected');
  exception when check_violation then null;
  end;

  -- missing gross_amount_minor
  begin
    insert into public.author_ledger_entries
      (author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, librum_amount_minor, available_at)
      values ('a0480000-0000-0000-0000-000000000001', 'c0480000-0000-0000-0000-000000000001', 'sale', 799, 'USD', 8000, 200, now());
    perform pg_temp.assert(false, 'part9: a sale missing gross_amount_minor must be rejected');
  exception when check_violation then null;
  end;

  -- gross_amount_minor <= 0
  begin
    insert into public.author_ledger_entries
      (author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at)
      values ('a0480000-0000-0000-0000-000000000001', 'c0480000-0000-0000-0000-000000000001', 'sale', 799, 'USD', 8000, 0, -799, now());
    perform pg_temp.assert(false, 'part9: a sale with gross_amount_minor <= 0 must be rejected');
  exception when check_violation then null;
  end;

  -- missing librum_amount_minor
  begin
    insert into public.author_ledger_entries
      (author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, available_at)
      values ('a0480000-0000-0000-0000-000000000001', 'c0480000-0000-0000-0000-000000000001', 'sale', 799, 'USD', 8000, 999, now());
    perform pg_temp.assert(false, 'part9: a sale missing librum_amount_minor must be rejected');
  exception when check_violation then null;
  end;

  -- librum_amount_minor < 0
  begin
    insert into public.author_ledger_entries
      (author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at)
      values ('a0480000-0000-0000-0000-000000000001', 'c0480000-0000-0000-0000-000000000001', 'sale', 999, 'USD', 8000, 999, -1, now());
    perform pg_temp.assert(false, 'part9: a sale with librum_amount_minor < 0 must be rejected');
  exception when check_violation then null;
  end;

  -- missing royalty_rate_bps
  begin
    insert into public.author_ledger_entries
      (author_id, purchase_id, entry_type, amount_minor, currency, gross_amount_minor, librum_amount_minor, available_at)
      values ('a0480000-0000-0000-0000-000000000001', 'c0480000-0000-0000-0000-000000000001', 'sale', 799, 'USD', 999, 200, now());
    perform pg_temp.assert(false, 'part9: a sale missing royalty_rate_bps must be rejected');
  exception when check_violation then null;
  end;

  -- missing available_at
  begin
    insert into public.author_ledger_entries
      (author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor)
      values ('a0480000-0000-0000-0000-000000000001', 'c0480000-0000-0000-0000-000000000001', 'sale', 799, 'USD', 8000, 999, 200);
    perform pg_temp.assert(false, 'part9: a sale missing available_at must be rejected');
  exception when check_violation then null;
  end;

  -- gross != author amount + Librum amount
  begin
    insert into public.author_ledger_entries
      (author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at)
      values ('a0480000-0000-0000-0000-000000000001', 'c0480000-0000-0000-0000-000000000001', 'sale', 799, 'USD', 8000, 1000, 200, now());
    perform pg_temp.assert(false, 'part9: a sale whose gross does not equal amount_minor + librum_amount_minor must be rejected');
  exception when check_violation then null;
  end;

  -- one fully valid, complete sale succeeds (a second sale against a
  -- second, otherwise-unused purchase -- the original purchase already
  -- has its one canonical sale entry from Part 5, and Part 10 below
  -- separately proves that idempotency).
  insert into public.books (id, author_id, title, description, preview_text, keywords, price_cents, status) values
    ('b0480000-0000-0000-0000-000000000002', 'a0480000-0000-0000-0000-000000000001', 'P048 Second Book', '', '', '', 500, 'published');
  insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, stripe_payment_intent_id, amount_cents) values
    ('c0480000-0000-0000-0000-000000000002', 'b0480000-0000-0000-0000-000000000002', 'a0480000-0000-0000-0000-000000000004', 'cs_p048_two', 'pi_p048_two', 500);
  insert into public.author_ledger_entries
    (id, author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at)
    values ('f0480000-0000-0000-0000-000000000003', 'a0480000-0000-0000-0000-000000000001',
            'c0480000-0000-0000-0000-000000000002', 'sale', 400, 'USD', 8000, 500, 100, now());

  perform pg_temp.assert(
    (select count(*) from public.author_ledger_entries where id = 'f0480000-0000-0000-0000-000000000003') = 1,
    'part9: a complete, reconciling sale snapshot must be accepted'
  );
end $$;

-- ============================================================
-- Part 10: idempotency -- one sale per purchase, one payout entry per
-- payout, and general external-reference idempotency.
-- ============================================================
do $$
declare
  v_payout_id uuid;
begin
  -- one sale per purchase: a second sale against the SAME purchase
  -- already credited in Part 5 must be rejected.
  begin
    insert into public.author_ledger_entries
      (author_id, purchase_id, entry_type, amount_minor, currency, royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at)
      values ('a0480000-0000-0000-0000-000000000001', 'c0480000-0000-0000-0000-000000000001', 'sale', 799, 'USD', 8000, 999, 200, now());
    perform pg_temp.assert(false, 'part10: a second sale entry for an already-credited purchase must be rejected');
  exception when unique_violation then null;
  end;

  -- one payout entry per payout_id.
  insert into public.author_payouts (id, author_id, amount_minor, currency, status) values
    ('90480000-0000-0000-0000-000000000001', 'a0480000-0000-0000-0000-000000000001', 799, 'USD', 'paid');
  v_payout_id := '90480000-0000-0000-0000-000000000001';

  insert into public.author_ledger_entries (author_id, payout_id, entry_type, amount_minor, currency, available_at) values
    ('a0480000-0000-0000-0000-000000000001', v_payout_id, 'payout', -799, 'USD', now());

  begin
    insert into public.author_ledger_entries (author_id, payout_id, entry_type, amount_minor, currency, available_at) values
      ('a0480000-0000-0000-0000-000000000001', v_payout_id, 'payout', -799, 'USD', now());
    perform pg_temp.assert(false, 'part10: a second payout debit entry for the same payout_id must be rejected');
  exception when unique_violation then null;
  end;

  -- external reference idempotency: two refund entries with the same
  -- (author_id, entry_type, reference_type, reference_id) must collide.
  insert into public.author_ledger_entries (author_id, entry_type, amount_minor, currency, reference_type, reference_id, available_at) values
    ('a0480000-0000-0000-0000-000000000001', 'refund', -999, 'USD', 'stripe_refund', 're_p048_one', now());

  begin
    insert into public.author_ledger_entries (author_id, entry_type, amount_minor, currency, reference_type, reference_id, available_at) values
      ('a0480000-0000-0000-0000-000000000001', 'refund', -999, 'USD', 'stripe_refund', 're_p048_one', now());
    perform pg_temp.assert(false, 'part10: a duplicate (author_id, entry_type, reference_type, reference_id) must be rejected');
  exception when unique_violation then null;
  end;
end $$;

-- ============================================================
-- Part 11: negative net balance is permitted -- Author B's lone -150
-- adjustment (Part 5, no offsetting sale at all) sums negative, and no
-- CHECK anywhere blocks it.
-- ============================================================
do $$
declare
  v_balance bigint;
begin
  select coalesce(sum(amount_minor), 0) into v_balance
  from public.author_ledger_entries
  where author_id = 'a0480000-0000-0000-0000-000000000002';

  perform pg_temp.assert(v_balance = -150, format('part11: Author B''s net balance must be -150, got %s', v_balance));
end $$;

-- ============================================================
-- Part 12: author_payouts -- author-own read, cross-author denial,
-- direct author mutation denied, positive-amount CHECK, nullable/open
-- provider text.
-- ============================================================
do $$
begin
  perform set_config('request.jwt.claim.sub', 'a0480000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.author_payouts) = 1,
    'part12: Author A must see exactly their own one payout row'
  );
  reset role;

  perform set_config('request.jwt.claim.sub', 'a0480000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.author_payouts) = 0,
    'part12: Author B must NOT be able to see Author A''s payout row'
  );
  begin
    insert into public.author_payouts (author_id, amount_minor, currency) values
      ('a0480000-0000-0000-0000-000000000002', 100, 'USD');
    perform pg_temp.assert(false, 'part12: an author must not be able to INSERT into author_payouts directly');
  exception when insufficient_privilege then null;
  end;
  reset role;

  begin
    insert into public.author_payouts (author_id, amount_minor, currency) values
      ('a0480000-0000-0000-0000-000000000001', 0, 'USD');
    perform pg_temp.assert(false, 'part12: a payout with amount_minor = 0 must be rejected');
  exception when check_violation then null;
  end;

  -- nullable/open provider text: no provider at all, and an arbitrary
  -- provider name, both succeed.
  insert into public.author_payouts (author_id, amount_minor, currency) values
    ('a0480000-0000-0000-0000-000000000001', 250, 'USD');
  insert into public.author_payouts (author_id, amount_minor, currency, provider) values
    ('a0480000-0000-0000-0000-000000000001', 250, 'USD', 'paysera_bank_transfer');
  perform pg_temp.assert(
    (select count(*) from public.author_payouts where author_id = 'a0480000-0000-0000-0000-000000000001') = 3,
    'part12: a null provider and an arbitrary open-text provider must both be accepted'
  );
end $$;

-- ============================================================
-- Part 13: author_payout_settings -- own read, cross-author denial,
-- direct writes denied, positive-threshold CHECK.
-- ============================================================
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('a0480000-0000-0000-0000-000000000001', 5000, 'USD');

do $$
begin
  perform set_config('request.jwt.claim.sub', 'a0480000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.author_payout_settings) = 1,
    'part13: Author A must see exactly their own payout settings row'
  );
  reset role;

  perform set_config('request.jwt.claim.sub', 'a0480000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.author_payout_settings) = 0,
    'part13: Author B must NOT be able to see Author A''s payout settings row'
  );
  begin
    insert into public.author_payout_settings (author_id, threshold_minor, currency) values
      ('a0480000-0000-0000-0000-000000000002', 1000, 'USD');
    perform pg_temp.assert(false, 'part13: an author must not be able to INSERT into author_payout_settings directly');
  exception when insufficient_privilege then null;
  end;
  begin
    update public.author_payout_settings set threshold_minor = 1 where author_id = 'a0480000-0000-0000-0000-000000000001';
    perform pg_temp.assert(false, 'part13: an author must not be able to UPDATE author_payout_settings directly');
  exception when insufficient_privilege then null;
  end;
  reset role;

  begin
    insert into public.author_payout_settings (author_id, threshold_minor, currency) values
      ('a0480000-0000-0000-0000-000000000002', 0, 'USD');
    perform pg_temp.assert(false, 'part13: a payout settings row with threshold_minor = 0 must be rejected');
  exception when check_violation then null;
  end;
end $$;

-- ============================================================
-- Part 14: account-deletion durability.
--
-- 14a: Author A has ledger + payout history AND a purchase -- deleting
-- their auth.users row must be blocked by the ON DELETE RESTRICT FKs
-- from author_ledger_entries.author_id / author_payouts.author_id, and
-- every row must remain fully intact afterward.
--
-- 14b: Author B has ledger history (the lone adjustment from Part 5)
-- but NO purchase and NO payout at all -- deletion must be blocked on
-- the ledger history alone, proving the RESTRICT protects independent
-- of purchases.
--
-- 14c: a fresh author with ONLY an author_payout_settings row (a
-- preference, not history) deletes cleanly, and the settings row
-- correctly CASCADEs away.
--
-- 14d: a reader with zero financial history of any kind deletes
-- cleanly.
-- ============================================================
do $$
begin
  begin
    delete from auth.users where id = 'a0480000-0000-0000-0000-000000000001';
    perform pg_temp.assert(false, 'part14a: deleting Author A (real ledger + payout + purchase history) must be blocked');
  exception when foreign_key_violation then null;
  end;

  perform pg_temp.assert(
    (select count(*) from public.profiles where id = 'a0480000-0000-0000-0000-000000000001') = 1,
    'part14a: Author A''s profile must still exist after the blocked delete attempt'
  );
  -- 4 rows: two sales (Part 5, Part 9), one payout debit (Part 10), one
  -- refund (Part 10's external-reference idempotency fixture).
  perform pg_temp.assert(
    (select count(*) from public.author_ledger_entries where author_id = 'a0480000-0000-0000-0000-000000000001') = 4,
    'part14a: Author A''s ledger rows must be fully intact after the blocked delete attempt'
  );
  perform pg_temp.assert(
    (select count(*) from public.author_payouts where author_id = 'a0480000-0000-0000-0000-000000000001') = 3,
    'part14a: Author A''s payout rows must be fully intact after the blocked delete attempt'
  );
end $$;

do $$
begin
  begin
    delete from auth.users where id = 'a0480000-0000-0000-0000-000000000002';
    perform pg_temp.assert(false, 'part14b: deleting Author B (ledger history only, no purchase, no payout) must still be blocked');
  exception when foreign_key_violation then null;
  end;

  perform pg_temp.assert(
    (select count(*) from public.profiles where id = 'a0480000-0000-0000-0000-000000000002') = 1,
    'part14b: Author B''s profile must still exist after the blocked delete attempt'
  );
end $$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a0480000-0000-0000-0000-000000000005', 'p048-author-c@test', '{"role":"author","display_name":"Author C"}');
insert into public.author_payout_settings (author_id, threshold_minor, currency) values
  ('a0480000-0000-0000-0000-000000000005', 2000, 'USD');

do $$
begin
  delete from auth.users where id = 'a0480000-0000-0000-0000-000000000005';

  perform pg_temp.assert(
    (select count(*) from public.profiles where id = 'a0480000-0000-0000-0000-000000000005') = 0,
    'part14c: an author with only a payout-settings row (no ledger/payout history) must delete cleanly'
  );
  perform pg_temp.assert(
    (select count(*) from public.author_payout_settings where author_id = 'a0480000-0000-0000-0000-000000000005') = 0,
    'part14c: their author_payout_settings row must CASCADE away, not remain orphaned'
  );
end $$;

do $$
begin
  delete from auth.users where id = 'a0480000-0000-0000-0000-000000000004';

  perform pg_temp.assert(
    (select count(*) from public.profiles where id = 'a0480000-0000-0000-0000-000000000004') = 0,
    'part14d: a reader with zero financial history must delete cleanly'
  );
end $$;

select 'ALL PASSED: 048_financial_ledger_foundation.test.sql' as result;

rollback;
