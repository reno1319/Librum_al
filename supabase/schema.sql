-- Librum: self-publishing platform database schema.
-- Run this once in the Supabase SQL Editor (Dashboard > SQL Editor > New query)
-- after creating a new Supabase project.

-- ============================================================
-- profiles: one row per signed-up user (author or reader)
-- ============================================================

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('author', 'reader')),
  display_name text not null,
  bio text,
  avatar_path text,
  stripe_account_id text,
  stripe_payouts_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Profiles are viewable by everyone"
  on public.profiles for select
  using (true);

create policy "Users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- stripe_account_id / stripe_payouts_enabled are only ever written by
-- server code using the service role key (see src/lib/supabase/admin.ts),
-- never by the user directly — otherwise an author could just set
-- stripe_payouts_enabled = true on themselves via the API.
revoke update (stripe_account_id, stripe_payouts_enabled) on public.profiles from authenticated;

-- Auto-create a profile row whenever someone signs up, using the
-- role/display_name passed in from the signup form's metadata.
create function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, role, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'role', 'reader'),
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- series: an author's named grouping of their own books, in reading
-- order. Publicly viewable (a book's series info shows on its page to
-- everyone), but only the owning author can create/rename/delete one.
-- Declared before books, which references it.
-- ============================================================

create table public.series (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  created_at timestamptz not null default now()
);

alter table public.series enable row level security;

create policy "Series are viewable by everyone"
  on public.series for select
  using (true);

create policy "Authors can create their own series"
  on public.series for insert
  with check (auth.uid() = author_id);

create policy "Authors can rename their own series"
  on public.series for update
  using (auth.uid() = author_id);

create policy "Authors can delete their own series"
  on public.series for delete
  using (auth.uid() = author_id);

-- ============================================================
-- books: owned by an author, visible to everyone once published
-- ============================================================

