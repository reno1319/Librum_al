-- ============================================================
-- ALL-CHECKOUT-1: make create_book_checkout_intent the single
-- authoritative ALL conversion boundary.
--
-- Patch 1 of the ALL application-wiring sequence. It changes one
-- function, adds two column comments, and touches nothing else: no
-- table, no policy, no index, no trigger, no other grant, and NO ROW.
-- Rollback is therefore recreating the previous function definition;
-- there is no forward-only step and no data to undo.
--
-- WHAT IT CHANGES, and why each one is a correctness fix rather than a
-- preference:
--
-- 1. The RPC surface narrows from seven arguments to four.
--    p_regime, p_currency and p_royalty_rate_bps are REMOVED, not
--    defaulted away. All three were parameters of a function granted to
--    `authenticated`, so any direct Data API caller could choose them:
--    mint a legacy_stripe_connect_v1/USD intent at will, or freeze an
--    author royalty rate of 0 bps (the author earns nothing) or
--    10000 bps (Librum earns nothing) onto a real checkout. The values
--    become internal constants -- librum_ledger_v1, ALL, 8000 -- so
--    there is no argument left to validate and no legacy value left to
--    reject. 8000 bps is the same rate AUTHOR_ROYALTY_RATE_BPS carries
--    in src/lib/pricing.ts, which is asserted there by its own unit
--    test and asserted here by 062's minted-intent test; the two
--    cannot drift without one of them failing.
--
-- 2. The price is read from books.price_all, never books.price_cents.
--    price_cents is legacy USD minor units; using it to price an ALL
--    checkout would be an unrecorded currency conversion at a rate
--    nobody chose. A null price_all (no ALL price authored yet) and a
--    zero price_all (explicitly free, acquired through getFreeBook)
--    both join the existing generic 'book not available for purchase'
--    refusal, so neither can mint an intent.
--
-- 3. The greatest(..., 50) discount floor is DELETED, and deliberately
--    not retuned to 9900. A clamp answers "this discounted price is
--    below the floor" by raising the reader's price back UP to the
--    floor: a book priced under the floor would then cost MORE with a
--    valid discount code than without one. The real discounted amount
--    is computed exactly and a paid result below 9900 minor units is
--    REJECTED with a typed status -- before any supersession, any
--    mapping mutation and any insert, so a rejected call leaves the
--    database exactly as it found it.
--
-- WHAT IT DOES NOT CHANGE. Historical legacy_stripe_connect_v1/USD
-- intents stay readable through get_book_checkout_quote and finalizable
-- through finalize_book_checkout_intent; neither function is touched
-- and no existing row is rewritten. What ends is the ability to MINT a
-- new legacy intent through this authenticated RPC.
--
-- DEPLOYMENT. The deployed application still sends the old named
-- arguments, so it will fail RPC resolution from the moment this
-- applies. That is safe and unobservable only because paid checkout is
-- closed: buyBook returns at canStartPaidCheckout() before this RPC is
-- reached, and PAID_CHECKOUT_MODE is absent in every environment.
-- Application compatibility returns with Patch 2. Apply in ONE
-- transaction (psql --single-transaction -v ON_ERROR_STOP=1): the
-- drops and the create must land together or not at all.
--
-- Re-applying this file to a database that already carries it fails at
-- `create function` ("already exists"), because the three drops name
-- the historical arities and not this one. That refusal is the intended
-- behaviour, not a defect.
-- ============================================================

-- ALL-CHECKOUT-1: all three historical arities are dropped, not
-- replaced. `create or replace` cannot narrow a parameter list, and a
-- surviving overload would let a caller keep choosing the regime,
-- currency and royalty rate that this change exists to take away from
-- them.
drop function if exists public.create_book_checkout_intent(uuid, text);
drop function if exists public.create_book_checkout_intent(uuid, text, text, text, integer);
drop function if exists public.create_book_checkout_intent(uuid, text, text, text, integer, boolean, uuid);

