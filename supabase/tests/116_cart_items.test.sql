-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for the cart
-- (supabase/migrations/20261125120000_cart_items.sql):
--
-- * part1 the table: row level security on; anon has no grants;
--   authenticated may only insert the four columns and update the two
--   gift columns.
-- * part2 what can go in: a live paid book, for yourself or as a gift.
--   Refused (42501): a free book, a pre-order, a draft, your own book
--   (g4 a), a copy for yourself of a book you own, a row for someone
--   else. A gift of a book you own is allowed.
-- * part3 one copy for yourself per book, one gift per book per email
--   (23505); at most 50 rows (LB529); bad email/note shapes (23514).
-- * part4 each reader sees, edits and removes only their own rows; a
--   copy for yourself can't be turned into a gift by update.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/116_cart_items.test.sql
--
-- Against the BASE schema it fails at part1 (no table): the negative
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

-- A = author, R = reader, S = second reader.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e1160000-0000-4000-8000-00000000000a', 'r116-a@test', now(), '{"role":"author","display_name":"R116 A"}'),
  ('e1160000-0000-4000-8000-00000000000b', 'r116-r@test', now(), '{"role":"reader","display_name":"R116 R"}'),
  ('e1160000-0000-4000-8000-00000000000c', 'r116-s@test', now(), '{"role":"reader","display_name":"R116 S"}');

insert into public.books (id, author_id, title, description, keywords, status, price_all, published_at) values
  ('e1161000-0000-4000-8000-0000000000b1', 'e1160000-0000-4000-8000-00000000000a', 'R116 Paid', 'x', '', 'published', 299, now()),
  ('e1161000-0000-4000-8000-0000000000b2', 'e1160000-0000-4000-8000-00000000000a', 'R116 Free', 'x', '', 'published', 0, now()),
  ('e1161000-0000-4000-8000-0000000000b4', 'e1160000-0000-4000-8000-00000000000a', 'R116 Draft', 'x', '', 'draft', 299, null),
  ('e1161000-0000-4000-8000-0000000000b5', 'e1160000-0000-4000-8000-00000000000a', 'R116 Owned', 'x', '', 'published', 349, now()),
  ('e1161000-0000-4000-8000-0000000000b6', 'e1160000-0000-4000-8000-00000000000a', 'R116 Unpriced', 'x', '', 'published', null, now());
insert into public.books (id, author_id, title, description, keywords, status, price_all, published_at, release_date, preorder_listed_at, preorder_count) values
  ('e1161000-0000-4000-8000-0000000000b3', 'e1160000-0000-4000-8000-00000000000a', 'R116 Preorder', 'x', '', 'preorder', 299, null, current_date + 30, now(), 1);
insert into public.purchases (book_id, reader_id, stripe_checkout_session_id, amount_cents)
  values ('e1161000-0000-4000-8000-0000000000b5', 'e1160000-0000-4000-8000-00000000000b', 'cs_r116', 34900);

-- part1
select pg_temp.assert(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.cart_items'::regclass),
  'part1: cart_items has row level security');
select pg_temp.assert(
  not exists (select 1 from information_schema.role_table_grants
               where table_schema = 'public' and table_name = 'cart_items' and grantee in ('PUBLIC', 'anon')),
  'part1: no grants for PUBLIC or anon');
select pg_temp.assert(
  (select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'cart_items' and grantee = 'authenticated') = 'DELETE,SELECT',
  'part1: authenticated has table-wide DELETE and SELECT only');
select pg_temp.assert(
  (select string_agg(privilege_type || ':' || column_name, ',' order by privilege_type, column_name)
     from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'cart_items' and grantee = 'authenticated'
      and privilege_type in ('INSERT', 'UPDATE'))
  = 'INSERT:book_id,INSERT:gift_email,INSERT:gift_note,INSERT:reader_id,UPDATE:gift_email,UPDATE:gift_note',
  'part1: column grants for INSERT and UPDATE');
