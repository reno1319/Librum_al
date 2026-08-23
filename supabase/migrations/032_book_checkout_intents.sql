-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. LAUNCH-1 P1-4: single-book checkout race hardening.
--
-- Problem this closes: buyBook's pre-checkout ownership read was a
-- plain, unlocked SELECT, and stripe.checkout.sessions.create() carried
-- no idempotency key -- two concurrent invocations (double-click, two
-- tabs, a retry) could each pass the read and each reach Stripe, each
-- creating its own real, payable Checkout Session. If both were ever
-- completed, the webhook's old single-book branch ran an unconditional
-- upsert with no read-before-write, so whichever delivery landed last
-- silently overwrote the other's stripe_checkout_session_id /
-- stripe_payment_intent_id / amount_cents on purchases' one
-- unique(book_id, reader_id) row -- the losing PaymentIntent became
-- permanently orphaned from purchases: invisible to
-- groupPurchasesByTransaction (groups by
-- purchases.stripe_payment_intent_id -- see
-- src/app/library/refund-logic.ts) and unrefundable via request_refund()
-- (migration 029, which looks purchases up by that same column).
--
-- Full option-comparison audit (Stripe idempotency-key design space,
-- Stripe Checkout Session search/list/reopen capabilities, and the final
-- table/RPC/webhook design with its concurrency stress-test) happened
-- across several review rounds before this file was written; only the
-- choices actually made are re-justified here.
--
-- Why Stripe idempotency keys alone are insufficient: a key needs to be
-- deterministic AND derived from something that already, uniquely, and
-- safely identifies "this one attempt" -- but nothing in Librum's own
-- state does that without first minting it somewhere durable. A
-- permanent (reader,book) key would block a legitimate repurchase after
-- refund, potentially indefinitely (Stripe's idempotency cache is
-- retained "at least 24 hours" with no documented upper bound). A
-- calendar-bucketed key (e.g. UTC date) fails outright: two requests
-- milliseconds apart on opposite sides of any fixed boundary get
-- different keys and each reach Stripe independently -- proven, not
-- assumed, in the design review that preceded this migration. The only
-- value that is both stable across concurrent duplicate requests AND
-- changes exactly when it should (a genuinely new attempt after expiry,
-- or after a refund) is one minted once, in the database, under a lock
-- -- exactly what create_book_checkout_intent below does, following the
-- same pattern already proven for bundles in migrations 025/026
-- (create_bundle_checkout_snapshot's own advisory-lock get-or-create).
-- This is a scaled-down reuse of that *pattern*, not its complexity --
-- no reservation/hold tables, since those solve a different problem
-- (blocking book/reader deletion mid-checkout) that single-book
-- purchases have never had protection against and that is out of scope
-- here.
--
-- Stripe Checkout Sessions cannot be reliably searched by any
-- server-controlled identifier at all (confirmed against the installed
-- stripe@22.5.0 SDK types, node_modules/stripe/cjs/resources/Checkout/
-- Sessions.d.ts: SessionListParams supports only created / customer /
-- customer_account / customer_details.email / payment_intent /
-- payment_link / status / subscription -- no client_reference_id, no
-- metadata filter -- and Librum's checkout never attaches a Stripe
-- Customer). Even if it could, list-then-create is an inherent
-- time-of-check/time-of-use race with no atomic get-or-create primitive
-- on Stripe's side. The database is therefore the only place this
-- invariant can actually live.

-- ============================================================
-- book_checkout_intents: one durable row per single-book checkout
-- attempt. Doubles as this table's own reconciliation/audit record (per
-- explicit product direction) rather than a separate table -- see the
-- completed_at / fulfilled_at / reconciliation_reason state model below.
--
-- book_id/reader_id use ON DELETE SET NULL, not CASCADE and not
-- RESTRICT. Once an intent can represent a Stripe transaction that was
-- genuinely paid but deliberately not fulfilled into purchases (see
-- reconciliation_reason below), this row IS financial audit evidence,
-- and deleting the book or the reader's profile later must not erase
-- it -- exactly the same reasoning bundle_checkout_snapshots already
-- applies to its own author_id/reader_id/bundle_id columns. RESTRICT
-- would be wrong here for a different reason: unlike
-- bundle_checkout_reservations (which self-clears via trigger the
-- moment a row stops being active), rows in this table are meant to
-- persist indefinitely as history -- RESTRICT would permanently block
-- deleting a book or profile the instant it ever had a single checkout
-- attempt, including one from months ago. book_title is denormalized
-- (mirroring bundle_checkout_snapshots.bundle_title) specifically so a
-- reconciliation row stays meaningful after book_id goes null.
create table public.book_checkout_intents (
  id uuid primary key default gen_random_uuid(),
  book_id uuid references public.books(id) on delete set null,
  reader_id uuid references public.profiles(id) on delete set null,
  book_title text not null,
  price_cents_at_checkout integer not null,
  discount_code_id uuid references public.discount_codes(id) on delete set null,
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text unique,
  expires_at timestamptz not null,
  completed_at timestamptz,
  fulfilled_at timestamptz,
  reconciliation_reason text,
  created_at timestamptz not null default now(),

  check (expires_at > created_at),

  -- A fulfilled intent must have settled (completed) first -- "fulfilled
  -- without completed" is not a state that can ever legitimately exist.
  check (fulfilled_at is null or completed_at is not null),

  -- The full state model, as a single biconditional rather than two
  -- one-directional checks: reconciliation_reason is set if AND ONLY IF
  -- this intent is completed but not fulfilled. Combined with the check
  -- above, every (completed_at, fulfilled_at, reconciliation_reason)
  -- combination is pinned to exactly one of 3 valid states:
  --   (null,     null,     null)      -- created, no session yet, OR
  --                                      session open but not yet paid
  --   (not null, not null, null)      -- paid and fulfilled
  --   (not null, null,     not null)  -- paid but fulfillment blocked;
  --                                      reason always present
  -- (not null, not null) is impossible by the first check above.
  -- (null, *, not null) is impossible by this one: reconciliation_reason
  -- requires completed_at to be set.
  check ((reconciliation_reason is not null) = (completed_at is not null and fulfilled_at is null)),

  check (reconciliation_reason is null or reconciliation_reason in ('active_other_session', 'book_or_reader_deleted'))
);

