-- LIBRUM 2.0 LEDGER-1C / LEDGER-1C.1: provider-neutral transactional
-- sale/refund accounting primitives, built ON TOP of migration 048's
-- schema foundation. Migration 048 is already LIVE in production and is
-- not modified by this file in any way. This file has never itself been
-- applied anywhere (LEDGER-1C.1 corrected it in place, before its own
-- first production apply -- there is no migration 050 for these
-- corrections).
--
-- ============================================================
-- CRITICAL BUSINESS FACT (unchanged from LEDGER-1C, restated verbatim):
-- Librum's CURRENT checkout still uses Stripe Connect DESTINATION
-- CHARGES. Under that architecture, the author's share is transferred
-- directly from the buyer's charge to the author's own connected Stripe
-- account -- Librum's own platform balance never holds the author's
-- share, even momentarily. If this migration's new RPCs were called
-- from that flow today, they would create a SECOND, ENTIRELY FICTITIOUS
-- Librum-owed liability on top of money the author has ALREADY been
-- paid directly by Stripe. This migration therefore creates functions
-- ONLY -- nothing in this file is called by any existing application
-- code path. No Stripe checkout, webhook, refund, or dispute file is
-- touched or wired to any function here.
--
-- LEDGER-1C.1 CORRECTIONS (this pass, before 049's first apply):
--   1. record_successful_sale() now freezes the ENTIRE canonical set of
--      purchases a payment funds, not just per-purchase linkage -- a
--      retry may no longer add, remove, or substitute a purchase in an
--      already-accounted payment's set, only exactly repeat it.
--   2. record_successful_sale() no longer trusts a caller-supplied
--      buyer_id as the stored fact -- payments.buyer_id is now DERIVED
--      from the canonical, unanimous purchases.reader_id across the
--      whole purchase set; a mixed-reader set is rejected outright, and
--      an optional caller-supplied buyer_id is only ever used as a
--      consistency CHECK against that derived value, never as an
--      override.
--   3. A new public.payment_refunds table now records the canonical,
--      provider-neutral fact of buyer money actually returned -- one
--      row per refunded purchase (V1: full-purchase-refund-only,
--      documented below) -- and payments.status is now DERIVED from the
--      sum of its own confirmed refunds rather than a single ad hoc
--      single-purchase heuristic. author_ledger_entries gains a new
--      payment_refund_id correlation column (this migration, not 048)
--      with its own idempotency-enforcing partial unique index.
--   4. record_payment_event() now rejects a retry that supplies a
--      DIFFERENT event_type for an already-seen (provider,
--      provider_event_id) pair, rather than silently treating it as an
--      identical retry.
-- ============================================================

-- ============================================================
-- Part 1: purchases.payment_id -- unchanged from LEDGER-1C's own design
-- (see that phase's report for the full FK/index reasoning): nullable,
-- not unique, ON DELETE RESTRICT, indexed. Historical synthetic
-- purchases remain NULL -- no backfill.
-- ============================================================

alter table public.purchases
  add column payment_id uuid references public.payments(id) on delete restrict;

create index purchases_payment_id_idx on public.purchases (payment_id);

-- ============================================================
-- Part 2: payment_refunds -- the canonical, provider-neutral record of
-- "did the buyer's money actually come back."
--
-- WHY A NEW TABLE (LEDGER-1C.1 Section 6, justified before adding it,
-- per this correction's own explicit instruction not to add a sixth
-- financial table casually): author_ledger_entries' own negative
-- 'refund' entry already records what Librum now owes the AUTHOR less
-- of, but nothing before this migration recorded the separate, provider-
-- side fact of how much of ONE PAYMENT has actually been returned to
-- the BUYER -- a fact that matters independently the moment one payment
-- can fund several purchases (a bundle): refunding ONE bundle item is a
-- PARTIAL refund of the payment as a whole, and payments.status cannot
-- be computed truthfully without a durable, summable record of every
-- individual refund against that payment. refund_requests/
-- refund_request_items (audited before writing this table) are the
-- READER-FACING WORKFLOW -- a request and the admin decision on it --
-- not a confirmed provider money movement, and this migration does not
-- overload them into becoming one; refund_issuance_attempts is
-- Stripe-specific attempt-tracking for actually calling Stripe's own
-- refund API (migration 036/037), a different provider-specific
-- concern this provider-neutral table does not touch or duplicate.
--
-- MINIMAL MODEL (Section 7): exactly the columns needed for
-- correctness and idempotency, nothing else. No raw provider payload,
-- no Stripe-specific column, matching every other table in this
-- migration and migration 048.
--
-- V1 FULL-PURCHASE-REFUND-ONLY (Section 8, documented explicitly since
-- it is enforced structurally, not just by convention): unique(
-- purchase_id) means a purchase may have AT MOST ONE payment_refunds
-- row, ever -- matching this codebase's own existing full-refund-only
-- product precedent (issue-refund.ts's "no partial-refund product
-- concept anywhere"). A future partial-refund-per-purchase model would
-- need to relax this constraint deliberately, not have it relaxed by
-- accident.
--
-- payment_id/purchase_id are both NOT NULL and ON DELETE RESTRICT --
-- exactly the same durable-financial-history reasoning as every other
-- RESTRICT relationship in this migration and migration 048: a
-- confirmed refund record must never be capable of silently
-- disappearing because the payment or purchase it refers to is later
-- removed by some future process.
--
-- CROSS-CONSISTENCY (Section 8, "payment_refunds.payment_id must match
-- purchases.payment_id... a refund for purchase A must never be
-- attachable to payment B"): this is NOT expressible as a plain CHECK
-- constraint (it depends on another table's row) -- record_refund()
-- below enforces it directly, by deriving payment_id from the
-- purchase's own canonical payment_id rather than ever accepting it as
-- a separate, independently-suppliable argument that could disagree.
-- ============================================================

create table public.payment_refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete restrict,
  purchase_id uuid not null references public.purchases(id) on delete restrict,
  provider text not null,
  provider_refund_id text not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now(),
  refunded_at timestamptz,
  unique (provider, provider_refund_id),
  unique (purchase_id)
);

create index payment_refunds_payment_id_idx on public.payment_refunds (payment_id);

alter table public.payment_refunds enable row level security;

-- LEDGER-1C.1 Section 21: treated as private payment infrastructure,
-- the same posture as payments/payment_events -- no anon, no ordinary
-- reader, no author access (an author never needs a buyer-side provider
-- refund identifier -- their own economic reversal is already fully
-- visible on their own author_ledger_entries 'refund' row). Only staff
-- with finance.view may read it; all writes are server-controlled only
-- (record_refund(), service_role-only, see Part 5 below) -- no
-- INSERT/UPDATE/DELETE grant or policy for any role anywhere in this
-- file, the same doubly-enforced append-only-style posture as every
-- other table in this migration and migration 048.
revoke all on public.payment_refunds from anon, authenticated;
grant select on public.payment_refunds to authenticated;

create policy "Staff with finance.view can view all payment refunds"
  on public.payment_refunds for select
  using (public.staff_has_permission('finance.view'));

-- ============================================================
-- Part 3: author_ledger_entries.payment_refund_id -- the durable,
-- FK-backed correlation from an author's 'refund' ledger debit to the
-- canonical payment_refunds row it reverses (LEDGER-1C.1 Section 16).
-- Added HERE, in migration 049 (not migration 048, which is already
-- live in production and is never modified) -- this is a plain,
-- backward-compatible ADD COLUMN against a table that already has zero
-- rows in production (LEDGER-1B/1C both created none), so there is
-- nothing to backfill and no existing row this column could ever
-- disagree with.
--
-- Nullable, ON DELETE SET NULL -- matching purchase_id/payment_id/
-- payout_id's own existing pattern on this same table: a ledger row is
-- an audit record in its own right (fully self-describing via its own
-- frozen amount_minor/currency) and must survive even if the row it
-- correlates to is later removed by some future process.
--
-- CHECK (entry_type <> 'refund' or payment_refund_id is not null):
-- every CANONICAL refund (one reversing a real recorded sale, which is
-- the only kind record_refund() ever creates) must be traceable to its
-- payment_refunds row -- reference_type/reference_id (migration 048)
-- remain available and untouched for a manual/future adjustment-style
-- entry that has no payment_refunds row to point to, exactly as
-- migration 048's own Section 46 already anticipated ("a future entry_
-- type or column ever DOES need to carry something more sensitive,
-- revisit this decision then").
--
-- IDEMPOTENCY (Section 17): the partial unique index below enforces, AT
-- THE DATABASE LEVEL, that a given payment_refunds row can have AT MOST
-- ONE corresponding author 'refund' ledger debit, ever -- not merely a
-- convention record_refund()'s own function code happens to follow.
-- ============================================================

alter table public.author_ledger_entries
  add column payment_refund_id uuid references public.payment_refunds(id) on delete set null;

alter table public.author_ledger_entries
  add constraint author_ledger_entries_refund_requires_payment_refund_id
  check (entry_type <> 'refund' or payment_refund_id is not null);

create unique index author_ledger_entries_one_refund_per_payment_refund_idx
  on public.author_ledger_entries (payment_refund_id)
  where entry_type = 'refund';

-- ============================================================
-- Part 4: payment event ingestion/idempotency primitives.
--
-- record_payment_event(): unchanged in shape from LEDGER-1C, but now
-- (LEDGER-1C.1 Section 18) rejects a retry that supplies a DIFFERENT
-- event_type for an already-seen (provider, provider_event_id) pair --
-- provider_event_id identifies one immutable real-world event; its own
-- event_type is a FACT about that event, not a value a caller gets to
-- silently overwrite or disagree with on a later call. An IDENTICAL
-- retry (same event_type) remains a safe, deterministic no-op.
--
-- mark_payment_event_processed()/mark_payment_event_failed(): unchanged
-- from LEDGER-1C -- the two minimal state transitions (Section 19: "do
-- not redesign into a queue system"). A processed event never regresses
-- to failed. EXPECTED ADAPTER SEQUENCE (documented here since no real
-- adapter exists yet to encode it in application code): (1)
-- record_payment_event() to durably dedupe the inbound delivery itself;
-- (2) if freshly received (already_existed = false), attempt the
-- business effect (record_successful_sale()/record_refund()); (3) call
-- mark_payment_event_processed() ONLY after that effect succeeds, or
-- mark_payment_event_failed() if it did not -- an event must never be
-- marked processed when the accounting it was supposed to trigger
-- failed, so a future retry of the same delivery can still find it
-- 'failed' (or still 'received', if the caller's own crash happened
-- before either mark call) and safely re-attempt.
-- ============================================================

create or replace function public.record_payment_event(
  p_provider text,
  p_provider_event_id text,
  p_event_type text
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
  insert into public.payment_events (provider, provider_event_id, event_type)
    values (p_provider, p_provider_event_id, p_event_type)
    -- Referenced by constraint NAME, not a (provider, provider_event_id)
    -- column list: this function's own RETURNS TABLE declares OUT
    -- parameters literally named provider/provider_event_id, which a
    -- bare column-list here would ambiguously collide with ("column
    -- reference \"provider\" is ambiguous... could refer to either a
    -- PL/pgSQL variable or a table column" -- confirmed empirically
    -- against a real Postgres instance while building this migration).
    -- migration 048's own unique(provider, provider_event_id)
    -- constraint is named payment_events_provider_provider_event_id_key
    -- by Postgres's own default naming convention.
    on conflict on constraint payment_events_provider_provider_event_id_key do nothing
    returning
      payment_events.id, payment_events.provider, payment_events.provider_event_id,
      payment_events.event_type, payment_events.status, payment_events.received_at,
      payment_events.processed_at, payment_events.last_error_code, payment_events.created_at
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
    already_existed := false;
    return next;
    return;
  end if;

  select pe.id, pe.provider, pe.provider_event_id, pe.event_type, pe.status,
         pe.received_at, pe.processed_at, pe.last_error_code, pe.created_at
    into v_existing
    from public.payment_events pe
    where pe.provider = p_provider and pe.provider_event_id = p_provider_event_id;

  if v_existing.event_type <> p_event_type then
    raise exception
      'payment event %/% already recorded with a different event_type (existing=%, requested=%)',
      p_provider, p_provider_event_id, v_existing.event_type, p_event_type;
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
  already_existed := true;
  return next;
end;
$$;

revoke all on function public.record_payment_event(text, text, text) from public, anon, authenticated;
grant execute on function public.record_payment_event(text, text, text) to service_role;

create or replace function public.mark_payment_event_processed(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.payment_events where id = p_event_id) then
    raise exception 'payment event not found: %', p_event_id;
  end if;

  update public.payment_events
    set status = 'processed', processed_at = now()
    where id = p_event_id and status <> 'processed';
end;
$$;

revoke all on function public.mark_payment_event_processed(uuid) from public, anon, authenticated;
grant execute on function public.mark_payment_event_processed(uuid) to service_role;

create or replace function public.mark_payment_event_failed(p_event_id uuid, p_error_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.payment_events where id = p_event_id) then
    raise exception 'payment event not found: %', p_event_id;
  end if;

  update public.payment_events
    set status = 'failed', last_error_code = p_error_code, processed_at = now()
    where id = p_event_id and status <> 'processed';
end;
$$;

revoke all on function public.mark_payment_event_failed(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_payment_event_failed(uuid, text) to service_role;

-- ============================================================
-- Part 5: record_successful_sale() -- the core atomic sale-accounting
-- primitive, LEDGER-1C.1-corrected.
--
-- TRUST BOUNDARY: unchanged core principle from LEDGER-1C -- every
-- purchase_id must already exist in public.purchases; author_id is
-- derived from that purchase's own book_id -> books.author_id; gross is
-- read from that purchase's own existing amount_cents. EXECUTE is
-- granted only to service_role.
--
-- BUYER IDENTITY (LEDGER-1C.1 Section 5): payments.buyer_id is now
-- DERIVED from the canonical, UNANIMOUS purchases.reader_id across
-- every purchase in the supplied set -- never taken as the caller's raw
-- claim. A set of purchases whose reader_id values disagree (a "mixed
-- buyer" set -- which should never occur for a single real payment, and
-- is rejected outright as a data-integrity violation if it is ever
-- attempted) is rejected before any write. p_buyer_id remains an
-- OPTIONAL parameter purely as a caller-side consistency assertion: if
-- supplied and it disagrees with the derived reader (when a derived
-- reader exists at all -- a purchase's reader_id can itself be NULL if
-- that reader's own account was since deleted, see migration 038), the
-- call is rejected -- a caller's belief about the buyer must never be
-- allowed to silently diverge from what the purchase records
-- themselves say. When p_buyer_id is omitted, the derived value alone
-- is used, with no cross-check to perform.
--
-- PURCHASE-SET IMMUTABILITY (LEDGER-1C.1 Section 2/3): once a payment
-- has been successfully processed by a FIRST call, the exact set of
-- purchase ids linked to it (`select id from purchases where payment_id
-- = payment.id`) is that payment's permanent, canonical purchase set,
-- for as long as this migration's own accounting model is concerned.
-- A retry for the SAME (provider, provider_payment_id) must supply
-- EXACTLY that same set (order-independent -- both sides are sorted
-- before comparison) to be recognized as a safe, identical retry; any
-- other set -- a substituted purchase of equal value, a subset, a
-- superset, or any combination -- is rejected as a conflict BEFORE any
-- write is attempted, rather than silently added, removed, or
-- re-attributed. This is checked once, for the whole set, immediately
-- after an existing payment is found -- the existing PER-PURCHASE
-- "already linked to a different payment" check inside the main loop
-- below still also runs, independently, and continues to catch the
-- separate case of an individual purchase already belonging to some
-- OTHER, unrelated payment even on a payment's very first (fresh)
-- processing call.
--
-- ROUNDING/ROYALTY/AVAILABLE_AT/BUNDLES/IDEMPOTENCY/ATOMICITY: all
-- unchanged from LEDGER-1C's own design (see that phase's report for
-- the full reasoning) -- this correction pass changes WHO the payment
-- is attributed to and WHETHER its purchase set may ever change after
-- the fact, not how the economics themselves are computed.
-- ============================================================

create or replace function public.record_successful_sale(
  p_provider text,
  p_provider_payment_id text,
  p_currency text,
  p_purchase_ids uuid[],
  p_royalty_rate_bps integer,
  p_available_at timestamptz,
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
  v_existing_amount bigint;
  v_existing_currency text;
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
  v_created boolean;
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
  if p_available_at is null then
    raise exception 'p_available_at is required';
  end if;

  -- Normalize: dedupe and sort, so set-equality comparisons below
  -- (against a payment's own canonical linked set, itself always
  -- fetched sorted the same way) are order-independent.
  select array_agg(distinct x order by x) into v_purchase_ids from unnest(p_purchase_ids) x;
  if v_purchase_ids is null or array_length(v_purchase_ids, 1) is null then
    raise exception 'p_purchase_ids must contain at least one purchase id';
  end if;

  if (select count(*) from public.purchases pu where pu.id = any(v_purchase_ids))
     <> array_length(v_purchase_ids, 1) then
    raise exception 'one or more purchase ids do not exist';
  end if;

  -- BUYER DERIVATION: every purchase in this set must share the same
  -- reader_id. NULL-safe distinct count -- count(distinct x) alone
  -- silently ignores NULL rows, which would wrongly treat "one real
  -- reader plus one NULL (detached) reader" as non-mixed; coalescing to
  -- a sentinel makes NULL itself a comparable value.
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

  select coalesce(sum(pu.amount_cents), 0) into v_total_gross
    from public.purchases pu
    where pu.id = any(v_purchase_ids);

  if v_total_gross <= 0 then
    raise exception 'total gross amount for the supplied purchases must be positive';
  end if;

  insert into public.payments (provider, provider_payment_id, buyer_id, amount_minor, currency, status, paid_at)
    values (p_provider, p_provider_payment_id, v_derived_reader_id, v_total_gross, p_currency, 'succeeded', now())
    on conflict (provider, provider_payment_id) do nothing
    returning payments.id, payments.amount_minor, payments.currency
    into v_payment_id, v_existing_amount, v_existing_currency;

  if v_payment_id is null then
    select p.id, p.amount_minor, p.currency
      into v_payment_id, v_existing_amount, v_existing_currency
      from public.payments p
      where p.provider = p_provider and p.provider_payment_id = p_provider_payment_id;

    -- PURCHASE-SET IMMUTABILITY, checked FIRST: the already-linked set
    -- for this payment must equal the supplied set exactly, or this
    -- retry is rejected outright -- no addition, removal, or
    -- substitution of any kind is ever permitted for an
    -- already-accounted payment. Checked before the economics
    -- comparison below deliberately: v_total_gross is always DERIVED by
    -- summing the supplied purchases' own amount_cents, so any set
    -- mismatch (a subset, a superset, or a substituted purchase of
    -- equal value) usually ALSO produces a mismatched amount_minor --
    -- reporting the set mismatch specifically, rather than a generic
    -- "different economics" message, is the more precise and useful
    -- diagnostic, and is checked first so it always wins when both
    -- would otherwise apply.
    select array_agg(pu.id order by pu.id) into v_canonical_ids
      from public.purchases pu
      where pu.payment_id = v_payment_id;

    if v_canonical_ids is distinct from v_purchase_ids then
      raise exception
        'payment %/% is already linked to a different set of purchases and cannot be reassigned',
        p_provider, p_provider_payment_id;
    end if;

    -- With the set confirmed identical, v_total_gross is now guaranteed
    -- to equal v_existing_amount by construction (same purchases, same
    -- summed amount_cents) -- the only economics that can still
    -- legitimately differ on a genuine retry is currency.
    if v_existing_amount <> v_total_gross or v_existing_currency <> p_currency then
      raise exception
        'payment %/% already recorded with different economics (retry mismatch): existing amount_minor=% currency=%, requested amount_minor=% currency=%',
        p_provider, p_provider_payment_id, v_existing_amount, v_existing_currency, v_total_gross, p_currency;
    end if;
  end if;

  foreach v_pid in array v_purchase_ids loop
    select pu.id as purchase_id, pu.amount_cents, pu.payment_id, b.author_id
      into v_purchase
      from public.purchases pu
      join public.books b on b.id = pu.book_id
      where pu.id = v_pid;

    if v_purchase.payment_id is not null and v_purchase.payment_id <> v_payment_id then
      raise exception 'purchase % is already linked to a different payment (%), not %',
        v_pid, v_purchase.payment_id, v_payment_id;
    end if;

    if v_purchase.payment_id is null then
      update public.purchases set payment_id = v_payment_id where id = v_pid;
    end if;

    v_gross := v_purchase.amount_cents;
    v_librum := round(v_gross * (10000 - p_royalty_rate_bps) / 10000.0)::bigint;
    v_author_amount := v_gross - v_librum;

    select ale.id, ale.amount_minor, ale.gross_amount_minor, ale.librum_amount_minor,
           ale.royalty_rate_bps, ale.currency
      into v_existing_entry
      from public.author_ledger_entries ale
      where ale.purchase_id = v_pid and ale.entry_type = 'sale';

    if v_existing_entry.id is not null then
      if v_existing_entry.amount_minor <> v_author_amount
         or v_existing_entry.gross_amount_minor <> v_gross
         or v_existing_entry.librum_amount_minor <> v_librum
         or v_existing_entry.royalty_rate_bps <> p_royalty_rate_bps
         or v_existing_entry.currency <> p_currency then
        raise exception
          'purchase % already has a sale ledger entry with different economics (retry mismatch)', v_pid;
      end if;
      v_entry_id := v_existing_entry.id;
      v_created := false;
    else
      insert into public.author_ledger_entries
        (author_id, purchase_id, payment_id, entry_type, amount_minor, currency,
         royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at)
      values
        (v_purchase.author_id, v_pid, v_payment_id, 'sale', v_author_amount, p_currency,
         p_royalty_rate_bps, v_gross, v_librum, p_available_at)
      returning id into v_entry_id;
      v_created := true;
    end if;

    purchase_id := v_pid;
    ledger_entry_id := v_entry_id;
    created := v_created;
    return next;
  end loop;
end;
$$;

revoke all on function public.record_successful_sale(text, text, text, uuid[], integer, timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function public.record_successful_sale(text, text, text, uuid[], integer, timestamptz, uuid)
  to service_role;

-- ============================================================
-- Part 6: record_refund() -- LEDGER-1C.1-corrected atomic compensating
-- primitive. Now creates/reuses a canonical payment_refunds row FIRST,
-- then the author ledger debit correlated to it via the new
-- payment_refund_id FK -- not a bare reference_type/reference_id pair.
--
-- PROVIDER (LEDGER-1C.1 Section 10): the caller supplies ONLY
-- p_provider_refund_id -- the external identifier a real provider
-- integration would receive for its own refund object. `provider`
-- itself is DERIVED from the original payment's own `provider` column,
-- never independently suppliable -- V1 has no cross-provider-refund
-- concept (a payment made via one provider cannot be "refunded" by a
-- different one), so there is nothing for a second, separately trusted
-- provider argument to legitimately express here.
--
-- REFUND AMOUNT (Section 9): always the ORIGINAL FROZEN sale's own
-- gross_amount_minor snapshot -- never purchases.amount_cents read
-- fresh (which happens to hold the same value today, but the frozen
-- snapshot is the one number this migration's own snapshot-completeness
-- design (migration 048) guarantees can never drift, by construction).
-- Currency is likewise read from the original payment, not re-derived.
-- Never accepted as a raw caller-supplied amount.
--
-- IDEMPOTENCY / CONFLICT SAFETY (Section 14/15): payment_refunds'
-- unique(purchase_id) means at most one canonical refund per purchase,
-- ever (V1 full-refund-only); unique(provider, provider_refund_id)
-- means the same external refund id can never be attached to two
-- different purchases. A retry with the IDENTICAL (provider derived +
-- provider_refund_id) for the SAME purchase is a safe no-op, returning
-- the existing payment_refund_id/ledger_entry_id unchanged. A DIFFERENT
-- provider_refund_id for an already-refunded purchase is rejected
-- outright (full-refund-only V1 has no second-refund concept to be
-- idempotent about). Reusing the SAME provider_refund_id against a
-- DIFFERENT purchase is rejected outright, distinctly, as a genuine
-- conflict, not confused with the same-purchase retry case.
--
-- PAYMENT STATUS (Section 12): now DERIVED, truthfully, from
-- sum(payment_refunds.amount_minor) for this payment, compared against
-- payments.amount_minor itself -- 'succeeded' (nothing refunded yet --
-- unreachable from inside this function, since it only ever runs after
-- inserting a new refund row, but included for completeness of the
-- derivation rule itself), 'partially_refunded' (some but not all of
-- the payment's total has been returned -- exactly the bundle-item
-- case), or 'refunded' (the full total has been returned, whether via
-- one purchase or the sum of several). A refunded sum exceeding the
-- payment's own total is treated as a data-integrity violation and
-- raises rather than silently storing a nonsensical status -- this
-- cannot occur through this function alone (each purchase's own refund
-- is capped at that purchase's own frozen gross, and purchases' gross
-- amounts already sum to the payment's own total by construction in
-- record_successful_sale()), so reaching it would indicate corruption
-- from outside this function's own write path.
--
-- ATOMICITY: unchanged principle from LEDGER-1C -- the entire function
-- body is one transaction; any exception aborts the whole call. Load
-- purchase/payment/original sale, verify a canonical payment exists,
-- create/reuse the payment_refunds row, insert the ledger debit
-- correlated to it, recompute and persist payment status -- all seven
-- steps or none.
-- ============================================================

create or replace function public.record_refund(
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
  if p_purchase_id is null then
    raise exception 'p_purchase_id is required';
  end if;
  if p_provider_refund_id is null or length(trim(p_provider_refund_id)) = 0 then
    raise exception 'p_provider_refund_id is required';
  end if;

  select pu.id, pu.payment_id into v_purchase
    from public.purchases pu
    where pu.id = p_purchase_id;

  if v_purchase.id is null then
    raise exception 'purchase % does not exist', p_purchase_id;
  end if;
  if v_purchase.payment_id is null then
    raise exception 'purchase % has no canonical payment; cannot record a refund', p_purchase_id;
  end if;

  select p.id, p.provider, p.amount_minor, p.currency into v_payment
    from public.payments p
    where p.id = v_purchase.payment_id;

  select ale.id, ale.author_id, ale.amount_minor, ale.gross_amount_minor into v_sale
    from public.author_ledger_entries ale
    where ale.purchase_id = p_purchase_id and ale.entry_type = 'sale';

  if v_sale.id is null then
    raise exception 'no sale ledger entry found for purchase %; cannot record a refund', p_purchase_id;
  end if;

  -- Idempotency / conflict check, scoped by purchase (V1: at most one
  -- canonical refund per purchase, ever).
  select pr.id, pr.provider, pr.provider_refund_id into v_existing_refund
    from public.payment_refunds pr
    where pr.purchase_id = p_purchase_id;

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
        'purchase % has already been refunded under a different provider refund id (%/%); full-refund-only V1 does not support a second refund',
        p_purchase_id, v_existing_refund.provider, v_existing_refund.provider_refund_id;
    end if;
  end if;

  begin
    insert into public.payment_refunds
      (payment_id, purchase_id, provider, provider_refund_id, amount_minor, currency, refunded_at)
    values
      (v_purchase.payment_id, p_purchase_id, v_payment.provider, p_provider_refund_id,
       v_sale.gross_amount_minor, v_payment.currency, now())
    returning id into v_refund_id;
  exception when unique_violation then
    -- The only remaining unique constraint that can fire here is
    -- (provider, provider_refund_id) -- the purchase_id-scoped check
    -- above already ruled out a pre-existing row for THIS purchase, so
    -- a conflict now means either a benign concurrent retry of this
    -- exact call, or a genuine attempt to reuse this provider_refund_id
    -- against a DIFFERENT purchase entirely.
    select pr.id, pr.purchase_id into v_existing_refund
      from public.payment_refunds pr
      where pr.provider = v_payment.provider and pr.provider_refund_id = p_provider_refund_id;

    if v_existing_refund.id is not null and v_existing_refund.purchase_id = p_purchase_id then
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
      'provider refund id %/% is already recorded against a different purchase',
      v_payment.provider, p_provider_refund_id;
  end;

  insert into public.author_ledger_entries
    (author_id, purchase_id, payment_id, payment_refund_id, entry_type, amount_minor, currency, available_at)
  values
    (v_sale.author_id, p_purchase_id, v_purchase.payment_id, v_refund_id, 'refund',
     -v_sale.amount_minor, v_payment.currency, now())
  returning id into v_ledger_id;

  select coalesce(sum(pr.amount_minor), 0) into v_refunded_sum
    from public.payment_refunds pr
    where pr.payment_id = v_purchase.payment_id;

  if v_refunded_sum > v_payment.amount_minor then
    raise exception
      'payment % refunded sum % exceeds payment total % -- data integrity violation',
      v_purchase.payment_id, v_refunded_sum, v_payment.amount_minor;
  elsif v_refunded_sum = v_payment.amount_minor then
    v_new_status := 'refunded';
  elsif v_refunded_sum > 0 then
    v_new_status := 'partially_refunded';
  else
    v_new_status := 'succeeded';
  end if;

  update public.payments set status = v_new_status, updated_at = now() where id = v_purchase.payment_id;

  payment_refund_id := v_refund_id;
  ledger_entry_id := v_ledger_id;
  created := true;
  return next;
end;
$$;

revoke all on function public.record_refund(uuid, text) from public, anon, authenticated;
grant execute on function public.record_refund(uuid, text) to service_role;

-- ============================================================
-- Part 7: production rollout compatibility -- restated (LEDGER-1C's own
-- Section 46, unaffected by this correction pass): every object this
-- migration adds is either a nullable column with no default that
-- changes no existing row, a brand-new table/index that starts and
-- remains empty, or a brand-new function nothing existing calls. No
-- existing table's existing column, constraint, RLS policy, or grant is
-- altered. Migration 048 remains byte-unchanged. The current
-- application -- including every Stripe checkout/webhook/refund/dispute
-- code path -- continues to run completely unaffected, and every
-- function in this migration remains callable ONLY by service_role.
-- ============================================================
