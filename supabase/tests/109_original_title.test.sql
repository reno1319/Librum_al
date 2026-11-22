-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for X19
-- (supabase/migrations/20261121180000_original_title.sql):
--
-- * part1 the column: books.original_title is nullable text with one
--   named CHECK (books_original_title_check): trimmed, 1..300
--   characters, no control characters.
-- * part2 who reads and writes it: public_books shows it (its last
--   column) for a published book; a draft stays its author's; an author
--   session may not write it (only the service-role catalog writer).
-- * part3 search_books(): finds a published book by its original title,
--   accent-blind, for anon and authenticated; never a draft; a book
--   without one is still found by its title.
-- * part4 LB490: a book waiting for review can't change its original
--   title; once the review is no longer pending it can.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance (on 16 strip ", maintain" from a copy of schema.sql):
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/109_original_title.test.sql
--
-- Against the BASE schema it fails at part1 (no column): the negative
-- control. Everything runs inside one transaction and is rolled back.

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

-- 'ok' when this original_title value is accepted on the draft probe
-- book, 'refused' on a CHECK violation. Each try is undone.
create function pg_temp.try_value(p_value text) returns text
  language plpgsql as $$
begin
  update public.books set original_title = p_value where id = 'e1091000-0000-4000-8000-0000000000a2';
  raise exception using errcode = 'P0001', message = 'probe ok';
exception
  when check_violation then return 'refused';
  when raise_exception then
    if sqlerrm = 'probe ok' then return 'ok'; end if;
    raise;
end;
$$;

-- Runs one statement as a role with a JWT subject; 'OK:<rows>' or the
-- error code.
create function pg_temp.run_as(p_role text, p_uid uuid, p_sql text) returns text
  language plpgsql as $$
declare
  v_rows bigint;
  v_out text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
    v_out := 'OK:' || v_rows;
  exception when others then
    v_out := sqlstate;
  end;
  reset role;
  return v_out;
end;
$$;

-- Runs one query as a role and returns its single text value (or the
-- error code).
create function pg_temp.value_as(p_role text, p_uid uuid, p_sql text) returns text
  language plpgsql as $$
declare
  v_out text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql into v_out;
  exception when others then
    v_out := 'ERR:' || sqlstate;
  end;
  reset role;
  return v_out;
end;
$$;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e1090000-0000-4000-8000-00000000000a', 'r109-a@test', now(), '{"role":"author","display_name":"R109 A"}'),
  ('e1090000-0000-4000-8000-00000000000b', 'r109-b@test', now(), '{"role":"reader","display_name":"R109 B"}');

insert into public.books (id, author_id, title, description, keywords, status, price_all, published_at, original_author, original_title) values
  ('e1091000-0000-4000-8000-0000000000a1', 'e1090000-0000-4000-8000-00000000000a', 'R109 Ylli', 'x', '', 'published', 0, now(), 'Jane Example', 'The Last Stär'),
  ('e1091000-0000-4000-8000-0000000000a2', 'e1090000-0000-4000-8000-00000000000a', 'R109 Draft', 'x', '', 'draft', 0, null, 'Jane Example', 'The Last Stär'),
  ('e1091000-0000-4000-8000-0000000000a3', 'e1090000-0000-4000-8000-00000000000a', 'R109 Own', 'x', '', 'published', 0, now(), null, null);

-- part1
select pg_temp.assert(
  (select not a.attnotnull and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'text'
     from pg_catalog.pg_attribute a
    where a.attrelid = 'public.books'::regclass and a.attname = 'original_title' and not a.attisdropped),
  'part1: books.original_title is nullable text');
select pg_temp.assert(
  (select count(*) from pg_catalog.pg_constraint
    where conrelid = 'public.books'::regclass and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) like '%original_title%') = 1
  and exists (select 1 from pg_catalog.pg_constraint
               where conrelid = 'public.books'::regclass and conname = 'books_original_title_check' and convalidated),
  'part1: exactly one CHECK mentions original_title, named books_original_title_check, validated');

do $$
declare
  v text;
begin
  foreach v in array array['The Egg', 'The Great God Pan', 'A', 'Война и мир', 'L''Étranger', repeat('ë', 300)] loop
    perform pg_temp.assert(pg_temp.try_value(v) = 'ok', 'part1: accepts "' || left(v, 20) || '"');
  end loop;
  foreach v in array array['', ' ', ' The Egg', 'The Egg ', 'The' || chr(9) || 'Egg', 'The' || chr(10) || 'Egg',
                           'The' || chr(127) || 'Egg', repeat('a', 301)] loop
    perform pg_temp.assert(pg_temp.try_value(v) = 'refused', 'part1: refuses "' || left(replace(v, chr(10), '\n'), 20) || '"');
  end loop;
  perform pg_temp.assert(pg_temp.try_value(null) = 'ok', 'part1: accepts NULL');
end $$;

-- part2
select pg_temp.assert(
  (select a.attname from pg_catalog.pg_attribute a
    where a.attrelid = 'public.public_books'::regclass and a.attnum > 0 and not a.attisdropped
    order by a.attnum desc limit 1) = 'original_title',
  'part2: original_title is public_books'' last column');

do $$
declare
  v text;
