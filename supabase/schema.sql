-- Librum: self-publishing platform database schema.
-- Run this once in the Supabase SQL Editor (Dashboard > SQL Editor > New query)
-- after creating a new Supabase project.

-- ============================================================
-- profiles: one row per signed-up user (author or reader)
-- ============================================================

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  -- 'admin' (added by migration 028) is a durable, server-enforced
  -- marketplace-operator role -- see requireAdmin() in src/lib/auth.ts
  -- and the Phase REFUND-1A audit. Never settable by the user: signup
  -- (handle_new_user() below) only ever writes 'author' or 'reader',
  -- and UPDATE on this column is revoked from authenticated entirely
  -- (see below) -- promotion to admin is only ever a direct,
  -- privileged database operation.
  role text not null check (role in ('author', 'reader', 'admin')),
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

-- The UPDATE policy above is row-scoped only (auth.uid() = id), never
-- column-restricted -- Supabase's own default privilege provisioning
-- grants authenticated table-level UPDATE on every table it creates
-- (confirmed directly against a live project via
-- information_schema.role_table_grants, not merely assumed), so
-- without an explicit column restriction here, ANY column -- including
-- role, stripe_account_id, and stripe_payouts_enabled -- would be
-- directly PATCHable by an authenticated user via a raw API call on
-- their own row, regardless of what the application's own UI exposes.
--
-- A column-scoped REVOKE on just the sensitive columns (an earlier
-- version of this file did exactly that, matching what migration 003
-- originally shipped) does NOT work: Postgres table-level and
-- column-level grants are independent, additive ACL entries, not a
-- hierarchy -- a column-scoped REVOKE cannot narrow a still-standing
-- table-level GRANT, because no column-level grant on that column ever
-- existed to remove in the first place (see the Phase REFUND-1A
-- database-security review). The only correct fix is to revoke the
-- table-level grant entirely and re-grant UPDATE only on the columns
-- authenticated legitimately needs -- confirmed by tracing every
-- authenticated-client UPDATE against profiles in this codebase
-- (src/app/dashboard/profile/actions.ts's updateProfile()): only
-- display_name, bio, and avatar_path. role, stripe_account_id, and
-- stripe_payouts_enabled are written exclusively via the admin/
-- service-role client (src/app/dashboard/payouts/actions.ts,
-- src/app/dashboard/payouts/page.tsx) -- service_role is a separate
-- privilege grantee, entirely unaffected by anything revoked here.
revoke update on public.profiles from authenticated;

grant update (display_name, bio, avatar_path)
  on public.profiles
  to authenticated;

-- Auto-create a profile row whenever someone signs up, using the
-- role/display_name passed in from the signup form's metadata. Role
-- resolution is a WHITELIST, not a passthrough (tightened by migration
-- 028 when 'admin' became a valid column value): only an exact 'author'
-- match is honored, anything else -- including 'admin', or any other
-- value a crafted signup request might submit -- becomes 'reader'.
-- Before that migration, the CHECK constraint accepting only
-- 'author'/'reader' was the sole thing preventing a crafted
-- raw_user_meta_data.role from creating a privileged profile; this
-- makes that safe independent of the constraint's exact value set.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, role, display_name)
  values (
    new.id,
    case
      when new.raw_user_meta_data->>'role' = 'author' then 'author'
      else 'reader'
    end,
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
--
-- stripe_payment_intent_id/refunded_at (added by migration 027) make
-- this row the durable transaction/payment record for a snapshot bundle
-- checkout, independent of how many (if any) purchases rows it produced
-- -- see that migration's own comment for the full Phase 9B-2
-- zero-eligible-item rationale. stripe_payment_intent_id is UNIQUE,
-- unlike purchases.stripe_payment_intent_id: one snapshot maps to
-- exactly one Stripe Checkout Session (stripe_checkout_session_id above
-- is already unique on this table) and a "payment" mode session has
-- exactly one PaymentIntent, so this is genuinely 1:1, and the
-- constraint catches a real bug class rather than being decorative.
-- NULL is expected and unconstrained (a free/$0 bundle fulfillment never
-- gets a Stripe PaymentIntent at all, and pre-fulfillment rows haven't
-- been paid yet).
create table public.bundle_checkout_snapshots (
  id uuid primary key default gen_random_uuid(),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text unique,
  bundle_id uuid references public.bundles(id) on delete set null,
  bundle_title text not null,
  author_id uuid references public.profiles(id) on delete set null,
  reader_id uuid references public.profiles(id) on delete set null,
  bundle_price_cents_at_checkout integer not null,
  total_amount_cents integer,
  items jsonb not null,
  protection_expires_at timestamptz not null,
  fulfilled_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.bundle_checkout_snapshots enable row level security;

-- No reader-facing policy is added -- nothing in the product surfaces
-- "my pending checkout" to a reader anywhere, and the Stripe webhook
-- (service role, bypasses RLS entirely) is the only writer/fulfiller.
--
-- One SELECT policy exists, added by migration 027 once the sales
-- dashboard needed to fold a fulfilled bundle's total_amount_cents into
-- an author's own revenue reporting (see the Phase 9B-2 zero-eligible-
-- item accounting fix) using the ordinary, RLS-respecting client rather
-- than the admin client. Scoped as narrowly as that need: auth.uid() =
-- author_id (same scoping as "Authors can view purchases of their own
-- books" on purchases below -- no reader access is granted by this
-- policy at all), and fulfilled_at is not null, so an in-flight, unpaid,
-- or expired checkout attempt stays exactly as invisible to its own
-- author as it always was.
create policy "Authors can view their own fulfilled bundle snapshot transactions"
  on public.bundle_checkout_snapshots
  for select
  using (
    auth.uid() = author_id
    and fulfilled_at is not null
  );

-- Added by migration 030 (Phase REFUND-1B Step 2 correction): the
-- reader-side counterpart to the author policy above, same shape,
-- reader_id instead of author_id. No GRANT/REVOKE accompanies this --
-- see migration 030's own comment for why the existing ambient
-- table-level SELECT privilege already covers it.
create policy "Readers can view their own fulfilled bundle snapshot transactions"
  on public.bundle_checkout_snapshots
  for select
  using (
    auth.uid() = reader_id
    and fulfilled_at is not null
  );

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

-- with check mirrors the insert policy's ownership check exactly (see
-- migration 031 for the full reasoning): without it, only author_id was
-- re-verified on update -- book_id (and every other column) was
-- completely unconstrained, letting an author repoint their own code at
-- a book they don't own via a raw API call.
create policy "Authors can update their own discount codes"
  on public.discount_codes for update
  using (auth.uid() = author_id)
  with check (
    auth.uid() = author_id
    and exists (
      select 1 from public.books
      where books.id = discount_codes.book_id
      and books.author_id = auth.uid()
    )
  );

create policy "Authors can delete their own discount codes"
  on public.discount_codes for delete
  using (auth.uid() = author_id);

create index discount_codes_book_id_idx on public.discount_codes(book_id);

-- Column-level grant, same two-layer pattern as public.profiles above:
-- the app's only UPDATE call (toggleDiscountCode) ever names just
-- `active` in its payload -- see migration 031 for why this is safe
-- (a plain .update(), not an upsert) and why the equivalent restriction
-- is deliberately NOT applied to reviews below. Revokes from BOTH anon
-- and authenticated (see migration 031's own comment on this exact
-- line for why authenticated-only, mirroring the profiles pattern
-- above, was insufficient here).
revoke update on public.discount_codes from anon, authenticated;

grant update (active)
  on public.discount_codes
  to authenticated;

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

-- with check mirrors the insert policy's ownership+refund check exactly
-- (see migration 031 for the full reasoning, including why this is
-- required -- not merely defensive -- for submitReview's own genuine
-- upsert-based edit flow to keep working, and why no column-level grant
-- restriction is applied here unlike discount_codes above). Without
-- this, only reader_id was re-verified on update -- book_id was
-- completely unconstrained, and a refunded reader's review could be
-- edited indefinitely.
create policy "Readers can update their own review"
  on public.reviews for update
  using (auth.uid() = reader_id)
  with check (
    auth.uid() = reader_id
    and exists (
      select 1 from public.purchases
      where purchases.book_id = reviews.book_id
      and purchases.reader_id = auth.uid()
      and purchases.refunded_at is null
    )
  );

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

-- Dependency order note: is_admin() is defined FIRST, before either
-- table, because both tables' "admin can view all" SELECT policies
-- reference it -- CREATE POLICY's USING expression is resolved at
-- creation time, not deferred, so the function must already exist. An
-- earlier draft of this migration defined is_admin() after both tables
-- (grouped with the other functions for readability) and failed to
-- apply for exactly this reason: "function public.is_admin() does not
-- exist". Every other object below follows the same rule -- nothing is
-- referenced before it is created -- see the ordering audit in the
-- Phase REFUND-1B implementation report for the full pass over this
-- file.
-- ============================================================
-- is_admin(): shared SECURITY DEFINER primitive for every admin-gated
-- RLS policy this and future phases need (refund review now; content
-- moderation, support tooling, etc. later -- see the Phase REFUND-1A
-- goal). Hardened per the Phase REFUND-1B security review: empty
-- search_path and a fully schema-qualified body, so nothing it touches
-- can be shadowed by an object in a schema the caller controls --
-- matches the same pattern already used by create_bundle_checkout_
-- snapshot(), user_owns_book(), and bestselling_books() in this file.
-- Depends only on public.profiles, which already exists as of
-- migration 001 -- no ordering dependency on anything else in this
-- file.
-- ============================================================

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = 'admin'
  );
