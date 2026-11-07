-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for Upload notes D
-- (supabase/migrations/20261107140000_page_estimate.sql): the page
-- estimate's word counts.
-- * part1  book_file_words: shape, keys, checks, RLS on with no policy;
-- * part2  grants: service_role SELECT/INSERT/UPDATE only, readers none;
-- * part3  public_books.word_count: the count of the book's CURRENT
--          file only, null otherwise; last column; rows go with the book.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/098_page_estimate.test.sql
--
-- Against the BASE schema it fails at part1 (no table): the negative
-- control. The rollback is 098_page_estimate.rollback.sql.

begin;

set local client_min_messages = warning;

create table pg_temp.assertions_run (n integer not null);
insert into pg_temp.assertions_run values (0);
grant select, update on pg_temp.assertions_run to anon, authenticated, service_role;

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  update pg_temp.assertions_run set n = n + 1;
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

-- Runs p_sql as p_role (null = the table owner); returns 'OK:<rows>' or
-- '<sqlstate>:<message>'.
create function pg_temp.run_as(p_role text, p_sql text) returns text
  language plpgsql as $$
declare
  v_state text;
  v_msg text;
  v_rows bigint;
  v_out text;
begin
  if p_role is not null then
    execute format('set local role %I', p_role);
  end if;
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
    v_out := 'OK:' || v_rows;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_out := v_state || ':' || v_msg;
  end;
  reset role;
  return v_out;
end;
$$;

-- ============================================================
-- Fixture: author A. L a live book with file v2 (v1 was its old file),
-- D a draft with no file, X a live book to delete.
-- ============================================================
-- Part 3 swaps a live book's file by hand; the live-file guard (only
-- approval may) is set aside for this test. The transaction rolls back.
alter table public.books disable trigger books_refuse_live_file_change;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0980000-0000-4000-8000-00000000000a', 'p098-a@test', now(), '{"role":"author","display_name":"P098 Ana"}');

insert into public.books (id, author_id, title, description, price_all, status, published_at, file_path, cover_path, categories)
values
  ('e0980001-0000-4000-8000-00000000000a', 'e0980000-0000-4000-8000-00000000000a', 'P098 Live', 'Live.', 0, 'published', now(),
   'a/l/v2.epub', 'e098000c-0000-4000-8000-00000000000a/cover.jpg', array['Horror']),
  ('e0980001-0000-4000-8000-00000000000d', 'e0980000-0000-4000-8000-00000000000a', 'P098 Draft', 'Draft.', 0, 'draft', null,
   null, null, array['Horror']),
  ('e0980001-0000-4000-8000-00000000000c', 'e0980000-0000-4000-8000-00000000000a', 'P098 Gone', 'Gone.', 0, 'published', now(),
   'a/x/v1.epub', 'e098000c-0000-4000-8000-00000000000c/cover.jpg', array['Horror']);

-- ============================================================
-- Part 1: the table
-- ============================================================
select pg_temp.assert(
  (select string_agg(a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text, ',' order by a.attnum)
     from pg_attribute a
    where a.attrelid = 'public.book_file_words'::regclass and a.attnum > 0 and not a.attisdropped)
  = 'book_id:uuid:true,file_path:text:true,word_count:integer:true,counted_at:timestamp with time zone:true',
  'part1: book_file_words columns, all not null');
select pg_temp.assert(
  (select pg_catalog.pg_get_constraintdef(c.oid) from pg_constraint c
    where c.conrelid = 'public.book_file_words'::regclass and c.contype = 'p') = 'PRIMARY KEY (book_id, file_path)',
  'part1: one row per book and file');
select pg_temp.assert(
  (select c.confdeltype = 'c' and c.confrelid = 'public.books'::regclass from pg_constraint c
    where c.conrelid = 'public.book_file_words'::regclass and c.contype = 'f'),
  'part1: book_id references books ON DELETE CASCADE');
select pg_temp.assert(
  (select c.relrowsecurity from pg_class c where c.oid = 'public.book_file_words'::regclass)
  and not exists (select 1 from pg_policy p where p.polrelid = 'public.book_file_words'::regclass),
  'part1: RLS on, no policy');
select pg_temp.assert(
  pg_temp.run_as('service_role', $q$insert into public.book_file_words (book_id, file_path, word_count)
    values ('e0980001-0000-4000-8000-00000000000a', 'a/l/v2.epub', -1)$q$) like '23514:%'
  and pg_temp.run_as('service_role', $q$insert into public.book_file_words (book_id, file_path, word_count)
    values ('e0980001-0000-4000-8000-00000000000a', '', 10)$q$) like '23514:%'
  and pg_temp.run_as('service_role', $q$insert into public.book_file_words (book_id, file_path, word_count)
    values ('e0980001-0000-4000-8000-00000000000f', 'a/f/v1.epub', 10)$q$) like '23503:%',
  'part1: a negative count, an empty path and an unknown book are refused');