create function public.create_book_checkout_intent(
  book_id uuid,
  p_discount_code text default null,
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
  -- ALL-CHECKOUT-1: the transaction regime, the currency and the
  -- author's royalty rate are FACTS OF THIS PLATFORM, not arguments.
  -- They were parameters granted to `authenticated`, which meant a
  -- direct Data API caller chose them: a legacy/USD intent, or an
  -- author royalty of 0 bps (the author earns nothing) or 10000 bps
  -- (Librum earns nothing). The surface is removed rather than
  -- guarded, so there is no value left to validate and no legacy value
  -- left to reject.
  v_regime constant text := 'librum_ledger_v1';
  v_currency constant text := 'ALL';
  v_royalty_rate_bps constant integer := 8000;
  -- The floor is on the amount CHARGED, in minor units: 99,00 ALL.
  -- It mirrors MINIMUM_PAID_CATALOG_PRICE_ALL (99) in
  -- src/lib/catalog-price.ts, times the 100 minor units in one lek.
  -- A discount that lands below it is REJECTED, never clamped -- see
  -- the discount block below for why clamping is a defect and not a
  -- policy.
  v_minimum_paid_minor constant integer := 9900;
  v_reader_id uuid;
  v_book record;
  v_discount record;
  -- ALL-CHECKOUT-1: renamed from v_price_cents. This holds integer
  -- MINOR UNITS of ALL (100 per lek); the old name is now a lie.
  v_price_minor integer;
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
  --
  -- ALL-CHECKOUT-1: price_all, never price_cents. books.price_cents is
  -- the legacy USD catalog column and is no longer read here at all --
  -- deriving an ALL amount from it would be a silent, unrecorded
  -- currency conversion at a rate nobody chose.
  select b.id, b.title, b.price_all, b.status, b.author_id
  into v_book
  from public.books b
  where b.id = create_book_checkout_intent.book_id;

  -- ALL-CHECKOUT-1: two new causes join the existing three under the
  -- SAME generic message, deliberately. `price_all is null` means the
  -- book has no ALL price yet, so it is not purchasable -- it is never
  -- inferred as free and never falls back to price_cents.
  -- `price_all = 0` means the book IS free, and a free book is
  -- acquired through getFreeBook, never through a paid checkout
  -- intent. One message for all five: a distinct message per cause
  -- would turn this RPC into an enumeration oracle over unpublished
  -- and unpriced titles, and the existing posture here is already a
  -- single generic raise.
  if v_book.id is null
     or v_book.status <> 'published'
     or v_book.author_id = v_reader_id
     or v_book.price_all is null
     or v_book.price_all = 0 then
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
  --
  -- ALL-CHECKOUT-1: this multiplication is THE ONE conversion boundary
  -- between the whole-lek catalog and minor-unit transaction
  -- accounting. books.price_all is a whole number of lek (0, or
  -- 99..100000, by CHECK); everything downstream of this line is
  -- integer minor units. There is no other place in the database where
  -- a catalog price becomes a transaction amount.
  v_price_minor := v_book.price_all * 100;
  v_discount_code_id := null;

  if p_discount_code is not null and pg_catalog.length(pg_catalog.btrim(p_discount_code)) > 0 then
    select d.id, d.percent_off, d.amount_off_cents, d.amount_off_all
    into v_discount
    from public.discount_codes d
    where d.book_id = create_book_checkout_intent.book_id
      and d.code = pg_catalog.upper(pg_catalog.btrim(p_discount_code))
      and d.active = true
      and (d.expires_at is null or d.expires_at > now())
    limit 1;

    -- ALL-CHECKOUT-1: the greatest(..., 50) clamp is DELETED, and
    -- deliberately not retuned to 9900. A clamp answers "the discounted
    -- price is below the floor" by raising the reader's price back UP to
    -- the floor -- so a book priced below the clamp charges MORE with a
    -- valid code than without one, which is the opposite of what a
    -- discount code means and what the reader was shown. The arithmetic
    -- is computed exactly and an out-of-range result is REJECTED with a
    -- typed status instead.
    if v_discount.id is not null then
      if v_discount.percent_off is not null then
        -- EXACT, with no rounding rule in play: the stored minor-unit
        -- price is always price_all * 100, so
        --   price_all * 100 * (100 - p) / 100  ==  price_all * (100 - p)
        -- identically, for every integer price_all and every integer
        -- percent_off. percent_off is `integer check (between 1 and 100)`
        -- and price_all is `integer`, so the product is an integer number
        -- of minor units by construction. Do NOT reintroduce round() or
        -- a numeric cast here: they would be no-ops that invite a future
        -- reader to believe a rounding policy exists.
        v_price_minor := v_book.price_all * (100 - v_discount.percent_off);
      elsif v_discount.amount_off_all is not null then
        -- Also exact: both operands are whole lek, so the result is a
        -- whole number of lek expressed in minor units. It may be zero
        -- or negative; the floor check below is what rejects that.
        v_price_minor := (v_book.price_all - v_discount.amount_off_all) * 100;
      else
        -- A legacy amount_off_cents code: USD semantics, created under
        -- the Stripe Connect regime. It is NEVER applied to an ALL
        -- checkout -- its number is not an amount of lek -- and it is
        -- never silently ignored either, because ignoring it would
        -- charge the reader the FULL price on a call in which they
        -- supplied a code the database still considers active.
        return query select null::uuid, null::integer, null::uuid,
                            null::timestamptz, 'discount_not_applicable'::text;
        return;
      end if;

      if v_price_minor < v_minimum_paid_minor then
        return query select null::uuid, null::integer, null::uuid,
                            null::timestamptz, 'discount_below_minimum'::text;
        return;
      end if;

      v_discount_code_id := v_discount.id;
    end if;
  end if;

  -- Both rejections above return BEFORE the first mutation of this
  -- call -- before the accept path's row locks, before any
  -- supersession, before the mapping retirement and before the INSERT.
  -- Nothing is superseded, nothing is minted, no mapping row is
  -- touched. That is the same placement supersession_rate_limited
  -- already uses, and both are TYPED statuses rather than exceptions:
  -- no caller should ever parse exception text.

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

    -- ALL-CHECKOUT-1: the regime, currency and royalty rate compared
    -- here are this function's own constants, not caller arguments. A
    -- legacy/USD predecessor therefore never matches a new ALL quote's
    -- economics, which is correct: it is a quote in a different
    -- currency under a different regime.
    v_economics_match :=
      v_candidate.price_cents_at_checkout = v_price_minor
      and v_candidate.discount_code_id is not distinct from v_discount_code_id
      and v_candidate.regime is not distinct from v_regime
      and v_candidate.currency is not distinct from v_currency
      and v_candidate.royalty_rate_bps is not distinct from v_royalty_rate_bps;

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
    create_book_checkout_intent.book_id, v_reader_id, v_book.title, v_price_minor, v_discount_code_id, v_expires_at,
    v_regime, v_currency, v_royalty_rate_bps
  )
  returning id into v_intent_id;

  return query
  select v_intent_id, v_price_minor, v_discount_code_id, v_expires_at, 'minted'::text;
