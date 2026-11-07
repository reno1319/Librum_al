-- LOCAL/DISPOSABLE DATABASE, or an authorized database run only.
--
-- Upload notes C ROLLBACK: undoes the behaviour of migration
-- 20261107120000_book_type.sql. Puts back the in-review lock (LB490)
-- and the picked-edition freeze (LB497) exactly as before it (same
-- definitions and trigger column lists; CREATE OR REPLACE keeps their
-- grants, none).
--
-- Deliberately NOT removed (the residue, no row changed): the column
-- books.book_type with its CHECK, and public_books.book_type (taking a
-- column out of the view means dropping it, and public_reviews and the
-- book_contributors SELECT policy depend on it; BD16's rollback keeps
-- release_date the same way). The reverted app neither reads nor writes
-- it, so the types chosen so far are kept, unused.
--
-- Run only together with the app revert. Safe to run more than once.

begin;

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
       new.reading_age_min, new.edition_number, new.pen_name_id)
      is distinct from
      (old.title, old.subtitle, old.description, old.keywords, old.isbn, old.language,
       old.publisher, old.edition, old.original_publication_date, old.genre, old.categories,
       old.cover_path, old.file_path, old.price_all, old.original_author, old.is_adult,
       old.reading_age_min, old.edition_number, old.pen_name_id)
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

drop trigger if exists books_refuse_change_while_in_review on public.books;
create trigger books_refuse_change_while_in_review
  before update of title, subtitle, description, keywords, isbn, language, publisher, edition,
    original_publication_date, genre, categories, cover_path, file_path, price_all,
    original_author, is_adult, reading_age_min, edition_number, pen_name_id, series_id,
    series_position
  on public.books
  for each row
  execute function public.books_refuse_change_while_in_review();

create or replace function public.books_freeze_picked_pd_edition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_catalog.current_setting('role') in ('anon', 'authenticated', 'service_role')
     and ((new.subtitle, new.language, new.keywords, new.isbn, new.publisher, new.edition,
           new.original_publication_date, new.genre, new.categories, new.reading_age_min,
           new.edition_number, new.price_all)
          is distinct from
          (old.subtitle, old.language, old.keywords, old.isbn, old.publisher, old.edition,
           old.original_publication_date, old.genre, old.categories, old.reading_age_min,
           old.edition_number, old.price_all)
          -- A deleted series clears series_id through its foreign key
          -- (a trigger, so depth > 1): allowed, as in LB490.
          or ((new.series_id, new.series_position) is distinct from (old.series_id, old.series_position)
              and not (pg_catalog.pg_trigger_depth() > 1 and new.series_id is null)))
     and exists (select 1 from public.pd_works w where w.picked_book_id = old.id)
  then
    raise exception 'Librum picked this book as the edition of a public-domain work, so this detail can''t change.'
      using errcode = 'LB497';
  end if;
  return new;
end;
$$;

drop trigger if exists books_freeze_picked_pd_edition on public.books;
create trigger books_freeze_picked_pd_edition
  before update of subtitle, language, keywords, isbn, publisher, edition, original_publication_date,
    genre, categories, reading_age_min, edition_number, price_all, series_id, series_position
  on public.books
  for each row
  execute function public.books_freeze_picked_pd_edition();

commit;
