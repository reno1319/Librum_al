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
