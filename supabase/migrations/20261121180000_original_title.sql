-- X19 (Renato 2026-11-21, x19q2 a, x19q3 a; pictures x19p1 "ok"):
-- the "Titulli origjinal" of a translated book.
--
-- WHAT CHANGES (no row is updated):
--   1. books.original_title: a new nullable text column, added last,
--      with a named CHECK (trimmed, 1..300 characters like the title,
--      no control characters). Every existing row gets null, which the
--      CHECK accepts. Required-ness (a Translator in the credits,
--      x19q2 a) is the app's check: the credits live in another table.
--   2. public.public_books: the same definer view, same rows, same
--      options, with original_title appended as its LAST column
--      (CREATE OR REPLACE VIEW may only append). Grants and the policies
--      that read it are kept.
--   3. public.search_books(): the same function, signature, grants and
--      invoker rights; its search term also matches original_title
--      (x19q3 a). unaccent(null) is null, so a book without one matches
--      exactly as before.
--   4. books_refuse_change_while_in_review() (LB490): a book waiting for
--      review can't change its original title either, like every other
--      detail; the trigger's column list gains original_title.
--
-- books' grants are unchanged: authenticated has UPDATE on series_id and
-- series_position only, so only the server-only catalog writer (service
-- role) writes original_title.
--
-- ROLLBACK: supabase/tests/109_original_title.rollback.sql restores the
-- previous search_books() body, guard function and trigger. The column
-- and the view column stay (nullable, unread once the app is reverted):
-- removing a view column means dropping public.public_books, which other
-- policies depend on.

-- ------------------------------------------------------------
-- 1. The column
-- ------------------------------------------------------------
alter table public.books
  add column original_title text
    constraint books_original_title_check
    check (original_title is null
           or (char_length(original_title) between 1 and 300
               and original_title = btrim(original_title)
               and original_title !~ '[[:cntrl:]]'));

-- ------------------------------------------------------------
-- 2. public_books: same columns, one appended
-- ------------------------------------------------------------
create or replace view public.public_books
  with (security_barrier)
as
  select b.id, b.title, b.subtitle, b.description, b.preview_text, b.keywords,
         b.isbn, b.language, b.publisher, b.edition, b.original_publication_date,
         b.genre, b.series_id, b.series_position, b.price_cents, b.cover_path,
         b.status, b.published_at, b.created_at, b.updated_at, b.price_all,
         b.librum_choice_at,
         -- BD15 P7: null on a public-domain edition without an editor
         -- mention, for every reader (its author too).
         b.public_pen_name_id as pen_name_id,
         b.original_author,
         b.categories, b.is_adult, b.reading_age_min, b.edition_number,
         b.pd_work_id, b.pd_editor_credit,
         -- BD16 P1 (migration 20261106120000): appended last.
         b.release_date,
         -- Upload notes C (migration 20261107120000): appended last.
         b.book_type,
         -- Upload notes D (migration 20261107140000): appended last.
         (select w.word_count
            from public.book_file_words w
           where w.book_id = b.id and w.file_path = b.file_path) as word_count,
         -- X19 (migration 20261121180000): appended last.
         b.original_title
  from public.books b
  where public.book_is_publicly_listed(b)
     or b.author_id = auth.uid()
     or public.user_owns_book(b.id);

-- ------------------------------------------------------------
-- 3. search_books(): the original title is searched too (x19q3 a)
-- ------------------------------------------------------------
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
  -- PEN-NAMES-2: public_books (no account columns), so this keeps working
  -- for anon after books' public SELECT is removed.
  select books.id as book_id
  from public.public_books books
  -- BD16 (D1): pre-orders are found too.
  where books.status in ('published', 'preorder')
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
      -- BD3-P4 (migration 20261101170000, 3a): the original author too.
      or extensions.unaccent(books.original_author) ilike extensions.unaccent('%' || search_term || '%')
      -- X19 (migration 20261121180000, x19q3 a): the original title too.
      or extensions.unaccent(books.original_title) ilike extensions.unaccent('%' || search_term || '%')
      or exists (
        -- PEN-NAMES-1 (5a): the book's OWN pen name, through the public
        -- view (no author_id). The account's public name finds only the
        -- books published under it (its default pen name), never a book
        -- under another pen name.
        select 1
        from public.public_pen_names pn
        where pn.id = books.pen_name_id
          and extensions.unaccent(pn.name)
            ilike extensions.unaccent('%' || search_term || '%')
      )
    )
  -- SEARCH CANDIDATE LIMIT (500) -- see the comment block above. NOT the
  -- 48-row VISIBLE SEARCH RESULT LIMIT the bookstore displays.
  limit least(greatest(coalesce(result_limit, 500), 1), 500);
$$;

-- ------------------------------------------------------------
-- 4. LB490: a book waiting for review keeps its original title too
-- ------------------------------------------------------------
create or replace function public.books_refuse_change_while_in_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if ((new.title, new.subtitle, new.description, new.keywords, new.isbn, new.language,
       new.publisher, new.edition, new.original_publication_date, new.genre, new.categories,
       new.cover_path, new.file_path, new.price_all, new.original_author, new.is_adult,
       new.reading_age_min, new.edition_number, new.pen_name_id, new.book_type, new.original_title)
      is distinct from
      (old.title, old.subtitle, old.description, old.keywords, old.isbn, old.language,
       old.publisher, old.edition, old.original_publication_date, old.genre, old.categories,
       old.cover_path, old.file_path, old.price_all, old.original_author, old.is_adult,
       old.reading_age_min, old.edition_number, old.pen_name_id, old.book_type, old.original_title)
      -- A deleted series clears series_id through its foreign key (ON
      -- DELETE SET NULL, run by a trigger, so depth > 1): allowed.
      or ((new.series_id, new.series_position) is distinct from (old.series_id, old.series_position)
          and not (pg_catalog.pg_trigger_depth() > 1 and new.series_id is null)))
     and public.book_is_locked_for_review(old.id)
  then
    raise exception 'This book is waiting for review. Cancel the review to change it.'
      using errcode = 'LB490';
  end if;
  -- Audit r2 (N2): a deleted series clears series_id through its foreign
  -- key; its position goes with it, on every book of the series, so no
  -- book keeps a position without a series (the app's own unlink before
  -- the delete fails as a whole when one book is in review).
  if pg_catalog.pg_trigger_depth() > 1 and new.series_id is null and old.series_id is not null then
    new.series_position := null;
  end if;
  return new;
end;
$$;

drop trigger books_refuse_change_while_in_review on public.books;
create trigger books_refuse_change_while_in_review
  before update of title, subtitle, description, keywords, isbn, language, publisher, edition,
    original_publication_date, genre, categories, cover_path, file_path, price_all,
    original_author, is_adult, reading_age_min, edition_number, pen_name_id, series_id,
    series_position, book_type, original_title
  on public.books
  for each row
  execute function public.books_refuse_change_while_in_review();
