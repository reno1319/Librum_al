-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. Adds durable, checkout-time-frozen bundle purchase snapshots,
-- plus the database-enforced protection that keeps a book or a reader's
-- profile from being deleted while a bundle checkout for it can still be
-- paid. See the Phase 9B-2 audit for the full reasoning -- summarized
-- here only where it explains a specific choice made in this file.
--
-- STAGE 1 OF 9B-2 -- SCHEMA/DEFINITION ONLY. Nothing in the application
-- writes to these tables yet: buyBundle and the Stripe webhook are
-- unchanged until later stages. total_amount_cents and fulfilled_at are
-- declared here but are only ever populated by the webhook's future
-- atomic fulfillment claim -- never by this migration.

-- ============================================================
-- bundle_checkout_snapshots: one durable row per bundle checkout
-- attempt. Freezes the exact books, titles, and prices a reader agreed
-- to buy at the moment they clicked "Buy bundle" -- fulfillment must
-- read from here, never from live bundles/bundle_books, so a later
-- edit or deletion of the bundle can never change what an in-flight or
-- already-completed checkout grants.
--
-- author_id/reader_id/bundle_id all use ON DELETE SET NULL: this row is
-- commercial/audit evidence and must survive the author, reader, or
-- bundle it references being deleted later -- bundle_title and items
-- are denormalized precisely so the row stays meaningful even then.
-- Active-checkout protection against destructive book/reader deletion
-- is NOT this table's job -- that's bundle_checkout_reservations and
-- bundle_checkout_reader_holds below.
--
-- total_amount_cents is nullable and is populated exactly once, by the
-- webhook's future atomic fulfillment UPDATE -- it is the only
-- Librum-side record of the bundle's total paid amount that survives a
-- reader later deleting their account, since their purchases rows
-- (which would otherwise reconstruct this via SUM) cascade away with
-- their profile.
--
-- items intentionally does NOT contain allocation_cents -- that value
-- doesn't exist until Stripe reports session.amount_total at webhook
-- time, and purchases.amount_cents (per book, per row) is already the
-- authoritative record of it once it does. Duplicating it here would be
-- redundant state with no reconciliation benefit.
create table public.bundle_checkout_snapshots (
  id uuid primary key default gen_random_uuid(),
  stripe_checkout_session_id text unique,
  bundle_id uuid references public.bundles(id) on delete set null,
  bundle_title text not null,
  author_id uuid references public.profiles(id) on delete set null,
  reader_id uuid references public.profiles(id) on delete set null,
  bundle_price_cents_at_checkout integer not null,
  total_amount_cents integer,
  items jsonb not null,
  protection_expires_at timestamptz not null,
  fulfilled_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.bundle_checkout_snapshots enable row level security;

-- Deliberately zero policies for anon/authenticated -- nothing in the
-- product surfaces "my pending checkout" to a reader anywhere. The only
-- legitimate writer is create_bundle_checkout_snapshot() below
-- (SECURITY DEFINER); the only legitimate reader going forward is the
-- Stripe webhook (service role, bypasses RLS entirely -- no policy is
-- added "for symmetry", since a service-role policy would be inert).

create index bundle_checkout_snapshots_bundle_id_idx on public.bundle_checkout_snapshots(bundle_id);
create index bundle_checkout_snapshots_author_id_idx on public.bundle_checkout_snapshots(author_id);
create index bundle_checkout_snapshots_reader_id_idx on public.bundle_checkout_snapshots(reader_id);

-- ============================================================
-- bundle_checkout_reservations: the database-enforced backstop that
-- makes "no book deletion while a checkout for it can still be paid" an
-- actual guarantee, not just an application-level advisory check. One
-- row per (snapshot, book) in that snapshot's frozen item list.
--
-- book_id uses ON DELETE RESTRICT, unconditionally -- Postgres has no
-- way to make a foreign key's own ON DELETE behavior conditional on a
-- sibling row's state. "Restrict only while the checkout is still
-- active" is instead achieved by the ROWS themselves existing only
-- while active: cleared on fulfillment or expiry by
-- clear_expired_book_reservations() below, at the moment a delete is
-- actually attempted -- never by a weaker FK.
create table public.bundle_checkout_reservations (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.bundle_checkout_snapshots(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (snapshot_id, book_id)
);

alter table public.bundle_checkout_reservations enable row level security;
-- Zero anon/authenticated policies -- rows are created only by the RPC
-- below and cleared only by the trigger function (both SECURITY
-- DEFINER, both bypass RLS as the function owner).

create index bundle_checkout_reservations_book_id_idx on public.bundle_checkout_reservations(book_id);

-- ============================================================
-- bundle_checkout_reader_holds: the symmetric database-enforced
-- backstop for the reader side of the same problem -- purchases.reader_id
-- also requires a live profiles row to exist at insert time, so a
-- reader deleting their account mid-checkout can orphan a still-payable
-- Stripe session exactly as an author deleting a reserved book can. One
-- row per snapshot (not per book -- there is exactly one reader per
-- checkout).
--
-- reader_id uses ON DELETE RESTRICT, unconditionally, for the same
-- reason as bundle_checkout_reservations.book_id above -- cleared on
-- fulfillment or expiry by clear_expired_reader_holds() below, never by
-- a weaker FK. Once fulfilled, the reader is protected instead by
-- purchases.reader_id's own (intentionally CASCADE, not restrict) FK --
-- a reader deleting their account after a genuine purchase is expected
-- to take their purchase history with it, unchanged from today.
create table public.bundle_checkout_reader_holds (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null unique references public.bundle_checkout_snapshots(id) on delete cascade,
  reader_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

alter table public.bundle_checkout_reader_holds enable row level security;
-- Zero anon/authenticated policies, same reasoning as reservations above.

create index bundle_checkout_reader_holds_reader_id_idx on public.bundle_checkout_reader_holds(reader_id);

-- ============================================================
-- create_bundle_checkout_snapshot: the sole write path into the three
-- tables above. Re-validates everything that could make the resulting
-- snapshot internally inconsistent if it were only checked earlier in
-- buyBundle (bundle existence/published status/minimum book count),
-- atomically with the same read that freezes membership and price --
-- closing the gap where "buyBundle validates, then the bundle changes,
-- then a stale snapshot gets created anyway."
--
-- Author payout readiness is deliberately NOT checked here -- that is a
-- business-eligibility gate on whether checkout should be offered at
-- all, not a fact about whether the resulting snapshot is internally
-- consistent, and remains buyBundle's responsibility.
--
-- Does NOT filter bundle_books by the individual book's own published
-- status -- the existing webhook fan-out has never done this either,
-- consistent with Phase 8A's decision that legitimate access to an
-- already-acquired-but-now-unpublished book is preserved. This
-- migration preserves that exact behavior rather than introducing a new
-- filter.
--
-- Takes no reader_id parameter -- always derives it from auth.uid(), so
-- a caller can only ever snapshot a checkout for themselves, never for
-- another reader.
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
begin
  v_reader_id := auth.uid();
  if v_reader_id is null then
    raise exception 'not authenticated';
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

-- EXECUTE is revoked from everyone first, then granted only to
-- authenticated -- an anonymous visitor has no auth.uid() to snapshot a
-- checkout for, so there is no reason to grant it access at all. A
-- PL/pgSQL function body that raises an exception rolls back everything
-- it already did in this call (the header insert, any reservations, the
-- reader hold) as a single atomic unit -- there is no partial-snapshot
-- state possible from a failed call.
revoke all on function public.create_bundle_checkout_snapshot(uuid) from public;
revoke all on function public.create_bundle_checkout_snapshot(uuid) from anon;
revoke all on function public.create_bundle_checkout_snapshot(uuid) from authenticated;
grant execute on function public.create_bundle_checkout_snapshot(uuid) to authenticated;

-- ============================================================
-- clear_expired_book_reservations / clear_expired_reader_holds: the
-- mechanism that makes "an abandoned checkout eventually stops blocking
-- deletion" true for every deletion path -- deleteBook, deleteAccount's
-- cascade, and direct SQL deletion alike -- without a scheduled cleanup
-- job and without depending on Stripe's checkout.session.expired
-- webhook ever arriving. A Postgres trigger fires for any DELETE
-- against the table regardless of what issued it, so this self-heals
-- even for a delete run directly in the Supabase SQL Editor.
--
-- SECURITY DEFINER is required here, not just a hardening choice: with
-- zero anon/authenticated policies on bundle_checkout_reservations /
-- bundle_checkout_reader_holds, a trigger running as the invoking
-- role's own privileges (SECURITY INVOKER, the default) would see no
-- rows to delete under RLS at all, silently doing nothing -- exactly
-- the same reasoning already established for user_owns_book() in
-- migration 024.
--
-- The predicate only ever matches a reservation/hold whose parent
-- snapshot is either already fulfilled (purchases rows already exist
-- and independently protect this book/reader via their own FK -- this
-- reservation is now permanently redundant regardless of expiry) or
-- unfulfilled AND past its protection_expires_at (genuinely abandoned).
-- It can never match an active row: fulfilled_at is null AND
-- protection_expires_at > now() satisfies neither clause, by
-- construction.
create or replace function public.clear_expired_book_reservations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.bundle_checkout_reservations r
  using public.bundle_checkout_snapshots s
  where r.book_id = old.id
    and r.snapshot_id = s.id
    and (
      s.fulfilled_at is not null
      or s.protection_expires_at <= now()
    );

  return old;
end;
$$;

create trigger clear_expired_book_reservations_trigger
  before delete on public.books
  for each row
  execute function public.clear_expired_book_reservations();

create or replace function public.clear_expired_reader_holds()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.bundle_checkout_reader_holds h
  using public.bundle_checkout_snapshots s
  where h.reader_id = old.id
    and h.snapshot_id = s.id
    and (
      s.fulfilled_at is not null
      or s.protection_expires_at <= now()
    );

  return old;
end;
$$;

create trigger clear_expired_reader_holds_trigger
  before delete on public.profiles
  for each row
  execute function public.clear_expired_reader_holds();

-- Trigger functions are invoked automatically by Postgres on the
-- covered DELETE operations, never called directly -- no EXECUTE grant
-- is given to any application role.
revoke all on function public.clear_expired_book_reservations() from public, anon, authenticated;
revoke all on function public.clear_expired_reader_holds() from public, anon, authenticated;