$$;

revoke all on function public.is_admin() from public;
revoke all on function public.is_admin() from anon;
revoke all on function public.is_admin() from authenticated;
grant execute on function public.is_admin() to authenticated;

-- ============================================================
-- refund_requests: one durable row per reader-initiated refund request,
-- always for an entire Stripe transaction (full-transaction refunds
-- only -- see the approved Phase REFUND-1B decisions; there is no
-- partial-amount concept anywhere in this design).
-- ============================================================

create table public.refund_requests (
  id uuid primary key default gen_random_uuid(),
  -- Nullable, ON DELETE SET NULL -- not RESTRICT, and not the CASCADE
  -- purchases.reader_id itself uses. This is a financial/audit record:
  -- deleting the owning profile must not silently delete the record of
  -- what was requested, only detach it from the (now-gone) profile.
  -- request_refund() below always populates this from auth.uid() at
  -- creation time -- NULL is only ever reached afterward, as the result
  -- of profile deletion, never inserted directly.
  reader_id uuid references public.profiles(id) on delete set null,
  stripe_payment_intent_id text not null,
  -- Nullable: only populated for snapshot-based bundle purchases;
  -- legacy bundles and single-book purchases have no snapshot row.
  bundle_checkout_snapshot_id uuid references public.bundle_checkout_snapshots(id) on delete set null,
  -- Transaction-level amount, derived and validated by request_refund()
  -- -- never supplied by the client. NOT simply
  -- SUM(refund_request_items.amount_cents): for a bundle purchase where
  -- every book was already owned (the zero-eligible-item case from the
  -- Phase 9B-2 accounting audit), zero purchases rows exist for this
  -- payment intent at all, so refund_request_items is legitimately
  -- empty -- the only authoritative amount in that case is
  -- bundle_checkout_snapshots.total_amount_cents. See request_refund()'s
  -- own derivation of this value below.
  amount_cents integer not null check (amount_cents > 0),
  reason text check (reason is null or char_length(reason) <= 2000),
  status text not null default 'requested'
    check (status in ('requested', 'approved', 'rejected', 'refunded', 'cancelled')),
  requested_at timestamptz not null default now(),
  -- Nullable on purpose: a direct Stripe Dashboard refund (requested ->
  -- refunded with no prior approval step -- see the webhook's future
  -- extension, not part of this migration) leaves these null. That is a
  -- legitimate, expected terminal state, not a data gap.
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null,
  admin_notes text,
  refunded_at timestamptz,
  created_at timestamptz not null default now()
);

