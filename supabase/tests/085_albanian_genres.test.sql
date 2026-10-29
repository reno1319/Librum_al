-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for ALBANIAN-3
-- (supabase/migrations/20261028150000_albanian_genres.sql):
--
-- * part1 the constraint: books has exactly one genre CHECK, named
--   books_genre_check; each of the eighteen Albanian genres and NULL is
--   accepted; every one of the fourteen old English names, a near miss
--   ("Letersi artistike" without ë), a decomposed "ë" (NFD) and a
--   trailing space are refused.
-- * part2 search_books() filters by the Albanian name.
--
-- The migration over populated data (every English genre mapped, every
-- other column unchanged) is proven by
-- 085_albanian_genres_catalog_equivalence.sh.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance (on 16 strip ", maintain" from a copy of schema.sql):
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/085_albanian_genres.test.sql
--
-- It must also pass against the base schema.sql plus the migration.
--
-- Everything runs inside one transaction and is rolled back at the end.

begin;

set local client_min_messages = warning;

create table pg_temp.assertions_run (n integer not null);
insert into pg_temp.assertions_run values (0);

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  update pg_temp.assertions_run set n = n + 1;
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

-- 'ok' when the book accepts the genre, 'refused' on a CHECK violation.
create function pg_temp.try_genre(p_genre text) returns text
  language plpgsql as $$
begin
  update public.books set genre = p_genre where id = 'e0850001-0000-4000-8000-0000000000b1';
  return 'ok';
exception when check_violation then
  return 'refused';
end;
$$;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0850000-0000-4000-8000-00000000000a', 'g085-a@test', now(), '{"role":"author","display_name":"G085 Author"}');

insert into public.books (id, author_id, title, status, price_all, published_at, genre) values
  ('e0850001-0000-4000-8000-0000000000b1', 'e0850000-0000-4000-8000-00000000000a', 'G085 Probe', 'draft', 199, null, null),
  ('e0850001-0000-4000-8000-0000000000b2', 'e0850000-0000-4000-8000-00000000000a', 'G085 Poezi', 'published', 199, now(), 'Poezi'),
  ('e0850001-0000-4000-8000-0000000000b3', 'e0850000-0000-4000-8000-00000000000a', 'G085 Letersi', 'published', 199, now(), 'Letërsi artistike');

-- part1
select pg_temp.assert(
  (select count(*) from pg_catalog.pg_constraint
    where conrelid = 'public.books'::regclass and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) like '%genre%') = 1,
  'part1: exactly one CHECK on books mentions genre');
select pg_temp.assert(
  exists (select 1 from pg_catalog.pg_constraint
           where conrelid = 'public.books'::regclass and conname = 'books_genre_check'),
  'part1: the CHECK is named books_genre_check');

do $$
declare
  v_genre text;
begin
  foreach v_genre in array array[
    'Biografi & kujtime', 'Biznes & ekonomi', 'Drama & teatër',
    'Fantashkencë', 'Fantazi', 'Filozofi', 'Histori', 'Horror',
    'Letërsi artistike', 'Për fëmijë', 'Për të rinj', 'Poezi',
    'Policor & triler', 'Psikologji', 'Publicistikë & ese', 'Romancë',
    'Shkencë', 'Zhvillim personal'
  ] loop
    perform pg_temp.assert(pg_temp.try_genre(v_genre) = 'ok', 'part1: accepts ' || v_genre);
  end loop;
  perform pg_temp.assert(pg_temp.try_genre(null) = 'ok', 'part1: accepts NULL');

  foreach v_genre in array array[
    'Fiction', 'Non-Fiction', 'Mystery & Thriller', 'Romance', 'Fantasy',
    'Science Fiction', 'Biography & Memoir', 'Self-Help', 'History',
    'Poetry', 'Young Adult', 'Children''s', 'Business',
    'Letersi artistike', 'Poezi ', 'poezi', ''
  ] loop
    perform pg_temp.assert(pg_temp.try_genre(v_genre) = 'refused', 'part1: refuses "' || v_genre || '"');
  end loop;
  -- "ë" written as e + combining diaeresis (NFD) is a different string.
  perform pg_temp.assert(
    pg_temp.try_genre('Fantashkenc' || 'e' || chr(776)) = 'refused',
    'part1: refuses a decomposed (NFD) ë');
end $$;

-- part2
select pg_temp.assert(
  (select array_agg(b.title order by b.title)
     from public.search_books(null, 'Letërsi artistike', null, null, 50) s
     join public.books b on b.id = s.book_id
    where b.title like 'G085%') = array['G085 Letersi'],
  'part2: search_books filters by the Albanian genre');
select pg_temp.assert(
  not exists (select 1 from public.search_books(null, 'Fiction', null, null, 50) s
                 join public.books b on b.id = s.book_id
               where b.title like 'G085%'),
  'part2: an English genre filter finds nothing');

do $$
declare v_n int;
begin
  select n into v_n from pg_temp.assertions_run;
  raise warning '085_albanian_genres: % assertions passed', v_n;
  raise notice 'ALL PASSED: 085_albanian_genres.test.sql (% assertions)', v_n;
end $$;

rollback;
