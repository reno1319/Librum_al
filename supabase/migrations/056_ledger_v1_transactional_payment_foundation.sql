-- STRIPE-CUTOVER-1C: ledger_v1 transactional payment foundation.
--
-- DATABASE FOUNDATION ONLY -- nothing in this migration wires Stripe
-- checkout to ledger_v1, changes NEW_CHECKOUT_REGIME, enables
-- BANK_PAYOUT_SETUP_ENABLED/PAYOUT_SCHEDULER_ENABLED, or creates any real
-- payment/ledger row. The current, live legacy_stripe_connect_v1 checkout
-- path (buyBook/buyBundle, the Stripe webhook, finalize_book_checkout_
-- intent(), fulfillBundleSnapshot()/fulfillLegacyBundle()) is unaffected
-- by this migration and continues to run exactly as it does today.
--
-- This migration is the final implementation of the design locked across
-- STRIPE-CUTOVER-1A through 1B.6 (see those design reports for the full
-- reasoning -- summarized here only where it explains a choice made in
-- this file). Two corrections surfaced only while writing this SQL, not
-- previously identified in the design chain, are called out explicitly
-- at the point they're made (search for "IMPLEMENTATION-1C" below).
--
-- Every object below is either: a nullable-then-backfilled-then-frozen
-- column on an existing table with real rows (book_checkout_intents,
-- bundle_checkout_snapshots, purchases -- all synthetic pre-launch data,
-- per migration 048's own top-of-file comment, never re-litigated here),
-- a brand-new column on a table that currently has ZERO rows in
-- production (payments, payment_refunds, author_ledger_entries,
-- payment_events -- confirmed zero rows, so no backfill/data-migration
-- concern applies to any of them), or a function replacement/new
-- function. Migrations 048 and 049 are not edited by this file.
--
-- ============================================================
-- Part 1: book_checkout_intents -- regime/currency/royalty_rate_bps.
-- ============================================================

alter table public.book_checkout_intents
  add column regime text,
  add column currency text,
  add column royalty_rate_bps integer;

update public.book_checkout_intents
  set regime = 'legacy_stripe_connect_v1', currency = 'USD'
  where regime is null;

alter table public.book_checkout_intents
  alter column regime set default 'legacy_stripe_connect_v1',
  alter column regime set not null,
  alter column currency set default 'USD',
  alter column currency set not null;

alter table public.book_checkout_intents
  add constraint book_checkout_intents_regime_check
    check (regime in ('legacy_stripe_connect_v1', 'librum_ledger_v1')),
  add constraint book_checkout_intents_currency_check
    check (currency ~ '^[A-Z]{3}$'),
  -- STRIPE-CUTOVER-1B.4 Section 12: ledger_v1 is ALL-only in V1 -- no
  -- FX. Enforced here, not left as "any 3-letter code," so a future
  -- application bug can never quietly create USD/EUR-denominated
  -- ledger_v1 commerce; changing this later requires a reviewed
  -- migration, exactly like the 30-day settlement rule.
  add constraint book_checkout_intents_ledger_v1_currency_check
    check (regime <> 'librum_ledger_v1' or currency = 'ALL'),
  -- Do NOT fabricate a historical royalty rate for legacy rows -- may
  -- stay NULL forever. ledger_v1 rows must always carry one, frozen at
  -- checkout-creation time (never recomputed from current application
  -- configuration at finalization time).
  add constraint book_checkout_intents_royalty_rate_bps_check
    check (royalty_rate_bps is null or (royalty_rate_bps >= 0 and royalty_rate_bps <= 10000)),
  add constraint book_checkout_intents_ledger_v1_royalty_rate_check
    check (regime <> 'librum_ledger_v1' or royalty_rate_bps is not null);

-- ============================================================
-- Part 2: bundle_checkout_snapshots -- same three columns, same rules.
-- ============================================================

alter table public.bundle_checkout_snapshots
  add column regime text,
  add column currency text,
  add column royalty_rate_bps integer;

update public.bundle_checkout_snapshots
  set regime = 'legacy_stripe_connect_v1', currency = 'USD'
  where regime is null;

alter table public.bundle_checkout_snapshots
  alter column regime set default 'legacy_stripe_connect_v1',
  alter column regime set not null,
  alter column currency set default 'USD',
  alter column currency set not null;

alter table public.bundle_checkout_snapshots
  add constraint bundle_checkout_snapshots_regime_check
    check (regime in ('legacy_stripe_connect_v1', 'librum_ledger_v1')),
  add constraint bundle_checkout_snapshots_currency_check
    check (currency ~ '^[A-Z]{3}$'),
  add constraint bundle_checkout_snapshots_ledger_v1_currency_check
    check (regime <> 'librum_ledger_v1' or currency = 'ALL'),
  add constraint bundle_checkout_snapshots_royalty_rate_bps_check
    check (royalty_rate_bps is null or (royalty_rate_bps >= 0 and royalty_rate_bps <= 10000)),
  add constraint bundle_checkout_snapshots_ledger_v1_royalty_rate_check
    check (regime <> 'librum_ledger_v1' or royalty_rate_bps is not null);

-- ============================================================
-- Part 3: checkout-fact immutability -- selective triggers, modeled on
-- migration 051's enforce_author_payouts_immutability() (a column-
-- selective "before update" trigger on a table that has OTHER,
-- legitimately mutable columns) -- NOT migration 055's
-- reject_payout_destination_snapshot_mutation() (a blanket "reject every
-- update" trigger on a table with no mutable columns at all -- the wrong
-- shape here, since completed_at/fulfilled_at/reconciliation_reason and
-- their bundle-snapshot equivalents must remain freely updatable).
--
-- Fires for every role's UPDATE, including a superuser/table-owner
-- session -- there is no grant to revoke and nothing a privileged role
-- bypasses by default (only ALTER TABLE ... DISABLE TRIGGER defeats it,
-- an explicit maintenance action, matching 051's own documented
-- posture). No DELETE-rejection trigger is added: neither table has one
-- today, no application code deletes from either, and adding one would
-- be a broader behavior change than this migration's own narrow scope.
-- ============================================================

create or replace function public.enforce_book_checkout_intents_financial_facts_immutability()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.regime is distinct from old.regime
    or new.currency is distinct from old.currency
    or new.royalty_rate_bps is distinct from old.royalty_rate_bps
  then
    raise exception
      'book_checkout_intents: regime/currency/royalty_rate_bps are immutable once set (intent %)',
      old.id;
  end if;
  return new;
end;
$$;

create trigger book_checkout_intents_enforce_financial_facts_immutability
  before update on public.book_checkout_intents
  for each row
  execute function public.enforce_book_checkout_intents_financial_facts_immutability();

create or replace function public.enforce_bundle_checkout_snapshots_financial_facts_immutability()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.regime is distinct from old.regime
    or new.currency is distinct from old.currency
    or new.royalty_rate_bps is distinct from old.royalty_rate_bps
  then
    raise exception
      'bundle_checkout_snapshots: regime/currency/royalty_rate_bps are immutable once set (snapshot %)',
      old.id;
  end if;
  return new;
end;
$$;

create trigger bundle_checkout_snapshots_enforce_financial_facts_immutability
  before update on public.bundle_checkout_snapshots
  for each row
  execute function public.enforce_bundle_checkout_snapshots_financial_facts_immutability();

-- ============================================================
-- Part 4: payments.regime -- immutable ledger-side transaction regime
-- authority (STRIPE-CUTOVER-1B.4 Section 6). payments has zero rows in
-- production today (it is entirely unwired -- migration 049's own
-- top-of-file comment) and is written EXCLUSIVELY by
-- record_successful_sale(), which after Part 12 below only ever writes
-- the literal 'librum_ledger_v1' -- no backfill is needed, and no other
-- regime will ever appear in this column. Kept NOT NULL with a default
-- for schema self-documentation and forward compatibility with a
-- hypothetical future third regime, not because ambiguity exists today.
-- ============================================================

alter table public.payments
  add column regime text not null default 'librum_ledger_v1'
    check (regime in ('legacy_stripe_connect_v1', 'librum_ledger_v1'));

-- No immutability trigger on payments.regime: the only writer
-- (record_successful_sale(), Part 12) never issues an UPDATE to an
-- existing payments row's regime under any code path -- see that
-- function's own "existing payment retry" branch, which performs zero
-- mutations to payments. A trigger would add a third protection layer
-- over a path that is already structurally unreachable, the same
-- reasoning migration 048 already applied to author_ledger_entries'
-- own append-only enforcement (revoke + RLS, no trigger).

-- ============================================================
-- Part 5: purchases.regime -- current-entitlement/informational only,
-- NOT historical payment authority (STRIPE-CUTOVER-1B.4 Section 7,
-- corrected from 1B.3's original "immutable forever" design once 1B.4
-- proved purchases rows are reused across refund/repurchase cycles --
-- see that report for the full pressure test). Deliberately carries NO
-- immutability trigger: it is allowed to legitimately change value on a
-- genuine refunded/disputed-lost repurchase, exactly like
-- stripe_checkout_session_id/stripe_payment_intent_id/amount_cents
-- already do on the same row today.
-- ============================================================

alter table public.purchases
  add column regime text;

update public.purchases
  set regime = 'legacy_stripe_connect_v1'
  where regime is null;

alter table public.purchases
  alter column regime set default 'legacy_stripe_connect_v1',
  alter column regime set not null;

