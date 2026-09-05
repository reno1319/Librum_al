-- LIBRUM 2.0 AUTHOR-1A / AUTHOR-1D STAGE 1: separates account/private
-- identity (profiles.display_name, unchanged) from public author
-- identity / pen name (the new profiles.public_author_name), closing the
-- gap the AUTHOR-1 audit found -- display_name is currently the ONLY
-- name field, so it is forced to serve both an account holder's private
-- identity and every reader-facing author attribution at once, meaning
-- an author cannot adopt a pen name without their real account name
-- changing retroactively everywhere a book/bundle/series/search result
-- of theirs appears.
--
-- ============================================================
-- LIBRUM 2.0 AUTHOR-1D: THIS IS STAGE 1 OF A TWO-STAGE ROLLOUT.
-- ============================================================
-- AUTHOR-1C's original design for this migration ALSO removed the
-- profiles table's own "Profiles are viewable by everyone" policy and
-- anon's SELECT grant in the same migration as everything below. Final
-- review (AUTHOR-1D) found that combination unsafe to apply as a single
-- step against a live production database that still runs the CURRENT
-- (pre-AUTHOR-1) application: applying it first would pull profiles
-- SELECT access out from under the old app before the new app (which
-- reads through public_author_profiles instead) is ever deployed, and
-- deploying the new app first would have it querying a view that
-- doesn't exist yet.
--
-- This migration is STAGE 1 -- a pure compatibility foundation. It adds
-- every new column/constraint/function/view the AUTHOR-1 application
-- needs, and WIDENS grants (the new view, the new update-grant column),
-- but never NARROWS anything the current production app still depends
-- on. Concretely: it does NOT touch the "Profiles are viewable by
-- everyone" SELECT policy, and does NOT revoke anon's SELECT grant on
-- profiles. Both the old app (still reading profiles directly) and the
-- new AUTHOR-1 app (reading public_author_profiles) work correctly
-- against the schema this migration produces -- see
-- supabase/tests/045_public_author_name.test.sql's own State A/B/C
-- coverage.
--
-- The privacy lockdown itself -- removing that policy, revoking anon's
-- grant, restricting authenticated to self+staff -- is migration 046,
-- applied only once the AUTHOR-1 application is confirmed live (see
-- that migration's own header for why it's then safe).
--
-- Additive and nullable, mirroring migration 044's own posture for new
-- optional text fields on an existing table: no destructive rename, no
-- uniqueness constraint (public author names are deliberately allowed to
-- collide -- every public author URL is already UUID-keyed, see
-- /authors/[id], never name-keyed). Carries the same conservative length
-- CHECK migration 044 already established for subtitle/publisher/edition
-- (300/200/100 chars) -- 120 here reflects that this is a short "name,"
-- not a bibliographic field.
--
-- display_name is NOT a verified/legal name -- Librum has no KYC or
-- legal-name-verification system today. Both display_name and
-- public_author_name are self-reported, user-editable text; the only
-- distinction this migration encodes is WHERE each is shown (account/
-- internal context vs. public reader-facing attribution), never a claim
-- about either one's legal accuracy.
alter table public.profiles
  add column public_author_name text
    check (public_author_name is null or char_length(public_author_name) <= 120);

-- Backfill AUTHORS ONLY -- an author's existing display_name is the
-- correct starting public name (it's what every reader-facing surface
-- has always shown them as, up to this exact migration), so leaving it
-- null for every pre-existing author would make the runtime
-- coalesce(public_author_name, display_name) fallback do 100% of the
-- work for the entire existing author base, rather than fallback being
-- the safety net it's meant to be for genuinely NEW authors only (who
-- haven't visited Profile yet -- see the runtime fallback everywhere
-- below). Deliberately scoped to role = 'author': a reader has no
-- public attribution surface at all (no public reader-profile page
-- exists), so populating this column for them would be meaningless
-- state with no reader ever benefiting from it.
--
-- Must run BEFORE the NOT-NULL-for-authors constraint immediately below
-- -- this is what makes adding that constraint safe against every
-- pre-existing author row.
update public.profiles
set public_author_name = display_name
where role = 'author'
  and public_author_name is null;

