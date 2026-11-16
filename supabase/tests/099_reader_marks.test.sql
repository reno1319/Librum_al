-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for K8 + K10
-- (supabase/migrations/20261115160000_reader_marks.sql): the reader's
-- place, bookmarks and highlights.
-- * part1  shape, RLS, grants, trigger functions not callable;
-- * part2  a buyer writes and reads their own marks; checks;
-- * part3  nobody else's rows; nothing in a book not owned;
-- * part4  the per-book limits;
-- * part5  a refund deletes the marks in that book only;
-- * part6  a deleted account deletes its marks.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/099_reader_marks.test.sql
--
-- Against the BASE schema it fails at part1 (no table): the negative
-- control. The rollback is 099_reader_marks.rollback.sql.

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

-- As a signed-in reader (role authenticated, auth.uid() = p_uid).
create function pg_temp.run_as_user(p_uid text, p_sql text) returns text
  language plpgsql as $$
declare
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', p_uid, true);
  v_out := pg_temp.run_as('authenticated', p_sql);
  perform set_config('request.jwt.claim.sub', '', true);
  return v_out;
end;
$$;

-- ============================================================
-- Fixture: author A with live books K and L; reader R owns K and L;
-- reader S owns K; reader T owns nothing.
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0990000-0000-4000-8000-00000000000a', 'p099-a@test', now(), '{"role":"author","display_name":"P099 Ana"}'),
  ('e0990000-0000-4000-8000-0000000000d1', 'p099-r@test', now(), '{"role":"reader","display_name":"P099 R"}'),
  ('e0990000-0000-4000-8000-0000000000d2', 'p099-s@test', now(), '{"role":"reader","display_name":"P099 S"}'),
  ('e0990000-0000-4000-8000-0000000000d3', 'p099-t@test', now(), '{"role":"reader","display_name":"P099 T"}');

insert into public.books (id, author_id, title, description, price_all, status, published_at, file_path, cover_path, categories)
values
  ('e0990001-0000-4000-8000-00000000000b', 'e0990000-0000-4000-8000-00000000000a', 'P099 K', 'K.', 199, 'published', now(),
   'a/k/v1.epub', 'e099000c-0000-4000-8000-00000000000b/cover.jpg', array['Horror']),
  ('e0990001-0000-4000-8000-00000000000c', 'e0990000-0000-4000-8000-00000000000a', 'P099 L', 'L.', 199, 'published', now(),
   'a/l/v1.epub', 'e099000c-0000-4000-8000-00000000000c/cover.jpg', array['Horror']);

insert into public.purchases (book_id, reader_id, amount_cents, stripe_checkout_session_id, stripe_payment_intent_id) values
  ('e0990001-0000-4000-8000-00000000000b', 'e0990000-0000-4000-8000-0000000000d1', 19900, 'cs_p099_1', 'pi_p099_1'),
  ('e0990001-0000-4000-8000-00000000000c', 'e0990000-0000-4000-8000-0000000000d1', 19900, 'cs_p099_2', 'pi_p099_2'),
  ('e0990001-0000-4000-8000-00000000000b', 'e0990000-0000-4000-8000-0000000000d2', 19900, 'cs_p099_3', 'pi_p099_3');

-- ============================================================
-- Part 1: shape, RLS on, one policy each, grants
-- ============================================================
select pg_temp.assert(
  (select string_agg(a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text, ',' order by a.attnum)
     from pg_attribute a where a.attrelid = 'public.reading_places'::regclass and a.attnum > 0 and not a.attisdropped)
  = 'user_id:uuid:true,book_id:uuid:true,char_offset:integer:true,progress:numeric(5,4):true,updated_at:timestamp with time zone:true',
  'part1: reading_places columns');
