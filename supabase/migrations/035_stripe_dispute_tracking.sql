-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. LAUNCH-1 P1-7A: closes the P0 finding from the P1-7 audit --
-- Librum had no code path reacting to a Stripe dispute/chargeback at
-- all (charge.dispute.created/.updated/.closed/.funds_withdrawn/
-- .funds_reinstated were entirely unhandled), so a reader who disputed
-- a charge with their bank kept full entitlement forever with zero
-- Librum-side detection. See the P1-7A design audit for the full
-- reasoning behind every decision below -- summarized here only where
-- needed to explain what this migration actually does.
--
-- Approved entitlement policy: access remains active for every dispute
-- status except a status of EXACTLY 'lost' -- open, under review,
-- warning/inquiry, won, 'prevented', and any future/unknown status all
-- leave entitlement untouched. A normal confirmed refund continues to
-- revoke entitlement independently through the existing refunded_at
-- mechanism, completely unchanged by anything in this migration.
--
-- PRE-PRODUCTION CORRECTION (this migration has never been applied to
-- production, so it is amended in place rather than followed by a
-- migration 036): the first draft of this migration introduced exactly
-- the "two definitions of active ownership" bug it was meant to avoid.
-- user_owns_book() correctly stopped counting a lost-disputed purchase
-- as owned, but every OTHER path that independently re-derives
-- ownership from raw purchases columns -- create_book_checkout_intent's
-- own "already owns this book" guard, finalize_book_checkout_intent's
-- "active_other_session" classification, and create_bundle_checkout_
-- snapshot's "already owns every book in this bundle" guard -- still
-- keyed off `refunded_at is null` alone, which stays true forever for a
-- disputed-but-never-refunded purchase. Traced in full below; every one
-- of those paths is corrected in this same migration, either by
-- reusing user_owns_book() directly (everywhere it is invoked in a
-- request-scoped, auth.uid()-meaningful context) or, where auth.uid()
-- is not the right identity (finalize_book_checkout_intent runs as the
-- service-role webhook acting on an EXPLICIT reader_id from the intent
-- row, not on its own calling identity), via a new, small, explicitly-
-- parameterized helper, payment_intent_has_lost_dispute(), which is
-- itself the one place the "is this exact payment intent's dispute
-- lost" fragment is now defined -- user_owns_book() calls it too,
-- rather than duplicating the fragment inline in two places.
--
-- If you're setting up a fresh project, just run schema.sql instead --
-- it already includes all of this.

-- ============================================================
-- payment_disputes: the SOLE authoritative record of Stripe dispute
-- state. Deliberately NOT also denormalized onto purchases or
-- bundle_checkout_snapshots -- stress-tested during the P1-7A design
-- phase against that alternative (Option B) and rejected: a
-- second copy of this state creates a real divergence-prevention
-- burden with no offsetting benefit, since an indexed lookup against
-- this table (see payment_intent_has_lost_dispute() below) costs the
-- same order of magnitude as the EXISTS subquery user_owns_book()
-- already runs against purchases today. One dispute event -> one
-- upsert into this one table -> done; nothing else to keep in sync.
--
-- status/reason are stored verbatim, with NO check constraint: the
-- installed stripe@22.5.0 SDK types both as open string unions
-- (Dispute.status includes `| OtherString`, confirmed directly in
-- node_modules/stripe/cjs/resources/Disputes.d.ts) since Stripe can
-- introduce new values -- constraining this column would risk
-- rejecting a legitimate future Stripe status outright. The
-- application layer (processDisputeEvent, src/app/api/webhooks/stripe/
-- route.ts) logs loudly when it sees a status outside the currently
-- documented set, but never refuses to store it, and never treats
-- anything other than the literal string 'lost' as revoking
-- entitlement -- see payment_intent_has_lost_dispute() below, whose
-- equality check is what actually makes an unrecognized value safe by
-- construction, not any allowlist maintained here or in application
-- code.
-- ============================================================

