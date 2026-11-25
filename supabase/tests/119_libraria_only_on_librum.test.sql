-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for LR1 patch 2
-- (supabase/migrations/20261125150000_libraria_only_on_librum.sql):
--
-- * part1 the tick: books.only_on_librum defaults to false; it cannot be
--   true while only_on_librum_removed_at is set; authenticated cannot
--   write either column directly.
-- * part2 public_books.only_on_librum: true for a ticked live book, false
--   for a ticked public-domain edition (a free classic never qualifies).
-- * part3 staff_remove_only_on_librum: owner/admin only (catalog.feature);
--   takes the tick off, stamps the time, writes the audit row; false for a
--   book that is not ticked; anon cannot call it.
-- * part4 libraria_category_buttons and
--   staff_set_libraria_category_buttons: everyone reads, nobody writes
--   directly; staff save an ordered list (audited with before and after);
--   more than 6 (LB537), a repeat or an unknown category is refused with
--   nothing changed; an empty list clears it; a moderator is refused.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/119_libraria_only_on_librum.test.sql
--
-- Against the BASE schema it fails at part1 (no column): the negative
-- control. Everything runs inside one transaction and is rolled back.

begin;

set local client_min_messages = warning;

create table pg_temp.assertions_run (n integer not null);
insert into pg_temp.assertions_run values (0);
create table pg_temp.kept (k text primary key, v text);

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  update pg_temp.assertions_run set n = n + 1;
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

-- Runs p_sql as p_role/p_uid; returns 'OK:<rows>' or the SQLSTATE. A
-- single-value select is returned as 'V:<value>'.
create function pg_temp.run_as(p_role text, p_uid uuid, p_sql text) returns text
  language plpgsql as $$
declare
  v_rows bigint;
  v_out text;
  v_val text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  execute format('set local role %I', p_role);
  begin
    if p_sql like 'select %' then
      execute p_sql into v_val;
      v_out := 'V:' || coalesce(v_val, '<null>');
    else
      execute p_sql;
      get diagnostics v_rows = row_count;
      v_out := 'OK:' || v_rows;
    end if;
  exception when others then
    v_out := sqlstate;
  end;
  reset role;
  return v_out;
end;
$$;

-- A = author, O = owner (staff), M = moderator (staff), R = reader.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e1190000-0000-4000-8000-00000000000a', 'r119-a@test', now(), '{"role":"author","display_name":"R119 Autor"}'),
  ('e1190000-0000-4000-8000-0000000000e1', 'r119-o@test', now(), '{"role":"reader","display_name":"R119 Owner"}'),
  ('e1190000-0000-4000-8000-0000000000e2', 'r119-m@test', now(), '{"role":"reader","display_name":"R119 Mod"}'),
  ('e1190000-0000-4000-8000-0000000000d1', 'r119-r@test', now(), '{"role":"reader","display_name":"R119 R"}');

insert into public.staff_members (user_id, role) values
  ('e1190000-0000-4000-8000-0000000000e1', 'owner'),
  ('e1190000-0000-4000-8000-0000000000e2', 'moderator');

insert into public.pd_works (id, title, original_author) values
  ('e1192000-0000-4000-8000-0000000000c1', 'R119 W1', 'R119 Naim');

-- L1 live paid, L2 live classic (public-domain edition), D3 draft.
insert into public.books (id, author_id, title, description, keywords, status, price_all, published_at, file_path, cover_path,
                          categories, original_author, pd_work_id) values
  ('e1191000-0000-4000-8000-0000000000b1', 'e1190000-0000-4000-8000-00000000000a', 'R119 L1', 'x', '', 'published', 299, now(),
   'a/l1/v1.epub', 'e119100c-0000-4000-8000-0000000000b1/cover.jpg', array['Poezi'], null, null),
  ('e1191000-0000-4000-8000-0000000000b2', 'e1190000-0000-4000-8000-00000000000a', 'R119 L2', 'x', '', 'published', 0, now(),
   'a/l2/v1.epub', 'e119100c-0000-4000-8000-0000000000b2/cover.jpg', array['Poezi'], 'R119 Naim', 'e1192000-0000-4000-8000-0000000000c1'),
  ('e1191000-0000-4000-8000-0000000000b3', 'e1190000-0000-4000-8000-00000000000a', 'R119 D3', 'x', '', 'draft', 199, null,
   null, null, array['Poezi'], null, null);