select pg_temp.assert(
  pg_temp.run_as('anon', null, 'select 1 from public.cart_items') = '42501',
  'part1: anon cannot read the cart');

-- part2
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000b',
  $q$insert into public.cart_items (reader_id, book_id) values ('e1160000-0000-4000-8000-00000000000b', 'e1161000-0000-4000-8000-0000000000b1')$q$) = 'OK:1',
  'part2: a live paid book for yourself');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000b',
  $q$insert into public.cart_items (reader_id, book_id, gift_email, gift_note) values ('e1160000-0000-4000-8000-00000000000b', 'e1161000-0000-4000-8000-0000000000b1', 'friend@example.test', 'Happy birthday')$q$) = 'OK:1',
  'part2: the same book as a gift');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000b',
  $q$insert into public.cart_items (reader_id, book_id, gift_email) values ('e1160000-0000-4000-8000-00000000000b', 'e1161000-0000-4000-8000-0000000000b5', 'friend@example.test')$q$) = 'OK:1',
  'part2: a gift of a book you own');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000b',
  $q$insert into public.cart_items (reader_id, book_id) values ('e1160000-0000-4000-8000-00000000000b', 'e1161000-0000-4000-8000-0000000000b5')$q$) = '42501',
  'part2: refused, a copy for yourself of a book you own');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000b',
  $q$insert into public.cart_items (reader_id, book_id) values ('e1160000-0000-4000-8000-00000000000b', 'e1161000-0000-4000-8000-0000000000b2')$q$) = '42501',
  'part2: refused, a free book');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000b',
  $q$insert into public.cart_items (reader_id, book_id) values ('e1160000-0000-4000-8000-00000000000b', 'e1161000-0000-4000-8000-0000000000b6')$q$) = '42501',
  'part2: refused, a book with no price');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000b',
  $q$insert into public.cart_items (reader_id, book_id) values ('e1160000-0000-4000-8000-00000000000b', 'e1161000-0000-4000-8000-0000000000b3')$q$) = '42501',
  'part2: refused, a pre-order');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000b',
  $q$insert into public.cart_items (reader_id, book_id, gift_email) values ('e1160000-0000-4000-8000-00000000000b', 'e1161000-0000-4000-8000-0000000000b4', 'x@example.test')$q$) = '42501',
  'part2: refused, a draft (also as a gift)');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000a',
  $q$insert into public.cart_items (reader_id, book_id, gift_email) values ('e1160000-0000-4000-8000-00000000000a', 'e1161000-0000-4000-8000-0000000000b1', 'x@example.test')$q$) = '42501',
  'part2: refused, the author gifting their own book (g4 a)');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000c',
  $q$insert into public.cart_items (reader_id, book_id) values ('e1160000-0000-4000-8000-00000000000b', 'e1161000-0000-4000-8000-0000000000b1')$q$) = '42501',
  'part2: refused, a row in someone else''s cart');
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$insert into public.cart_items (reader_id, book_id) values ('e1160000-0000-4000-8000-00000000000b', 'e1161000-0000-4000-8000-0000000000b1')$q$) = '42501',
  'part2: refused, anon');