create table public.payment_disputes (
  id uuid primary key default gen_random_uuid(),
  stripe_dispute_id text unique not null,
  stripe_payment_intent_id text not null,
  status text not null,
  reason text not null,
  amount_cents integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index payment_disputes_payment_intent_idx
  on public.payment_disputes(stripe_payment_intent_id);

alter table public.payment_disputes enable row level security;

-- Zero policies for any command, same posture as bundle_checkout_
-- reservations/bundle_checkout_reader_holds -- doubly closed alongside
-- the explicit revoke below. Only service_role (the webhook) and the
-- SECURITY DEFINER functions that read it below (all of which bypass
-- RLS as the function owner) ever touch this table.
revoke all on public.payment_disputes from public, anon, authenticated;

-- ============================================================
-- payment_intent_has_lost_dispute(): the ONE place "does this exact
-- Stripe payment intent have a dispute at status 'lost'" is defined.
-- Explicitly parameterized (not auth.uid()-based) because it is called
-- from contexts where the relevant identity is NOT the calling
-- session's own -- most notably finalize_book_checkout_intent below,
-- which runs as the service-role webhook acting on an explicit
-- reader_id read from the intent row, where auth.uid() would not
-- reflect that reader at all. user_owns_book() below also calls this,
-- rather than duplicating the same fragment inline -- one canonical
-- predicate, reused everywhere the "is this payment intent's dispute
-- lost" fact is needed, whether or not auth.uid() happens to be
-- meaningful in the caller's context.
-- ============================================================
create or replace function public.payment_intent_has_lost_dispute(
  target_payment_intent_id text
)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.payment_disputes d
    where d.stripe_payment_intent_id = target_payment_intent_id
      and d.status = 'lost'
  );
$$;

-- EXECUTE restricted to authenticated -- called both directly (nowhere,
-- currently) and transitively via user_owns_book() (already granted to
-- authenticated) and the two SECURITY DEFINER RPCs below, both of which
-- already have their own grants. Explicit anyway, for a reader of this
-- file alone to see the complete privilege model.
revoke all on function public.payment_intent_has_lost_dispute(text) from public;
revoke all on function public.payment_intent_has_lost_dispute(text) from anon;
revoke all on function public.payment_intent_has_lost_dispute(text) from authenticated;
grant execute on function public.payment_intent_has_lost_dispute(text) to authenticated;

-- ============================================================
-- user_owns_book(): extended with the dispute-lost predicate, via
-- payment_intent_has_lost_dispute() above. Every other entitlement/
-- ownership call site in the application (the manuscript download
-- route, submitReview, the book detail page's "owned" display state,
-- buyBook's and getFreeBook's "already own it" repurchase guards, and
-- buyBundle's/the bundle page's per-book ownership checks) is switched,
-- in this same phase, to call this RPC instead of duplicating the raw
-- purchases query -- payment_disputes is fully closed to anon/
-- authenticated above, so a request-scoped client cannot read it
-- directly; routing every check through this one SECURITY DEFINER
-- function avoids granting any new table-level privilege and
-- consolidates what used to be several separately-duplicated ownership
-- queries into one canonical predicate.
--
-- The payment_intent_has_lost_dispute() call correctly no-ops for a
-- free acquisition (purchases.stripe_payment_intent_id is null for
-- those -- see getFreeBook -- and null can never equal a dispute's
-- real payment_intent_id, so the lookup matches nothing and ownership
-- is unaffected, exactly as it should be: a free book was never
-- charged and can never be disputed).
-- ============================================================
create or replace function public.user_owns_book(target_book_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.purchases
    where purchases.book_id = target_book_id
      and purchases.reader_id = auth.uid()
      and purchases.refunded_at is null
      and not public.payment_intent_has_lost_dispute(purchases.stripe_payment_intent_id)
  );
$$;

