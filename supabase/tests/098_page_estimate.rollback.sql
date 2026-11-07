-- LOCAL/DISPOSABLE DATABASE, or an authorized database run only.
--
-- Upload notes D ROLLBACK: undoes migration
-- 20261107140000_page_estimate.sql. public_books keeps its word_count
-- column (taking a column out of the view means dropping it, and
-- public_reviews and the book_contributors SELECT policy depend on it;
-- the book_type and release_date rollbacks keep theirs the same way),
-- but it becomes an always-null integer, so the table can go.
--
-- Residue: public_books.word_count (always null). The counts are lost;
-- the reverted app neither reads nor writes them.
--
-- Run only together with the app revert. Safe to run more than once.

begin;

create or replace view public.public_books
  with (security_barrier)
as
  select b.id, b.title, b.subtitle, b.description, b.preview_text, b.keywords,
         b.isbn, b.language, b.publisher, b.edition, b.original_publication_date,
         b.genre, b.series_id, b.series_position, b.price_cents, b.cover_path,
         b.status, b.published_at, b.created_at, b.updated_at, b.price_all,
         b.librum_choice_at,
         b.public_pen_name_id as pen_name_id,
         b.original_author,
         b.categories, b.is_adult, b.reading_age_min, b.edition_number,
         b.pd_work_id, b.pd_editor_credit,
         b.release_date,
         b.book_type,
         null::integer as word_count
  from public.books b
  where public.book_is_publicly_listed(b)
     or b.author_id = auth.uid()
     or public.user_owns_book(b.id);

drop table if exists public.book_file_words;

commit;