-- ============================================================
-- Part 2: grants
-- ============================================================
select pg_temp.assert(
  pg_temp.run_as('service_role', $q$insert into public.book_file_words (book_id, file_path, word_count)
    values ('e0980001-0000-4000-8000-00000000000a', 'a/l/v1.epub', 1000),
           ('e0980001-0000-4000-8000-00000000000a', 'a/l/v2.epub', 45700),
           ('e0980001-0000-4000-8000-00000000000c', 'a/x/v1.epub', 500)$q$) = 'OK:3',
  'part2: service_role inserts');
select pg_temp.assert(
  pg_temp.run_as('service_role', $q$insert into public.book_file_words (book_id, file_path, word_count)
    values ('e0980001-0000-4000-8000-00000000000a', 'a/l/v2.epub', 45750)
    on conflict (book_id, file_path) do update set word_count = excluded.word_count, counted_at = now()$q$) = 'OK:1',
  'part2: service_role upserts (the website''s write)');
-- A separate statement: the planner may read a subquery before the call.
select pg_temp.assert(
  (select word_count from public.book_file_words
    where book_id = 'e0980001-0000-4000-8000-00000000000a' and file_path = 'a/l/v2.epub') = 45750,
  'part2: the upsert replaced the count');
select pg_temp.assert(
  pg_temp.run_as('service_role', $q$delete from public.book_file_words$q$) like '42501:%',
  'part2: service_role can''t delete');
select pg_temp.assert(
  pg_temp.run_as('anon', $q$select 1 from public.book_file_words$q$) like '42501:%'
  and pg_temp.run_as('authenticated', $q$select 1 from public.book_file_words$q$) like '42501:%'
  and pg_temp.run_as('authenticated', $q$insert into public.book_file_words (book_id, file_path, word_count)
    values ('e0980001-0000-4000-8000-00000000000d', 'a/d/v1.epub', 1)$q$) like '42501:%',
  'part2: anon and authenticated can neither read nor write it');
select pg_temp.assert(
  not exists (select 1 from information_schema.role_table_grants g
               where g.table_schema = 'public' and g.table_name = 'book_file_words'
                 and g.grantee in ('PUBLIC', 'anon', 'authenticated')),
  'part2: no grant to PUBLIC, anon or authenticated');

-- ============================================================
-- Part 3: public_books.word_count
-- ============================================================
select pg_temp.assert(
  (select a.attname from pg_attribute a
    where a.attrelid = 'public.public_books'::regclass and a.attnum > 0 and not a.attisdropped
    order by a.attnum desc limit 1) = 'word_count'
  and (select pg_catalog.format_type(a.atttypid, a.atttypmod) from pg_attribute a
        where a.attrelid = 'public.public_books'::regclass and a.attname = 'word_count') = 'integer',
  'part3: word_count (integer) is public_books'' last column');
select pg_temp.assert(
  (select word_count from public.public_books where id = 'e0980001-0000-4000-8000-00000000000a') = 45750,
  'part3: the live book shows its CURRENT file''s count (not the old file''s)');
select pg_temp.assert(
  pg_temp.run_as('anon', $q$select word_count from public.public_books where id = 'e0980001-0000-4000-8000-00000000000a' and word_count = 45750$q$) = 'OK:1'
  and pg_temp.run_as('authenticated', $q$select word_count from public.public_books$q$) like 'OK:%',
  'part3: anon and authenticated read it through the view');
update public.books set file_path = 'a/l/v3.epub' where id = 'e0980001-0000-4000-8000-00000000000a';
select pg_temp.assert(
  (select word_count is null from public.public_books where id = 'e0980001-0000-4000-8000-00000000000a'),
  'part3: a new file with no count yet shows none');
update public.books set file_path = 'a/l/v1.epub' where id = 'e0980001-0000-4000-8000-00000000000a';
select pg_temp.assert(
  (select word_count from public.public_books where id = 'e0980001-0000-4000-8000-00000000000a') = 1000,
  'part3: the count follows file_path');
-- Another book's row for the same path is never borrowed.
insert into public.book_file_words (book_id, file_path, word_count)
  values ('e0980001-0000-4000-8000-00000000000c', 'a/l/v1.epub', 7);
select pg_temp.assert(
  (select word_count from public.public_books where id = 'e0980001-0000-4000-8000-00000000000a') = 1000,
  'part3: only the book''s own row counts');
delete from public.books where id = 'e0980001-0000-4000-8000-00000000000c';
select pg_temp.assert(
  not exists (select 1 from public.book_file_words where book_id = 'e0980001-0000-4000-8000-00000000000c'),
  'part3: a deleted book''s counts go with it');
select pg_temp.assert(
  pg_temp.run_as('anon', $q$select 1 from public.books$q$) like '42501:%',
  'part3: anon still can''t read books itself');

select pg_temp.assert((select n from pg_temp.assertions_run) >= 16, 'all assertions ran');

rollback;