-- Prevents a reader from having two concurrently-open requests for the
-- same Stripe transaction. Partial (status-scoped), not a plain unique
-- constraint, so a rejected/cancelled request can still be followed by
-- a fresh one later. request_refund() also checks this explicitly
-- before inserting, to raise a friendly error rather than surface this
-- constraint's raw violation -- this index is the DB-level backstop for
-- that check, not the caller's only line of defense against it.
create unique index refund_requests_open_payment_intent_idx
  on public.refund_requests (stripe_payment_intent_id)
  where status in ('requested', 'approved');

create index refund_requests_reader_id_idx on public.refund_requests(reader_id);
create index refund_requests_status_idx on public.refund_requests(status);

alter table public.refund_requests enable row level security;

-- Explicit least-privilege table grants, rather than relying on RLS
-- policies alone to narrow whatever table-level privilege Supabase's
-- default privilege provisioning happens to hand anon/authenticated on
-- a newly created public-schema table. This is the same lesson already
-- learned twice in this codebase -- migration 028's profiles fix (a
-- standing table-level GRANT isn't narrowed by a column-scoped REVOKE)
-- and the Phase REFUND-1B security audit that found this table's own
-- earlier UPDATE policies were only safe because nobody had yet
-- exploited the untouched table-level grant behind them -- so here the
-- privilege model is stated outright instead of left implicit: revoke
-- everything, then grant back only SELECT. INSERT/UPDATE/DELETE are
-- never granted to anon or authenticated at all, on either role, at any
-- point in this file -- every mutation happens exclusively through the
-- SECURITY DEFINER functions below (request_refund(),
-- cancel_refund_request(), review_refund_request()), which run as the
-- function owner and are therefore unaffected by these revokes.
-- service_role is untouched by both statements below (only anon and
-- authenticated are named) and keeps its own separate, Supabase-
-- provisioned privileges -- the future webhook extension that will
-- write status = 'refunded' runs under service_role, same as every
-- other webhook write in this schema (see fulfillBundleSnapshot() in
-- src/app/api/webhooks/stripe/route.ts), and needs no grant here.
revoke all on public.refund_requests from anon, authenticated;
grant select on public.refund_requests to authenticated;