-- ============================================================
-- create_book_checkout_intent(): closes the FIRST gap the pre-
-- production audit found. This function's own "reader already owns
-- this book" guard (which blocks minting a fresh checkout intent at
-- all) previously tested `refunded_at is null` directly, completely
-- independent of user_owns_book() above -- a lost-disputed reader was
-- therefore still refused a repurchase attempt at this, the earliest
-- possible point, even after user_owns_book() itself was fixed to say
-- they don't currently own the book. Reuses user_owns_book() directly
-- (not the lower-level helper): this function runs in a request-
-- scoped, auth.uid()-meaningful context (invoked via buyBook's own
-- authenticated Supabase client), the exact same identity
-- user_owns_book() itself resolves internally, so calling it here is
-- both correct and the smallest possible fix -- no new parameter, no
-- duplicated predicate.
-- ============================================================
create or replace function public.create_book_checkout_intent(
  book_id uuid,
  p_discount_code text default null
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

  -- LAUNCH-1 P1-7A correction: was `if exists (select 1 from purchases
  -- where ... and refunded_at is null)`. That is exactly the "second
  -- definition of active ownership" this correction exists to remove --
  -- replaced with the same canonical predicate everything else uses.
  -- A reader whose only purchase of this book is disputed-and-lost may
  -- now legitimately start a fresh checkout; a reader with an open,
  -- won, warning/inquiry, 'prevented', or unrecognized-status dispute
  -- (user_owns_book() still returns true for all of those) is still
  -- correctly refused, exactly as before.
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

  insert into public.book_checkout_intents (
    book_id, reader_id, book_title, price_cents_at_checkout, discount_code_id, expires_at
  ) values (
    create_book_checkout_intent.book_id, v_reader_id, v_book.title, v_price_cents, v_discount_code_id, v_expires_at
  )
  returning id into v_intent_id;

  return query
  select v_intent_id, v_price_cents, v_discount_code_id, v_expires_at;
end;
$$;

revoke all on function public.create_book_checkout_intent(uuid, text) from public;
revoke all on function public.create_book_checkout_intent(uuid, text) from anon;
revoke all on function public.create_book_checkout_intent(uuid, text) from authenticated;
grant execute on function public.create_book_checkout_intent(uuid, text) to authenticated;

-- ============================================================
-- book_checkout_intents.reconciliation_reason: widened to allow a
-- third value, 'disputed_lost', written by finalize_book_checkout_
-- intent() below when a dispute already reached 'lost' for this exact
-- payment intent before this delivery could grant entitlement --
-- mirrors 'active_other_session'/'book_or_reader_deleted' exactly.
-- ============================================================
alter table public.book_checkout_intents
  drop constraint book_checkout_intents_reconciliation_reason_check;

alter table public.book_checkout_intents
  add constraint book_checkout_intents_reconciliation_reason_check
  check (reconciliation_reason is null or reconciliation_reason in (
    'active_other_session', 'book_or_reader_deleted', 'disputed_lost'
  ));

-- ============================================================
-- finalize_book_checkout_intent(): TWO corrections in this function,
-- both from the same pre-production audit.
--
-- 1. The dispute-before-fulfillment guarantee (unchanged in effect from
--    the first draft of this migration, now expressed via
--    payment_intent_has_lost_dispute() instead of an inline EXISTS,
--    for consistency with every other call site). Placed AFTER the
--    existing already_finalized short-circuit (an already-granted
--    purchase is never retroactively unwound here -- revocation for an
--    already-fulfilled purchase happens only via user_owns_book()'s own
--    read-time check, never by rewriting fulfillment history) and
--    AFTER the financial-authority amount check, but BEFORE the book/
--    reader-deleted check.
--
-- 2. THE SECOND, MORE SERIOUS GAP THE AUDIT FOUND: the existing
--    "active_other_session" classification below -- which exists to
--    detect "a DIFFERENT, still-valid transaction already owns this
--    (book, reader) pair, so this delivery must not touch it" --
--    tested only `stripe_checkout_session_id is not null and
--    refunded_at is null`. A lost-disputed purchase satisfies that
--    condition exactly as well as a genuinely active one does (a
--    dispute never sets refunded_at). Left uncorrected, a reader who
--    legitimately repurchases a book after a lost dispute would reach
--    THIS function with a brand-new intent and a brand-new payment
--    intent (see the idempotency argument below), pass the dispute-
--    before-fulfillment guard above (that guard checks the NEW payment
--    intent, which has no dispute), and then be wrongly classified
--    active_other_session against their OWN old, disputed-and-lost row
--    -- paying a second time while ending up owning nothing, the exact
--    "charged without entitlement" failure class this whole dispute-
--    tracking effort exists to prevent. Fixed by adding the same
--    payment_intent_has_lost_dispute() check (against v_existing's OWN
--    payment intent, now also selected) to the active_other_session
--    condition: an existing row is only "active" if it is NEITHER
--    refunded NOR disputed-lost.
--
-- Runs inside this function's own existing row-locked transaction (the
-- `for update` taken at the very top, unchanged) -- no new lock is
-- needed for either correction: the intent row lock already fully
-- serializes every call for this exact intent_id, and both checks read
-- an unrelated table (payment_disputes), not one this function itself
-- writes concurrently with anything else.
--
-- Idempotency-collision check (explicitly verified, not assumed): a
-- repurchase after a lost dispute always reaches this function via a
-- BRAND-NEW book_checkout_intents row. create_book_checkout_intent's
-- own reuse query above only reuses an intent with `fulfilled_at is
-- null` -- the OLD intent that led to the now-disputed purchase is
-- already fulfilled_at IS NOT NULL (that is how the purchase came to
-- exist at all; a dispute only ever follows a successfully completed
-- charge, never replaces one), so it can never be matched by that
-- reuse query. A fresh intent means a fresh gen_random_uuid() intent_id,
-- which means buyBook's deterministic idempotency key
-- (`book-checkout:${intent.intent_id}`) is necessarily different from
-- the original checkout's -- there is no collision to guard against
-- here at all, structurally, not merely by convention. Verified
-- directly by the SQL regression suite (Part 7) rather than left as an
-- assumption.
-- ============================================================
create or replace function public.finalize_book_checkout_intent(
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
begin
  select id, book_id, reader_id, discount_code_id, price_cents_at_checkout,
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

  -- Dispute-before-fulfillment guarantee (see comment block above).
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

  select p.stripe_checkout_session_id, p.stripe_payment_intent_id, p.refunded_at
  into v_existing
  from public.purchases p
  where p.book_id = v_intent.book_id
    and p.reader_id = v_intent.reader_id;

  -- LAUNCH-1 P1-7A correction: added `and not payment_intent_has_lost_
  -- dispute(v_existing.stripe_payment_intent_id)` -- see the audit
  -- comment above this function for the full failure this closes. An
  -- existing row whose OWN payment intent is disputed-lost is no
  -- longer treated as "active" here; execution falls through to the
  -- eligible/upsert path below exactly as it already does for a
  -- refunded row.
  if v_existing.stripe_checkout_session_id is not null
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
    amount_cents, discount_code_id, refunded_at
  ) values (
    v_intent.book_id, v_intent.reader_id, p_stripe_checkout_session_id, p_stripe_payment_intent_id,
    v_intent.price_cents_at_checkout, v_intent.discount_code_id, null
  )
  on conflict (book_id, reader_id) do update set
    stripe_checkout_session_id = excluded.stripe_checkout_session_id,
    stripe_payment_intent_id = excluded.stripe_payment_intent_id,
    amount_cents = excluded.amount_cents,
    discount_code_id = excluded.discount_code_id,
    refunded_at = null;

  update public.book_checkout_intents
  set stripe_payment_intent_id = p_stripe_payment_intent_id,
      completed_at = now(),
      fulfilled_at = now()
  where id = p_intent_id;

  return query select 'eligible_fulfilled'::text, v_intent.book_id, v_intent.reader_id;
