-- PHASE-2C: bundle membership integrity -- checkout-time defense.
--
-- create_bundle_checkout_snapshot() previously built its frozen item
-- list (v_items) directly from an unfiltered public.bundle_books join,
-- with only a `jsonb_array_length(v_items) < 2` floor. That check
-- cannot distinguish "this bundle has always had exactly 2 books" from
-- "this bundle was published with 3 books and one member has since
-- become invalid" (the book was unpublished by its author, or the
-- book_id row was cascade-deleted out of bundle_books entirely when its
-- book was deleted -- public.bundle_books.book_id references
-- public.books(id) on delete cascade, so a book deletion silently drops
-- its bundle_books row with no revalidation of the owning bundle at
-- all). In the 3-book-becomes-2-valid case specifically, the old check
-- would happily freeze a snapshot for 2 books under a bundle that was
-- published, priced, and advertised as containing 3 -- silently
-- narrower than what the reader was shown on the bundle detail page.
--
-- This migration adds an explicit total-vs-valid membership comparison,
-- counted BEFORE the existing item-list build and from a separate query
-- (never derived by filtering v_items), so an invalid bundle is
-- rejected outright rather than silently checked out as a smaller
-- valid subset:
--   - v_total_members: every bundle_books row for this bundle, full
--     stop.
--   - v_valid_members: only rows whose joined book is still owned by
--     this exact bundle's author AND still status = 'published'.
--   - Reject (raise exception, rolling back the whole call) if either
--     count is below 2, or if the two counts differ at all -- ANY
--     invalid member blocks the entire checkout, not just a fallback to
--     the remaining valid ones.
--
-- This is a checkout-time guard only. It stops a currently-invalid live
-- bundle from producing a NEW snapshot; it does not retroactively
-- repair a bundle_checkout_snapshot row already frozen and returned
-- before a member became invalid -- existing frozen-snapshot reuse
-- behavior (the v_existing block above this check) is completely
-- unchanged, by design: an already-active checkout's promised price and
-- item list must not change out from under a reader mid-checkout.
--
-- Companion application-level defenses added in the same change (not
-- part of this migration): src/app/(public)/dashboard/books/actions.ts
-- (unpublishBook()/deleteBook() now block on published-bundle
-- membership before mutating) and src/app/(public)/dashboard/bundles/
-- actions.ts (performBundlePublish() now performs this same total-vs-
-- valid comparison before allowing publish). This migration is the
-- last line of defense for the one path those two can't fully close on
-- their own: a book becoming invalid (unpublished, or deleted then
-- cascading its bundle_books row away) after a bundle was already
-- published, without any further author action on the bundle itself.
--
-- Function signature, security properties (security definer, empty
-- search_path, fully schema-qualified references throughout), and
-- grants are byte-for-byte unchanged from the prior version (migration
-- 056, STRIPE-CUTOVER-1C) -- only the new count-and-compare block and
-- its two new declared variables are added.
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
  v_total_members integer;
  v_valid_members integer;
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

  -- FIX/bundle-membership-integrity: every membership row must resolve
  -- to a book still owned by this exact bundle's author and still
  -- published -- not merely "at least 2 happen to remain valid" (a
  -- weaker check that would let a bundle silently sell fewer/different
  -- books than it was published with). Counted separately from the
  -- item-list build below (never derived from it) so an invalid bundle
  -- is rejected before any item list is even constructed, let alone
  -- frozen into a snapshot.
  select count(*) into v_total_members
  from public.bundle_books bb
  where bb.bundle_id = v_bundle.id;

  select count(*) into v_valid_members
  from public.bundle_books bb
  join public.books bo on bo.id = bb.book_id
  where bb.bundle_id = v_bundle.id
    and bo.author_id = v_bundle.author_id
    and bo.status = 'published';

  if v_total_members < 2
    or v_valid_members < 2
    or v_total_members <> v_valid_members
  then
    raise exception 'bundle does not have enough valid books to check out';
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
  --
  -- LAUNCH-1 P1-7A correction: was an inline `exists (select 1 from
  -- purchases where ... and refunded_at is null)` per item -- replaced
  -- with public.user_owns_book(), the same canonical predicate every
  -- other ownership check in this schema now uses. A reader whose only
  -- purchase of a book in this bundle is disputed-and-lost is correctly
  -- treated as NOT owning it. Same read, same place, inside this same
  -- already-advisory-locked transaction -- no new concurrency exposure
  -- to the reservation/hold mechanism.
  if not exists (
    select 1
    from jsonb_array_elements(v_items) as item
    where not public.user_owns_book((item->>'book_id')::uuid)
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

-- Signature, security properties, and grants unchanged -- restated
-- verbatim (not a functional change) since `create or replace function`
-- above does not touch existing grants, but restating them here keeps
-- this migration file self-contained and matches this schema's own
-- established convention of every migration that replaces a function
-- also restating its grants.
revoke all on function public.create_bundle_checkout_snapshot(uuid, text, text, integer) from public;
revoke all on function public.create_bundle_checkout_snapshot(uuid, text, text, integer) from anon;
revoke all on function public.create_bundle_checkout_snapshot(uuid, text, text, integer) from authenticated;
grant execute on function public.create_bundle_checkout_snapshot(uuid, text, text, integer) to authenticated;