update public.pd_works set picked_book_id = 'e1191000-0000-4000-8000-0000000000b2' where id = 'e1192000-0000-4000-8000-0000000000c1';

-- part1
select pg_temp.assert(
  (select count(*) from public.books where id::text like 'e1191000%' and not only_on_librum and only_on_librum_removed_at is null) = 3,
  'part1: every book starts unticked');
select pg_temp.assert(
  (select string_agg(a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text, ',' order by a.attname)
     from pg_catalog.pg_attribute a
    where a.attrelid = 'public.books'::regclass and a.attname like 'only_on_librum%')
  = 'only_on_librum:boolean:true,only_on_librum_removed_at:timestamp with time zone:false',
  'part1: the two columns');
update public.books set only_on_librum = true where id in ('e1191000-0000-4000-8000-0000000000b1', 'e1191000-0000-4000-8000-0000000000b2');
do $$
begin
  update public.books set only_on_librum_removed_at = now() where id = 'e1191000-0000-4000-8000-0000000000b1';
  raise exception 'FAIL: part1: ticked and removed at once was allowed';
exception when check_violation then
  null;
end $$;
update pg_temp.assertions_run set n = n + 1;
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1190000-0000-4000-8000-00000000000a',
  $q$update public.books set only_on_librum = false where id = 'e1191000-0000-4000-8000-0000000000b3'$q$) = '42501',
  'part1: the author cannot write the tick directly');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1190000-0000-4000-8000-00000000000a',
  $q$update public.books set only_on_librum_removed_at = null where id = 'e1191000-0000-4000-8000-0000000000b3'$q$) = '42501',
  'part1: the author cannot write the removal directly');

-- part2
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select string_agg(title || '=' || only_on_librum::text, ',' order by title) from public.public_books where title like 'R119%'$q$)
  = 'V:R119 L1=true,R119 L2=false', 'part2: a ticked classic is never only-on-Librum; drafts are not listed');
select pg_temp.assert(
  (select attnum from pg_catalog.pg_attribute where attrelid = 'public.public_books'::regclass and attname = 'only_on_librum')
  = (select max(attnum) from pg_catalog.pg_attribute where attrelid = 'public.public_books'::regclass and attnum > 0),
  'part2: only_on_librum is the last column of public_books');

-- part3
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1190000-0000-4000-8000-0000000000e2',
  $q$select public.staff_remove_only_on_librum('e1191000-0000-4000-8000-0000000000b1')::text$q$) = 'P0001',
  'part3: a moderator is refused');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1190000-0000-4000-8000-00000000000a',
  $q$select public.staff_remove_only_on_librum('e1191000-0000-4000-8000-0000000000b1')::text$q$) = 'P0001',
  'part3: the author is refused');
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select public.staff_remove_only_on_librum('e1191000-0000-4000-8000-0000000000b1')::text$q$) = '42501',
  'part3: anon cannot call it');
select pg_temp.assert((select only_on_librum from public.books where id = 'e1191000-0000-4000-8000-0000000000b1'),
  'part3: still ticked after the refusals');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1190000-0000-4000-8000-0000000000e1',
  $q$select public.staff_remove_only_on_librum('e1191000-0000-4000-8000-0000000000b1')::text$q$) = 'V:true',
  'part3: the owner takes it off');
select pg_temp.assert(
  (select not only_on_librum and only_on_librum_removed_at is not null from public.books where id = 'e1191000-0000-4000-8000-0000000000b1'),
  'part3: unticked and stamped');
select pg_temp.assert(
  (select count(*) from public.admin_audit_log where action = 'book.only_on_librum_removed' and target_type = 'books'
      and target_id = 'e1191000-0000-4000-8000-0000000000b1' and actor_id = 'e1190000-0000-4000-8000-0000000000e1') = 1,
  'part3: one audit row');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1190000-0000-4000-8000-0000000000e1',
  $q$select public.staff_remove_only_on_librum('e1191000-0000-4000-8000-0000000000b1')::text$q$) = 'V:false',
  'part3: a book not ticked gives false');
select pg_temp.assert(
  (select count(*) from public.admin_audit_log where action = 'book.only_on_librum_removed') = 1,
  'part3: and writes no second audit row');