-- The SELECT policies below are still required -- the GRANT above only
-- says authenticated may run SELECT statements against this table at
-- all; RLS is what narrows which rows a given SELECT actually returns.
-- No INSERT/UPDATE/DELETE policy is defined for this table anywhere in
-- this file: with RLS enabled, zero policies for a command denies it
-- outright for every role regardless of any table-level grant -- and as
-- of the revoke above, there is no table-level grant for those commands
-- to fall back on in the first place. Two independent layers now agree:
-- privilege (no grant) and RLS (no policy).
create policy "Readers can view their own refund requests"
  on public.refund_requests
  for select
  using (auth.uid() = reader_id);

create policy "Admins can view all refund requests"
  on public.refund_requests
  for select
  using (public.is_admin());

-- Deliberately NO update policy for authenticated (or anyone) here
-- either. An earlier draft of this migration allowed direct
-- authenticated UPDATE through two row/status-scoped policies (reader:
-- requested -> cancelled; admin: requested -> approved/rejected). A
-- pre-implementation security audit found that RLS is row-scoped, not
-- column-scoped: WITH CHECK only constrains the *status* column's new
-- value, so nothing stopped a caller who legitimately satisfied one of
-- those policies from ALSO rewriting every other column on the same
-- row in the same statement -- amount_cents, stripe_payment_intent_id,
-- bundle_checkout_snapshot_id, reader_id, reviewed_by, reviewed_at,
-- refunded_at, admin_notes -- none of which WITH CHECK examined.
--
-- The fix: close the raw-UPDATE surface entirely (policies removed
-- here; the revoke-all grant above already means authenticated holds
-- no table-level UPDATE privilege to fall back on regardless) and
-- replace both transitions with narrow SECURITY DEFINER RPCs --
-- cancel_refund_request() and review_refund_request(), defined after
-- request_refund() below -- that update only the exact columns each
-- transition needs and derive every identity/timestamp value
-- (auth.uid(), now()) internally rather than trusting client-supplied
-- column values. This matches the pattern this schema already uses
-- everywhere else a value must be trustworthy (request_refund() itself
-- never accepts reader_id or amount_cents as arguments, for the same
-- reason).

-- ============================================================
-- refund_request_items: the per-book line items a refund_requests row
-- covers, frozen at request-creation time by request_refund() --
-- mirrors how bundle_checkout_snapshots freezes items/prices rather
-- than re-deriving them live. Can be empty for a request whose
-- transaction produced zero purchases rows (the zero-eligible-item
-- bundle case) -- amount_cents on the parent refund_requests row is
-- still correctly populated in that case; see above.
-- ============================================================

