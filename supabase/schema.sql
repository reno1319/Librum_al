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
  -- LIBRUM 2.0 AUTHOR-1A (migration 045): display_name is the account/
  -- private identity -- signed-in greetings, admin/staff views, the
  -- profile owner's own settings. It is NOT a verified legal name
  -- (Librum has no KYC/legal-name verification) and, once
  -- public_author_name is set, is no longer what readers see attributed
  -- to a book/bundle/series or matched in search -- see
  -- public_author_name below and resolvePublicAuthorName()
  -- (src/lib/author-name.ts).
  bio text,
  avatar_path text,
  -- The reader-facing author name / pen name. Nullable and additive:
  -- null means "no pen name chosen yet," resolved at read time via
  -- coalesce(public_author_name, display_name) (search_books() below,
  -- and resolvePublicAuthorName() in application code) -- never backfilled
  -- for non-authors (a reader has no public attribution surface), and
  -- deliberately not unique -- authors may share a public name; every
  -- public author URL is UUID-keyed (/authors/[id]), never name-keyed.
  public_author_name text
    check (public_author_name is null or char_length(public_author_name) <= 120),
  -- LIBRUM 2.0 AUTHOR-1C (migration 045): makes "every author has a public name" a real,
  -- database-enforced invariant, not merely a convention the app and
  -- migration backfill happen to maintain. handle_new_user() below sets
  -- public_author_name = display_name for every new author at signup,
  -- and migration 045's own backfill did the same for every pre-existing
  -- author -- this constraint is what makes it permanently impossible
  -- for that state to regress, which is what lets search_books() and
  -- every public reader-facing query stop treating display_name as a
  -- fallback source at all (see both further below). Never applies to
  -- readers -- they have no public attribution surface, so their
  -- public_author_name stays null forever, exactly as before.
  constraint public_author_name_required_for_authors
    check (role <> 'author' or public_author_name is not null),
  stripe_account_id text,
  stripe_payouts_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- LIBRUM 2.0 AUTHOR-1D (migration 046): replaces the original "Profiles
-- are viewable by everyone" (using (true)) policy -- a real, confirmed
-- privacy hole (see the AUTHOR-1C audit): with that policy in place, ANY
-- anon or ordinary authenticated client could directly SELECT any column
-- of any row, including a pseudonymous author's private display_name and
-- even stripe_account_id/stripe_payouts_enabled, completely bypassing
-- every application-layer fix AUTHOR-1B made. RLS restricts ROWS, never
-- columns, so there is no way to keep "using (true)" and still hide
-- display_name for someone else's row while showing it for your own --
-- self-only visibility here, combined with the safe public_author_
-- profiles VIEW (migration 045, below -- created a full stage earlier so
-- the new app could already read through it before this lockdown ever
-- ran; see that view's own comment and migration 046's header for the
-- two-stage AUTHOR-1D rollout this schema.sql file's single consolidated
-- pass collapses into one), is what actually closes this. The second
-- permissive policy staff needs is deferred to alongside staff_has_
-- permission()'s own definition further below -- same ordering rule
-- already established for staff_members' own deferred broader policy.
create policy "Users can view their own full profile"
  on public.profiles for select
  using (auth.uid() = id);

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

-- LIBRUM 2.0 AUTHOR-1D (migration 046): anon no longer gets any SELECT
-- grant on the base table at all -- it never legitimately reads a row of
-- its own (it has no auth.uid()), so the only thing a table-level SELECT
-- grant to anon ever did was let it read display_name/stripe_account_id/
-- stripe_payouts_enabled etc. for EVERY OTHER user's row too, since RLS
-- restricts which ROWS are visible, never which COLUMNS -- exactly the
-- hole the AUTHOR-1C audit found. authenticated keeps SELECT (its own
-- row, or another row where the staff policy below applies -- see the
-- two profiles SELECT policies above/below); for any other row it now
-- gets zero rows back, not merely fewer columns. Public reader-facing
-- access to safe columns for ANY author -- the actual replacement for
-- what the old "viewable by everyone" policy provided -- is the
-- public_author_profiles view immediately below (migration 045 --
-- already live a full rollout stage before this lockdown runs, per
-- AUTHOR-1D), which is unaffected by either of these grants (a view runs
-- with its owner's privileges, not the querying role's, unless created
-- with security_invoker -- not used here, deliberately).
grant select
  on public.profiles
  to authenticated;

-- LIBRUM 2.0 AUTHOR-1A (migration 045): public_author_name added to this
-- grant, alongside the three columns it has always covered -- confirmed
-- by tracing every authenticated-client write against profiles
-- (src/app/dashboard/profile/actions.ts's updateProfile()), which is
-- also the only place that ever writes this new column.
grant update (display_name, bio, avatar_path, public_author_name)
  on public.profiles
  to authenticated;

-- LIBRUM 2.0 AUTHOR-1C (migration 045): the safe, reader-facing replacement for direct
-- public access to profiles -- exposes ONLY the columns a reader ever
-- legitimately needs for author attribution (never display_name, never
-- role, never any Stripe/internal column). Deliberately a plain view,
-- not `security_invoker` -- Postgres runs a non-security-invoker view
-- with the privileges of the view's OWNER (this migration-applying
-- role, the same owner as public.profiles itself), which is NOT subject
-- to profiles' own RLS (RLS never applies to a table's owner unless
-- FORCE ROW LEVEL SECURITY is set, which it isn't here) -- so this view
-- can see every author's row regardless of the caller's own identity,
-- while still only ever returning these four columns. Verified directly
-- against a real local Postgres instance (not merely reasoned about):
-- anon and an ordinary authenticated reader can both read another
-- author's public_author_name/bio/avatar_path through this view, while
-- neither can read one byte of that same author's display_name through
-- either this view (the column isn't in it) or the base table (RLS+grant
-- above now block it).
--
-- Filtered to role = 'author' -- mirrors public_author_name's own
-- "never populated for a reader" invariant (see the column's own
-- comment and the CHECK constraint above): a reader's row simply isn't
-- in this view at all, which is exactly the right behavior everywhere
-- this view is embedded, including reviews' reviewer-identity join
-- (src/app/(public)/books/[id]/page.tsx) -- a plain reader-reviewer
-- resolves to no public name (never their private display_name), and a
-- reviewer who is ALSO an author with a pen name resolves to that pen
-- name, through the exact same mechanism as any other author
-- attribution on the site.
create view public.public_author_profiles as
  select id, public_author_name, bio, avatar_path
  from public.profiles
  where role = 'author';

grant select
  on public.public_author_profiles
  to anon, authenticated;

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
-- LIBRUM 2.0 AUTHOR-1C (migration 045): a new author now gets public_author_name
-- initialized to their own submitted display_name at signup, the same
-- value migration 045's own backfill gave every pre-existing author --
-- required by profiles' own public_author_name_required_for_authors
-- CHECK constraint above, and what makes it safe for search_books() and
-- every public reader-facing query to read ONLY public_author_name (via
-- the public_author_profiles view) and never fall back to the private
-- display_name at all. A reader gets null, exactly as before -- they
-- have no public attribution surface.
create or replace function public.handle_new_user()
returns trigger as $$
declare
  v_role text;
  v_display_name text;
begin
  v_role := case
    when new.raw_user_meta_data->>'role' = 'author' then 'author'
    else 'reader'
  end;
  v_display_name := coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1));

  insert into public.profiles (id, role, display_name, public_author_name)
  values (
    new.id,
    v_role,
    v_display_name,
    case when v_role = 'author' then v_display_name else null end
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
        -- LIBRUM 2.0 AUTHOR-1C (migration 045): reads public_author_profiles (the safe
        -- view), never public.profiles directly. This function is
        -- SECURITY INVOKER (deliberately -- see this function's own
        -- long-standing posture, unchanged), meaning it runs with the
        -- CALLING role's own privileges -- anon or an ordinary
        -- authenticated reader included. Since AUTHOR-1C now restricts
        -- direct SELECT on public.profiles to a caller's own row (or an
        -- authorized staff permission), a public search call from anon/
        -- an ordinary reader would get "permission denied for table
        -- profiles" (confirmed directly against a real local Postgres
        -- instance while building this fix) if this EXISTS clause still
        -- queried the base table -- the view is what makes this
        -- function work at all post-AUTHOR-1C, not merely what keeps it
        -- private. public_author_profiles is already scoped to
        -- role = 'author' and already only ever contains a non-null
        -- public_author_name (see that view's own comment and the
        -- profiles table's public_author_name_required_for_authors
        -- CHECK) -- so this matches ONLY the public pen name, with no
        -- coalesce and no possible path to a private display_name.
        select 1
        from public.public_author_profiles p
        where p.id = books.author_id
          and extensions.unaccent(p.public_author_name)
            ilike extensions.unaccent('%' || search_term || '%')
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
  created_at timestamptz not null default now(),
  -- STRIPE-CUTOVER-1C (migration 056): same immutable checkout-facts
  -- contract as book_checkout_intents above -- frozen at ORIGINAL
  -- insert by create_bundle_checkout_snapshot(), never patched
  -- afterward, enforced by the selective trigger below.
  regime text not null default 'legacy_stripe_connect_v1'
    check (regime in ('legacy_stripe_connect_v1', 'librum_ledger_v1')),
  currency text not null default 'USD'
    check (currency ~ '^[A-Z]{3}$'),
  royalty_rate_bps integer
    check (royalty_rate_bps is null or (royalty_rate_bps >= 0 and royalty_rate_bps <= 10000)),
  check (regime <> 'librum_ledger_v1' or currency = 'ALL'),
  check (regime <> 'librum_ledger_v1' or royalty_rate_bps is not null)
);

alter table public.bundle_checkout_snapshots enable row level security;

-- STRIPE-CUTOVER-1C (migration 056): selective immutability trigger,
-- same pattern as book_checkout_intents' own above -- protects only
-- regime/currency/royalty_rate_bps; fulfilled_at/total_amount_cents/
-- refunded_at remain freely updatable.
create or replace function public.enforce_bundle_checkout_snapshots_financial_facts_immutability()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.regime is distinct from old.regime
    or new.currency is distinct from old.currency
    or new.royalty_rate_bps is distinct from old.royalty_rate_bps
  then
    raise exception
      'bundle_checkout_snapshots: regime/currency/royalty_rate_bps are immutable once set (snapshot %)',
      old.id;
  end if;
  return new;
end;
$$;

create trigger bundle_checkout_snapshots_enforce_financial_facts_immutability
  before update on public.bundle_checkout_snapshots
  for each row
  execute function public.enforce_bundle_checkout_snapshots_financial_facts_immutability();

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
-- STRIPE-CUTOVER-1C (migration 056): three new trailing, defaulted
-- parameters (p_regime/p_currency/p_royalty_rate_bps) so ledger_v1
-- checkout facts are written on this ORIGINAL insert, never patched
-- afterward. The existing 1-argument call site (buyBundle) continues to
-- work completely unchanged, taking the defaults --
-- regime='legacy_stripe_connect_v1', currency='USD',
-- royalty_rate_bps=NULL, exactly as before this migration.
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

-- EXECUTE is revoked from everyone first, then granted only to
-- authenticated -- an anonymous visitor has no auth.uid() to snapshot a
-- checkout for, so there is no reason to grant it access at all. A
-- PL/pgSQL function body that raises an exception rolls back everything
-- it already did in this call (the header insert, any reservations, the
-- reader hold) as a single atomic unit -- there is no partial-snapshot
-- state possible from a failed call.
revoke all on function public.create_bundle_checkout_snapshot(uuid, text, text, integer) from public;
revoke all on function public.create_bundle_checkout_snapshot(uuid, text, text, integer) from anon;
revoke all on function public.create_bundle_checkout_snapshot(uuid, text, text, integer) from authenticated;
grant execute on function public.create_bundle_checkout_snapshot(uuid, text, text, integer) to authenticated;

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
  --
  -- STRIPE-CUTOVER-1C (migration 056): relaxed from `not null` -- a
  -- provider-neutral librum_ledger_v1 purchase, created by the shared
  -- entitlement core, has no Stripe checkout session concept at all.
  -- Zero effect on the legacy path: every legacy call site still
  -- always supplies a real, non-null session id.
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  amount_cents integer not null,
  discount_code_id uuid references public.discount_codes(id) on delete set null,
  bundle_id uuid references public.bundles(id) on delete set null,
  refunded_at timestamptz,
  created_at timestamptz not null default now(),
  -- STRIPE-CUTOVER-1C (migration 056): current-entitlement/informational
  -- only -- NOT immutable historical payment authority (see
  -- payments.regime, and author_ledger_entries/payment_refunds' own
  -- composite (payment_id, purchase_id) keying, for that). Reflects the
  -- most recent transaction that established or re-established this
  -- entitlement row; refund/dispute routing must never rely on it to
  -- identify a specific old financial transaction. Deliberately carries
  -- no immutability trigger -- legitimately changes value on a genuine
  -- refunded/disputed-lost repurchase, exactly like stripe_checkout_
  -- session_id/stripe_payment_intent_id/amount_cents already do.
  regime text not null default 'legacy_stripe_connect_v1'
    check (regime in ('legacy_stripe_connect_v1', 'librum_ledger_v1')),
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

-- LIBRUM 2.0 AUTHOR-1D (migration 046): the second permissive SELECT
-- policy profiles needs, deferred here for the exact same reason as
-- staff_members' own policy immediately above -- it references
-- staff_has_permission(), which doesn't exist yet back at profiles' own
-- table definition.
-- Preserves every existing admin/moderation surface that reads another
-- user's account identity via the ordinary request-scoped client (never
-- the service-role/admin client) -- traced directly against every such
-- call site in the app: reports/[id]/page.tsx (reports.view), staff/
-- page.tsx (staff.view), refunds/page.tsx and refunds/[id]/page.tsx
-- (refunds.view), and the audit log's actor names (audit.view).
-- admin-shell.tsx and admin/(protected)/page.tsx's own greetings read
-- the SIGNED-IN staff member's own row (already covered by "Users can
-- view their own full profile" above) and need no entry here. A staff
-- role with none of these permissions (e.g. 'editor', which
-- staff_has_permission() grants nothing to today) gets exactly the same
-- zero-rows-for-another-user result as any ordinary reader.
create policy "Staff with an authorized permission can view any profile"
  on public.profiles
  for select
  using (
    public.staff_has_permission('reports.view')
    or public.staff_has_permission('staff.view')
    or public.staff_has_permission('refunds.view')
    or public.staff_has_permission('audit.view')
  );

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
  -- STRIPE-CUTOVER-1C (migration 056): immutable checkout financial
  -- facts, frozen at ORIGINAL insert by create_book_checkout_intent()
  -- and never patched afterward -- enforced by the selective trigger
  -- below. Existing/compatibility-phase legacy rows default to
  -- legacy_stripe_connect_v1/USD/NULL; ledger_v1 rows must supply
  -- currency='ALL' (no FX) and a real royalty_rate_bps.
  regime text not null default 'legacy_stripe_connect_v1'
    check (regime in ('legacy_stripe_connect_v1', 'librum_ledger_v1')),
  currency text not null default 'USD'
    check (currency ~ '^[A-Z]{3}$'),
  royalty_rate_bps integer
    check (royalty_rate_bps is null or (royalty_rate_bps >= 0 and royalty_rate_bps <= 10000)),

  check (expires_at > created_at),
  check (fulfilled_at is null or completed_at is not null),
  check ((reconciliation_reason is not null) = (completed_at is not null and fulfilled_at is null)),
  check (reconciliation_reason is null or reconciliation_reason in ('active_other_session', 'book_or_reader_deleted', 'disputed_lost')),
  check (regime <> 'librum_ledger_v1' or currency = 'ALL'),
  check (regime <> 'librum_ledger_v1' or royalty_rate_bps is not null)
);

alter table public.book_checkout_intents enable row level security;

revoke all on public.book_checkout_intents from public, anon, authenticated;

create index book_checkout_intents_reader_book_open_idx
  on public.book_checkout_intents (reader_id, book_id, created_at desc)
  where fulfilled_at is null;

create index book_checkout_intents_needs_reconciliation_idx
  on public.book_checkout_intents (completed_at)
  where fulfilled_at is null and completed_at is not null;

-- STRIPE-CUTOVER-1C (migration 056): selective immutability trigger,
-- modeled on migration 051's enforce_author_payouts_immutability() --
-- protects only regime/currency/royalty_rate_bps; completed_at/
-- fulfilled_at/reconciliation_reason remain freely updatable.
create or replace function public.enforce_book_checkout_intents_financial_facts_immutability()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.regime is distinct from old.regime
    or new.currency is distinct from old.currency
    or new.royalty_rate_bps is distinct from old.royalty_rate_bps
  then
    raise exception
      'book_checkout_intents: regime/currency/royalty_rate_bps are immutable once set (intent %)',
      old.id;
  end if;
  return new;
end;
$$;

create trigger book_checkout_intents_enforce_financial_facts_immutability
  before update on public.book_checkout_intents
  for each row
  execute function public.enforce_book_checkout_intents_financial_facts_immutability();

-- STRIPE-CUTOVER-1C (migration 056): three new trailing, defaulted
-- parameters, same reasoning and pattern as create_bundle_checkout_
-- snapshot() above -- the existing 2-argument call site (buyBook)
-- continues to work completely unchanged, taking the defaults.
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

