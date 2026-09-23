-- ALL-SEARCH-1 (ALL-WIRING-2, Patch 2 of the ALL application-wiring
-- sequence): move public.search_books()'s price predicates from the
-- legacy USD `books.price_cents` column to the ALL catalog column
-- `books.price_all`, and exclude rows that have no authored ALL price.
--
-- WHY THIS MIGRATION EXISTS AT ALL. Patch 2 moves every free/paid
-- decision in the application onto `books.price_all`. Bookstore search
-- is the one such decision that does not live in the application: the
-- unsearched grid filters in the application's own query builder, but a
-- searched grid delegates matching (and the price scoping that goes
-- with it) to this function, because diacritic-tolerant matching needs
-- Postgres's unaccent() and cannot be expressed client-side. Leaving
-- this body on `price_cents` while the rest of Patch 2 moved would make
-- the searched and unsearched paths of the SAME page disagree about
-- which books exist and what they cost.
--
-- WHAT CHANGES, precisely, and nothing else:
--
--   1. `books.price_cents >= min_price_cents` becomes
--      `books.price_all >= min_price_cents`, and likewise for the
--      maximum. The VALUES these parameters carry are whole lek from
--      this patch onward; see the parameter-name note below.
--   2. A new unconditional `books.price_all is not null` predicate. A
--      row with no authored ALL price is not ALL-ready -- neither free
--      nor purchasable -- so it must not appear in a search result,
--      exactly as it no longer appears in the unsearched grid.
--
-- The signature, the return shape, the language, the SECURITY INVOKER
-- posture, the empty search_path, the STABLE volatility, the
-- title/description/keywords/pen-name matching, and the 1..500
-- candidate clamp are all byte-identical to the base definition.
--
-- THE PARAMETER NAMES ARE DELIBERATELY NOT RENAMED. `min_price_cents`
-- and `max_price_cents` now carry whole-ALL catalog values, which is a
-- genuine misnomer and is accepted here on purpose: a function's
-- parameter names are part of its call signature for every PostgREST
-- caller at once, so renaming them is a separate, independently
-- reviewable change rather than a rider on the patch that performs the
-- atomic free/paid cutover. This comment, and the matching one at the
-- application call site (src/app/(public)/bookstore/page.tsx), are the
-- contract until that rename happens.
--
-- ROLLOUT NOTE, stated plainly because it is NOT behaviour-free.
-- Applying this migration before the matching application deploy breaks
-- nothing structurally: the signature is unchanged, so the currently
-- deployed caller still resolves this function and still passes two
-- integers. But those integers are USD cents until the new build is
-- live, and they would be compared against whole lek -- and, more
-- visibly, EVERY book with a null `price_all` disappears from search
-- results the moment this is applied. Today that is every book in the
-- catalog. That disappearance is intentional under the accepted
-- null-price rule (an unpriced book is not purchasable and must not be
-- offered), and it is immediately observable to readers; it is not an
-- interval in which nothing changes.
--
-- Applied through `create or replace`, which preserves the function's
-- existing owner and ACL. No revoke/grant is restated: base already
-- established `revoke all ... from public` and `grant execute ... to
-- anon, authenticated` on this exact signature, and `create or replace`
-- does not reset them. The catalog-equivalence harness
-- (supabase/tests/063_all_search_books_price_all_catalog_equivalence.sh)
-- proves that, rather than assuming it.
--
-- No row of any table is read or written by this migration.

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
    -- ALL-SEARCH-1: a row with no authored ALL price is not ALL-ready.
    -- Unconditional, never folded into the two bound checks below: a
    -- reader who applies no price filter at all must not be shown an
    -- unpriced book either.
    and books.price_all is not null
    -- ALL-SEARCH-1: whole-ALL catalog bounds. The parameter names still
    -- read "cents" and are deliberately not renamed here -- see the
    -- header. `price_cents` is never consulted: it is legacy USD minor
    -- units and its values are not lek.
    and (min_price_cents is null or books.price_all >= min_price_cents)
    and (max_price_cents is null or books.price_all <= max_price_cents)
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