select pg_temp.assert(
  (select string_agg(a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text, ',' order by a.attnum)
     from pg_attribute a where a.attrelid = 'public.reader_highlights'::regclass and a.attnum > 0 and not a.attisdropped)
  = 'id:uuid:true,user_id:uuid:true,book_id:uuid:true,start_offset:integer:true,end_offset:integer:true,quote:text:true,prefix:text:true,suffix:text:true,color:text:true,note:text:false,orphaned_at:timestamp with time zone:false,created_at:timestamp with time zone:true,updated_at:timestamp with time zone:true',
  'part1: reader_highlights columns');
select pg_temp.assert(
  (select pg_catalog.count(*) from pg_class c
    where c.oid in ('public.reading_places'::regclass, 'public.reader_bookmarks'::regclass, 'public.reader_highlights'::regclass)
      and c.relrowsecurity) = 3
  and (select pg_catalog.count(*) from pg_policy p
        where p.polrelid in ('public.reading_places'::regclass, 'public.reader_bookmarks'::regclass, 'public.reader_highlights'::regclass)) = 3,
  'part1: RLS on, one policy per table');
select pg_temp.assert(
  (select pg_catalog.count(*) from pg_constraint c
    where c.contype = 'f' and c.confdeltype = 'c'
      and c.conrelid in ('public.reading_places'::regclass, 'public.reader_bookmarks'::regclass, 'public.reader_highlights'::regclass)) = 6,
  'part1: user and book FKs cascade on all three');
select pg_temp.assert(
  not exists (select 1 from information_schema.role_table_grants g
               where g.table_schema = 'public' and g.table_name in ('reading_places', 'reader_bookmarks', 'reader_highlights')
                 and g.grantee in ('PUBLIC', 'anon', 'service_role'))
  and pg_temp.run_as('anon', $q$select 1 from public.reader_highlights$q$) like '42501:%'
  and pg_temp.run_as('service_role', $q$select 1 from public.reading_places$q$) like '42501:%',
  'part1: no grant to PUBLIC, anon or service_role');
select pg_temp.assert(
  not has_function_privilege('authenticated', 'public.reader_marks_enforce_limit()', 'execute')
  and not has_function_privilege('authenticated', 'public.reader_marks_delete_on_refund()', 'execute'),
  'part1: the trigger functions are not callable by readers');

-- ============================================================
-- Part 2: a reader writes and reads their own marks in an owned book
-- ============================================================
select pg_temp.assert(
  pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d1', $q$insert into public.reading_places (book_id, char_offset, progress)
    values ('e0990001-0000-4000-8000-00000000000b', 1200, 0.25)$q$) = 'OK:1',
  'part2: R saves a place (user_id from auth.uid())');
select pg_temp.assert(
  pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d1', $q$insert into public.reading_places (book_id, char_offset, progress)
    values ('e0990001-0000-4000-8000-00000000000b', 1500, 0.3)
    on conflict (user_id, book_id) do update set char_offset = excluded.char_offset, progress = excluded.progress, updated_at = now()$q$) = 'OK:1',
  'part2: R upserts the place');
select pg_temp.assert(
  (select char_offset from public.reading_places where user_id = 'e0990000-0000-4000-8000-0000000000d1') = 1500,
  'part2: the upsert replaced the place');
select pg_temp.assert(
  pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d1', $q$insert into public.reader_bookmarks (book_id, char_offset)
    values ('e0990001-0000-4000-8000-00000000000b', 1500), ('e0990001-0000-4000-8000-00000000000c', 10)$q$) = 'OK:2'
  and pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d1', $q$insert into public.reader_bookmarks (book_id, char_offset)
    values ('e0990001-0000-4000-8000-00000000000b', 1500)$q$) like '23505:%',
  'part2: R adds bookmarks; the same page twice is refused');
select pg_temp.assert(
  pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d1', $q$insert into public.reader_highlights (id, book_id, start_offset, end_offset, quote, prefix, suffix, color, note)
    values ('e0990002-0000-4000-8000-000000000001', 'e0990001-0000-4000-8000-00000000000b', 100, 110, 'abcdefghij', 'x', 'y', 'yellow', 'Shënim'),
           ('e0990002-0000-4000-8000-000000000002', 'e0990001-0000-4000-8000-00000000000c', 5, 9, 'abcd', '', '', 'pink', null)$q$) = 'OK:2',
  'part2: R adds highlights');
