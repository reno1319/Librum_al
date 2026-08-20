-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. Replaces create_bundle_checkout_snapshot (migration 025) so
-- that two independent, concurrent requests for the same reader+bundle
-- (two tabs, a slow double-click that escapes the client-side pending
-- guard, a retried request) reuse the same in-flight checkout instead
-- of each creating its own snapshot -- which, downstream, would give
-- Stripe two different idempotency keys and let it create two
-- separately-payable Checkout Sessions for the same purchase. See the
-- Phase 9B-2 Stage 2C audit for the full option comparison and
-- reasoning; this file only explains the choices actually made here.
--
-- The function's signature and return shape are unchanged from
-- migration 025 -- CREATE OR REPLACE FUNCTION on an unchanged signature
-- preserves the function's existing grants, so the revoke/grant block
-- from migration 025 does not need to be repeated here.

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

  -- Serializes every call for this exact (reader, bundle) pair against
  -- every other concurrent call for the SAME pair. Transaction-scoped:
  -- released automatically at this call's commit, or at any of this
  -- function's raise exception rollbacks -- no manual unlock needed.
  -- hashtext() is applied to each id SEPARATELY (not concatenated
  -- first), so the two-int overload's collision surface is the product
  -- of two independent 32-bit hash spaces. Even a collision only ever
  -- causes an unrelated request to briefly wait its turn -- it can
  -- never let one reader see or reuse another reader's snapshot, since
  -- every lookup below still filters on the real reader_id/bundle_id
  -- columns, never on this hash. pg_catalog is already implicitly
  -- reachable under this function's empty search_path (as it already
  -- is for now(), jsonb_agg(), etc. elsewhere in this function), but
  -- both calls are schema-qualified explicitly here for clarity on this
  -- new, security-relevant statement.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(v_reader_id::text),
    pg_catalog.hashtext(create_bundle_checkout_snapshot.bundle_id::text)
  );

  -- Reuse an existing active checkout for this exact reader+bundle
  -- instead of creating a second, independent one. This is what makes
  -- two concurrent buyBundle calls end up sharing the same snapshot_id
  -- -- and therefore the same Stripe idempotency key downstream --
  -- instead of producing two separately-payable Checkout Sessions.
  -- Reuse returns the row's ALREADY-frozen values verbatim: nothing
  -- about an active snapshot -- title, price, items, item prices,
  -- membership, protection_expires_at -- is ever refreshed on reuse.
  -- An author editing the bundle after this snapshot was created must
  -- not change what this already-active checkout promises.
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

  -- Must still be published at this exact moment, not merely when
  -- buyBundle checked it earlier -- re-verified here, not trusted from
  -- any caller-side check.
  select b.id, b.title, b.price_cents, b.author_id
  into v_bundle
  from public.bundles b
  where b.id = create_bundle_checkout_snapshot.bundle_id
    and b.status = 'published';

  if v_bundle.id is null then
    raise exception 'bundle not found or not published';
  end if;

  -- One statement builds the frozen item list AND determines the book
  -- count from the same read -- no separate count query, so there is no
  -- window between "count the books" and "list the books" for
  -- membership to drift within this function's own execution. No
  -- allocation_cents here; that value doesn't exist until Stripe
  -- reports amount_total at webhook time.
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

  -- Closes the race where a concurrent request fulfilled a purchase for
  -- this same reader while THIS call was waiting on the advisory lock
  -- above: buyBundle's own "already own everything" check runs before
  -- that fulfillment and is stale by the time execution reaches here.
  -- Re-checked against the exact same book list v_items was just built
  -- from -- the current, authoritative bundle membership -- not a
  -- second, separately-fetched list, so this can never disagree with
  -- what the new snapshot below is about to freeze. A reader who
  -- already owns every one of these books gets no new snapshot at all.
  -- A reader who owns only SOME of them is unaffected -- fresh-snapshot
  -- creation proceeds exactly as it already did before this migration.
  if not exists (
    select 1
    from jsonb_array_elements(v_items) as item
    where not exists (
      select 1
      from public.purchases p
      where p.book_id = (item->>'book_id')::uuid
        and p.reader_id = v_reader_id
        and p.refunded_at is null
    )
  ) then
    raise exception 'reader already owns every book in this bundle';
  end if;

  -- Computed once, before any Stripe call is ever made by the caller --
  -- the exact same value is later passed to Stripe as the session's own
  -- explicit expires_at, so at no point can Stripe hold a still-payable
  -- session past this timestamp. Chosen as an interior duration (23h,
  -- not Stripe's 24h maximum -- confirmed against the installed Stripe
  -- SDK's own type definitions, which document a valid range of 30
  -- minutes to 24 hours from session creation) to leave margin against
  -- that bound, given the real, if normally small, elapsed time between
  -- this function returning and the caller's subsequent Stripe API call.
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