-- LIBRUM 2.0 AUTHOR-1C: makes "every author has a public name" a real,
-- database-enforced invariant, not merely a convention the app and the
-- backfill above happen to maintain. Combined with the backfill above
-- (existing authors) and handle_new_user()'s own update further below
-- (new authors), this is what makes it permanently impossible for an
-- author row to ever have a null public_author_name again -- which is
-- what lets search_books() and every public reader-facing query below
-- stop treating display_name as a fallback source at all. Never applies
-- to readers -- they have no public attribution surface, so their
-- public_author_name stays null forever, exactly as before.
--
-- Safe to add in Stage 1: this only ever constrains WRITES (an INSERT or
-- UPDATE that would leave an author row's public_author_name null), and
-- the current production application has no write path that could ever
-- trigger it -- it doesn't select, display, or write this column at
-- all, and role promotion to 'author' only ever happens through
-- handle_new_user() (updated below, in this same migration, to always
-- satisfy this constraint).
alter table public.profiles
  add constraint public_author_name_required_for_authors
  check (role <> 'author' or public_author_name is not null);

-- Extends (not replaces) the existing authenticated UPDATE grant on
-- profiles -- Postgres column-level GRANTs are additive per-role, so
-- this single incremental statement is sufficient; it does not need to
-- repeat the display_name/bio/avatar_path columns migration 033 already
-- granted. anon gets nothing here either, same as every other profiles
-- column -- it has no legitimate reason to write anything on this
-- table. Purely additive: the current production app never writes this
-- column, so this grant is inert until the new app's Profile page ships.
grant update (public_author_name)
  on public.profiles
  to authenticated;

-- ============================================================
-- LIBRUM 2.0 AUTHOR-1D STAGE 1: the safe, reader-facing replacement for
-- direct public access to profiles -- exposes ONLY the columns a reader
-- ever legitimately needs for author attribution (never display_name,
-- never role, never any Stripe/internal column). Deliberately a plain
-- view, not `security_invoker` -- Postgres runs a non-security-invoker
-- view with the privileges of the view's OWNER (this migration-applying
-- role, the same owner as public.profiles itself), which is NOT subject
-- to profiles' own RLS (RLS never applies to a table's owner unless
-- FORCE ROW LEVEL SECURITY is set, which it isn't here) -- so this view
-- can see every author's row regardless of the caller's own identity,
-- while still only ever returning these four columns.
--
-- Created here, in Stage 1, specifically so the AUTHOR-1 application can
-- be deployed and fully verified (reading through this view) WHILE the
-- old application keeps working unchanged against the still-untouched
-- base-table grant/policy -- the entire point of the two-stage split.
-- Verified directly against a real local Postgres instance: anon and an
-- ordinary authenticated reader can both read another author's
-- public_author_name/bio/avatar_path through this view, both before and
-- after migration 046's lockdown -- this view's own grant never changes
-- across either migration.
--
-- Filtered to role = 'author' -- mirrors public_author_name's own
-- "never populated for a reader" invariant: a reader's row simply isn't
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

-- LIBRUM 2.0 AUTHOR-1C: a new author now gets public_author_name
-- initialized to their own submitted display_name at signup, the same
-- value the backfill above gave every pre-existing author -- required
-- by public_author_name_required_for_authors above, and what makes it
-- safe for search_books() and every public reader-facing query to read
-- ONLY public_author_name (via public_author_profiles) and never fall
-- back to the private display_name at all. A reader gets null, exactly
-- as before -- they have no public attribution surface.
--
-- Safe in Stage 1: the current production application never reads
-- public_author_name, so this extra initialization is inert to it --
-- both apps agree on display_name's own value and meaning, which this
-- trigger update never touches.
--
-- Everything else about this function (role whitelist, search_path
-- hardening) is unchanged from schema.sql/migration 001's own version.
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

-- search_books(): the author-name search clause now reads
-- public_author_profiles (the safe view), never public.profiles
-- directly, and matches public_author_name alone -- no coalesce with
-- display_name.
--
-- LIBRUM 2.0 AUTHOR-1D: shipping this in STAGE 1 (rather than deferring
-- it to migration 046, alongside the grant/RLS lockdown) is deliberate,
-- not an oversight. This function is SECURITY INVOKER, meaning it runs
-- with the CALLING role's own privileges -- confirmed directly against a
-- real local Postgres instance: if this clause still queried the base
-- profiles table, it would keep working fine through Stage 1 (the old
-- grant/policy are still in place here), but would break the moment
-- migration 046 narrows them, with a hard "permission denied for table
-- profiles" -- unless search_books() had ALREADY been moved onto the
-- view beforehand. Shipping the view-based version now means migration
-- 046 is a pure grant/RLS change with zero function bodies to touch.
--
-- Functionally transparent for the entire existing author base at this
-- exact point in the rollout: the backfill above has just set every
-- existing author's public_author_name equal to their display_name, so
-- this clause matches exactly the same authors, by exactly the same
-- name, that the previous display_name-only version did -- nothing an
-- old-app user could search for stops matching. It only diverges once an
-- author actually visits the NEW Profile page and sets a real pen name,
-- which cannot happen until the new application is deployed.
--
-- Everything else in this function is byte-for-byte unchanged from
-- migration 021: same security invoker posture, same title/description/
-- keywords matching, same unaccent() normalization for Albanian
-- diacritics, same genre/price filters, same candidate-limit clamping.
-- CREATE OR REPLACE preserves the existing REVOKE/GRANT EXECUTE from
-- migration 021 automatically.
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
        from public.public_author_profiles p
        where p.id = books.author_id
          and extensions.unaccent(p.public_author_name)
            ilike extensions.unaccent('%' || search_term || '%')
      )
    )
  -- SEARCH CANDIDATE LIMIT (500) -- unchanged, see migration 021's own
  -- comment (reproduced in schema.sql) for the full reasoning.
  limit least(greatest(coalesce(result_limit, 500), 1), 500);
$$;

-- ============================================================
-- LIBRUM 2.0 AUTHOR-1D: deliberately NOT included in this migration --
-- ============================================================
-- The profiles table's own SELECT policy ("Profiles are viewable by
-- everyone") and anon's table-level SELECT grant are left EXACTLY as
-- they are today. The current production application depends on both to
-- keep working (it reads profiles.display_name directly, for any row,
-- via the ordinary anon/authenticated client) -- narrowing either one
-- here would break it before the new AUTHOR-1 application is even
-- deployed. That lockdown is migration 046, applied only once the new
-- application is confirmed live and reading exclusively through
-- public_author_profiles (and, for self/staff cases, its own row).