select pg_temp.assert(
  pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d1', $q$update public.reader_highlights set color = 'green', note = 'Tjetër', updated_at = now()
    where id = 'e0990002-0000-4000-8000-000000000001'$q$) = 'OK:1'
  and pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d1', $q$update public.reader_highlights set start_offset = 200, end_offset = 210, orphaned_at = now()
    where id = 'e0990002-0000-4000-8000-000000000001'$q$) = 'OK:1',
  'part2: R changes colour, note, span and orphaned_at');
select pg_temp.assert(
  pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d1', $q$update public.reader_highlights set quote = 'x' where id = 'e0990002-0000-4000-8000-000000000001'$q$) like '42501:%'
  and pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d1', $q$update public.reader_highlights set book_id = 'e0990001-0000-4000-8000-00000000000c' where id = 'e0990002-0000-4000-8000-000000000001'$q$) like '42501:%'
  and pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d1', $q$update public.reader_highlights set user_id = 'e0990000-0000-4000-8000-0000000000d2' where id = 'e0990002-0000-4000-8000-000000000001'$q$) like '42501:%'
  and pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d1', $q$update public.reader_bookmarks set char_offset = 1 where book_id = 'e0990001-0000-4000-8000-00000000000c'$q$) like '42501:%',
  'part2: the quote, book, owner and a bookmark''s place can''t be changed');
select pg_temp.assert(
  pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d1', $q$insert into public.reader_highlights (book_id, start_offset, end_offset, quote, color)
    values ('e0990001-0000-4000-8000-00000000000b', 1, 2, 'a', 'red')$q$) like '23514:%'
  and pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d1', $q$insert into public.reader_highlights (book_id, start_offset, end_offset, quote, color)
    values ('e0990001-0000-4000-8000-00000000000b', 5, 5, 'a', 'blue')$q$) like '23514:%'
  and pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d1', format($q$insert into public.reader_highlights (book_id, start_offset, end_offset, quote, color, note)
    values ('e0990001-0000-4000-8000-00000000000b', 1, 2, 'a', 'blue', %L)$q$, repeat('n', 1001))) like '23514:%'
  and pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d1', $q$insert into public.reader_highlights (book_id, start_offset, end_offset, quote, color, note)
    values ('e0990001-0000-4000-8000-00000000000b', 1, 2, 'a', 'blue', '')$q$) like '23514:%'
  and pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d1', format($q$insert into public.reader_highlights (book_id, start_offset, end_offset, quote, color)
    values ('e0990001-0000-4000-8000-00000000000b', 1, 2, %L, 'blue')$q$, repeat('q', 4001))) like '23514:%'
  and pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d1', $q$insert into public.reading_places (book_id, char_offset, progress)
    values ('e0990001-0000-4000-8000-00000000000c', 1, 1.5)$q$) like '23514:%',
  'part2: an unknown colour, an empty span, a long or empty note, a long quote and progress > 1 are refused');
select pg_temp.assert(
  pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d1', format($q$insert into public.reader_highlights (book_id, start_offset, end_offset, quote, color, note)
    values ('e0990001-0000-4000-8000-00000000000b', 1, 2, 'a', 'blue', %L)$q$, repeat('n', 1000))) = 'OK:1',
  'part2: a 1,000-character note is fine');

select pg_temp.assert(
  pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d1', $q$select public.reader_highlights_reanchor('e0990001-0000-4000-8000-00000000000b',
    '[{"id":"e0990002-0000-4000-8000-000000000001","start_offset":300,"end_offset":310}]'::jsonb, '{}'::uuid[])$q$) = 'OK:1',
  'part2: re-anchor runs');
-- Separate statements: the planner may read a subquery before the call.
select pg_temp.assert(
  (select start_offset = 300 and end_offset = 310 and orphaned_at is null from public.reader_highlights where id = 'e0990002-0000-4000-8000-000000000001'),
  'part2: re-anchor moved a found highlight and cleared orphaned_at');
