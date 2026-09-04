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
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Table-level ACL is what actually protects role/stripe_account_id/
-- stripe_payouts_enabled from a raw authenticated/anon PATCH -- RLS's
-- USING/WITH CHECK above only ever constrain which ROW, never which
-- COLUMNS, so without an explicit ACL restriction ANY column would be
-- directly writable on the caller's own row regardless of what the
-- application's own UI exposes.
--
-- A column-scoped REVOKE on just the sensitive columns (an earlier
-- version of this file did exactly that, matching what migration 003
-- originally shipped) does NOT work: Postgres table-level and
-- column-level grants are independent, additive ACL entries, not a
-- hierarchy -- a column-scoped REVOKE cannot narrow a still-standing
-- table-level GRANT, because no column-level grant on that column ever
-- existed to remove in the first place (see the Phase REFUND-1A
-- database-security review). Nor is a targeted `revoke update ...`
-- alone sufficient once more than one role is in play: migration 028
-- correctly revoked and re-granted for authenticated, but never touched
-- anon -- REVOKE/GRANT are per-role, independent ACL entries, so
-- narrowing one role's privileges has zero effect on another's. anon
-- retained Supabase's full ambient default privileges (SELECT, INSERT,
-- UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER) on every column until
-- LAUNCH-1 P1-5 (migration 033) closed it -- the exact same defect
-- class already found and fixed for discount_codes/reviews (migration
-- 031) and refund_requests (migration 029).
--
-- Reset-and-regrant, not a narrower REVOKE: removes every privilege
-- type Supabase's own ambient defaults hand out (not just UPDATE) for
-- both anon and authenticated, then re-grants exactly what each
-- legitimately needs -- confirmed by tracing every authenticated-client
-- write against profiles in this codebase
-- (src/app/dashboard/profile/actions.ts's updateProfile()): only
-- display_name, bio, and avatar_path. role, stripe_account_id, and
-- stripe_payouts_enabled are written exclusively via the admin/
-- service-role client (src/app/dashboard/payouts/actions.ts,
-- src/app/dashboard/payouts/page.tsx) -- service_role is a separate
-- privilege grantee, entirely unaffected by anything revoked here.
-- Neither role gets INSERT or DELETE -- profiles has zero RLS policies
-- for either command, so both are already unconditionally blocked
-- regardless of ACL; this makes that inertness structural rather than
-- incidental. anon gets no UPDATE grant at all, on any column -- it has
-- no legitimate reason to update anything on this table.
revoke all on public.profiles from anon, authenticated;

grant select
  on public.profiles
  to anon, authenticated;

grant update (display_name, bio, avatar_path)
  on public.profiles
  to authenticated;

-- ============================================================
-- staff_members: ADMIN-1A's staff/RBAC foundation, replacing binary
-- profiles.role = 'admin' authorization. One row per staff member, keyed
-- by profile id -- a staff member is always also a profile. role is a
-- single persisted string; permissions are NOT persisted here or
-- anywhere in the database -- they are defined exactly once, in
-- TypeScript, at src/lib/staff-permissions.ts. The only database-side
-- copy of the role->permission matrix is the small, explicitly
-- synchronized CASE expression inside staff_has_permission() further
-- below (placed after is_admin(), for the same dependency-order reason
-- is_admin() itself is placed after profiles: nothing in this file may
-- be referenced before it is created).
--
-- profiles.role and is_admin() (below) are deliberately left in place,
-- unused by any remaining application call site as of this migration --
-- an explicit temporary compatibility layer, not a decision that nothing
-- ever depends on them; removal is future cleanup work, not part of
-- ADMIN-1A.
-- ============================================================

create table public.staff_members (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'editor', 'moderator', 'support')),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.staff_members enable row level security;

revoke all on public.staff_members from anon, authenticated;
grant select on public.staff_members to authenticated;

create policy "Staff can view their own staff_members row"
  on public.staff_members
  for select
  using (auth.uid() = user_id);

-- The broader "staff.view can see every row" policy is deferred to
-- later in this file, alongside staff_has_permission()'s own definition
-- -- CREATE POLICY's USING expression is resolved at creation time, and
-- that function does not exist yet at this point in the file. Same
-- ordering rule already established for book_reports' admin policy; see
-- that table's own comment for the fuller explanation of why this file
-- is laid out this way instead of moving is_admin()/staff_has_permission()
-- earlier.

-- Deliberately no insert/update/delete policy for any role, anywhere --
-- combined with the revoke above (no table-level grant for those
-- commands either), self-promotion is structurally impossible: no
-- client request of any kind can create or modify a row here. The only
-- writer, ever, is this schema's own owner-bootstrap backfill directly
-- below (running as the migration-applying/schema-setup role, which
-- bypasses RLS) -- and, in the future, a service-role or SECURITY
-- DEFINER staff-management RPC (ADMIN-1B).
--
-- Owner bootstrap: every existing profiles.role = 'admin' row becomes an
-- 'owner' in staff_members, not merely 'admin' -- deliberate, not the
-- narrowest possible mapping. An 'admin'-role staff member has every
-- permission an 'owner' has except staff.manage, which did not exist as
-- a concept before this table -- but staff.manage is meaningless for the
-- platform's whole future if zero rows can ever hold it, since there is
-- no self-promotion path and no staff-management UI exists yet to grant
-- it to anyone. Backfilling as 'owner' avoids that bootstrapping
-- deadlock. No email or UUID is hardcoded -- every currently-trusted
-- admin is carried forward automatically from profiles.role. created_by
-- is left NULL: this row was not granted by any staff member's action,
-- it was inherited from legacy state by this schema itself.
insert into public.staff_members (user_id, role, created_by)
select id, 'owner', null
from public.profiles
where role = 'admin'
on conflict (user_id) do nothing;

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
--
-- search_path is the empty string (LAUNCH-1 P1-6), matching every
-- other SECURITY DEFINER function in this schema -- every table
-- reference below is already schema-qualified (public.profiles), and
-- the one unqualified call (split_part, below) resolves via pg_catalog
-- regardless, since pg_catalog is always implicitly searched first
-- unless explicitly repositioned in search_path. This was confirmed
-- non-exploitable even under the previous `search_path = public`
-- setting by the P1-6 audit; the change is for consistency/auditability,
-- not a live exploit closure.
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
$$ language plpgsql security definer set search_path = '';

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- EXECUTE is revoked from public/anon/authenticated (LAUNCH-1 P1-6),
-- the same belt-and-suspenders treatment already given to this
-- schema's other two trigger functions below (clear_expired_book_
-- reservations, clear_expired_reader_holds). Cannot break signup:
-- RETURNS TRIGGER already makes direct invocation structurally
-- impossible ("trigger functions can only be called as triggers"), and
-- the trigger mechanism itself never checks EXECUTE privilege on the
-- function it fires.
revoke all on function public.handle_new_user() from public, anon, authenticated;

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
  using (auth.uid() = author_id)
  with check (auth.uid() = author_id);

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
  -- LIBRUM 2.0 PUBLISHING-UX-1 PART B (migration 044): subtitle/
  -- publisher/edition each carry a conservative length CHECK -- new
  -- public-facing bibliographic fields with no existing length
  -- precedent on this table to inherit.
  subtitle text check (subtitle is null or char_length(subtitle) <= 300),
  description text not null default '',
  preview_text text not null default '',
  keywords text not null default '',
  isbn text,
  -- language is deliberately NOT constrained by a DB CHECK -- the
  -- launch language set (sq/en/it -- see src/lib/languages.ts) is
  -- product configuration, validated in TypeScript at every write path
  -- (createBook()/updateBook()), not a permanent database invariant.
  language text,
  publisher text check (publisher is null or char_length(publisher) <= 200),
  edition text check (edition is null or char_length(edition) <= 100),
  original_publication_date date,
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
  -- system-authoritative -- set exactly once by performPublish() on a
  -- genuine draft -> published transition, never accepted from author-
  -- submitted form data, never overwritten by a later unpublish/
  -- republish cycle. See migration 044's own comment for full semantics.
  published_at timestamptz,
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
  using (auth.uid() = author_id)
  with check (auth.uid() = author_id);

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
  using (auth.uid() = author_id)
  with check (auth.uid() = author_id);

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

-- Explicit least-privilege table grant (LAUNCH-1 P1-6), same rationale
-- as purchases above: both SELECT policies below require auth.uid(),
-- so anon gets nothing, and every request-scoped read (library.page.
-- tsx's refund-window grouping, dashboard/sales/page.tsx's revenue
-- rollup) runs behind an already-authenticated guard. Zero INSERT/
-- UPDATE/DELETE policy exists for any role -- create_bundle_checkout_
-- snapshot() (SECURITY DEFINER) and the Stripe webhook (service_role,
-- untouched by this revoke) are the only writers.
revoke all on public.bundle_checkout_snapshots from anon, authenticated;
grant select on public.bundle_checkout_snapshots to authenticated;

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
-- a weaker FK. Once fulfilled, this hold row is deleted as part of
-- fulfillment itself (see fulfillBundleSnapshot's own reservation/hold
-- cleanup), so it's no longer present to block anything by the time a
-- reader might later delete their account -- unrelated to how
-- purchases.reader_id itself now behaves on profile deletion (SET
-- NULL, not CASCADE, as of migration 038; see the purchases table's
-- own definition below).
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

-- Explicit least-privilege table grant (LAUNCH-1 P1-6): supersedes an
-- earlier, narrower `revoke update`-only fix (migration 031) with a
-- full reset-and-regrant, the same model already used for profiles/
-- refund_requests/purchases/bundle_checkout_snapshots above. anon gets
-- nothing -- no discount_codes operation is ever legitimately
-- anonymous; the one anon-adjacent lookup (matching a code string at
-- checkout) is done server-side with the service role key, never
-- through a client-facing select. authenticated gets exactly the four
-- operations src/app/dashboard/discounts/actions.ts uses: SELECT (list
-- own codes), INSERT (create), UPDATE (active only -- toggleDiscountCode's
-- payload is a plain, single-key `{ active }` object, not an upsert, so
-- narrowing the grantable column set is safe), DELETE (remove).
revoke all on public.discount_codes from anon, authenticated;

grant select, insert, delete
  on public.discount_codes
  to authenticated;

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
  -- LAUNCH-1: nullable, ON DELETE SET NULL -- not CASCADE. This is a
  -- financial/audit record: deleting the owning profile must not
  -- silently delete the record of what was purchased, only detach it
  -- from the (now-gone) profile, matching bundle_checkout_snapshots.
  -- reader_id, refund_requests.reader_id, and book_checkout_intents.
  -- reader_id, which already use this same SET NULL pattern. No
  -- application code depends on reader_id being non-null here -- RLS
  -- ("auth.uid() = reader_id") and user_owns_book() are both NULL-safe
  -- by ordinary SQL three-valued logic, and author-side accounting
  -- (the "Authors can view purchases of their own books" policy below)
  -- scopes through books.author_id, never through reader_id. See
  -- migration 038 and the Purchase History Retention Alignment
  -- audit/design report for the full reasoning.
  reader_id uuid references public.profiles(id) on delete set null,
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

-- Explicit least-privilege table grant (LAUNCH-1 P1-6), same rationale
-- as refund_requests below: state the privilege model outright rather
-- than relying on RLS alone to narrow Supabase's ambient default
-- table-level privileges. authenticated needs SELECT only -- every
-- request-scoped read against this table runs behind an
-- already-authenticated guard (library order history, the sales
-- dashboard, every ownership/eligibility check in books/[id]/
-- actions.ts and the download route). anon gets nothing: both SELECT
-- policies below require auth.uid(), which an anon session never has.
-- No INSERT/UPDATE/DELETE policy exists for any role below -- the
-- Stripe webhook, via service_role (untouched by this revoke), is the
-- only writer.
revoke all on public.purchases from anon, authenticated;
grant select on public.purchases to authenticated;

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

-- ============================================================
-- payment_disputes: LAUNCH-1 P1-7A. One durable row per Stripe Dispute
-- object (charge.dispute.created/.updated/.closed/.funds_withdrawn/
-- .funds_reinstated), keyed by the dispute's own stable id. This is
-- the SOLE authoritative record of dispute state -- deliberately not
-- denormalized onto purchases/bundle_checkout_snapshots (stress-tested
-- and rejected during the P1-7A design phase: a second copy creates a
-- real divergence-prevention burden with no offsetting benefit, since
-- an indexed NOT EXISTS against this table costs the same order of
-- magnitude as the EXISTS subquery user_owns_book() already runs
-- against purchases today).
--
-- status/reason are stored verbatim, with NO check constraint: the
-- installed stripe@22.5.0 SDK types both as open string unions
-- (Dispute.status includes `| OtherString`, confirmed directly in
-- node_modules/stripe/cjs/resources/Disputes.d.ts) since Stripe can
-- introduce new values -- constraining this column would risk
-- rejecting a legitimate future Stripe status outright. Only the
-- literal string 'lost' is ever treated as revoking entitlement (see
-- user_owns_book() below) -- an unrecognized value is therefore safe
-- by construction, not by any allowlist maintained here.
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