create table public.refund_request_items (
  id uuid primary key default gen_random_uuid(),
  refund_request_id uuid not null references public.refund_requests(id) on delete cascade,
  -- Nullable, ON DELETE SET NULL: purchases.reader_id cascades on
  -- profile deletion (existing, already-shipped behavior -- see
  -- schema.sql), so a purchases row this line item points at can be
  -- deleted out from under it as a side effect of the reader's account
  -- being deleted. RESTRICT here would then block that entire profile
  -- deletion from completing at all -- exactly the problem
  -- refund_requests.reader_id's own ON DELETE SET NULL exists to avoid,
  -- just one join further away. book_id and amount_cents below are
  -- untouched by this -- both are frozen at request-creation time and
  -- remain fully intact even if purchase_id later becomes null, so the
  -- audit record still answers "which book, how much" regardless.
  -- request_refund() always inserts a real purchase_id for every
  -- purchase-backed line item -- NULL is only ever reached afterward.
  purchase_id uuid references public.purchases(id) on delete set null,
  book_id uuid not null references public.books(id) on delete restrict,
  amount_cents integer not null check (amount_cents > 0),
  unique (refund_request_id, purchase_id)
);

create index refund_request_items_refund_request_id_idx on public.refund_request_items(refund_request_id);

alter table public.refund_request_items enable row level security;

-- Same explicit least-privilege grant as refund_requests above, for
-- the same reason: state the privilege model outright rather than
-- relying on RLS alone to narrow an implicit table-level grant.
-- service_role is untouched (only anon and authenticated are named).
revoke all on public.refund_request_items from anon, authenticated;
grant select on public.refund_request_items to authenticated;

-- No insert/update/delete policy for authenticated here either --
-- request_refund() (SECURITY DEFINER) is the sole writer; deleting a
-- refund_requests row cascades these away automatically, and nothing
-- in this design ever updates an existing line item in place. As with
-- refund_requests, this is now doubly enforced: no table-level grant
-- for those commands (revoke above) and no RLS policy for them either.
create policy "Readers can view items on their own refund requests"
  on public.refund_request_items
  for select
  using (
    exists (
      select 1 from public.refund_requests
      where refund_requests.id = refund_request_items.refund_request_id
        and refund_requests.reader_id = auth.uid()
    )
  );

create policy "Admins can view all refund request items"
  on public.refund_request_items
  for select
  using (public.is_admin());

-- ============================================================
-- request_refund(): the sole path by which a refund_requests row (and
-- its refund_request_items) can ever be created. SECURITY DEFINER so
-- it can read/write past this table's otherwise-empty INSERT policy
-- surface, but every financial and ownership fact it uses is derived
-- and re-validated from authoritative tables inside this function --
-- never trusted from its own arguments. Hardened the same way as
-- is_admin() above: empty search_path, every table/function reference
-- schema-qualified. Genuine pg_catalog functions used below (length,
-- char_length, now, sum, min, count) are additionally qualified as
-- pg_catalog.* for consistency, though this is belt-and-suspenders --
-- pg_catalog is implicitly searched first regardless of search_path (it
-- is unconditionally consulted before any explicit path entry, and here
-- the explicit path is empty), so these could never actually be
-- shadowed even left unqualified. coalesce and nullif are deliberately
-- left unqualified: per the SQL standard, COALESCE/NULLIF are special
-- conditional expressions parsed directly by the SQL grammar, not
-- schema-resolvable function calls, so they carry no search_path
-- exposure and pg_catalog.coalesce(...)/pg_catalog.nullif(...) is not
-- valid syntax to begin with. The bare trim(...) calls below are left
-- unqualified for the same reason: PostgreSQL's TRIM(...) is SQL-
-- standard special syntax, not a plain call to a catalog function
-- literally named "trim" (the standard syntax is rewritten internally
-- to btrim/ltrim/rtrim) -- qualifying it as pg_catalog.trim(...) risks
-- referencing a function that does not exist under that name, for no
-- security benefit, since the special syntax is immune to search_path
-- shadowing by construction.
--
-- Arguments accepted from the client -- exactly these two, nothing
-- else:
--   p_stripe_payment_intent_id: a lookup key, not a financial or
--     ownership claim. The reader's own client already has legitimate
--     visibility into it via their own purchases rows.
--   p_reason: free text, no financial/ownership implication, length-
--     capped by this table's own CHECK constraint.
--
-- Everything else -- reader_id, whether this payment intent is really
-- theirs, whether it's already refunded, whether it's still within the
-- 14-day window, whether a request is already open for it, the exact
-- line items, and the transaction-level amount -- is derived and
-- validated here, never accepted as input.
-- ============================================================

