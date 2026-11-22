-- LOCAL/DISPOSABLE DATABASE OR REVIEWED RUN ONLY.
--
-- Rollback for X19 (supabase/migrations/20261121180000_original_title.sql).
-- Restores the previous search_books() body (migration 20261106120000)
-- and the previous LB490 guard and trigger (migration 20261107120000).
-- books.original_title, its CHECK and the public_books column STAY
-- (nullable, unread once the app is reverted): removing a view column
-- means dropping public.public_books, which other policies depend on.

begin;

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
       new.reading_age_min, new.edition_number, new.pen_name_id, new.book_type)
      is distinct from
      (old.title, old.subtitle, old.description, old.keywords, old.isbn, old.language,
       old.publisher, old.edition, old.original_publication_date, old.genre, old.categories,
       old.cover_path, old.file_path, old.price_all, old.original_author, old.is_adult,
       old.reading_age_min, old.edition_number, old.pen_name_id, old.book_type)
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
    series_position, book_type
  on public.books
  for each row
  execute function public.books_refuse_change_while_in_review();

commit;