alter table public.purchases
  add constraint purchases_regime_check
    check (regime in ('legacy_stripe_connect_v1', 'librum_ledger_v1'));

-- IMPLEMENTATION-1C correction 1 (found while extracting the shared
-- entitlement core in Part 11, not previously identified in the 1B.x
-- design chain): stripe_checkout_session_id is declared `not null` in
-- schema.sql today, a Stripe-specific assumption that cannot hold for a
-- provider-neutral librum_ledger_v1 purchase (a future non-Stripe
-- provider, or ledger_v1 itself, has no Stripe checkout session
-- concept). Relaxed to nullable here -- required for the shared
-- entitlement core (Part 11) to insert a ledger_v1 purchases row at
-- all. Zero effect on the current legacy path: every legacy call site
-- continues to supply a real, non-null Stripe session id exactly as
-- today: this only widens what is ALLOWED, changing no existing
-- behavior or data.
alter table public.purchases
  alter column stripe_checkout_session_id drop not null;

-- ============================================================
-- Part 6: payment_events.provider_payment_id -- required event/payment
-- binding for ledger_v1 (STRIPE-CUTOVER-1B.3 Section 5, 1B.4 Section
-- 10). Legacy historical rows (today: none exist at all, but future
-- legacy-path event rows if that path is ever wired to payment_events)
-- may remain NULL forever -- no backfill, no default, no NOT NULL.
-- ============================================================

alter table public.payment_events
  add column provider_payment_id text;

-- ============================================================
-- Part 7: sale-item uniqueness correction (STRIPE-CUTOVER-1B.5).
-- author_ledger_entries' existing partial unique index enforced "one
-- sale per purchase_id, ever" -- incompatible with purchases being a
-- reusable entitlement row (1B.4). Replaced with a composite index that
-- permits a second, independent sale for the same reused purchase under
-- a DIFFERENT payment, while still enforcing exactly-once per
-- (payment,item) pair.
-- ============================================================

drop index if exists public.author_ledger_entries_one_sale_per_purchase_idx;

create unique index author_ledger_entries_one_sale_per_payment_purchase_idx
  on public.author_ledger_entries (payment_id, purchase_id)
  where entry_type = 'sale';

-- STRIPE-CUTOVER-1B.6 Section 5: REQUIRED, not optional. A sale row
-- with a NULL payment_id would be invisible to the composite unique
-- index above (Postgres treats NULL as distinct from every other value
-- in a unique index) and unrecoverable by the immutable-payment-set
-- reconstruction query (Part 13's "existing payment retry" branch,
-- `where payment_id = ...`) -- both silently defeated by a single NULL.
-- Production has zero author_ledger_entries rows today, so this adds no
-- backfill concern.
alter table public.author_ledger_entries
  add constraint author_ledger_entries_sale_requires_payment_id
    check (entry_type <> 'sale' or payment_id is not null);

-- IMPLEMENTATION-1C correction 3 (found only while running this
-- migration's own regression suite, not previously identified in the
-- 1B.x design chain): author_ledger_entries.payment_id's existing FK
-- was declared `on delete set null` (migration 048) -- consistent with
-- that column being nullable in general, but now inconsistent with the
-- CHECK just added above, which forbids a NULL payment_id on any 'sale'
-- row. Left unchanged, deleting a payments row that has any sale
-- entries would attempt the SET NULL action, which the CHECK then
-- rejects -- turning a routine, already-guarded-elsewhere FK delete
-- attempt into a confusing CHECK-constraint failure instead of the
-- clean, already-established RESTRICT behavior purchases.payment_id
-- and payment_refunds.payment_id both already use for the exact same
-- payments row (both declared `on delete restrict` in migration 048).
-- Realigned here to the same RESTRICT behavior, for the same reason:
-- a payment with recorded financial history must never be deletable,
-- full stop -- SET NULL was never actually reachable for a 'sale' row
-- even before this migration's own CHECK (mark_payment_event_processed
-- /_failed and every other path never delete from payments either), so
-- this closes a latent inconsistency rather than changing any reachable
-- production behavior.
alter table public.author_ledger_entries
  drop constraint author_ledger_entries_payment_id_fkey;

alter table public.author_ledger_entries
  add constraint author_ledger_entries_payment_id_fkey
    foreign key (payment_id) references public.payments(id) on delete restrict;

-- ============================================================
-- Part 8: refund uniqueness correction (STRIPE-CUTOVER-1B.5). Same
-- reasoning as Part 7, mirrored onto payment_refunds: "one refund per
-- purchase_id, ever" incorrectly blocks an independent later payment
-- for the same reused entitlement from ever being refunded. provider/
-- provider_refund_id global uniqueness is untouched.
-- ============================================================

alter table public.payment_refunds
  drop constraint payment_refunds_purchase_id_key;

alter table public.payment_refunds
  add constraint payment_refunds_payment_id_purchase_id_key
    unique (payment_id, purchase_id);

-- ============================================================
-- Part 9: record_payment_event() evolution (STRIPE-CUTOVER-1B.3 Section
-- 6). Zero current application call sites exist for this function
-- (confirmed by repo-wide search) -- there is no live compatibility
-- break to protect, but the drop+recreate is still required because
-- BOTH the argument list AND the RETURNS TABLE shape change (a new
-- trailing p_provider_payment_id parameter, and a new
-- provider_payment_id output column) -- CREATE OR REPLACE cannot widen
-- either (the same rule migration 055 already states explicitly for
-- get_author_payout_overview()).
-- ============================================================

drop function if exists public.record_payment_event(text, text, text);