-- Keep this list in sync with GENRES in src/lib/genres.ts.
create table public.books (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  description text not null default '',
  preview_text text not null default '',
  keywords text not null default '',
  isbn text,
  genre text check (genre in (
    'Fiction', 'Non-Fiction', 'Mystery & Thriller', 'Romance', 'Fantasy',
    'Science Fiction', 'Horror', 'Biography & Memoir', 'Self-Help',
    'History', 'Poetry', 'Young Adult', 'Children''s', 'Business'
  )),
  series_id uuid references public.series(id) on delete set null,
  series_position integer check (series_position > 0),
  price_cents integer not null default 0 check (price_cents >= 0),
  cover_path text,
  file_path text,
  status text not null default 'draft' check (status in ('draft', 'published')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.books enable row level security;

create policy "Published books are viewable by everyone, drafts by their author"
  on public.books for select
  using (status = 'published' or auth.uid() = author_id);

create policy "Authors can insert their own books"
  on public.books for insert
  with check (auth.uid() = author_id);

create policy "Authors can update their own books"
  on public.books for update
  using (auth.uid() = author_id);

create policy "Authors can delete their own books"
  on public.books for delete
  using (auth.uid() = author_id);

create index books_author_id_idx on public.books(author_id);
create index books_status_idx on public.books(status);
create index books_genre_idx on public.books(genre);
create index books_series_id_idx on public.books(series_id);

-- Dedicated schema for extensions, per Supabase's own recommendation
-- (avoids cluttering/coupling public with extension objects). Created
-- defensively with "if not exists" since we can't assume it's already
-- there -- this is additive and harmless if it already exists.
create schema if not exists extensions;
create extension if not exists unaccent with schema extensions;

-- Diacritic-tolerant bookstore search (see the Phase 6B search audit).
-- Matches title/description/keywords/author-display-name using
-- extensions.unaccent() on both the stored text and the search term, so
-- e.g. a search for "Kerc" matches stored "Kërc" and vice versa -- ë/e
-- and ç/c fold together (along with other accented Latin letters,
-- unaccent's normal behavior), while ILIKE keeps matching
-- case-insensitive as before.
--
-- SECURITY INVOKER (the default, stated explicitly): unlike
-- bestselling_books, this only reads books/profiles data that's already
-- publicly selectable under existing RLS ("Published books are viewable
-- by everyone" / "Profiles are viewable by everyone") -- there is no
-- privileged data to bypass, so no elevated privilege is used or
-- needed. It runs under the calling role's own RLS, same as any other
-- query the bookstore already makes.
--
-- Returns ONLY book_id -- never any profiles or purchases column -- the
-- caller re-fetches full book rows (with profiles(display_name)) the
-- same way the rest of the bookstore code already does.
--
-- SEARCH CANDIDATE LIMIT vs. VISIBLE SEARCH RESULT LIMIT: result_limit
-- here clamps to 1-500 -- this is a CANDIDATE ceiling, not the 48
-- results the bookstore actually displays. The application sorts
-- (newest / price / bestselling) over whatever this function returns,
-- then applies its own separate 48-row display cap AFTER sorting -- so
-- this limit must cover every book that could plausibly match a query,
-- not just the number shown on screen, or sorting would silently run
-- over an incomplete/arbitrary subset of the true matches (see the
-- Phase 6B-2 correction audit). 500 is a bounded ceiling judged
-- appropriate for Librum's current catalog size (low hundreds of
-- published books, per the Phase 6B-1 audit) -- it is NOT claimed to be
-- correct at arbitrary catalog size. If the catalog can plausibly grow
-- to where a single query matches more than 500 published books, this
-- architecture (push sorting into the database, or paginate, or both)
-- must be revisited before that happens -- raising this constant alone
-- would silently reintroduce the same truncate-before-sort bug this
-- fixes, just at a higher threshold.
--
-- This still guards against an unbounded scan/result set -- 500 is a
-- hard cap, not "no limit" -- mirroring the same defensive
-- least/greatest/coalesce pattern already used by bestselling_books.
create or replace function public.search_books(
  search_term text default null,
  genre_filter text default null,
  min_price_cents int default null,
  max_price_cents int default null,
  result_limit int default 500
)
returns table (book_id uuid)
language sql
security invoker
set search_path = ''
stable
as $$
  select books.id as book_id
  from public.books
  where books.status = 'published'
    and (genre_filter is null or books.genre = genre_filter)
    and (min_price_cents is null or books.price_cents >= min_price_cents)
    and (max_price_cents is null or books.price_cents <= max_price_cents)
    and (
      search_term is null
      or extensions.unaccent(books.title) ilike extensions.unaccent('%' || search_term || '%')
      or extensions.unaccent(books.description) ilike extensions.unaccent('%' || search_term || '%')
      or extensions.unaccent(books.keywords) ilike extensions.unaccent('%' || search_term || '%')
      or exists (
        select 1
        from public.profiles
        where profiles.id = books.author_id
          and profiles.role = 'author'
          and extensions.unaccent(profiles.display_name) ilike extensions.unaccent('%' || search_term || '%')
      )
    )
  -- SEARCH CANDIDATE LIMIT (500) -- see the comment block above. NOT the
  -- 48-row VISIBLE SEARCH RESULT LIMIT the bookstore displays.
  limit least(greatest(coalesce(result_limit, 500), 1), 500);
$$;

revoke all on function public.search_books(text, text, int, int, int) from public;
grant execute on function public.search_books(text, text, int, int, int) to anon, authenticated;

-- ============================================================
-- book_contributors: credits shown on a book's page beyond the single
-- primary author (illustrator, translator, narrator, co-author, etc).
-- Free text — the contributor doesn't need a Librum account, matching
-- how most illustrators/translators/narrators actually work. Purely
-- informational: no payout or account access is tied to this.
-- ============================================================

-- Keep this list in sync with CONTRIBUTOR_ROLES in src/lib/contributor-roles.ts.
create table public.book_contributors (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  name text not null,
  role text not null check (role in (
    'Co-Author', 'Illustrator', 'Translator', 'Narrator', 'Editor',
    'Foreword', 'Cover Designer'
  )),
  created_at timestamptz not null default now()
);

alter table public.book_contributors enable row level security;

create policy "Contributors are viewable wherever the book is"
  on public.book_contributors for select
  using (
    exists (
      select 1 from public.books
      where books.id = book_contributors.book_id
      and (books.status = 'published' or books.author_id = auth.uid())
    )
  );

create policy "Authors can add contributors to their own books"
  on public.book_contributors for insert
  with check (
    exists (
      select 1 from public.books
      where books.id = book_contributors.book_id
      and books.author_id = auth.uid()
    )
  );

create policy "Authors can remove contributors from their own books"
  on public.book_contributors for delete
  using (
    exists (
      select 1 from public.books
      where books.id = book_contributors.book_id
      and books.author_id = auth.uid()
    )
  );

create index book_contributors_book_id_idx on public.book_contributors(book_id);

-- ============================================================
-- book_views: one row per page view of a published book, for basic
-- author-facing analytics. Anonymous — no viewer identity is stored —
-- and a simple count, not deduplicated unique visitors: a reload or a
-- repeat visit counts again. Written only by the app's server code
-- using the service role key (like purchases), so there's deliberately
-- no insert policy for regular users.
-- ============================================================

create table public.book_views (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.book_views enable row level security;

create policy "Authors can view the view-counts of their own books"
  on public.book_views for select
  using (
    exists (
      select 1 from public.books
      where books.id = book_views.book_id
      and books.author_id = auth.uid()
    )
  );

create index book_views_book_id_idx on public.book_views(book_id);
create index book_views_created_at_idx on public.book_views(created_at);

-- ============================================================
-- bundles: an author packages several of their own published books
-- into one discounted purchase. Declared before purchases, which
-- references it.
-- ============================================================

create table public.bundles (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  description text not null default '',
  price_cents integer not null default 0 check (price_cents >= 0),
  status text not null default 'draft' check (status in ('draft', 'published')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.bundles enable row level security;

create policy "Published bundles are viewable by everyone, drafts by their author"
  on public.bundles for select
  using (status = 'published' or auth.uid() = author_id);

create policy "Authors can insert their own bundles"
  on public.bundles for insert
  with check (auth.uid() = author_id);

create policy "Authors can update their own bundles"
  on public.bundles for update
  using (auth.uid() = author_id);

create policy "Authors can delete their own bundles"
  on public.bundles for delete
  using (auth.uid() = author_id);

create index bundles_author_id_idx on public.bundles(author_id);
create index bundles_status_idx on public.bundles(status);

-- ============================================================
-- bundle_books: which books are in a bundle. Both the bundle and the
-- book must belong to the same author — enforced in the insert policy
-- via two separate EXISTS checks, since a single-table policy can't
-- express "same owner across two tables" any more simply than that.
-- ============================================================

create table public.bundle_books (
  id uuid primary key default gen_random_uuid(),
  bundle_id uuid not null references public.bundles(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (bundle_id, book_id)
);

alter table public.bundle_books enable row level security;

create policy "Bundle contents are viewable wherever the bundle is"
  on public.bundle_books for select
  using (
    exists (
      select 1 from public.bundles
      where bundles.id = bundle_books.bundle_id
      and (bundles.status = 'published' or bundles.author_id = auth.uid())
    )
  );

create policy "Authors can add books to their own bundles"
  on public.bundle_books for insert
  with check (
    exists (
      select 1 from public.bundles
      where bundles.id = bundle_books.bundle_id
      and bundles.author_id = auth.uid()
    )
    and exists (
      select 1 from public.books
      where books.id = bundle_books.book_id
      and books.author_id = auth.uid()
    )
  );

create policy "Authors can remove books from their own bundles"
  on public.bundle_books for delete
  using (
    exists (
      select 1 from public.bundles
      where bundles.id = bundle_books.bundle_id
      and bundles.author_id = auth.uid()
    )
  );

create index bundle_books_bundle_id_idx on public.bundle_books(bundle_id);
create index bundle_books_book_id_idx on public.bundle_books(book_id);

-- ============================================================
-- bundle_checkout_snapshots: one durable row per bundle checkout
-- attempt. Freezes the exact books, titles, and prices a reader agreed
-- to buy at the moment they clicked "Buy bundle" -- fulfillment reads
-- from here, never from live bundles/bundle_books, so a later edit or
-- deletion of the bundle can never change what an in-flight or
-- already-completed checkout grants. See the Phase 9B-2 audit.
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
-- webhook's atomic fulfillment UPDATE -- it is the only Librum-side
-- record of the bundle's total paid amount that survives a reader later
-- deleting their account, since their purchases rows (which would
-- otherwise reconstruct this via SUM) cascade away with their profile.
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
-- (SECURITY DEFINER); the only legitimate reader is the Stripe webhook
-- (service role, bypasses RLS entirely -- no policy is added "for
-- symmetry", since a service-role policy would be inert).

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
-- status -- the webhook fan-out has never done this either, consistent
-- with Phase 8A's decision that legitimate access to an
-- already-acquired-but-now-unpublished book is preserved.
--
-- Takes no reader_id parameter -- always derives it from auth.uid(), so
-- a caller can only ever snapshot a checkout for themselves, never for
-- another reader.
--
-- Serializes concurrent calls for the same (reader, bundle) pair via a
-- transaction-scoped advisory lock, and reuses an existing active
-- (unfulfilled, unexpired) snapshot for that pair instead of creating a
-- second one -- see the Phase 9B-2 Stage 2C audit. A reused snapshot's
-- frozen values are returned verbatim; nothing about it is refreshed.
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
-- the same reasoning already established for user_owns_book() above.
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

-- ============================================================
-- discount_codes: an author's promo codes for one of their own books,
-- applied at Stripe Checkout. Only the author can list/manage their own
-- codes (see RLS below) — looking a code up by book_id+code at checkout
-- time is done server-side with the service role key, not through a
-- public select policy, so codes aren't enumerable by anyone browsing.
-- ============================================================

create table public.discount_codes (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  code text not null,
  percent_off integer check (percent_off between 1 and 100),
  amount_off_cents integer check (amount_off_cents > 0),
  active boolean not null default true,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (book_id, code),
  check ((percent_off is null) <> (amount_off_cents is null))
);

alter table public.discount_codes enable row level security;

create policy "Authors can view their own discount codes"
  on public.discount_codes for select
  using (auth.uid() = author_id);

create policy "Authors can create discount codes for their own books"
  on public.discount_codes for insert
  with check (
    auth.uid() = author_id
    and exists (
      select 1 from public.books
      where books.id = discount_codes.book_id
      and books.author_id = auth.uid()
    )
  );

create policy "Authors can update their own discount codes"
  on public.discount_codes for update
  using (auth.uid() = author_id);

create policy "Authors can delete their own discount codes"
  on public.discount_codes for delete
  using (auth.uid() = author_id);

create index discount_codes_book_id_idx on public.discount_codes(book_id);

-- ============================================================
-- storage: cover images (public) and manuscript files (private)
-- ============================================================

insert into storage.buckets (id, name, public)
values ('covers', 'covers', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('manuscripts', 'manuscripts', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- Files are stored as "<owner_id>/<filename>" so ownership can be
-- checked from the path itself via storage.foldername(name).

create policy "Cover images are publicly readable"
  on storage.objects for select
  using (bucket_id = 'covers');

create policy "Authors can upload their own cover images"
  on storage.objects for insert
  with check (bucket_id = 'covers' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Authors can replace their own cover images"
  on storage.objects for update
  using (bucket_id = 'covers' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Authors can upload their own manuscripts"
  on storage.objects for insert
  with check (bucket_id = 'manuscripts' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Authors can read their own manuscripts"
  on storage.objects for select
  using (bucket_id = 'manuscripts' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Authors can replace their own manuscripts"
  on storage.objects for update
  using (bucket_id = 'manuscripts' and auth.uid()::text = (storage.foldername(name))[1]);

-- deleteBook (src/app/dashboard/books/actions.ts) needs to remove an
-- author's own cover/manuscript files for a zero-acquisition book --
-- owner-scoped the same way as the insert/update policies above, never
-- public/anonymous. See the Phase 8 audit.
create policy "Authors can delete their own cover images"
  on storage.objects for delete
  using (bucket_id = 'covers' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Authors can delete their own manuscripts"
  on storage.objects for delete
  using (bucket_id = 'manuscripts' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Avatars are publicly readable"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "Users can upload their own avatar"
  on storage.objects for insert
  with check (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Users can replace their own avatar"
  on storage.objects for update
  using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

-- ============================================================
-- purchases: one row per completed sale, written only by the
-- Stripe webhook (via the service role key, which bypasses RLS) —
-- there is deliberately no insert policy for regular users.
-- ============================================================

create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  -- restrict, not cascade: a book with any acquisition history must
  -- never be deletable -- see the Phase 8 audit and
  -- 023_restrict_purchase_book_deletion.sql. Unlike bundle_id below
  -- (correctly "set null", since deleting a bundle shouldn't affect the
  -- per-book purchase records it fanned out to), book_id is the
  -- purchase's actual subject and must never be severed or allow its
  -- row to be cascaded away.
  book_id uuid not null references public.books(id) on delete restrict,
  reader_id uuid not null references public.profiles(id) on delete cascade,
  -- Not unique on its own: a bundle checkout is one Stripe session that
  -- fans out into one purchase row per book in the bundle, so several
  -- rows can share the same session id. (book_id, reader_id) below is
  -- still the real uniqueness guarantee.
  stripe_checkout_session_id text not null,
  stripe_payment_intent_id text,
  amount_cents integer not null,
  discount_code_id uuid references public.discount_codes(id) on delete set null,
  bundle_id uuid references public.bundles(id) on delete set null,
  refunded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (book_id, reader_id)
);

alter table public.purchases enable row level security;

create policy "Readers can view their own purchases"
  on public.purchases for select
  using (auth.uid() = reader_id);

create policy "Authors can view purchases of their own books"
  on public.purchases for select
  using (
    exists (
      select 1 from public.books
      where books.id = purchases.book_id
      and books.author_id = auth.uid()
    )
  );

-- Ranks bestselling books by real, non-refunded purchase count without
-- pulling every purchases row into the app to count in memory. security
-- definer is required since RLS above restricts purchases to the
-- reader/author involved in each row -- not a new privilege, since the
-- app's own admin/service-role client already bypasses RLS for this
-- exact aggregate elsewhere. Only ever returns (book_id, purchase_count)
-- -- never reader_id or amount_cents -- so it can't expose who bought
-- what.
--
-- EXECUTE is restricted to service_role only -- this reads across every
-- reader's purchase rows (bypassing the per-reader/author RLS scoping
-- above), so it must never be directly callable by a public/browser
-- client, only by the app's server-side admin client. result_limit is
-- clamped to 1-100 regardless of caller input (NULL, 0, negative, or
-- oversized all resolve to a safe bound).
create or replace function public.bestselling_books(
  book_ids uuid[] default null,
  result_limit int default null
)
returns table (book_id uuid, purchase_count bigint)
language sql
security definer
set search_path = ''
stable
as $$
  select purchases.book_id, count(*) as purchase_count
  from public.purchases
  where purchases.refunded_at is null
    and (book_ids is null or purchases.book_id = any(book_ids))
  group by purchases.book_id
  order by purchase_count desc
  limit least(greatest(coalesce(result_limit, 100), 1), 100);
$$;

revoke all on function public.bestselling_books(uuid[], int) from public;
revoke all on function public.bestselling_books(uuid[], int) from anon;
revoke all on function public.bestselling_books(uuid[], int) from authenticated;
grant execute on function public.bestselling_books(uuid[], int) to service_role;

-- Lets a reader who legitimately owns a book keep viewing its detail
-- page after the author unpublishes it (see the Phase 8/8A audit).
-- Declared here, after purchases, rather than alongside books' other
-- policies -- it queries purchases, so it must come after that table
-- is defined; a books policy further down in the file can still
-- reference it, since policies don't need to be textually adjacent to
-- their table.
--
-- WHY A HELPER FUNCTION, NOT A DIRECT POLICY: a books policy with an
-- inline "exists (select 1 from purchases where ...)" would create a
-- genuine two-table RLS cycle -- purchases already has a policy
-- ("Authors can view purchases of their own books") that queries
-- books, so a books policy querying purchases the other direction
-- closes that into a real, documented Postgres RLS recursion risk, not
-- just same-table self-reference. security definer breaks the cycle:
-- it executes its internal query as the function's owner, which
-- bypasses purchases' RLS entirely (table owners bypass RLS by
-- default; no FORCE ROW LEVEL SECURITY is set on purchases), so
-- calling it from a books policy never re-enters purchases' policies.
--
-- Returns ONLY true/false -- never a purchase row, amount, Stripe id,
-- or reader id. Takes no reader_id parameter -- always uses auth.uid()
-- internally, so a caller can only ever ask "do I own this," never
-- "does someone else."
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
  );
$$;

-- EXECUTE is restricted to authenticated only -- an anonymous visitor
-- has no auth.uid() to own anything with, so there is no reason to
-- grant it access at all.
revoke all on function public.user_owns_book(uuid) from public;
revoke all on function public.user_owns_book(uuid) from anon;
revoke all on function public.user_owns_book(uuid) from authenticated;
grant execute on function public.user_owns_book(uuid) to authenticated;

-- A SEPARATE policy from the existing
-- "Published books are viewable by everyone, drafts by their author"
-- policy near the top of this file -- that policy is left completely
-- unchanged. Postgres combines multiple permissive SELECT policies on
-- the same table with OR, so the effective visibility becomes
-- "published, or own author, or legitimately acquired" without
-- touching the existing policy's own logic or its role scope.
create policy "Owners can view books they've acquired"
  on public.books for select
  to authenticated
  using (public.user_owns_book(books.id));

create index purchases_reader_id_idx on public.purchases(reader_id);
create index purchases_book_id_idx on public.purchases(book_id);
create index purchases_payment_intent_idx on public.purchases(stripe_payment_intent_id);
create index purchases_checkout_session_idx on public.purchases(stripe_checkout_session_id);
create index purchases_bundle_id_idx on public.purchases(bundle_id);

-- ============================================================
-- reviews: one per reader per book — only buyers can write one,
-- resubmitting overwrites their existing review (see the unique
-- constraint + the app's upsert on book_id/reader_id)
-- ============================================================

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  reader_id uuid not null references public.profiles(id) on delete cascade,
  rating integer not null check (rating between 1 and 5),
  body text not null default '',
  created_at timestamptz not null default now(),
  unique (book_id, reader_id)
);

alter table public.reviews enable row level security;

create policy "Reviews are viewable by everyone"
  on public.reviews for select
  using (true);

-- refunded_at is null is required here (not just app-level) so a
-- refunded reader can't write a review via a direct API call -- see the
-- Phase 7 book detail page audit.
create policy "Buyers can review books they own"
  on public.reviews for insert
  with check (
    auth.uid() = reader_id
    and exists (
      select 1 from public.purchases
      where purchases.book_id = reviews.book_id
      and purchases.reader_id = auth.uid()
      and purchases.refunded_at is null
    )
  );

create policy "Readers can update their own review"
  on public.reviews for update
  using (auth.uid() = reader_id);

create policy "Readers can delete their own review"
  on public.reviews for delete
  using (auth.uid() = reader_id);

create index reviews_book_id_idx on public.reviews(book_id);

-- ============================================================
-- wishlist_items: a reader saves a book for later, no purchase implied
-- ============================================================

create table public.wishlist_items (
  id uuid primary key default gen_random_uuid(),
  reader_id uuid not null references public.profiles(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (reader_id, book_id)
);

alter table public.wishlist_items enable row level security;

create policy "Readers can view their own wishlist"
  on public.wishlist_items for select
  using (auth.uid() = reader_id);

create policy "Readers can add to their own wishlist"
  on public.wishlist_items for insert
  with check (auth.uid() = reader_id);

create policy "Readers can remove from their own wishlist"
  on public.wishlist_items for delete
  using (auth.uid() = reader_id);

create index wishlist_items_reader_id_idx on public.wishlist_items(reader_id);

-- ============================================================
-- author_follows: a reader opts in to a "new book" email whenever an
-- author they follow publishes. No public select policy — follower
-- identities aren't exposed to the client; follower counts and
-- notification recipient lists are read server-side with the service
-- role key instead.
-- ============================================================

create table public.author_follows (
  id uuid primary key default gen_random_uuid(),
  follower_id uuid not null references public.profiles(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (follower_id, author_id),
  check (follower_id <> author_id)
);

alter table public.author_follows enable row level security;

create policy "Readers can view their own follows"
  on public.author_follows for select
  using (auth.uid() = follower_id);

create policy "Readers can follow an author"
  on public.author_follows for insert
  with check (auth.uid() = follower_id);

create policy "Readers can unfollow an author"
  on public.author_follows for delete
  using (auth.uid() = follower_id);

create index author_follows_follower_id_idx on public.author_follows(follower_id);
create index author_follows_author_id_idx on public.author_follows(author_id);

-- ============================================================
-- book_reports: readers flag a book for review. Write-only from the
-- app's perspective — there's no in-app moderation UI yet, so there's
-- deliberately no select policy for regular users (not even the
-- reported book's own author). Review reports directly in the
-- Supabase dashboard's Table Editor for now.
-- ============================================================

create table public.book_reports (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null,
  details text not null default '',
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  created_at timestamptz not null default now()
);

alter table public.book_reports enable row level security;

create policy "Readers can report a book"
  on public.book_reports for insert
  with check (auth.uid() = reporter_id);

create index book_reports_book_id_idx on public.book_reports(book_id);
