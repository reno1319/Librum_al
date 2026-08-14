-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. It adds the genre column needed for storefront search/filter.
-- If you're setting up a fresh project, just run schema.sql instead.

-- Keep this list in sync with GENRES in src/lib/genres.ts.
alter table public.books
  add column genre text check (genre in (
    'Fiction', 'Non-Fiction', 'Mystery & Thriller', 'Romance', 'Fantasy',
    'Science Fiction', 'Horror', 'Biography & Memoir', 'Self-Help',
    'History', 'Poetry', 'Young Adult', 'Children''s', 'Business'
  ));

create index books_genre_idx on public.books(genre);
