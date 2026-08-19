-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. Adds diacritic-tolerant bookstore search as a dedicated,
-- read-only SQL function (see the Phase 6B search audit) -- schema.sql
-- already includes this same function for fresh project setups.
--
-- WHY: Postgres ILIKE has no built-in accent-folding, so a reader
-- searching "Kerc" could never find a book titled "Kërc" -- unaccent()
-- fixes that by folding both the stored text and the search term to
-- their unaccented form before comparing (ë/e and ç/c fold together,
-- along with unaccent's normal handling of other accented Latin
-- letters). ILIKE still keeps the match case-insensitive, exactly as
-- today's search already is.
--
-- SCHEMA FOR THE EXTENSION: Supabase recommends installing extensions
-- into a dedicated "extensions" schema rather than public. This
-- migration creates that schema defensively (if not exists) since no
-- extension has been enabled anywhere in this repository's SQL history
-- before now, so there's nothing to conflict with -- then installs
-- unaccent there and references it as extensions.unaccent(...).
--
-- >>> IMPORTANT BEFORE YOU RUN THIS: if `unaccent` was ever enabled on
-- your live Supabase project through some other path (e.g. manually via
-- the dashboard, into a different schema), `create extension if not
-- exists ... with schema extensions` below will silently no-op rather
-- than move it, and search_books's explicit extensions.unaccent(...)
-- reference would then fail to resolve at call time. If you're not
-- certain, run this one read-only check first in the SQL Editor:
--   select extname, extnamespace::regnamespace from pg_extension where extname = 'unaccent';
-- If that returns no rows, you're clear to run this migration as-is.
--
-- SECURITY: search_books is SECURITY INVOKER, not SECURITY DEFINER --
-- unlike bestselling_books, it only reads books/profiles data that is
-- already publicly selectable under existing RLS ("Published books are
-- viewable by everyone" / "Profiles are viewable by everyone"), so no
-- elevated privilege is used or needed. It returns ONLY book_id --
-- never any profiles or purchases column -- the caller re-fetches full
-- book rows the normal way afterward. Only published books can ever be
-- returned (status = 'published' is enforced inside the function, not
-- left to the caller).
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
-- migration fixes, just at a higher threshold.
--
-- This still guards against an unbounded scan/result set -- 500 is a
-- hard cap, not "no limit" -- mirroring the same defensive
-- least/greatest/coalesce pattern already used by bestselling_books.
--
-- If you're setting up a fresh project, just run schema.sql instead (it
-- already includes this function -- run this migration afterward
-- either way, on a fresh or an existing project).

create schema if not exists extensions;
create extension if not exists unaccent with schema extensions;

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

-- Public/anon and authenticated both need this -- the bookstore search
-- page is reachable by logged-out visitors too, and it only surfaces
-- data that was already public.
revoke all on function public.search_books(text, text, int, int, int) from public;
grant execute on function public.search_books(text, text, int, int, int) to anon, authenticated;
