-- BD15 P1 ROLLBACK: undoes the behaviour of migration 20261103200000.
-- Puts back, exactly as they were before it (same definitions, CREATE
-- OR REPLACE keeps their grants):
--   * public.book_makes_pen_name_public(): BD14's rule, without the
--     public-domain clause;
--   * public.public_bundles: pen_name_id shown as stored;
--   * public.public_books: the base row rule (status = 'published', the
--     caller's own, owned) and pen_name_id as stored;
-- and removes every BD15 trigger, trigger function, constraint and
-- public.book_is_publicly_listed().
--
-- Deliberately NOT removed (the residue): the six books columns
-- (categories, is_adult, reading_age_min, edition_number, pd_work_id,
-- pd_editor_credit), their foreign key to pd_works, the public_books
-- columns that show them, and the tables pd_works and
-- book_ai_disclosures with their grants. Taking a column out of
-- public_books means dropping it, and public_reviews and the
-- book_contributors SELECT policy depend on it; nullable or defaulted
-- columns and staff-only tables the reverted app never reads are the
-- safer state. No row is changed, so nothing an author or staff typed
-- is lost. supabase/tests/090_bd15_upload_flow_foundation_residue.sql
-- is exactly this residue; the catalog harness compares a rolled-back
-- database against base + that file.
--
-- Run only together with the app revert. Safe to run more than once.
--
-- Known limits after a rollback:
--   * The forward migration cannot be re-run as is (its ADD COLUMN and
--     CREATE TABLE statements would fail on the residue).
--   * The reverted supabase/schema.sql no longer mentions the residue;
--     the next migration must start from the live state.

-- The views first: they stop reading book_is_publicly_listed().
create or replace view public.public_books
  with (security_barrier)
as
  select b.id, b.title, b.subtitle, b.description, b.preview_text, b.keywords,
         b.isbn, b.language, b.publisher, b.edition, b.original_publication_date,
         b.genre, b.series_id, b.series_position, b.price_cents, b.cover_path,
         b.status, b.published_at, b.created_at, b.updated_at, b.price_all,
         b.librum_choice_at, b.pen_name_id,
         b.original_author,
         b.categories, b.is_adult, b.reading_age_min, b.edition_number,
         b.pd_work_id, b.pd_editor_credit
  from public.books b
  where b.status = 'published'
     or b.author_id = auth.uid()
     or public.user_owns_book(b.id);

create or replace view public.public_bundles
  with (security_barrier)
as
  select bu.id, bu.title, bu.description, bu.price_cents, bu.status,
         bu.created_at, bu.updated_at, bu.price_all, bu.pen_name_id
  from public.bundles bu
  where bu.status = 'published'
     or bu.author_id = auth.uid();

create or replace function public.book_makes_pen_name_public(b public.books)
returns boolean
language sql
immutable
parallel safe
as $$
  select b.status operator(pg_catalog.=) 'published'
      or b.published_at is not null
$$;

drop function if exists public.book_is_publicly_listed(public.books);

drop trigger if exists bundles_require_public_pen_name on public.bundles;
drop function if exists public.bundles_require_public_pen_name();

drop trigger if exists book_contributors_limit on public.book_contributors;
drop function if exists public.book_contributors_limit();

drop trigger if exists bundle_books_refuse_hidden_pd_edition on public.bundle_books;
drop function if exists public.bundle_books_refuse_hidden_pd_edition();

drop trigger if exists books_pd_edition_rules on public.books;
drop function if exists public.books_pd_edition_rules();

drop trigger if exists books_check_published_pd_edition on public.books;
drop trigger if exists pd_works_check_published_pd_edition on public.pd_works;
drop function if exists public.books_check_published_pd_edition();

drop trigger if exists books_lock_picked_pd_edition on public.books;
drop function if exists public.books_lock_picked_pd_edition();

drop trigger if exists books_lock_after_first_publish on public.books;
drop function if exists public.books_lock_after_first_publish();

drop trigger if exists books_sync_categories on public.books;
drop function if exists public.books_sync_categories();

alter table public.pd_works
  drop constraint if exists pd_works_picked_book_fkey;

alter table public.books
  drop constraint if exists books_pd_work_id_id_key,
  drop constraint if exists books_pd_series_check,
  drop constraint if exists books_pd_price_check,
  drop constraint if exists books_pd_editor_credit_check,
  drop constraint if exists books_adult_reading_age_check,
  drop constraint if exists books_adult_categories_check,
  drop constraint if exists books_language_check,
  drop constraint if exists books_edition_number_check,
  drop constraint if exists books_reading_age_min_check,
  drop constraint if exists books_categories_check;