alter table public.book_checkout_intents enable row level security;

-- Zero policies for anon/authenticated, matching bundle_checkout_snapshots
-- exactly -- nothing in the product surfaces "my pending checkout" to a
-- reader anywhere. RLS default-denies with no matching policy regardless,
-- but the revoke below is still explicit, not left to that default --
-- this is precisely the lesson the discount_codes production gap (found
-- and fixed in migration 031) already taught: RLS restricts which ROWS
-- are visible, a table-level GRANT is a separate, independent privilege
-- layer, and Supabase grants both anon and authenticated broad default
-- privileges on every table unless explicitly revoked.
revoke all on public.book_checkout_intents from public, anon, authenticated;

-- Serves create_book_checkout_intent's reuse lookup
-- (book_id/reader_id/fulfilled_at is null/created_at desc). The
-- predicate references only a static column-null check, never now(), so
-- it's a valid immutable partial-index predicate (unlike a
-- time-dependent "unexpired" predicate, which Postgres would reject).
create index book_checkout_intents_reader_book_open_idx
  on public.book_checkout_intents (reader_id, book_id, created_at desc)
  where fulfilled_at is null;

-- Serves the admin reconciliation query (see this migration's own
-- closing comment) directly -- same immutable-predicate reasoning.
create index book_checkout_intents_needs_reconciliation_idx
  on public.book_checkout_intents (completed_at)
  where fulfilled_at is null and completed_at is not null;

