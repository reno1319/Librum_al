-- ALBANIAN-3 (Renato 2026-10-28, "B a" + "C ok"): genres are stored in
-- Albanian. Eighteen genres: the fourteen earlier English genres,
-- translated, plus four new ones (Drama & teatër, Filozofi, Psikologji,
-- Shkencë). Same list and order as GENRES in src/lib/genres.ts.
--
-- WHAT CHANGES (one table, one column, one constraint):
--   1. books_genre_check is dropped (it allows only the English names).
--   2. Every book whose genre is one of the thirteen English names that
--      change gets the Albanian name ("Horror" is the same word in
--      Albanian, so those rows are not touched). A NULL genre stays NULL. No trigger fires:
--      every books trigger is on INSERT, DELETE or UPDATE OF other
--      columns (status, pen_name_id, author_id, series_id, file_path,
--      cover_path), never genre.
--   3. books_genre_check is added back, same name, with the eighteen
--      Albanian names.
-- A genre outside the fourteen known names (impossible under the old
-- CHECK) would be left as it is, so the new CHECK would fail and the
-- whole migration roll back instead of silently clearing data.
--
-- Nothing else reads the genre names: search_books() compares
-- genre_filter by equality, public_books passes the column through,
-- and books_genre_idx is a plain btree on the column.

alter table public.books drop constraint books_genre_check;

update public.books
set genre = case genre
  when 'Fiction' then 'Letërsi artistike'
  when 'Non-Fiction' then 'Publicistikë & ese'
  when 'Mystery & Thriller' then 'Policor & triler'
  when 'Romance' then 'Romancë'
  when 'Fantasy' then 'Fantazi'
  when 'Science Fiction' then 'Fantashkencë'
  when 'Biography & Memoir' then 'Biografi & kujtime'
  when 'Self-Help' then 'Zhvillim personal'
  when 'History' then 'Histori'
  when 'Poetry' then 'Poezi'
  when 'Young Adult' then 'Për të rinj'
  when 'Children''s' then 'Për fëmijë'
  when 'Business' then 'Biznes & ekonomi'
end
where genre in (
  'Fiction', 'Non-Fiction', 'Mystery & Thriller', 'Romance', 'Fantasy',
  'Science Fiction', 'Biography & Memoir', 'Self-Help', 'History',
  'Poetry', 'Young Adult', 'Children''s', 'Business'
);

alter table public.books
  add constraint books_genre_check check (genre in (
    'Biografi & kujtime', 'Biznes & ekonomi', 'Drama & teatër',
    'Fantashkencë', 'Fantazi', 'Filozofi', 'Histori', 'Horror',
    'Letërsi artistike', 'Për fëmijë', 'Për të rinj', 'Poezi',
    'Policor & triler', 'Psikologji', 'Publicistikë & ese', 'Romancë',
    'Shkencë', 'Zhvillim personal'
  ));