-- part3
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000b',
  $q$insert into public.cart_items (reader_id, book_id) values ('e1160000-0000-4000-8000-00000000000b', 'e1161000-0000-4000-8000-0000000000b1')$q$) = '23505',
  'part3: a second copy for yourself');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000b',
  $q$insert into public.cart_items (reader_id, book_id, gift_email) values ('e1160000-0000-4000-8000-00000000000b', 'e1161000-0000-4000-8000-0000000000b1', 'friend@example.test')$q$) = '23505',
  'part3: a second gift of the same book to the same email');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000b',
  $q$insert into public.cart_items (reader_id, book_id, gift_email) values ('e1160000-0000-4000-8000-00000000000b', 'e1161000-0000-4000-8000-0000000000b1', 'other@example.test')$q$) = 'OK:1',
  'part3: the same book to a second email');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000b',
  $q$insert into public.cart_items (reader_id, book_id, gift_email) values ('e1160000-0000-4000-8000-00000000000b', 'e1161000-0000-4000-8000-0000000000b1', 'Upper@Example.test')$q$) = '23514',
  'part3: an email that is not lower case');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000b',
  $q$insert into public.cart_items (reader_id, book_id, gift_email) values ('e1160000-0000-4000-8000-00000000000b', 'e1161000-0000-4000-8000-0000000000b1', 'not an email')$q$) = '23514',
  'part3: not an email');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000b',
  $q$insert into public.cart_items (reader_id, book_id, gift_email, gift_note) values ('e1160000-0000-4000-8000-00000000000b', 'e1161000-0000-4000-8000-0000000000b1', 'n@example.test', repeat('a', 301))$q$) = '23514',
  'part3: a note over 300 characters');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000b',
  $q$insert into public.cart_items (reader_id, book_id, gift_note) values ('e1160000-0000-4000-8000-00000000000b', 'e1161000-0000-4000-8000-0000000000b1', 'note without a gift')$q$) = '23514',
  'part3: a note without a gift email');
-- 4 rows so far; 46 more reach 50, the 51st is refused.
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000b',
  $q$insert into public.cart_items (reader_id, book_id, gift_email)
     select 'e1160000-0000-4000-8000-00000000000b', 'e1161000-0000-4000-8000-0000000000b1', 'g' || n || '@example.test' from generate_series(1, 46) n$q$) = 'OK:46',
  'part3: up to 50 rows');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000b',
  $q$insert into public.cart_items (reader_id, book_id, gift_email) values ('e1160000-0000-4000-8000-00000000000b', 'e1161000-0000-4000-8000-0000000000b1', 'g51@example.test')$q$) = 'LB529',
  'part3: the 51st row is refused');
delete from public.cart_items where gift_email like 'g%@example.test';

-- part4
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000c',
  $q$insert into public.cart_items (reader_id, book_id) values ('e1160000-0000-4000-8000-00000000000c', 'e1161000-0000-4000-8000-0000000000b1')$q$) = 'OK:1',
  'part4: S adds the book');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000b',
  'select 1 from public.cart_items') = 'OK:4', 'part4: R sees only R''s 4 rows');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000b',
  $q$update public.cart_items set gift_email = 'fixed@example.test' where gift_email = 'friend@example.test' and book_id = 'e1161000-0000-4000-8000-0000000000b1'$q$) = 'OK:1',
  'part4: R fixes a gift email (g2 a)');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000b',
  $q$update public.cart_items set gift_email = 'x@example.test' where gift_email is null$q$) = 'OK:0',
  'part4: a copy for yourself is not turned into a gift');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000b',
  $q$update public.cart_items set gift_email = null where gift_email = 'fixed@example.test'$q$) = '42501',
  'part4: a gift is not turned into a copy for yourself');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000b',
  $q$update public.cart_items set book_id = 'e1161000-0000-4000-8000-0000000000b5'$q$) = '42501',
  'part4: the book of a row cannot change');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000b',
  $q$delete from public.cart_items where reader_id = 'e1160000-0000-4000-8000-00000000000c'$q$) = 'OK:0',
  'part4: R cannot remove S''s rows');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1160000-0000-4000-8000-00000000000b',
  $q$delete from public.cart_items where gift_email is null$q$) = 'OK:1',
  'part4: R removes R''s own copy');
select pg_temp.assert((select count(*) from public.cart_items where reader_id = 'e1160000-0000-4000-8000-00000000000c') = 1,
  'part4: S''s row is still there');

do $$
declare v_n int;
begin
  select n into v_n from pg_temp.assertions_run;
  if v_n < 34 then
    raise exception 'FAIL: only % assertions ran (expected at least 34)', v_n;
  end if;
  raise warning '116_cart_items: % assertions passed', v_n;
  raise notice 'ALL PASSED: 116_cart_items.test.sql (% assertions)', v_n;
end $$;

rollback;