-- ============================================================
-- create_book_checkout_intent: the sole write path for MINTING an
-- intent (as opposed to finalize_book_checkout_intent below, which
-- SETTLES one). Called from buyBook with the request-scoped
-- (authenticated) client.
--
-- Never accepts price_cents_at_checkout, reader_id, or any
-- author/payment-destination data from the caller -- this function is
-- reachable directly via PostgREST by any authenticated client, not
-- just through buyBook's own server action, so every financial value it
-- returns is re-derived here from books/discount_codes, never trusted
-- from a parameter. reader_id is always auth.uid(), never a parameter.
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

  -- Serializes every call for this exact (reader, book) pair against
  -- every other concurrent call for the SAME pair -- both other
  -- create_book_checkout_intent calls AND finalize_book_checkout_intent
  -- calls below, which take the identical lock namespace. Transaction-
  -- scoped: released automatically at commit or at any raise exception
  -- rollback in this function.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(v_reader_id::text),
    pg_catalog.hashtext(create_book_checkout_intent.book_id::text)
  );

  -- Reuse an existing, still-open, unsettled intent for this exact
  -- reader+book instead of minting a second, independent one -- this is
  -- what makes two concurrent buyBook calls converge on the same
  -- intent_id, and therefore the same Stripe idempotency key downstream,
  -- instead of producing two separately-payable Checkout Sessions.
  --
  -- completed_at is null is required here, not just fulfilled_at is
  -- null: a paid-but-blocked (reconciliation) intent also has
  -- fulfilled_at is null, but its Stripe session is already settled and
  -- can never become payable again. Reusing it would hand the caller an
  -- idempotency key Stripe already has a terminal, non-payable cached
  -- response for -- silently soft-locking a reader who genuinely needs a
  -- fresh attempt (or a refund) for up to this row's remaining
  -- expires_at window. Excluding completed_at is not null rows lets a
  -- blocked reader mint a working fresh attempt immediately, without
  -- touching or resurrecting the blocked row.
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

  -- Must still be published, purchasable, and not the caller's own book
  -- at this exact moment, not merely when buyBook checked it earlier --
  -- re-verified here, not trusted from any caller-side check.
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

  -- Closes the race where a concurrent request fulfilled a purchase for
  -- this same reader while THIS call was waiting on the advisory lock
  -- above -- buyBook's own early "already own" check runs before that
  -- fulfillment and is stale by the time execution reaches here.
  -- refunded_at is null means a refunded reader is never blocked from a
  -- fresh intent -- repurchase after refund stays permitted.
  if exists (
    select 1
    from public.purchases p
    where p.book_id = create_book_checkout_intent.book_id
      and p.reader_id = v_reader_id
      and p.refunded_at is null
  ) then
    raise exception 'reader already owns this book';
  end if;

  v_price_cents := v_book.price_cents;
  v_discount_code_id := null;

  -- Independently re-normalizes and re-validates the code, exactly like
  -- buyBook's own existing pre-check (which still runs, unchanged, for
  -- the friendly "That promo code isn't valid" UX -- this RPC does not
  -- reuse or trust that result, only its own fresh lookup). An
  -- invalid/expired/wrong-book code is silently ignored (full price
  -- charged), not raised -- a well-behaved caller (buyBook) never sends
  -- one, since its own pre-check already redirected with an error first.
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
      -- Ported from applyDiscount() in src/lib/pricing.ts. Cast through
      -- numeric, never float8/double precision -- verified empirically
      -- (20 boundary cases, including exact .5-cent ties) against
      -- Math.round() before this migration was written: the numeric cast
      -- matched Node exactly on all 20; the float8 form silently
      -- diverged on 3 of them (the classic binary-floating-point .5
      -- representation trap -- 2.5 stored as 2.4999999999999996). Both
      -- Math.round (rounds .5 toward +Infinity) and Postgres numeric
      -- round() (rounds .5 away from zero) coincide exactly for
      -- non-negative inputs, which this expression always produces:
      -- price_cents > 0 (free books excluded above) and percent_off is
      -- constrained to [1,100] by discount_codes' own CHECK constraint.
      -- MIN_CHARGE_CENTS (50) mirrors the same constant in pricing.ts.
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

  -- Same constant and "leave margin under Stripe's 24h max" reasoning
  -- already established in migration 026 for bundles. The Node caller
  -- converts this to Stripe's own Checkout Session expires_at via
  -- Math.floor (never Math.round) of the millisecond timestamp -- see
  -- toStripeExpiresAtSeconds in src/app/books/[id]/checkout-logic.ts --
  -- which guarantees stripe_expires_at <= this column's value always,
  -- never later, so Stripe can never accept a payment after the
  -- database has already stopped reusing this intent.
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
-- finalize_book_checkout_intent: the sole write path for SETTLING an
-- intent once Stripe has confirmed payment. Called ONLY by the Stripe
-- webhook, via the service-role admin client -- this function asserts
-- "Stripe confirms this was paid," which only a Stripe-signature-
-- verified event handler is trusted to say. Restricted to service_role
-- below; not callable by authenticated or anon at all.
--
-- Two independent locks, each protecting a different concurrency
-- boundary:
--   1. `select ... for update` on THIS intent's own row, taken first and
--      unconditionally -- serializes two concurrent finalize calls for
--      the exact same intent_id (e.g. a genuinely simultaneous duplicate
--      webhook delivery, or the deleted-book/reader path below). The
--      second call blocks on this select until the first's transaction
--      commits, then observes its already-written fulfilled_at /
--      reconciliation_reason and returns 'already_finalized' -- there is
--      no separate pre-lock check that could race ahead of this; the row
--      lock IS the serialization point, checked exactly once.
--   2. pg_advisory_xact_lock(reader_id, book_id) -- the SAME namespace
--      create_book_checkout_intent uses -- taken only once book_id/
--      reader_id are known to be non-null, and only after the row lock
--      above is already held. Serializes this finalize call against a
--      concurrent finalize call for a genuinely DIFFERENT intent of this
--      same reader/book pair (which the row lock alone cannot do, since
--      that's a different row) -- this is what makes two truly
--      concurrent webhook deliveries for two different, both-paid
--      intents converge correctly: whichever commits first's write to
--      purchases is what the second observes once it acquires this same
--      lock, so it correctly classifies itself active_other_session
--      instead of racing to overwrite the first's purchases row.
--
-- Both locks are transaction-scoped and released automatically at this
-- function's own commit -- there is no manual unlock, and no window
-- between "decide the outcome" and "write it" for anything else to
-- interleave, because everything from the row lock onward runs inside
-- this one function call, which is one Postgres transaction end to end.
create or replace function public.finalize_book_checkout_intent(
  p_intent_id uuid,
  p_stripe_checkout_session_id text,
  p_stripe_payment_intent_id text,
  p_amount_cents integer
)
-- Output columns are deliberately NOT named book_id/reader_id: PL/pgSQL
-- treats RETURNS TABLE columns as variables in scope for the whole
-- function body, and a name matching a real column on purchases or
-- book_checkout_intents creates an ambiguity Postgres rejects at
-- runtime -- not just in a bare SELECT (fixable by qualifying with a
-- table alias) but even inside `on conflict (book_id, reader_id)`
-- below, whose column list does NOT accept table-qualified names at
-- all. Prefixing these avoids the entire class of collision rather than
-- requiring every reference elsewhere in this function (and in any
-- future edit to it) to remember to qualify itself correctly.
returns table (
  outcome text,        -- 'eligible_fulfilled' | 'active_other_session'
                        -- | 'blocked_book_or_reader_deleted' | 'already_finalized'
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

  -- Financial-authority check: p_amount_cents is Stripe's own reported
  -- charge for this session (Node extracts it from session.amount_total
  -- on a webhook event whose signature Node has already verified), but
  -- that verification only proves the EVENT is genuinely from Stripe --
  -- it says nothing about whether the amount matches what THIS intent
  -- was actually frozen to charge. This function is the last, and only,
  -- place that can cross-check a caller-supplied amount against the
  -- server-computed, tamper-proof value this same intent already froze
  -- at create_book_checkout_intent time -- so it does, unconditionally,
  -- before any branch below is allowed to run. Deliberately does NOT
  -- assume the two values must agree merely because both normally
  -- originate from the same checkout: a mismatch here means something is
  -- wrong (a future bug misrouting an event to the wrong intent_id, a
  -- Stripe-side amount adjustment this integration doesn't expect, a
  -- corrupted/zero amount_total) and must fail closed rather than
  -- silently trust the caller-supplied figure -- raising here rolls back
  -- this entire transaction (including the row lock taken above), writes
  -- nothing to purchases, and never sets fulfilled_at. `is null` is
  -- checked explicitly: `<>` against a null p_amount_cents would
  -- evaluate to null, which plpgsql's `if` treats as false and would
  -- silently skip this check entirely -- the fail-closed guarantee
  -- degrades to nothing without it.
  if p_amount_cents is null or p_amount_cents <> v_intent.price_cents_at_checkout then
    raise exception 'stripe amount does not match this intent''s frozen price';
  end if;

  -- The book or reader was deleted after this intent was created but
  -- before this webhook could fulfill it (book_id/reader_id use ON
  -- DELETE SET NULL, not RESTRICT -- see this table's own comment
  -- above). Stripe genuinely charged the card, but there is no longer a
  -- valid (book_id, reader_id) to write into purchases (both NOT NULL
  -- there) -- recorded as completed-but-blocked, exactly like
  -- active_other_session below, rather than silently dropped or
  -- endlessly retried by returning an error. Still under the row lock
  -- taken above, so two concurrent finalize calls hitting this same
  -- deleted-entity path for the same intent are serialized the same way
  -- as every other outcome -- only the first writes
  -- reconciliation_reason; the second sees it already set and returns
  -- 'already_finalized' instead of racing to write it twice.
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

  -- No same_session case here, deliberately: unlike the bundle
  -- fulfillment path (which has no per-attempt row of its own to check),
  -- every retry or duplicate delivery of the event that would finalize
  -- THIS exact session always carries this exact p_intent_id (it comes
  -- straight from that session's own Stripe metadata, fixed at session
  -- creation) -- so the row-lock + already-settled check at the very top
  -- of this function already catches every such retry as
  -- 'already_finalized', before execution ever reaches here. A second,
  -- genuinely different intent row can never legitimately carry the same
  -- stripe_checkout_session_id as this call's own session (each Stripe
  -- session's metadata.intent_id is fixed to the one intent that created
  -- it), so comparing v_existing.stripe_checkout_session_id against
  -- p_stripe_checkout_session_id here would be unreachable dead code --
  -- removed rather than kept untested.
  select p.stripe_checkout_session_id, p.refunded_at
  into v_existing
  from public.purchases p
  where p.book_id = v_intent.book_id
    and p.reader_id = v_intent.reader_id;

  if v_existing.stripe_checkout_session_id is not null and v_existing.refunded_at is null then
    -- active_other_session: a different, still-active (non-refunded)
    -- transaction already owns this reader/book pair -- two valid
    -- Stripe sessions for the same book completed close together. Never
    -- overwritten, never auto-refunded -- durably recorded here for
    -- admin reconciliation (see this migration's closing query) and
    -- excluded from purchases entirely, since no additional entitlement
    -- is being granted (the reader already has access via the other
    -- transaction).
    update public.book_checkout_intents
    set stripe_payment_intent_id = p_stripe_payment_intent_id,
        completed_at = now(),
        reconciliation_reason = 'active_other_session'
    where id = p_intent_id;
    return query select 'active_other_session'::text, v_intent.book_id, v_intent.reader_id;
    return;
  end if;

  -- eligible: no existing row, or an existing row that's refunded (a
  -- repurchase after refund -- upserts onto that same, permanently-
  -- stable purchases row, unchanged from today's behavior).
  -- discount_code_id is sourced from this intent's own, RPC-validated
  -- value, not from session.metadata -- strictly more trustworthy than
  -- trusting Stripe's own metadata echo of it. amount_cents is written
  -- from v_intent.price_cents_at_checkout, NOT p_amount_cents -- by this
  -- point the check above has already proven the two are equal, but the
  -- server-computed, frozen value is what's actually written, never the
  -- caller-supplied parameter, even though they're now known to match.
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

revoke all on function public.finalize_book_checkout_intent(uuid, text, text, integer) from public;
revoke all on function public.finalize_book_checkout_intent(uuid, text, text, integer) from anon;
revoke all on function public.finalize_book_checkout_intent(uuid, text, text, integer) from authenticated;
grant execute on function public.finalize_book_checkout_intent(uuid, text, text, integer) to service_role;

-- ============================================================
-- Admin reconciliation query for every Stripe-confirmed paid
-- transaction that was NOT fulfilled into purchases (state 4 in this
-- table's own comment above) -- unambiguous by construction, since
-- state 2 (an ordinary still-open session) always has completed_at is
-- null:
--
-- select
--   i.id as intent_id, i.book_id, i.book_title, i.reader_id,
--   i.price_cents_at_checkout, i.stripe_checkout_session_id,
--   i.stripe_payment_intent_id, i.completed_at, i.reconciliation_reason,
--   i.created_at
-- from public.book_checkout_intents i
-- where i.completed_at is not null and i.fulfilled_at is null
-- order by i.completed_at desc;