create or replace function public.request_refund(
  p_stripe_payment_intent_id text,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reader_id uuid;
  v_snapshot record;
  v_purchase_reader_count int;
  v_earliest_created_at timestamptz;
  v_amount_cents integer;
  v_request_id uuid;
  v_open_count int;
begin
  v_reader_id := auth.uid();
  if v_reader_id is null then
    raise exception 'not authenticated';
  end if;

  if p_stripe_payment_intent_id is null or pg_catalog.length(trim(p_stripe_payment_intent_id)) = 0 then
    raise exception 'stripe_payment_intent_id is required';
  end if;

  -- Ownership verification (anti-spoofing): at least one purchases row
  -- for this exact payment intent must belong to the caller, OR the
  -- matching bundle_checkout_snapshots row (if any) must belong to the
  -- caller -- the latter covers the zero-eligible-item bundle case,
  -- where no purchases row exists for this payment intent at all. A
  -- reader can never request a refund for a transaction that isn't
  -- theirs, even if they somehow learn or guess its payment intent id.
  select pg_catalog.count(*) into v_purchase_reader_count
  from public.purchases
  where purchases.stripe_payment_intent_id = p_stripe_payment_intent_id
    and purchases.reader_id = v_reader_id;

  select bcs.id, bcs.reader_id, bcs.total_amount_cents, bcs.fulfilled_at, bcs.refunded_at
  into v_snapshot
  from public.bundle_checkout_snapshots bcs
  where bcs.stripe_payment_intent_id = p_stripe_payment_intent_id;

  if v_purchase_reader_count = 0
     and (v_snapshot.id is null or v_snapshot.reader_id is distinct from v_reader_id) then
    raise exception 'no matching purchase found for this payment intent';
  end if;

  -- Already-refunded check -- full-transaction refunds only, so a
  -- single check covers it: any matching purchases row already
  -- refunded, or the matching snapshot already refunded, blocks a new
  -- request outright.
  if exists (
    select 1
    from public.purchases
    where purchases.stripe_payment_intent_id = p_stripe_payment_intent_id
      and purchases.reader_id = v_reader_id
      and purchases.refunded_at is not null
  ) or (v_snapshot.id is not null and v_snapshot.refunded_at is not null) then
    raise exception 'this purchase has already been refunded';
  end if;

  -- 14-day eligibility window (approved Phase REFUND-1B decision),
  -- measured from the earliest matching purchases row, or the
  -- snapshot's fulfilled_at when there are no purchases rows at all.
  -- This gates SUBMISSION only -- it says nothing about approval.
  select pg_catalog.min(purchases.created_at) into v_earliest_created_at
  from public.purchases
  where purchases.stripe_payment_intent_id = p_stripe_payment_intent_id
    and purchases.reader_id = v_reader_id;

  if v_earliest_created_at is null then
    v_earliest_created_at := v_snapshot.fulfilled_at;
  end if;

  if v_earliest_created_at is null or v_earliest_created_at < (pg_catalog.now() - interval '14 days') then
    raise exception 'this purchase is outside the refund request window';
  end if;

  -- Existing-open-request check -- a friendlier error than the raw
  -- unique index violation, which still exists as the DB-level
  -- backstop for this same rule.
  select pg_catalog.count(*) into v_open_count
  from public.refund_requests
  where refund_requests.stripe_payment_intent_id = p_stripe_payment_intent_id
    and refund_requests.status in ('requested', 'approved');

  if v_open_count > 0 then
    raise exception 'a refund request for this purchase is already open';
  end if;

  -- Transaction-level amount: sum of this reader's own purchases rows
  -- for this payment intent, or the snapshot's own total when there are
  -- none (the zero-eligible-item bundle case) -- see the Phase 9B-2
  -- accounting audit for why purchases rows alone are not always
  -- authoritative for a bundle transaction's full amount.
  select coalesce(pg_catalog.sum(purchases.amount_cents), 0) into v_amount_cents
  from public.purchases
  where purchases.stripe_payment_intent_id = p_stripe_payment_intent_id
    and purchases.reader_id = v_reader_id;

  if v_amount_cents = 0 then
    v_amount_cents := v_snapshot.total_amount_cents;
  end if;

  if v_amount_cents is null or v_amount_cents <= 0 then
    raise exception 'unable to determine a refundable amount for this payment intent';
  end if;

  insert into public.refund_requests (
    reader_id, stripe_payment_intent_id, bundle_checkout_snapshot_id,
    amount_cents, reason, status
  )
  values (
    v_reader_id, p_stripe_payment_intent_id, v_snapshot.id,
    v_amount_cents, nullif(trim(coalesce(p_reason, '')), ''), 'requested'
  )
  returning id into v_request_id;

  -- Line items: one per this reader's own purchases row on this payment
  -- intent with a positive amount. A legitimate $0 row (e.g. a free
  -- book bundled alongside paid ones) is still part of the transaction
  -- the webhook will later revoke entitlement for -- it just has no
  -- money to audit, so it gets no line item here (see this table's own
  -- CHECK (amount_cents > 0)).
  insert into public.refund_request_items (refund_request_id, purchase_id, book_id, amount_cents)
  select v_request_id, purchases.id, purchases.book_id, purchases.amount_cents
  from public.purchases
  where purchases.stripe_payment_intent_id = p_stripe_payment_intent_id
    and purchases.reader_id = v_reader_id
    and purchases.amount_cents > 0;

  return v_request_id;
end;
$$;

revoke all on function public.request_refund(text, text) from public;
revoke all on function public.request_refund(text, text) from anon;
revoke all on function public.request_refund(text, text) from authenticated;
grant execute on function public.request_refund(text, text) to authenticated;

-- ============================================================
-- cancel_refund_request(): the sole path by which a reader may move
-- their own refund_requests row from 'requested' to 'cancelled'. Exists
-- because direct authenticated UPDATE on refund_requests is revoked
-- above (see the comment on that revoke) -- an RLS policy's WITH CHECK
-- can only constrain the status column's new value, not pin every other
-- column to its prior value, so a raw UPDATE surface would let a caller
-- ride arbitrary column changes alongside a legitimate status
-- transition. This function only ever writes status, nothing else.
-- ============================================================

create or replace function public.cancel_refund_request(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reader_id uuid;
  v_updated_id uuid;
begin
  v_reader_id := auth.uid();
  if v_reader_id is null then
    raise exception 'not authenticated';
  end if;

  update public.refund_requests
  set status = 'cancelled'
  where id = p_id
    and reader_id = v_reader_id
    and status = 'requested'
  returning id into v_updated_id;

  if v_updated_id is null then
    raise exception 'no cancellable refund request found for this id';
  end if;
end;
$$;

revoke all on function public.cancel_refund_request(uuid) from public;
revoke all on function public.cancel_refund_request(uuid) from anon;
revoke all on function public.cancel_refund_request(uuid) from authenticated;
grant execute on function public.cancel_refund_request(uuid) to authenticated;

-- ============================================================
-- review_refund_request(): the sole path by which an admin may move a
-- refund_requests row from 'requested' to 'approved' or 'rejected'.
-- Same rationale as cancel_refund_request() above -- direct
-- authenticated UPDATE is revoked, so this is the only way to write
-- these columns. reviewed_by and reviewed_at are always derived
-- internally (auth.uid(), now()) and can never be supplied by the
-- caller, so an admin can never backdate a review or attribute it to a
-- different admin. p_decision only ever accepts 'approved' or
-- 'rejected' -- 'refunded' is not a reachable value through this
-- function (or through any other authenticated-accessible path; see
-- the revoked update above and the absence of any UPDATE policy).
-- ============================================================

create or replace function public.review_refund_request(
  p_id uuid,
  p_decision text,
  p_admin_notes text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_id uuid;
  v_updated_id uuid;
begin
  v_admin_id := auth.uid();
  if v_admin_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  if p_decision not in ('approved', 'rejected') then
    raise exception 'p_decision must be ''approved'' or ''rejected''';
  end if;

  -- Same 2000-character cap as refund_requests.reason, for consistency.
  if p_admin_notes is not null and pg_catalog.char_length(p_admin_notes) > 2000 then
    raise exception 'p_admin_notes must be 2000 characters or fewer';
  end if;

  update public.refund_requests
  set status = p_decision,
      reviewed_at = pg_catalog.now(),
      reviewed_by = v_admin_id,
      admin_notes = nullif(trim(coalesce(p_admin_notes, '')), '')
  where id = p_id
    and status = 'requested'
  returning id into v_updated_id;

  if v_updated_id is null then
    raise exception 'no reviewable refund request found for this id';
  end if;
end;
$$;

revoke all on function public.review_refund_request(uuid, text, text) from public;
revoke all on function public.review_refund_request(uuid, text, text) from anon;
revoke all on function public.review_refund_request(uuid, text, text) from authenticated;
grant execute on function public.review_refund_request(uuid, text, text) to authenticated;