begin
  v := pg_temp.value_as('anon', null,
    $q$select original_title from public.public_books where id = 'e1091000-0000-4000-8000-0000000000a1'$q$);
  perform pg_temp.assert(v = 'The Last Stär', format('part2: anon reads a published book''s original title -- got %s', v));
  v := pg_temp.value_as('anon', null,
    $q$select count(*)::text from public.public_books where id = 'e1091000-0000-4000-8000-0000000000a2'$q$);
  perform pg_temp.assert(v = '0', format('part2: anon does not see a draft -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e1090000-0000-4000-8000-00000000000b',
    $q$select count(*)::text from public.public_books where id = 'e1091000-0000-4000-8000-0000000000a2'$q$);
  perform pg_temp.assert(v = '0', format('part2: another account does not see a draft -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e1090000-0000-4000-8000-00000000000a',
    $q$select original_title from public.public_books where id = 'e1091000-0000-4000-8000-0000000000a2'$q$);
  perform pg_temp.assert(v = 'The Last Stär', format('part2: the author reads their draft''s original title -- got %s', v));

  v := pg_temp.run_as('authenticated', 'e1090000-0000-4000-8000-00000000000a',
    $q$update public.books set original_title = 'X' where id = 'e1091000-0000-4000-8000-0000000000a1'$q$);
  perform pg_temp.assert(v = '42501', format('part2: an author session may not update original_title -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e1090000-0000-4000-8000-00000000000a',
    $q$update public.public_books set original_title = 'X' where id = 'e1091000-0000-4000-8000-0000000000a1'$q$);
  perform pg_temp.assert(v = '42501', format('part2: nobody writes through public_books -- got %s', v));
  v := pg_temp.run_as('service_role', null,
    $q$update public.books set original_title = 'The Last Star' where id = 'e1091000-0000-4000-8000-0000000000a3'$q$);
  perform pg_temp.assert(v = 'OK:1', format('part2: the catalog writer sets a live book''s original title at once -- got %s', v));
end $$;

select pg_temp.assert(
  (select original_title from public.books where id = 'e1091000-0000-4000-8000-0000000000a1') = 'The Last Stär',
  'part2: the refused writes changed nothing');
update public.books set original_title = null where id = 'e1091000-0000-4000-8000-0000000000a3';

-- part3
do $$
declare
  v text;
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    v := pg_temp.value_as(r, 'e1090000-0000-4000-8000-00000000000b',
      $q$select string_agg(book_id::text, ',' order by book_id) from public.search_books('last star', null, null, null, 500)$q$);
    perform pg_temp.assert(v = 'e1091000-0000-4000-8000-0000000000a1',
      format('part3: %s finds the published book by its original title, accent-blind, never the draft -- got %s', r, v));
    v := pg_temp.value_as(r, 'e1090000-0000-4000-8000-00000000000b',
      $q$select count(*)::text from public.search_books('Great God', null, null, null, 500)$q$);
    perform pg_temp.assert(v = '0', format('part3: %s gets no false match -- got %s', r, v));
    v := pg_temp.value_as(r, 'e1090000-0000-4000-8000-00000000000b',
      $q$select count(*)::text from public.search_books('R109 Own', null, null, null, 500)$q$);
    perform pg_temp.assert(v = '1', format('part3: %s still finds a book without one by its title -- got %s', r, v));
  end loop;
end $$;

-- part4: LB490
insert into public.book_reviews (id, book_id, book_title, author_id, status)
values ('e1092000-0000-4000-8000-0000000000a1', 'e1091000-0000-4000-8000-0000000000a2', 'R109 Draft',
        'e1090000-0000-4000-8000-00000000000a', 'pending');

do $$
declare
  v text;
begin
  v := pg_temp.run_as('service_role', null,
    $q$update public.books set original_title = 'Other' where id = 'e1091000-0000-4000-8000-0000000000a2'$q$);
  perform pg_temp.assert(v = 'LB490', format('part4: a book waiting for review keeps its original title -- got %s', v));
  v := pg_temp.run_as('service_role', null,
    $q$update public.books set original_title = 'The Last Stär' where id = 'e1091000-0000-4000-8000-0000000000a2'$q$);
  perform pg_temp.assert(v = 'OK:1', format('part4: an unchanged value is not refused -- got %s', v));
  v := pg_temp.run_as('service_role', null,
    $q$update public.books set original_title = 'Other' where id = 'e1091000-0000-4000-8000-0000000000a1'$q$);
  perform pg_temp.assert(v = 'OK:1', format('part4: another book is not locked -- got %s', v));
end $$;

update public.book_reviews set status = 'withdrawn', decided_at = now() where id = 'e1092000-0000-4000-8000-0000000000a1';

do $$
declare
  v text;
begin
  v := pg_temp.run_as('service_role', null,
    $q$update public.books set original_title = 'Other' where id = 'e1091000-0000-4000-8000-0000000000a2'$q$);
  perform pg_temp.assert(v = 'OK:1', format('part4: the lock ends with the pending review -- got %s', v));
end $$;

do $$
declare v_n int;
begin
  select n into v_n from pg_temp.assertions_run;
  if v_n < 33 then
    raise exception 'FAIL: only % assertions ran (expected at least 33)', v_n;
  end if;
  raise warning '109_original_title: % assertions passed', v_n;
  raise notice 'ALL PASSED: 109_original_title.test.sql (% assertions)', v_n;
end $$;

rollback;