select pg_temp.assert(
  pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d1', $q$select public.reader_highlights_reanchor('e0990001-0000-4000-8000-00000000000b',
    '[]'::jsonb, array['e0990002-0000-4000-8000-000000000001']::uuid[])$q$) = 'OK:1',
  'part2: re-anchor runs for a not-found highlight');
select pg_temp.assert(
  (select orphaned_at is not null from public.reader_highlights where id = 'e0990002-0000-4000-8000-000000000001'),
  'part2: re-anchor marked it not found');
select pg_temp.assert(
  pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d2', $q$select public.reader_highlights_reanchor('e0990001-0000-4000-8000-00000000000b',
    '[{"id":"e0990002-0000-4000-8000-000000000001","start_offset":1,"end_offset":2}]'::jsonb, '{}'::uuid[])$q$) = 'OK:1'
  and pg_temp.run_as('anon', $q$select public.reader_highlights_reanchor('e0990001-0000-4000-8000-00000000000b', '[]'::jsonb, '{}'::uuid[])$q$) like '42501:%',
  'part2: S''s re-anchor call runs; anon can''t call it');
select pg_temp.assert(
  (select start_offset = 300 from public.reader_highlights where id = 'e0990002-0000-4000-8000-000000000001'),
  'part2: S''s call did not move R''s highlight');

-- ============================================================
-- Part 3: nobody else's rows, and nothing in a book not owned
-- ============================================================
select pg_temp.assert(
  pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d2', $q$select 1 from public.reader_highlights$q$) = 'OK:0'
  and pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d2', $q$select 1 from public.reading_places$q$) = 'OK:0'
  and pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d2', $q$update public.reader_highlights set color = 'blue'$q$) = 'OK:0'
  and pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d2', $q$delete from public.reader_bookmarks$q$) = 'OK:0',
  'part3: S sees, changes and deletes none of R''s rows');
select pg_temp.assert(
  pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d2', $q$insert into public.reader_bookmarks (user_id, book_id, char_offset)
    values ('e0990000-0000-4000-8000-0000000000d1', 'e0990001-0000-4000-8000-00000000000b', 7)$q$) like '42501:%',
  'part3: S can''t write a row in R''s name');
select pg_temp.assert(
  pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d2', $q$insert into public.reader_bookmarks (book_id, char_offset)
    values ('e0990001-0000-4000-8000-00000000000c', 7)$q$) like '42501:%'
  and pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d3', $q$insert into public.reading_places (book_id, char_offset, progress)
    values ('e0990001-0000-4000-8000-00000000000b', 7, 0)$q$) like '42501:%'
  and pg_temp.run_as_user('e0990000-0000-4000-8000-00000000000a', $q$insert into public.reader_highlights (book_id, start_offset, end_offset, quote, color)
    values ('e0990001-0000-4000-8000-00000000000b', 1, 2, 'a', 'blue')$q$) like '42501:%',
  'part3: no marks in a book the caller does not own (a non-buyer, a stranger, the author)');
select pg_temp.assert(
  pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d2', $q$insert into public.reader_highlights (book_id, start_offset, end_offset, quote, color)
    values ('e0990001-0000-4000-8000-00000000000b', 1, 2, 'a', 'blue')$q$) = 'OK:1',
  'part3: S marks the book S owns');

-- ============================================================
-- Part 4: per-book limits (3,000 highlights, 500 bookmarks)
-- ============================================================
insert into public.reader_highlights (user_id, book_id, start_offset, end_offset, quote, color)
  select 'e0990000-0000-4000-8000-0000000000d2', 'e0990001-0000-4000-8000-00000000000b', g, g + 1, 'a', 'yellow'
    from generate_series(2, 3000) g;
select pg_temp.assert(
  (select pg_catalog.count(*) from public.reader_highlights where user_id = 'e0990000-0000-4000-8000-0000000000d2') = 3000,
  'part4: S has 3,000 highlights in K');
