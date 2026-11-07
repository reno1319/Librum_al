-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for Upload notes C
-- (supabase/migrations/20261107120000_book_type.sql): books.book_type,
-- "Lloji i librit".
-- * part1  the column: nullable, eight values only, existing rows null;
-- * part2  a draft and a live book change it straight away (no review);
-- * part3  a book waiting for review can't change it (LB490);
-- * part4  a picked public-domain edition: a first choice is allowed,
--          a change after that is refused (LB497); the owner may;
-- * part5  public_books carries it, as its last column, grants kept.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/097_book_type.test.sql
--
-- Against the BASE schema it fails at part1 (no column): the negative
-- control. The rollback is 097_book_type.rollback.sql.

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

create function pg_temp.type_of(p_book uuid) returns text language sql as $$
  select coalesce((select book_type from public.books where id = p_book), '<null>')
$$;

-- ============================================================
-- Fixture: author A. D a draft, L a live book, R a draft waiting for
-- review, P a public-domain draft that Librum picked as its work's
-- edition.
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0970000-0000-4000-8000-00000000000a', 'p097-a@test', now(), '{"role":"author","display_name":"P097 Ana"}');

insert into public.books (id, author_id, title, description, price_all, status, published_at, file_path, cover_path, categories, original_author)
values
  ('e0970001-0000-4000-8000-00000000000d', 'e0970000-0000-4000-8000-00000000000a', 'P097 Draft', 'Draft.', 0, 'draft', null,
   null, null, array['Horror'], null),
  ('e0970001-0000-4000-8000-00000000000a', 'e0970000-0000-4000-8000-00000000000a', 'P097 Live', 'Live.', 0, 'published', now(),
   'a/l/v1.epub', 'e097000c-0000-4000-8000-00000000000a/cover.jpg', array['Horror'], null),
  ('e0970001-0000-4000-8000-00000000000b', 'e0970000-0000-4000-8000-00000000000a', 'P097 In review', 'Review.', 0, 'draft', null,
   'a/r/v1.epub', 'e097000c-0000-4000-8000-00000000000b/cover.jpg', array['Horror'], null),
  ('e0970001-0000-4000-8000-00000000000c', 'e0970000-0000-4000-8000-00000000000a', 'P097 Picked', 'Picked.', 0, 'draft', null,
   'a/p/v1.epub', 'e097000c-0000-4000-8000-00000000000c/cover.jpg', array['Poezi'], 'P097 Classic');

insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, original_author, description, is_adult,
                                 status, submitted_at)
select bo.id, bo.title, bo.author_id, bo.file_path, bo.cover_path, bo.original_author, bo.description, bo.is_adult,
       'pending', now() - interval '1 hour'
  from public.books bo where bo.id = 'e0970001-0000-4000-8000-00000000000b';

insert into public.pd_works (id, title, original_author) values
  ('e0970002-0000-4000-8000-00000000000c', 'P097 Classic work', 'P097 Classic');
update public.books set pd_work_id = 'e0970002-0000-4000-8000-00000000000c'
 where id = 'e0970001-0000-4000-8000-00000000000c';
update public.pd_works set picked_book_id = 'e0970001-0000-4000-8000-00000000000c'
 where id = 'e0970002-0000-4000-8000-00000000000c';

-- ============================================================
-- Part 1: the column
-- ============================================================
select pg_temp.assert(
  (select a.attnotnull = false and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'text' and not a.atthasdef
     from pg_attribute a where a.attrelid = 'public.books'::regclass and a.attname = 'book_type'),
  'part1: books.book_type is a nullable text column with no default');
select pg_temp.assert(
  (select count(*) from public.books where book_type is not null) = 0,
  'part1: every book starts with no type');
select pg_temp.assert(
  pg_temp.run_as('service_role',
    $q$update public.books set book_type = 'Novelë' where id = 'e0970001-0000-4000-8000-00000000000d'$q$) like '23514:%',
  'part1: a value off the list is refused (check violation)');
select pg_temp.assert(
  pg_temp.run_as('service_role',
    $q$update public.books set book_type = 'roman' where id = 'e0970001-0000-4000-8000-00000000000d'$q$) like '23514:%',
  'part1: the list is case-exact');
select pg_temp.assert(
  pg_temp.run_as('service_role',
    $q$update public.books set book_type = '' where id = 'e0970001-0000-4000-8000-00000000000d'$q$) like '23514:%',
  'part1: an empty string is not "none"');
-- Every one of the eight values is accepted.
do $$
declare
  v text;
