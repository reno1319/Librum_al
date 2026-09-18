-- ALL-CATALOG-2 / currency cutover: correct the discount floor in
-- create_book_checkout_intent().
--
-- Librum's catalog and ledger currency is ALL (Albanian lek). Amounts
-- are stored in minor units, hundredths of a lek. The discount floor in
-- this function was still 50 -- a US-cents constant inherited from the
-- Stripe era, when it meant Stripe's $0.50 minimum charge. In lek minor
-- units 50 means 0.50 ALL, so a large percent-off code could produce a
-- real POK order for a fraction of a lek.
--
-- The application already knows this constant does not survive the
-- currency change: src/app/(public)/books/[id]/checkout-logic.ts:86 and
-- its test "never reuses MIN_CHARGE_CENTS as an ALL business rule"
-- guard exactly this mistake on the TypeScript side. This is the same
-- mistake on the SQL side, where those tests could not see it.
--
-- The function body below is unchanged from schema.sql apart from that
-- one literal and the comment explaining it. It is restated in full
-- because `create or replace function` has no partial form.

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

  -- LAUNCH-1 P1-7A correction: was `if exists (select 1 from purchases
  -- where ... and refunded_at is null)` -- exactly the "second
  -- definition of active ownership" this correction exists to remove --
  -- replaced with the same canonical predicate everything else uses. A
  -- reader whose only purchase of this book is disputed-and-lost may
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
      -- ALL-CATALOG-2: the floor was 50, which was 50 US cents -- the
      -- Stripe minimum charge, the same constant src/lib/pricing.ts
      -- still calls MIN_CHARGE_CENTS. Minor units are now hundredths
      -- of a lek, so 50 meant 0.50 ALL: a 99%-off code on any book
      -- would have produced an order worth about half a cent, with a
      -- rounded-to-zero author royalty behind it. The floor is now
      -- 9900 = 99.00 ALL, MINIMUM_PAID_CATALOG_PRICE_ALL from
      -- src/lib/catalog-price.ts, the same minimum an author is
      -- allowed to list a paid book at in the first place. A code
      -- that would go below it is clamped, not rejected -- that is
      -- the behaviour this function already had, and changing it
      -- into a visible "this code cannot apply to this book" error
      -- is a product decision, not part of the currency cutover.
      v_price_cents := greatest(
        case
          when v_discount.percent_off is not null
            then round(v_book.price_cents::numeric * (100 - v_discount.percent_off) / 100)::integer
          else v_book.price_cents - v_discount.amount_off_cents
        end,
        9900
      );
      v_discount_code_id := v_discount.id;
    end if;
  end if;

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
  select v_intent_id, v_price_cents, v_discount_code_id, v_expires_at;
end;
$$;

revoke all on function public.create_book_checkout_intent(uuid, text, text, text, integer) from public;
revoke all on function public.create_book_checkout_intent(uuid, text, text, text, integer) from anon;
revoke all on function public.create_book_checkout_intent(uuid, text, text, text, integer) from authenticated;
grant execute on function public.create_book_checkout_intent(uuid, text, text, text, integer) to authenticated;