end;
$$;

-- ALL-CHECKOUT-1: a newly created function receives EXECUTE to PUBLIC by
-- default, so these revokes must follow the create, in the same
-- transaction. service_role is deliberately neither granted nor revoked
-- here: this RPC is called as the signed-in reader and auth.uid() is its
-- ownership source, and a revoke this migration did not need would be a
-- silent privilege change of its own.
revoke all on function public.create_book_checkout_intent(uuid, text, boolean, uuid) from public;
revoke all on function public.create_book_checkout_intent(uuid, text, boolean, uuid) from anon;
revoke all on function public.create_book_checkout_intent(uuid, text, boolean, uuid) from authenticated;
grant execute on function public.create_book_checkout_intent(uuid, text, boolean, uuid) to authenticated;

-- ============================================================
-- Two column comments, so the units are recorded where a reader of the
-- schema will find them. Both columns are historically named *_cents
-- and neither holds cents: they hold integer minor units of their own
-- row's currency. Renaming them is a separate, far larger change;
-- saying so in the catalog is not.
-- ============================================================

comment on column public.book_checkout_intents.price_cents_at_checkout is
  'Integer minor units of this row''s own currency (100 minor units = 1 ALL). Frozen at insert; never derived from books.price_cents.';

comment on column public.purchases.amount_cents is
  'Integer minor units of the currency of this row''s payment (purchases.payment_id -> payments.currency); legacy rows with a null payment_id are legacy_stripe_connect_v1 USD.';
