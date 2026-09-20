-- STALE-CHECKOUT-1: repair the stale paid-book checkout intent.
--
-- The defect, stated exactly. book_checkout_intents is BOTH the economic
-- quote (23 hours -- schema.sql's create_book_checkout_intent) AND the
-- provider-attempt key (pok_book_checkout_orders.intent_id is the PRIMARY
-- KEY, and a POK hosted order lives at most 30 minutes --
-- src/lib/pok-checkout.ts's `Math.min(remaining, 30)`). One intent may
-- therefore hold exactly one provider attempt for its whole life, and the
-- intent has no terminal state meaning "abandoned" -- its only non-fulfilled
-- terminal state requires completed_at plus a reconciliation_reason from a
-- closed list that all mean money arrived. So a spent provider attempt
-- permanently poisons a live quote, and the 46x lifetime mismatch is what
-- makes the poisoning last ~22.5 hours.
--
-- The repair, in one sentence: an economic quote stays IMMUTABLE and gains
-- one terminal, NON-FINANCIAL state (superseded); a provider attempt stays
-- 1:1 with its intent -- the PK is deliberately kept -- and gains one
-- terminal state (retired) plus the window Librum itself requested; and a
-- retry either resumes the same attempt or retires the pair and mints a
-- brand-new intent that re-reads the current book, publication state,
-- price, currency, regime and discount. Nothing is ever retired while its
-- attempt could still take money, so POK's missing cancel operation is
-- never needed.
--
-- The two states are ORTHOGONAL, and that is load-bearing rather than
-- incidental: (superseded, fulfilled) is a legal, expected, auditable
-- terminal state meaning "we gave up on this quote and then its money
-- arrived anyway". A late verified payment on a superseded or retired
-- attempt must still reach fulfilment or reconciliation -- it is never
-- discarded. That is precisely why the supersede rule cannot be a CHECK
-- constraint: a CHECK sees only the post-state, where a superseded-then-
-- paid row legitimately carries both, and "supersession happened while
-- incomplete" is a TRANSITION fact. It lives in a trigger.
--
-- Worst-case reader lockout: ~22.5 hours -> the remainder of a <=30 minute
-- provider window plus a 2 minute safety margin, so roughly 32 minutes.
--
-- This migration is ADDITIVE except for the functions it recreates. It
-- reads and mutates NO existing data row: coalesce(provider_window_ends_at,
-- created_at + interval '30 minutes') is what replaces a backfill, and it
-- is provable from tracked source rather than from reading data, because
-- every pre-migration mapping row was created by code that requested at
-- most 30 minutes.
--
-- Deployment order is migration FIRST, application second. Old five-
-- argument named calls to create_book_checkout_intent still resolve
-- through the new trailing defaults, and the old application reads named
-- JSON fields, so the added output column is inert to it. The reverse
-- order would have the application calling a signature that does not
-- exist.
--
-- Rollback: application first, then these function bodies from git if
-- needed. Leave the added columns and the two new state values in place --
-- they are additive and hold audit data. The one hazard, stated rather
-- than buried: restoring the OLD function bodies WHILE superseded rows
-- exist makes those rows reusable again and resurrects the original
-- lockout. That is a behavioural regression, not data corruption, and it
-- is avoided by rolling the application back first.
--
-- PAID_CHECKOUT_MODE and PAID_PUBLISHING_MODE remain absent everywhere.
-- Applying this migration enables nothing: buyBook() denies at
-- canStartPaidCheckout() before provider resolution and before any RPC.
-- That gate is a server-action gate and protects no database RPC -- see
-- the security note on create_book_checkout_intent below, which is why
-- the new authenticated-reachable surface is bounded in SQL rather than
-- argued from the application.


-- ============================================================
-- Part 1: book_checkout_intents -- the superseded terminal state.
-- ============================================================

alter table public.book_checkout_intents
  add column superseded_at timestamptz,
  add column superseded_reason text;

alter table public.book_checkout_intents
  add constraint book_checkout_intents_superseded_pairing_check
    check ((superseded_at is null) = (superseded_reason is null)),
  -- The INTENT's reason vocabulary. It is deliberately DIFFERENT from the
  -- mapping's (Part 3) and no value is shared: one value could not satisfy
  -- both CHECKs, and writing a mapping-specific reason onto an intent
  -- would be a false record of why the quote was abandoned.
  add constraint book_checkout_intents_superseded_reason_check
    check (superseded_reason is null or superseded_reason in
           ('quote_stale', 'provider_attempt_retired', 'intent_expired'));

-- No CHECK here references completed_at or fulfilled_at. See the header:
-- superseded-then-paid is a legal terminal state.


-- ============================================================
-- Part 2: the transition trigger.
--
-- Renamed from enforce_book_checkout_intents_financial_facts_immutability
-- because the old name is now wrong -- this function enforces transitions,
-- not just field immutability -- and the rename is four reversible
-- statements.
--
-- Bound BEFORE INSERT OR UPDATE, and it branches on tg_op FIRST, because
-- referencing OLD in an INSERT trigger raises at runtime.
-- ============================================================

drop trigger if exists book_checkout_intents_enforce_financial_facts_immutability
  on public.book_checkout_intents;
drop function if exists public.enforce_book_checkout_intents_financial_facts_immutability();

create or replace function public.enforce_book_checkout_intents_transition_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- A row may legitimately be inserted already superseded (nothing does
    -- that today, and nothing forbids it). What it may never be is
    -- inserted already superseded AND financially complete -- the same
    -- invariant the UPDATE path enforces, which an INSERT would otherwise
    -- simply route around.
    if new.superseded_at is not null
       and (new.completed_at is not null or new.fulfilled_at is not null) then
      raise exception
        'book_checkout_intents: an intent cannot be inserted already superseded and financially complete';
    end if;
    return new;
  end if;

  -- STRIPE-CUTOVER-1C (migration 056), carried over unchanged.
  if new.regime is distinct from old.regime
    or new.currency is distinct from old.currency
    or new.royalty_rate_bps is distinct from old.royalty_rate_bps
  then
    raise exception
      'book_checkout_intents: regime/currency/royalty_rate_bps are immutable once set (intent %)',
      old.id;
  end if;

  -- The test must read NEW as well as OLD: an UPDATE that introduces
  -- supersession and financial completion SIMULTANEOUSLY passes an
  -- OLD-only test, and is exactly the hole this closes.
  if old.superseded_at is null and new.superseded_at is not null then
    if old.completed_at is not null or old.fulfilled_at is not null
       or new.completed_at is not null or new.fulfilled_at is not null then
      raise exception
        'book_checkout_intents: a financially complete intent cannot be superseded (intent %)',
        old.id;
    end if;
  elsif old.superseded_at is not null
        and (new.superseded_at is distinct from old.superseded_at
             or new.superseded_reason is distinct from old.superseded_reason) then
    raise exception
      'book_checkout_intents: superseded state is immutable (intent %)', old.id;
  end if;

  -- Deliberately NOT blocked, and this is the whole point of Part 1's
  -- constraint set: an already-superseded row later receiving
  -- completed_at/fulfilled_at changes neither superseded column, so
  -- neither branch above fires and the late payment fulfils normally.
  return new;
end;
$$;

create trigger book_checkout_intents_enforce_transition_rules
  before insert or update on public.book_checkout_intents
  for each row
  execute function public.enforce_book_checkout_intents_transition_rules();

revoke all on function public.enforce_book_checkout_intents_transition_rules()
  from public, anon, authenticated;


-- ============================================================
-- Part 3: pok_book_checkout_orders -- the retired terminal state and the
-- window Librum requested.
--
-- provider_window_ends_at records what Librum REQUESTED, never what POK
-- enforced. It may justify retiring exactly one thing: an attempt with no
-- recorded provider_order_id, whose checkout URL was therefore never
-- disclosed (_self.confirmUrl is only ever surfaced as startPokCheckout's
-- return value, and POK's hosted page is reachable only by an order id we
-- never handed out). An attempt WITH a recorded order id is retired only
-- after an authenticated POK retrieval says so.
-- ============================================================

alter table public.pok_book_checkout_orders
  add column provider_window_ends_at timestamptz,
  add column retired_at timestamptz,
  add column retired_reason text;

alter table public.pok_book_checkout_orders
  drop constraint pok_book_checkout_orders_state_check;

alter table public.pok_book_checkout_orders
  add constraint pok_book_checkout_orders_state_check
    check (state in ('creating', 'ready', 'needs_reconciliation', 'retired')),
  add constraint pok_book_checkout_orders_retired_pairing_check
    check ((retired_at is null) = (retired_reason is null)),
  -- State and its timestamp are one fact, so they cannot disagree:
  -- state='retired' without retirement facts, or retirement facts without
  -- the state, are both impossible.
  add constraint pok_book_checkout_orders_retired_state_check
    check ((state = 'retired') = (retired_at is not null)),
  -- The MAPPING's reason vocabulary. No value is shared with the intent's.
  add constraint pok_book_checkout_orders_retired_reason_check
    check (retired_reason is null or retired_reason in
           ('provider_attempt_expired', 'provider_attempt_canceled',
            'provider_window_elapsed_no_order_id'));

-- The pre-existing `state='ready' implies both ids present` constraint
-- needs no change: 'retired' satisfies its second branch.

create or replace function public.enforce_pok_book_checkout_orders_transition_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.state = 'retired' then
    if new.state is distinct from old.state then
      raise exception
        'pok_book_checkout_orders: a retired attempt cannot leave the retired state (intent %)',
        old.intent_id;
    end if;
    if new.retired_at is distinct from old.retired_at
       or new.retired_reason is distinct from old.retired_reason then
      raise exception
        'pok_book_checkout_orders: retirement facts are immutable (intent %)',
        old.intent_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger pok_book_checkout_orders_enforce_transition_rules
  before update on public.pok_book_checkout_orders
  for each row
  execute function public.enforce_pok_book_checkout_orders_transition_rules();

revoke all on function public.enforce_pok_book_checkout_orders_transition_rules()
  from public, anon, authenticated;


-- ============================================================
-- Part 4: indexes.
-- ============================================================

-- The open-intent index must stop matching superseded and completed rows,
-- or the reuse lookup keeps paying for them forever.
drop index if exists public.book_checkout_intents_reader_book_open_idx;
create index book_checkout_intents_reader_book_open_idx
  on public.book_checkout_intents (reader_id, book_id, created_at desc)
  where fulfilled_at is null and completed_at is null and superseded_at is null;

-- Supports the temporary supersession guard in create_book_checkout_intent.
create index book_checkout_intents_reader_book_superseded_idx
  on public.book_checkout_intents (reader_id, book_id, superseded_at desc)
  where superseded_at is not null;


-- ============================================================
-- Part 5: one consistent lock order.
--
-- Required order, everywhere:
--   payment_events -> advisory(reader, book) -> intent row -> mapping row
--
-- Before this migration the two sides disagreed:
--   create_book_checkout_intent            advisory -> intent row
--   ..._entitlement_core                   intent row -> advisory
--   finalize_ledger_book_payment (wrapper) intent row -> (core's advisory)
--
-- That was harmless only because create_book_checkout_intent never took
-- an intent ROW lock. This repair makes it take one (to supersede a
-- candidate), which closes a genuine deadlock cycle: a retry holding the
-- advisory lock waits for an intent row lock while a concurrent webhook
-- holding that row lock waits for the advisory lock. Postgres would
-- detect it and abort one transaction.
--
-- SCOPE NOTE, stated rather than absorbed: the accepted design named only
-- the entitlement core. Fixing only the core is NOT sufficient, because
-- finalize_ledger_book_payment takes `select ... for update` on the intent
-- in the WRAPPER, before the core is ever entered -- so the POK path would
-- still acquire the intent row lock first and the cycle would survive. The
-- same protocol is therefore applied at the top of that wrapper too. Both
-- functions live in the two files already in scope. pg_advisory_xact_lock
-- is re-entrant within a transaction, so the wrapper and the core taking
-- the same key is a second acquisition, never a self-block.
--
-- THE PRE-READ PROTOCOL, and why an unlocked pre-read is sound here.
-- The lock key is (reader_id, book_id), which lives on the very row we
-- want to lock -- so it must be read before the row lock is taken.
-- reader_id and book_id are written exactly once, at INSERT, and are
-- otherwise only ever set to NULL by `on delete set null`. No code path
-- and no RPC rewrites either to a DIFFERENT identifier. The only
-- transition an unlocked pre-read can therefore miss is non-null -> null,
-- and that is re-checked under the row lock and handled explicitly.
--
-- What is NOT done, and deliberately: coalesce(reader_id::text, '') to
-- fabricate a lock key for a deleted pair. pg_advisory_xact_lock is
-- STRICT, so a null argument silently takes NO LOCK AT ALL -- the version
-- of this code that passed a null would have had a lock-free window and
-- looked locked. When either identifier is already null the advisory lock
-- is SKIPPED entirely and said to be skipped, because every deleted-path
-- outcome writes only the one intent row that the row lock already covers.
-- ============================================================

create or replace function public.finalize_book_checkout_intent_entitlement_core(
  p_intent_id uuid,
  p_stripe_checkout_session_id text,
  p_stripe_payment_intent_id text,
  p_amount_cents integer
)
returns table (
  outcome text,        -- 'eligible_fulfilled' | 'active_other_session'
                        -- | 'blocked_book_or_reader_deleted'
                        -- | 'blocked_disputed_lost' | 'already_finalized'
  out_book_id uuid,     -- null only for blocked_book_or_reader_deleted
  out_reader_id uuid    -- null only for blocked_book_or_reader_deleted
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent record;
  v_existing record;
  v_pre_book_id uuid;
  v_pre_reader_id uuid;
begin
  -- Step 1: read the lock key UNLOCKED.
  select book_id, reader_id
    into v_pre_book_id, v_pre_reader_id
    from public.book_checkout_intents
    where id = p_intent_id;

  -- Step 2/3: lock the pair, unless it is already gone.
  if v_pre_book_id is not null and v_pre_reader_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(v_pre_reader_id::text),
      pg_catalog.hashtext(v_pre_book_id::text)
    );
  end if;

  -- Step 4: the intent row lock, now strictly after the advisory lock.
  select id, book_id, reader_id, discount_code_id, price_cents_at_checkout, regime,
         fulfilled_at, completed_at, reconciliation_reason
  into v_intent
  from public.book_checkout_intents
  where id = p_intent_id
  for update;

  if v_intent.id is null then
    raise exception 'checkout intent not found';
  end if;

  -- Step 5: revalidate the identity the lock was derived from. Enforced,
  -- never assumed. The ONLY legal change is a non-null identifier
  -- becoming null (`on delete set null`); every other difference --
  -- null becoming non-null, or one non-null value becoming a different
  -- one -- would mean the write-once invariant above is false, and is
  -- refused rather than worked around.
  if (v_intent.reader_id is distinct from v_pre_reader_id
      and not (v_pre_reader_id is not null and v_intent.reader_id is null))
     or (v_intent.book_id is distinct from v_pre_book_id
         and not (v_pre_book_id is not null and v_intent.book_id is null)) then
    raise exception
      'book_checkout_intents: reader/book identity changed under lock (intent %)', p_intent_id;
  end if;
  -- If either is null now, the reader or book was deleted. The deleted
  -- branch below writes only this locked row, so an advisory lock we do
  -- not hold (or hold for a pair that no longer exists) changes nothing.

  if v_intent.fulfilled_at is not null or v_intent.reconciliation_reason is not null then
    return query select 'already_finalized'::text, v_intent.book_id, v_intent.reader_id;
    return;
  end if;

  if p_amount_cents is null or p_amount_cents <> v_intent.price_cents_at_checkout then
    raise exception 'stripe amount does not match this intent''s frozen price';
  end if;

  -- LAUNCH-1 P1-7A: dispute-before-fulfillment guarantee. If a dispute
  -- on this exact payment intent has already reached 'lost', no
  -- purchases row is ever written for it -- recorded as completed-but-
  -- blocked, exactly like the book/reader-deleted case below, rather
  -- than silently granting entitlement Librum's own dispute record
  -- already says was lost. Runs inside this function's own existing
  -- row-locked transaction (the `for update` taken above) -- no new
  -- lock needed, since that row lock already fully serializes every
  -- call for this exact intent_id, and this check reads an unrelated
  -- table. Correct under real-world dispute timing: a dispute can only
  -- ever be filed against an already-completed charge, so "dispute
  -- before fulfillment" only ever means webhook processing order
  -- inverted, never that the underlying events truly raced -- a plain
  -- read of already-committed state is sufficient.
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

  -- STALE-CHECKOUT-1: the advisory lock that used to be taken HERE now
  -- sits at the top of this function. Nothing else about this path
  -- changed: the same key, the same transaction, the same coverage of the
  -- purchases read and upsert below -- only acquired earlier, and not
  -- acquired at all on the deleted path, which returns above.

  -- p.id is selected specifically to detect "does an existing purchases
  -- row exist at all" -- id is the primary key, always non-null for a
  -- real row, unlike stripe_checkout_session_id (now nullable) or
  -- stripe_payment_intent_id (always nullable). When no row matches,
  -- v_existing.id is null and every other field is null too.
  select p.id, p.stripe_payment_intent_id, p.refunded_at
  into v_existing
  from public.purchases p
  where p.book_id = v_intent.book_id
    and p.reader_id = v_intent.reader_id;

  -- LAUNCH-1 P1-7A correction: added `and not payment_intent_has_lost_
  -- dispute(v_existing.stripe_payment_intent_id)` -- without it, a
  -- reader's own OLD, disputed-and-lost purchase row would still be
  -- classified "active" here (a dispute never sets refunded_at), wrongly
  -- blocking their legitimate repurchase after paying a second time. An
  -- existing row whose own payment intent is disputed-lost now falls
  -- through to the eligible/upsert path below, exactly like a refunded
  -- row already does.
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

  -- STALE-CHECKOUT-1: fulfilment deliberately ignores superseded_at. A
  -- verified payment ALWAYS grants entitlement, even on a quote Librum
  -- had already given up on -- that is invariant 7, and the trigger in
  -- Part 2 exists to keep this UPDATE legal on a superseded row.
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

-- finalize_ledger_book_payment takes the intent row lock in the WRAPPER,
-- before the core is entered, so the core's move alone would leave the POK
-- path acquiring intent-before-advisory. The same protocol is applied
-- here, after the payment_events lock (which keeps the global order
-- payment_events -> advisory -> intent) and before the intent row lock.
-- Every other statement, outcome value, written column and returned shape
-- is unchanged.
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
  v_pre_book_id uuid;
  v_pre_reader_id uuid;
begin
  if p_payment_event_id is null then raise exception 'p_payment_event_id is required'; end if;
  if p_intent_id is null then raise exception 'p_intent_id is required'; end if;
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
    raise exception 'finalize_ledger_book_payment: payment_event % not found', p_payment_event_id;
  end if;

  if v_event.provider is distinct from p_provider
     or v_event.provider_payment_id is distinct from p_provider_payment_id
  then
    raise exception
      'finalize_ledger_book_payment: payment_event %/% does not match supplied provider/provider_payment_id (event provider=%, provider_payment_id=%)',
      p_provider, p_provider_payment_id, v_event.provider, v_event.provider_payment_id;
  end if;

  -- STALE-CHECKOUT-1: the same pre-read / advisory-lock / row-lock /
  -- identity-revalidation protocol the entitlement core now uses. See
  -- Part 5's header for why the unlocked pre-read is sound and why a
  -- deleted pair skips the lock rather than fabricating a key.
  select book_id, reader_id
    into v_pre_book_id, v_pre_reader_id
    from public.book_checkout_intents
    where id = p_intent_id;

  if v_pre_book_id is not null and v_pre_reader_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(v_pre_reader_id::text),
      pg_catalog.hashtext(v_pre_book_id::text)
    );
  end if;

  select id, book_id, reader_id, price_cents_at_checkout, currency, royalty_rate_bps, regime
    into v_intent
    from public.book_checkout_intents
    where id = p_intent_id
    for update;

  if v_intent.id is null then
    raise exception 'finalize_ledger_book_payment: checkout intent % not found', p_intent_id;
  end if;

  -- Identity revalidation, identical to the core's. See Part 5's header.
  if (v_intent.reader_id is distinct from v_pre_reader_id
      and not (v_pre_reader_id is not null and v_intent.reader_id is null))
     or (v_intent.book_id is distinct from v_pre_book_id
         and not (v_pre_book_id is not null and v_intent.book_id is null)) then
    raise exception
      'book_checkout_intents: reader/book identity changed under lock (intent %)', p_intent_id;
  end if;

  if v_intent.regime <> 'librum_ledger_v1' then
    raise exception
      'finalize_ledger_book_payment: intent % is not a librum_ledger_v1 checkout (regime %) -- use finalize_book_checkout_intent for legacy_stripe_connect_v1',
      p_intent_id, v_intent.regime;
  end if;

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

  select core.outcome, core.out_book_id, core.out_reader_id
    into v_core
    from public.finalize_book_checkout_intent_entitlement_core(
      p_intent_id, null, p_provider_payment_id, p_actual_amount_minor::integer
    ) as core;

  if v_core.outcome in ('active_other_session', 'blocked_book_or_reader_deleted', 'blocked_disputed_lost') then
    perform public.mark_payment_event_failed(p_payment_event_id, v_core.outcome);
    outcome := v_core.outcome;
    out_book_id := v_core.out_book_id;
    out_reader_id := v_core.out_reader_id;
    out_author_id := null;
    return next;
    return;
  end if;

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
-- Part 6: create_book_checkout_intent.
--
-- Dropped and recreated rather than replaced: the RETURNS TABLE shape
-- gains quote_status, which create-or-replace cannot do. Dropping first
-- also guarantees no duplicate overload survives, so an old five-argument
-- call can never silently resolve to the old body.
--
-- Two new trailing, defaulted parameters, exactly the pattern migration
-- 056 used: every existing five-argument named call keeps working
-- unchanged and takes the defaults.
--
-- WHAT CHANGED, beyond the new columns:
--
-- 1. Book availability and ownership are now validated on EVERY path.
--    Before this, the reuse branch returned before both checks, so the
--    RPC -- which is granted to `authenticated` and is directly callable
--    through the Data API -- would hand back a live quote for a book that
--    had since been unpublished, or to a reader who already owned it.
--    buyBook's own checks never closed that: a server-action gate
--    protects no database RPC.
--
-- 2. Reuse now requires the economics to MATCH. Before, any non-terminal
--    unexpired intent was returned verbatim, so a changed price, a
--    revoked discount, or -- worst -- a NEWLY ENTERED valid discount code
--    was silently ignored and the reader was charged the old amount.
--
-- 3. A quote is never rewritten. When the economics have moved, the old
--    quote is SUPERSEDED and a new one minted -- and only when its
--    provider attempt is provably not payable. Otherwise the caller gets
--    a typed conflict status and nothing is mutated.
--
-- SECURITY SURFACE, stated rather than buried. This adds an UPDATE on
-- book_checkout_intents.superseded_at, and (for an id-less elapsed
-- mapping) an UPDATE on pok_book_checkout_orders, reachable by an
-- `authenticated` caller for the first time through the SECURITY DEFINER
-- owner. Both are bounded to that caller's own rows: every candidate is
-- filtered reader_id = auth.uid(). Neither can touch a completed,
-- fulfilled or Stripe-bound row, and the mapping UPDATE fires only under
-- the id-less, window-elapsed predicate. Direct callers still cannot
-- INSERT a mapping -- claim_pok_book_checkout_order is service_role only.
--
-- The pricing arithmetic, including the greatest(..., 50) floor, is
-- copied VERBATIM. This repair does not touch floor policy.
-- ============================================================

drop function if exists public.create_book_checkout_intent(uuid, text, text, text, integer);

create or replace function public.create_book_checkout_intent(
  book_id uuid,
  p_discount_code text default null,
  p_regime text default 'legacy_stripe_connect_v1',
  p_currency text default 'USD',
  p_royalty_rate_bps integer default null,
  p_accept_existing_quote boolean default false,
  p_expected_intent_id uuid default null
)
returns table (
  intent_id uuid,
  price_cents_at_checkout integer,
  discount_code_id uuid,
  expires_at timestamptz,
  quote_status text
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
  v_candidate_id uuid;
  v_candidate record;
  v_map record;
  v_attempt text;
  v_economics_match boolean;
  v_supersede_reason text;
  v_rows integer;
  v_superseded_recently integer;
  v_rate_checked boolean := false;
begin
  v_reader_id := auth.uid();
  if v_reader_id is null then
    raise exception 'not authenticated';
  end if;

  -- The advisory lock is taken FIRST and covers everything below,
  -- including the supersessions and the rate count. Unlike the two
  -- finalization paths this function needs no pre-read: its key comes
  -- from auth.uid() and its own book_id argument, neither of which any
  -- row can invalidate.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(v_reader_id::text),
    pg_catalog.hashtext(create_book_checkout_intent.book_id::text)
  );

  -- Checked on EVERY path now, reuse included -- see note 1 above.
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

  -- LAUNCH-1 P1-7A correction: the same canonical ownership predicate
  -- everything else uses. A reader whose only purchase of this book is
  -- disputed-and-lost may legitimately start a fresh checkout; a reader
  -- with an open, won, warning/inquiry, 'prevented', or unrecognized-
  -- status dispute is still correctly refused.
  if public.user_owns_book(create_book_checkout_intent.book_id) then
    raise exception 'reader already owns this book';
  end if;

  -- The CURRENT economics for THIS request. Derived server-side, never
  -- from a caller-supplied price.
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

  -- ----------------------------------------------------------
  -- The deliberate accept path.
  --
  -- It resumes ONLY the exact intent the reader was shown and clicked to
  -- accept. It never selects another intent, never supersedes, and never
  -- mints -- including after the accepted quote has expired, where
  -- retiring and minting would charge a DIFFERENT amount than the one
  -- they just confirmed, which is the precise harm the conflict notice
  -- exists to prevent.
  -- ----------------------------------------------------------
  if coalesce(p_accept_existing_quote, false) then
    select i.id, i.price_cents_at_checkout, i.discount_code_id, i.expires_at
    into v_candidate
    from public.book_checkout_intents i
    where i.book_id = create_book_checkout_intent.book_id
      and i.reader_id = v_reader_id
      and i.fulfilled_at is null
      and i.completed_at is null
      and i.superseded_at is null
      and i.expires_at > now()
      and i.stripe_checkout_session_id is null
      and i.stripe_payment_intent_id is null
    order by i.created_at desc
    limit 1
    for update;

    if p_expected_intent_id is not null and v_candidate.id = p_expected_intent_id then
      return query
      select v_candidate.id, v_candidate.price_cents_at_checkout,
             v_candidate.discount_code_id, v_candidate.expires_at, 'reused'::text;
      return;
    end if;

    return query
    select null::uuid, null::integer, null::uuid, null::timestamptz, 'expected_intent_changed'::text;
    return;
  end if;

  -- ----------------------------------------------------------
  -- The ordinary path. Candidates newest-first; every check for a
  -- candidate precedes every mutation for it, with both its rows already
  -- locked.
  -- ----------------------------------------------------------
  for v_candidate_id in
    select i.id
    from public.book_checkout_intents i
    where i.book_id = create_book_checkout_intent.book_id
      and i.reader_id = v_reader_id
      and i.fulfilled_at is null
      and i.completed_at is null
      and i.superseded_at is null
    order by i.created_at desc
  loop
    select i.* into v_candidate
    from public.book_checkout_intents i
    where i.id = v_candidate_id
    for update;

    -- Re-asserted under the row lock rather than trusted from the
    -- unlocked id scan above.
    if v_candidate.id is null
       or v_candidate.fulfilled_at is not null
       or v_candidate.completed_at is not null
       or v_candidate.superseded_at is not null then
      continue;
    end if;

    -- A Stripe-bound quote is NEVER superseded: its session may still be
    -- payable and this code can no longer reach Stripe to find out. It
    -- has to drain or expire operationally.
    if v_candidate.stripe_checkout_session_id is not null
       or v_candidate.stripe_payment_intent_id is not null then
      return query
      select v_candidate.id, v_candidate.price_cents_at_checkout,
             v_candidate.discount_code_id, v_candidate.expires_at, 'blocked_legacy_attempt'::text;
      return;
    end if;

    select m.* into v_map
    from public.pok_book_checkout_orders m
    where m.intent_id = v_candidate.id
    for update;

    -- Local attempt classification, from the mapping row ALONE. No
    -- provider call, and no local timestamp is ever allowed to decide
    -- anything about an attempt whose order id was recorded.
    if v_map.intent_id is null then
      v_attempt := 'absent';
    elsif v_map.state = 'retired' then
      v_attempt := 'terminal';
    elsif v_map.provider_order_id is null
          and coalesce(v_map.provider_window_ends_at, v_map.created_at + interval '30 minutes')
              + interval '2 minutes' < now() then
      -- Id-less: no checkout URL was ever disclosed, so this attempt was
      -- never payable by anyone, and the window we ourselves requested
      -- has closed.
      v_attempt := 'never_payable';
    else
      v_attempt := 'possibly_live';
    end if;

    v_economics_match :=
      v_candidate.price_cents_at_checkout = v_price_cents
      and v_candidate.discount_code_id is not distinct from v_discount_code_id
      and v_candidate.regime is not distinct from p_regime
      and v_candidate.currency is not distinct from p_currency
      and v_candidate.royalty_rate_bps is not distinct from p_royalty_rate_bps;

    if v_candidate.expires_at <= now() then
      -- LOCAL expiry is not PROVIDER expiry. An attempt with a recorded
      -- order id needs an authenticated retrieval before it can be
      -- retired, whatever this intent's own clock says.
      if v_attempt = 'possibly_live' then
        return query
        select v_candidate.id, v_candidate.price_cents_at_checkout,
               v_candidate.discount_code_id, v_candidate.expires_at,
               'blocked_expired_attempt_unresolved'::text;
        return;
      end if;
      v_supersede_reason := case when v_attempt = 'never_payable'
                                 then 'provider_attempt_retired'
                                 else 'intent_expired' end;

    elsif v_economics_match then
      if v_attempt <> 'never_payable' then
        return query
        select v_candidate.id, v_candidate.price_cents_at_checkout,
               v_candidate.discount_code_id, v_candidate.expires_at, 'reused'::text;
        return;
      end if;
      v_supersede_reason := 'provider_attempt_retired';

    else
      if v_attempt = 'possibly_live' then
        return query
        select v_candidate.id, v_candidate.price_cents_at_checkout,
               v_candidate.discount_code_id, v_candidate.expires_at,
               'conflict_attempt_unresolved'::text;
        return;
      end if;
      v_supersede_reason := case when v_attempt = 'never_payable'
                                 then 'provider_attempt_retired'
                                 else 'quote_stale' end;
    end if;

    -- TEMPORARY DEFENCE ONLY, and framed honestly: a per-reader,
    -- per-book supersession cap. It is not abuse prevention and does
    -- nothing against a caller spreading inserts across many books or
    -- many accounts -- broader account-level and API rate limiting stays
    -- outside this repair. What it does bound is the one genuinely new
    -- vector this function opens: a direct caller alternating
    -- p_discount_code between null and a valid code flips the economic
    -- comparison on every call, and each flip would otherwise be an
    -- unbounded supersede-and-mint.
    --
    -- Counted AFTER the advisory lock, so concurrent calls for the same
    -- (reader, book) serialise and cannot both pass; that is also exactly
    -- why it is scoped per reader+book, since the advisory lock is
    -- (reader, book) and any broader counter could not be made race-free
    -- without a different locking scheme.
    --
    -- Checked before the FIRST mutation of this call, so the limited
    -- outcome leaves nothing changed. A TYPED status, never an exception:
    -- no caller should ever parse exception text.
    if not v_rate_checked then
      select count(*) into v_superseded_recently
      from public.book_checkout_intents i
      where i.reader_id = v_reader_id
        and i.book_id = create_book_checkout_intent.book_id
        and i.superseded_at is not null
        and i.superseded_at > now() - interval '1 hour';

      if v_superseded_recently >= 20 then
        return query
        select null::uuid, null::integer, null::uuid, null::timestamptz,
               'supersession_rate_limited'::text;
        return;
      end if;
      v_rate_checked := true;
    end if;

    -- The id-less elapsed mapping is retired in the SAME transaction as
    -- the supersede and the mint, under the same advisory lock, with both
    -- rows already locked. A creating/needs_reconciliation mapping can
    -- therefore never remain attached to a newly superseded intent.
    if v_attempt = 'never_payable' then
      update public.pok_book_checkout_orders m
         set state = 'retired',
             retired_at = now(),
             retired_reason = 'provider_window_elapsed_no_order_id'
       where m.intent_id = v_candidate.id
         and m.provider_order_id is null
         and m.state in ('creating', 'needs_reconciliation');
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then
        -- Every row was locked before the decision, so a zero-row CAS is
        -- an invariant violation, not a race. The raise IS the typed
        -- signal: it rolls the whole transaction back, so nothing partial
        -- survives.
        raise exception
          'create_book_checkout_intent: mapping changed under lock (intent %)', v_candidate.id;
      end if;
    end if;

    update public.book_checkout_intents i
       set superseded_at = now(),
           superseded_reason = v_supersede_reason
     where i.id = v_candidate.id;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception
        'create_book_checkout_intent: intent changed under lock (intent %)', v_candidate.id;
    end if;
  end loop;

  v_expires_at := now() + interval '23 hours';

  insert into public.book_checkout_intents (
    book_id, reader_id, book_title, price_cents_at_checkout, discount_code_id, expires_at,
    regime, currency, royalty_rate_bps
  ) values (
    create_book_checkout_intent.book_id, v_reader_id, v_book.title, v_price_cents, v_discount_code_id, v_expires_at,
    p_regime, p_currency, p_royalty_rate_bps
  )
  returning id into v_intent_id;

  return query
  select v_intent_id, v_price_cents, v_discount_code_id, v_expires_at, 'minted'::text;
end;
$$;

revoke all on function public.create_book_checkout_intent(uuid, text, text, text, integer, boolean, uuid) from public;
revoke all on function public.create_book_checkout_intent(uuid, text, text, text, integer, boolean, uuid) from anon;
revoke all on function public.create_book_checkout_intent(uuid, text, text, text, integer, boolean, uuid) from authenticated;
grant execute on function public.create_book_checkout_intent(uuid, text, text, text, integer, boolean, uuid) to authenticated;


-- ============================================================
-- Part 7: retire_book_checkout_attempt.
--
-- ONE atomic retirement. The mapping moves to 'retired' and the intent is
-- superseded in the SAME transaction, under the same advisory lock, or
-- neither happens. A two-step retire-then-supersede would have opened a
-- window in which a dead attempt sat on a live quote.
--
-- service_role only. The classification that authorises retirement
-- requires a provider round trip the database cannot make, so the
-- application -- running as service_role -- is trusted for exactly that
-- one judgement, and SQL independently enforces everything SQL can know:
-- terminal state, Stripe-drain, the identity CAS, reason coherence, lock
-- order.
--
-- It REQUIRES a mapping row. Writing 'provider_attempt_retired' onto an
-- intent that never had a provider attempt would be a false record, so
-- p_expected_claim_id must be non-null and a missing mapping is
-- mapping_changed.
--
-- The only outcome that permits a replacement is retired_and_superseded.
-- ============================================================

create or replace function public.retire_book_checkout_attempt(
  p_intent_id uuid,
  p_expected_claim_id uuid,
  p_expected_provider_order_id text,
  p_expected_state text,
  p_retired_reason text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent record;
  v_map record;
  v_pre_book_id uuid;
  v_pre_reader_id uuid;
  v_rows integer;
begin
  -- The MAPPING's vocabulary, never the intent's. Passing an intent-side
  -- reason here is a caller error, reported as a typed outcome.
  if p_retired_reason is null or p_retired_reason not in
     ('provider_attempt_expired', 'provider_attempt_canceled', 'provider_window_elapsed_no_order_id') then
    return 'invalid_retired_reason';
  end if;

  if p_intent_id is null or p_expected_claim_id is null then
    return 'mapping_changed';
  end if;

  select book_id, reader_id
    into v_pre_book_id, v_pre_reader_id
    from public.book_checkout_intents
    where id = p_intent_id;

  if v_pre_book_id is not null and v_pre_reader_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(v_pre_reader_id::text),
      pg_catalog.hashtext(v_pre_book_id::text)
    );
  end if;

  select i.* into v_intent
  from public.book_checkout_intents i
  where i.id = p_intent_id
  for update;

  if v_intent.id is null then
    return 'not_found';
  end if;

  -- Identity revalidation under the row lock. See Part 5's header.
  if (v_intent.reader_id is distinct from v_pre_reader_id
      and not (v_pre_reader_id is not null and v_intent.reader_id is null))
     or (v_intent.book_id is distinct from v_pre_book_id
         and not (v_pre_book_id is not null and v_intent.book_id is null)) then
    raise exception
      'book_checkout_intents: reader/book identity changed under lock (intent %)', p_intent_id;
  end if;

  if v_intent.reader_id is null or v_intent.book_id is null then
    return 'reader_or_book_deleted';
  end if;

  -- Terminal and drain checks BEFORE any mutation, so every rejection
  -- leaves both rows exactly as they were.
  if v_intent.fulfilled_at is not null then
    return 'already_fulfilled';
  end if;
  if v_intent.completed_at is not null then
    return 'already_completed';
  end if;
  if v_intent.superseded_at is not null
     or v_intent.stripe_checkout_session_id is not null
     or v_intent.stripe_payment_intent_id is not null then
    return 'not_retireable';
  end if;

  select m.* into v_map
  from public.pok_book_checkout_orders m
  where m.intent_id = p_intent_id
  for update;

  if v_map.intent_id is null then
    return 'mapping_changed';
  end if;

  -- `is not distinct from`, never `=`. provider_order_id is the nullable
  -- one that matters: with ordinary equality an expected-null comparison
  -- evaluates to UNKNOWN, so a correctly-identified id-less attempt would
  -- be reported as mapping_changed, or an UNKNOWN would fall through a
  -- negated test.
  if not (v_map.creation_claim_id is not distinct from p_expected_claim_id
          and v_map.provider_order_id is not distinct from p_expected_provider_order_id
          and v_map.state is not distinct from p_expected_state) then
    return 'mapping_changed';
  end if;

  -- The reason must match the evidence. A local-window reason may only
  -- retire an attempt that has no recorded order id; a provider-reported
  -- reason may only retire one that does.
  if (p_retired_reason = 'provider_window_elapsed_no_order_id' and v_map.provider_order_id is not null)
     or (p_retired_reason in ('provider_attempt_expired', 'provider_attempt_canceled')
         and v_map.provider_order_id is null) then
    return 'reason_not_coherent';
  end if;

  update public.pok_book_checkout_orders m
     set state = 'retired',
         retired_at = now(),
         retired_reason = p_retired_reason
   where m.intent_id = p_intent_id
     and m.creation_claim_id is not distinct from p_expected_claim_id
     and m.provider_order_id is not distinct from p_expected_provider_order_id
     and m.state is not distinct from p_expected_state;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception
      'retire_book_checkout_attempt: mapping changed under lock (intent %)', p_intent_id;
  end if;

  -- The intent ALWAYS receives 'provider_attempt_retired'. The two
  -- columns never share a reason value.
  update public.book_checkout_intents i
     set superseded_at = now(),
         superseded_reason = 'provider_attempt_retired'
   where i.id = p_intent_id;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception
      'retire_book_checkout_attempt: intent changed under lock (intent %)', p_intent_id;
  end if;

  return 'retired_and_superseded';
end;
$$;

revoke all on function public.retire_book_checkout_attempt(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.retire_book_checkout_attempt(uuid, uuid, text, text, text)
  to service_role;


-- ============================================================
-- Part 8: claim_pok_book_checkout_order.
--
-- Replaces the application's generic JavaScript interpretation of SQLSTATE
-- 23505, which read ANY unique violation -- including a webhook_token or
-- merchant_custom_reference collision -- as "already claimed". Only the
-- primary key is a legitimate "already claimed"; the ON CONFLICT target
-- below names it explicitly, so any other unique violation propagates as
-- a real exception.
--
-- SQL also CALCULATES and RETURNS the granted window rather than
-- validating a supplied one. That is stronger than a check: "not in the
-- future" and "later than the intent expiry" become structurally
-- impossible instead of merely rejected, and one clock -- Postgres --
-- governs both the stored window and the number POK is asked for.
--
-- service_role only.
-- ============================================================

create or replace function public.claim_pok_book_checkout_order(
  p_intent_id uuid,
  p_reference text,
  p_webhook_token uuid,
  p_claim_id uuid,
  p_requested_window_minutes integer
)
returns table (
  outcome text,
  provider_window_ends_at timestamptz,
  granted_window_minutes integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent record;
  v_pre_book_id uuid;
  v_pre_reader_id uuid;
  v_minutes integer;
  v_ends timestamptz;
  v_claimed uuid;
  v_existing record;
begin
  if p_intent_id is null then
    return query select 'intent_not_found'::text, null::timestamptz, null::integer;
    return;
  end if;

  select book_id, reader_id
    into v_pre_book_id, v_pre_reader_id
    from public.book_checkout_intents
    where id = p_intent_id;

  if v_pre_book_id is not null and v_pre_reader_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(v_pre_reader_id::text),
      pg_catalog.hashtext(v_pre_book_id::text)
    );
  end if;

  select i.* into v_intent
  from public.book_checkout_intents i
  where i.id = p_intent_id
  for update;

  if v_intent.id is null then
    return query select 'intent_not_found'::text, null::timestamptz, null::integer;
    return;
  end if;

  -- Identity revalidation under the row lock. See Part 5's header.
  if (v_intent.reader_id is distinct from v_pre_reader_id
      and not (v_pre_reader_id is not null and v_intent.reader_id is null))
     or (v_intent.book_id is distinct from v_pre_book_id
         and not (v_pre_book_id is not null and v_intent.book_id is null)) then
    raise exception
      'book_checkout_intents: reader/book identity changed under lock (intent %)', p_intent_id;
  end if;

  -- A deleted reader or book makes the row permanently unclaimable: the
  -- reuse query filters on both columns, neither of which can match null.
  if v_intent.reader_id is null or v_intent.book_id is null then
    return query select 'intent_not_claimable'::text, null::timestamptz, null::integer;
    return;
  end if;

  if v_intent.superseded_at is not null
     or v_intent.completed_at is not null
     or v_intent.fulfilled_at is not null then
    return query select 'intent_not_claimable'::text, null::timestamptz, null::integer;
    return;
  end if;

  if v_intent.stripe_checkout_session_id is not null
     or v_intent.stripe_payment_intent_id is not null then
    return query select 'intent_stripe_bound'::text, null::timestamptz, null::integer;
    return;
  end if;

  -- Mirrors the application's own validateIntent, as defence in depth --
  -- a POK order may only ever be claimed for a ledger_v1/ALL/positive
  -- quote, whatever a caller believes.
  if v_intent.regime <> 'librum_ledger_v1'
     or v_intent.currency <> 'ALL'
     or v_intent.price_cents_at_checkout is null
     or v_intent.price_cents_at_checkout <= 0 then
    return query select 'intent_not_claimable'::text, null::timestamptz, null::integer;
    return;
  end if;

  if v_intent.expires_at <= now() then
    return query select 'intent_expired'::text, null::timestamptz, null::integer;
    return;
  end if;

  if p_reference is distinct from ('book:' || p_intent_id::text) then
    return query select 'reference_mismatch'::text, null::timestamptz, null::integer;
    return;
  end if;

  -- The window, computed here and bounded by the intent's own expiry.
  v_minutes := least(greatest(coalesce(p_requested_window_minutes, 0), 1), 30);
  v_ends := now() + (v_minutes * interval '1 minute');
  if v_ends > v_intent.expires_at then
    v_minutes := floor(extract(epoch from (v_intent.expires_at - now())) / 60)::integer;
    if v_minutes < 1 then
      return query select 'intent_expired'::text, null::timestamptz, null::integer;
      return;
    end if;
    v_ends := now() + (v_minutes * interval '1 minute');
  end if;

  insert into public.pok_book_checkout_orders as m
    (intent_id, merchant_custom_reference, webhook_token, creation_claim_id,
     state, provider_window_ends_at)
  values (p_intent_id, p_reference, p_webhook_token, p_claim_id, 'creating', v_ends)
  on conflict on constraint pok_book_checkout_orders_pkey do nothing
  returning m.intent_id into v_claimed;

  if v_claimed is null then
    select m.provider_window_ends_at into v_existing
    from public.pok_book_checkout_orders m
    where m.intent_id = p_intent_id;
    return query select 'already_claimed'::text, v_existing.provider_window_ends_at, null::integer;
    return;
  end if;

  return query select 'claimed'::text, v_ends, v_minutes;
end;
$$;

revoke all on function public.claim_pok_book_checkout_order(uuid, text, uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_pok_book_checkout_order(uuid, text, uuid, uuid, integer)
  to service_role;


-- ============================================================
-- Part 9: get_book_checkout_quote.
--
-- The book page needs to render a conflict notice showing the FROZEN
-- amount of a specific open quote, and book_checkout_intents is revoked
-- from `authenticated`, so a narrow definer read is required.
--
-- It takes an EXACT intent id AND an exact book id. An earlier design
-- took only the book id and would have been free to select a different
-- row than the one the reader was actually shown.
--
-- The id in the URL is a SELECTOR, never authorization: this function
-- enforces auth.uid(), intent ownership and book identity itself. A
-- foreign or mismatched id returns ZERO ROWS, indistinguishable from "no
-- such intent", so it leaks nothing -- not even existence.
-- ============================================================

create or replace function public.get_book_checkout_quote(
  p_intent_id uuid,
  p_book_id uuid
)
returns table (
  intent_id uuid,
  price_cents_at_checkout integer,
  currency text,
  discount_code_id uuid,
  expires_at timestamptz,
  provider_window_ends_at timestamptz,
  quote_state text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reader_id uuid;
begin
  v_reader_id := auth.uid();
  if v_reader_id is null then
    raise exception 'not authenticated';
  end if;

  return query
  select i.id,
         i.price_cents_at_checkout,
         i.currency,
         i.discount_code_id,
         i.expires_at,
         m.provider_window_ends_at,
         case
           when i.fulfilled_at is not null then 'fulfilled'
           when i.completed_at is not null then 'completed'
           when i.superseded_at is not null then 'superseded'
           when i.expires_at <= now() then 'expired'
           when m.intent_id is not null and m.state <> 'retired' then 'unresolved_conflict'
           else 'not_conflicting'
         end::text
  from public.book_checkout_intents i
  left join public.pok_book_checkout_orders m on m.intent_id = i.id
  where i.id = p_intent_id
    and i.book_id = p_book_id
    and i.reader_id = v_reader_id;
end;
$$;

revoke all on function public.get_book_checkout_quote(uuid, uuid) from public;
revoke all on function public.get_book_checkout_quote(uuid, uuid) from anon;
revoke all on function public.get_book_checkout_quote(uuid, uuid) from authenticated;
grant execute on function public.get_book_checkout_quote(uuid, uuid) to authenticated;