-- STRIPE-CUTOVER-1C (migration 056): the entitlement-creation logic
-- below (lock intent, classify already-finalized/disputed/deleted/
-- active-other-session, upsert purchases) is identical for both regimes
-- -- only the SECURITY BOUNDARY differs. Extracted into a shared,
-- INTERNAL core (revoked from every application role, including
-- service_role -- only callable by finalize_book_checkout_intent()
-- below and finalize_ledger_book_payment() further down this file, both
-- owned by the same role, which always retains implicit EXECUTE on its
-- own functions regardless of that revoke). Two corrections versus the
-- pre-056 body: (1) `regime` is now selected off the locked intent row
-- and written into the purchases insert/upsert; (2) the
-- "active_other_session" check's `stripe_checkout_session_id is not
-- null` clause is replaced with an explicit `v_existing.id is not
-- null` -- that column is now nullable for provider-neutral
-- librum_ledger_v1 purchases (see purchases.stripe_checkout_session_id
-- above), so the old clause would have silently misclassified an
-- active ledger_v1 purchase as "no active row exists."
create or replace function public.finalize_book_checkout_intent_entitlement_core(
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
  select id, book_id, reader_id, discount_code_id, price_cents_at_checkout, regime,
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

  -- p.id is selected specifically to detect "does an existing purchases
  -- row exist at all" -- id is the primary key, always non-null for a
  -- real row, unlike stripe_checkout_session_id (now nullable) or
  -- stripe_payment_intent_id (always nullable). When no row matches,
  -- v_existing.id is null and every other field is null too.
  select p.id, p.stripe_payment_intent_id, p.refunded_at
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
  if v_existing.id is not null
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
    amount_cents, discount_code_id, refunded_at, regime
  ) values (
    v_intent.book_id, v_intent.reader_id, p_stripe_checkout_session_id, p_stripe_payment_intent_id,
    v_intent.price_cents_at_checkout, v_intent.discount_code_id, null, v_intent.regime
  )
  on conflict (book_id, reader_id) do update set
    stripe_checkout_session_id = excluded.stripe_checkout_session_id,
    stripe_payment_intent_id = excluded.stripe_payment_intent_id,
    amount_cents = excluded.amount_cents,
    discount_code_id = excluded.discount_code_id,
    refunded_at = null,
    regime = excluded.regime;

  update public.book_checkout_intents
  set stripe_payment_intent_id = p_stripe_payment_intent_id,
      completed_at = now(),
      fulfilled_at = now()
  where id = p_intent_id;

  return query select 'eligible_fulfilled'::text, v_intent.book_id, v_intent.reader_id;
end;
$$;

revoke all on function public.finalize_book_checkout_intent_entitlement_core(uuid, text, text, integer)
  from public, anon, authenticated, service_role;

-- finalize_book_checkout_intent() remains the legacy-compatible public/
-- service_role RPC -- signature and RETURNS TABLE shape unchanged, so
-- the live Stripe webhook keeps calling this exact RPC unaware anything
-- changed. Explicitly requires regime = legacy_stripe_connect_v1 before
-- delegating to the shared core -- a librum_ledger_v1 intent can only
-- be finalized through finalize_ledger_book_payment() further down this
-- file, which additionally enforces payment-event binding and the hard
-- actual-vs-expected amount/currency match.
create or replace function public.finalize_book_checkout_intent(
  p_intent_id uuid,
  p_stripe_checkout_session_id text,
  p_stripe_payment_intent_id text,
  p_amount_cents integer
)
returns table (
  outcome text,
  out_book_id uuid,
  out_reader_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_regime text;
begin
  select regime into v_regime from public.book_checkout_intents where id = p_intent_id;

  if v_regime is null then
    raise exception 'checkout intent not found';
  end if;

  if v_regime <> 'legacy_stripe_connect_v1' then
    raise exception
      'finalize_book_checkout_intent: intent % is not a legacy_stripe_connect_v1 checkout (regime %) -- ledger_v1 checkouts must be finalized via finalize_ledger_book_payment',
      p_intent_id, v_regime;
  end if;

  return query
  select *
  from public.finalize_book_checkout_intent_entitlement_core(
    p_intent_id, p_stripe_checkout_session_id, p_stripe_payment_intent_id, p_amount_cents
  );
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

-- ============================================================
-- LIBRUM 2.0 BLOG-1B (migration 047): schema + RBAC + storage
-- foundation for the native editorial Blog feature (BLOG-1).
-- FOUNDATION ONLY -- no public /blog, no admin CMS pages, no Markdown
-- rendering, no sitemap integration. Those are later BLOG phases; this
-- migration only has to be safe to sit underneath them, unused, exactly
-- as migration 039 (book_reports) sat underneath MOD-1's own later
-- admin UI.
--
-- SECURITY MODEL (BLOG-1A.1's approved correction to BLOG-1A's original
-- draft, verified against this repo's own precedent before writing a
-- single statement here): RLS restricts ROWS, never COLUMNS -- a
-- `blog.manage`-gated USING/WITH CHECK policy on a direct table UPDATE
-- would let any genuinely authorized blog.manage staffer set status/
-- published_at/created_by/slug to anything at all in the same call,
-- with no audit trail, because those are legitimate rows for that
-- policy to allow, just with illegitimate column values inside them --
-- the same class of hole AUTHOR-1C found in profiles (migration 046's
-- own header). The fix, and this repo's own actual convention for every
-- comparably sensitive table (book_reports, refund_requests,
-- staff_members, purchases, payment_disputes, admin_audit_log,
-- book_checkout_intents -- all `revoke all ... grant select only`,
-- every mutation through a SECURITY DEFINER RPC): blog_posts gets ZERO
-- table-level INSERT/UPDATE/DELETE grant to anon or authenticated, at
-- all, ever, and therefore has no INSERT/UPDATE/DELETE RLS policy
-- either -- with no grant for those commands, a policy for them would
-- never be evaluated. Every write, including ordinary field edits, goes
-- through one of the five RPCs below.
-- ============================================================

create table public.blog_posts (
  id                uuid primary key default gen_random_uuid(),
  title             text not null check (char_length(title) <= 200),
  slug              text not null unique check (char_length(slug) <= 200),
  excerpt           text not null check (char_length(excerpt) <= 500),
  content_markdown  text not null check (char_length(content_markdown) <= 50000),
  cover_image_path  text,
  category          text not null check (category in ('publishing', 'writing', 'authors-books', 'librum-guides')),
  status            text not null default 'draft' check (status in ('draft', 'published')),
  featured          boolean not null default false,
  seo_title         text check (seo_title is null or char_length(seo_title) <= 70),
  seo_description   text check (seo_description is null or char_length(seo_description) <= 160),
  -- system-authoritative -- set exactly once, by publish_blog_post()
  -- below, on a genuine draft -> published transition, never accepted
  -- from client-submitted data, never reset by a later unpublish/
  -- republish cycle (see publish_blog_post()'s own comment). Mirrors
  -- books.published_at's exact semantics (migration 044).
  published_at      timestamptz,
  -- server/auth-derived only -- never a parameter to create_blog_post(),
  -- so there is no path by which a client can supply this at all, let
  -- alone spoof another staff member's id (see create_blog_post()'s
  -- own comment).
  created_by        uuid not null references public.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Serves both the public /blog listing (status='published', filtered by
-- category, newest first) and the featured/latest queries a later BLOG
-- phase will add -- a single partial index on exactly the predicate
-- every public-facing query shares, mirroring books_status_idx's own
-- shape.
create index blog_posts_public_listing_idx
  on public.blog_posts (status, category, published_at desc)
  where status = 'published';

alter table public.blog_posts enable row level security;

revoke all on public.blog_posts from anon, authenticated;

grant select on public.blog_posts to anon, authenticated;

create policy "Anyone can read published blog posts"
  on public.blog_posts for select
  using (status = 'published');

create policy "Staff with blog.view can read any blog post"
  on public.blog_posts for select
  using (public.staff_has_permission('blog.view'));

-- create_blog_post: the only path by which a blog_posts row can ever be
-- created (authenticated has no table-level INSERT grant at all).
-- created_by is deliberately not a parameter -- derived exclusively
-- from auth.uid() inside this function body. status is hardcoded
-- 'draft'; published_at is left null. Ordinary creation is not
-- audit-logged, matching this codebase's existing convention that only
-- moderation/state-transition actions are.
create or replace function public.create_blog_post(
  p_title text,
  p_slug text,
  p_excerpt text,
  p_content_markdown text,
  p_cover_image_path text,
  p_category text,
  p_featured boolean,
  p_seo_title text,
  p_seo_description text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_new_id uuid;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('blog.manage') then
    raise exception 'not authorized';
  end if;

  if p_category not in ('publishing', 'writing', 'authors-books', 'librum-guides') then
    raise exception 'invalid category';
  end if;

  if p_title is null or pg_catalog.char_length(p_title) = 0 or pg_catalog.char_length(p_title) > 200 then
    raise exception 'title must be between 1 and 200 characters';
  end if;
  if p_slug is null or pg_catalog.char_length(p_slug) = 0 or pg_catalog.char_length(p_slug) > 200 then
    raise exception 'slug must be between 1 and 200 characters';
  end if;
  if p_excerpt is null or pg_catalog.char_length(p_excerpt) = 0 or pg_catalog.char_length(p_excerpt) > 500 then
    raise exception 'excerpt must be between 1 and 500 characters';
  end if;
  if p_content_markdown is null or pg_catalog.char_length(p_content_markdown) = 0
     or pg_catalog.char_length(p_content_markdown) > 50000 then
    raise exception 'content_markdown must be between 1 and 50000 characters';
  end if;
  if p_seo_title is not null and pg_catalog.char_length(p_seo_title) > 70 then
    raise exception 'seo_title must be 70 characters or fewer';
  end if;
  if p_seo_description is not null and pg_catalog.char_length(p_seo_description) > 160 then
    raise exception 'seo_description must be 160 characters or fewer';
  end if;

  insert into public.blog_posts
    (title, slug, excerpt, content_markdown, cover_image_path, category, featured,
     seo_title, seo_description, status, created_by)
  values
    (p_title, p_slug, p_excerpt, p_content_markdown, p_cover_image_path, p_category, coalesce(p_featured, false),
     nullif(trim(coalesce(p_seo_title, '')), ''), nullif(trim(coalesce(p_seo_description, '')), ''),
     'draft', v_actor_id)
  returning id into v_new_id;

  return v_new_id;
end;
$$;

revoke all on function public.create_blog_post(text, text, text, text, text, text, boolean, text, text)
  from public, anon, authenticated;
grant execute on function public.create_blog_post(text, text, text, text, text, text, boolean, text, text)
  to authenticated;

-- update_blog_post: the only path by which any editable field can
-- change (authenticated has no table-level UPDATE grant at all).
-- status/published_at/created_by/created_at are not parameters at all.
-- slug is the one field whose legality depends on the row's CURRENT
-- state (read fresh from the table, never trusted from the caller):
-- editable while status='draft', rejected once status='published'.
create or replace function public.update_blog_post(
  p_id uuid,
  p_title text,
  p_slug text,
  p_excerpt text,
  p_content_markdown text,
  p_cover_image_path text,
  p_category text,
  p_featured boolean,
  p_seo_title text,
  p_seo_description text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_current_slug text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('blog.manage') then
    raise exception 'not authorized';
  end if;

  select status, slug into v_status, v_current_slug
  from public.blog_posts
  where id = p_id;

  if v_status is null then
    raise exception 'no such blog post';
  end if;

  if v_status = 'published' and p_slug is distinct from v_current_slug then
    raise exception 'slug is immutable once a post is published';
  end if;

  if p_category not in ('publishing', 'writing', 'authors-books', 'librum-guides') then
    raise exception 'invalid category';
  end if;

  if p_title is null or pg_catalog.char_length(p_title) = 0 or pg_catalog.char_length(p_title) > 200 then
    raise exception 'title must be between 1 and 200 characters';
  end if;
  if p_slug is null or pg_catalog.char_length(p_slug) = 0 or pg_catalog.char_length(p_slug) > 200 then
    raise exception 'slug must be between 1 and 200 characters';
  end if;
  if p_excerpt is null or pg_catalog.char_length(p_excerpt) = 0 or pg_catalog.char_length(p_excerpt) > 500 then
    raise exception 'excerpt must be between 1 and 500 characters';
  end if;
  if p_content_markdown is null or pg_catalog.char_length(p_content_markdown) = 0
     or pg_catalog.char_length(p_content_markdown) > 50000 then
    raise exception 'content_markdown must be between 1 and 50000 characters';
  end if;
  if p_seo_title is not null and pg_catalog.char_length(p_seo_title) > 70 then
    raise exception 'seo_title must be 70 characters or fewer';
  end if;
  if p_seo_description is not null and pg_catalog.char_length(p_seo_description) > 160 then
    raise exception 'seo_description must be 160 characters or fewer';
  end if;

  update public.blog_posts
  set title = p_title,
      slug = p_slug,
      excerpt = p_excerpt,
      content_markdown = p_content_markdown,
      cover_image_path = p_cover_image_path,
      category = p_category,
      featured = coalesce(p_featured, false),
      seo_title = nullif(trim(coalesce(p_seo_title, '')), ''),
      seo_description = nullif(trim(coalesce(p_seo_description, '')), ''),
      updated_at = pg_catalog.now()
  where id = p_id;
end;
$$;

revoke all on function public.update_blog_post(uuid, text, text, text, text, text, text, boolean, text, text)
  from public, anon, authenticated;
grant execute on function public.update_blog_post(uuid, text, text, text, text, text, text, boolean, text, text)
  to authenticated;

-- publish_blog_post: draft -> published only. published_at uses
-- coalesce(published_at, now()) so a true first publish sets it while a
-- later republish (after an unpublish) never resets it. Raises (does
-- not silently no-op) when the row is already published or doesn't
-- exist, matching review_book_report()'s own convention.
create or replace function public.publish_blog_post(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_updated_id uuid;
  v_slug text;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('blog.manage') then
    raise exception 'not authorized';
  end if;

  update public.blog_posts
  set status = 'published',
      published_at = coalesce(published_at, pg_catalog.now()),
      updated_at = pg_catalog.now()
  where id = p_id and status = 'draft'
  returning id, slug into v_updated_id, v_slug;

  if v_updated_id is null then
    raise exception 'no publishable draft found for this id';
  end if;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'blog_post.published', 'blog_posts', p_id, jsonb_build_object('slug', v_slug));
end;
$$;

revoke all on function public.publish_blog_post(uuid) from public, anon, authenticated;
grant execute on function public.publish_blog_post(uuid) to authenticated;

-- unpublish_blog_post: published -> draft only. published_at is
-- deliberately never included in the SET list at all.
create or replace function public.unpublish_blog_post(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_updated_id uuid;
  v_slug text;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('blog.manage') then
    raise exception 'not authorized';
  end if;

  update public.blog_posts
  set status = 'draft',
      updated_at = pg_catalog.now()
  where id = p_id and status = 'published'
  returning id, slug into v_updated_id, v_slug;

  if v_updated_id is null then
    raise exception 'no published post found for this id';
  end if;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'blog_post.unpublished', 'blog_posts', p_id, jsonb_build_object('slug', v_slug));
end;
$$;

revoke all on function public.unpublish_blog_post(uuid) from public, anon, authenticated;
grant execute on function public.unpublish_blog_post(uuid) to authenticated;

-- delete_blog_post: draft rows only -- the WHERE clause is the entire
-- enforcement of "a published post can never be deleted." Returns the
-- deleted row's cover_image_path (nullable) so a future Server Action
-- can remove the permanent public cover from storage AFTER this DELETE
-- has already committed, without a second, potentially-stale SELECT
-- against a row that no longer exists.
create or replace function public.delete_blog_post(p_id uuid)
returns table (deleted_cover_image_path text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_deleted_id uuid;
  v_slug text;
  v_cover_image_path text;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('blog.manage') then
    raise exception 'not authorized';
  end if;

  delete from public.blog_posts
  where id = p_id and status = 'draft'
  returning id, slug, cover_image_path into v_deleted_id, v_slug, v_cover_image_path;

  if v_deleted_id is null then
    raise exception 'only a draft post can be deleted, or it does not exist';
  end if;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'blog_post.deleted', 'blog_posts', p_id, jsonb_build_object('slug', v_slug));

  return query select v_cover_image_path;
end;
$$;

revoke all on function public.delete_blog_post(uuid) from public, anon, authenticated;
grant execute on function public.delete_blog_post(uuid) to authenticated;

-- Storage: staging reuses the existing PRIVATE manuscripts bucket and
-- its existing owner-path policies -- those policies check only
-- `auth.uid()::text = (storage.foldername(name))[1]`, with no role/
-- permission condition at all, so <staff-uid>/tmp/blog/<uuid>.<ext> is
-- already a legal path under them; no new staging policy is added here.
-- The permanent bucket IS new -- public read, writes gated by
-- blog.manage rather than an owner-path check, since blog covers are
-- staff-managed institutional content, not owned by an individual.
insert into storage.buckets (id, name, public)
values ('blog', 'blog', true)
on conflict (id) do nothing;

create policy "Blog images are publicly readable"
  on storage.objects for select
  using (bucket_id = 'blog');

create policy "Staff with blog.manage can upload blog images"
  on storage.objects for insert
  with check (bucket_id = 'blog' and public.staff_has_permission('blog.manage'));

create policy "Staff with blog.manage can replace blog images"
  on storage.objects for update
  using (bucket_id = 'blog' and public.staff_has_permission('blog.manage'));

create policy "Staff with blog.manage can delete blog images"
  on storage.objects for delete
  using (bucket_id = 'blog' and public.staff_has_permission('blog.manage'));

-- Permission matrix: blog.view/blog.manage granted to owner, admin, and
-- editor; editor also gains admin.access (the structural prerequisite
-- to enter /admin/(protected) at all). moderator/support are unchanged.
-- The full CASE expression is restated here (not just the new arms)
-- because CREATE OR REPLACE replaces the whole function body, never
-- merges with a previous definition.
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
            'finance.view', 'blog.view', 'blog.manage'
          )
        )
        or (
          sm.role = 'editor'
          and p_permission in ('admin.access', 'blog.view', 'blog.manage')
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

-- BLOG-1B.1 (found by real Postgres execution): blog_posts is the first
-- table where anon holds a genuine table-level SELECT grant AND an RLS
-- policy ORs in a staff_has_permission() call -- for the draft row, the
-- first disjunct (status='published') is false, so Postgres must
-- evaluate the second for anon too, which previously raised "permission
-- denied for function" outright rather than returning false, breaking
-- anon's read of the published row as well. The fix is a widened
-- EXECUTE grant, not a change to this function's logic or to any RLS
-- policy: with auth.uid() always null for anon, this remains
-- deterministically false for every permission regardless of what
-- staff_members contains -- granting anon EXECUTE reveals nothing.
-- staff_members/book_reports/refund_requests still grant anon no
-- table-level SELECT at all, so this is simply never reachable from
-- their own RLS evaluation.
revoke all on function public.staff_has_permission(text) from public, anon, authenticated;
grant execute on function public.staff_has_permission(text) to anon, authenticated;

-- Audit filter allow-lists: list_admin_audit_events() validates its
-- optional p_action/p_target_type filters against a closed vocabulary
-- (migration 042). Only the FILTER is gated this way -- the unfiltered
-- default view already shows every admin_audit_log row regardless of
-- this list. Full function body restated (same CREATE OR REPLACE
-- reasoning as staff_has_permission() above).
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
    'refund.issuance_submitted',
    'blog_post.published', 'blog_post.unpublished', 'blog_post.deleted'
  ) then
    raise exception 'invalid action filter';
  end if;

  if p_target_type is not null and p_target_type not in (
    'staff_members', 'book_reports', 'refund_requests', 'blog_posts'
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
) from public, anon, authenticated;
grant execute on function public.list_admin_audit_events(
  text, uuid, text, timestamptz, timestamptz, timestamptz, uuid, integer
) to authenticated;

-- ============================================================
-- LIBRUM 2.0 LEDGER-1B (migration 048): provider-neutral financial
-- ledger foundation -- SCHEMA AND INVARIANTS ONLY. Five new tables
-- (payments, payment_events, author_payouts, author_payout_settings,
-- author_ledger_entries); nothing existing is altered, and nothing here
-- writes a single row -- every existing purchases/refund_requests/
-- payment_disputes row is a synthetic pre-launch test transaction, so
-- there is deliberately no backfill of historical ledger entries,
-- payments, or payouts. The new ledger starts at financial zero; real
-- sale/refund recording is wired in by a later LEDGER-1C phase.
--
-- amount_minor columns are integer minor units (bigint, never a float,
-- never "_cents") and currency is bounded uppercase ISO-4217-shaped text
-- (`currency ~ '^[A-Z]{3}$'`), never summed across currencies, no FX
-- conversion. author_ledger_entries is append-only by the same
-- trigger-free, two-layer pattern this schema already uses for
-- admin_audit_log/payment_disputes/book_checkout_intents: every ambient
-- anon/authenticated grant is revoked and only SELECT is handed back,
-- and zero INSERT/UPDATE/DELETE policies exist for any role. Amounts are
-- signed per entry_type (sale > 0, refund/payout < 0, adjustment either
-- sign but never 0), a 'sale' entry must reference a purchase, and a
-- sale's gross/librum/author snapshot amounts must reconcile exactly
-- when populated. Idempotency is enforced with partial unique indexes:
-- one 'sale' entry per purchase_id, one 'payout' entry per payout_id,
-- and one entry per (author_id, entry_type, reference_type,
-- reference_id) whenever both reference columns are populated.
--
-- author_id on author_ledger_entries/author_payouts references
-- profiles(id) ON DELETE RESTRICT -- real financial history must never
-- silently disappear when an account is deleted, the same reasoning
-- purchases.book_id's own RESTRICT already applies. author_payout_
-- settings (a preference, not history) uses ON DELETE CASCADE instead,
-- and payments.buyer_id (a buyer-side audit record) uses ON DELETE SET
-- NULL, matching purchases.reader_id's own existing precedent.
--
-- RLS: payments/payment_events are staff-only (finance.view, the same
-- permission migration 043 already introduced) -- no buyer-facing UI
-- reads them yet, so no buyer SELECT policy is added prematurely.
-- author_payouts/author_payout_settings/author_ledger_entries add an
-- author-own SELECT policy in addition to the staff finance.view policy.
-- No admin-adjustment RPC and no sale/refund-recording RPC are added in
-- this migration -- both are explicitly deferred to a later phase.
-- ============================================================

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_payment_id text not null,
  buyer_id uuid references public.profiles(id) on delete set null,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'pending'
    check (status in ('pending', 'succeeded', 'failed', 'cancelled', 'partially_refunded', 'refunded')),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- STRIPE-CUTOVER-1C (migration 056): immutable ledger-side transaction
  -- regime authority. payments rows are written exclusively by
  -- record_successful_sale(), which hardcodes the literal
  -- 'librum_ledger_v1' -- this table has no legacy_stripe_connect_v1
  -- rows and never will, since the legacy checkout path is entirely
  -- unwired from it. Kept NOT NULL with a default for schema self-
  -- documentation and forward compatibility with a hypothetical future
  -- third regime.
  regime text not null default 'librum_ledger_v1'
    check (regime in ('legacy_stripe_connect_v1', 'librum_ledger_v1')),
  unique (provider, provider_payment_id)
);

create index payments_buyer_id_created_at_idx on public.payments (buyer_id, created_at desc);

alter table public.payments enable row level security;

revoke all on public.payments from anon, authenticated;
grant select on public.payments to authenticated;

create policy "Staff with finance.view can view all payments"
  on public.payments for select
  using (public.staff_has_permission('finance.view'));

create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  status text not null default 'received'
    check (status in ('received', 'processed', 'failed', 'ignored')),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  -- STRIPE-CUTOVER-1C (migration 056): required event/payment binding
  -- for ledger_v1 ingestion -- legacy historical rows may remain NULL
  -- forever (no backfill, no default, no NOT NULL).
  provider_payment_id text,
  unique (provider, provider_event_id)
);

alter table public.payment_events enable row level security;

revoke all on public.payment_events from anon, authenticated;
grant select on public.payment_events to authenticated;

create policy "Staff with finance.view can view all payment events"
  on public.payment_events for select
  using (public.staff_has_permission('finance.view'));

-- LEDGER-1E-B (migration 051): provider-neutral payout-run grouping/
-- audit table. Defined here, before author_payouts, purely so
-- author_payouts.payout_run_id can reference it directly in that
-- table's own CREATE TABLE below. NOT the money-safety mechanism --
-- see author_payouts_one_active_per_author_currency_idx further down
-- for that. run_type is deliberately restricted to 'scheduled' only;
-- no manual-payout feature exists yet.
--
-- LEDGER-1E-B.1: run_key is REQUIRED and non-blank for every
-- 'scheduled' row (the CHECK below) -- scheduler-invocation
-- idempotency (the unique index further down) only actually holds if
-- every scheduled run is forced to supply a key that can collide with
-- a duplicate/concurrent firing; an optional key would let a caller
-- silently skip that protection.
create table public.payout_runs (
  id uuid primary key default gen_random_uuid(),
  run_type text not null default 'scheduled' check (run_type in ('scheduled')),
  run_key text,
  scheduled_for date,
  started_at timestamptz,
  completed_at timestamptz,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed')),
  created_at timestamptz not null default now(),

  constraint payout_runs_scheduled_run_key_required check (
    run_type <> 'scheduled'
    or (run_key is not null and btrim(run_key) <> '')
  )
);

create unique index payout_runs_run_type_run_key_idx
  on public.payout_runs (run_type, run_key)
  where run_key is not null;

alter table public.payout_runs enable row level security;
revoke all on public.payout_runs from anon, authenticated;

-- LEDGER-1E-B.1: service_role's DEFAULT-PRIVILEGES-derived direct
-- INSERT/UPDATE/DELETE is revoked here too -- no legitimate direct-DML
-- path exists onto this table in this phase either. SELECT retained.
revoke all on public.payout_runs from service_role;
grant select on public.payout_runs to service_role;

create table public.author_payouts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete restrict,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'paid', 'failed', 'cancelled', 'reconciling')),
  provider text,
  provider_reference text,
  period_start timestamptz,
  period_end timestamptz,
  created_at timestamptz not null default now(),
  processing_at timestamptz,
  paid_at timestamptz,
  failed_at timestamptz,
  failure_code text,
  -- LEDGER-1E-B.1: ON DELETE RESTRICT, not SET NULL -- payout_run_id is
  -- immutable from insert (the trigger below), so it is permanent audit
  -- history; a run with any historical payouts referencing it must
  -- never be deletable, matching the same RESTRICT posture already used
  -- for author_id itself.
  payout_run_id uuid references public.payout_runs(id) on delete restrict,

  check (period_start is null or period_end is null or period_end >= period_start)
);

create index author_payouts_author_currency_created_idx
  on public.author_payouts (author_id, currency, created_at desc);
create index author_payouts_status_created_idx
  on public.author_payouts (status, created_at);
create index author_payouts_payout_run_id_idx
  on public.author_payouts (payout_run_id)
  where payout_run_id is not null;

-- LEDGER-1E-B (migration 051): the money-safety invariant -- at most
-- ONE active reservation (status pending/processing/reconciling) per
-- (author_id, currency). See that migration's own comment for the full
-- reasoning; this single partial unique index is the entire
-- concurrency mechanism reserve_author_payout() relies on.
create unique index author_payouts_one_active_per_author_currency_idx
  on public.author_payouts (author_id, currency)
  where status in ('pending', 'processing', 'reconciling');

-- LEDGER-1E-B: once a provider+provider_reference pair is known, it
-- must correlate to exactly one payout.
create unique index author_payouts_provider_reference_idx
  on public.author_payouts (provider, provider_reference)
  where provider is not null and provider_reference is not null;

alter table public.author_payouts enable row level security;

revoke all on public.author_payouts from anon, authenticated;
grant select on public.author_payouts to authenticated;

-- LEDGER-1E-C (migration 052) dropped the original author-own SELECT
-- policy this table shipped with in migration 048 -- authors now read
-- their own payout data exclusively through get_author_payout_overview()/
-- list_author_payout_history() (both further down this file), which are
-- SECURITY DEFINER and expose no internal correlation identifiers
-- (provider/provider_reference/failure_code/payout_run_id). The
-- table-level grant above is kept only so the remaining staff policy
-- below still has a privilege to narrow.
create policy "Staff with finance.view can view all payouts"
  on public.author_payouts for select
  using (public.staff_has_permission('finance.view'));

-- LEDGER-1E-B.1: service_role's DEFAULT-PRIVILEGES-derived direct
-- INSERT/UPDATE/DELETE is revoked -- the only legal mutation path is
-- EXECUTE on the six payout RPCs below (each SECURITY DEFINER, so it
-- runs as its OWNER regardless of the caller's own table grants).
-- SELECT retained.
revoke all on public.author_payouts from service_role;
grant select on public.author_payouts to service_role;

-- LEDGER-1E-B.1: database-enforced economic-identity immutability, FROM
-- INSERT ONWARD (not merely "once a payout leaves pending"). There is
-- no legitimate resize/reassignment path at ANY lifecycle stage in this
-- architecture -- a stale pending reservation is cancelled and a fresh
-- one created, never mutated in place. status/provider/
-- provider_reference/the lifecycle timestamps remain freely updatable
-- by the legal-transition RPCs further below.
create or replace function public.enforce_author_payouts_immutability()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.amount_minor is distinct from old.amount_minor
    or new.currency is distinct from old.currency
    or new.author_id is distinct from old.author_id
    or new.payout_run_id is distinct from old.payout_run_id
  then
    raise exception
      'author_payouts: amount_minor/currency/author_id/payout_run_id are immutable from the moment a payout is created (payout id %, current status %)',
      old.id, old.status;
  end if;
  return new;
end;
$$;

create trigger author_payouts_enforce_immutability
  before update on public.author_payouts
  for each row
  execute function public.enforce_author_payouts_immutability();

-- LEDGER-1E-B.1: a 'paid' row must always carry a non-blank provider, a
-- non-blank provider_reference, and a non-null paid_at -- structurally
-- impossible otherwise, not merely RPC-discouraged. One-directional
-- only (says nothing about non-paid rows' own provider/timestamp
-- combinations, which legitimately vary).
alter table public.author_payouts
  add constraint author_payouts_paid_requires_provider_and_reference
  check (
    status <> 'paid'
    or (
      provider is not null and btrim(provider) <> ''
      and provider_reference is not null and btrim(provider_reference) <> ''
      and paid_at is not null
    )
  );

create table public.author_payout_settings (
  author_id uuid references public.profiles(id) on delete cascade,
  threshold_minor bigint not null check (threshold_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- LEDGER-1E-B (migration 051): composite PK, not PRIMARY KEY(author_id)
  -- -- an author earning in multiple currencies needs one threshold row
  -- PER currency, not a single one for their whole account.
  primary key (author_id, currency)
);

alter table public.author_payout_settings enable row level security;

revoke all on public.author_payout_settings from anon, authenticated;
grant select on public.author_payout_settings to authenticated;

create policy "Authors can view their own payout settings"
  on public.author_payout_settings for select
  using (auth.uid() = author_id);

create table public.author_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete restrict,
  purchase_id uuid references public.purchases(id) on delete set null,
  -- STRIPE-CUTOVER-1C (migration 056): ON DELETE RESTRICT, not SET
  -- NULL -- a sale row's payment_id must never become NULL (the CHECK
  -- below forbids it), so a payments row that any sale entry still
  -- references can never legitimately be deleted at all. Realigned to
  -- match purchases.payment_id/payment_refunds.payment_id, both already
  -- RESTRICT for the same payments row.
  payment_id uuid references public.payments(id) on delete restrict,
  payout_id uuid references public.author_payouts(id) on delete set null,

  entry_type text not null check (entry_type in ('sale', 'refund', 'adjustment', 'payout')),

  amount_minor bigint not null check (amount_minor <> 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),

  royalty_rate_bps integer check (royalty_rate_bps is null or (royalty_rate_bps >= 0 and royalty_rate_bps <= 10000)),
  gross_amount_minor bigint check (gross_amount_minor is null or gross_amount_minor > 0),
  librum_amount_minor bigint check (librum_amount_minor is null or librum_amount_minor >= 0),

  available_at timestamptz,

  reference_type text,
  reference_id text,

  description text,

  created_at timestamptz not null default now(),

  check (entry_type <> 'sale' or amount_minor > 0),
  check (entry_type <> 'refund' or amount_minor < 0),
  check (entry_type <> 'payout' or amount_minor < 0),

  check (entry_type <> 'sale' or purchase_id is not null),
  check (entry_type <> 'payout' or payout_id is not null),

  check (entry_type <> 'sale' or gross_amount_minor is not null),
  check (entry_type <> 'sale' or gross_amount_minor > 0),
  check (entry_type <> 'sale' or librum_amount_minor is not null),
  check (entry_type <> 'sale' or librum_amount_minor >= 0),
  check (entry_type <> 'sale' or royalty_rate_bps is not null),
  check (entry_type <> 'sale' or available_at is not null),

  check (
    entry_type <> 'sale'
    or gross_amount_minor = amount_minor + librum_amount_minor
  ),

  -- STRIPE-CUTOVER-1C (migration 056): sale rows are now the canonical
  -- immutable payment-item association (composite unique index below) --
  -- a NULL payment_id would be invisible to that index (Postgres treats
  -- NULL as distinct from every other value in a unique index) and
  -- unrecoverable by the immutable-payment-set reconstruction query
  -- inside record_successful_sale()'s own retry branch.
  check (entry_type <> 'sale' or payment_id is not null)
);

-- STRIPE-CUTOVER-1C (migration 056): widened from bare purchase_id to
-- (payment_id, purchase_id) -- purchases is a reusable current-
-- entitlement row (STRIPE-CUTOVER-1B.4), so the same purchase must be
-- able to receive a second, independent sale credit under a genuinely
-- different, later payment. Still enforces exactly-once per
-- (payment,item) pair.
create unique index author_ledger_entries_one_sale_per_payment_purchase_idx
  on public.author_ledger_entries (payment_id, purchase_id)
  where entry_type = 'sale';

create unique index author_ledger_entries_one_entry_per_payout_idx
  on public.author_ledger_entries (payout_id)
  where entry_type = 'payout';

create unique index author_ledger_entries_reference_idempotency_idx
  on public.author_ledger_entries (author_id, entry_type, reference_type, reference_id)
  where reference_type is not null and reference_id is not null;

create index author_ledger_entries_author_currency_created_idx
  on public.author_ledger_entries (author_id, currency, created_at desc);
create index author_ledger_entries_author_currency_available_idx
  on public.author_ledger_entries (author_id, currency, available_at);

alter table public.author_ledger_entries enable row level security;

revoke all on public.author_ledger_entries from anon, authenticated;
grant select on public.author_ledger_entries to authenticated;

-- LEDGER-1D (migration 050) dropped the original author-own SELECT
-- policy this table shipped with in migration 048 -- authors now read
-- their own ledger data exclusively through get_author_financial_
-- summary()/list_author_financial_activity() (both further down this
-- file), which are SECURITY DEFINER and expose no internal correlation
-- identifiers. The table-level grant above is kept only so the
-- remaining staff policy below still has a privilege to narrow.
create policy "Staff with finance.view can view all ledger entries"
  on public.author_ledger_entries for select
  using (public.staff_has_permission('finance.view'));

-- ============================================================
-- LIBRUM 2.0 LEDGER-1C / LEDGER-1C.1 (migration 049): provider-neutral
-- transactional sale/refund accounting primitives, built on migration
-- 048's schema. CRITICAL: Librum's CURRENT checkout still uses Stripe
-- Connect destination charges -- the author's share is transferred
-- directly to the author's own connected account, so Librum's own
-- balance never holds it. NOTHING in this section is called by any
-- existing application code path; no Stripe checkout/webhook/refund/
-- dispute file is touched or wired to any function here. Every function
-- below is SECURITY DEFINER, granted to service_role only.
--
-- LEDGER-1C.1 corrected LEDGER-1C in place (049 was never applied
-- before this correction): record_successful_sale() now freezes the
-- entire canonical purchase set a payment funds (a retry must supply
-- exactly that set, order-independent, never a substitute/subset/
-- superset) and derives payments.buyer_id from the unanimous
-- purchases.reader_id across that set (never a raw caller claim,
-- though an optional p_buyer_id is cross-checked against it when
-- supplied); a new payment_refunds table now records the canonical,
-- provider-neutral fact of buyer money returned (one row per refunded
-- purchase, V1 full-refund-only) with payments.status now derived
-- truthfully from the sum of its own confirmed refunds; author_ledger_
-- entries gains a payment_refund_id correlation column (this migration,
-- not 048) with its own idempotency-enforcing partial unique index; and
-- record_payment_event() now rejects a retry that supplies a different
-- event_type for an already-seen (provider, provider_event_id) pair.
-- ============================================================

alter table public.purchases
  add column payment_id uuid references public.payments(id) on delete restrict;

create index purchases_payment_id_idx on public.purchases (payment_id);

create table public.payment_refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete restrict,
  purchase_id uuid not null references public.purchases(id) on delete restrict,
  provider text not null,
  provider_refund_id text not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now(),
  refunded_at timestamptz,
  unique (provider, provider_refund_id),
  -- STRIPE-CUTOVER-1C (migration 056): widened from bare purchase_id to
  -- (payment_id, purchase_id) -- same reasoning as author_ledger_
  -- entries' own sale-uniqueness widening above: one transaction item
  -- may receive one full V1 refund, but the same reusable entitlement,
  -- bought again later under a genuinely different payment, may have
  -- its own independent refund.
  unique (payment_id, purchase_id)
);

create index payment_refunds_payment_id_idx on public.payment_refunds (payment_id);

alter table public.payment_refunds enable row level security;

revoke all on public.payment_refunds from anon, authenticated;
grant select on public.payment_refunds to authenticated;

create policy "Staff with finance.view can view all payment refunds"
  on public.payment_refunds for select
  using (public.staff_has_permission('finance.view'));

alter table public.author_ledger_entries
  add column payment_refund_id uuid references public.payment_refunds(id) on delete set null;

alter table public.author_ledger_entries
  add constraint author_ledger_entries_refund_requires_payment_refund_id
  check (entry_type <> 'refund' or payment_refund_id is not null);

create unique index author_ledger_entries_one_refund_per_payment_refund_idx
  on public.author_ledger_entries (payment_refund_id)
  where entry_type = 'refund';

-- STRIPE-CUTOVER-1C (migration 056): new trailing p_provider_payment_id
-- parameter and provider_payment_id output column -- required event/
-- payment binding for ledger_v1 (a caller-argument mismatch here raises
-- before either ledger wrapper does any business mutation).
create or replace function public.record_payment_event(
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_provider_payment_id text default null
)
returns table (
  id uuid,
  provider text,
  provider_event_id text,
  event_type text,
  status text,
  received_at timestamptz,
  processed_at timestamptz,
  last_error_code text,
  created_at timestamptz,
  provider_payment_id text,
  already_existed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new record;
  v_existing record;
begin
  insert into public.payment_events (provider, provider_event_id, event_type, provider_payment_id)
    values (p_provider, p_provider_event_id, p_event_type, p_provider_payment_id)
    on conflict on constraint payment_events_provider_provider_event_id_key do nothing
    returning
      payment_events.id, payment_events.provider, payment_events.provider_event_id,
      payment_events.event_type, payment_events.status, payment_events.received_at,
      payment_events.processed_at, payment_events.last_error_code, payment_events.created_at,
      payment_events.provider_payment_id
    into v_new;

  if v_new.id is not null then
    id := v_new.id;
    provider := v_new.provider;
    provider_event_id := v_new.provider_event_id;
    event_type := v_new.event_type;
    status := v_new.status;
    received_at := v_new.received_at;
    processed_at := v_new.processed_at;
    last_error_code := v_new.last_error_code;
    created_at := v_new.created_at;
    provider_payment_id := v_new.provider_payment_id;
    already_existed := false;
    return next;
    return;
  end if;

  select pe.id, pe.provider, pe.provider_event_id, pe.event_type, pe.status,
         pe.received_at, pe.processed_at, pe.last_error_code, pe.created_at,
         pe.provider_payment_id
    into v_existing
    from public.payment_events pe
    where pe.provider = p_provider and pe.provider_event_id = p_provider_event_id;

  if v_existing.event_type <> p_event_type then
    raise exception
      'payment event %/% already recorded with a different event_type (existing=%, requested=%)',
      p_provider, p_provider_event_id, v_existing.event_type, p_event_type;
  end if;

  -- provider_payment_id consistency: a mismatch between two non-null
  -- values is a genuine integrity problem and must raise. An existing
  -- NULL row may be backfilled by a later call that does supply one;
  -- never the reverse.
  if v_existing.provider_payment_id is not null
     and p_provider_payment_id is not null
     and v_existing.provider_payment_id <> p_provider_payment_id
  then
    raise exception
      'payment event %/% already recorded with a different provider_payment_id (existing=%, requested=%)',
      p_provider, p_provider_event_id, v_existing.provider_payment_id, p_provider_payment_id;
  end if;

  if v_existing.provider_payment_id is null and p_provider_payment_id is not null then
    update public.payment_events set provider_payment_id = p_provider_payment_id
      where payment_events.id = v_existing.id;
    v_existing.provider_payment_id := p_provider_payment_id;
  end if;

  id := v_existing.id;
  provider := v_existing.provider;
  provider_event_id := v_existing.provider_event_id;
  event_type := v_existing.event_type;
  status := v_existing.status;
  received_at := v_existing.received_at;
  processed_at := v_existing.processed_at;
  last_error_code := v_existing.last_error_code;
  created_at := v_existing.created_at;
  provider_payment_id := v_existing.provider_payment_id;
  already_existed := true;
  return next;
end;
$$;

revoke all on function public.record_payment_event(text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_payment_event(text, text, text, text) to service_role;

create or replace function public.mark_payment_event_processed(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.payment_events where id = p_event_id) then
    raise exception 'payment event not found: %', p_event_id;
  end if;

  update public.payment_events
    set status = 'processed', processed_at = now()
    where id = p_event_id and status <> 'processed';
end;
$$;

-- STRIPE-CUTOVER-1C (migration 056): internal-only after this
-- migration -- ledger-v1 event disposition must only ever happen via
-- the atomic wrapper that also recorded the corresponding business
-- effect (finalize_ledger_book_payment()/finalize_ledger_bundle_
-- payment(), both further down this file), never via a bare,
-- independent service_role call.
revoke all on function public.mark_payment_event_processed(uuid) from public, anon, authenticated, service_role;

create or replace function public.mark_payment_event_failed(p_event_id uuid, p_error_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.payment_events where id = p_event_id) then
    raise exception 'payment event not found: %', p_event_id;
  end if;

  update public.payment_events
    set status = 'failed', last_error_code = p_error_code, processed_at = now()
    where id = p_event_id and status <> 'processed';
end;
$$;

-- STRIPE-CUTOVER-1C (migration 056): internal-only, same reasoning as
-- mark_payment_event_processed() above.
revoke all on function public.mark_payment_event_failed(uuid, text) from public, anon, authenticated, service_role;

-- STRIPE-CUTOVER-1C (migration 056): final signature and two-branch
-- body. p_available_at (6th param) renamed to p_paid_at -- available_at
-- is now derived internally as paid_at + 30 days, never accepted from a
-- caller. INTERNAL after this migration -- EXECUTE is revoked from
-- service_role too (see the revoke below), reachable only via
-- finalize_ledger_book_payment()/finalize_ledger_bundle_payment()
-- further down this file (both owned by the same role, which always
-- retains implicit EXECUTE on its own functions regardless of that
-- revoke).
create or replace function public.record_successful_sale(
  p_provider text,
  p_provider_payment_id text,
  p_currency text,
  p_purchase_ids uuid[],
  p_royalty_rate_bps integer,
  p_paid_at timestamptz,
  p_buyer_id uuid default null
)
returns table (
  purchase_id uuid,
  ledger_entry_id uuid,
  created boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purchase_ids uuid[];
  v_canonical_ids uuid[];
  v_payment_id uuid;
  v_payment record;
  v_total_gross bigint;
  v_distinct_reader_count integer;
  v_derived_reader_id uuid;
  v_pid uuid;
  v_purchase record;
  v_gross bigint;
  v_librum bigint;
  v_author_amount bigint;
  v_existing_entry record;
  v_entry_id uuid;
  v_available_at timestamptz;
begin
  if p_provider is null or length(trim(p_provider)) = 0 then
    raise exception 'p_provider is required';
  end if;
  if p_provider_payment_id is null or length(trim(p_provider_payment_id)) = 0 then
    raise exception 'p_provider_payment_id is required';
  end if;
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'p_currency must be a 3-letter uppercase code';
  end if;
  if p_royalty_rate_bps is null or p_royalty_rate_bps < 0 or p_royalty_rate_bps > 10000 then
    raise exception 'p_royalty_rate_bps must be between 0 and 10000';
  end if;
  if p_paid_at is null then
    raise exception 'p_paid_at is required';
  end if;

  select array_agg(distinct x order by x) into v_purchase_ids from unnest(p_purchase_ids) x;
  if v_purchase_ids is null or array_length(v_purchase_ids, 1) is null then
    raise exception 'p_purchase_ids must contain at least one purchase id';
  end if;

  if (select count(*) from public.purchases pu where pu.id = any(v_purchase_ids))
     <> array_length(v_purchase_ids, 1) then
    raise exception 'one or more purchase ids do not exist';
  end if;

  select count(distinct coalesce(pu.reader_id::text, '00000000-0000-0000-0000-000000000000'))
    into v_distinct_reader_count
    from public.purchases pu
    where pu.id = any(v_purchase_ids);

  if v_distinct_reader_count > 1 then
    raise exception 'the supplied purchases do not all belong to the same reader (mixed buyers)';
  end if;

  select pu.reader_id into v_derived_reader_id
    from public.purchases pu
    where pu.id = v_purchase_ids[1];

  if p_buyer_id is not null and v_derived_reader_id is not null and p_buyer_id <> v_derived_reader_id then
    raise exception
      'p_buyer_id (%) does not match the reader derived from the supplied purchases (%)',
      p_buyer_id, v_derived_reader_id;
  end if;

  -- v_total_gross is only ever computed from purchases.amount_cents HERE
  -- -- the candidate INSERT amount for a brand new payment -- never
  -- read or trusted again once a payment already exists (the retry
  -- branch below never touches purchases.amount_cents at all). Safe
  -- here because, if this insert wins, these purchases were just
  -- finalized/upserted in the SAME outer transaction from frozen
  -- checkout/snapshot data by the calling wrapper, moments before this
  -- call.
  select coalesce(sum(pu.amount_cents), 0) into v_total_gross
    from public.purchases pu
    where pu.id = any(v_purchase_ids);

  if v_total_gross <= 0 then
    raise exception 'total gross amount for the supplied purchases must be positive';
  end if;

  v_available_at := p_paid_at + interval '30 days';

  -- regime is a hardcoded trusted literal, never a caller-supplied
  -- parameter: calling this function at all is definitionally a
  -- ledger_v1 event, since it is callable only by the ledger wrapper
  -- RPCs after the revoke below.
  insert into public.payments
    (provider, provider_payment_id, buyer_id, amount_minor, currency, status, paid_at, regime)
    values
    (p_provider, p_provider_payment_id, v_derived_reader_id, v_total_gross, p_currency, 'succeeded', p_paid_at, 'librum_ledger_v1')
    on conflict (provider, provider_payment_id) do nothing
    returning payments.id
    into v_payment_id;

  if v_payment_id is not null then
    -- FRESH PAYMENT BRANCH. Derives economics from current
    -- purchases.amount_cents -- the only branch where that is ever
    -- safe to do.
    foreach v_pid in array v_purchase_ids loop
      select pu.id as purchase_id, pu.amount_cents, b.author_id
        into v_purchase
        from public.purchases pu
        join public.books b on b.id = pu.book_id
        where pu.id = v_pid;

      v_gross := v_purchase.amount_cents;
      v_librum := round(v_gross * (10000 - p_royalty_rate_bps) / 10000.0)::bigint;
      v_author_amount := v_gross - v_librum;

      insert into public.author_ledger_entries
        (author_id, purchase_id, payment_id, entry_type, amount_minor, currency,
         royalty_rate_bps, gross_amount_minor, librum_amount_minor, available_at)
      values
        (v_purchase.author_id, v_pid, v_payment_id, 'sale', v_author_amount, p_currency,
         p_royalty_rate_bps, v_gross, v_librum, v_available_at)
      returning id into v_entry_id;

      -- "Most recent payment for this current entitlement" pointer --
      -- unconditional, since this branch only runs once, at true
      -- creation time.
      update public.purchases set payment_id = v_payment_id where id = v_pid;

      purchase_id := v_pid;
      ledger_entry_id := v_entry_id;
      created := true;
      return next;
    end loop;
    return;
  end if;

  -- EXISTING PAYMENT RETRY BRANCH. Never reads purchases.amount_cents
  -- for economics, never updates purchases.payment_id, never updates
  -- payments. Every fact compared below comes from the immutable
  -- payments row itself or from the immutable author_ledger_entries
  -- sale rows already recorded against it -- reconstructed here, never
  -- from the mutable current-entitlement state.
  select p.id, p.currency, p.paid_at, p.regime into v_payment
    from public.payments p
    where p.provider = p_provider and p.provider_payment_id = p_provider_payment_id;

  v_payment_id := v_payment.id;

  if v_payment.regime <> 'librum_ledger_v1' then
    raise exception
      'payment %/% is not a librum_ledger_v1 payment (regime %) -- cannot be retried via record_successful_sale',
      p_provider, p_provider_payment_id, v_payment.regime;
  end if;

  if v_payment.currency <> p_currency then
    raise exception
      'payment %/% already recorded with a different currency (existing=%, requested=%)',
      p_provider, p_provider_payment_id, v_payment.currency, p_currency;
  end if;

  if v_payment.paid_at <> p_paid_at then
    raise exception
      'payment %/% already recorded with a different paid_at (existing=%, requested=%)',
      p_provider, p_provider_payment_id, v_payment.paid_at, p_paid_at;
  end if;

  select array_agg(ale.purchase_id order by ale.purchase_id) into v_canonical_ids
    from public.author_ledger_entries ale
    where ale.payment_id = v_payment_id and ale.entry_type = 'sale';

  if v_canonical_ids is distinct from v_purchase_ids then
    raise exception
      'payment %/% is already linked to a different set of purchases and cannot be reassigned',
      p_provider, p_provider_payment_id;
  end if;

  foreach v_pid in array v_purchase_ids loop
    select ale.id, ale.royalty_rate_bps
      into v_existing_entry
      from public.author_ledger_entries ale
      where ale.payment_id = v_payment_id and ale.purchase_id = v_pid and ale.entry_type = 'sale';

    if v_existing_entry.id is null then
      raise exception
        'payment %/% is missing a sale entry for purchase % -- partial/corrupt prior recording, cannot safely retry',
        p_provider, p_provider_payment_id, v_pid;
    end if;

    if v_existing_entry.royalty_rate_bps <> p_royalty_rate_bps then
      raise exception
        'purchase % sale entry royalty_rate_bps does not match retry request (existing=%, requested=%)',
        v_pid, v_existing_entry.royalty_rate_bps, p_royalty_rate_bps;
    end if;

    purchase_id := v_pid;
    ledger_entry_id := v_existing_entry.id;
    created := false;
    return next;
  end loop;
end;
$$;

revoke all on function public.record_successful_sale(text, text, text, uuid[], integer, timestamptz, uuid)
  from public, anon, authenticated, service_role;

-- STRIPE-CUTOVER-1C (migration 056): corrected signature -- resolves
-- the payment being refunded via the immutable (provider,
-- provider_payment_id) key, NEVER via purchases.payment_id (which only
-- ever reflects the current entitlement's MOST RECENT payment and would
-- resolve to the wrong, later payment once the same purchases row has
-- been reused by a subsequent transaction). Resolves the original sale
-- via the composite (payment_id, purchase_id) key, mirroring
-- record_successful_sale()'s own correction above.
create or replace function public.record_refund(
  p_provider text,
  p_provider_payment_id text,
  p_purchase_id uuid,
  p_provider_refund_id text
)
returns table (
  payment_refund_id uuid,
  ledger_entry_id uuid,
  created boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purchase record;
  v_payment record;
  v_sale record;
  v_existing_refund record;
  v_refund_id uuid;
  v_ledger_id uuid;
  v_refunded_sum bigint;
  v_new_status text;
begin
  if p_provider is null or length(trim(p_provider)) = 0 then
    raise exception 'p_provider is required';
  end if;
  if p_provider_payment_id is null or length(trim(p_provider_payment_id)) = 0 then
    raise exception 'p_provider_payment_id is required';
  end if;
  if p_purchase_id is null then
    raise exception 'p_purchase_id is required';
  end if;
  if p_provider_refund_id is null or length(trim(p_provider_refund_id)) = 0 then
    raise exception 'p_provider_refund_id is required';
  end if;

  select pu.id into v_purchase
    from public.purchases pu
    where pu.id = p_purchase_id;

  if v_purchase.id is null then
    raise exception 'purchase % does not exist', p_purchase_id;
  end if;

  select p.id, p.provider, p.amount_minor, p.currency into v_payment
    from public.payments p
    where p.provider = p_provider and p.provider_payment_id = p_provider_payment_id;

  if v_payment.id is null then
    raise exception 'payment %/% does not exist; cannot record a refund', p_provider, p_provider_payment_id;
  end if;

  select ale.id, ale.author_id, ale.amount_minor, ale.gross_amount_minor into v_sale
    from public.author_ledger_entries ale
    where ale.payment_id = v_payment.id and ale.purchase_id = p_purchase_id and ale.entry_type = 'sale';

  if v_sale.id is null then
    raise exception 'no sale ledger entry found for payment %/% purchase %; cannot record a refund',
      p_provider, p_provider_payment_id, p_purchase_id;
  end if;

  select pr.id, pr.provider, pr.provider_refund_id into v_existing_refund
    from public.payment_refunds pr
    where pr.payment_id = v_payment.id and pr.purchase_id = p_purchase_id;

  if v_existing_refund.id is not null then
    if v_existing_refund.provider = v_payment.provider
       and v_existing_refund.provider_refund_id = p_provider_refund_id then
      select ale.id into v_ledger_id
        from public.author_ledger_entries ale
        where ale.payment_refund_id = v_existing_refund.id and ale.entry_type = 'refund';
      payment_refund_id := v_existing_refund.id;
      ledger_entry_id := v_ledger_id;
      created := false;
      return next;
      return;
    else
      raise exception
        'payment %/% purchase % has already been refunded under a different provider refund id (%/%); full-refund-only V1 does not support a second refund',
        p_provider, p_provider_payment_id, p_purchase_id, v_existing_refund.provider, v_existing_refund.provider_refund_id;
    end if;
  end if;

  begin
    insert into public.payment_refunds
      (payment_id, purchase_id, provider, provider_refund_id, amount_minor, currency, refunded_at)
    values
      (v_payment.id, p_purchase_id, v_payment.provider, p_provider_refund_id,
       v_sale.gross_amount_minor, v_payment.currency, now())
    returning id into v_refund_id;
  exception when unique_violation then
    -- The only remaining unique constraint that can fire here is
    -- (provider, provider_refund_id) -- the (payment_id, purchase_id)
    -- scoped check above already ruled out a pre-existing row for THIS
    -- payment/purchase pair.
    select pr.id, pr.payment_id, pr.purchase_id into v_existing_refund
      from public.payment_refunds pr
      where pr.provider = v_payment.provider and pr.provider_refund_id = p_provider_refund_id;

    if v_existing_refund.id is not null
       and v_existing_refund.payment_id = v_payment.id
       and v_existing_refund.purchase_id = p_purchase_id
    then
      select ale.id into v_ledger_id
        from public.author_ledger_entries ale
        where ale.payment_refund_id = v_existing_refund.id and ale.entry_type = 'refund';
      payment_refund_id := v_existing_refund.id;
      ledger_entry_id := v_ledger_id;
      created := false;
      return next;
      return;
    end if;

    raise exception
      'provider refund id %/% is already recorded against a different payment/purchase',
      v_payment.provider, p_provider_refund_id;
  end;

  insert into public.author_ledger_entries
    (author_id, purchase_id, payment_id, payment_refund_id, entry_type, amount_minor, currency, available_at)
  values
    (v_sale.author_id, p_purchase_id, v_payment.id, v_refund_id, 'refund',
     -v_sale.amount_minor, v_payment.currency, now())
  returning id into v_ledger_id;

  select coalesce(sum(pr.amount_minor), 0) into v_refunded_sum
    from public.payment_refunds pr
    where pr.payment_id = v_payment.id;

  if v_refunded_sum > v_payment.amount_minor then
    raise exception
      'payment % refunded sum % exceeds payment total % -- data integrity violation',
      v_payment.id, v_refunded_sum, v_payment.amount_minor;
  elsif v_refunded_sum = v_payment.amount_minor then
    v_new_status := 'refunded';
  elsif v_refunded_sum > 0 then
    v_new_status := 'partially_refunded';
  else
    v_new_status := 'succeeded';
  end if;

  update public.payments set status = v_new_status, updated_at = now() where id = v_payment.id;

  payment_refund_id := v_refund_id;
  ledger_entry_id := v_ledger_id;
  created := true;
  return next;
end;
$$;

revoke all on function public.record_refund(text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.record_refund(text, text, uuid, text) to service_role;

-- ============================================================
-- STRIPE-CUTOVER-1C (migration 056): the two ledger_v1 atomic wrapper
-- RPCs. Every step below runs inside the wrapper's own transaction --
-- any exception rolls back everything: the payment_event row lock, any
-- entitlement write the shared core made, and any payment/ledger write
-- record_successful_sale made. All commit or all rollback. Neither
-- accepts author_id, expected amount, expected currency, royalty rate,
-- available_at, or regime -- every one of those is derived from the
-- trusted, already-frozen checkout row or computed internally.
-- ============================================================

create or replace function public.finalize_ledger_book_payment(
  p_payment_event_id uuid,
  p_intent_id uuid,
  p_provider text,
  p_provider_payment_id text,
  p_actual_amount_minor bigint,
  p_actual_currency text,
  p_paid_at timestamptz
)
returns table (
  outcome text,
  out_book_id uuid,
  out_reader_id uuid,
  out_author_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event record;
  v_intent record;
  v_normalized_currency text;
  v_core record;
  v_purchase_id uuid;
  v_author_id uuid;
begin
  if p_payment_event_id is null then raise exception 'p_payment_event_id is required'; end if;
  if p_intent_id is null then raise exception 'p_intent_id is required'; end if;
  if p_provider is null or length(trim(p_provider)) = 0 then raise exception 'p_provider is required'; end if;
  if p_provider_payment_id is null or length(trim(p_provider_payment_id)) = 0 then
    raise exception 'p_provider_payment_id is required';
  end if;
  if p_paid_at is null then raise exception 'p_paid_at is required'; end if;

  select id, provider, provider_payment_id into v_event
    from public.payment_events
    where id = p_payment_event_id
    for update;

  if v_event.id is null then
    raise exception 'finalize_ledger_book_payment: payment_event % not found', p_payment_event_id;
  end if;

  if v_event.provider is distinct from p_provider
     or v_event.provider_payment_id is distinct from p_provider_payment_id
  then
    raise exception
      'finalize_ledger_book_payment: payment_event %/% does not match supplied provider/provider_payment_id (event provider=%, provider_payment_id=%)',
      p_provider, p_provider_payment_id, v_event.provider, v_event.provider_payment_id;
  end if;

  select id, book_id, reader_id, price_cents_at_checkout, currency, royalty_rate_bps, regime
    into v_intent
    from public.book_checkout_intents
    where id = p_intent_id
    for update;

  if v_intent.id is null then
    raise exception 'finalize_ledger_book_payment: checkout intent % not found', p_intent_id;
  end if;

  if v_intent.regime <> 'librum_ledger_v1' then
    raise exception
      'finalize_ledger_book_payment: intent % is not a librum_ledger_v1 checkout (regime %) -- use finalize_book_checkout_intent for legacy_stripe_connect_v1',
      p_intent_id, v_intent.regime;
  end if;

  v_normalized_currency := upper(btrim(coalesce(p_actual_currency, '')));

  if p_actual_amount_minor is null or p_actual_amount_minor <= 0 then
    raise exception 'finalize_ledger_book_payment: p_actual_amount_minor must be positive';
  end if;

  if p_actual_amount_minor <> v_intent.price_cents_at_checkout
     or v_normalized_currency <> v_intent.currency
  then
    raise exception
      'finalize_ledger_book_payment: amount/currency mismatch for intent % (expected % %, got % %)',
      p_intent_id, v_intent.price_cents_at_checkout, v_intent.currency, p_actual_amount_minor, v_normalized_currency;
  end if;

  select core.outcome, core.out_book_id, core.out_reader_id
    into v_core
    from public.finalize_book_checkout_intent_entitlement_core(
      p_intent_id, null, p_provider_payment_id, p_actual_amount_minor::integer
    ) as core;

  if v_core.outcome in ('active_other_session', 'blocked_book_or_reader_deleted', 'blocked_disputed_lost') then
    perform public.mark_payment_event_failed(p_payment_event_id, v_core.outcome);
    outcome := v_core.outcome;
    out_book_id := v_core.out_book_id;
    out_reader_id := v_core.out_reader_id;
    out_author_id := null;
    return next;
    return;
  end if;

  select id into v_purchase_id
    from public.purchases
    where book_id = v_core.out_book_id and reader_id = v_core.out_reader_id;

  select author_id into v_author_id from public.books where id = v_core.out_book_id;

  perform public.record_successful_sale(
    p_provider, p_provider_payment_id, v_normalized_currency,
    array[v_purchase_id], v_intent.royalty_rate_bps, p_paid_at, v_core.out_reader_id
  );

  perform public.mark_payment_event_processed(p_payment_event_id);

  outcome := v_core.outcome;
  out_book_id := v_core.out_book_id;
  out_reader_id := v_core.out_reader_id;
  out_author_id := v_author_id;
  return next;
end;
$$;

revoke all on function public.finalize_ledger_book_payment(uuid, uuid, text, text, bigint, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.finalize_ledger_book_payment(uuid, uuid, text, text, bigint, text, timestamptz)
  to service_role;

create or replace function public.finalize_ledger_bundle_payment(
  p_payment_event_id uuid,
  p_snapshot_id uuid,
  p_provider text,
  p_provider_payment_id text,
  p_actual_amount_minor bigint,
  p_actual_currency text,
  p_paid_at timestamptz
)
returns table (
  outcome text,
  out_reader_id uuid,
  out_author_id uuid,
  out_book_ids uuid[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event record;
  v_snapshot record;
  v_normalized_currency text;
  v_existing_payment_id uuid;
  v_funded_total_frozen bigint;
  v_row record;
  v_purchase_ids uuid[] := array[]::uuid[];
  v_out_book_ids uuid[] := array[]::uuid[];
  v_pid uuid;
begin
  if p_payment_event_id is null then raise exception 'p_payment_event_id is required'; end if;
  if p_snapshot_id is null then raise exception 'p_snapshot_id is required'; end if;
  if p_provider is null or length(trim(p_provider)) = 0 then raise exception 'p_provider is required'; end if;
  if p_provider_payment_id is null or length(trim(p_provider_payment_id)) = 0 then
    raise exception 'p_provider_payment_id is required';
  end if;
  if p_paid_at is null then raise exception 'p_paid_at is required'; end if;

  select id, provider, provider_payment_id into v_event
    from public.payment_events
    where id = p_payment_event_id
    for update;

  if v_event.id is null then
    raise exception 'finalize_ledger_bundle_payment: payment_event % not found', p_payment_event_id;
  end if;

  if v_event.provider is distinct from p_provider
     or v_event.provider_payment_id is distinct from p_provider_payment_id
  then
    raise exception
      'finalize_ledger_bundle_payment: payment_event %/% does not match supplied provider/provider_payment_id (event provider=%, provider_payment_id=%)',
      p_provider, p_provider_payment_id, v_event.provider, v_event.provider_payment_id;
  end if;

  select id, reader_id, author_id, bundle_id, bundle_title, bundle_price_cents_at_checkout,
         items, regime, currency, royalty_rate_bps
    into v_snapshot
    from public.bundle_checkout_snapshots
    where id = p_snapshot_id
    for update;

  if v_snapshot.id is null then
    raise exception 'finalize_ledger_bundle_payment: bundle checkout snapshot % not found', p_snapshot_id;
  end if;

  if v_snapshot.regime <> 'librum_ledger_v1' then
    raise exception
      'finalize_ledger_bundle_payment: snapshot % is not a librum_ledger_v1 checkout (regime %) -- legacy bundle fulfillment handles legacy_stripe_connect_v1',
      p_snapshot_id, v_snapshot.regime;
  end if;

  if v_snapshot.reader_id is null then
    raise exception
      'finalize_ledger_bundle_payment: snapshot % reader_id is null (reader deleted) -- unrecoverable',
      p_snapshot_id;
  end if;

  v_normalized_currency := upper(btrim(coalesce(p_actual_currency, '')));

  if p_actual_amount_minor is null or p_actual_amount_minor <= 0 then
    raise exception 'finalize_ledger_bundle_payment: p_actual_amount_minor must be positive';
  end if;

  if p_actual_amount_minor <> v_snapshot.bundle_price_cents_at_checkout
     or v_normalized_currency <> v_snapshot.currency
  then
    raise exception
      'finalize_ledger_bundle_payment: amount/currency mismatch for snapshot % (expected % %, got % %)',
      p_snapshot_id, v_snapshot.bundle_price_cents_at_checkout, v_snapshot.currency,
      p_actual_amount_minor, v_normalized_currency;
  end if;

  if public.payment_intent_has_lost_dispute(p_provider_payment_id) then
    perform public.mark_payment_event_failed(p_payment_event_id, 'blocked_disputed_lost');
    outcome := 'blocked_disputed_lost';
    out_reader_id := v_snapshot.reader_id;
    out_author_id := v_snapshot.author_id;
    out_book_ids := array[]::uuid[];
    return next;
    return;
  end if;

  select id into v_existing_payment_id
    from public.payments
    where provider = p_provider and provider_payment_id = p_provider_payment_id;

  select coalesce(sum(d.frozen_price), 0)
    into v_funded_total_frozen
    from jsonb_array_elements(v_snapshot.items) as item,
      lateral (select (item->>'book_id')::uuid as book_id, (item->>'price_cents_at_checkout')::integer as frozen_price) d
    left join public.purchases pu on pu.book_id = d.book_id and pu.reader_id = v_snapshot.reader_id
    where not (
      pu.id is not null
      and (v_existing_payment_id is null or pu.payment_id is distinct from v_existing_payment_id)
      and pu.refunded_at is null
      and not public.payment_intent_has_lost_dispute(pu.stripe_payment_intent_id)
    );

  if v_funded_total_frozen = 0 then
    raise exception
      'finalize_ledger_bundle_payment: snapshot % has no fundable items but a positive amount must still be allocated (every item already actively owned via a different payment)',
      p_snapshot_id;
  end if;

  for v_row in
    with item_data as (
      select
        (item->>'book_id')::uuid as book_id,
        (item->>'price_cents_at_checkout')::integer as frozen_price,
        (item->>'position')::integer as position
      from jsonb_array_elements(v_snapshot.items) as item
    ),
    classified as (
      select
        d.book_id, d.frozen_price, d.position,
        pu.id as existing_purchase_id,
        case
          when pu.id is not null
            and (v_existing_payment_id is null or pu.payment_id is distinct from v_existing_payment_id)
            and pu.refunded_at is null
            and not public.payment_intent_has_lost_dispute(pu.stripe_payment_intent_id)
          then 'active_other_payment'
          else 'eligible'
        end as classification
      from item_data d
      left join public.purchases pu on pu.book_id = d.book_id and pu.reader_id = v_snapshot.reader_id
    ),
    funded as (
      select * from classified where classification = 'eligible'
    ),
    allocated as (
      select
        book_id, frozen_price, position, existing_purchase_id,
        floor(p_actual_amount_minor * frozen_price::numeric / v_funded_total_frozen)::bigint as floor_share
      from funded
    ),
    final_shares as (
      select
        book_id, existing_purchase_id, floor_share,
        floor_share + case
          when row_number() over (order by position) <= (p_actual_amount_minor - sum(floor_share) over ())
          then 1 else 0
        end as final_share
      from allocated
    )
    select book_id, existing_purchase_id, final_share from final_shares
  loop
    insert into public.purchases (
      book_id, reader_id, stripe_checkout_session_id, stripe_payment_intent_id,
      amount_cents, discount_code_id, bundle_id, refunded_at, regime
    ) values (
      v_row.book_id, v_snapshot.reader_id, null, p_provider_payment_id,
      v_row.final_share, null, v_snapshot.bundle_id, null, v_snapshot.regime
    )
    on conflict (book_id, reader_id) do update set
      stripe_payment_intent_id = excluded.stripe_payment_intent_id,
      amount_cents = excluded.amount_cents,
      bundle_id = excluded.bundle_id,
      refunded_at = null,
      regime = excluded.regime
    returning id into v_pid;

    v_purchase_ids := array_append(v_purchase_ids, v_pid);
    v_out_book_ids := array_append(v_out_book_ids, v_row.book_id);
  end loop;

  for v_row in
    select pu.id as pid, pu.book_id as bid
    from public.purchases pu
    where pu.reader_id = v_snapshot.reader_id
      and pu.book_id in (
        select (item->>'book_id')::uuid from jsonb_array_elements(v_snapshot.items) as item
      )
      and v_existing_payment_id is not null
      and pu.payment_id = v_existing_payment_id
      and not (pu.id = any(v_purchase_ids))
  loop
    v_purchase_ids := array_append(v_purchase_ids, v_row.pid);
    v_out_book_ids := array_append(v_out_book_ids, v_row.bid);
  end loop;

  perform public.record_successful_sale(
    p_provider, p_provider_payment_id, v_normalized_currency,
    v_purchase_ids, v_snapshot.royalty_rate_bps, p_paid_at, v_snapshot.reader_id
  );

  update public.bundle_checkout_snapshots
    set fulfilled_at = now(), total_amount_cents = p_actual_amount_minor
    where id = p_snapshot_id and fulfilled_at is null;

  delete from public.bundle_checkout_reservations where snapshot_id = p_snapshot_id;
  delete from public.bundle_checkout_reader_holds where snapshot_id = p_snapshot_id;

  perform public.mark_payment_event_processed(p_payment_event_id);

  outcome := 'eligible_fulfilled';
  out_reader_id := v_snapshot.reader_id;
  out_author_id := v_snapshot.author_id;
  out_book_ids := v_out_book_ids;
  return next;
end;
$$;

revoke all on function public.finalize_ledger_bundle_payment(uuid, uuid, text, text, bigint, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.finalize_ledger_bundle_payment(uuid, uuid, text, text, bigint, text, timestamptz)
  to service_role;

-- ============================================================
-- LIBRUM 2.0 LEDGER-1D (migration 050): author-facing financial
-- reporting + safe read model, built on migrations 048/049. Adds two
-- SECURITY DEFINER functions -- get_author_financial_summary() and
-- list_author_financial_activity() -- authenticated to auth.uid() alone
-- (no p_author_id parameter exists on either), grantable to
-- authenticated since both are read-only, self-scoped, and expose no
-- internal correlation identifiers (payment_id, payout_id,
-- payment_refund_id, reference_type, reference_id, buyer identity, or
-- any provider id are never selected). The original author-own RLS
-- policy on author_ledger_entries (migration 048) was removed above --
-- authors now read their own ledger data exclusively through these two
-- functions; finance.view staff access is entirely unaffected.
--
-- PENDING/AVAILABLE: a 'refund' entry is attributed to the same
-- settlement bucket as the ORIGINAL SALE it reverses (looked up via the
-- shared purchase_id, always 1:1 by construction), not its own
-- available_at (which migration 048 always sets to "immediate") --
-- otherwise reversing a not-yet-settled sale would wrongly show
-- pending=800/available=-800 instead of the correct pending=0/
-- available=0. 'payout'/'adjustment' entries use their own available_at,
-- with NULL treated as immediately available (coalesced to created_at) --
-- an explicit rule for a case migration 048 only ever documented as an
-- expectation for future callers. available_minor = current_balance_minor
-- - pending_minor; negative balances (e.g. a paid-out sale later
-- refunded) are reported as-is, never clamped to zero.
-- ============================================================

-- LEDGER-1E-B (migration 051): the accounting formula above now lives
-- in exactly ONE place -- author_ledger_balance(p_author_id uuid),
-- parameterized so the service-role payout engine can compute an
-- ARBITRARY author's balance, not just auth.uid()'s. SECURITY DEFINER,
-- EXECUTE granted ONLY to service_role (never PUBLIC/anon/authenticated,
-- not even finance.view staff -- finance.view stays read-only via its
-- own RLS policy, never an arbitrary-author balance RPC).
-- get_author_financial_summary() below is now a one-line, auth.uid()-
-- scoped wrapper around it -- byte-identical external contract to the
-- original migration 050 version (same columns, same semantics, same
-- authenticated-only grant).
create or replace function public.author_ledger_balance(p_author_id uuid)
returns table (
  currency text,
  lifetime_sale_minor bigint,
  lifetime_refund_minor bigint,
  lifetime_adjustment_minor bigint,
  net_earnings_minor bigint,
  paid_out_minor bigint,
  pending_minor bigint,
  available_minor bigint,
  current_balance_minor bigint
)
language sql
security definer
set search_path = ''
stable
as $$
  with entries as (
    select
      ale.currency,
      ale.entry_type,
      ale.amount_minor,
      case
        when ale.entry_type = 'sale' then ale.available_at
        when ale.entry_type = 'refund' then coalesce(
          (
            select sib.available_at
            from public.author_ledger_entries sib
            where sib.purchase_id = ale.purchase_id and sib.entry_type = 'sale'
            limit 1
          ),
          ale.available_at
        )
        else coalesce(ale.available_at, ale.created_at)
      end as effective_available_at
    from public.author_ledger_entries ale
    where ale.author_id = p_author_id
  )
  select
    currency,
    coalesce(sum(amount_minor) filter (where entry_type = 'sale'), 0)::bigint as lifetime_sale_minor,
    coalesce(-sum(amount_minor) filter (where entry_type = 'refund'), 0)::bigint as lifetime_refund_minor,
    coalesce(sum(amount_minor) filter (where entry_type = 'adjustment'), 0)::bigint as lifetime_adjustment_minor,
    coalesce(sum(amount_minor) filter (where entry_type in ('sale', 'refund', 'adjustment')), 0)::bigint as net_earnings_minor,
    coalesce(-sum(amount_minor) filter (where entry_type = 'payout'), 0)::bigint as paid_out_minor,
    coalesce(sum(amount_minor) filter (where effective_available_at > now()), 0)::bigint as pending_minor,
    (
      coalesce(sum(amount_minor), 0)
      - coalesce(sum(amount_minor) filter (where effective_available_at > now()), 0)
    )::bigint as available_minor,
    coalesce(sum(amount_minor), 0)::bigint as current_balance_minor
  from entries
  group by currency;
$$;

revoke all on function public.author_ledger_balance(uuid) from public, anon, authenticated;
grant execute on function public.author_ledger_balance(uuid) to service_role;

create or replace function public.get_author_financial_summary()
returns table (
  currency text,
  lifetime_sale_minor bigint,
  lifetime_refund_minor bigint,
  lifetime_adjustment_minor bigint,
  net_earnings_minor bigint,
  paid_out_minor bigint,
  pending_minor bigint,
  available_minor bigint,
  current_balance_minor bigint
)
language sql
security definer
set search_path = ''
stable
as $$
  select * from public.author_ledger_balance(auth.uid());
$$;

revoke all on function public.get_author_financial_summary() from public, anon, authenticated;
grant execute on function public.get_author_financial_summary() to authenticated;

create or replace function public.list_author_financial_activity(
  p_limit integer default 25,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
)
returns table (
  id uuid,
  entry_type text,
  amount_minor bigint,
  currency text,
  gross_amount_minor bigint,
  librum_amount_minor bigint,
  royalty_rate_bps integer,
  available_at timestamptz,
  created_at timestamptz,
  book_id uuid,
  book_title text
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_limit integer;
begin
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
      ale.id,
      ale.entry_type,
      ale.amount_minor,
      ale.currency,
      ale.gross_amount_minor,
      ale.librum_amount_minor,
      ale.royalty_rate_bps,
      ale.available_at,
      ale.created_at,
      b.id as book_id,
      b.title as book_title
    from public.author_ledger_entries ale
    left join public.purchases pu on pu.id = ale.purchase_id
    left join public.books b on b.id = pu.book_id
    where ale.author_id = auth.uid()
      and (
        p_cursor_created_at is null
        or (ale.created_at, ale.id) < (p_cursor_created_at, p_cursor_id)
      )
    order by ale.created_at desc, ale.id desc
    limit v_limit;
end;
$$;

revoke all on function public.list_author_financial_activity(integer, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.list_author_financial_activity(integer, timestamptz, uuid) to authenticated;

-- ============================================================
-- LIBRUM 2.0 LEDGER-1E-B (migration 051): the six payout-mutation
-- RPCs -- reserve/start/mark_reconciling/finalize/fail/cancel.
-- Every one is SECURITY DEFINER, search_path='', EXECUTE granted
-- ONLY to service_role (never PUBLIC/anon/authenticated -- not
-- even finance.view staff, which stays strictly read-only).
-- No payout provider, scheduler, or manual-payout capability
-- exists anywhere in this file. See that migration's own header
-- comment for the full state-machine/reservation design.
-- ============================================================

-- Part 5: reserve_author_payout() -- the one entry point that ever
-- creates a payout reservation.
--
-- Caller supplies ONLY author_id + currency (+ optional payout_run_id
-- for a future scheduler's own grouping) -- NEVER an amount (Section 11
-- of the task: "Caller must NOT supply payout amount"). The database
-- computes it, deterministically, from the canonical balance (Part 4)
-- minus every currently-active reservation for this exact
-- author+currency, compared against that exact currency's own
-- threshold row (Section 7's V1 rule: no settings row for this exact
-- currency means NOT eligible, full stop -- never a guessed default).
--
-- On success: reserves the FULL payoutable balance (Section 11's own
-- worked example -- threshold 50, payoutable 73, reserves 73, not 50),
-- inserts one 'pending' author_payouts row, returns exactly one row
-- (payout_id, amount_minor, currency).
--
-- On "not eligible" (no ledger balance in this currency at all; no
-- settings row for this exact currency; payoutable below threshold):
-- returns ZERO rows -- a deterministic, ordinary, expected outcome, NOT
-- an exception. A batch scheduler processing many authors will see this
-- constantly and should never need to catch an error for it.
--
-- On a genuine concurrent race (Part 3c's unique index rejects a second
-- simultaneous reservation attempt for the same author+currency): the
-- resulting unique_violation is caught and folded into the SAME "zero
-- rows returned" outcome -- from the caller's point of view, "another
-- process already reserved this author+currency" and "this author
-- isn't eligible right now" are both simply "nothing to do here,"
-- which is exactly the right uniform shape for a batch caller.
-- ============================================================

-- LEDGER-1E-D-B (migration 053): the canonical eligibility/payoutable-
-- amount calculation, extracted out of reserve_author_payout()'s own
-- previously-inline logic so dry_run_scheduled_payouts() (further down
-- this file) can never drift into a second formula. See migration
-- 053's own Part 1 comment for the full priority-order/active-
-- reservation reasoning.
create or replace function public.author_payout_eligibility(
  p_author_id uuid,
  p_currency text
)
returns table (
  author_id uuid,
  currency text,
  ledger_available_minor bigint,
  reserved_minor bigint,
  payoutable_minor bigint,
  threshold_configured boolean,
  threshold_minor bigint,
  active_reservation boolean,
  eligible boolean,
  ineligible_reason text
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_available bigint;
  v_threshold bigint;
  v_reserved bigint;
  v_payoutable bigint;
  v_active_reservation boolean;
begin
  select balance.available_minor into v_available
  from public.author_ledger_balance(p_author_id) balance
  where balance.currency = p_currency;

  select aps.threshold_minor into v_threshold
  from public.author_payout_settings aps
  where aps.author_id = p_author_id and aps.currency = p_currency;

  select coalesce(sum(ap.amount_minor), 0) into v_reserved
  from public.author_payouts ap
  where ap.author_id = p_author_id
    and ap.currency = p_currency
    and ap.status in ('pending', 'processing', 'reconciling');

  v_active_reservation := exists (
    select 1
    from public.author_payouts ap
    where ap.author_id = p_author_id
      and ap.currency = p_currency
      and ap.status in ('pending', 'processing', 'reconciling')
  );

  if v_available is null then
    v_payoutable := null;
  else
    v_payoutable := v_available - v_reserved;
  end if;

  author_id := p_author_id;
  currency := p_currency;
  ledger_available_minor := v_available;
  reserved_minor := v_reserved;
  payoutable_minor := v_payoutable;
  threshold_configured := v_threshold is not null;
  threshold_minor := v_threshold;
  active_reservation := v_active_reservation;

  if v_threshold is null then
    eligible := false;
    ineligible_reason := 'no_settings';
  elsif v_available is null then
    eligible := false;
    ineligible_reason := 'no_available_balance';
  elsif v_active_reservation then
    eligible := false;
    ineligible_reason := 'active_reservation';
  elsif v_payoutable < v_threshold then
    eligible := false;
    ineligible_reason := 'below_threshold';
  else
    eligible := true;
    ineligible_reason := null;
  end if;

  return next;
end;
$$;

revoke all on function public.author_payout_eligibility(uuid, text) from public, anon, authenticated;
grant execute on function public.author_payout_eligibility(uuid, text) to service_role;

create or replace function public.reserve_author_payout(
  p_author_id uuid,
  p_currency text,
  p_payout_run_id uuid default null
)
returns table (
  payout_id uuid,
  amount_minor bigint,
  currency text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_eligibility record;
  v_payout_id uuid;
  v_run_status text;
begin
  if p_payout_run_id is not null then
    -- Closed-run reservation barrier (LEDGER-1E-D-D.1): FOR SHARE
    -- conflicts with complete_scheduled_payout_run()'s own FOR UPDATE
    -- on the same payout_runs row, serializing the two operations.
    -- The lock is held for the remainder of this transaction, i.e.
    -- until this RPC call commits or rolls back.
    select pr.status into v_run_status
    from public.payout_runs pr
    where pr.id = p_payout_run_id
    for share;

    if not found then
      raise exception 'reserve_author_payout: payout run % does not exist', p_payout_run_id;
    end if;

    if v_run_status <> 'running' then
      -- Deterministic, silent no-op -- never mutates payout_runs,
      -- never reopens it, never raises for this specific case.
      return;
    end if;
  end if;

  select * into v_eligibility
  from public.author_payout_eligibility(p_author_id, p_currency);

  if not v_eligibility.eligible then
    return;
  end if;

  begin
    insert into public.author_payouts (author_id, amount_minor, currency, status, payout_run_id)
    values (p_author_id, v_eligibility.payoutable_minor, p_currency, 'pending', p_payout_run_id)
    returning id into v_payout_id;
  exception
    when unique_violation then
      -- LEDGER-1E-B.1: only the active-reservation index is treated as
      -- an expected losing concurrency race -- GET STACKED DIAGNOSTICS
      -- confirms which constraint actually fired; any OTHER uniqueness
      -- violation re-raises rather than being silently reinterpreted as
      -- "not eligible."
      declare
        v_constraint_name text;
      begin
        get stacked diagnostics v_constraint_name = constraint_name;
        if v_constraint_name = 'author_payouts_one_active_per_author_currency_idx' then
          return;
        else
          raise;
        end if;
      end;
  end;

  payout_id := v_payout_id;
  amount_minor := v_eligibility.payoutable_minor;
  currency := p_currency;
  return next;
end;
$$;

revoke all on function public.reserve_author_payout(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.reserve_author_payout(uuid, text, uuid) to service_role;

-- ============================================================
-- Part 6: start_author_payout() -- pending -> processing, WITH
-- REVALIDATION (Section 18 of the task).
--
-- This is the last DB-side checkpoint before a future provider call
-- would ever be made, and the moment amount/currency/author become
-- immutable (Part 3e's trigger takes effect the instant status leaves
-- 'pending'). Before transitioning, it recomputes the canonical balance
-- FRESH and confirms the reservation is still economically supportable
-- -- a refund or other debit may have posted since reserve_author_payout()
-- computed this amount.
--
-- If the reservation no longer fits: DO NOT resize it (Section 18's own
-- explicit instruction) -- cancel it outright (pending -> cancelled,
-- itself a legal transition) and return that as the deterministic
-- result. A future run's reserve_author_payout() call will compute a
-- fresh, correctly-sized reservation from the now-current balance. This
-- keeps "the reserved amount is always exactly what was true either at
-- reservation time or is now being explicitly re-decided" true, rather
-- than ever silently mutating a number this whole design otherwise
-- treats as sacred.
--
-- SELECT ... FOR UPDATE locks the specific payout row for the duration
-- of this check-then-transition, so a concurrent cancel_author_payout()
-- or a second start_author_payout() retry on the SAME row cannot race
-- with this one.
-- ============================================================

create or replace function public.start_author_payout(p_payout_id uuid)
returns table (
  payout_id uuid,
  status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payout record;
  v_available bigint;
  v_reserved_excluding_self bigint;
  v_payoutable bigint;
begin
  select * into v_payout
  from public.author_payouts
  where id = p_payout_id
  for update;

  if not found then
    raise exception 'start_author_payout: payout % not found', p_payout_id;
  end if;

  if v_payout.status <> 'pending' then
    raise exception
      'start_author_payout: payout % is not pending (current status %)',
      p_payout_id, v_payout.status;
  end if;

  select balance.available_minor into v_available
  from public.author_ledger_balance(v_payout.author_id) balance
  where balance.currency = v_payout.currency;

  select coalesce(sum(ap.amount_minor), 0) into v_reserved_excluding_self
  from public.author_payouts ap
  where ap.author_id = v_payout.author_id
    and ap.currency = v_payout.currency
    and ap.status in ('pending', 'processing', 'reconciling')
    and ap.id <> p_payout_id;

  v_payoutable := coalesce(v_available, 0) - v_reserved_excluding_self;

  if v_payoutable < v_payout.amount_minor then
    -- Table alias required: this function's own OUT parameter is also
    -- named "status" (RETURNS TABLE(payout_id uuid, status text)
    -- above), which otherwise makes a bare "status" reference in the
    -- WHERE clause ambiguous between the PL/pgSQL variable and the
    -- table column -- the same class of bug already fixed once this
    -- session in record_payment_event()'s ON CONFLICT target list.
    update public.author_payouts ap
    set status = 'cancelled'
    where ap.id = p_payout_id and ap.status = 'pending';

    payout_id := p_payout_id;
    status := 'cancelled';
    return next;
    return;
  end if;

  update public.author_payouts ap
  set status = 'processing', processing_at = now()
  where ap.id = p_payout_id and ap.status = 'pending';

  payout_id := p_payout_id;
  status := 'processing';
  return next;
end;
$$;

revoke all on function public.start_author_payout(uuid) from public, anon, authenticated;
grant execute on function public.start_author_payout(uuid) to service_role;

-- ============================================================
-- Part 7: mark_author_payout_reconciling() -- processing -> reconciling
-- only. No ledger movement whatsoever. Idempotent if already
-- reconciling (a retried "I don't know what happened" signal is a
-- safe no-op, not an error). See Part 3a's comment for why this state
-- exists at all: it exists precisely so a genuinely ambiguous provider
-- outcome is never conflated with either a confirmed success or a
-- confirmed failure.
-- ============================================================

create or replace function public.mark_author_payout_reconciling(p_payout_id uuid)
returns table (
  payout_id uuid,
  status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select ap.status into v_status
  from public.author_payouts ap
  where ap.id = p_payout_id
  for update;

  if not found then
    raise exception 'mark_author_payout_reconciling: payout % not found', p_payout_id;
  end if;

  if v_status = 'reconciling' then
    payout_id := p_payout_id;
    status := 'reconciling';
    return next;
    return;
  end if;

  if v_status <> 'processing' then
    raise exception
      'mark_author_payout_reconciling: payout % is not processing (current status %)',
      p_payout_id, v_status;
  end if;

  update public.author_payouts ap
  set status = 'reconciling'
  where ap.id = p_payout_id and ap.status = 'processing';

  payout_id := p_payout_id;
  status := 'reconciling';
  return next;
end;
$$;

revoke all on function public.mark_author_payout_reconciling(uuid) from public, anon, authenticated;
grant execute on function public.mark_author_payout_reconciling(uuid) to service_role;

-- ============================================================
-- Part 8: finalize_author_payout() -- processing/reconciling -> paid.
-- The ONE place a payout ledger debit is ever created.
--
-- Creates exactly one author_ledger_entries row (entry_type='payout',
-- amount_minor = -author_payouts.amount_minor, payout_id set) --
-- already backed by an EXISTING migration-048 invariant confirmed still
-- live: author_ledger_entries_one_entry_per_payout_idx, a partial
-- unique index on (payout_id) WHERE entry_type='payout'. A second
-- ledger debit for the same payout is structurally impossible even
-- before considering this function's own idempotency handling.
--
-- IDEMPOTENT RETRY (Section 24): called again for an already-'paid' row
-- with the SAME provider+provider_reference is a safe no-op, returning
-- the existing ledger entry id -- tolerates a webhook/API retry.
-- Called again with a DIFFERENT provider+provider_reference on an
-- already-'paid' row is treated as a financial anomaly and REJECTED
-- (raises) rather than silently overwritten -- that shape would mean
-- either a duplicate external send or data corruption, and either way
-- needs a human, not an automatic acceptance.
--
-- provider/provider_reference are both required (NOT NULL enforced in
-- the function body) -- a "success" with no way to correlate it back to
-- an external transfer is not a state this design accepts.
--
-- PAYOUT REVERSAL -- explicitly NOT built here (Section 29 of the
-- task). Confirmed: migration 048's author_ledger_entries.entry_type
-- CHECK still only permits ('sale', 'refund', 'adjustment', 'payout').
-- Before any real payout provider is ever enabled, a future migration
-- MUST add a payout_reversal entry_type (a positive compensating entry,
-- mirroring exactly how 'refund' was added alongside 'sale' in 048/049)
-- so a provider-returned/reversed transfer can be represented WITHOUT
-- ever mutating the original payout debit. This is a hard
-- pre-real-money requirement, flagged here, not implemented.
-- ============================================================

create or replace function public.finalize_author_payout(
  p_payout_id uuid,
  p_provider text,
  p_provider_reference text
)
returns table (
  payout_id uuid,
  status text,
  ledger_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payout record;
  v_ledger_id uuid;
begin
  -- LEDGER-1E-B.1: reject blank/whitespace-only inputs, not merely NULL.
  if p_provider is null or btrim(p_provider) = ''
    or p_provider_reference is null or btrim(p_provider_reference) = ''
  then
    raise exception 'finalize_author_payout: provider and provider_reference are both required and must not be blank';
  end if;

  select * into v_payout
  from public.author_payouts
  where id = p_payout_id
  for update;

  if not found then
    raise exception 'finalize_author_payout: payout % not found', p_payout_id;
  end if;

  if v_payout.status = 'paid' then
    if v_payout.provider = p_provider and v_payout.provider_reference = p_provider_reference then
      select ale.id into v_ledger_id
      from public.author_ledger_entries ale
      where ale.payout_id = p_payout_id and ale.entry_type = 'payout';

      payout_id := p_payout_id;
      status := 'paid';
      ledger_entry_id := v_ledger_id;
      return next;
      return;
    else
      raise exception
        'finalize_author_payout: payout % is already paid with a DIFFERENT provider reference (existing %/%, received %/%) -- refusing to overwrite; this requires operator investigation, not an automatic retry',
        p_payout_id, v_payout.provider, v_payout.provider_reference, p_provider, p_provider_reference;
    end if;
  end if;

  if v_payout.status not in ('processing', 'reconciling') then
    raise exception
      'finalize_author_payout: payout % is not processing/reconciling (current status %)',
      p_payout_id, v_payout.status;
  end if;

  insert into public.author_ledger_entries
    (author_id, payout_id, entry_type, amount_minor, currency, available_at, created_at)
  values
    (v_payout.author_id, p_payout_id, 'payout', -v_payout.amount_minor, v_payout.currency, now(), now())
  returning id into v_ledger_id;

  update public.author_payouts
  set status = 'paid',
      provider = p_provider,
      provider_reference = p_provider_reference,
      paid_at = now()
  where id = p_payout_id;

  payout_id := p_payout_id;
  status := 'paid';
  ledger_entry_id := v_ledger_id;
  return next;
end;
$$;

revoke all on function public.finalize_author_payout(uuid, text, text) from public, anon, authenticated;
grant execute on function public.finalize_author_payout(uuid, text, text) to service_role;

-- ============================================================
-- Part 9: fail_author_payout() -- processing/reconciling -> failed,
-- for a CONFIRMED provider failure only (never for an ambiguous/
-- timeout outcome -- that goes to mark_author_payout_reconciling()
-- instead, Part 7). No ledger debit is ever created. The reservation
-- releases automatically: 'failed' no longer matches
-- author_payouts_one_active_per_author_currency_idx's predicate
-- (Part 3c), so the amount becomes payoutable again the instant this
-- commits, with zero additional code needed. This function never
-- creates a new payout row itself -- a future run's own
-- reserve_author_payout() call is what may reserve again.
-- ============================================================

create or replace function public.fail_author_payout(
  p_payout_id uuid,
  p_failure_code text
)
returns table (
  payout_id uuid,
  status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select ap.status into v_status
  from public.author_payouts ap
  where ap.id = p_payout_id
  for update;

  if not found then
    raise exception 'fail_author_payout: payout % not found', p_payout_id;
  end if;

  if v_status not in ('processing', 'reconciling') then
    raise exception
      'fail_author_payout: payout % is not processing/reconciling (current status %)',
      p_payout_id, v_status;
  end if;

  update public.author_payouts
  set status = 'failed', failed_at = now(), failure_code = p_failure_code
  where id = p_payout_id;

  payout_id := p_payout_id;
  status := 'failed';
  return next;
end;
$$;

revoke all on function public.fail_author_payout(uuid, text) from public, anon, authenticated;
grant execute on function public.fail_author_payout(uuid, text) to service_role;

-- ============================================================
-- Part 10: cancel_author_payout() -- pending -> cancelled ONLY. Once
-- start_author_payout() has moved a row to 'processing', cancellation
-- through this function is refused -- a provider call may already be
-- in flight and there is no reliable way to un-send it (Section 26's
-- own V1 boundary). No ledger debit. Reservation releases the same way
-- fail_author_payout()'s does: 'cancelled' falls outside the active-
-- payout index's predicate automatically.
-- ============================================================

create or replace function public.cancel_author_payout(p_payout_id uuid)
returns table (
  payout_id uuid,
  status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select ap.status into v_status
  from public.author_payouts ap
  where ap.id = p_payout_id
  for update;

  if not found then
    raise exception 'cancel_author_payout: payout % not found', p_payout_id;
  end if;

  if v_status <> 'pending' then
    raise exception
      'cancel_author_payout: payout % is not pending (current status %)',
      p_payout_id, v_status;
  end if;

  update public.author_payouts ap
  set status = 'cancelled'
  where ap.id = p_payout_id and ap.status = 'pending';

  payout_id := p_payout_id;
  status := 'cancelled';
  return next;
end;
$$;

revoke all on function public.cancel_author_payout(uuid) from public, anon, authenticated;
grant execute on function public.cancel_author_payout(uuid) to service_role;

-- ============================================================
-- LIBRUM 2.0 LEDGER-1E-C (migration 052): author-facing payout
-- reporting + safe payout history read model. Reservation-aware
-- payoutability snapshot layered on top of author_ledger_balance()
-- (pure ledger truth, untouched) and author_payouts' own active-
-- reservation rows -- see that migration's own comments for the full
-- formula/reconciliation-invariant/currency-universe/threshold
-- reasoning. Neither function below is called by any Stripe checkout/
-- webhook/refund/dispute/payout-mutation code path, and no payout
-- mutation RPC is touched by anything here.
-- ============================================================

create or replace function public.get_author_payout_overview()
returns table (
  currency text,
  ledger_available_minor bigint,
  reserved_minor bigint,
  available_for_payout_minor bigint,
  threshold_configured boolean,
  threshold_minor bigint,
  threshold_reached boolean
)
language sql
security definer
set search_path = ''
stable
as $$
  with ledger as (
    select balance.currency, balance.available_minor
    from public.author_ledger_balance(auth.uid()) balance
  ),
  reservations as (
    select ap.currency, sum(ap.amount_minor)::bigint as reserved_minor
    from public.author_payouts ap
    where ap.author_id = auth.uid()
      and ap.status in ('pending', 'processing', 'reconciling')
    group by ap.currency
  ),
  settings as (
    select aps.currency, aps.threshold_minor
    from public.author_payout_settings aps
    where aps.author_id = auth.uid()
  ),
  payout_currencies as (
    select distinct ap.currency
    from public.author_payouts ap
    where ap.author_id = auth.uid()
  ),
  currencies as (
    select currency from ledger
    union
    select currency from settings
    union
    select currency from payout_currencies
  )
  select
    c.currency,
    coalesce(l.available_minor, 0)::bigint as ledger_available_minor,
    coalesce(r.reserved_minor, 0)::bigint as reserved_minor,
    (coalesce(l.available_minor, 0) - coalesce(r.reserved_minor, 0))::bigint as available_for_payout_minor,
    (s.threshold_minor is not null) as threshold_configured,
    s.threshold_minor as threshold_minor,
    (
      s.threshold_minor is not null
      and (coalesce(l.available_minor, 0) - coalesce(r.reserved_minor, 0)) >= s.threshold_minor
    ) as threshold_reached
  from currencies c
  left join ledger l on l.currency = c.currency
  left join reservations r on r.currency = c.currency
  left join settings s on s.currency = c.currency
  order by c.currency;
$$;

revoke all on function public.get_author_payout_overview() from public, anon, authenticated;
grant execute on function public.get_author_payout_overview() to authenticated;

create or replace function public.list_author_payout_history(
  p_limit integer default 25,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
)
returns table (
  id uuid,
  amount_minor bigint,
  currency text,
  status text,
  created_at timestamptz,
  processing_at timestamptz,
  paid_at timestamptz,
  failed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_limit integer;
begin
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
      ap.id,
      ap.amount_minor,
      ap.currency,
      ap.status,
      ap.created_at,
      ap.processing_at,
      ap.paid_at,
      ap.failed_at
    from public.author_payouts ap
    where ap.author_id = auth.uid()
      and (
        p_cursor_created_at is null
        or (ap.created_at, ap.id) < (p_cursor_created_at, p_cursor_id)
      )
    order by ap.created_at desc, ap.id desc
    limit v_limit;
end;
$$;

revoke all on function public.list_author_payout_history(integer, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.list_author_payout_history(integer, timestamptz, uuid) to authenticated;

-- ============================================================
-- LIBRUM 2.0 LEDGER-1E-D-B (migration 053): payout scheduler database
-- foundation -- pure dry-run preview and idempotent scheduled-run
-- create/complete, both built on author_payout_eligibility() above.
-- No scheduler HTTP route, no cron configuration, no feature switch,
-- no provider, and no real payout execution exist anywhere here.
-- ============================================================

create or replace function public.dry_run_scheduled_payouts()
returns table (
  author_id uuid,
  currency text,
  ledger_available_minor bigint,
  reserved_minor bigint,
  payoutable_minor bigint,
  threshold_configured boolean,
  threshold_minor bigint,
  active_reservation boolean,
  eligible boolean,
  ineligible_reason text
)
language sql
security definer
set search_path = ''
stable
as $$
  select e.*
  from public.author_payout_settings aps
  cross join lateral public.author_payout_eligibility(aps.author_id, aps.currency) e;
$$;

revoke all on function public.dry_run_scheduled_payouts() from public, anon, authenticated;
grant execute on function public.dry_run_scheduled_payouts() to service_role;

create or replace function public.start_scheduled_payout_run(
  p_target_month date
)
returns table (
  payout_run_id uuid,
  payout_run_key text,
  payout_run_scheduled_for date,
  payout_run_status text,
  payout_run_started_at timestamptz,
  payout_run_completed_at timestamptz,
  is_new boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_key text;
  v_current_month_start date;
  v_inserted_id uuid;
  v_existing public.payout_runs%rowtype;
begin
  if p_target_month is null then
    raise exception 'start_scheduled_payout_run: p_target_month is required';
  end if;

  if p_target_month <> date_trunc('month', p_target_month)::date then
    raise exception
      'start_scheduled_payout_run: p_target_month must be the first day of a month, got %',
      p_target_month;
  end if;

  v_current_month_start := date_trunc('month', (now() at time zone 'Europe/Tirane'))::date;
  if p_target_month > v_current_month_start then
    raise exception
      'start_scheduled_payout_run: p_target_month % is in the future (current Europe/Tirane month is %)',
      p_target_month, v_current_month_start;
  end if;

  v_run_key := 'monthly:' || to_char(p_target_month, 'YYYY-MM');

  insert into public.payout_runs (run_type, run_key, scheduled_for, status, started_at)
  values ('scheduled', v_run_key, p_target_month, 'running', now())
  on conflict (run_type, run_key) where run_key is not null do nothing
  returning payout_runs.id into v_inserted_id;

  select pr.* into v_existing
  from public.payout_runs pr
  where pr.run_type = 'scheduled' and pr.run_key = v_run_key;

  if v_existing.status = 'failed' then
    raise exception
      'start_scheduled_payout_run: scheduled payout run % (target month %) is failed and requires explicit recovery',
      v_run_key, p_target_month;
  end if;

  payout_run_id := v_existing.id;
  payout_run_key := v_existing.run_key;
  payout_run_scheduled_for := v_existing.scheduled_for;
  payout_run_status := v_existing.status;
  payout_run_started_at := v_existing.started_at;
  payout_run_completed_at := v_existing.completed_at;
  is_new := (v_inserted_id is not null);
  return next;
end;
$$;

revoke all on function public.start_scheduled_payout_run(date) from public, anon, authenticated;
grant execute on function public.start_scheduled_payout_run(date) to service_role;

create or replace function public.complete_scheduled_payout_run(
  p_run_id uuid
)
returns table (
  payout_run_id uuid,
  payout_run_key text,
  payout_run_status text,
  payout_run_completed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.payout_runs%rowtype;
begin
  select pr.* into v_existing
  from public.payout_runs pr
  where pr.id = p_run_id
  for update;

  if not found then
    raise exception 'complete_scheduled_payout_run: run % not found', p_run_id;
  end if;

  if v_existing.status = 'completed' then
    payout_run_id := v_existing.id;
    payout_run_key := v_existing.run_key;
    payout_run_status := v_existing.status;
    payout_run_completed_at := v_existing.completed_at;
    return next;
    return;
  end if;

  if v_existing.status <> 'running' then
    raise exception
      'complete_scheduled_payout_run: run % is not running (current status %)',
      p_run_id, v_existing.status;
  end if;

  update public.payout_runs as pr
  set status = 'completed', completed_at = now()
  where pr.id = p_run_id
  returning pr.id, pr.run_key, pr.status, pr.completed_at
  into payout_run_id, payout_run_key, payout_run_status, payout_run_completed_at;

  return next;
end;
$$;

revoke all on function public.complete_scheduled_payout_run(uuid) from public, anon, authenticated;
grant execute on function public.complete_scheduled_payout_run(uuid) to service_role;

-- ============================================================
-- LIBRUM 2.0 BANK-PAYOUT-1C: manual-bank V1 financial foundation.
--
-- Database-foundation only -- no author form, no admin UI, no CSV
-- download UI, no bank adapter, no bank contact, no minimum-threshold
-- value, no scheduler enablement, no real money movement anywhere in
-- this file. Migrations 048-054 are already LIVE production history
-- and are NOT modified in any way except the two narrowly-scoped
-- CREATE OR REPLACE edits explicitly justified in Parts 6 and 7 below
-- (author_payout_eligibility's body, start_author_payout's body) --
-- their external signatures/RETURNS TABLE shapes are preserved
-- unchanged. reserve_author_payout(), mark_author_payout_reconciling(),
-- cancel_author_payout(), start_scheduled_payout_run(),
-- complete_scheduled_payout_run(), dry_run_scheduled_payouts() are all
-- completely untouched -- ZERO duplicate lifecycle RPCs are created
-- here.
--
-- This migration is the implementation of the design approved across
-- BANK-PAYOUT-1A / 1A.1 / 1B / 1B.1. Every design decision below cites
-- back to the specific corrected reasoning from that review chain
-- rather than re-deriving it.
--
-- New objects: payout_minimum_policy, author_payout_destinations,
-- payout_destination_snapshots, payout_reversal; a new
-- author_ledger_entries entry_type ('payout_reversal'); two new staff
-- permissions (finance.payout_export, finance.payout_operate); four
-- new RPCs (set_author_payout_threshold, set_author_payout_destination,
-- record_payout_reversal, list_payout_batch_export); and CREATE OR
-- REPLACE on six existing functions (author_payout_eligibility,
-- get_author_payout_overview, start_author_payout,
-- finalize_author_payout, author_ledger_balance,
-- list_author_payout_history, staff_has_permission) -- every one named
-- explicitly, no silent omission.
-- ============================================================

-- ============================================================
-- Part 1: payout_minimum_policy -- provider/bank-neutral minimum
-- threshold policy, per currency. Platform financial policy, not an
-- author preference (BANK-PAYOUT-1B Section 15/18; BANK-PAYOUT-1B.1
-- Correction 2 confirms the eligibility-time design this table feeds).
--
-- NO ROW IS INSERTED BY THIS MIGRATION. No minimum value -- 25, 50, or
-- any other number -- is invented here. The first real policy row is
-- populated later, through a separate, explicit, reviewed
-- administrative operation, once real bank/provider economics are
-- known. Until that happens, author_payout_eligibility() (Part 6) and
-- set_author_payout_threshold() (Part 12) both fail closed for every
-- currency -- see those parts for the exact mechanism.
-- ============================================================

create table public.payout_minimum_policy (
  currency text primary key check (currency ~ '^[A-Z]{3}$'),
  minimum_threshold_minor bigint not null check (minimum_threshold_minor > 0),
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.payout_minimum_policy enable row level security;

-- This is platform financial policy, not author data -- no author-own
-- read policy exists or is needed. anon/authenticated get no direct
-- access of any kind (not even SELECT): the currently-active minimum
-- is exposed to authors only indirectly, through
-- get_author_payout_overview()'s own safe, derived fields (Part 8),
-- never as a raw table read. service_role's own default DML is
-- revoked too -- the only legitimate mutation path in this phase is a
-- future, separate, explicitly-reviewed administrative operation
-- (Section 18's own instruction: "no policy-editing UI/API in this
-- phase"), and even that is deliberately not built here. The
-- SECURITY DEFINER RPCs that need to READ this table
-- (author_payout_eligibility, get_author_payout_overview,
-- set_author_payout_threshold) run as their OWNER regardless of the
-- calling role's own table grants, so revoking SELECT from every
-- ordinary role does not break them.
revoke all on public.payout_minimum_policy from anon, authenticated, service_role;

-- ============================================================
-- Part 2: author_payout_destinations -- live, author-editable payout
-- destination preference. (author_id, currency) identity, mirroring
-- author_payout_settings' own composite-PK precedent exactly
-- (BANK-PAYOUT-1B.1 Section 5's locked decision).
--
-- Deliberately excluded (BANK-PAYOUT-1A.1 Section 5/BANK-PAYOUT-1C
-- Section 9): bank-login data, provider credentials, card data, KYC
-- documents, a free-text bank-name field (derivable from the IBAN's
-- own bank-code segment if ever needed for display), and BIC (not
-- required for Albanian domestic ALL transfers or for SEPA EUR
-- transfers under the EU's IBAN-only rule; add only if a real future
-- adapter proves otherwise).
-- ============================================================

create table public.author_payout_destinations (
  author_id uuid not null references public.profiles(id) on delete cascade,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  beneficiary_name text not null check (btrim(beneficiary_name) <> ''),
  iban text not null check (btrim(iban) <> ''),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (author_id, currency)
);

alter table public.author_payout_destinations enable row level security;

-- Author-own SELECT only -- mirrors author_payout_settings' own exact
-- posture. No finance.view policy here at all (BANK-PAYOUT-1A.1
-- Section D/1C Section 10): full bank-destination data must never
-- become visible through the broad, already-existing finance.view
-- permission. Full IBAN visibility for staff is exclusively through
-- the narrowly-gated list_payout_batch_export() RPC (Part 13), which
-- checks finance.payout_export internally.
revoke all on public.author_payout_destinations from anon, authenticated, service_role;
grant select on public.author_payout_destinations to authenticated;

create policy "Authors can view their own payout destination"
  on public.author_payout_destinations for select
  using (auth.uid() = author_id);

-- Writes occur exclusively through set_author_payout_destination()
-- (Part 11), a SECURITY DEFINER RPC scoped by auth.uid() with no
-- author_id parameter. No INSERT/UPDATE/DELETE policy exists for any
-- role, and service_role's own default DML is revoked above too
-- (1A.1's own correction to the author_payout_settings gap): even the
-- internal scheduler process cannot bypass this table's one write
-- path via raw table access.

-- ============================================================
-- Part 3: payout_destination_snapshots -- immutable, per-payout,
-- frozen-at-handoff facts. A dedicated table, not columns on
-- author_payouts (BANK-PAYOUT-1A.1 Section D/E's own privacy
-- correction): author_payouts already carries a "Staff with
-- finance.view can view all payouts" SELECT * policy, so placing raw
-- IBAN/beneficiary data there would silently hand it to every
-- finance.view staff member. Keeping it in its own table, with no
-- finance.view policy at all, closes that off completely.
--
-- payment_reference is a genuinely persisted, uniquely-constrained
-- column (BANK-PAYOUT-1B.1 Correction 2/2b) -- generated exactly once
-- inside start_author_payout() (Part 7) and never recomputed. A
-- truncated hash is not "unique by construction"; the UNIQUE
-- constraint below is what actually guarantees it, and the generation
-- ALGORITHM itself lives entirely in start_author_payout()'s own body,
-- free to change later (e.g. once a real bank's field-length limit is
-- known) with zero migration/table-shape change required.
-- ============================================================

create table public.payout_destination_snapshots (
  payout_id uuid primary key references public.author_payouts(id) on delete restrict,
  beneficiary_name text not null,
  iban text not null,
  currency text not null,
  payment_reference text not null,
  created_at timestamptz not null default now(),

  constraint payout_destination_snapshots_payment_reference_key unique (payment_reference)
);

alter table public.payout_destination_snapshots enable row level security;

-- No finance.view policy, no author-own policy -- access is
-- exclusively through the narrowly-gated list_payout_batch_export()
-- RPC (Part 13) and the trusted service_role payout-lifecycle
-- functions (start_author_payout, finalize_author_payout) that read
-- it internally. service_role's own default DML is revoked below too
-- -- the only legitimate INSERT path is the one inside
-- start_author_payout() itself.
revoke all on public.payout_destination_snapshots from anon, authenticated, service_role;

-- ------------------------------------------------------------
-- Part 3a: explicit immutability enforcement (BANK-PAYOUT-1C Section
-- 13's own mandatory correction over BANK-PAYOUT-1A.1's original
-- "absent UPDATE/DELETE grant is enough" design) -- a trigger that
-- unconditionally rejects UPDATE and DELETE on this table, so
-- immutability is a real database invariant rather than merely an
-- absence of a grant a future migration could accidentally add back.
-- ------------------------------------------------------------

create or replace function public.reject_payout_destination_snapshot_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'payout_destination_snapshots: rows are immutable once inserted (payout %, attempted %)',
    coalesce(old.payout_id, new.payout_id), tg_op;
end;
$$;

create trigger payout_destination_snapshots_reject_update
  before update on public.payout_destination_snapshots
  for each row
  execute function public.reject_payout_destination_snapshot_mutation();

create trigger payout_destination_snapshots_reject_delete
  before delete on public.payout_destination_snapshots
  for each row
  execute function public.reject_payout_destination_snapshot_mutation();

-- ============================================================
-- Part 4: payout_reversal -- the immutable primitive that finally
-- unblocks real external payout execution (BANK-PAYOUT-1A Section D /
-- BANK-PAYOUT-1B.1 Correction 3 for the exact V1 economic rule).
--
-- amount_minor/currency/provider are NOT caller-supplied anywhere
-- (record_payout_reversal, Part 5, derives all three internally from
-- the original author_payouts row) -- "reversal amount MUST equal the
-- original payout amount" is therefore true by construction, not by a
-- validation rule a caller could get wrong. The CHECK/trigger below is
-- still added as defense-in-depth, matching this codebase's own
-- established belt-and-suspenders pattern (e.g.
-- author_payouts_paid_requires_provider_and_reference).
--
-- One reversal per payout in V1 (BANK-PAYOUT-1B.1 Section 4's locked
-- rule) -- no partial reversals, no multiple reversals. A bank/return
-- fee is a Librum operating expense, never charged to the author's own
-- ledger (BANK-PAYOUT-1B.1 Correction 3's own reasoning) -- this
-- structurally cannot happen here since the amount is never a caller
-- input to begin with.
-- ============================================================

create table public.payout_reversal (
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null references public.author_payouts(id) on delete restrict,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  provider text not null check (btrim(provider) <> ''),
  provider_reference text not null check (btrim(provider_reference) <> ''),
  reason text,
  reversed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  constraint payout_reversal_one_per_payout unique (payout_id),
  constraint payout_reversal_provider_reference_key unique (provider, provider_reference)
);

alter table public.payout_reversal enable row level security;

-- Same posture as author_payouts itself: authenticated gets SELECT
-- only (no policy is added here granting anyone read access beyond
-- what a later, separate task might add for finance reporting -- this
-- migration does not expose reversal rows to any role, matching the
-- "no author/client write access" requirement and keeping this
-- strictly a service_role-mutated, currently server-only-readable
-- table). service_role's own default DML is revoked -- the only
-- legitimate mutation path is record_payout_reversal() (Part 5).
revoke all on public.payout_reversal from anon, authenticated, service_role;

-- ------------------------------------------------------------
-- Part 4a: cross-table defense-in-depth -- the referenced payout must
-- be 'paid', and the reversal's own amount/currency must match it
-- exactly. Enforced via trigger (a plain CHECK constraint cannot
-- reference another table in Postgres).
-- ------------------------------------------------------------

create or replace function public.enforce_payout_reversal_matches_original()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_payout record;
begin
  select ap.status, ap.amount_minor, ap.currency into v_payout
  from public.author_payouts ap
  where ap.id = new.payout_id;

  if not found then
    raise exception 'payout_reversal: payout % not found', new.payout_id;
  end if;

  if v_payout.status <> 'paid' then
    raise exception
      'payout_reversal: payout % is not paid (current status %) -- only a paid payout may be reversed',
      new.payout_id, v_payout.status;
  end if;

  if new.amount_minor <> v_payout.amount_minor then
    raise exception
      'payout_reversal: amount % does not match original payout amount % (payout %) -- V1 permits only a full reversal',
      new.amount_minor, v_payout.amount_minor, new.payout_id;
  end if;

  if new.currency <> v_payout.currency then
    raise exception
      'payout_reversal: currency % does not match original payout currency % (payout %)',
      new.currency, v_payout.currency, new.payout_id;
  end if;

  return new;
end;
$$;

create trigger payout_reversal_enforce_matches_original
  before insert on public.payout_reversal
  for each row
  execute function public.enforce_payout_reversal_matches_original();

-- ============================================================
-- Part 5: author_ledger_entries -- admit the new 'payout_reversal'
-- entry type (BANK-PAYOUT-1B Section 5/1B.1 Section 12; migration 048
-- itself is NOT touched, all changes are additive here).
--
-- Sign: positive (a compensating credit, mirroring exactly how
-- 'refund' was added alongside 'sale' -- never overloading
-- 'adjustment'). payout_id is required for this entry type (a
-- reversal without a referenced payout is meaningless), and exactly
-- one 'payout_reversal' ledger credit is permitted per payout_id,
-- mirroring author_ledger_entries_one_entry_per_payout_idx's own exact
-- existing shape for 'payout' entries.
-- ============================================================

alter table public.author_ledger_entries
  drop constraint author_ledger_entries_entry_type_check;

alter table public.author_ledger_entries
  add constraint author_ledger_entries_entry_type_check
  check (entry_type = any (array['sale', 'refund', 'adjustment', 'payout', 'payout_reversal']));

alter table public.author_ledger_entries
  add constraint author_ledger_entries_payout_reversal_amount_positive
  check (entry_type <> 'payout_reversal' or amount_minor > 0);

alter table public.author_ledger_entries
  add constraint author_ledger_entries_payout_reversal_requires_payout_id
  check (entry_type <> 'payout_reversal' or payout_id is not null);

create unique index author_ledger_entries_one_reversal_per_payout_idx
  on public.author_ledger_entries (payout_id)
  where entry_type = 'payout_reversal';

-- ============================================================
-- Part 6: record_payout_reversal() -- the one entry point that ever
-- creates a payout_reversal row. Correctness-by-construction contract
-- (BANK-PAYOUT-1C Section 4's own mandatory correction): the caller
-- supplies ONLY p_payout_id, p_reversal_reference, p_reason -- never
-- amount, never currency, never provider. All three are derived from
-- the original author_payouts row, because a reversal is a reversal OF
-- that payout, and a different administrative notification channel is
-- not a different payout provider (Section 4's own rationale, accepted
-- as-is -- no existing constraint made deriving provider unsafe, so no
-- substitute contract was needed).
--
-- Idempotency mirrors finalize_author_payout()'s own already-
-- established pattern exactly (BANK-PAYOUT-1B.1 Correction 2d): an
-- identical retry (same payout_id, same reversal reference) is a safe
-- no-op returning the existing row; a different reference on an
-- already-reversed payout is rejected, requiring a human.
-- ============================================================

create or replace function public.record_payout_reversal(
  p_payout_id uuid,
  p_reversal_reference text,
  p_reason text default null
)
returns table (
  reversal_id uuid,
  payout_id uuid,
  amount_minor bigint,
  currency text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payout record;
  v_existing record;
  v_reversal_id uuid;
begin
  if p_reversal_reference is null or btrim(p_reversal_reference) = '' then
    raise exception 'record_payout_reversal: p_reversal_reference is required and must not be blank';
  end if;

  select * into v_payout
  from public.author_payouts
  where id = p_payout_id
  for update;

  if not found then
    raise exception 'record_payout_reversal: payout % not found', p_payout_id;
  end if;

  -- Table alias required: this function's own OUT parameter is also
  -- named "payout_id" (RETURNS TABLE above), which otherwise makes a
  -- bare "payout_id" reference in the WHERE clause ambiguous -- the
  -- same class of bug already documented and fixed elsewhere in this
  -- schema (start_author_payout's own comment).
  select * into v_existing
  from public.payout_reversal pr
  where pr.payout_id = p_payout_id;

  if found then
    if v_existing.provider = 'manual_bank' and v_existing.provider_reference = p_reversal_reference then
      reversal_id := v_existing.id;
      payout_id := p_payout_id;
      amount_minor := v_existing.amount_minor;
      currency := v_existing.currency;
      return next;
      return;
    else
      raise exception
        'record_payout_reversal: payout % is already reversed with a DIFFERENT reference (existing %, received %) -- refusing to overwrite; this requires operator investigation, not an automatic retry',
        p_payout_id, v_existing.provider_reference, p_reversal_reference;
    end if;
  end if;

  if v_payout.status <> 'paid' then
    raise exception
      'record_payout_reversal: payout % is not paid (current status %) -- only a paid payout may be reversed',
      p_payout_id, v_payout.status;
  end if;

  -- provider is derived, not caller-supplied (Section 4): the payout's
  -- own provider is the natural, always-safe choice for V1, where
  -- 'manual_bank' is the only provider that exists.
  insert into public.payout_reversal
    (payout_id, amount_minor, currency, provider, provider_reference, reason)
  values
    (p_payout_id, v_payout.amount_minor, v_payout.currency, v_payout.provider, p_reversal_reference, p_reason)
  returning id into v_reversal_id;

  insert into public.author_ledger_entries
    (author_id, payout_id, entry_type, amount_minor, currency, available_at, created_at)
  values
    (v_payout.author_id, p_payout_id, 'payout_reversal', v_payout.amount_minor, v_payout.currency, now(), now());

  reversal_id := v_reversal_id;
  payout_id := p_payout_id;
  amount_minor := v_payout.amount_minor;
  currency := v_payout.currency;
  return next;
end;
$$;

revoke all on function public.record_payout_reversal(uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_payout_reversal(uuid, text, text) to service_role;

-- ============================================================
-- Part 7: author_payout_eligibility() -- CREATE OR REPLACE, RETURNS
-- TABLE signature preserved EXACTLY (BANK-PAYOUT-1C Section 21's own
-- mandatory correction over BANK-PAYOUT-1B.1's original plan to widen
-- it). The scheduler/reservation callers need the decision, not
-- UI-explanation fields -- those are added to
-- get_author_payout_overview() instead (Part 8). Preserving the exact
-- signature avoids a DROP/recreate and any dependency risk on the two
-- existing callers (dry_run_scheduled_payouts, reserve_author_payout),
-- neither of which is touched by this migration.
--
-- Body changes (BANK-PAYOUT-1B.1 Correction 1's locked priority
-- order): no_settings -> no_minimum_policy -> no_available_balance ->
-- active_reservation -> below_threshold (against the EFFECTIVE
-- threshold, greatest(stored, current minimum)) -> no_destination ->
-- eligible. The greatest() computation only ever runs after
-- v_threshold is already confirmed non-null (Correction 1's own
-- NULL-safety note) -- an author who never configured a threshold is
-- never treated as having implicitly opted in at the policy minimum.
-- ============================================================

create or replace function public.author_payout_eligibility(
  p_author_id uuid,
  p_currency text
)
returns table (
  author_id uuid,
  currency text,
  ledger_available_minor bigint,
  reserved_minor bigint,
  payoutable_minor bigint,
  threshold_configured boolean,
  threshold_minor bigint,
  active_reservation boolean,
  eligible boolean,
  ineligible_reason text
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_available bigint;
  v_threshold bigint;
  v_minimum_policy bigint;
  v_effective_threshold bigint;
  v_reserved bigint;
  v_payoutable bigint;
  v_active_reservation boolean;
  v_has_destination boolean;
begin
  select balance.available_minor into v_available
  from public.author_ledger_balance(p_author_id) balance
  where balance.currency = p_currency;

  select aps.threshold_minor into v_threshold
  from public.author_payout_settings aps
  where aps.author_id = p_author_id and aps.currency = p_currency;

  select pmp.minimum_threshold_minor into v_minimum_policy
  from public.payout_minimum_policy pmp
  where pmp.currency = p_currency and pmp.is_active = true;

  select coalesce(sum(ap.amount_minor), 0) into v_reserved
  from public.author_payouts ap
  where ap.author_id = p_author_id
    and ap.currency = p_currency
    and ap.status in ('pending', 'processing', 'reconciling');

  v_active_reservation := exists (
    select 1
    from public.author_payouts ap
    where ap.author_id = p_author_id
      and ap.currency = p_currency
      and ap.status in ('pending', 'processing', 'reconciling')
  );

  v_has_destination := exists (
    select 1
    from public.author_payout_destinations apd
    where apd.author_id = p_author_id and apd.currency = p_currency
  );

  if v_available is null then
    v_payoutable := null;
  else
    v_payoutable := v_available - v_reserved;
  end if;

  author_id := p_author_id;
  currency := p_currency;
  ledger_available_minor := v_available;
  reserved_minor := v_reserved;
  payoutable_minor := v_payoutable;
  threshold_configured := v_threshold is not null;
  threshold_minor := v_threshold;
  active_reservation := v_active_reservation;

  if v_threshold is null then
    eligible := false;
    ineligible_reason := 'no_settings';
  elsif v_minimum_policy is null then
    eligible := false;
    ineligible_reason := 'no_minimum_policy';
  else
    -- Both operands are non-null here (Correction 1's own NULL-safety
    -- requirement) -- safe to compute the effective threshold now.
    v_effective_threshold := greatest(v_threshold, v_minimum_policy);

    if v_available is null then
      eligible := false;
      ineligible_reason := 'no_available_balance';
    elsif v_active_reservation then
      eligible := false;
      ineligible_reason := 'active_reservation';
    elsif v_payoutable < v_effective_threshold then
      eligible := false;
      ineligible_reason := 'below_threshold';
    elsif not v_has_destination then
      eligible := false;
      ineligible_reason := 'no_destination';
    else
      eligible := true;
      ineligible_reason := null;
    end if;
  end if;

  return next;
end;
$$;

revoke all on function public.author_payout_eligibility(uuid, text) from public, anon, authenticated;
grant execute on function public.author_payout_eligibility(uuid, text) to service_role;

-- ============================================================
-- Part 8: get_author_payout_overview() -- CREATE OR REPLACE. Adds safe,
-- policy-aware fields so the author-facing dashboard can never claim
-- "threshold reached" using only the raw stored threshold when the
-- active platform minimum is higher (BANK-PAYOUT-1B.1 Correction 1's
-- own dashboard-implication finding; BANK-PAYOUT-1C Section 22).
--
-- No bank details, no fabricated minimum: minimum_policy_configured is
-- false and effective_threshold_minor/destination_configured are
-- honestly null/false whenever no active policy exists for that
-- currency -- exactly mirroring author_payout_eligibility()'s own
-- fail-closed semantics, never inventing a number.
--
-- Unlike author_payout_eligibility() (Part 7), this function's own
-- RETURNS TABLE shape DOES change (three new output columns) -- an
-- explicit DROP is required first, since CREATE OR REPLACE cannot
-- widen a function's OUT-parameter shape in Postgres.
-- ============================================================

drop function if exists public.get_author_payout_overview();

create or replace function public.get_author_payout_overview()
returns table (
  currency text,
  ledger_available_minor bigint,
  reserved_minor bigint,
  available_for_payout_minor bigint,
  threshold_configured boolean,
  threshold_minor bigint,
  threshold_reached boolean,
  minimum_policy_configured boolean,
  effective_threshold_minor bigint,
  destination_configured boolean
)
language sql
security definer
set search_path = ''
stable
as $$
  with ledger as (
    select balance.currency, balance.available_minor
    from public.author_ledger_balance(auth.uid()) balance
  ),
  reservations as (
    select ap.currency, sum(ap.amount_minor)::bigint as reserved_minor
    from public.author_payouts ap
    where ap.author_id = auth.uid()
      and ap.status in ('pending', 'processing', 'reconciling')
    group by ap.currency
  ),
  settings as (
    select aps.currency, aps.threshold_minor
    from public.author_payout_settings aps
    where aps.author_id = auth.uid()
  ),
  policy as (
    select pmp.currency, pmp.minimum_threshold_minor
    from public.payout_minimum_policy pmp
    where pmp.is_active = true
  ),
  destinations as (
    select apd.currency
    from public.author_payout_destinations apd
    where apd.author_id = auth.uid()
  ),
  payout_currencies as (
    select distinct ap.currency
    from public.author_payouts ap
    where ap.author_id = auth.uid()
  ),
  currencies as (
    select currency from ledger
    union
    select currency from settings
    union
    select currency from payout_currencies
  )
  select
    c.currency,
    coalesce(l.available_minor, 0)::bigint as ledger_available_minor,
    coalesce(r.reserved_minor, 0)::bigint as reserved_minor,
    (coalesce(l.available_minor, 0) - coalesce(r.reserved_minor, 0))::bigint as available_for_payout_minor,
    (s.threshold_minor is not null) as threshold_configured,
    s.threshold_minor as threshold_minor,
    (
      s.threshold_minor is not null
      and p.minimum_threshold_minor is not null
      and (coalesce(l.available_minor, 0) - coalesce(r.reserved_minor, 0))
        >= greatest(s.threshold_minor, p.minimum_threshold_minor)
    ) as threshold_reached,
    (p.minimum_threshold_minor is not null) as minimum_policy_configured,
    case
      when s.threshold_minor is not null and p.minimum_threshold_minor is not null
        then greatest(s.threshold_minor, p.minimum_threshold_minor)
      else null
    end as effective_threshold_minor,
    (d.currency is not null) as destination_configured
  from currencies c
  left join ledger l on l.currency = c.currency
  left join reservations r on r.currency = c.currency
  left join settings s on s.currency = c.currency
  left join policy p on p.currency = c.currency
  left join destinations d on d.currency = c.currency
  order by c.currency;
$$;

revoke all on function public.get_author_payout_overview() from public, anon, authenticated;
grant execute on function public.get_author_payout_overview() to authenticated;

-- ============================================================
-- Part 9: author_ledger_balance() -- CREATE OR REPLACE. The only
-- change is paid_out_minor's own filter, extended from entry_type =
-- 'payout' to entry_type in ('payout', 'payout_reversal') (BANK-
-- PAYOUT-1B Section E/1B.1's own worked-example confirmation). Because
-- 'payout' entries are negative and 'payout_reversal' entries are
-- positive, this single change turns paid_out_minor into the correct
-- NET figure -- a full reversal nets exactly back to zero. Every other
-- column (current_balance_minor, available_minor, net_earnings_minor,
-- pending_minor, lifetime_*) is untouched: they are already either
-- entry-type-agnostic sums (automatically absorbing the new type) or
-- explicitly filtered to a set that correctly excludes it.
-- ============================================================

create or replace function public.author_ledger_balance(p_author_id uuid)
returns table (
  currency text,
  lifetime_sale_minor bigint,
  lifetime_refund_minor bigint,
  lifetime_adjustment_minor bigint,
  net_earnings_minor bigint,
  paid_out_minor bigint,
  pending_minor bigint,
  available_minor bigint,
  current_balance_minor bigint
)
language sql
security definer
set search_path = ''
stable
as $$
  with entries as (
    select
      ale.currency,
      ale.entry_type,
      ale.amount_minor,
      case
        when ale.entry_type = 'sale' then ale.available_at
        when ale.entry_type = 'refund' then coalesce(
          (
            select sib.available_at
            from public.author_ledger_entries sib
            where sib.purchase_id = ale.purchase_id and sib.entry_type = 'sale'
            limit 1
          ),
          ale.available_at
        )
        else coalesce(ale.available_at, ale.created_at)
      end as effective_available_at
    from public.author_ledger_entries ale
    where ale.author_id = p_author_id
  )
  select
    currency,
    coalesce(sum(amount_minor) filter (where entry_type = 'sale'), 0)::bigint as lifetime_sale_minor,
    coalesce(-sum(amount_minor) filter (where entry_type = 'refund'), 0)::bigint as lifetime_refund_minor,
    coalesce(sum(amount_minor) filter (where entry_type = 'adjustment'), 0)::bigint as lifetime_adjustment_minor,
    coalesce(sum(amount_minor) filter (where entry_type in ('sale', 'refund', 'adjustment')), 0)::bigint as net_earnings_minor,
    coalesce(-sum(amount_minor) filter (where entry_type in ('payout', 'payout_reversal')), 0)::bigint as paid_out_minor,
    coalesce(sum(amount_minor) filter (where effective_available_at > now()), 0)::bigint as pending_minor,
    (
      coalesce(sum(amount_minor), 0)
      - coalesce(sum(amount_minor) filter (where effective_available_at > now()), 0)
    )::bigint as available_minor,
    coalesce(sum(amount_minor), 0)::bigint as current_balance_minor
  from entries
  group by currency;
$$;

revoke all on function public.author_ledger_balance(uuid) from public, anon, authenticated;
grant execute on function public.author_ledger_balance(uuid) to service_role;

-- ============================================================
-- Part 10: list_author_payout_history() -- CREATE OR REPLACE. Adds a
-- safe, derived `reversed boolean` and `reversed_at timestamptz` via a
-- LEFT JOIN against payout_reversal -- never provider, provider_
-- reference, or reason (BANK-PAYOUT-1B Section 8's own explicit
-- instruction). author_payouts.status remains 'paid' -- this migration
-- does not add a 'reversed' status (BANK-PAYOUT-1B.1 Section 9's
-- locked decision: the payout_reversal row's own existence is the
-- authoritative signal; a join is exactly as queryable as a status
-- value, without growing the CHECK-constrained enum for zero net
-- capability).
--
-- This function's RETURNS TABLE shape also changes (two new output
-- columns) -- an explicit DROP is required first, same reason as
-- get_author_payout_overview() above.
-- ============================================================

drop function if exists public.list_author_payout_history(integer, timestamptz, uuid);

create or replace function public.list_author_payout_history(
  p_limit integer default 25,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
)
returns table (
  id uuid,
  amount_minor bigint,
  currency text,
  status text,
  created_at timestamptz,
  processing_at timestamptz,
  paid_at timestamptz,
  failed_at timestamptz,
  reversed boolean,
  reversed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_limit integer;
begin
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
      ap.id,
      ap.amount_minor,
      ap.currency,
      ap.status,
      ap.created_at,
      ap.processing_at,
      ap.paid_at,
      ap.failed_at,
      (pr.payout_id is not null) as reversed,
      pr.reversed_at
    from public.author_payouts ap
    left join public.payout_reversal pr on pr.payout_id = ap.id
    where ap.author_id = auth.uid()
      and (
        p_cursor_created_at is null
        or (ap.created_at, ap.id) < (p_cursor_created_at, p_cursor_id)
      )
    order by ap.created_at desc, ap.id desc
    limit v_limit;
end;
$$;

revoke all on function public.list_author_payout_history(integer, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.list_author_payout_history(integer, timestamptz, uuid) to authenticated;

-- ============================================================
-- Part 11: set_author_payout_destination() -- the one entry point that
-- ever writes author_payout_destinations. No author_id parameter --
-- auth.uid() exclusively (BANK-PAYOUT-1A Section J / 1C Section 11).
--
-- IBAN validation (BANK-PAYOUT-1A.1 Section H): structural length +
-- MOD-97 (ISO 7064) checksum + Albanian-specific length when the
-- country prefix is 'AL'. This proves the string is well-formed --
-- NEVER that the account exists or belongs to the author. Nothing in
-- this function's success response implies ownership verification.
-- ============================================================

create or replace function public.iban_mod97_valid(p_iban text)
returns boolean
language plpgsql
set search_path = ''
immutable
as $$
declare
  v_rearranged text;
  v_numeric text;
  v_char text;
  v_remainder numeric := 0;
  i integer;
begin
  if p_iban is null or length(p_iban) < 4 or length(p_iban) > 34 then
    return false;
  end if;
  if p_iban !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]+$' then
    return false;
  end if;

  -- Move the first 4 characters (country + check digits) to the end,
  -- then expand every letter to its two-digit numeric value (A=10 ...
  -- Z=35), exactly per ISO 7064 MOD 97-10.
  v_rearranged := substr(p_iban, 5) || substr(p_iban, 1, 4);
  v_numeric := '';
  for i in 1..length(v_rearranged) loop
    v_char := substr(v_rearranged, i, 1);
    if v_char between '0' and '9' then
      v_numeric := v_numeric || v_char;
    else
      v_numeric := v_numeric || (ascii(v_char) - ascii('A') + 10)::text;
    end if;
  end loop;

  -- Compute the numeric string mod 97 in manageable chunks (it can be
  -- far longer than fits in a standard integer/bigint).
  for i in 1..length(v_numeric) loop
    v_remainder := (v_remainder * 10 + substr(v_numeric, i, 1)::numeric) % 97;
  end loop;

  return v_remainder = 1;
end;
$$;

revoke all on function public.iban_mod97_valid(text) from public, anon, authenticated;
grant execute on function public.iban_mod97_valid(text) to service_role, authenticated;

create or replace function public.set_author_payout_destination(
  p_currency text,
  p_beneficiary_name text,
  p_iban text
)
returns table (
  currency text,
  beneficiary_name text,
  iban text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_currency text;
  v_beneficiary_name text;
  v_iban text;
begin
  v_currency := upper(btrim(coalesce(p_currency, '')));
  v_beneficiary_name := btrim(coalesce(p_beneficiary_name, ''));
  v_iban := upper(regexp_replace(coalesce(p_iban, ''), '\s+', '', 'g'));

  if v_currency !~ '^[A-Z]{3}$' then
    raise exception 'set_author_payout_destination: currency must be a 3-letter ISO code';
  end if;

  if v_beneficiary_name = '' then
    raise exception 'set_author_payout_destination: beneficiary_name is required and must not be blank';
  end if;

  if v_iban = '' then
    raise exception 'set_author_payout_destination: iban is required and must not be blank';
  end if;

  if v_currency = 'ALL' and v_iban !~ '^AL[0-9]{2}[A-Z0-9]{24}$' then
    raise exception 'set_author_payout_destination: iban does not match the expected Albanian IBAN format (AL + 26 digits/letters)';
  end if;

  if not public.iban_mod97_valid(v_iban) then
    raise exception 'set_author_payout_destination: iban fails checksum validation -- this only confirms the format is well-formed, never that the account exists or belongs to you';
  end if;

  -- ON CONFLICT ON CONSTRAINT (not a bare column list): this
  -- function's own OUT parameter is also named "currency" (RETURNS
  -- TABLE above), which makes an unqualified "currency" in a bare
  -- ON CONFLICT (author_id, currency) column list ambiguous between
  -- the PL/pgSQL variable and the table column -- the same class of
  -- bug start_author_payout()'s own comment already documents once
  -- this session. Naming the constraint sidesteps it entirely.
  insert into public.author_payout_destinations (author_id, currency, beneficiary_name, iban, updated_at)
  values (auth.uid(), v_currency, v_beneficiary_name, v_iban, now())
  on conflict on constraint author_payout_destinations_pkey do update
    set beneficiary_name = excluded.beneficiary_name,
        iban = excluded.iban,
        updated_at = now();

  currency := v_currency;
  beneficiary_name := v_beneficiary_name;
  iban := v_iban;
  select apd.updated_at into updated_at
  from public.author_payout_destinations apd
  where apd.author_id = auth.uid() and apd.currency = v_currency;
  return next;
end;
$$;

revoke all on function public.set_author_payout_destination(text, text, text) from public, anon, authenticated;
grant execute on function public.set_author_payout_destination(text, text, text) to authenticated;

-- ============================================================
-- Part 12: set_author_payout_threshold() -- gated deterministically on
-- an active payout_minimum_policy row (BANK-PAYOUT-1B.1 Correction 1 /
-- BANK-PAYOUT-1C Section 16/19). No author_id parameter. While no
-- active policy row exists for the target currency, every write is
-- refused -- never a silent unvalidated accept, never a silently
-- clamped value. No amount is invented anywhere in this function.
-- ============================================================

create or replace function public.set_author_payout_threshold(
  p_currency text,
  p_threshold_minor bigint
)
returns table (
  currency text,
  threshold_minor bigint,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_currency text;
  v_minimum bigint;
begin
  v_currency := upper(btrim(coalesce(p_currency, '')));

  if v_currency !~ '^[A-Z]{3}$' then
    raise exception 'set_author_payout_threshold: currency must be a 3-letter ISO code';
  end if;

  if p_threshold_minor is null or p_threshold_minor <= 0 then
    raise exception 'set_author_payout_threshold: threshold_minor must be a positive amount';
  end if;

  select pmp.minimum_threshold_minor into v_minimum
  from public.payout_minimum_policy pmp
  where pmp.currency = v_currency and pmp.is_active = true;

  if v_minimum is null then
    raise exception
      'set_author_payout_threshold: no active minimum payout policy is configured for % yet -- threshold cannot be saved until one is',
      v_currency;
  end if;

  if p_threshold_minor < v_minimum then
    raise exception
      'set_author_payout_threshold: threshold_minor (%) is below the current minimum (%) for % -- choose a value at or above the minimum',
      p_threshold_minor, v_minimum, v_currency;
  end if;

  -- ON CONFLICT ON CONSTRAINT, same reasoning as
  -- set_author_payout_destination() above: this function's own OUT
  -- parameter is also named "currency", which makes a bare column-list
  -- conflict target ambiguous.
  insert into public.author_payout_settings (author_id, currency, threshold_minor, updated_at)
  values (auth.uid(), v_currency, p_threshold_minor, now())
  on conflict on constraint author_payout_settings_pkey do update
    set threshold_minor = excluded.threshold_minor,
        updated_at = now();

  currency := v_currency;
  threshold_minor := p_threshold_minor;
  select aps.updated_at into updated_at
  from public.author_payout_settings aps
  where aps.author_id = auth.uid() and aps.currency = v_currency;
  return next;
end;
$$;

revoke all on function public.set_author_payout_threshold(text, bigint) from public, anon, authenticated;
grant execute on function public.set_author_payout_threshold(text, bigint) to authenticated;

-- ============================================================
-- Part 13: staff_has_permission() -- CREATE OR REPLACE. Adds
-- 'finance.payout_export' and 'finance.payout_operate' to the admin
-- role's existing permission list, alongside 'finance.view' (owner
-- already has every permission unconditionally via its own first
-- branch, unchanged). This is the ONLY place valid permission strings
-- are registered in this codebase -- there is no separate permissions
-- table (BANK-PAYOUT-1C's own required discovery: 'finance.export'/
-- 'finance.reconcile'/'finance.recover_orphaned', named in a migration
-- 050 comment, were never actually wired in here or anywhere else --
-- confirmed by reading this function's live body before writing this
-- migration, not assumed).
-- ============================================================

create or replace function public.staff_has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
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
            'finance.view', 'finance.payout_export', 'finance.payout_operate',
            'blog.view', 'blog.manage'
          )
        )
        or (
          sm.role = 'editor'
          and p_permission in ('admin.access', 'blog.view', 'blog.manage')
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
-- Part 14: start_author_payout() -- CREATE OR REPLACE. External
-- signature/RETURNS TABLE shape unchanged. Existing behavior fully
-- preserved (pending-only source, fresh balance revalidation,
-- cancel-don't-resize on shrunk balance). Additions (BANK-PAYOUT-1B.1
-- Section 10/1C Section 15): a final live destination lookup; if none
-- exists, CANCEL (not "leave pending"), by direct analogy to the
-- existing balance-shrink cancel behavior -- a stale, unactionable
-- reservation must never sit silently blocking the author's own
-- eligibility for a future, correctly-configured attempt. Otherwise:
-- generate a unique payment_reference (retrying only on a genuine
-- payment_reference collision -- every other error re-raises,
-- BANK-PAYOUT-1C Section 14's own instruction), freeze the immutable
-- snapshot, and transition atomically, in the same transaction as the
-- existing balance check.
-- ============================================================

create or replace function public.start_author_payout(p_payout_id uuid)
returns table (
  payout_id uuid,
  status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payout record;
  v_available bigint;
  v_reserved_excluding_self bigint;
  v_payoutable bigint;
  v_destination record;
  v_payment_reference text;
  v_attempt integer := 0;
  v_constraint_name text;
begin
  select * into v_payout
  from public.author_payouts
  where id = p_payout_id
  for update;

  if not found then
    raise exception 'start_author_payout: payout % not found', p_payout_id;
  end if;

  if v_payout.status <> 'pending' then
    raise exception
      'start_author_payout: payout % is not pending (current status %)',
      p_payout_id, v_payout.status;
  end if;

  select balance.available_minor into v_available
  from public.author_ledger_balance(v_payout.author_id) balance
  where balance.currency = v_payout.currency;

  select coalesce(sum(ap.amount_minor), 0) into v_reserved_excluding_self
  from public.author_payouts ap
  where ap.author_id = v_payout.author_id
    and ap.currency = v_payout.currency
    and ap.status in ('pending', 'processing', 'reconciling')
    and ap.id <> p_payout_id;

  v_payoutable := coalesce(v_available, 0) - v_reserved_excluding_self;

  if v_payoutable < v_payout.amount_minor then
    update public.author_payouts ap
    set status = 'cancelled'
    where ap.id = p_payout_id and ap.status = 'pending';

    payout_id := p_payout_id;
    status := 'cancelled';
    return next;
    return;
  end if;

  -- Final live destination check (Section 13/15): a payout must never
  -- be handed off with nothing to pay to. Cancelling here mirrors the
  -- balance-shrink branch above exactly, for exactly the same reason.
  select * into v_destination
  from public.author_payout_destinations
  where author_id = v_payout.author_id and currency = v_payout.currency;

  if not found then
    update public.author_payouts ap
    set status = 'cancelled'
    where ap.id = p_payout_id and ap.status = 'pending';

    payout_id := p_payout_id;
    status := 'cancelled';
    return next;
    return;
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_payment_reference := 'LIBRUM-' || to_char(now(), 'YYYY-MM') || '-'
      || upper(substr(encode(gen_random_uuid()::text::bytea, 'hex'), 1, 6));

    begin
      insert into public.payout_destination_snapshots
        (payout_id, beneficiary_name, iban, currency, payment_reference)
      values
        (p_payout_id, v_destination.beneficiary_name, v_destination.iban, v_destination.currency, v_payment_reference);

      exit;
    exception
      when unique_violation then
        get stacked diagnostics v_constraint_name = constraint_name;
        if v_constraint_name = 'payout_destination_snapshots_payment_reference_key' then
          if v_attempt >= 8 then
            raise exception
              'start_author_payout: could not generate a unique payment_reference for payout % after % attempts',
              p_payout_id, v_attempt;
          end if;
          -- Retry with a fresh candidate -- a genuine, expected,
          -- collision-safe retry per BANK-PAYOUT-1C Section 14.
        else
          -- Any other uniqueness violation (e.g. the payout_id primary
          -- key, which would indicate this function ran twice for the
          -- same payout) is a real anomaly -- re-raise, never silently
          -- retried.
          raise;
        end if;
    end;
  end loop;

  update public.author_payouts ap
  set status = 'processing', processing_at = now()
  where ap.id = p_payout_id and ap.status = 'pending';

  payout_id := p_payout_id;
  status := 'processing';
  return next;
end;
$$;

revoke all on function public.start_author_payout(uuid) from public, anon, authenticated;
grant execute on function public.start_author_payout(uuid) to service_role;

-- ============================================================
-- Part 15: finalize_author_payout() -- CREATE OR REPLACE. External
-- signature/RETURNS TABLE shape unchanged. Existing idempotency/state
-- behavior fully preserved. The one addition (BANK-PAYOUT-1B.1
-- Correction 2c/1C Section 16): when p_provider = 'manual_bank',
-- p_provider_reference MUST equal the frozen
-- payout_destination_snapshots.payment_reference for that payout --
-- the database is the final authority preventing a mismatched
-- reference from ever being finalized. Deliberately NOT a universal,
-- provider-agnostic rule: a future automated provider's own
-- provider_reference (its own transaction id) is legitimately a
-- different string from Librum's internal payment_reference, and nothing
-- here constrains that case.
-- ============================================================

create or replace function public.finalize_author_payout(
  p_payout_id uuid,
  p_provider text,
  p_provider_reference text
)
returns table (
  payout_id uuid,
  status text,
  ledger_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payout record;
  v_ledger_id uuid;
  v_snapshot_reference text;
begin
  if p_provider is null or btrim(p_provider) = ''
    or p_provider_reference is null or btrim(p_provider_reference) = ''
  then
    raise exception 'finalize_author_payout: provider and provider_reference are both required and must not be blank';
  end if;

  select * into v_payout
  from public.author_payouts
  where id = p_payout_id
  for update;

  if not found then
    raise exception 'finalize_author_payout: payout % not found', p_payout_id;
  end if;

  if v_payout.status = 'paid' then
    if v_payout.provider = p_provider and v_payout.provider_reference = p_provider_reference then
      select ale.id into v_ledger_id
      from public.author_ledger_entries ale
      where ale.payout_id = p_payout_id and ale.entry_type = 'payout';

      payout_id := p_payout_id;
      status := 'paid';
      ledger_entry_id := v_ledger_id;
      return next;
      return;
    else
      raise exception
        'finalize_author_payout: payout % is already paid with a DIFFERENT provider reference (existing %/%, received %/%) -- refusing to overwrite; this requires operator investigation, not an automatic retry',
        p_payout_id, v_payout.provider, v_payout.provider_reference, p_provider, p_provider_reference;
    end if;
  end if;

  if v_payout.status not in ('processing', 'reconciling') then
    raise exception
      'finalize_author_payout: payout % is not processing/reconciling (current status %)',
      p_payout_id, v_payout.status;
  end if;

  if p_provider = 'manual_bank' then
    select pds.payment_reference into v_snapshot_reference
    from public.payout_destination_snapshots pds
    where pds.payout_id = p_payout_id;

    if v_snapshot_reference is null then
      raise exception
        'finalize_author_payout: payout % has no destination snapshot -- it was never started/processed through start_author_payout()',
        p_payout_id;
    end if;

    if p_provider_reference <> v_snapshot_reference then
      raise exception
        'finalize_author_payout: for manual_bank, provider_reference (%) must equal the frozen payment reference used at hand-off (%) for payout %',
        p_provider_reference, v_snapshot_reference, p_payout_id;
    end if;
  end if;

  insert into public.author_ledger_entries
    (author_id, payout_id, entry_type, amount_minor, currency, available_at, created_at)
  values
    (v_payout.author_id, p_payout_id, 'payout', -v_payout.amount_minor, v_payout.currency, now(), now())
  returning id into v_ledger_id;

  update public.author_payouts
  set status = 'paid',
      provider = p_provider,
      provider_reference = p_provider_reference,
      paid_at = now()
  where id = p_payout_id;

  payout_id := p_payout_id;
  status := 'paid';
  ledger_entry_id := v_ledger_id;
  return next;
end;
$$;

revoke all on function public.finalize_author_payout(uuid, text, text) from public, anon, authenticated;
grant execute on function public.finalize_author_payout(uuid, text, text) to service_role;

-- ============================================================
-- Part 16: list_payout_batch_export() -- the ONLY place full
-- beneficiary/IBAN data becomes visible to a staff member, gated
-- internally on finance.payout_export (BANK-PAYOUT-1B.1 Section
-- 19/1C Section 24/25). Granted to `authenticated`, matching this
-- codebase's own existing /admin/finance RPC convention (permission
-- checked inside the body, not via a service_role-only grant) --
-- distinct from the payout-mutation RPCs above, which are called
-- through a trusted server action, never directly by a staff member's
-- own session.
--
-- Pure read, provider-neutral row shape, only `processing`-status
-- payouts for the given run, joined to their own immutable snapshot.
-- No mutation, no unrelated internal identifiers, no provider
-- credentials.
-- ============================================================

create or replace function public.list_payout_batch_export(p_payout_run_id uuid)
returns table (
  payout_id uuid,
  payment_reference text,
  beneficiary_name text,
  iban text,
  currency text,
  amount_minor bigint
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if not public.staff_has_permission('finance.payout_export') then
    raise exception 'list_payout_batch_export: permission denied';
  end if;

  return query
    select
      ap.id as payout_id,
      pds.payment_reference,
      pds.beneficiary_name,
      pds.iban,
      ap.currency,
      ap.amount_minor
    from public.author_payouts ap
    join public.payout_destination_snapshots pds on pds.payout_id = ap.id
    where ap.payout_run_id = p_payout_run_id
      and ap.status = 'processing'
    order by pds.payment_reference;
end;
$$;

revoke all on function public.list_payout_batch_export(uuid) from public, anon, authenticated;
grant execute on function public.list_payout_batch_export(uuid) to authenticated;

-- ============================================================
-- Scope confirmation: migrations 048-054 remain byte-unchanged.
-- reserve_author_payout(), mark_author_payout_reconciling(),
-- cancel_author_payout(), start_scheduled_payout_run(),
-- complete_scheduled_payout_run(), dry_run_scheduled_payouts() are
-- completely untouched -- zero duplicate lifecycle RPCs. No Stripe
-- code path is touched, called, or affected. No scheduler HTTP route,
-- no cron configuration, no feature switch, no bank/provider adapter,
-- and no real money movement exist anywhere in this file.
-- payout_minimum_policy carries zero rows -- no minimum value is
-- invented here. PAYOUT_SCHEDULER_ENABLED is not referenced by this
-- migration at all.
-- ============================================================

-- ============================================================
-- PHASE-1C round-4 review, finding 4 (migration 057): a single,
-- narrowly scoped, SECURITY DEFINER, count-only RPC for the staging
-- fixture scripts (scripts/staging-fixtures/) -- author_payout_
-- destinations, payout_destination_snapshots, and payout_reversal are
-- `revoke all ... from anon, authenticated, service_role`, so the
-- fixture scripts' service-role client cannot count fixture-linked rows
-- in them via a direct REST query. Scoped to ONE caller-supplied author
-- id, discloses nothing but a row count per table, EXECUTE-granted
-- ONLY to service_role. Does not weaken any of the 3 tables' own
-- grants. See migration 057 for the full design rationale.
-- ============================================================
create or replace function public.staging_fixture_protected_table_counts(p_author_id uuid)
returns table (table_name text, row_count bigint)
language sql
security definer
set search_path = ''
stable
as $$
  select 'author_payout_destinations'::text, count(*)
    from public.author_payout_destinations
    where author_id = p_author_id
  union all
  select 'payout_destination_snapshots'::text, count(*)
    from public.payout_destination_snapshots pds
    where pds.payout_id in (
      select id from public.author_payouts where author_id = p_author_id
    )
  union all
  select 'payout_reversal'::text, count(*)
    from public.payout_reversal pr
    where pr.payout_id in (
      select id from public.author_payouts where author_id = p_author_id
    );
$$;

revoke all on function public.staging_fixture_protected_table_counts(uuid) from public;
revoke all on function public.staging_fixture_protected_table_counts(uuid) from anon;
revoke all on function public.staging_fixture_protected_table_counts(uuid) from authenticated;
grant execute on function public.staging_fixture_protected_table_counts(uuid) to service_role;