begin
  foreach v in array array['Roman', 'Novelë / tregim', 'Përmbledhje me tregime', 'Poezi', 'Dramë', 'Ese',
                           'Biografi & kujtime', 'Jo-artistik (studim, tjetër)']
  loop
    perform pg_temp.assert(
      pg_temp.run_as('service_role', format(
        'update public.books set book_type = %L where id = %L', v, 'e0970001-0000-4000-8000-00000000000d')) = 'OK:1'
      and pg_temp.type_of('e0970001-0000-4000-8000-00000000000d') = v,
      'part1: accepted ' || v);
  end loop;
end;
$$;
select pg_temp.assert(
  (select pg_catalog.array_length(regexp_split_to_array(pg_catalog.pg_get_constraintdef(c.oid), ''''), 1)
     from pg_constraint c
    where c.conrelid = 'public.books'::regclass and c.conname = 'books_book_type_check') = 17,
  'part1: books_book_type_check lists exactly eight values');
select pg_temp.assert(
  (select bool_and(v = normalize(v, NFC)) from unnest(array['Novelë / tregim', 'Përmbledhje me tregime', 'Dramë',
     'Jo-artistik (studim, tjetër)']) v)
  and pg_temp.type_of('e0970001-0000-4000-8000-00000000000d') = normalize(pg_temp.type_of('e0970001-0000-4000-8000-00000000000d'), NFC),
  'part1: the stored values are NFC');

-- ============================================================
-- Part 2: draft and live change it straight away
-- ============================================================
select pg_temp.assert(
  pg_temp.run_as('service_role',
    $q$update public.books set book_type = 'Roman' where id = 'e0970001-0000-4000-8000-00000000000d'$q$) = 'OK:1'
  and pg_temp.run_as('service_role',
    $q$update public.books set book_type = null where id = 'e0970001-0000-4000-8000-00000000000d'$q$) = 'OK:1'
  and pg_temp.type_of('e0970001-0000-4000-8000-00000000000d') = '<null>',
  'part2: a draft sets and clears its type');
select pg_temp.assert(
  pg_temp.run_as('service_role',
    $q$update public.books set book_type = 'Roman' where id = 'e0970001-0000-4000-8000-00000000000a' and status = 'published'$q$) = 'OK:1'
  and pg_temp.run_as('service_role',
    $q$update public.books set book_type = 'Ese' where id = 'e0970001-0000-4000-8000-00000000000a' and status = 'published'$q$) = 'OK:1'
  and pg_temp.type_of('e0970001-0000-4000-8000-00000000000a') = 'Ese'
  and (select status from public.books where id = 'e0970001-0000-4000-8000-00000000000a') = 'published'
  and not exists (select 1 from public.book_pending_changes where book_id = 'e0970001-0000-4000-8000-00000000000a')
  and not exists (select 1 from public.book_reviews where book_id = 'e0970001-0000-4000-8000-00000000000a'),
  'part2: a live book changes its type at once, stays live, nothing waits for review');
-- Authors never write books directly (no UPDATE grant): unchanged.
select pg_temp.assert(
  pg_temp.run_as('authenticated',
    $q$update public.books set book_type = 'Poezi' where id = 'e0970001-0000-4000-8000-00000000000a'$q$) like '42501:%',
  'part2: authenticated still has no UPDATE on books');

-- ============================================================
-- Part 3: in review (LB490)
-- ============================================================
select pg_temp.assert(
  pg_temp.run_as('service_role',
    $q$update public.books set book_type = 'Roman' where id = 'e0970001-0000-4000-8000-00000000000b'$q$) like 'LB490:%'
  and pg_temp.type_of('e0970001-0000-4000-8000-00000000000b') = '<null>',
  'part3: a book waiting for review can''t take a type');
select pg_temp.assert(
  (select pg_catalog.pg_get_triggerdef(t.oid) ~ 'UPDATE OF .*\mbook_type\M'
     from pg_trigger t where t.tgrelid = 'public.books'::regclass and t.tgname = 'books_refuse_change_while_in_review'),
  'part3: the in-review trigger fires on book_type');
-- Cancelling the review (the row leaves 'pending') unlocks it.
update public.book_reviews set status = 'cancelled', decided_at = now()
 where book_id = 'e0970001-0000-4000-8000-00000000000b' and status = 'pending';
select pg_temp.assert(
  pg_temp.run_as('service_role',
    $q$update public.books set book_type = 'Roman' where id = 'e0970001-0000-4000-8000-00000000000b'$q$) = 'OK:1',
  'part3: after the review is cancelled the type can be set');
-- Locked from the other side: type set, then sent, then a change refused.
insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, original_author, description, is_adult,
                                 status, submitted_at)
select bo.id, bo.title, bo.author_id, bo.file_path, bo.cover_path, bo.original_author, bo.description, bo.is_adult,
       'pending', now()
  from public.books bo where bo.id = 'e0970001-0000-4000-8000-00000000000b';
select pg_temp.assert(
  pg_temp.run_as('service_role',
    $q$update public.books set book_type = null where id = 'e0970001-0000-4000-8000-00000000000b'$q$) like 'LB490:%'
  and pg_temp.type_of('e0970001-0000-4000-8000-00000000000b') = 'Roman',
  'part3: a book in review can''t clear or change its type');

-- ============================================================
-- Part 4: a picked public-domain edition (LB497)
-- ============================================================
select pg_temp.assert(
  pg_temp.run_as('service_role',
    $q$update public.books set subtitle = 'x' where id = 'e0970001-0000-4000-8000-00000000000c'$q$) like 'LB497:%',
  'part4: fixture -- the edition is picked (its subtitle is frozen)');
select pg_temp.assert(
  pg_temp.run_as('service_role',
    $q$update public.books set book_type = 'Poezi' where id = 'e0970001-0000-4000-8000-00000000000c'$q$) = 'OK:1'
  and pg_temp.type_of('e0970001-0000-4000-8000-00000000000c') = 'Poezi',
  'part4: a picked edition with no type may set it once');
select pg_temp.assert(
  pg_temp.run_as('service_role',
    $q$update public.books set book_type = 'Poezi' where id = 'e0970001-0000-4000-8000-00000000000c'$q$) = 'OK:1',
  'part4: writing the same type again is not a change');
select pg_temp.assert(
  pg_temp.run_as('service_role',
    $q$update public.books set book_type = 'Ese' where id = 'e0970001-0000-4000-8000-00000000000c'$q$) like 'LB497:%'
  and pg_temp.run_as('service_role',
    $q$update public.books set book_type = null where id = 'e0970001-0000-4000-8000-00000000000c'$q$) like 'LB497:%'
  and pg_temp.type_of('e0970001-0000-4000-8000-00000000000c') = 'Poezi',
  'part4: once set, the picked edition''s type is frozen (change and clear refused)');
select pg_temp.assert(
  pg_temp.run_as(null,
    $q$update public.books set book_type = 'Ese' where id = 'e0970001-0000-4000-8000-00000000000c'$q$) = 'OK:1',
  'part4: the database owner (a staff fix by hand) may still change it');
select pg_temp.assert(
  (select pg_catalog.pg_get_triggerdef(t.oid) ~ 'UPDATE OF .*\mbook_type\M'
     from pg_trigger t where t.tgrelid = 'public.books'::regclass and t.tgname = 'books_freeze_picked_pd_edition'),
  'part4: the freeze trigger fires on book_type');
-- The functions keep no grant for any role.
select pg_temp.assert(
  not has_function_privilege('service_role', 'public.books_freeze_picked_pd_edition()', 'execute')
  and not has_function_privilege('authenticated', 'public.books_freeze_picked_pd_edition()', 'execute')
  and not has_function_privilege('service_role', 'public.books_refuse_change_while_in_review()', 'execute')
  and not has_function_privilege('authenticated', 'public.books_refuse_change_while_in_review()', 'execute')
  and not has_function_privilege('anon', 'public.books_refuse_change_while_in_review()', 'execute'),
  'part4: neither trigger function is executable by any role');

-- ============================================================
-- Part 5: public_books
-- ============================================================
select pg_temp.assert(
  (select a.attname from pg_attribute a
    where a.attrelid = 'public.public_books'::regclass and a.attnum > 0 and not a.attisdropped
    order by a.attnum desc limit 1) = 'book_type',
  'part5: book_type is public_books'' last column');
select pg_temp.assert(
  (select release_date is null and book_type = 'Ese' from public.public_books where id = 'e0970001-0000-4000-8000-00000000000a'),
  'part5: the view shows the live book''s type');
select pg_temp.assert(
  pg_temp.run_as('anon', $q$select book_type from public.public_books$q$) like 'OK:%'
  and pg_temp.run_as('authenticated', $q$select book_type from public.public_books$q$) like 'OK:%',
  'part5: anon and authenticated still read the view');
select pg_temp.assert(
  pg_temp.run_as('anon', $q$select 1 from public.books$q$) like '42501:%',
  'part5: anon still can''t read books itself');

select pg_temp.assert((select n from pg_temp.assertions_run) >= 30, 'all assertions ran');

rollback;