-- LAUNCH-1 P1-8: durable lost-dispute transfer-reversal-recovery state,
-- added directly to this table (strictly 1:1 with a dispute -- see the
-- Migration 036 design report for why this isn't a dedicated table).
-- transfer_reversal_status is a small state machine, not a boolean:
-- 'not_attempted' (default) -> 'attempting' -> 'succeeded' | 'failed',
-- with 'failed' retryable by either the webhook or the reconciliation
-- route. transfer_reversal_amount_cents is always derived live from the
-- Stripe Transfer object at attempt time, never from Librum's own
-- platform-fee split. transfer_reversal_attempt_count increments only
-- on a claim from 'not_attempted' or a definitively-terminal 'failed'
-- -- never on a stale 'attempting' re-claim, whose retry (if any)
-- reuses the same attempt number and therefore the same deterministic
-- Stripe idempotency key.
alter table public.payment_disputes
  add column transfer_reversal_status text not null default 'not_attempted'
    check (transfer_reversal_status in ('not_attempted', 'attempting', 'succeeded', 'failed')),
  add column stripe_transfer_id text,
  add column stripe_transfer_reversal_id text,
  add column transfer_reversal_amount_cents integer
    check (transfer_reversal_amount_cents is null or transfer_reversal_amount_cents >= 0),
  add column transfer_reversal_attempt_count integer not null default 0
    check (transfer_reversal_attempt_count >= 0),
  add column transfer_reversal_attempted_at timestamptz,
  add column transfer_reversal_succeeded_at timestamptz,
  add column transfer_reversal_failure_code text,
  add column transfer_reversal_failure_message text;

-- Composite partial index supporting both the webhook's own immediate
-- 'failed' retry and the reconciliation route's periodic scan for
-- 'failed' rows and stale 'attempting' rows -- excludes 'not_attempted'
-- and 'succeeded' rows entirely.
create index payment_disputes_needs_reversal_idx
  on public.payment_disputes (transfer_reversal_status, transfer_reversal_attempted_at)
  where status = 'lost'
    and transfer_reversal_status in ('attempting', 'failed');

alter table public.payment_disputes enable row level security;

-- Zero policies for any command, same posture as bundle_checkout_
-- reservations/bundle_checkout_reader_holds -- doubly closed alongside
-- the explicit revoke below. Only service_role (the webhook) and the
-- two SECURITY DEFINER functions that read it (both bypass RLS as the
-- function owner) ever touch this table.
revoke all on public.payment_disputes from public, anon, authenticated;

-- payment_intent_has_lost_dispute(): the ONE place "does this exact
-- Stripe payment intent have a dispute at status 'lost'" is defined.
-- Explicitly parameterized (not auth.uid()-based) because it is called
-- from contexts where the relevant identity is NOT the calling
-- session's own -- most notably finalize_book_checkout_intent, which
-- runs as the service-role webhook acting on an explicit reader_id
-- read from the intent row, where auth.uid() would not reflect that
-- reader at all. user_owns_book() below also calls this, rather than
-- duplicating the same fragment inline -- one canonical predicate,
-- reused everywhere the "is this payment intent's dispute lost" fact
-- is needed, whether or not auth.uid() happens to be meaningful in the
-- caller's context.
--
-- LAUNCH-1 P2-2: no authenticated EXECUTE grant -- every legitimate
-- caller is another SECURITY DEFINER function's own body (user_owns_
-- book(), create_book_checkout_intent(), finalize_book_checkout_
-- intent(), all below), never a direct application RPC call. Those
-- nested calls keep working via the shared function-owner's own
-- implicit EXECUTE privilege, unaffected by this revoke -- see the
-- P2-2 audit for the empirical verification of this exact semantics.
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

revoke all on function public.payment_intent_has_lost_dispute(text) from public;
revoke all on function public.payment_intent_has_lost_dispute(text) from anon;
revoke all on function public.payment_intent_has_lost_dispute(text) from authenticated;

-- LAUNCH-1 P2-2: author_lost_disputed_payment_intents() -- the Sales
-- dashboard's (src/app/dashboard/sales/page.tsx) sole way to learn
-- which of ITS OWN CALLER's payment intents are lost-disputed. Takes
-- no arguments at all: authorization is derived exclusively from
-- auth.uid(), never from a caller-supplied payment-intent id, closing
-- the arbitrary-membership-oracle shape the P1-8-era lost_disputed_
-- payment_intents(text[]) RPC had (dropped by this same change,
-- migration 037 -- its one legitimate caller is fully superseded by
-- this function). The candidate set is the UNION of this author's own
-- purchases (via books.author_id) and their own fulfilled bundle_
-- checkout_snapshots (via author_id directly) -- the same two
-- author-scoping conditions "Authors can view purchases of their own
-- books" and "Authors can view their own fulfilled bundle snapshot
-- transactions" already use, just performed server-side here instead
-- of by the caller.
create or replace function public.author_lost_disputed_payment_intents()
returns table (stripe_payment_intent_id text)
language sql
security definer
set search_path = ''
stable
as $$
  with author_payment_intents as (
    select p.stripe_payment_intent_id
    from public.purchases p
    join public.books b on b.id = p.book_id
    where b.author_id = auth.uid()
      and p.stripe_payment_intent_id is not null
    union
    select s.stripe_payment_intent_id
    from public.bundle_checkout_snapshots s
    where s.author_id = auth.uid()
      and s.fulfilled_at is not null
      and s.stripe_payment_intent_id is not null
  )
  select distinct d.stripe_payment_intent_id
  from public.payment_disputes d
  where d.status = 'lost'
    and d.stripe_payment_intent_id in (select stripe_payment_intent_id from author_payment_intents);
$$;

