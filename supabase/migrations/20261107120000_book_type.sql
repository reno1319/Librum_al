-- ============================================================
-- Upload notes C (migration 20261107120000): "Lloji i librit", the
-- book's form (Roman, Poezi, ...), one pick, above the genres.
-- Enkelejd's upload notes 11-06, note 4; Renato: option a (11-06
-- 20:06 UTC), the list as drafted (11-06 20:09 UTC), and a live book's
-- type changes straight away, like its genres, with no review (11-07
-- 08:59 UTC).
--
-- What it changes, and nothing else:
--   1. books.book_type: null ("not chosen yet") or one of eight values.
--      The website requires it before a book is sent for review (as it
--      does the categories); the database only keeps it on the list.
--      No existing row is changed: every book starts with none.
--   2. The in-review lock (LB490) covers it: a book waiting for review
--      can't change its type either.
--   3. A picked public-domain edition's details are frozen (LB497); its
--      type is too, once it has one. One with none yet may set it once,
--      so it can still be sent for review.
--   4. public_books carries it, appended last.
--
-- No new table, function grant or SQLSTATE. Live books' pending
-- changes, request_book_review() and approval are unchanged.
--
-- The declarative equivalent is in supabase/schema.sql; see
-- supabase/tests/097_book_type.test.sql.
-- Rollback: supabase/tests/097_book_type.rollback.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1. The column. NFC strings, as the website's BOOK_TYPES list
--    (src/lib/book-types.ts) spells them; the two must stay identical.
-- ------------------------------------------------------------
alter table public.books
  add column book_type text
    constraint books_book_type_check check (book_type in (
      'Roman',
      'Novelë / tregim',
      'Përmbledhje me tregime',
      'Poezi',
      'Dramë',
      'Ese',
      'Biografi & kujtime',
      'Jo-artistik (studim, tjetër)'
    ));

-- ------------------------------------------------------------
-- 2. The in-review lock (LB490): the same rule, book_type added.
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

-- ------------------------------------------------------------
-- 3. A picked edition's frozen details (LB497): book_type added, but a
--    first choice (from none) is allowed.
-- ------------------------------------------------------------
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
              and not (pg_catalog.pg_trigger_depth() > 1 and new.series_id is null))
          -- Upload notes C: the type, once it has one.
          or (old.book_type is not null and new.book_type is distinct from old.book_type))
     and exists (select 1 from public.pd_works w where w.picked_book_id = old.id)
  then
    raise exception 'Librum picked this book as the edition of a public-domain work, so this detail can''t change.'
      using errcode = 'LB497';
  end if;
  return new;
end;
$$;

drop trigger books_freeze_picked_pd_edition on public.books;
create trigger books_freeze_picked_pd_edition
  before update of subtitle, language, keywords, isbn, publisher, edition, original_publication_date,
    genre, categories, reading_age_min, edition_number, price_all, series_id, series_position,
    book_type
  on public.books
  for each row
  execute function public.books_freeze_picked_pd_edition();

-- CREATE OR REPLACE keeps the functions' grants (none: revoked from
-- public, anon, authenticated and service_role when they were created).

-- ------------------------------------------------------------
-- 4. public_books: same columns, one appended. CREATE OR REPLACE keeps
--    every grant and the policies that read it.
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
         b.book_type
  from public.books b
  where public.book_is_publicly_listed(b)
     or b.author_id = auth.uid()
     or public.user_owns_book(b.id);