end;
$$;

-- Grants unchanged from migration 032 -- CREATE OR REPLACE FUNCTION
-- does not reset a function's existing ACL, but restated here anyway
-- for a reader of this file alone to see the complete, correct
-- privilege model without having to cross-reference migration 032.
revoke all on function public.finalize_book_checkout_intent(uuid, text, text, integer) from public;
revoke all on function public.finalize_book_checkout_intent(uuid, text, text, integer) from anon;
revoke all on function public.finalize_book_checkout_intent(uuid, text, text, integer) from authenticated;
grant execute on function public.finalize_book_checkout_intent(uuid, text, text, integer) to service_role;

-- ============================================================
-- create_bundle_checkout_snapshot(): closes the THIRD gap the
-- pre-production audit found -- this function's own "reader already
-- owns every book in this bundle" pre-check (which blocks starting a
-- new bundle checkout at all when nothing in it would be a new
-- acquisition) previously tested `refunded_at is null` directly for
-- each item, independent of user_owns_book(). Replaced with
-- user_owns_book() per item -- this function runs in a request-scoped,
-- auth.uid()-meaningful context (invoked via buyBundle's own
-- authenticated Supabase client, the same identity already resolved
-- into v_reader_id at the top of this function), so reusing
-- user_owns_book() here is both correct and the smallest possible fix.
--
-- No new lock or transaction-boundary change: this check already ran,
-- unlocked-in-any-NEW way, at this exact point in this function's own
-- pre-existing advisory-lock-protected transaction (the lock is taken
-- above, before v_items is even built) -- swapping the inline EXISTS
-- for a call to user_owns_book() is the same read, in the same place,
-- inside the same already-serialized transaction; it introduces no new
-- concurrency exposure to the bundle reservation/hold mechanism.
-- ============================================================
create or replace function public.create_bundle_checkout_snapshot(
  bundle_id uuid
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

  -- LAUNCH-1 P1-7A correction: was an inline `exists (select 1 from
  -- purchases where ... and refunded_at is null)` per item -- replaced
  -- with public.user_owns_book(), the same canonical predicate every
  -- other ownership check in this schema now uses. A reader whose only
  -- purchase of a book in this bundle is disputed-and-lost is correctly
  -- treated as NOT owning it -- the bundle checkout proceeds instead of
  -- being wrongly refused with "already owns every book."
  if not exists (
    select 1
    from jsonb_array_elements(v_items) as item
    where not public.user_owns_book((item->>'book_id')::uuid)
  ) then
    raise exception 'reader already owns every book in this bundle';
  end if;

  v_protection_expires_at := now() + interval '23 hours';

  insert into public.bundle_checkout_snapshots (
    bundle_id,
    bundle_title,
    author_id,
    reader_id,
    bundle_price_cents_at_checkout,
    items,
    protection_expires_at
  )
  values (
    v_bundle.id,
    v_bundle.title,
    v_bundle.author_id,
    v_reader_id,
    v_bundle.price_cents,
    v_items,
    v_protection_expires_at
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

revoke all on function public.create_bundle_checkout_snapshot(uuid) from public;
revoke all on function public.create_bundle_checkout_snapshot(uuid) from anon;
revoke all on function public.create_bundle_checkout_snapshot(uuid) from authenticated;
grant execute on function public.create_bundle_checkout_snapshot(uuid) to authenticated;
