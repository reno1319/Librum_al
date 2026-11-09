-- ============================================================
-- Upload notes D (migration 20261107140000): the page estimate,
-- "Faqe: rreth N" (words / 250) on the book page.
-- Enkelejd's upload notes 11-06, note 3b; Renato 11-07: book page only
-- (Q1 a), counted when the manuscript is saved plus a staff-only button
-- for older files, never on a public request (Q2 a), exact number (Q3 b),
-- row hidden without a count (Q4 a).
--
-- What it changes, and nothing else:
--   1. book_file_words: one word count per stored manuscript file
--      (book id + storage key). Keyed by the file, so a live book's
--      waiting file is counted when it is saved and shows once Librum
--      approves it. Rows go with their book (ON DELETE CASCADE). Only
--      service_role reads or writes it; RLS on, no policy.
--   2. public_books carries word_count (the count for the book's own
--      current file_path, else null), appended last.
--
-- No row of any existing table changes; no function, trigger or SQLSTATE.
-- Existing books get no count until their file is saved again or staff
-- press "Numëro faqet" on the admin book page.
--
-- The declarative equivalent is in supabase/schema.sql; see
-- supabase/tests/098_page_estimate.test.sql.
-- Rollback: supabase/tests/098_page_estimate.rollback.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1. The table.
-- ------------------------------------------------------------
create table public.book_file_words (
  book_id uuid not null references public.books(id) on delete cascade,
  file_path text not null constraint book_file_words_file_path_check check (file_path <> ''),
  word_count integer not null constraint book_file_words_word_count_check check (word_count >= 0),
  counted_at timestamptz not null default now(),
  primary key (book_id, file_path)
);

alter table public.book_file_words enable row level security;

-- The website writes it with the service key only (on save, and the
-- staff button); readers see the count only through public_books.
revoke all on public.book_file_words from public, anon, authenticated, service_role;
grant select, insert, update on public.book_file_words to service_role;

-- ------------------------------------------------------------
-- 2. public_books: same columns, one appended. CREATE OR REPLACE keeps
--    every grant and the policies that read it. The view runs as its
--    owner, so it reads book_file_words without granting it to readers.
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
           where w.book_id = b.id and w.file_path = b.file_path) as word_count
  from public.books b
  where public.book_is_publicly_listed(b)
     or b.author_id = auth.uid()
     or public.user_owns_book(b.id);