select pg_temp.assert(
  pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d2', $q$insert into public.reader_highlights (book_id, start_offset, end_offset, quote, color)
    values ('e0990001-0000-4000-8000-00000000000b', 1, 2, 'a', 'blue')$q$) = '23514:reader_marks_limit',
  'part4: the 3,001st is refused (23514 reader_marks_limit)');
insert into public.reader_bookmarks (user_id, book_id, char_offset)
  select 'e0990000-0000-4000-8000-0000000000d2', 'e0990001-0000-4000-8000-00000000000b', g from generate_series(1, 500) g;
select pg_temp.assert(
  pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d2', $q$insert into public.reader_bookmarks (book_id, char_offset)
    values ('e0990001-0000-4000-8000-00000000000b', 9999)$q$) = '23514:reader_marks_limit'
  and pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d1', $q$insert into public.reader_bookmarks (book_id, char_offset)
    values ('e0990001-0000-4000-8000-00000000000b', 9999)$q$) = 'OK:1',
  'part4: the 501st bookmark is refused; the limit is per reader');

-- ============================================================
-- Part 5: a refund deletes the reader's marks in that book only
-- ============================================================
update public.purchases set amount_cents = amount_cents
 where reader_id = 'e0990000-0000-4000-8000-0000000000d1' and book_id = 'e0990001-0000-4000-8000-00000000000b';
select pg_temp.assert(
  (select pg_catalog.count(*) from public.reader_bookmarks where user_id = 'e0990000-0000-4000-8000-0000000000d1') = 3,
  'part5: an update that is not a refund deletes nothing');
update public.purchases set refunded_at = now()
 where reader_id = 'e0990000-0000-4000-8000-0000000000d1' and book_id = 'e0990001-0000-4000-8000-00000000000b';
select pg_temp.assert(
  not exists (select 1 from public.reading_places where user_id = 'e0990000-0000-4000-8000-0000000000d1' and book_id = 'e0990001-0000-4000-8000-00000000000b')
  and not exists (select 1 from public.reader_bookmarks where user_id = 'e0990000-0000-4000-8000-0000000000d1' and book_id = 'e0990001-0000-4000-8000-00000000000b')
  and not exists (select 1 from public.reader_highlights where user_id = 'e0990000-0000-4000-8000-0000000000d1' and book_id = 'e0990001-0000-4000-8000-00000000000b'),
  'part5: R''s place, bookmarks and highlights in K are gone');
select pg_temp.assert(
  (select pg_catalog.count(*) from public.reader_bookmarks where user_id = 'e0990000-0000-4000-8000-0000000000d1' and book_id = 'e0990001-0000-4000-8000-00000000000c') = 1
  and (select pg_catalog.count(*) from public.reader_highlights where user_id = 'e0990000-0000-4000-8000-0000000000d1' and book_id = 'e0990001-0000-4000-8000-00000000000c') = 1
  and (select pg_catalog.count(*) from public.reader_highlights where user_id = 'e0990000-0000-4000-8000-0000000000d2') = 3000,
  'part5: R''s marks in L and S''s marks in K stay');
select pg_temp.assert(
  pg_temp.run_as_user('e0990000-0000-4000-8000-0000000000d1', $q$insert into public.reader_bookmarks (book_id, char_offset)
    values ('e0990001-0000-4000-8000-00000000000b', 1)$q$) like '42501:%',
  'part5: after the refund R can''t mark K');

-- ============================================================
-- Part 6: a deleted account deletes its marks
-- ============================================================
delete from public.profiles where id = 'e0990000-0000-4000-8000-0000000000d2';
select pg_temp.assert(
  not exists (select 1 from public.reader_highlights where user_id = 'e0990000-0000-4000-8000-0000000000d2')
  and not exists (select 1 from public.reader_bookmarks where user_id = 'e0990000-0000-4000-8000-0000000000d2'),
  'part6: S''s marks went with S''s profile');

select pg_temp.assert((select n from pg_temp.assertions_run) >= 25, 'all assertions ran');

rollback;