revoke all on function public.author_lost_disputed_payment_intents() from public;
revoke all on function public.author_lost_disputed_payment_intents() from anon;
revoke all on function public.author_lost_disputed_payment_intents() from authenticated;
grant execute on function public.author_lost_disputed_payment_intents() to authenticated;

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
--
-- LAUNCH-1 P1-7A: extended with the dispute-lost predicate, via
-- payment_intent_has_lost_dispute() above. Every other entitlement/
-- ownership call site in the application (the manuscript download
-- route, submitReview, the book detail page's "owned" display state,
-- buyBook's and getFreeBook's "already own it" repurchase guards, and
-- buyBundle's/the bundle page's per-book ownership checks) calls this
-- RPC instead of duplicating the raw purchases query -- payment_
-- disputes is fully closed to anon/authenticated above, so a
-- request-scoped client cannot read it directly; routing every check
-- through this one SECURITY DEFINER function avoids granting any new
-- table-level privilege and consolidates what used to be several
-- separately-duplicated ownership queries into one canonical
-- predicate. The dispute check correctly no-ops for a free acquisition
-- (purchases.stripe_payment_intent_id is null for those -- see
-- getFreeBook -- and null can never equal a dispute's real payment_
-- intent_id).
--
-- create_book_checkout_intent() and create_bundle_checkout_snapshot()
-- (both invoked in a request-scoped, auth.uid()-meaningful context)
-- also call this function directly for their own "does the reader
-- already own this" pre-checks, rather than duplicating the predicate
-- -- see each function's own comment for the pre-production audit that
-- found they had NOT originally been updated, leaving a reader whose
-- purchase was disputed-and-lost unable to ever repurchase.
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
-- book_reports: readers flag a book for review. Write-only from an
-- ordinary reader's perspective -- there is deliberately no select
-- policy for regular users (not even the reported book's own author).
-- LIBRUM 2.0 LAUNCH-FIX-1B MOD-1 (migration 039) added an admin-only
-- SELECT policy plus reviewed_at/reviewed_by/admin_notes and the
-- review_book_report() RPC, in a LATER section of this file (after
-- is_admin() is defined) -- see that section's own comment for why the
-- policy/RPC can't live inline here despite conceptually belonging to
-- this table. ADMIN-1A (migration 040) later re-gated that same policy
-- and RPC to staff_has_permission('reports.view'/'reports.resolve')
-- instead of is_admin() -- the placement/ordering reasoning is unchanged,
-- only which function is being waited for.
-- ============================================================

create table public.book_reports (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null,
  details text not null default '',
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null,
  admin_notes text,
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
-- staff_has_permission(): ADMIN-1A's SQL-side authorization primitive,
-- superseding is_admin() above for every staff-gated RLS policy and RPC
-- in this file from this point on. is_admin() is left defined but
-- unused -- see this file's own staff_members section for why.
--
-- SECURITY DEFINER / empty search_path / stable, same hardening posture
-- as is_admin() -- and, like is_admin() querying profiles internally,
-- this function's own query against staff_members runs as this
-- function's owner, not subject to staff_members' RLS policies, the same
-- established, working precedent as every other SECURITY DEFINER helper
-- in this schema.
--
-- Deliberate design choice: a generic is_staff() existence check was
-- considered and rejected -- it cannot express "moderator may resolve
-- reports but not refunds," which review_book_report()/
-- review_refund_request() further below both need.
-- staff_has_permission(text) was chosen instead, accepting the one
-- deliberate duplication this creates: this CASE expression is a second,
-- explicitly synchronized copy of the canonical role->permission matrix
-- in src/lib/staff-permissions.ts, verified by
-- supabase/tests/040_staff_rbac_foundation.test.sql, which walks every
-- (role, permission) pair.
--
-- 'editor' has no branch below -- it is granted zero permissions in the
-- current matrix.
-- ============================================================

create or replace function public.staff_has_permission(p_permission text)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.staff_members sm
    where sm.user_id = auth.uid()
      and (
        sm.role = 'owner'
        or (
          sm.role = 'admin'
          and p_permission in (
            'admin.access', 'reports.view', 'reports.resolve',
            'refunds.view', 'refunds.resolve', 'staff.view'
          )
        )
        or (
          sm.role = 'moderator'
          and p_permission in ('admin.access', 'reports.view', 'reports.resolve')
        )
        or (
          sm.role = 'support'
          and p_permission in ('admin.access', 'refunds.view')
        )
      )
  );
$$;

revoke all on function public.staff_has_permission(text) from public;
revoke all on function public.staff_has_permission(text) from anon;
revoke all on function public.staff_has_permission(text) from authenticated;
grant execute on function public.staff_has_permission(text) to authenticated;

-- Deferred from staff_members' own section above -- see that section's
-- comment for why this couldn't be created until staff_has_permission()
-- existed. This file has always had this ordering correct; migration
-- 040_staff_rbac_foundation.sql originally did not (it placed this exact
-- policy before staff_has_permission()'s own definition and failed in
-- production with "function ... does not exist", SQLSTATE 42883) -- that
-- migration file has since been corrected to match this file's ordering
-- exactly.
create policy "Staff with staff.view can view all staff_members rows"
  on public.staff_members
  for select
  using (public.staff_has_permission('staff.view'));

-- ============================================================
-- refund_requests: one durable row per reader-initiated refund request,
-- always for an entire Stripe transaction (full-transaction refunds
-- only -- see the approved Phase REFUND-1B decisions; there is no
-- partial-amount concept anywhere in this design).
-- ============================================================

create table public.refund_requests (
  id uuid primary key default gen_random_uuid(),
  -- Nullable, ON DELETE SET NULL -- not RESTRICT. This is a
  -- financial/audit record: deleting the owning profile must not
  -- silently delete the record of what was requested, only detach it
  -- from the (now-gone) profile -- the same pattern purchases.reader_id
  -- itself now uses as of migration 038 (previously CASCADE).
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

create policy "Staff with refunds.view can view all refund requests"
  on public.refund_requests
  for select
  using (public.staff_has_permission('refunds.view'));

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
  -- Nullable, ON DELETE SET NULL. As of migration 038,
  -- purchases.reader_id is itself SET NULL (not CASCADE) on profile
  -- deletion, so a purchases row this line item points at is no longer
  -- deleted as a side effect of the reader's account being deleted --
  -- but this column stays SET NULL regardless, on the same general
  -- financial/audit-record principle applied throughout this schema:
  -- a purchases row could in principle still be removed some other
  -- way, and RESTRICT here would then block that entire profile
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

create policy "Staff with refunds.view can view all refund request items"
  on public.refund_request_items
  for select
  using (public.staff_has_permission('refunds.view'));

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

  if not public.staff_has_permission('refunds.resolve') then
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

-- ============================================================
-- LAUNCH-1 P1-4: single-book checkout race hardening. Mirrors
-- supabase/migrations/032_book_checkout_intents.sql exactly -- see that
-- file's own header comment for the full audit/design rationale (why
-- Stripe idempotency keys alone are insufficient, why a calendar-
-- bucketed key was tried and rejected, and the concurrency argument
-- behind finalize_book_checkout_intent's two independent locks).
-- ============================================================

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
  check (fulfilled_at is null or completed_at is not null),
  check ((reconciliation_reason is not null) = (completed_at is not null and fulfilled_at is null)),
  check (reconciliation_reason is null or reconciliation_reason in ('active_other_session', 'book_or_reader_deleted', 'disputed_lost'))
);

alter table public.book_checkout_intents enable row level security;

revoke all on public.book_checkout_intents from public, anon, authenticated;

create index book_checkout_intents_reader_book_open_idx
  on public.book_checkout_intents (reader_id, book_id, created_at desc)
  where fulfilled_at is null;

create index book_checkout_intents_needs_reconciliation_idx
  on public.book_checkout_intents (completed_at)
  where fulfilled_at is null and completed_at is not null;

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

  -- LAUNCH-1 P1-7A: dispute-before-fulfillment guarantee. If a dispute
  -- on this exact payment intent has already reached 'lost', no
  -- purchases row is ever written for it -- recorded as completed-but-
  -- blocked, exactly like the book/reader-deleted case below, rather
  -- than silently granting entitlement Librum's own dispute record
  -- already says was lost. Runs inside this function's own existing
  -- row-locked transaction (the `for update` taken above) -- no new
  -- lock needed, since that row lock already fully serializes every
  -- call for this exact intent_id, and this check reads an unrelated
  -- table. Correct under real-world dispute timing: a dispute can only
  -- ever be filed against an already-completed charge, so "dispute
  -- before fulfillment" only ever means webhook processing order
  -- inverted, never that the underlying events truly raced -- a plain
  -- read of already-committed state is sufficient.
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
  -- dispute(v_existing.stripe_payment_intent_id)` -- without it, a
  -- reader's own OLD, disputed-and-lost purchase row would still be
  -- classified "active" here (a dispute never sets refunded_at), wrongly
  -- blocking their legitimate repurchase after paying a second time. An
  -- existing row whose own payment intent is disputed-lost now falls
  -- through to the eligible/upsert path below, exactly like a refunded
  -- row already does.
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

revoke all on function public.finalize_book_checkout_intent(uuid, text, text, integer) from public;
revoke all on function public.finalize_book_checkout_intent(uuid, text, text, integer) from anon;
revoke all on function public.finalize_book_checkout_intent(uuid, text, text, integer) from authenticated;
grant execute on function public.finalize_book_checkout_intent(uuid, text, text, integer) to service_role;

-- Admin reconciliation query for every Stripe-confirmed paid transaction
-- that was NOT fulfilled into purchases:
--
-- select
--   i.id as intent_id, i.book_id, i.book_title, i.reader_id,
--   i.price_cents_at_checkout, i.stripe_checkout_session_id,
--   i.stripe_payment_intent_id, i.completed_at, i.reconciliation_reason,
--   i.created_at
-- from public.book_checkout_intents i
-- where i.completed_at is not null and i.fulfilled_at is null
-- order by i.completed_at desc;

-- ============================================================
-- LIBRUM 2.0 LAUNCH-FIX-1B MOD-1 (migration 039): admin-only read/
-- disposition path for book_reports (its own CREATE TABLE is far above,
-- near book_reports' original write-only introduction) -- placed here,
-- not there, because the authorization primitive it depends on is not
-- yet defined at that earlier point in this consolidated file (originally
-- is_admin(); as of ADMIN-1A/migration 040, staff_has_permission()).
-- Same dependency-order reasoning as "Staff with refunds.view can view
-- all refund requests" above: that function must already exist for
-- CREATE POLICY's USING expression to resolve. Mirrors
-- review_refund_request() verbatim in structure and hardening, adapted
-- only for book_reports' own two-value decision and 'open' starting
-- status. See migration 039's own header comment for the original MOD-1
-- rationale (root cause, why the base table-level grant is deliberately
-- left untouched) -- staff_members/requireStaff, explicitly out of scope
-- for MOD-1, were subsequently built by ADMIN-1A (migration 040); author
-- suspension remains out of scope, deferred to later work.
-- ============================================================

create policy "Staff with reports.view can view all book reports"
  on public.book_reports
  for select
  using (public.staff_has_permission('reports.view'));

create or replace function public.review_book_report(
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

  if not public.staff_has_permission('reports.resolve') then
    raise exception 'not authorized';
  end if;

  if p_decision not in ('resolved', 'dismissed') then
    raise exception 'p_decision must be ''resolved'' or ''dismissed''';
  end if;

  if p_admin_notes is not null and pg_catalog.char_length(p_admin_notes) > 2000 then
    raise exception 'p_admin_notes must be 2000 characters or fewer';
  end if;

  update public.book_reports
  set status = p_decision,
      reviewed_at = pg_catalog.now(),
      reviewed_by = v_admin_id,
      admin_notes = nullif(trim(coalesce(p_admin_notes, '')), '')
  where id = p_id
    and status = 'open'
  returning id into v_updated_id;

  if v_updated_id is null then
    raise exception 'no reviewable report found for this id';
  end if;
end;
$$;

revoke all on function public.review_book_report(uuid, text, text) from public;
revoke all on function public.review_book_report(uuid, text, text) from anon;
revoke all on function public.review_book_report(uuid, text, text) from authenticated;
grant execute on function public.review_book_report(uuid, text, text) to authenticated;

-- ============================================================
-- LIBRUM 2.0 ADMIN-1B PART B (migration 041): the staff-management
-- mutation surface deferred by ADMIN-1A (migration 040) -- add/
-- change-role/remove RPCs, an append-only audit log, and a hard,
-- trigger-enforced last-owner invariant. Placed here, at the tail, for
-- the same reason migration 039's block above is: every object this
-- section creates is new and self-contained, depending only on
-- staff_members/staff_has_permission()/profiles, all already defined
-- earlier in this file -- there is no earlier "logical" position this
-- needs to occupy. See supabase/migrations/041_staff_management.sql's
-- own header and inline comments for the full design reasoning
-- (concurrency, anti-enumeration, atomicity, audit-log ACL) -- not
-- repeated in full here to avoid the two copies drifting apart in
-- prose while schema.sql and the migration file stay byte-identical in
-- the SQL itself.
-- ============================================================

create or replace function public.staff_members_protect_last_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_count integer;
begin
  if (tg_op = 'DELETE' and old.role = 'owner')
     or (tg_op = 'UPDATE' and old.role = 'owner' and new.role <> 'owner') then

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('staff_members:owner_invariant')
    );

    select count(*) into v_owner_count
    from public.staff_members
    where role = 'owner';

    if v_owner_count <= 1 then
      raise exception 'at least one owner is required';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  else
    return new;
  end if;
end;
$$;

revoke all on function public.staff_members_protect_last_owner() from public;
revoke all on function public.staff_members_protect_last_owner() from anon;
revoke all on function public.staff_members_protect_last_owner() from authenticated;

create trigger staff_members_protect_last_owner
  before update of role or delete on public.staff_members
  for each row execute function public.staff_members_protect_last_owner();

create table public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  target_type text not null,
  target_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.admin_audit_log enable row level security;

revoke all on public.admin_audit_log from anon, authenticated;

create index admin_audit_log_actor_id_idx on public.admin_audit_log (actor_id);
create index admin_audit_log_target_idx on public.admin_audit_log (target_type, target_id);

create or replace function public.list_staff_members()
returns table (
  user_id uuid,
  display_name text,
  email text,
  role text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('staff.view') then
    raise exception 'not authorized';
  end if;

  return query
    select sm.user_id, p.display_name, au.email::text, sm.role, sm.created_at
    from public.staff_members sm
    join public.profiles p on p.id = sm.user_id
    join auth.users au on au.id = sm.user_id
    order by sm.created_at asc;
end;
$$;

revoke all on function public.list_staff_members() from public;
revoke all on function public.list_staff_members() from anon;
revoke all on function public.list_staff_members() from authenticated;
grant execute on function public.list_staff_members() to authenticated;

create or replace function public.add_staff_member_by_email(
  target_email text,
  new_role text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_normalized_email text;
  v_target_user_id uuid;
  v_email_confirmed_at timestamptz;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('staff.manage') then
    raise exception 'not authorized';
  end if;

  if new_role not in ('owner', 'admin', 'editor', 'moderator', 'support') then
    raise exception 'invalid role';
  end if;

  v_normalized_email := lower(trim(coalesce(target_email, '')));
  if v_normalized_email = '' then
    raise exception 'invalid email';
  end if;

  select id, email_confirmed_at
  into v_target_user_id, v_email_confirmed_at
  from auth.users
  where lower(email) = v_normalized_email
  limit 1;

  if v_target_user_id is null or v_email_confirmed_at is null then
    raise exception 'no verified Librum account was found for that email';
  end if;

  if not exists (select 1 from public.profiles where id = v_target_user_id) then
    raise exception 'no verified Librum account was found for that email';
  end if;

  if exists (select 1 from public.staff_members where user_id = v_target_user_id) then
    raise exception 'already staff';
  end if;

  insert into public.staff_members (user_id, role, created_by)
  values (v_target_user_id, new_role, v_actor_id);

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (
    v_actor_id, 'staff.added', 'staff_members', v_target_user_id,
    jsonb_build_object('role', new_role)
  );
end;
$$;

revoke all on function public.add_staff_member_by_email(text, text) from public;
revoke all on function public.add_staff_member_by_email(text, text) from anon;
revoke all on function public.add_staff_member_by_email(text, text) from authenticated;
grant execute on function public.add_staff_member_by_email(text, text) to authenticated;

create or replace function public.change_staff_role(
  target_user_id uuid,
  new_role text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_old_role text;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('staff.manage') then
    raise exception 'not authorized';
  end if;

  if new_role not in ('owner', 'admin', 'editor', 'moderator', 'support') then
    raise exception 'invalid role';
  end if;

  if target_user_id = v_actor_id then
    raise exception 'cannot change your own role';
  end if;

  select role into v_old_role
  from public.staff_members
  where user_id = target_user_id;

  if v_old_role is null then
    raise exception 'staff member not found';
  end if;

  if v_old_role = new_role then
    return;
  end if;

  update public.staff_members
  set role = new_role,
      updated_at = pg_catalog.now()
  where user_id = target_user_id;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (
    v_actor_id, 'staff.role_changed', 'staff_members', target_user_id,
    jsonb_build_object('old_role', v_old_role, 'new_role', new_role)
  );
end;
$$;

revoke all on function public.change_staff_role(uuid, text) from public;
revoke all on function public.change_staff_role(uuid, text) from anon;
revoke all on function public.change_staff_role(uuid, text) from authenticated;
grant execute on function public.change_staff_role(uuid, text) to authenticated;

create or replace function public.remove_staff_member(
  target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_role text;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('staff.manage') then
    raise exception 'not authorized';
  end if;

  if target_user_id = v_actor_id then
    raise exception 'cannot remove yourself';
  end if;

  select role into v_role
  from public.staff_members
  where user_id = target_user_id;

  if v_role is null then
    raise exception 'staff member not found';
  end if;

  delete from public.staff_members where user_id = target_user_id;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'staff.removed', 'staff_members', target_user_id, jsonb_build_object('role', v_role));
end;
$$;

revoke all on function public.remove_staff_member(uuid) from public;
revoke all on function public.remove_staff_member(uuid) from anon;
revoke all on function public.remove_staff_member(uuid) from authenticated;
grant execute on function public.remove_staff_member(uuid) to authenticated;

-- ============================================================
-- ADMIN-1C PART B: audit-visibility primitives -- audit.view permission,
-- list_admin_audit_events() RPC, the durable refund_issuance_attempts
-- table + begin/complete/fail RPCs, and audit-event insertion inside
-- review_book_report()/review_refund_request(). See
-- supabase/migrations/042_admin_audit_visibility.sql for the full design
-- reasoning (this is that file's exact SQL, appended here per this
-- file's own established convention).
-- ============================================================

--
-- Migrations 040 and 041 are immutable (already production-applied) and
-- are not modified by this file in any way.

-- ============================================================
-- Part 1: audit.view -- extends staff_has_permission()'s existing
-- 'admin' branch only. owner is unconditionally true already (no change
-- needed); moderator/support/editor get no new branch, so
-- staff_has_permission('audit.view') already returns false for them by
-- construction, exactly like every other permission they don't hold.
-- This is a CREATE OR REPLACE on staff_has_permission()'s existing,
-- unchanged signature -- its own revoke-all-then-grant-execute-to-
-- authenticated block (migration 040) is preserved automatically and is
-- not repeated here, same convention migration 040 itself already used
-- when it modified review_book_report()/review_refund_request().
-- ============================================================

create or replace function public.staff_has_permission(p_permission text)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.staff_members sm
    where sm.user_id = auth.uid()
      and (
        sm.role = 'owner'
        or (
          sm.role = 'admin'
          and p_permission in (
            'admin.access', 'reports.view', 'reports.resolve',
            'refunds.view', 'refunds.resolve', 'staff.view', 'audit.view'
          )
        )
        or (
          sm.role = 'moderator'
          and p_permission in ('admin.access', 'reports.view', 'reports.resolve')
        )
        or (
          sm.role = 'support'
          and p_permission in ('admin.access', 'refunds.view')
        )
      )
  );
$$;

-- ============================================================
-- Part 2: list_admin_audit_events() -- the ONLY read path for
-- admin_audit_log. Direct SELECT remains denied to anon/authenticated
-- (migration 041's own `revoke all ... from anon, authenticated` already
-- covers this; nothing here grants it back). No RLS SELECT policy is
-- added for the same reason ADMIN-1C Part A recommended against one --
-- this table has no client-facing read path other than this controlled,
-- filtered, paginated RPC.
--
-- Joins ONLY public.profiles, for actor_display_name -- never
-- auth.users, never book_reports/refund_requests/staff_members for
-- target labeling (Part A's own "do not design a huge polymorphic join"
-- recommendation). LEFT JOIN, not JOIN: actor_id is nullable
-- (ON DELETE SET NULL, migration 041) for an actor whose profile has
-- since been deleted -- a LEFT JOIN preserves that audit row (with
-- actor_display_name = null) rather than silently dropping it from the
-- list.
--
-- Validation ordering matches every other RPC in this schema: auth ->
-- permission -> parameter validation -> query. A non-staff caller never
-- reaches the filter-validation logic at all.
--
-- Action/target_type filters are allow-listed, not free text -- Part A's
-- own explicit design choice, re-confirmed here: an unrecognized filter
-- value is a stable, controlled `raise exception`, matching this
-- schema's own established convention for rejecting an invalid enum-like
-- parameter (e.g. add_staff_member_by_email()'s `if new_role not in
-- (...) then raise exception 'invalid role'`) -- never a silently-empty
-- result, which would be indistinguishable from "no rows matched" and
-- could mask a caller-side bug (e.g. a typo'd action string) as an
-- empty audit log.
--
-- Cursor semantics: null/null means "first page". A malformed PARTIAL
-- cursor (exactly one of the pair supplied) is rejected outright --
-- silently treating it as either "first page" or "apply only half the
-- key" would produce ambiguous, unreviewed pagination behavior.
--
-- p_limit is clamped, never trusted verbatim: NULL defaults to 25,
-- anything below 1 is raised to 1, anything above 100 is capped to 100.
--
-- ADMIN-1C PART B PRE-FINALIZE CORRECTION: the action allow-list below
-- uses 'refund.review_rejected', not the earlier draft's
-- 'refund.review_denied' -- the actual domain status refund_requests.
-- status transitions to is 'rejected' (migration 029's own CHECK
-- constraint), so the audit action string now names that exactly,
-- matching review_book_report()'s own 'dismissed'/'report.dismissed'
-- naming discipline (the audit action always mirrors the real status
-- value, never a softer synonym for it).
create or replace function public.list_admin_audit_events(
  p_action text default null,
  p_actor_id uuid default null,
  p_target_type text default null,
  p_created_after timestamptz default null,
  p_created_before timestamptz default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 25
)
returns table (
  id uuid,
  actor_id uuid,
  actor_display_name text,
  action text,
  target_type text,
  target_id uuid,
  metadata jsonb,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_limit integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('audit.view') then
    raise exception 'not authorized';
  end if;

  if p_action is not null and p_action not in (
    'staff.added', 'staff.role_changed', 'staff.removed',
    'report.resolved', 'report.dismissed',
    'refund.review_approved', 'refund.review_rejected',
    'refund.issuance_submitted'
  ) then
    raise exception 'invalid action filter';
  end if;

  if p_target_type is not null and p_target_type not in (
    'staff_members', 'book_reports', 'refund_requests'
  ) then
    raise exception 'invalid target_type filter';
  end if;

  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception 'invalid cursor';
  end if;

  if p_created_after is not null and p_created_before is not null
     and p_created_after >= p_created_before then
    raise exception 'invalid date range';
  end if;

  v_limit := coalesce(p_limit, 25);
  if v_limit < 1 then
    v_limit := 1;
  elsif v_limit > 100 then
    v_limit := 100;
  end if;

  return query
    select
      aal.id,
      aal.actor_id,
      p.display_name as actor_display_name,
      aal.action,
      aal.target_type,
      aal.target_id,
      aal.metadata,
      aal.created_at
    from public.admin_audit_log aal
    left join public.profiles p on p.id = aal.actor_id
    where (p_action is null or aal.action = p_action)
      and (p_actor_id is null or aal.actor_id = p_actor_id)
      and (p_target_type is null or aal.target_type = p_target_type)
      and (p_created_after is null or aal.created_at >= p_created_after)
      and (p_created_before is null or aal.created_at < p_created_before)
      and (
        p_cursor_created_at is null
        or (aal.created_at, aal.id) < (p_cursor_created_at, p_cursor_id)
      )
    order by aal.created_at desc, aal.id desc
    limit v_limit;
end;
$$;

revoke all on function public.list_admin_audit_events(
  text, uuid, text, timestamptz, timestamptz, timestamptz, uuid, integer
) from public;
revoke all on function public.list_admin_audit_events(
  text, uuid, text, timestamptz, timestamptz, timestamptz, uuid, integer
) from anon;
revoke all on function public.list_admin_audit_events(
  text, uuid, text, timestamptz, timestamptz, timestamptz, uuid, integer
) from authenticated;
grant execute on function public.list_admin_audit_events(
  text, uuid, text, timestamptz, timestamptz, timestamptz, uuid, integer
) to authenticated;

-- ============================================================
-- Part 3: refund_issuance_attempts -- PRE-FINALIZE FINANCIAL DURABILITY
-- CORRECTION. This is the actual fix, not a cosmetic addition.
--
-- The first draft of this migration wrote the refund.issuance_submitted
-- audit event ONLY after stripe.refunds.create() had already resolved
-- successfully -- correct for never logging a false success, but it left
-- a real durability gap: if Stripe accepts the refund and then the
-- application process dies, or the post-Stripe audit-write call itself
-- fails, Librum is left with NO durable record of which human staff
-- member initiated that external financial side effect at all. The
-- Stripe idempotency key already prevents a DUPLICATE Stripe operation,
-- but duplicate-prevention is a different property from durability --
-- neither the idempotency key nor the (already-committed, unrelated)
-- admin_audit_log partial unique index on stripe_refund_id can recover
-- "who clicked this" if the write recording that fact never lands.
--
-- The fix: a narrow, durable, actor-attributed row is committed to THIS
-- table BEFORE the Stripe call is ever made (begin_refund_issuance_
-- attempt() below), carrying exactly the deterministic idempotency key
-- that will also be sent to Stripe. If everything downstream succeeds,
-- complete_refund_issuance_attempt() transitions it to 'submitted' and
-- writes the admin_audit_log event, atomically, in one transaction. If
-- Stripe returns an immediate failed/canceled status,
-- fail_refund_issuance_attempt() marks it 'failed'. If Stripe THROWS
-- (a transport/API exception), the same function marks it 'unknown', not
-- 'failed' -- see the status-model comment on the table below, and Part 6
-- for why this distinction is load-bearing, not cosmetic. If the
-- completion call itself fails after a genuine Stripe success, the row is
-- left exactly as it was ('initiated') -- not silently discarded, not
-- fabricated as complete -- so a human can reconcile using attempt id,
-- refund_request_id, actor_id, idempotency_key, and created_at, exactly
-- the fields Part B's own correction brief requires to remain
-- inspectable.
--
-- This is deliberately OPERATIONAL/RECOVERY state, not a second audit
-- log: it is never read through list_admin_audit_events(), carries no
-- browser-facing display concept, and (unlike admin_audit_log) its rows
-- are actively UPDATED as an attempt progresses -- admin_audit_log
-- itself remains append-only and untouched by this table's existence.
--
-- ADMIN-1C PART B FINAL FINANCIAL INVARIANT CORRECTION: refund_request_id
-- is now `on delete restrict`, not the earlier draft's `on delete
-- cascade`. This table is financial operational/recovery EVIDENCE -- a
-- record of who initiated a real external Stripe call and with which
-- idempotency key -- and must not silently vanish merely because its
-- parent refund_requests row is later deleted. Nothing in this schema
-- currently deletes refund_requests rows in ordinary operation (they are
-- only ever transitioned between statuses), so RESTRICT costs nothing in
-- practice and only prevents an accidental future deletion from quietly
-- erasing evidence that a real refund attempt happened. (Historical note:
-- refund_request_items' own `on delete cascade` precedent, migration 029,
-- was correct for ITS purpose -- pure line-item detail with no
-- independent evidentiary value -- but does not apply here.)
--
-- actor_id: on delete set null, identical treatment to admin_audit_log.
-- actor_id and staff_members.created_by -- a historical/operational
-- reference, not a live grant; the row must survive the actor's own
-- account being deleted later. Unchanged by this correction.
--
-- No email, payment-method, card, billing, raw Stripe payload, secret,
-- or other customer PII column exists here or anywhere in this table --
-- only the fields explicitly required for attribution and reconciliation.
--
-- STRIPE-REFUND IDENTITY: ADMIN-1C PART B FINAL FINANCIAL INVARIANT
-- CORRECTION adds a second uniqueness guarantee below (see the
-- stripe_refund_id partial unique index, after the table DDL): exactly
-- ONE attempt row may ever claim a given non-null stripe_refund_id. The
-- earlier draft only enforced this at the audit-log layer (a partial
-- unique index on admin_audit_log.metadata->>'stripe_refund_id') --
-- correct for preventing a duplicate AUDIT ROW, but it said nothing about
-- whether two DIFFERENT attempt rows could both durably claim to own the
-- same real external Stripe refund object, which is the actual identity
-- fact that matters for reconciliation. Three distinct uniqueness layers
-- now exist, deliberately kept separate because they guard three
-- distinct things:
--   1. ATTEMPT-IDENTITY uniqueness (idempotency_key, below) -- the same
--      deterministic key always resolves to the same attempt ROW.
--   2. EXTERNAL STRIPE-REFUND IDENTITY uniqueness (stripe_refund_id,
--      below) -- a given real Stripe refund object may be CLAIMED
--      (transitioned to 'submitted') by at most one attempt row.
--   3. AUDIT-EVENT uniqueness (admin_audit_log's own partial unique
--      index, Part 9) -- at most one refund.issuance_submitted row may
--      ever reference a given stripe_refund_id, now a tertiary backstop
--      behind both of the above.
-- ============================================================

create table public.refund_issuance_attempts (
  id uuid primary key default gen_random_uuid(),
  refund_request_id uuid not null references public.refund_requests(id) on delete restrict,
  actor_id uuid references public.profiles(id) on delete set null,
  idempotency_key text not null,
  stripe_refund_id text,
  stripe_status text,
  -- Status model: exactly FOUR states -- ADMIN-1C PART B FINAL FINANCIAL
  -- INVARIANT CORRECTION adds 'unknown', distinguishing a CONFIRMED
  -- outcome from an AMBIGUOUS one, matching exactly what this flow can
  -- actually observe --
  --   'initiated' -- begin_refund_issuance_attempt() has durably
  --     recorded that a staff member is about to call Stripe with this
  --     exact idempotency key. This is the row that exists BEFORE the
  --     external call, and is what makes recovery possible if nothing
  --     after this point ever lands.
  --   'submitted' -- complete_refund_issuance_attempt() has confirmed
  --     Stripe accepted the refund (a non-terminal-failure resolved
  --     status) and recorded stripe_refund_id/stripe_status. Terminal,
  --     successful, CONFIRMED.
  --   'failed' -- fail_refund_issuance_attempt() has recorded that Stripe
  --     returned an immediate failed/canceled status for THIS specific
  --     attempt -- a resolved API response Librum actually received and
  --     can act on. Terminal, unsuccessful, CONFIRMED.
  --   'unknown' -- fail_refund_issuance_attempt() has recorded that the
  --     stripe.refunds.create() call THREW (a transport/API exception)
  --     rather than resolving. This is deliberately NOT 'failed': a
  --     thrown exception can occur AFTER Stripe has already accepted an
  --     idempotent request but BEFORE Librum received the response (a
  --     timeout, a dropped connection, a 5xx after the fact) -- Librum
  --     genuinely does not know whether a real Stripe refund now exists
  --     for this idempotency key. Recording 'failed' here would overstate
  --     what is known and could wrongly suggest it's safe to disregard;
  --     'unknown' instead flags the row for reconciliation using the SAME
  --     Stripe idempotency-key/live-refund lookup logic
  --     (determineRefundAttempt(), issue-refund.ts) that already gates
  --     every retry -- see that function's own comment for why an
  --     'unknown' LOCAL status never by itself authorizes a fresh
  --     external Stripe call. NOT terminal, deliberately -- unlike
  --     'submitted'/'failed', an 'unknown' row is a RECOVERABLE dead
  --     end, not a permanent one: see the ADMIN-1C PART B UNKNOWN-STATE
  --     RECOVERY CORRECTION note below.
  --
  -- ADMIN-1C PART B UNKNOWN-STATE RECOVERY CORRECTION: the complete
  -- state machine, exactly as enforced by complete_refund_issuance_
  -- attempt()'s and fail_refund_issuance_attempt()'s own guarded UPDATEs
  -- (`where status in (...)`) --
  --   initiated -> submitted | failed | unknown
  --   unknown   -> submitted | failed | unknown
  --   submitted -> (terminal -- no further transitions, ever)
  --   failed    -> (terminal -- no further transitions, ever)
  -- A genuine retry after 'unknown' reuses the SAME durable row (the SAME
  -- deterministic idempotency key resolves back to it via
  -- begin_refund_issuance_attempt()'s own idempotency_key uniqueness) --
  -- unlike a genuine retry after 'failed', which always uses a NEW
  -- deterministic key (buildRetryIdempotencyKey(), issue-refund.ts) and
  -- therefore always creates a genuinely NEW row. This is the correct,
  -- deliberate asymmetry: 'failed' means Stripe gave a definitive answer
  -- for that specific attempt, so a retry is a NEW attempt; 'unknown'
  -- means Stripe never gave an answer for THIS attempt at all, so a
  -- retry using the identical idempotency key is still resolving the
  -- SAME original attempt -- reusing the row (rather than minting a new
  -- one) is what keeps the durable actor/timestamp attribution intact
  -- across the eventual resolution, and is exactly what Stripe's own
  -- idempotency-key contract already assumes ("the same key always means
  -- the same operation").
  -- Explicitly NOT a replacement for refund_requests.status/refunded_at,
  -- which remains the Stripe webhook's sole, unchanged, authoritative
  -- source for whether a refund actually SETTLED (see
  -- src/app/api/webhooks/stripe/route.ts's processChargeRefund) --
  -- 'submitted' here means only "Stripe accepted the attempt," the exact
  -- same distinction issue-refund.ts's own REFUND_SUBMITTED_SUCCESS_MESSAGE
  -- has always drawn for the admin-facing UI.
  status text not null default 'initiated'
    check (status in ('initiated', 'submitted', 'failed', 'unknown')),
  -- A short, safe, non-sensitive code only -- never the raw Stripe error
  -- message (which can be arbitrarily detailed/unbounded and is already
  -- logged server-side via console.error at the TypeScript call site,
  -- same posture as STRIPE_REFUND_ERROR_MESSAGE's own existing
  -- "never surfaced, only console.error'd" treatment of raw Stripe
  -- exceptions). The vocabulary itself is unchanged by this correction --
  -- 'stripe_error' still means "the create() call threw" -- what changed
  -- is which STATUS that reason now maps to (see
  -- fail_refund_issuance_attempt() below): 'stripe_error' -> 'unknown'
  -- (ambiguous), 'immediate_failed'/'immediate_canceled' -> 'failed'
  -- (confirmed).
  failure_reason text
    check (failure_reason is null or failure_reason in ('stripe_error', 'immediate_failed', 'immediate_canceled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Attempt-identity idempotency (uniqueness layer 1 of 3 -- see this
-- table's own header comment above for the full three-layer model):
-- the SAME deterministic idempotency key must resolve to the SAME
-- durable attempt row, however many times begin_refund_issuance_
-- attempt() is called for it (a double-click, a retried Server Action,
-- two concurrent admin tabs). Global uniqueness on idempotency_key
-- alone is correct and sufficient here -- the key already embeds the
-- refund_request_id by construction (buildRefundIdempotencyKey()/
-- buildRetryIdempotencyKey(), issue-refund.ts), so two DIFFERENT refund
-- requests can never collide on this constraint.
create unique index refund_issuance_attempts_idempotency_key_idx
  on public.refund_issuance_attempts (idempotency_key);

-- External Stripe-refund identity (uniqueness layer 2 of 3): at most one
-- attempt row may ever CLAIM a given real, non-null Stripe refund object.
-- Partial (where stripe_refund_id is not null) because every row starts
-- with a null stripe_refund_id (set only by complete_refund_issuance_
-- attempt() once Stripe has actually responded) -- a plain non-partial
-- unique index would incorrectly treat every not-yet-submitted row as
-- colliding on NULL (though Postgres itself already treats multiple NULLs
-- as non-equal for uniqueness purposes, the partial form is kept anyway
-- to make the intent -- "only claimed rows are constrained" -- explicit
-- and to avoid the index ever indexing the common not-yet-claimed case at
-- all). Enforced at the exact point of claim inside
-- complete_refund_issuance_attempt() -- see that function's own comment
-- for the controlled-failure behavior when a second attempt collides.
create unique index refund_issuance_attempts_stripe_refund_id_idx
  on public.refund_issuance_attempts (stripe_refund_id)
  where stripe_refund_id is not null;

-- Operational/reconciliation lookup: "every attempt for this refund
-- request," the exact query a human would run to investigate the
-- post-Stripe-DB-failure condition Part 9 of the correction brief
-- describes.
create index refund_issuance_attempts_refund_request_id_idx
  on public.refund_issuance_attempts (refund_request_id);

alter table public.refund_issuance_attempts enable row level security;

-- Same locked-down posture as admin_audit_log: no SELECT/INSERT/UPDATE/
-- DELETE grant to anon or authenticated, RLS enabled with zero policies
-- (belt-and-suspenders -- even a role that somehow held a table grant
-- would see/affect nothing). All access is through the three narrow
-- SECURITY DEFINER RPCs below. No /admin UI reads this table in
-- ADMIN-1C at all.
revoke all on public.refund_issuance_attempts from anon, authenticated;

-- ============================================================
-- Part 4: begin_refund_issuance_attempt() -- MUST be called, and MUST
-- durably commit, before the caller ever invokes stripe.refunds.create().
-- This ordering is enforced at the TypeScript call site
-- (executeApprovedRefund(), src/app/admin/(protected)/refunds/
-- issue-refund.ts), not here -- this function has no way to prevent a
-- caller from ignoring its own return value, but it is the ONLY
-- supported path that produces a valid attempt id, and the completion/
-- fail RPCs below both require one that actually exists.
--
-- refund_requests.status must currently be 'approved' -- same business
-- gate executeApprovedRefund() itself already independently re-checks
-- via its own read; this RPC re-derives it a second time rather than
-- trusting the caller, matching this schema's universal "never trust
-- client-supplied state" discipline.
--
-- Idempotency/concurrency: `on conflict (idempotency_key) do nothing`
-- against the unique index above, falling back to SELECTing the
-- already-existing row's id when the insert is a no-op. Two concurrent
-- calls with the SAME key (a double-click, two admin tabs, a retried
-- Server Action) therefore always resolve to the SAME attempt identity
-- -- exactly the same guarantee Stripe's own idempotency-key contract
-- provides for the external call this attempt row precedes. A GENUINE
-- retry after a failed/canceled Stripe attempt uses a NEW deterministic
-- key (buildRetryIdempotencyKey(), issue-refund.ts) and therefore always
-- creates a genuinely NEW row here -- this table never blocks a
-- legitimate second attempt, only collapses duplicate identities for
-- the identical one.
-- ============================================================

create or replace function public.begin_refund_issuance_attempt(
  p_refund_request_id uuid,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_status text;
  v_attempt_id uuid;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('refunds.resolve') then
    raise exception 'not authorized';
  end if;

  select status into v_status from public.refund_requests where id = p_refund_request_id;
  if v_status is null then
    raise exception 'refund request not found';
  end if;
  if v_status <> 'approved' then
    raise exception 'refund request is not approved';
  end if;

  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'invalid idempotency key';
  end if;

  insert into public.refund_issuance_attempts (refund_request_id, actor_id, idempotency_key, status)
  values (p_refund_request_id, v_actor_id, p_idempotency_key, 'initiated')
  on conflict (idempotency_key) do nothing
  returning id into v_attempt_id;

  if v_attempt_id is null then
    select id into v_attempt_id
    from public.refund_issuance_attempts
    where idempotency_key = p_idempotency_key;
  end if;

  return v_attempt_id;
end;
$$;

revoke all on function public.begin_refund_issuance_attempt(uuid, text) from public;
revoke all on function public.begin_refund_issuance_attempt(uuid, text) from anon;
revoke all on function public.begin_refund_issuance_attempt(uuid, text) from authenticated;
grant execute on function public.begin_refund_issuance_attempt(uuid, text) to authenticated;

-- ============================================================
-- Part 5: complete_refund_issuance_attempt() -- called only after a
-- GENUINE new Stripe refund attempt has resolved without throwing, with
-- a non-terminal-failure status (see issue-refund.ts's own call site for
-- the exact condition this must follow -- unchanged from the first
-- draft's own equivalent condition, just relocated onto this attempt-
-- scoped function).
--
-- Ownership invariant: the caller must be the SAME actor who began the
-- attempt (attempt.actor_id = auth.uid()) -- chosen specifically because
-- the entire point of this table is per-actor accountability for one
-- specific button click; there is no legitimate scenario in the current
-- product where a different staff member should be able to complete
-- someone else's in-flight attempt, and allowing it would let one
-- staff member's action get attributed to another's audit trail. Kept
-- unchanged for V1 by ADMIN-1C PART B UNKNOWN-STATE RECOVERY CORRECTION's
-- own explicit instruction -- retry-from-'unknown' recovery already works
-- under this same restriction, since the normal path is the SAME staff
-- member re-clicking "Issue refund" after a transient failure, not a
-- different one resolving it on their behalf.
--
-- DEFERRED (explicitly out of scope for this correction, NOT built here):
-- an 'unknown' attempt whose initiating actor later becomes unavailable
-- (removed as staff, account deleted) has no recovery path under this
-- ownership invariant -- actor_id on delete set null (see the table's own
-- header comment) means attempt.actor_id could become NULL, and
-- `v_attempt_actor_id is distinct from v_actor_id` would then reject
-- EVERY caller, including an owner, from ever completing or failing that
-- row. This is a genuine, currently-unhandled operational gap -- tracked
-- as FIN-OPS-1 (Refund issuance reconciliation): a future, explicitly
-- privileged (e.g. owner-only, or a dedicated new permission) mechanism
-- to resolve an orphaned 'unknown' attempt would be required to close it.
-- No such mechanism exists yet, and none is added by this correction.
--
-- Transition: 'initiated' -> 'submitted' OR 'unknown' -> 'submitted',
-- exactly once -- guarded by `where status in ('initiated', 'unknown')`
-- on the UPDATE, identical in spirit to review_book_report()/
-- review_refund_request()'s own `where status = '...'` concurrency
-- guards. A repeat completion call for an already-'submitted' attempt
-- (e.g. a retried Server Action after the first call actually succeeded
-- but the caller never saw the response) is a safe, silent no-op --
-- v_updated_id stays null and the function simply returns, writing no
-- second audit row. An already-'failed' attempt is likewise never
-- reopened -- neither 'submitted' nor 'failed' appears in the guard's
-- `in (...)` list, so both terminal states are structurally protected
-- from this UPDATE ever touching them again, with no separate check
-- needed.
--
-- ADMIN-1C PART B UNKNOWN-STATE RECOVERY CORRECTION: 'unknown' is now
-- accepted as a second valid starting state, alongside 'initiated'. Root
-- issue this fixes: a Stripe transport/API exception moves an attempt to
-- 'unknown' (see fail_refund_issuance_attempt() below) precisely because
-- Librum could not confirm what happened -- but a SUBSEQUENT retry using
-- the SAME deterministic idempotency key (begin_refund_issuance_attempt()
-- resolves it back to this exact same durable row, never a new one) can
-- absolutely produce a definitive resolved Stripe response. Without this
-- change, 'unknown' would be a dead end: this RPC's own guard would
-- reject the completion of a row it is EXACTLY the recovery mechanism
-- for. The full state machine (see the table's own header comment, and
-- fail_refund_issuance_attempt()'s below, for the complete picture):
--   initiated -> submitted | failed | unknown
--   unknown   -> submitted | failed | unknown
--   submitted -> (terminal, no further transitions)
--   failed    -> (terminal, no further transitions)
--
-- Atomicity: the attempt UPDATE and the admin_audit_log INSERT are one
-- PL/pgSQL function body, one transaction -- they succeed or fail
-- together, the same "succeed together or fail together" guarantee
-- review_book_report()/review_refund_request() themselves already have.
--
-- ADMIN-1C PART B FINAL FINANCIAL INVARIANT CORRECTION: this function now
-- ALSO enforces uniqueness layer 2 (external Stripe-refund identity, see
-- the table's own header comment) -- the UPDATE that stamps
-- stripe_refund_id onto this attempt is wrapped in its own exception
-- handler for unique_violation against refund_issuance_attempts_
-- stripe_refund_id_idx. If a DIFFERENT attempt has already claimed this
-- exact stripe_refund_id (a scenario that should never arise given each
-- attempt's own idempotency_key uniqueness, but is not assumed away),
-- this function raises a controlled, clearly-worded exception rather than
-- silently letting the collision through -- the calling attempt is left
-- exactly as it was (still 'initiated'), never falsely marked
-- 'submitted', and no audit row is written for it. This is a genuine
-- collision-rejection, not a harmless duplicate: at most one attempt may
-- ever own a given real Stripe refund object.
--
-- The admin_audit_log INSERT is separately wrapped in its own exception
-- handler for unique_violation against the pre-existing partial unique
-- index on metadata->>'stripe_refund_id' -- see that index's own comment
-- (Part 9 below) for why this is now a TERTIARY backstop, behind both the
-- attempt table's own 'initiated'/'unknown' UPDATE guard (primary,
-- duplicate-completion prevention) and the stripe_refund_id claim check
-- immediately above (secondary, cross-attempt collision prevention).
-- ============================================================

create or replace function public.complete_refund_issuance_attempt(
  p_attempt_id uuid,
  p_stripe_refund_id text,
  p_stripe_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_attempt_actor_id uuid;
  v_refund_request_id uuid;
  v_updated_id uuid;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('refunds.resolve') then
    raise exception 'not authorized';
  end if;

  select actor_id, refund_request_id into v_attempt_actor_id, v_refund_request_id
  from public.refund_issuance_attempts
  where id = p_attempt_id;

  if v_refund_request_id is null then
    raise exception 'refund issuance attempt not found';
  end if;

  if v_attempt_actor_id is distinct from v_actor_id then
    raise exception 'not authorized';
  end if;

  if p_stripe_refund_id is null or length(trim(p_stripe_refund_id)) = 0 then
    raise exception 'invalid stripe refund id';
  end if;

  if p_stripe_status is null or p_stripe_status not in ('pending', 'requires_action', 'succeeded') then
    raise exception 'invalid stripe status';
  end if;

  begin
    update public.refund_issuance_attempts
    set status = 'submitted',
        stripe_refund_id = p_stripe_refund_id,
        stripe_status = p_stripe_status,
        updated_at = pg_catalog.now()
    where id = p_attempt_id
      and status in ('initiated', 'unknown')
    returning id into v_updated_id;
  exception when unique_violation then
    -- Uniqueness layer 2 (external Stripe-refund identity) tripped: a
    -- DIFFERENT attempt already owns this exact stripe_refund_id. This
    -- attempt is left untouched (still whatever it was -- 'initiated' or
    -- 'unknown') -- controlled failure, not a silent no-op and not a
    -- falsely-claimed 'submitted'.
    raise exception 'stripe refund id already claimed by another attempt';
  end;

  if v_updated_id is null then
    -- Already submitted -- safe no-op, see this function's own header
    -- comment. Never re-raise, never write a second audit row.
    return;
  end if;

  begin
    insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
    values (
      v_actor_id,
      'refund.issuance_submitted',
      'refund_requests',
      v_refund_request_id,
      jsonb_build_object('stripe_refund_id', p_stripe_refund_id, 'stripe_status', p_stripe_status)
    );
  exception when unique_violation then
    null;
  end;
end;
$$;

revoke all on function public.complete_refund_issuance_attempt(uuid, text, text) from public;
revoke all on function public.complete_refund_issuance_attempt(uuid, text, text) from anon;
revoke all on function public.complete_refund_issuance_attempt(uuid, text, text) from authenticated;
grant execute on function public.complete_refund_issuance_attempt(uuid, text, text) to authenticated;

-- ============================================================
-- Part 6: fail_refund_issuance_attempt() -- called when Stripe throws, or
-- returns an immediate failed/canceled status, for a specific attempt.
-- Best-effort operational bookkeeping, not a business invariant: never
-- writes an admin_audit_log row (neither a failure nor an ambiguous
-- outcome is a "staff decision" event in the sense the rest of this
-- table records), and a repeat/racing call against an already-terminal
-- ('submitted' or 'failed') attempt is a silent no-op rather than an
-- error -- the caller's own outcome to the admin is already decided by
-- this point (a safe, generic stripe_error message), and this call must
-- never introduce a SECOND failure mode on top of the real one.
--
-- ADMIN-1C PART B FINAL FINANCIAL INVARIANT CORRECTION: this function no
-- longer maps every call to status = 'failed' unconditionally. A thrown
-- stripe.refunds.create() call (p_failure_reason = 'stripe_error') proves
-- only that Librum did not receive a resolved response -- NOT that Stripe
-- never processed the request. Reporting 'failed' for that case would
-- overstate what is known, since the underlying idempotent request may
-- have already succeeded on Stripe's side. p_failure_reason is therefore
-- mapped to the resulting status:
--   'immediate_failed'   -> status = 'failed'   (a resolved API response
--                            Librum actually observed: CONFIRMED failure)
--   'immediate_canceled' -> status = 'failed'   (same: CONFIRMED)
--   'stripe_error'        -> status = 'unknown'  (no resolved response:
--                            AMBIGUOUS, not confirmed either way)
--   null                  -> status = 'unknown'  (the safest default when
--                            no specific reason is even supplied)
-- The failure_reason CODE itself is unchanged/preserved verbatim in every
-- case -- only the resulting STATUS differs. See the table's own header
-- comment for the full status vocabulary and why 'unknown' rows are
-- reconciled via Stripe's own live-refund lookup, never assumed safe to
-- retry over merely because the local row says 'unknown'.
--
-- ADMIN-1C PART B UNKNOWN-STATE RECOVERY CORRECTION: 'unknown' is now
-- also a valid STARTING state for this function, not only a possible
-- resulting one -- the guarded UPDATE below matches
-- `status in ('initiated', 'unknown')`, identical in spirit to
-- complete_refund_issuance_attempt()'s own recovery guard (see that
-- function's own comment for the full root-cause reasoning: without this,
-- 'unknown' would be a dead end no retry could ever resolve). This makes
-- three recovery paths possible from an 'unknown' row, all exercised by
-- this function alone:
--   unknown -> failed   (a retry's Stripe call now resolves definitively
--                         to immediate_failed/immediate_canceled)
--   unknown -> unknown  (a retry's Stripe call throws AGAIN -- still no
--                         resolved response; failure_reason is
--                         overwritten with the latest observation, but
--                         the status itself does not change)
-- (the third path, unknown -> submitted, is complete_refund_issuance_
-- attempt()'s own, not this function's.) A 'submitted' or 'failed'
-- attempt is NEVER matched by this guard -- both terminal states are
-- structurally protected from ever being downgraded back to 'unknown' by
-- a stray or racing fail call, with no separate check required.
--
-- Same ownership invariant as complete_refund_issuance_attempt() above,
-- for the same reason.
-- ============================================================

create or replace function public.fail_refund_issuance_attempt(
  p_attempt_id uuid,
  p_failure_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_attempt_actor_id uuid;
  v_target_status text;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('refunds.resolve') then
    raise exception 'not authorized';
  end if;

  select actor_id into v_attempt_actor_id
  from public.refund_issuance_attempts
  where id = p_attempt_id;

  if not found then
    raise exception 'refund issuance attempt not found';
  end if;

  if v_attempt_actor_id is distinct from v_actor_id then
    raise exception 'not authorized';
  end if;

  if p_failure_reason is not null
     and p_failure_reason not in ('stripe_error', 'immediate_failed', 'immediate_canceled') then
    raise exception 'invalid failure reason';
  end if;

  -- KNOWN FAILURE vs. UNKNOWN EXTERNAL OUTCOME -- see this function's own
  -- header comment. Only a resolved API response Librum actually observed
  -- (immediate_failed/immediate_canceled) counts as a confirmed failure;
  -- a thrown call (stripe_error) or no reason at all is ambiguous.
  v_target_status := case p_failure_reason
    when 'immediate_failed' then 'failed'
    when 'immediate_canceled' then 'failed'
    else 'unknown'
  end;

  update public.refund_issuance_attempts
  set status = v_target_status,
      failure_reason = p_failure_reason,
      updated_at = pg_catalog.now()
  where id = p_attempt_id
    and status in ('initiated', 'unknown');
  -- Deliberately no check on whether this UPDATE matched a row -- if the
  -- attempt already reached 'submitted' or 'failed' by the time this
  -- runs (a race with a concurrent completion call, extremely unlikely
  -- in practice but not impossible), leaving it as-is is correct: this
  -- function's caller has already decided to report a failure to the
  -- admin based on its OWN observation of the Stripe call, and must
  -- never raise here on top of that.
end;
$$;

revoke all on function public.fail_refund_issuance_attempt(uuid, text) from public;
revoke all on function public.fail_refund_issuance_attempt(uuid, text) from anon;
revoke all on function public.fail_refund_issuance_attempt(uuid, text) from authenticated;
grant execute on function public.fail_refund_issuance_attempt(uuid, text) to authenticated;

-- ============================================================
-- Part 7: audit-event insertion for review_book_report(). CREATE OR
-- REPLACE on its existing, unchanged signature -- authorization/business
-- logic is byte-for-byte identical to migration 040's own version; only
-- one insert statement is added, immediately after the UPDATE's own
-- success check and before the function returns, inside the same
-- implicit transaction. A failed/stale/no-op review (the UPDATE matches
-- zero rows, or an earlier validation already raised) never reaches the
-- insert at all. Grants are preserved automatically by CREATE OR REPLACE
-- on an unchanged signature and are not repeated here, matching
-- migration 040's own precedent when it performed this exact kind of
-- edit to this same function.
-- ============================================================

create or replace function public.review_book_report(
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
  v_notes_added boolean;
begin
  v_admin_id := auth.uid();
  if v_admin_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('reports.resolve') then
    raise exception 'not authorized';
  end if;

  if p_decision not in ('resolved', 'dismissed') then
    raise exception 'p_decision must be ''resolved'' or ''dismissed''';
  end if;

  if p_admin_notes is not null and pg_catalog.char_length(p_admin_notes) > 2000 then
    raise exception 'p_admin_notes must be 2000 characters or fewer';
  end if;

  v_notes_added := nullif(trim(coalesce(p_admin_notes, '')), '') is not null;

  update public.book_reports
  set status = p_decision,
      reviewed_at = pg_catalog.now(),
      reviewed_by = v_admin_id,
      admin_notes = nullif(trim(coalesce(p_admin_notes, '')), '')
  where id = p_id
    and status = 'open'
  returning id into v_updated_id;

  if v_updated_id is null then
    raise exception 'no reviewable report found for this id';
  end if;

  -- ADMIN-1C Part B: audit event. Only old_status/new_status/notes_added
  -- -- never the report reason, reporter identity, or admin_notes text
  -- itself (Part A's own explicit "do not duplicate full report text or
  -- long staff notes" principle).
  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (
    v_admin_id,
    case p_decision when 'resolved' then 'report.resolved' else 'report.dismissed' end,
    'book_reports',
    p_id,
    jsonb_build_object('old_status', 'open', 'new_status', p_decision, 'notes_added', v_notes_added)
  );
end;
$$;

-- ============================================================
-- Part 8: audit-event insertion for review_refund_request(). Same
-- treatment as Part 7. This is the internal STAFF DECISION (approve/
-- reject) only -- it never touches Stripe. The separate external
-- side-effect event (refund.issuance_submitted) is recorded by
-- complete_refund_issuance_attempt() above, from a different call site,
-- at a different (later, possibly never-reached) moment.
--
-- ADMIN-1C PART B PRE-FINALIZE CORRECTION: the audit action for a
-- rejection is now 'refund.review_rejected', matching
-- refund_requests.status's own actual value ('rejected', migration
-- 029's CHECK constraint) -- the first draft used 'refund.review_denied',
-- a softer synonym that didn't match the real domain status anywhere
-- else in this schema.
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
  v_notes_added boolean;
begin
  v_admin_id := auth.uid();
  if v_admin_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('refunds.resolve') then
    raise exception 'not authorized';
  end if;

  if p_decision not in ('approved', 'rejected') then
    raise exception 'p_decision must be ''approved'' or ''rejected''';
  end if;

  if p_admin_notes is not null and pg_catalog.char_length(p_admin_notes) > 2000 then
    raise exception 'p_admin_notes must be 2000 characters or fewer';
  end if;

  v_notes_added := nullif(trim(coalesce(p_admin_notes, '')), '') is not null;

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

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (
    v_admin_id,
    case p_decision when 'approved' then 'refund.review_approved' else 'refund.review_rejected' end,
    'refund_requests',
    p_id,
    jsonb_build_object('old_status', 'requested', 'new_status', p_decision, 'notes_added', v_notes_added)
  );
end;
$$;

-- ============================================================
-- Part 9: indexes.
--
-- admin_audit_log (created_at desc, id desc): supports keyset
-- pagination -- every list_admin_audit_events() call, filtered or not,
-- orders and paginates on this exact pair. Unchanged, retained.
--
-- admin_audit_log (action, created_at desc): RE-EVALUATED per the
-- correction brief. Retained: `action` is one of the four required V1
-- filters (ADMIN-1C Part A's own filter design), so this directly
-- supports a stated, real query shape (an action-filtered, newest-first
-- listing) rather than a speculative one -- without it, that filtered
-- query would need a full-table sort at any real row count. Not removed.
--
-- admin_audit_log ((metadata ->> 'stripe_refund_id')) partial unique,
-- where action = 'refund.issuance_submitted': RETAINED as a TERTIARY
-- backstop (see complete_refund_issuance_attempt()'s own comment). Three
-- distinct uniqueness layers now exist, guarding three distinct things,
-- from primary to tertiary:
--   1. PRIMARY: complete_refund_issuance_attempt()'s own `where status =
--      'initiated'` UPDATE guard (attempt-level idempotency) -- prevents
--      a repeat completion of the SAME attempt from writing a second
--      audit row.
--   2. SECONDARY: refund_issuance_attempts_stripe_refund_id_idx (Part 3
--      above) -- prevents a DIFFERENT attempt from claiming a
--      stripe_refund_id another attempt already owns, enforced at the
--      point of claim with a controlled exception, not a silent no-op.
--   3. TERTIARY: this index -- guards the audit table's OWN row
--      uniqueness directly, in case layers 1/2 were ever somehow
--      bypassed (e.g. a future direct SQL patch). Costs nothing to keep
--      as defense-in-depth at the audit-table layer specifically.
-- These are deliberately three DISTINCT layers: attempt-identity
-- idempotency (Part 3's unique index on idempotency_key) is a FOURTH,
-- separate concept again (which attempt ROW a given CLICK resolves to,
-- not which Stripe refund a given ATTEMPT may claim).
--
-- refund_issuance_attempts indexes: see Part 3 above (idempotency_key
-- unique, stripe_refund_id unique where not null, refund_request_id for
-- reconciliation lookups) -- not repeated here.
-- ============================================================

create index admin_audit_log_created_at_id_idx
  on public.admin_audit_log (created_at desc, id desc);

create index admin_audit_log_action_created_at_idx
  on public.admin_audit_log (action, created_at desc);

create unique index admin_audit_log_refund_issuance_stripe_id_idx
  on public.admin_audit_log ((metadata ->> 'stripe_refund_id'))
  where action = 'refund.issuance_submitted';

-- ============================================================
-- ADMIN-1D PART B: finance/reconciliation READ PRIMITIVES -- one new
-- permission (finance.view) and six new SECURITY DEFINER read
-- functions (refund operational-state classification, dispute
-- visibility, single-book checkout-exception detection, refund/
-- entitlement consistency checks, and a summary-count RPC). No new
-- table, no new column, no new index, and no Stripe call anywhere in
-- this addition. See supabase/migrations/043_finance_reconciliation_
-- reads.sql for the full design reasoning (this is that file's exact
-- SQL, appended here per this file's own established convention).
-- ============================================================

--
-- Migrations 002 through 042 are immutable (already production-applied)
-- and are not modified by this file in any way.

-- ============================================================
-- Part 1: finance.view -- extends staff_has_permission()'s existing
-- 'admin' branch only, identical treatment to how ADMIN-1C Part B added
-- audit.view. owner is unconditionally true already (no change needed);
-- moderator/support/editor get no new branch, so
-- staff_has_permission('finance.view') already returns false for them by
-- construction, exactly like every other permission they don't hold.
-- This is a CREATE OR REPLACE on staff_has_permission()'s existing,
-- unchanged signature -- its own revoke-all-then-grant-execute-to-
-- authenticated block (migration 040) is preserved automatically and is
-- not repeated here, the same convention migration 042 itself already
-- used when it added audit.view this same way.
--
-- Deliberately NOT added here (ADMIN-1D Part B's own explicit scope
-- boundary): finance.reconcile, finance.recover_orphaned,
-- finance.export. Part B/C are read-only; introducing a mutation
-- permission before any mutation design is reviewed and approved would
-- grant a capability with nothing behind it yet, and risks the matrix
-- drifting out of sync with what actually exists -- add each mutation
-- permission in the same change that adds the RPC it guards, in a later
-- part.
-- ============================================================

create or replace function public.staff_has_permission(p_permission text)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.staff_members sm
    where sm.user_id = auth.uid()
      and (
        sm.role = 'owner'
        or (
          sm.role = 'admin'
          and p_permission in (
            'admin.access', 'reports.view', 'reports.resolve',
            'refunds.view', 'refunds.resolve', 'staff.view', 'audit.view',
            'finance.view'
          )
        )
        or (
          sm.role = 'moderator'
          and p_permission in ('admin.access', 'reports.view', 'reports.resolve')
        )
        or (
          sm.role = 'support'
          and p_permission in ('admin.access', 'refunds.view')
        )
      )
  );
$$;

-- ============================================================
-- Part 2: refund_reconciliation_rows() -- a PRIVATE helper (no EXECUTE
-- grant to authenticated at all, same posture as payment_intent_has_
-- lost_dispute() from migration 035/037), so the exact same
-- classification logic is computed in exactly one place and reused by
-- both list_refund_reconciliation_states() (Part 3, paginated/filtered)
-- and get_finance_summary_counts() (Part 8, aggregated) -- never
-- duplicated between them.
--
-- CRITICAL CORRECTNESS NOTE (ADMIN-1D Part A's own finding, carried
-- forward verbatim): 'initiated' does NOT mean "Stripe was never
-- called." The durability ordering begin_refund_issuance_attempt()
-- establishes is: (1) a durable 'initiated' row is committed, (2) THEN
-- stripe.refunds.create() may run, (3) THEN the local completion/failure
-- RPC records the outcome. A row still showing 'initiated' can mean the
-- process died before step 2, during step 2, or even AFTER Stripe
-- accepted the refund but before step 3 ever ran -- Librum genuinely
-- cannot distinguish these from the local row alone. This file therefore
-- never encodes "initiated = never called Stripe" anywhere -- a stale
-- 'initiated' row is classified as 'approved_attempt_stale_initiated'
-- (ambiguous, needs human reconciliation, exactly like an 'unknown' row
-- -- NOT as "safe to just retry, nothing happened yet").
--
-- APPROVED, NEVER ATTEMPTED: needs_attention = true IMMEDIATELY, no
-- grace period. ADMIN-1D PART B FINAL PRE-COMMIT CLASSIFICATION
-- CORRECTION removed an earlier draft's invented 24-hour threshold here.
-- Once staff has explicitly approved a refund request, issuing it is the
-- one remaining step of an administrative workflow Librum itself already
-- decided to complete -- there is no legitimate reason to wait a full
-- day before treating an unattempted approval as something a
-- reconciliation view should surface. This is NOT a claim that the
-- refund is broken, late, or overdue -- see describeRefundOperationalState
-- in finance-logic.ts, whose label for this exact state is "Approved —
-- awaiting issuance," never "Failed"/"Overdue"/"Broken". needs_attention
-- here means "this is the kind of thing an exception queue should list,"
-- not "something has gone wrong."
--
-- STALE-INITIATED THRESHOLD: 5 minutes -- a Librum OPERATIONAL TRIAGE
-- HEURISTIC for a synchronous begin -> stripe.refunds.create() ->
-- complete/fail flow (executeApprovedRefund(), issue-refund.ts), not a
-- database invariant derived from any hosting provider's current
-- execution-timeout configuration. No deployment/platform assumption is
-- part of this threshold's correctness -- it exists purely to give staff
-- a practical operational signal ("this attempt has been sitting
-- unresolved long enough to be worth a look") without claiming to prove
-- anything about what actually happened to the underlying Stripe call.
-- 5 minutes is deliberately generous relative to how quickly this flow
-- ordinarily completes, so an attempt genuinely still in progress is
-- essentially never flagged mid-flight, while a row still 'initiated'
-- after that long is worth surfacing for human reconciliation -- not
-- because SQL claims to know the request has definitely terminated, only
-- because it has been ambiguous for longer than is operationally normal.
-- Not user-configurable in V1, per this file's own explicit scope
-- boundary -- hardcoded here, in exactly one place; TypeScript never
-- needs to know this value at all (it only ever formats the label SQL
-- already computed, never recomputes staleness itself).
--
-- SUBMITTED-AWAITING-FINALIZATION THRESHOLD: 1 hour -- likewise a
-- Librum operational triage heuristic for ordinary webhook-finalization
-- latency (refund.updated/charge.refunded settling refund_requests.
-- status = 'refunded'), NOT a Stripe-guaranteed delivery SLA and not a
-- claim that Stripe has failed. Measured from the ATTEMPT'S OWN
-- updated_at (the actual transition-to-'submitted' timestamp complete_
-- refund_issuance_attempt() writes), not its created_at (which can be
-- much earlier if the same row started as 'unknown' and only resolved to
-- 'submitted' on a later retry). A refund is not "broken" merely for
-- passing this threshold -- it means the ordinary settlement window has
-- elapsed without confirmation, which is worth a look, not an alarm.
-- ============================================================

create or replace function public.refund_reconciliation_rows()
returns table (
  refund_request_id uuid,
  reader_id uuid,
  amount_cents integer,
  refund_request_status text,
  requested_at timestamptz,
  reviewed_at timestamptz,
  latest_attempt_id uuid,
  latest_attempt_status text,
  latest_attempt_created_at timestamptz,
  latest_attempt_updated_at timestamptz,
  stripe_refund_id text,
  stripe_status text,
  operational_state text,
  needs_attention boolean
)
language sql
security definer
set search_path = ''
stable
as $$
  with latest_attempts as (
    select distinct on (refund_issuance_attempts.refund_request_id)
      refund_issuance_attempts.id,
      refund_issuance_attempts.refund_request_id,
      refund_issuance_attempts.status,
      refund_issuance_attempts.stripe_refund_id,
      refund_issuance_attempts.stripe_status,
      refund_issuance_attempts.created_at,
      refund_issuance_attempts.updated_at
    from public.refund_issuance_attempts
    order by
      refund_issuance_attempts.refund_request_id,
      refund_issuance_attempts.created_at desc,
      refund_issuance_attempts.id desc
  )
  select
    rr.id as refund_request_id,
    rr.reader_id,
    rr.amount_cents,
    rr.status as refund_request_status,
    rr.requested_at,
    rr.reviewed_at,
    la.id as latest_attempt_id,
    la.status as latest_attempt_status,
    la.created_at as latest_attempt_created_at,
    la.updated_at as latest_attempt_updated_at,
    la.stripe_refund_id,
    la.stripe_status,
    case
      when rr.status = 'requested' then 'requested'
      when rr.status = 'rejected' then 'rejected'
      when rr.status = 'refunded' then 'refunded'
      when rr.status = 'cancelled' then 'cancelled'
      when rr.status = 'approved' and la.id is null then 'approved_unattempted'
      -- Strict '>' here, paired with needs_attention's own '<=' below, so
      -- the two never disagree at the exact boundary instant: an attempt
      -- exactly 5 minutes old is classified stale in BOTH fields, never
      -- "fresh" in one and "needs attention" in the other.
      when rr.status = 'approved' and la.status = 'initiated'
        and la.created_at > (now() - interval '5 minutes') then 'approved_attempt_initiated'
      when rr.status = 'approved' and la.status = 'initiated' then 'approved_attempt_stale_initiated'
      when rr.status = 'approved' and la.status = 'unknown' then 'approved_attempt_unknown'
      when rr.status = 'approved' and la.status = 'failed' then 'approved_attempt_failed'
      when rr.status = 'approved' and la.status = 'submitted' then 'approved_attempt_submitted'
      -- Unreachable given refund_requests.status's and refund_issuance_
      -- attempts.status's own CHECK constraints -- kept as an explicit,
      -- visible fallback rather than silently returning null, matching
      -- this schema's universal fail-loud-not-silent discipline.
      else 'unclassified'
    end as operational_state,
    case
      -- No grace period: an approved, never-attempted request needs
      -- attention immediately -- see this function's own header comment
      -- (ADMIN-1D PART B FINAL PRE-COMMIT CLASSIFICATION CORRECTION) for
      -- why an invented waiting period was removed here.
      when rr.status = 'approved' and la.id is null then true
      when rr.status = 'approved' and la.status = 'initiated'
        and la.created_at <= (now() - interval '5 minutes') then true
      when rr.status = 'approved' and la.status = 'unknown' then true
      when rr.status = 'approved' and la.status = 'failed' then true
      when rr.status = 'approved' and la.status = 'submitted'
        and la.updated_at <= (now() - interval '1 hour') then true
      else false
    end as needs_attention
  from public.refund_requests rr
  left join latest_attempts la on la.refund_request_id = rr.id;
$$;

revoke all on function public.refund_reconciliation_rows() from public;
revoke all on function public.refund_reconciliation_rows() from anon;
revoke all on function public.refund_reconciliation_rows() from authenticated;
-- No grant to authenticated at all, deliberately -- this is an internal
-- composition helper, never a direct application RPC call. Every
-- legitimate caller is another SECURITY DEFINER function in this same
-- file, which keeps working via the shared function-owner's own implicit
-- EXECUTE privilege, unaffected by this revoke -- the exact same pattern
-- payment_intent_has_lost_dispute() already established (migrations
-- 035/037).

-- ============================================================
-- Part 3: list_refund_reconciliation_states() -- the ONE finance-view
-- read path for refund operational state. Deliberately the COMPLETE
-- refund-status list (requested/rejected/refunded/cancelled included,
-- not just the approved-and-stuck exceptions), filterable down to a
-- needs_attention-only view -- chosen over a narrower "exceptions only"
-- RPC specifically so a future /admin/finance and a future /admin/
-- refunds integration can both call this ONE function with different
-- filters, rather than each growing its own independent copy of the
-- operational_state classification logic. p_operational_state and
-- p_needs_attention are independent, composable filters (both may be
-- supplied, either, or neither).
--
-- Keyset pagination on (requested_at desc, refund_request_id desc),
-- mirroring list_admin_audit_events()'s own established cursor
-- contract exactly (ADMIN-1C Part B) -- no OFFSET anywhere. p_limit
-- clamped identically: null -> 25, below 1 -> 1, above 100 -> 100.
-- ============================================================

create or replace function public.list_refund_reconciliation_states(
  p_operational_state text default null,
  p_needs_attention boolean default null,
  p_cursor_requested_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 25
)
returns table (
  refund_request_id uuid,
  reader_id uuid,
  reader_display_name text,
  amount_cents integer,
  refund_request_status text,
  requested_at timestamptz,
  reviewed_at timestamptz,
  latest_attempt_id uuid,
  latest_attempt_status text,
  latest_attempt_created_at timestamptz,
  latest_attempt_updated_at timestamptz,
  stripe_refund_id text,
  stripe_status text,
  operational_state text,
  needs_attention boolean
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_limit integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('finance.view') then
    raise exception 'not authorized';
  end if;

  if p_operational_state is not null and p_operational_state not in (
    'requested', 'rejected', 'refunded', 'cancelled',
    'approved_unattempted', 'approved_attempt_initiated',
    'approved_attempt_stale_initiated', 'approved_attempt_unknown',
    'approved_attempt_failed', 'approved_attempt_submitted'
  ) then
    raise exception 'invalid operational_state filter';
  end if;

  if (p_cursor_requested_at is null) <> (p_cursor_id is null) then
    raise exception 'invalid cursor';
  end if;

  v_limit := coalesce(p_limit, 25);
  if v_limit < 1 then
    v_limit := 1;
  elsif v_limit > 100 then
    v_limit := 100;
  end if;

  return query
    select
      r.refund_request_id,
      r.reader_id,
      p.display_name as reader_display_name,
      r.amount_cents,
      r.refund_request_status,
      r.requested_at,
      r.reviewed_at,
      r.latest_attempt_id,
      r.latest_attempt_status,
      r.latest_attempt_created_at,
      r.latest_attempt_updated_at,
      r.stripe_refund_id,
      r.stripe_status,
      r.operational_state,
      r.needs_attention
    from public.refund_reconciliation_rows() r
    left join public.profiles p on p.id = r.reader_id
    where (p_operational_state is null or r.operational_state = p_operational_state)
      and (p_needs_attention is null or r.needs_attention = p_needs_attention)
      and (
        p_cursor_requested_at is null
        or (r.requested_at, r.refund_request_id) < (p_cursor_requested_at, p_cursor_id)
      )
    order by r.requested_at desc, r.refund_request_id desc
    limit v_limit;
end;
$$;

revoke all on function public.list_refund_reconciliation_states(
  text, boolean, timestamptz, uuid, integer
) from public;
revoke all on function public.list_refund_reconciliation_states(
  text, boolean, timestamptz, uuid, integer
) from anon;
revoke all on function public.list_refund_reconciliation_states(
  text, boolean, timestamptz, uuid, integer
) from authenticated;
grant execute on function public.list_refund_reconciliation_states(
  text, boolean, timestamptz, uuid, integer
) to authenticated;

-- ============================================================
-- Part 4: list_finance_disputes() -- read-only projection of
-- payment_disputes. Deliberately does NOT expose transfer_reversal_
-- failure_message: that column can hold a raw, unbounded Stripe SDK
-- error string (`stripeError.message ?? String(error)`, see
-- failTransferReversalAttempt() call site in src/app/api/webhooks/
-- stripe/route.ts) -- exactly the "unbounded/raw Stripe error" this
-- file's own design brief prohibits surfacing. transfer_reversal_
-- failure_code IS exposed: it is Stripe's own short, bounded error-code
-- taxonomy (e.g. 'insufficient_funds'), not free text.
--
-- needs_attention does NOT claim knowledge of any Stripe evidence
-- deadline -- payment_disputes stores no evidence_due_by/needs_response
-- column (confirmed: not part of this table, migration 035/036), so no
-- such fact is fabricated here. needs_attention is exactly two safe,
-- source-grounded signals, OR'd together:
--   (a) status is not a recognized TERMINAL Stripe dispute status. The
--       terminal set is a small, explicit allow-list ('won', 'lost',
--       'warning_closed', 'charge_refunded') -- status carries NO check
--       constraint in this schema (migration 035's own comment: Stripe's
--       SDK types Dispute.status as an open string union, deliberately
--       unconstrained here). Failing CLOSED (an unrecognized future
--       Stripe status counts as non-terminal, i.e. needs_attention)
--       matches this schema's universal "never silently treat an
--       unrecognized value as safe" discipline.
--   (b) status = 'lost' and transfer_reversal_status = 'failed', OR
--       transfer_reversal_status = 'attempting' and stale by the SAME
--       10-minute threshold the existing reconciliation route already
--       uses (STALE_ATTEMPTING_THRESHOLD_MS = 10 * 60 * 1000, src/app/
--       api/internal/reconcile-transfer-reversals/route.ts) -- reused
--       verbatim, not reinvented, so this RPC's notion of "stale
--       attempting" never drifts from the cron's own.
--
-- reader_id/reader_display_name are best-effort DISPLAY context, not an
-- authoritative join: a dispute's stripe_payment_intent_id is not
-- guaranteed to resolve to exactly one purchases/bundle_checkout_
-- snapshots row (a bundle fans out to several purchases rows sharing one
-- PI, and a book can later be repurchased, which overwrites its
-- purchases row's own stripe_payment_intent_id -- see this file's own
-- Part 7 comment for the full reasoning behind why that makes an
-- absence non-authoritative). Resolved bundle-first (bundle_checkout_
-- snapshots.stripe_payment_intent_id IS unique, a true 1:1 match). Falls
-- back to the most recent matching purchases row otherwise, deterministic
-- via LATERAL ... ORDER BY created_at desc, id desc LIMIT 1. A dispute
-- whose PI matches no row at all (context genuinely unavailable) simply
-- returns reader_id/reader_display_name as null -- never fabricated.
-- ============================================================

create or replace function public.list_finance_disputes(
  p_needs_attention boolean default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 25
)
returns table (
  id uuid,
  stripe_dispute_id text,
  stripe_payment_intent_id text,
  reader_id uuid,
  reader_display_name text,
  status text,
  reason text,
  amount_cents integer,
  created_at timestamptz,
  updated_at timestamptz,
  transfer_reversal_status text,
  stripe_transfer_reversal_id text,
  transfer_reversal_attempt_count integer,
  transfer_reversal_attempted_at timestamptz,
  transfer_reversal_succeeded_at timestamptz,
  transfer_reversal_failure_code text,
  needs_attention boolean
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_limit integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('finance.view') then
    raise exception 'not authorized';
  end if;

  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception 'invalid cursor';
  end if;

  v_limit := coalesce(p_limit, 25);
  if v_limit < 1 then
    v_limit := 1;
  elsif v_limit > 100 then
    v_limit := 100;
  end if;

  return query
    select
      pd.id,
      pd.stripe_dispute_id,
      pd.stripe_payment_intent_id,
      coalesce(bundle_ctx.reader_id, purchase_ctx.reader_id) as reader_id,
      coalesce(bundle_ctx.reader_display_name, purchase_ctx.reader_display_name) as reader_display_name,
      pd.status,
      pd.reason,
      pd.amount_cents,
      pd.created_at,
      pd.updated_at,
      pd.transfer_reversal_status,
      pd.stripe_transfer_reversal_id,
      pd.transfer_reversal_attempt_count,
      pd.transfer_reversal_attempted_at,
      pd.transfer_reversal_succeeded_at,
      pd.transfer_reversal_failure_code,
      (
        pd.status not in ('won', 'lost', 'warning_closed', 'charge_refunded')
        or (
          pd.status = 'lost'
          and (
            pd.transfer_reversal_status = 'failed'
            or (
              pd.transfer_reversal_status = 'attempting'
              and pd.transfer_reversal_attempted_at <= (now() - interval '10 minutes')
            )
          )
        )
      ) as needs_attention
    from public.payment_disputes pd
    left join lateral (
      select bcs.reader_id, pr.display_name as reader_display_name
      from public.bundle_checkout_snapshots bcs
      left join public.profiles pr on pr.id = bcs.reader_id
      where bcs.stripe_payment_intent_id = pd.stripe_payment_intent_id
      limit 1
    ) bundle_ctx on true
    left join lateral (
      select pu.reader_id, pr2.display_name as reader_display_name
      from public.purchases pu
      left join public.profiles pr2 on pr2.id = pu.reader_id
      where pu.stripe_payment_intent_id = pd.stripe_payment_intent_id
      order by pu.created_at desc, pu.id desc
      limit 1
    ) purchase_ctx on true
    where (
      p_needs_attention is null
      or (
        pd.status not in ('won', 'lost', 'warning_closed', 'charge_refunded')
        or (
          pd.status = 'lost'
          and (
            pd.transfer_reversal_status = 'failed'
            or (
              pd.transfer_reversal_status = 'attempting'
              and pd.transfer_reversal_attempted_at <= (now() - interval '10 minutes')
            )
          )
        )
      ) = p_needs_attention
    )
    and (
      p_cursor_created_at is null
      or (pd.created_at, pd.id) < (p_cursor_created_at, p_cursor_id)
    )
    order by pd.created_at desc, pd.id desc
    limit v_limit;
end;
$$;

revoke all on function public.list_finance_disputes(
  boolean, timestamptz, uuid, integer
) from public;
revoke all on function public.list_finance_disputes(
  boolean, timestamptz, uuid, integer
) from anon;
revoke all on function public.list_finance_disputes(
  boolean, timestamptz, uuid, integer
) from authenticated;
grant execute on function public.list_finance_disputes(
  boolean, timestamptz, uuid, integer
) to authenticated;

-- ============================================================
-- Part 5: list_finance_checkout_exceptions() -- single-book checkout
-- reconciliation only. Exactly the existing book_checkout_intents_
-- needs_reconciliation_idx partial index (completed_at) where fulfilled_
-- at is null and completed_at is not null, migration 032 -- these rows
-- are, BY CONSTRUCTION of that table's own CHECK-constraint state
-- machine, Stripe-confirmed-paid transactions that did not grant
-- entitlement, each carrying an authoritative reconciliation_reason.
--
-- book_title is read from book_checkout_intents.book_title itself (a
-- column frozen at checkout time), never joined live against books --
-- this is deliberate: a 'book_or_reader_deleted' reconciliation_reason
-- means the live books row may no longer exist at all, and the frozen
-- column is exactly what survives that case.
--
-- NO BUNDLE EQUIVALENT IS BUILT HERE -- see this file's own Part 7
-- comment for why: bundle_checkout_snapshots has no completed_at-
-- equivalent column, so "Stripe confirmed payment but Librum failed to
-- fulfill" cannot be safely distinguished from "the reader never paid
-- at all" for a bundle checkout with the CURRENT schema. Per this
-- migration's own scope discipline (report a real limitation rather
-- than invent an unproven classifier), that gap is documented, not
-- papered over with a lower-confidence heuristic mixed into the same
-- "exception" list as these high-confidence rows.
-- ============================================================

create or replace function public.list_finance_checkout_exceptions(
  p_cursor_completed_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 25
)
returns table (
  intent_id uuid,
  book_id uuid,
  book_title text,
  reader_id uuid,
  reader_display_name text,
  price_cents_at_checkout integer,
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  completed_at timestamptz,
  reconciliation_reason text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_limit integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('finance.view') then
    raise exception 'not authorized';
  end if;

  if (p_cursor_completed_at is null) <> (p_cursor_id is null) then
    raise exception 'invalid cursor';
  end if;

  v_limit := coalesce(p_limit, 25);
  if v_limit < 1 then
    v_limit := 1;
  elsif v_limit > 100 then
    v_limit := 100;
  end if;

  return query
    select
      bci.id as intent_id,
      bci.book_id,
      bci.book_title,
      bci.reader_id,
      p.display_name as reader_display_name,
      bci.price_cents_at_checkout,
      bci.stripe_checkout_session_id,
      bci.stripe_payment_intent_id,
      bci.completed_at,
      bci.reconciliation_reason,
      bci.created_at
    from public.book_checkout_intents bci
    left join public.profiles p on p.id = bci.reader_id
    where bci.completed_at is not null
      and bci.fulfilled_at is null
      and (
        p_cursor_completed_at is null
        or (bci.completed_at, bci.id) < (p_cursor_completed_at, p_cursor_id)
      )
    order by bci.completed_at desc, bci.id desc
    limit v_limit;
end;
$$;

revoke all on function public.list_finance_checkout_exceptions(
  timestamptz, uuid, integer
) from public;
revoke all on function public.list_finance_checkout_exceptions(
  timestamptz, uuid, integer
) from anon;
revoke all on function public.list_finance_checkout_exceptions(
  timestamptz, uuid, integer
) from authenticated;
grant execute on function public.list_finance_checkout_exceptions(
  timestamptz, uuid, integer
) to authenticated;

-- ============================================================
-- Part 6: list_finance_refund_entitlement_mismatches() -- three narrow,
-- SAFE-DIRECTION-ONLY consistency checks, each an EXISTS-based positive
-- signal, never inferred from an absence of rows. See this file's own
-- Part 7 comment for exactly why the absence direction is unsafe to
-- check (purchases.stripe_payment_intent_id gets silently overwritten
-- on a repurchase of the same book, so "zero matching purchases rows"
-- does not reliably mean anything by itself).
--
--   'refunded_request_active_purchase' -- refund_requests.status =
--     'refunded' (not a snapshot-based request) but a purchases row
--     matching its stripe_payment_intent_id still shows refunded_at is
--     null. A real drift: entitlement should have been revoked when the
--     request settled.
--   'refunded_request_active_bundle_snapshot' -- same idea, for a
--     snapshot-based request (refund_requests.bundle_checkout_snapshot_
--     id is not null): the linked bundle_checkout_snapshots.refunded_at
--     is still null despite the request itself reading 'refunded'.
--   'purchase_refunded_request_unresolved' -- a purchases row shows
--     refunded_at is not null, but a MATCHING refund_requests row (same
--     stripe_payment_intent_id) exists and its own status is not yet
--     'refunded'. Deliberately does NOT fire when zero refund_requests
--     rows exist for that PI at all -- a direct Stripe Dashboard refund
--     with no corresponding Librum refund_requests row is an explicitly
--     documented, legitimate, expected state (refund_requests.reviewed_
--     at's own column comment, migration 029), not a data gap.
--
-- No cursor/keyset pagination on this one, deliberately -- unlike the
-- other list RPCs above, this is a rare cross-consistency health check,
-- not a growing operational queue: in a healthy system every one of
-- these three conditions should return zero rows. A plain bounded LIMIT
-- (still clamped 1-100, still finance.view-gated) is proportionate; add
-- real keyset pagination later if actual volume ever demonstrates the
-- need.
-- ============================================================

create or replace function public.list_finance_refund_entitlement_mismatches(
  p_limit integer default 25
)
returns table (
  mismatch_type text,
  refund_request_id uuid,
  purchase_id uuid,
  bundle_checkout_snapshot_id uuid,
  reader_id uuid,
  reader_display_name text,
  stripe_payment_intent_id text,
  amount_cents integer
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_limit integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('finance.view') then
    raise exception 'not authorized';
  end if;

  v_limit := coalesce(p_limit, 25);
  if v_limit < 1 then
    v_limit := 1;
  elsif v_limit > 100 then
    v_limit := 100;
  end if;

  return query
    (
      select
        'refunded_request_active_purchase'::text as mismatch_type,
        rr.id as refund_request_id,
        pu.id as purchase_id,
        null::uuid as bundle_checkout_snapshot_id,
        rr.reader_id,
        p.display_name as reader_display_name,
        rr.stripe_payment_intent_id,
        rr.amount_cents
      from public.refund_requests rr
      join public.purchases pu on pu.stripe_payment_intent_id = rr.stripe_payment_intent_id
      left join public.profiles p on p.id = rr.reader_id
      where rr.status = 'refunded'
        and rr.bundle_checkout_snapshot_id is null
        and pu.refunded_at is null
    )
    union all
    (
      select
        'refunded_request_active_bundle_snapshot'::text,
        rr.id,
        null::uuid,
        bcs.id,
        rr.reader_id,
        p.display_name,
        rr.stripe_payment_intent_id,
        rr.amount_cents
      from public.refund_requests rr
      join public.bundle_checkout_snapshots bcs on bcs.id = rr.bundle_checkout_snapshot_id
      left join public.profiles p on p.id = rr.reader_id
      where rr.status = 'refunded'
        and rr.bundle_checkout_snapshot_id is not null
        and bcs.refunded_at is null
    )
    union all
    (
      select
        'purchase_refunded_request_unresolved'::text,
        rr.id,
        pu.id,
        null::uuid,
        pu.reader_id,
        p.display_name,
        pu.stripe_payment_intent_id,
        pu.amount_cents
      from public.purchases pu
      join public.refund_requests rr on rr.stripe_payment_intent_id = pu.stripe_payment_intent_id
      left join public.profiles p on p.id = pu.reader_id
      where pu.refunded_at is not null
        and rr.status <> 'refunded'
    )
    limit v_limit;
end;
$$;

revoke all on function public.list_finance_refund_entitlement_mismatches(integer) from public;
revoke all on function public.list_finance_refund_entitlement_mismatches(integer) from anon;
revoke all on function public.list_finance_refund_entitlement_mismatches(integer) from authenticated;
grant execute on function public.list_finance_refund_entitlement_mismatches(integer) to authenticated;

-- ============================================================
-- Part 7: NOT built in this file -- explicitly out of scope, recorded
-- here so the reasoning lives next to the code it constrains.
--
-- (a) Bundle checkout exception detection ("payment succeeded but not
--     fulfilled" for a bundle). bundle_checkout_snapshots has no
--     completed_at-equivalent column: fulfillBundleSnapshot() (the
--     webhook) sets fulfilled_at, total_amount_cents, and stripe_
--     payment_intent_id together, in the SAME compare-and-swap UPDATE
--     (guarded `where fulfilled_at is null`, src/app/api/webhooks/
--     stripe/route.ts). If that write never lands, stripe_payment_
--     intent_id stays null too -- there is no durable signal left behind
--     that distinguishes "Stripe actually confirmed this payment" from
--     "the reader never paid at all." Reporting this limitation, not
--     inventing a lower-confidence heuristic (e.g. "expired + a Stripe
--     session id was ever linked back") that would sit in the same
--     "exception" list as list_finance_checkout_exceptions()'s
--     genuinely proven rows above and quietly erode trust in it.
--
-- (b) Any repurchase-driven "orphaned purchase" detector. finalize_
--     book_checkout_intent()'s own upsert (`on conflict (book_id,
--     reader_id) do update`) overwrites stripe_checkout_session_id/
--     stripe_payment_intent_id/amount_cents on a repurchase of the same
--     book by the same reader -- so a HISTORICAL refunded transaction's
--     payment_intent_id can silently stop appearing in purchases at all
--     once that book is bought again. This means "zero purchases rows
--     match this payment_intent_id" is NOT a safe signal of anything by
--     itself (it can mean "legitimately no purchases row ever existed
--     here", e.g. the zero-eligible-item bundle case, OR "a later
--     repurchase overwrote the row this PI used to own"), which is
--     exactly why list_finance_refund_entitlement_mismatches() above
--     only ever fires on rows that DO exist and disagree -- never on an
--     absence.
--
-- (c) Any Stripe-mutating recovery action, including FIN-OPS-1 (an
--     'unknown'/'initiated' refund_issuance_attempts row whose actor_id
--     has gone null). This file adds ZERO new INSERT/UPDATE/DELETE
--     against refund_issuance_attempts, payment_disputes, book_
--     checkout_intents, or bundle_checkout_snapshots, and does not touch
--     begin_refund_issuance_attempt()/complete_refund_issuance_
--     attempt()/fail_refund_issuance_attempt()'s existing `attempt.
--     actor_id = auth.uid()` ownership check in any way. The broader
--     actor-takeover problem this file's own audit predecessor
--     (ADMIN-1D Part A) identified is real, but explicitly deferred to
--     ADMIN-1D Part D, and is BROADER than "actor_id is null" alone --
--     it also covers an actor who has been demoted, or who is simply a
--     different staff member than the one who began the attempt. No
--     code for any of that exists here.
-- ============================================================

-- ============================================================
-- Part 8: get_finance_summary_counts() -- one small, cheap summary RPC
-- for a future /admin/finance landing page. Deliberately counts only --
-- no monetary aggregate (no SUM(amount_cents) anywhere): none of these
-- counts have a concrete operational use for a dollar total, only for
-- "how many things need a human to look at them," per this file's own
-- design brief. Every predicate below exactly mirrors its corresponding
-- list RPC's own WHERE clause (Parts 3/4/5/6), so the count a caller
-- sees always agrees with what that list RPC would actually return for
-- the same filter -- and every one of those predicates is already
-- backed by an existing index or, for refund_reconciliation_rows()
-- itself, a table whose realistic size at this stage does not warrant a
-- new one (see this file's own header for the full per-RPC index
-- reasoning already given in Parts 3-6 above; not repeated per-column
-- here).
-- ============================================================

create or replace function public.get_finance_summary_counts()
returns table (
  refund_needs_attention_count integer,
  dispute_needs_attention_count integer,
  checkout_exception_count integer,
  refund_entitlement_mismatch_count integer
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('finance.view') then
    raise exception 'not authorized';
  end if;

  return query
    select
      (select count(*)::integer from public.refund_reconciliation_rows() r where r.needs_attention),
      (
        select count(*)::integer
        from public.payment_disputes pd
        where pd.status not in ('won', 'lost', 'warning_closed', 'charge_refunded')
          or (
            pd.status = 'lost'
            and (
              pd.transfer_reversal_status = 'failed'
              or (
                pd.transfer_reversal_status = 'attempting'
                and pd.transfer_reversal_attempted_at <= (now() - interval '10 minutes')
              )
            )
          )
      ),
      (
        select count(*)::integer
        from public.book_checkout_intents bci
        where bci.completed_at is not null and bci.fulfilled_at is null
      ),
      (
        select count(*)::integer
        from (
          select rr.id
          from public.refund_requests rr
          join public.purchases pu on pu.stripe_payment_intent_id = rr.stripe_payment_intent_id
          where rr.status = 'refunded' and rr.bundle_checkout_snapshot_id is null and pu.refunded_at is null
          union all
          select rr.id
          from public.refund_requests rr
          join public.bundle_checkout_snapshots bcs on bcs.id = rr.bundle_checkout_snapshot_id
          where rr.status = 'refunded' and rr.bundle_checkout_snapshot_id is not null and bcs.refunded_at is null
          union all
          select rr.id
          from public.purchases pu
          join public.refund_requests rr on rr.stripe_payment_intent_id = pu.stripe_payment_intent_id
          where pu.refunded_at is not null and rr.status <> 'refunded'
        ) mismatches
      );
end;
$$;

revoke all on function public.get_finance_summary_counts() from public;
revoke all on function public.get_finance_summary_counts() from anon;
revoke all on function public.get_finance_summary_counts() from authenticated;
grant execute on function public.get_finance_summary_counts() to authenticated;