create or replace function public.record_payment_event(
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_provider_payment_id text default null
)
returns table (
  id uuid,
  provider text,
  provider_event_id text,
  event_type text,
  status text,
  received_at timestamptz,
  processed_at timestamptz,
  last_error_code text,
  created_at timestamptz,
  provider_payment_id text,
  already_existed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new record;
  v_existing record;
begin
  insert into public.payment_events (provider, provider_event_id, event_type, provider_payment_id)
    values (p_provider, p_provider_event_id, p_event_type, p_provider_payment_id)
    on conflict on constraint payment_events_provider_provider_event_id_key do nothing
    returning
      payment_events.id, payment_events.provider, payment_events.provider_event_id,
      payment_events.event_type, payment_events.status, payment_events.received_at,
      payment_events.processed_at, payment_events.last_error_code, payment_events.created_at,
      payment_events.provider_payment_id
    into v_new;

  if v_new.id is not null then
    id := v_new.id;
    provider := v_new.provider;
    provider_event_id := v_new.provider_event_id;
    event_type := v_new.event_type;
    status := v_new.status;
    received_at := v_new.received_at;
    processed_at := v_new.processed_at;
    last_error_code := v_new.last_error_code;
    created_at := v_new.created_at;
    provider_payment_id := v_new.provider_payment_id;
    already_existed := false;
    return next;
    return;
  end if;

  select pe.id, pe.provider, pe.provider_event_id, pe.event_type, pe.status,
         pe.received_at, pe.processed_at, pe.last_error_code, pe.created_at,
         pe.provider_payment_id
    into v_existing
    from public.payment_events pe
    where pe.provider = p_provider and pe.provider_event_id = p_provider_event_id;

  if v_existing.event_type <> p_event_type then
    raise exception
      'payment event %/% already recorded with a different event_type (existing=%, requested=%)',
      p_provider, p_provider_event_id, v_existing.event_type, p_event_type;
  end if;

  -- provider_payment_id consistency: a mismatch between two non-null
  -- values is a genuine integrity problem (this exact external event
  -- somehow being replayed with a different claimed payment) and must
  -- raise. An existing NULL row (recorded before a payment id was known
  -- -- structurally unreachable today since nothing calls this
  -- function pre-ledger_v1, but kept correct for when it is) may be
  -- backfilled by a later call that does supply one; never the reverse.
  if v_existing.provider_payment_id is not null
     and p_provider_payment_id is not null
     and v_existing.provider_payment_id <> p_provider_payment_id
  then
    raise exception
      'payment event %/% already recorded with a different provider_payment_id (existing=%, requested=%)',
      p_provider, p_provider_event_id, v_existing.provider_payment_id, p_provider_payment_id;
  end if;

  if v_existing.provider_payment_id is null and p_provider_payment_id is not null then
    update public.payment_events set provider_payment_id = p_provider_payment_id
      where payment_events.id = v_existing.id;
    v_existing.provider_payment_id := p_provider_payment_id;
  end if;

  id := v_existing.id;
  provider := v_existing.provider;
  provider_event_id := v_existing.provider_event_id;
  event_type := v_existing.event_type;
  status := v_existing.status;
  received_at := v_existing.received_at;
  processed_at := v_existing.processed_at;
  last_error_code := v_existing.last_error_code;
  created_at := v_existing.created_at;
  provider_payment_id := v_existing.provider_payment_id;
  already_existed := true;
  return next;
end;
$$;

revoke all on function public.record_payment_event(text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_payment_event(text, text, text, text) to service_role;

-- ============================================================
-- Part 10: create_book_checkout_intent() evolution (STRIPE-CUTOVER-
-- 1B.4 Section 10 -- this exact RPC replacement was a gap in 1B.3's
-- original scope, found only when 1B.4 re-audited the actual single-
-- book checkout creation path). Same drop+recreate pattern as Part 11
-- below: the argument list changes (three new trailing, defaulted
-- parameters), so CREATE OR REPLACE alone cannot do this -- adding
-- parameters via CREATE OR REPLACE silently creates a second, separate
-- overloaded function rather than replacing the original, which risks a
-- PostgREST "could not choose the best candidate function" ambiguity
-- error. Dropping the old 2-argument signature first leaves exactly one
-- candidate, so the EXISTING call site (buyBook,
-- src/app/(public)/books/[id]/actions.ts, `supabase.rpc
-- ("create_book_checkout_intent", { book_id, p_discount_code })`)
-- continues to work completely unchanged, taking the new parameters'
-- defaults.
-- ============================================================

drop function if exists public.create_book_checkout_intent(uuid, text);

create or replace function public.create_book_checkout_intent(
  book_id uuid,
  p_discount_code text default null,
  p_regime text default 'legacy_stripe_connect_v1',
  p_currency text default 'USD',
  p_royalty_rate_bps integer default null
)
returns table (
  intent_id uuid,
  price_cents_at_checkout integer,
  discount_code_id uuid,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reader_id uuid;
  v_book record;
  v_discount record;
  v_price_cents integer;
  v_discount_code_id uuid;
  v_expires_at timestamptz;
  v_intent_id uuid;
  v_existing record;
begin
  v_reader_id := auth.uid();
  if v_reader_id is null then
    raise exception 'not authenticated';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(v_reader_id::text),
    pg_catalog.hashtext(create_book_checkout_intent.book_id::text)
  );

  select i.id, i.price_cents_at_checkout, i.discount_code_id, i.expires_at
  into v_existing
  from public.book_checkout_intents i
  where i.book_id = create_book_checkout_intent.book_id
    and i.reader_id = v_reader_id
    and i.fulfilled_at is null
    and i.completed_at is null
    and i.expires_at > now()
  order by i.created_at desc
  limit 1;

  if v_existing.id is not null then
    return query
    select v_existing.id, v_existing.price_cents_at_checkout, v_existing.discount_code_id, v_existing.expires_at;
    return;
  end if;

  select b.id, b.title, b.price_cents, b.status, b.author_id
  into v_book
  from public.books b
  where b.id = create_book_checkout_intent.book_id;

  if v_book.id is null
     or v_book.status <> 'published'
     or v_book.author_id = v_reader_id
     or v_book.price_cents <= 0 then
    raise exception 'book not available for purchase';
  end if;

  -- IMPLEMENTATION-1C correction 4 (found only while running this
  -- migration's own regression suite against 035_stripe_dispute_
  -- tracking.test.sql, not previously identified anywhere in the 1B.x
  -- design chain): migration 035's LAUNCH-1 P1-7A correction replaced
  -- this exact inline `exists (select 1 from purchases where ... and
  -- refunded_at is null)` check with public.user_owns_book(), because
  -- the raw form wrongly treats a disputed-and-LOST purchase as still
  -- "owned," blocking a legitimate repurchase after a lost dispute. The
  -- extraction that produced this function's pre-056 body must reflect
  -- that already-shipped fix, not migration 032's superseded original.
  if public.user_owns_book(create_book_checkout_intent.book_id) then
    raise exception 'reader already owns this book';
  end if;

  v_price_cents := v_book.price_cents;
  v_discount_code_id := null;

  if p_discount_code is not null and pg_catalog.length(pg_catalog.btrim(p_discount_code)) > 0 then
    select d.id, d.percent_off, d.amount_off_cents
    into v_discount
    from public.discount_codes d
    where d.book_id = create_book_checkout_intent.book_id
      and d.code = pg_catalog.upper(pg_catalog.btrim(p_discount_code))
      and d.active = true
      and (d.expires_at is null or d.expires_at > now())
    limit 1;

    if v_discount.id is not null then
      v_price_cents := greatest(
        case
          when v_discount.percent_off is not null
            then round(v_book.price_cents::numeric * (100 - v_discount.percent_off) / 100)::integer
          else v_book.price_cents - v_discount.amount_off_cents
        end,
        50
      );
      v_discount_code_id := v_discount.id;
    end if;
  end if;

  v_expires_at := now() + interval '23 hours';

  -- IMPLEMENTATION-1C: the only functional change from the pre-056
  -- version of this function -- regime/currency/royalty_rate_bps are
  -- written on this ORIGINAL insert, from the new trailing parameters,
  -- never patched afterward (STRIPE-CUTOVER-1B.4 Section 10). Every
  -- other line above is byte-identical to the pre-056 function body.
  insert into public.book_checkout_intents (
    book_id, reader_id, book_title, price_cents_at_checkout, discount_code_id, expires_at,
    regime, currency, royalty_rate_bps
  ) values (
    create_book_checkout_intent.book_id, v_reader_id, v_book.title, v_price_cents, v_discount_code_id, v_expires_at,
    p_regime, p_currency, p_royalty_rate_bps
  )
  returning id into v_intent_id;

  return query
  select v_intent_id, v_price_cents, v_discount_code_id, v_expires_at;
end;
$$;

revoke all on function public.create_book_checkout_intent(uuid, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.create_book_checkout_intent(uuid, text, text, text, integer)
  to authenticated;

-- ============================================================
-- Part 11: create_bundle_checkout_snapshot() evolution (STRIPE-CUTOVER-
-- 1B.3 Section 4, 1B.4). Same drop+recreate pattern and reasoning as
-- Part 10. The existing 1-argument call site (buyBundle,
-- src/app/(public)/bundles/[id]/actions.ts, `supabase.rpc
-- ("create_bundle_checkout_snapshot", { bundle_id })`) continues to
-- work completely unchanged, taking the new parameters' defaults --
-- regime='legacy_stripe_connect_v1', currency='USD',
-- royalty_rate_bps=NULL, exactly as required.
-- ============================================================

drop function if exists public.create_bundle_checkout_snapshot(uuid);

create or replace function public.create_bundle_checkout_snapshot(
  bundle_id uuid,
  p_regime text default 'legacy_stripe_connect_v1',
  p_currency text default 'USD',
  p_royalty_rate_bps integer default null
)
returns table (
  snapshot_id uuid,
  bundle_title text,
  bundle_price_cents_at_checkout integer,
  protection_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reader_id uuid;
  v_bundle record;
  v_items jsonb;
  v_protection_expires_at timestamptz;
  v_snapshot_id uuid;
  v_existing record;
begin
  v_reader_id := auth.uid();
  if v_reader_id is null then
    raise exception 'not authenticated';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(v_reader_id::text),
    pg_catalog.hashtext(create_bundle_checkout_snapshot.bundle_id::text)
  );

  select s.id, s.bundle_title, s.bundle_price_cents_at_checkout, s.protection_expires_at
  into v_existing
  from public.bundle_checkout_snapshots s
  where s.reader_id = v_reader_id
    and s.bundle_id = create_bundle_checkout_snapshot.bundle_id
    and s.fulfilled_at is null
    and s.protection_expires_at > now()
  order by s.created_at desc
  limit 1;

  if v_existing.id is not null then
    return query
    select
      v_existing.id,
      v_existing.bundle_title,
      v_existing.bundle_price_cents_at_checkout,
      v_existing.protection_expires_at;
    return;
  end if;

  select b.id, b.title, b.price_cents, b.author_id
  into v_bundle
  from public.bundles b
  where b.id = create_bundle_checkout_snapshot.bundle_id
    and b.status = 'published';

  if v_bundle.id is null then
    raise exception 'bundle not found or not published';
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'book_id', item.book_id,
      'title', item.title,
      'price_cents_at_checkout', item.price_cents,
      'position', item.position
    )
    order by item.position
  )
  into v_items
  from (
    select
      bo.id as book_id,
      bo.title,
      bo.price_cents,
      row_number() over (order by bb.created_at, bo.id) as position
    from public.bundle_books bb
    join public.books bo on bo.id = bb.book_id
    where bb.bundle_id = v_bundle.id
  ) item;

  if v_items is null or jsonb_array_length(v_items) < 2 then
    raise exception 'bundle does not have enough books to check out';
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(v_items) as item
    where not public.user_owns_book((item->>'book_id')::uuid)
  ) then
    raise exception 'reader already owns every book in this bundle';
  end if;

  v_protection_expires_at := now() + interval '23 hours';

  -- IMPLEMENTATION-1C: the only functional change from the pre-056
  -- version of this function -- regime/currency/royalty_rate_bps are
  -- written on this ORIGINAL insert, never patched afterward
  -- (STRIPE-CUTOVER-1B.3 Section 4). Every other line above is
  -- byte-identical to the pre-056 function body.
  insert into public.bundle_checkout_snapshots (
    bundle_id,
    bundle_title,
    author_id,
    reader_id,
    bundle_price_cents_at_checkout,
    items,
    protection_expires_at,
    regime,
    currency,
    royalty_rate_bps
  )
  values (
    v_bundle.id,
    v_bundle.title,
    v_bundle.author_id,
    v_reader_id,
    v_bundle.price_cents,
    v_items,
    v_protection_expires_at,
    p_regime,
    p_currency,
    p_royalty_rate_bps
  )
  returning id into v_snapshot_id;

  insert into public.bundle_checkout_reservations (snapshot_id, book_id)
  select v_snapshot_id, (item->>'book_id')::uuid
  from jsonb_array_elements(v_items) as item;

  insert into public.bundle_checkout_reader_holds (snapshot_id, reader_id)
  values (v_snapshot_id, v_reader_id);

  return query
  select v_snapshot_id, v_bundle.title, v_bundle.price_cents, v_protection_expires_at;