do $$
begin
  update public.books set only_on_librum = true where id = 'e1191000-0000-4000-8000-0000000000b1';
  raise exception 'FAIL: part3: re-ticking after removal was allowed';
exception when check_violation then
  null;
end $$;
update pg_temp.assertions_run set n = n + 1;
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select only_on_librum::text from public.public_books where title = 'R119 L1'$q$) = 'V:false',
  'part3: off the shelf for readers');

-- part4
select pg_temp.assert(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.libraria_category_buttons'::regclass),
  'part4: row level security on');
select pg_temp.assert(pg_temp.run_as('anon', null, 'select count(*) from public.libraria_category_buttons') = 'V:0',
  'part4: anon reads it (empty)');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1190000-0000-4000-8000-0000000000e1',
  $q$insert into public.libraria_category_buttons (position, category) values (1, 'Poezi')$q$) = '42501',
  'part4: nobody writes directly, staff included');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1190000-0000-4000-8000-0000000000e1',
  $q$select 'ok' from public.staff_set_libraria_category_buttons(array['Romancë', 'Histori', 'Poezi'])$q$) = 'V:ok',
  'part4: the owner saves a list');
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select string_agg(position || ':' || category, ',' order by position) from public.libraria_category_buttons$q$)
  = 'V:1:Romancë,2:Histori,3:Poezi', 'part4: saved in order');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1190000-0000-4000-8000-0000000000e1',
  $q$select 'ok' from public.staff_set_libraria_category_buttons(array['Poezi', 'Horror', 'Fantazi', 'Filozofi', 'Shkencë', 'Romancë', 'Histori'])$q$) = 'LB537',
  'part4: more than 6 is refused');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1190000-0000-4000-8000-0000000000e1',
  $q$select 'ok' from public.staff_set_libraria_category_buttons(array['Poezi', 'Poezi'])$q$) = '23505',
  'part4: a repeat is refused');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1190000-0000-4000-8000-0000000000e1',
  $q$select 'ok' from public.staff_set_libraria_category_buttons(array['Nope'])$q$) = '23514',
  'part4: an unknown category is refused');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1190000-0000-4000-8000-0000000000e2',
  $q$select 'ok' from public.staff_set_libraria_category_buttons(array['Poezi'])$q$) = 'P0001',
  'part4: a moderator is refused');
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select 'ok' from public.staff_set_libraria_category_buttons(array['Poezi'])$q$) = '42501',
  'part4: anon cannot call it');
select pg_temp.assert(
  (select string_agg(position || ':' || category, ',' order by position) from public.libraria_category_buttons)
  = '1:Romancë,2:Histori,3:Poezi', 'part4: every refusal left the list unchanged');
select pg_temp.assert(
  (select count(*) from public.admin_audit_log where action = 'libraria.category_buttons_set') = 1,
  'part4: one audit row so far');
select pg_temp.assert(
  (select metadata from public.admin_audit_log where action = 'libraria.category_buttons_set')
  = '{"after": ["Romancë", "Histori", "Poezi"], "before": []}'::jsonb,
  'part4: the audit row holds before and after');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1190000-0000-4000-8000-0000000000e1',
  $q$select 'ok' from public.staff_set_libraria_category_buttons(array[]::text[])$q$) = 'V:ok',
  'part4: an empty list clears it');
select pg_temp.assert((select count(*) from public.libraria_category_buttons) = 0, 'part4: cleared');
select pg_temp.assert(
  (select metadata from public.admin_audit_log where action = 'libraria.category_buttons_set' order by created_at desc, id limit 1) ? 'before',
  'part4: the clear is audited too');
select pg_temp.assert(
  (select count(*) from public.admin_audit_log where action = 'libraria.category_buttons_set') = 2,
  'part4: two audit rows');

do $$
declare v_n int;
begin
  select n into v_n from pg_temp.assertions_run;
  if v_n < 30 then
    raise exception 'FAIL: only % assertions ran (expected at least 30)', v_n;
  end if;
  raise warning '119_libraria_only_on_librum: % assertions passed', v_n;
  raise notice 'ALL PASSED: 119_libraria_only_on_librum.test.sql (% assertions)', v_n;
end $$;

rollback;
