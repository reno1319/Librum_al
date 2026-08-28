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
-- existed.
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