end;
$$;

revoke all on function public.create_bundle_checkout_snapshot(uuid, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.create_bundle_checkout_snapshot(uuid, text, text, integer)
  to authenticated;

-- ============================================================
-- Part 12: shared single-book entitlement core (STRIPE-CUTOVER-1B.6
-- Section 23). The entitlement-creation logic in finalize_book_
-- checkout_intent() (lock intent, classify already-finalized/disputed/
-- deleted/active-other-session, upsert purchases) is identical for
-- both regimes -- only the SECURITY BOUNDARY differs (who may invoke
-- it, and what payment/ledger/event effects surround it). Extracted
-- here, byte-identical to the pre-056 finalize_book_checkout_intent()
-- body (migration 035) with exactly two corrections, both found only
-- while writing this extraction and not previously identified in the
-- 1B.x design chain:
--
-- IMPLEMENTATION-1C correction 1: `regime` is now selected off the
-- locked intent row and written into the purchases insert/upsert
-- (`regime = v_intent.regime` / `excluded.regime`) -- the actual
-- mechanism behind STRIPE-CUTOVER-1B.4 Section C's "purchase regime
-- creation" design.
--
-- IMPLEMENTATION-1C correction 2: the "active_other_session" check's
-- `v_existing.stripe_checkout_session_id is not null and` clause is
-- REMOVED. That clause was always redundant under the legacy-only
-- schema (stripe_checkout_session_id was `not null`, so the check could
-- never be false for a real row) -- but Part 5 above relaxes that
-- column to nullable for provider-neutral librum_ledger_v1 purchases,
-- which legitimately have no Stripe session id. Left unchanged, this
-- clause would silently misclassify an active, non-refunded ledger_v1
-- purchase as "no active row exists" (since its session id is null),
-- letting a later checkout upsert straight over a currently-owned
-- entitlement -- exactly the "charged without entitlement"/silent-
-- overwrite failure class this whole design exists to prevent. Dropping
-- it leaves `refunded_at is null and not lost-disputed` as the sole,
-- regime-agnostic activity signal, which is correct for both regimes:
-- every purchases row, by construction, is only ever written by a
-- completed, paid fulfillment (this function's own insert/upsert is the
-- only writer), so there is no partial/placeholder purchases state for
-- the dropped clause to have been guarding against.
--
-- Revoked from every application role, including service_role -- the
-- ONLY legitimate callers are finalize_book_checkout_intent() below
-- (legacy path, regime-gated) and finalize_ledger_book_payment()
-- (Part 15, ledger_v1 path, after its own event-binding and hard
-- amount/currency checks). Both are SECURITY DEFINER functions owned by
-- the same role that owns this one -- a nested call from inside either
-- one's body executes as that shared owner, which always retains
-- implicit EXECUTE on its own functions regardless of any REVOKE
-- targeting other roles (ordinary PostgreSQL ownership semantics, not a
-- special case introduced here). See the "direct bypass denied" tests
-- in the accompanying regression suite for empirical proof this holds.
-- ============================================================

create or replace function public.finalize_book_checkout_intent_entitlement_core(
  p_intent_id uuid,
  p_stripe_checkout_session_id text,
  p_stripe_payment_intent_id text,
  p_amount_cents integer
)
returns table (
  outcome text,
  out_book_id uuid,
  out_reader_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent record;
  v_existing record;
begin
  select id, book_id, reader_id, discount_code_id, price_cents_at_checkout, regime,
         fulfilled_at, completed_at, reconciliation_reason
  into v_intent
  from public.book_checkout_intents
  where id = p_intent_id
  for update;

  if v_intent.id is null then
    raise exception 'checkout intent not found';
  end if;

  if v_intent.fulfilled_at is not null or v_intent.reconciliation_reason is not null then
    return query select 'already_finalized'::text, v_intent.book_id, v_intent.reader_id;
    return;
  end if;

  if p_amount_cents is null or p_amount_cents <> v_intent.price_cents_at_checkout then
    raise exception 'stripe amount does not match this intent''s frozen price';
  end if;

  if public.payment_intent_has_lost_dispute(p_stripe_payment_intent_id) then
    update public.book_checkout_intents
    set stripe_payment_intent_id = p_stripe_payment_intent_id,
        completed_at = now(),
        reconciliation_reason = 'disputed_lost'
    where id = p_intent_id;
    return query select 'blocked_disputed_lost'::text, v_intent.book_id, v_intent.reader_id;
    return;
  end if;

  if v_intent.book_id is null or v_intent.reader_id is null then
    update public.book_checkout_intents
    set stripe_payment_intent_id = p_stripe_payment_intent_id,
        completed_at = now(),
        reconciliation_reason = 'book_or_reader_deleted'
    where id = p_intent_id;
    return query select 'blocked_book_or_reader_deleted'::text, null::uuid, null::uuid;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(v_intent.reader_id::text),
    pg_catalog.hashtext(v_intent.book_id::text)
  );

  -- IMPLEMENTATION-1C correction 2 (see this function's own top
  -- comment): p.id is selected specifically to detect "does an existing
  -- purchases row exist at all" -- id is the primary key, always
  -- non-null for a real row, unlike stripe_checkout_session_id (now
  -- nullable, Part 5) or stripe_payment_intent_id (always nullable).
  -- When no row matches, v_existing.id is null and every other field is
  -- null too (a SELECT INTO that finds zero rows leaves the whole
  -- record null) -- relying on refunded_at is null alone to mean
  -- "active" would be wrong in that case, since a genuinely nonexistent
  -- row also satisfies "refunded_at is null".
  select p.id, p.stripe_payment_intent_id, p.refunded_at
  into v_existing
  from public.purchases p
  where p.book_id = v_intent.book_id
    and p.reader_id = v_intent.reader_id;

  if v_existing.id is not null
     and v_existing.refunded_at is null
     and not public.payment_intent_has_lost_dispute(v_existing.stripe_payment_intent_id)
  then
    update public.book_checkout_intents
    set stripe_payment_intent_id = p_stripe_payment_intent_id,
        completed_at = now(),
        reconciliation_reason = 'active_other_session'
    where id = p_intent_id;
    return query select 'active_other_session'::text, v_intent.book_id, v_intent.reader_id;
    return;
  end if;

  insert into public.purchases (
    book_id, reader_id, stripe_checkout_session_id, stripe_payment_intent_id,
    amount_cents, discount_code_id, refunded_at, regime
  ) values (
    v_intent.book_id, v_intent.reader_id, p_stripe_checkout_session_id, p_stripe_payment_intent_id,
    v_intent.price_cents_at_checkout, v_intent.discount_code_id, null, v_intent.regime
  )
  on conflict (book_id, reader_id) do update set
    stripe_checkout_session_id = excluded.stripe_checkout_session_id,
    stripe_payment_intent_id = excluded.stripe_payment_intent_id,
    amount_cents = excluded.amount_cents,
    discount_code_id = excluded.discount_code_id,
    refunded_at = null,
    regime = excluded.regime;

  update public.book_checkout_intents
  set stripe_payment_intent_id = p_stripe_payment_intent_id,
      completed_at = now(),
      fulfilled_at = now()
  where id = p_intent_id;

  return query select 'eligible_fulfilled'::text, v_intent.book_id, v_intent.reader_id;
end;
$$;

revoke all on function public.finalize_book_checkout_intent_entitlement_core(uuid, text, text, integer)
  from public, anon, authenticated, service_role;

-- ============================================================
-- finalize_book_checkout_intent() -- remains the legacy-compatible
-- public/service_role RPC (STRIPE-CUTOVER-1B.6 Section 23). External
-- signature and RETURNS TABLE shape are byte-identical to the pre-056
-- version, so this is a plain CREATE OR REPLACE (no drop): the live
-- Stripe webhook (src/app/api/webhooks/stripe/route.ts,
-- fulfillSingleBookPurchase()) continues to call this exact RPC with
-- exactly the same four arguments, completely unaware anything changed.
--
-- The one new line -- explicitly requiring regime =
-- legacy_stripe_connect_v1 before delegating to the shared core -- is
-- the entire enforcement of STRIPE-CUTOVER-1B.6 Section 23/24's
-- guardrail: a librum_ledger_v1 intent can never be finalized through
-- this path, only through finalize_ledger_book_payment() (Part 15),
-- which additionally enforces payment-event binding and the hard
-- actual-vs-expected amount/currency match before ever reaching the
-- same shared entitlement logic.
-- ============================================================

create or replace function public.finalize_book_checkout_intent(
  p_intent_id uuid,
  p_stripe_checkout_session_id text,
  p_stripe_payment_intent_id text,
  p_amount_cents integer
)
returns table (
  outcome text,
  out_book_id uuid,
  out_reader_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_regime text;
begin
  select regime into v_regime from public.book_checkout_intents where id = p_intent_id;

  if v_regime is null then
    raise exception 'checkout intent not found';
  end if;

  if v_regime <> 'legacy_stripe_connect_v1' then
    raise exception
      'finalize_book_checkout_intent: intent % is not a legacy_stripe_connect_v1 checkout (regime %) -- ledger_v1 checkouts must be finalized via finalize_ledger_book_payment',
      p_intent_id, v_regime;
  end if;

  return query
  select *
  from public.finalize_book_checkout_intent_entitlement_core(
    p_intent_id, p_stripe_checkout_session_id, p_stripe_payment_intent_id, p_amount_cents
  );
end;
$$;

-- Grants unchanged from migration 035 -- CREATE OR REPLACE FUNCTION
-- does not reset a function's existing ACL, but restated here anyway,
-- matching this codebase's own established convention.
revoke all on function public.finalize_book_checkout_intent(uuid, text, text, integer) from public;
revoke all on function public.finalize_book_checkout_intent(uuid, text, text, integer) from anon;
revoke all on function public.finalize_book_checkout_intent(uuid, text, text, integer) from authenticated;
grant execute on function public.finalize_book_checkout_intent(uuid, text, text, integer) to service_role;

-- ============================================================
-- Part 13: record_successful_sale() -- final signature and two-branch
-- body (STRIPE-CUTOVER-1B.6). The 6th parameter is RENAMED
-- (p_available_at -> p_paid_at) on the same type-position signature --
-- CREATE OR REPLACE FUNCTION rejects a parameter rename even when every
-- argument type is unchanged, so this requires DROP FUNCTION first,
-- exactly like a genuine type/arity change would.
-- ============================================================

drop function if exists public.record_successful_sale(text, text, text, uuid[], integer, timestamptz, uuid);

create or replace function public.record_successful_sale(
  p_provider text,
  p_provider_payment_id text,
  p_currency text,
  p_purchase_ids uuid[],
  p_royalty_rate_bps integer,
  p_paid_at timestamptz,
  p_buyer_id uuid default null
)
returns table (
  purchase_id uuid,
  ledger_entry_id uuid,
  created boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purchase_ids uuid[];
  v_canonical_ids uuid[];
  v_payment_id uuid;
  v_payment record;
  v_total_gross bigint;
  v_distinct_reader_count integer;
  v_derived_reader_id uuid;
  v_pid uuid;
  v_purchase record;
  v_gross bigint;
  v_librum bigint;
  v_author_amount bigint;
  v_existing_entry record;
  v_entry_id uuid;
  v_available_at timestamptz;
begin
  if p_provider is null or length(trim(p_provider)) = 0 then
    raise exception 'p_provider is required';
  end if;
  if p_provider_payment_id is null or length(trim(p_provider_payment_id)) = 0 then
    raise exception 'p_provider_payment_id is required';
  end if;
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'p_currency must be a 3-letter uppercase code';
  end if;
  if p_royalty_rate_bps is null or p_royalty_rate_bps < 0 or p_royalty_rate_bps > 10000 then
    raise exception 'p_royalty_rate_bps must be between 0 and 10000';
  end if;
  if p_paid_at is null then
    raise exception 'p_paid_at is required';
  end if;

  select array_agg(distinct x order by x) into v_purchase_ids from unnest(p_purchase_ids) x;
  if v_purchase_ids is null or array_length(v_purchase_ids, 1) is null then
    raise exception 'p_purchase_ids must contain at least one purchase id';
  end if;

  if (select count(*) from public.purchases pu where pu.id = any(v_purchase_ids))
     <> array_length(v_purchase_ids, 1) then
    raise exception 'one or more purchase ids do not exist';
  end if;

  select count(distinct coalesce(pu.reader_id::text, '00000000-0000-0000-0000-000000000000'))
    into v_distinct_reader_count
    from public.purchases pu
    where pu.id = any(v_purchase_ids);

  if v_distinct_reader_count > 1 then
    raise exception 'the supplied purchases do not all belong to the same reader (mixed buyers)';
  end if;

  select pu.reader_id into v_derived_reader_id
    from public.purchases pu
    where pu.id = v_purchase_ids[1];

  if p_buyer_id is not null and v_derived_reader_id is not null and p_buyer_id <> v_derived_reader_id then
    raise exception
      'p_buyer_id (%) does not match the reader derived from the supplied purchases (%)',
      p_buyer_id, v_derived_reader_id;
  end if;

  -- v_total_gross is only ever computed from purchases.amount_cents HERE
  -- -- as the candidate INSERT amount for a brand new payment -- never
  -- read or trusted again once a payment already exists (see the retry
  -- branch below, which never touches purchases.amount_cents at all).
  -- Safe here specifically because, if this insert wins, these purchases
  -- were just finalized/upserted in the SAME outer transaction from
  -- frozen checkout/snapshot data by the calling wrapper, moments before
  -- this call (STRIPE-CUTOVER-1B.6 Section 18).
  select coalesce(sum(pu.amount_cents), 0) into v_total_gross
    from public.purchases pu
    where pu.id = any(v_purchase_ids);

  if v_total_gross <= 0 then
    raise exception 'total gross amount for the supplied purchases must be positive';
  end if;

  v_available_at := p_paid_at + interval '30 days';

  -- regime is a hardcoded trusted literal, never a caller-supplied
  -- parameter (STRIPE-CUTOVER-1B.6 Section 9): calling this function at
  -- all is definitionally a ledger_v1 event, since after Part 33 below
  -- it is callable only by the ledger wrapper RPCs.
  insert into public.payments
    (provider, provider_payment_id, buyer_id, amount_minor, currency, status, paid_at, regime)
    values
    (p_provider, p_provider_payment_id, v_derived_reader_id, v_total_gross, p_currency, 'succeeded', p_paid_at, 'librum_ledger_v1')
    on conflict (provider, provider_payment_id) do nothing
    returning payments.id
    into v_payment_id;

  if v_payment_id is not null then
    -- ========================================================
    -- FRESH PAYMENT BRANCH (STRIPE-CUTOVER-1B.6 Section 18). Derives
    -- economics from current purchases.amount_cents -- the only branch
    -- where that is ever safe to do.
    -- ========================================================
    foreach v_pid in array v_purchase_ids loop
      select pu.id as purchase_id, pu.amount_cents, b.author_id
        into v_purchase
        from public.purchases pu
        join public.books b on b.id = pu.book_id
        where pu.id = v_pid;

      v_gross := v_purchase.amount_cents;
      v_librum := round(v_gross * (10000 - p_royalty_rate_bps) / 10000.0)::bigint;
      v_author_amount := v_gross - v_librum;

      insert into public.author_ledger_entries
        (author_id, purchase_id, payment_id, entry_type, amount_minor, currency,
         royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at)
      values
        (v_purchase.author_id, v_pid, v_payment_id, 'sale', v_author_amount, p_currency,
         p_royalty_rate_bps, v_gross, v_librum, v_available_at)
      returning id into v_entry_id;

      -- "Most recent payment for this current entitlement" pointer --
      -- STRIPE-CUTOVER-1B.6 Section 16 -- unconditional, since this
      -- branch only runs once, at true creation time.
      update public.purchases set payment_id = v_payment_id where id = v_pid;

      purchase_id := v_pid;
      ledger_entry_id := v_entry_id;
      created := true;
      return next;
    end loop;
    return;
  end if;

  -- ========================================================
  -- EXISTING PAYMENT RETRY BRANCH (STRIPE-CUTOVER-1B.6 Section 19).
  -- Never reads purchases.amount_cents for economics, never updates
  -- purchases.payment_id, never updates payments. Every fact compared
  -- below comes from the immutable payments row itself or from the
  -- immutable author_ledger_entries sale rows already recorded against
  -- it -- reconstructed here, never from the mutable current-entitlement
  -- state (STRIPE-CUTOVER-1B.5 Section 8, 1B.6 Section 22).
  -- ========================================================
  select p.id, p.currency, p.paid_at, p.regime into v_payment
    from public.payments p
    where p.provider = p_provider and p.provider_payment_id = p_provider_payment_id;

  v_payment_id := v_payment.id;

  if v_payment.regime <> 'librum_ledger_v1' then
    raise exception
      'payment %/% is not a librum_ledger_v1 payment (regime %) -- cannot be retried via record_successful_sale',
      p_provider, p_provider_payment_id, v_payment.regime;
  end if;

  if v_payment.currency <> p_currency then
    raise exception
      'payment %/% already recorded with a different currency (existing=%, requested=%)',
      p_provider, p_provider_payment_id, v_payment.currency, p_currency;
  end if;

  if v_payment.paid_at <> p_paid_at then
    raise exception
      'payment %/% already recorded with a different paid_at (existing=%, requested=%)',
      p_provider, p_provider_payment_id, v_payment.paid_at, p_paid_at;
  end if;

  select array_agg(ale.purchase_id order by ale.purchase_id) into v_canonical_ids
    from public.author_ledger_entries ale
    where ale.payment_id = v_payment_id and ale.entry_type = 'sale';

  if v_canonical_ids is distinct from v_purchase_ids then
    raise exception
      'payment %/% is already linked to a different set of purchases and cannot be reassigned',
      p_provider, p_provider_payment_id;
  end if;

  foreach v_pid in array v_purchase_ids loop
    select ale.id, ale.royalty_rate_bps
      into v_existing_entry
      from public.author_ledger_entries ale
      where ale.payment_id = v_payment_id and ale.purchase_id = v_pid and ale.entry_type = 'sale';

    if v_existing_entry.id is null then
      raise exception
        'payment %/% is missing a sale entry for purchase % -- partial/corrupt prior recording, cannot safely retry',
        p_provider, p_provider_payment_id, v_pid;
    end if;

    if v_existing_entry.royalty_rate_bps <> p_royalty_rate_bps then
      raise exception
        'purchase % sale entry royalty_rate_bps does not match retry request (existing=%, requested=%)',
        v_pid, v_existing_entry.royalty_rate_bps, p_royalty_rate_bps;
    end if;

    purchase_id := v_pid;
    ledger_entry_id := v_existing_entry.id;
    created := false;
    return next;
  end loop;
end;
$$;

-- STRIPE-CUTOVER-1B.6 Section 24/1C Part 24: INTERNAL financial
-- primitive after this migration -- EXECUTE is revoked from
-- service_role too, not just public/anon/authenticated. The only
-- legitimate callers are finalize_ledger_book_payment() (Part 16) and
-- finalize_ledger_bundle_payment() (Part 17), both SECURITY DEFINER
-- functions owned by the same role that owns this one -- ownership
-- privilege is never revoked by these statements, so the nested calls
-- keep working (see the "direct bypass denied" regression tests). This
-- is what makes the wrapper's own payment_event binding, hard actual-
-- vs-expected amount/currency match, and checkout-regime validation
-- impossible to bypass via a bare service_role RPC call.
revoke all on function public.record_successful_sale(text, text, text, uuid[], integer, timestamptz, uuid)
  from public, anon, authenticated, service_role;

-- ============================================================
-- Part 14: mark_payment_event_processed()/mark_payment_event_failed()
-- become internal too (STRIPE-CUTOVER-1B.6 Section 25). Zero current
-- application call sites exist for either (confirmed by repo-wide
-- search) -- there is no proven legacy caller to preserve, and ledger-
-- v1 event disposition must only ever happen via the atomic wrapper
-- that also recorded the corresponding business effect, never via a
-- bare, independent service_role call that could mark an event
-- processed without ever having created the payment/ledger rows it
-- claims to represent. Bodies are unchanged from migration 049 -- only
-- the grant is narrowed, so a plain REVOKE is sufficient (no drop or
-- redefinition needed).
-- ============================================================

revoke execute on function public.mark_payment_event_processed(uuid) from service_role;
revoke execute on function public.mark_payment_event_failed(uuid, text) from service_role;

-- ============================================================
-- Part 15: record_refund() -- corrected signature (STRIPE-CUTOVER-
-- 1B.5 Section G, 1B.6 Section 14 confirms no further change needed).
-- Resolves the payment being refunded via the immutable (provider,
-- provider_payment_id) key -- NEVER via purchases.payment_id, which
-- only ever reflects the current entitlement's MOST RECENT payment and
-- would resolve to the wrong (later) payment once the same purchases
-- row has been reused by a subsequent transaction. Resolves the
-- original sale via the composite (payment_id, purchase_id) key,
-- mirroring record_successful_sale's own Part 13 correction. Argument
-- list changes (two new leading parameters), so this requires
-- drop+recreate exactly like every other signature change in this
-- file. Every other line of logic below (full-refund-only V1 behavior,
-- provider-refund-id idempotency/conflict handling, the payment-status
-- derivation) is unchanged from the pre-056 body.
-- ============================================================

drop function if exists public.record_refund(uuid, text);

create or replace function public.record_refund(
  p_provider text,
  p_provider_payment_id text,
  p_purchase_id uuid,
  p_provider_refund_id text
)
returns table (
  payment_refund_id uuid,
  ledger_entry_id uuid,
  created boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purchase record;
  v_payment record;
  v_sale record;
  v_existing_refund record;
  v_refund_id uuid;
  v_ledger_id uuid;
  v_refunded_sum bigint;
  v_new_status text;
begin
  if p_provider is null or length(trim(p_provider)) = 0 then
    raise exception 'p_provider is required';
  end if;
  if p_provider_payment_id is null or length(trim(p_provider_payment_id)) = 0 then
    raise exception 'p_provider_payment_id is required';
  end if;
  if p_purchase_id is null then
    raise exception 'p_purchase_id is required';
  end if;
  if p_provider_refund_id is null or length(trim(p_provider_refund_id)) = 0 then
    raise exception 'p_provider_refund_id is required';
  end if;

  select pu.id into v_purchase
    from public.purchases pu
    where pu.id = p_purchase_id;

  if v_purchase.id is null then
    raise exception 'purchase % does not exist', p_purchase_id;
  end if;

  select p.id, p.provider, p.amount_minor, p.currency into v_payment
    from public.payments p
    where p.provider = p_provider and p.provider_payment_id = p_provider_payment_id;

  if v_payment.id is null then
    raise exception 'payment %/% does not exist; cannot record a refund', p_provider, p_provider_payment_id;
  end if;

  select ale.id, ale.author_id, ale.amount_minor, ale.gross_amount_minor into v_sale
    from public.author_ledger_entries ale
    where ale.payment_id = v_payment.id and ale.purchase_id = p_purchase_id and ale.entry_type = 'sale';

  if v_sale.id is null then
    raise exception 'no sale ledger entry found for payment %/% purchase %; cannot record a refund',
      p_provider, p_provider_payment_id, p_purchase_id;
  end if;

  select pr.id, pr.provider, pr.provider_refund_id into v_existing_refund
    from public.payment_refunds pr
    where pr.payment_id = v_payment.id and pr.purchase_id = p_purchase_id;

  if v_existing_refund.id is not null then
    if v_existing_refund.provider = v_payment.provider
       and v_existing_refund.provider_refund_id = p_provider_refund_id then
      select ale.id into v_ledger_id
        from public.author_ledger_entries ale
        where ale.payment_refund_id = v_existing_refund.id and ale.entry_type = 'refund';
      payment_refund_id := v_existing_refund.id;
      ledger_entry_id := v_ledger_id;
      created := false;
      return next;
      return;
    else
      raise exception
        'payment %/% purchase % has already been refunded under a different provider refund id (%/%); full-refund-only V1 does not support a second refund',
        p_provider, p_provider_payment_id, p_purchase_id, v_existing_refund.provider, v_existing_refund.provider_refund_id;
    end if;
  end if;

  begin
    insert into public.payment_refunds
      (payment_id, purchase_id, provider, provider_refund_id, amount_minor, currency, refunded_at)
    values
      (v_payment.id, p_purchase_id, v_payment.provider, p_provider_refund_id,
       v_sale.gross_amount_minor, v_payment.currency, now())
    returning id into v_refund_id;
  exception when unique_violation then
    -- The only remaining unique constraint that can fire here is
    -- (provider, provider_refund_id) -- the (payment_id, purchase_id)
    -- scoped check above already ruled out a pre-existing row for THIS
    -- payment/purchase pair, so a conflict now means either a benign
    -- concurrent retry of this exact call, or a genuine attempt to
    -- reuse this provider_refund_id against a DIFFERENT purchase
    -- entirely.
    select pr.id, pr.payment_id, pr.purchase_id into v_existing_refund
      from public.payment_refunds pr
      where pr.provider = v_payment.provider and pr.provider_refund_id = p_provider_refund_id;

    if v_existing_refund.id is not null
       and v_existing_refund.payment_id = v_payment.id
       and v_existing_refund.purchase_id = p_purchase_id
    then
      select ale.id into v_ledger_id
        from public.author_ledger_entries ale
        where ale.payment_refund_id = v_existing_refund.id and ale.entry_type = 'refund';
      payment_refund_id := v_existing_refund.id;
      ledger_entry_id := v_ledger_id;
      created := false;
      return next;
      return;
    end if;

    raise exception
      'provider refund id %/% is already recorded against a different payment/purchase',
      v_payment.provider, p_provider_refund_id;
  end;

  insert into public.author_ledger_entries
    (author_id, purchase_id, payment_id, payment_refund_id, entry_type, amount_minor, currency, available_at)
  values
    (v_sale.author_id, p_purchase_id, v_payment.id, v_refund_id, 'refund',
     -v_sale.amount_minor, v_payment.currency, now())
  returning id into v_ledger_id;

  select coalesce(sum(pr.amount_minor), 0) into v_refunded_sum
    from public.payment_refunds pr
    where pr.payment_id = v_payment.id;

  if v_refunded_sum > v_payment.amount_minor then
    raise exception
      'payment % refunded sum % exceeds payment total % -- data integrity violation',
      v_payment.id, v_refunded_sum, v_payment.amount_minor;
  elsif v_refunded_sum = v_payment.amount_minor then
    v_new_status := 'refunded';
  elsif v_refunded_sum > 0 then
    v_new_status := 'partially_refunded';
  else
    v_new_status := 'succeeded';
  end if;

  update public.payments set status = v_new_status, updated_at = now() where id = v_payment.id;

  payment_refund_id := v_refund_id;
  ledger_entry_id := v_ledger_id;
  created := true;
  return next;
end;
$$;

revoke all on function public.record_refund(text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.record_refund(text, text, uuid, text) to service_role;

-- ============================================================
-- Part 16: finalize_ledger_book_payment() -- the single-book atomic
-- ledger wrapper (STRIPE-CUTOVER-1B.3 Section 9/26, 1B.6 Section 26).
-- Every step below runs inside this one function's own transaction --
-- any exception rolls back everything: the payment_event row lock, any
-- entitlement write the core made, and any payment/ledger write
-- record_successful_sale made. All commit or all rollback.
--
-- Does NOT accept author_id, expected amount, expected currency,
-- royalty rate, available_at, or regime -- every one of those is
-- derived from the trusted, already-frozen book_checkout_intents row
-- (regime/currency/royalty_rate_bps, Part 1) or computed internally
-- (available_at, inside record_successful_sale, Part 13).
-- ============================================================

create or replace function public.finalize_ledger_book_payment(
  p_payment_event_id uuid,
  p_intent_id uuid,
  p_provider text,
  p_provider_payment_id text,
  p_actual_amount_minor bigint,
  p_actual_currency text,
  p_paid_at timestamptz
)
returns table (
  outcome text,
  out_book_id uuid,
  out_reader_id uuid,
  out_author_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event record;
  v_intent record;
  v_normalized_currency text;
  v_core record;
  v_purchase_id uuid;
  v_author_id uuid;
begin
  if p_payment_event_id is null then raise exception 'p_payment_event_id is required'; end if;
  if p_intent_id is null then raise exception 'p_intent_id is required'; end if;
  if p_provider is null or length(trim(p_provider)) = 0 then raise exception 'p_provider is required'; end if;
  if p_provider_payment_id is null or length(trim(p_provider_payment_id)) = 0 then
    raise exception 'p_provider_payment_id is required';
  end if;
  if p_paid_at is null then raise exception 'p_paid_at is required'; end if;

  -- Payment-event binding (STRIPE-CUTOVER-1B.3 Section 5, 1B.4 Section
  -- 10): a mismatch here means the caller is trying to finalize a
  -- payment using an event that doesn't actually correspond to it --
  -- raise before touching the checkout intent or anything else.
  select id, provider, provider_payment_id into v_event
    from public.payment_events
    where id = p_payment_event_id
    for update;

  if v_event.id is null then
    raise exception 'finalize_ledger_book_payment: payment_event % not found', p_payment_event_id;
  end if;

  if v_event.provider is distinct from p_provider
     or v_event.provider_payment_id is distinct from p_provider_payment_id
  then
    raise exception
      'finalize_ledger_book_payment: payment_event %/% does not match supplied provider/provider_payment_id (event provider=%, provider_payment_id=%)',
      p_provider, p_provider_payment_id, v_event.provider, v_event.provider_payment_id;
  end if;

  select id, book_id, reader_id, price_cents_at_checkout, currency, royalty_rate_bps, regime
    into v_intent
    from public.book_checkout_intents
    where id = p_intent_id
    for update;

  if v_intent.id is null then
    raise exception 'finalize_ledger_book_payment: checkout intent % not found', p_intent_id;
  end if;

  if v_intent.regime <> 'librum_ledger_v1' then
    raise exception
      'finalize_ledger_book_payment: intent % is not a librum_ledger_v1 checkout (regime %) -- use finalize_book_checkout_intent for legacy_stripe_connect_v1',
      p_intent_id, v_intent.regime;
  end if;

  -- Hard actual-vs-expected match (STRIPE-CUTOVER-1B.3 Section 31,
  -- explicitly re-locked in 1B.3 -- no legacy permissiveness leaks into
  -- ledger_v1). A mismatch raises here, before any write of any kind --
  -- zero entitlement/payment/ledger mutations, and payment_event stays
  -- whatever it already was ('received').
  v_normalized_currency := upper(btrim(coalesce(p_actual_currency, '')));

  if p_actual_amount_minor is null or p_actual_amount_minor <= 0 then
    raise exception 'finalize_ledger_book_payment: p_actual_amount_minor must be positive';
  end if;

  if p_actual_amount_minor <> v_intent.price_cents_at_checkout
     or v_normalized_currency <> v_intent.currency
  then
    raise exception
      'finalize_ledger_book_payment: amount/currency mismatch for intent % (expected % %, got % %)',
      p_intent_id, v_intent.price_cents_at_checkout, v_intent.currency, p_actual_amount_minor, v_normalized_currency;
  end if;

  -- Shared entitlement core (Part 12). stripe_checkout_session_id is
  -- passed null -- ledger_v1 is provider-neutral and has no Stripe
  -- checkout session concept (Part 5's nullability relaxation exists
  -- precisely for this call).
  -- Aliased and column-qualified: this function's own RETURNS TABLE
  -- declares outcome/out_book_id/out_reader_id too (in-scope as plpgsql
  -- variables for the whole function body), which collides with a bare
  -- column list here exactly as migration 032's own top comment on
  -- finalize_book_checkout_intent already documents for the same class
  -- of collision.
  select core.outcome, core.out_book_id, core.out_reader_id
    into v_core
    from public.finalize_book_checkout_intent_entitlement_core(
      p_intent_id, null, p_provider_payment_id, p_actual_amount_minor::integer
    ) as core;

  if v_core.outcome in ('active_other_session', 'blocked_book_or_reader_deleted', 'blocked_disputed_lost') then
    -- Genuine business-rule block, not a retry-safety concern -- Stripe
    -- (or any provider) redelivering this exact event will never
    -- produce a different outcome (mirrors the existing legacy
    -- fulfillSingleBookPurchase() posture for these same three
    -- outcomes). Marked failed, not left received forever (STRIPE-
    -- CUTOVER-1B.3 Section 7): there is nothing further for a retry of
    -- this event to accomplish.
    perform public.mark_payment_event_failed(p_payment_event_id, v_core.outcome);
    outcome := v_core.outcome;
    out_book_id := v_core.out_book_id;
    out_reader_id := v_core.out_reader_id;
    out_author_id := null;
    return next;
    return;
  end if;

  -- outcome is 'eligible_fulfilled' or 'already_finalized' -- both
  -- proceed to ledger recording. record_successful_sale's own
  -- idempotency (Part 13) is what correctly distinguishes a genuine
  -- fresh payment from a safe retry no-op; this wrapper does not
  -- special-case 'already_finalized' itself (STRIPE-CUTOVER-1B.3
  -- Section 7's corrected retry design -- no naive "already done, skip
  -- everything" shortcut that could leave a legitimate received event
  -- stuck forever).
  select id into v_purchase_id
    from public.purchases
    where book_id = v_core.out_book_id and reader_id = v_core.out_reader_id;

  select author_id into v_author_id from public.books where id = v_core.out_book_id;

  perform public.record_successful_sale(
    p_provider, p_provider_payment_id, v_normalized_currency,
    array[v_purchase_id], v_intent.royalty_rate_bps, p_paid_at, v_core.out_reader_id
  );

  perform public.mark_payment_event_processed(p_payment_event_id);

  outcome := v_core.outcome;
  out_book_id := v_core.out_book_id;
  out_reader_id := v_core.out_reader_id;
  out_author_id := v_author_id;
  return next;
end;
$$;

revoke all on function public.finalize_ledger_book_payment(uuid, uuid, text, text, bigint, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.finalize_ledger_book_payment(uuid, uuid, text, text, bigint, text, timestamptz)
  to service_role;

-- ============================================================
-- Part 17: finalize_ledger_bundle_payment() -- the bundle atomic ledger
-- wrapper (STRIPE-CUTOVER-1B.6 Sections 10/13/27). Fresh SQL, not an
-- extraction of the existing TypeScript fulfillBundleSnapshot() -- the
-- legacy TS path stays exactly as-is (regime-routed at the application
-- layer, Stage 2, out of this migration's scope) and is not reused
-- here, precisely because its provider-specific same-session
-- classification (keyed on stripe_checkout_session_id) does not
-- generalize to a provider-neutral, hard-matched ledger_v1 payment. The
-- classification/allocation rule below is the provider-neutral
-- equivalent, pressure-tested against retry/duplicate-webhook/repeat-
-- purchase scenarios in the accompanying regression suite.
--
-- Uses frozen snapshot facts exclusively for allocation -- never
-- re-reads books.price_cents. Because the actual-vs-expected amount
-- match is HARD here (unlike the legacy bundle path's deliberately
-- permissive, log-only posture -- STRIPE-CUTOVER-1B.3 Section 2
-- explicitly rejects importing that permissiveness into ledger_v1),
-- p_actual_amount_minor is always exactly bundle_price_cents_at_checkout
-- by the time allocation runs -- there is no "already allocated,
-- remaining" bookkeeping to carry across retries the way the legacy
-- path needs: the SAME deterministic floor+remainder-by-position split,
-- over the SAME frozen per-item prices, produces the SAME per-item
-- share on every call for a given snapshot, whether this is the first
-- delivery or the Nth retry.
--
-- "same_payment" classification (an item this exact payment already
-- funded, on an earlier delivery) is detected via purchases.payment_id
-- equalling the ALREADY-EXISTING payments row for (p_provider,
-- p_provider_payment_id) -- the provider-neutral substitute for the
-- legacy path's stripe_checkout_session_id-based same-session check,
-- necessary because a librum_ledger_v1 purchase has no Stripe checkout
-- session id at all (Part 5).
--
-- An item whose author differs from the bundle's own single author is
-- not possible under this schema (bundles are single-author -- see
-- bundle_checkout_snapshots.author_id, migration 025) -- out_author_id
-- below is read directly off the snapshot, not derived per item.
-- ============================================================

create or replace function public.finalize_ledger_bundle_payment(
  p_payment_event_id uuid,
  p_snapshot_id uuid,
  p_provider text,
  p_provider_payment_id text,
  p_actual_amount_minor bigint,
  p_actual_currency text,
  p_paid_at timestamptz
)
returns table (
  outcome text,
  out_reader_id uuid,
  out_author_id uuid,
  out_book_ids uuid[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event record;
  v_snapshot record;
  v_normalized_currency text;
  v_existing_payment_id uuid;
  v_funded_total_frozen bigint;
  v_row record;
  v_purchase_ids uuid[] := array[]::uuid[];
  v_out_book_ids uuid[] := array[]::uuid[];
  v_pid uuid;
begin
  if p_payment_event_id is null then raise exception 'p_payment_event_id is required'; end if;
  if p_snapshot_id is null then raise exception 'p_snapshot_id is required'; end if;
  if p_provider is null or length(trim(p_provider)) = 0 then raise exception 'p_provider is required'; end if;
  if p_provider_payment_id is null or length(trim(p_provider_payment_id)) = 0 then
    raise exception 'p_provider_payment_id is required';
  end if;
  if p_paid_at is null then raise exception 'p_paid_at is required'; end if;

  select id, provider, provider_payment_id into v_event
    from public.payment_events
    where id = p_payment_event_id
    for update;

  if v_event.id is null then
    raise exception 'finalize_ledger_bundle_payment: payment_event % not found', p_payment_event_id;
  end if;

  if v_event.provider is distinct from p_provider
     or v_event.provider_payment_id is distinct from p_provider_payment_id
  then
    raise exception
      'finalize_ledger_bundle_payment: payment_event %/% does not match supplied provider/provider_payment_id (event provider=%, provider_payment_id=%)',
      p_provider, p_provider_payment_id, v_event.provider, v_event.provider_payment_id;
  end if;

  select id, reader_id, author_id, bundle_id, bundle_title, bundle_price_cents_at_checkout,
         items, regime, currency, royalty_rate_bps
    into v_snapshot
    from public.bundle_checkout_snapshots
    where id = p_snapshot_id
    for update;

  if v_snapshot.id is null then
    raise exception 'finalize_ledger_bundle_payment: bundle checkout snapshot % not found', p_snapshot_id;
  end if;

  if v_snapshot.regime <> 'librum_ledger_v1' then
    raise exception
      'finalize_ledger_bundle_payment: snapshot % is not a librum_ledger_v1 checkout (regime %) -- legacy bundle fulfillment handles legacy_stripe_connect_v1',
      p_snapshot_id, v_snapshot.regime;
  end if;

  if v_snapshot.reader_id is null then
    raise exception
      'finalize_ledger_bundle_payment: snapshot % reader_id is null (reader deleted) -- unrecoverable',
      p_snapshot_id;
  end if;

  v_normalized_currency := upper(btrim(coalesce(p_actual_currency, '')));

  if p_actual_amount_minor is null or p_actual_amount_minor <= 0 then
    raise exception 'finalize_ledger_bundle_payment: p_actual_amount_minor must be positive';
  end if;

  -- Hard actual-vs-expected match (STRIPE-CUTOVER-1B.3 Section 2 --
  -- explicitly REJECTS the legacy bundle path's log-only mismatch
  -- posture for ledger_v1). Zero writes of any kind above this point.
  if p_actual_amount_minor <> v_snapshot.bundle_price_cents_at_checkout
     or v_normalized_currency <> v_snapshot.currency
  then
    raise exception
      'finalize_ledger_bundle_payment: amount/currency mismatch for snapshot % (expected % %, got % %)',
      p_snapshot_id, v_snapshot.bundle_price_cents_at_checkout, v_snapshot.currency,
      p_actual_amount_minor, v_normalized_currency;
  end if;

  -- Dispute-before-fulfillment guarantee, mirroring the shared
  -- entitlement core's own guard (Part 12) and the legacy bundle path's
  -- equivalent check.
  if public.payment_intent_has_lost_dispute(p_provider_payment_id) then
    perform public.mark_payment_event_failed(p_payment_event_id, 'blocked_disputed_lost');
    outcome := 'blocked_disputed_lost';
    out_reader_id := v_snapshot.reader_id;
    out_author_id := v_snapshot.author_id;
    out_book_ids := array[]::uuid[];
    return next;
    return;
  end if;

  select id into v_existing_payment_id
    from public.payments
    where provider = p_provider and provider_payment_id = p_provider_payment_id;

  -- Classify every item, compute the deterministic floor+remainder
  -- allocation across the funded (same_payment + eligible) set, and
  -- collect it in one pass -- see this function's own top comment for
  -- why the divisor is the funded set's own frozen-price total, not the
  -- full bundle's (an active_other_payment item's implied share is
  -- redistributed across the funded items, mirroring the legacy path's
  -- own established mechanism, not separately credited to anyone).
  select coalesce(sum(d.frozen_price), 0)
    into v_funded_total_frozen
    from jsonb_array_elements(v_snapshot.items) as item,
      lateral (select (item->>'book_id')::uuid as book_id, (item->>'price_cents_at_checkout')::integer as frozen_price) d
    left join public.purchases pu on pu.book_id = d.book_id and pu.reader_id = v_snapshot.reader_id
    where not (
      pu.id is not null
      and (v_existing_payment_id is null or pu.payment_id is distinct from v_existing_payment_id)
      and pu.refunded_at is null
      and not public.payment_intent_has_lost_dispute(pu.stripe_payment_intent_id)
    );

  if v_funded_total_frozen = 0 then
    raise exception
      'finalize_ledger_bundle_payment: snapshot % has no fundable items but a positive amount must still be allocated (every item already actively owned via a different payment)',
      p_snapshot_id;
  end if;

  for v_row in
    with item_data as (
      select
        (item->>'book_id')::uuid as book_id,
        (item->>'price_cents_at_checkout')::integer as frozen_price,
        (item->>'position')::integer as position
      from jsonb_array_elements(v_snapshot.items) as item
    ),
    classified as (
      select
        d.book_id, d.frozen_price, d.position,
        pu.id as existing_purchase_id,
        case
          when pu.id is not null
            and (v_existing_payment_id is null or pu.payment_id is distinct from v_existing_payment_id)
            and pu.refunded_at is null
            and not public.payment_intent_has_lost_dispute(pu.stripe_payment_intent_id)
          then 'active_other_payment'
          else 'eligible'
        end as classification
      from item_data d
      left join public.purchases pu on pu.book_id = d.book_id and pu.reader_id = v_snapshot.reader_id
    ),
    funded as (
      select * from classified where classification = 'eligible'
    ),
    allocated as (
      select
        book_id, frozen_price, position, existing_purchase_id,
        floor(p_actual_amount_minor * frozen_price::numeric / v_funded_total_frozen)::bigint as floor_share
      from funded
    ),
    final_shares as (
      select
        book_id, existing_purchase_id, floor_share,
        floor_share + case
          when row_number() over (order by position) <= (p_actual_amount_minor - sum(floor_share) over ())
          then 1 else 0
        end as final_share
      from allocated
    )
    select book_id, existing_purchase_id, final_share from final_shares
  loop
    insert into public.purchases (
      book_id, reader_id, stripe_checkout_session_id, stripe_payment_intent_id,
      amount_cents, discount_code_id, bundle_id, refunded_at, regime
    ) values (
      v_row.book_id, v_snapshot.reader_id, null, p_provider_payment_id,
      v_row.final_share, null, v_snapshot.bundle_id, null, v_snapshot.regime
    )
    on conflict (book_id, reader_id) do update set
      stripe_payment_intent_id = excluded.stripe_payment_intent_id,
      amount_cents = excluded.amount_cents,
      bundle_id = excluded.bundle_id,
      refunded_at = null,
      regime = excluded.regime
    returning id into v_pid;

    v_purchase_ids := array_append(v_purchase_ids, v_pid);
    v_out_book_ids := array_append(v_out_book_ids, v_row.book_id);
  end loop;

  -- same_payment items (already funded by an earlier delivery of this
  -- exact payment, untouched above) still belong in the complete
  -- purchase-id set passed to record_successful_sale -- its own
  -- idempotency (Part 13) requires the FULL set on every call, not just
  -- what changed this delivery.
  for v_row in
    select pu.id as pid, pu.book_id as bid
    from public.purchases pu
    where pu.reader_id = v_snapshot.reader_id
      and pu.book_id in (
        select (item->>'book_id')::uuid from jsonb_array_elements(v_snapshot.items) as item
      )
      and v_existing_payment_id is not null
      and pu.payment_id = v_existing_payment_id
      and not (pu.id = any(v_purchase_ids))
  loop
    v_purchase_ids := array_append(v_purchase_ids, v_row.pid);
    v_out_book_ids := array_append(v_out_book_ids, v_row.bid);
  end loop;

  perform public.record_successful_sale(
    p_provider, p_provider_payment_id, v_normalized_currency,
    v_purchase_ids, v_snapshot.royalty_rate_bps, p_paid_at, v_snapshot.reader_id
  );

  update public.bundle_checkout_snapshots
    set fulfilled_at = now(), total_amount_cents = p_actual_amount_minor
    where id = p_snapshot_id and fulfilled_at is null;

  delete from public.bundle_checkout_reservations where snapshot_id = p_snapshot_id;
  delete from public.bundle_checkout_reader_holds where snapshot_id = p_snapshot_id;

  perform public.mark_payment_event_processed(p_payment_event_id);

  outcome := 'eligible_fulfilled';
  out_reader_id := v_snapshot.reader_id;
  out_author_id := v_snapshot.author_id;
  out_book_ids := v_out_book_ids;
  return next;
end;
$$;

revoke all on function public.finalize_ledger_bundle_payment(uuid, uuid, text, text, bigint, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.finalize_ledger_bundle_payment(uuid, uuid, text, text, bigint, text, timestamptz)
  to service_role;
