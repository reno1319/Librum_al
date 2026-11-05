-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for BD15 P1
-- (supabase/migrations/20261103200000_bd15_upload_flow_foundation.sql):
-- * part1  categories <-> genre, the category, 18+, reading age,
--          edition number and language rules;
-- * part2  title, pen name and first publication date are locked once a
--          book has been published (N1, N3), for the app's roles only;
-- * part3  public-domain editions: free, one published edition per work
--          (picked by staff), the picked edition cannot be unpublished
--          or deleted by its author but staff takedowns, suspensions and
--          account deletion still work, swap, no series or bundle
--          without an editor mention, and no public pen name from the
--          edition without one (Renato's Q1, 3 Nov; the byline itself
--          is P7's);
-- * part4  at most 3 contributors, no error oracle for a stranger;
-- * part5  N2: public_bundles lists a live bundle only while its pen
--          name is public, a bundle cannot be published under a hidden
--          one, and pen_name_id stays a plain column (r2);
-- * part6  N8 (BD14 audit): a once-published book cannot move to
--          another pen name; a suspended author's pen name and bundle
--          pen name are hidden from a signed-in reader;
-- * part7  the "AI used" answer is staff only and in no public view.
--
-- The schema.sql / migration equivalence, the backfill on populated data
-- and the rollback are in
-- 090_bd15_upload_flow_foundation_catalog_equivalence.sh.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance (17 or newer: schema.sql uses the MAINTAIN privilege):
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/090_bd15_upload_flow_foundation.test.sql
--
-- Against the BASE schema it fails at once (no categories column): the
-- negative control.
--
-- Everything runs inside one transaction and is rolled back at the end.

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

-- Runs p_sql as p_role (null = the table owner, role none) with
-- auth.uid() = p_sub, then fires the deferred constraint triggers;
-- returns 'OK:<rows>' or '<sqlstate>:<message>'. Each call is its own
-- subtransaction: a refused call leaves nothing behind, a successful
-- one stays.
create function pg_temp.run_as(p_role text, p_sub text, p_sql text) returns text
  language plpgsql as $$
declare
  v_state text;
  v_msg text;
  v_rows bigint;
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  if p_role is not null then
    execute format('set local role %I', p_role);
  end if;
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
    set constraints all immediate;
    set constraints all deferred;
    v_out := 'OK:' || v_rows;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_out := v_state || ':' || v_msg;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  return v_out;
end;
$$;

create function pg_temp.value_as(p_role text, p_sub text, p_sql text) returns text
  language plpgsql as $$
declare
  v_state text;
  v_msg text;
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql into v_out;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_out := v_state || ':' || v_msg;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  return v_out;
end;
$$;

-- ============================================================
-- Fixture (as the table owner):
--   A  author "P090 Ana" (two pen names: default + "P090 Ana Two")
--   U  author "P090 Uli", uploader of public-domain edition p1
--   V  author "P090 Vera", uploader of public-domain edition p2
--   S  staff owner; R reader; X stranger author
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0900000-0000-4000-8000-00000000000a', 'p090-a@test', now(), '{"role":"author","display_name":"P090 Ana"}'),
  ('e0900000-0000-4000-8000-0000000000a1', 'p090-u@test', now(), '{"role":"author","display_name":"P090 Uli"}'),
  ('e0900000-0000-4000-8000-0000000000a2', 'p090-v@test', now(), '{"role":"author","display_name":"P090 Vera"}'),
  ('e0900000-0000-4000-8000-0000000000c1', 'p090-s@test', now(), '{"role":"reader","display_name":"P090 Staff"}'),
  ('e0900000-0000-4000-8000-0000000000aa', 'p090-r@test', now(), '{"role":"reader","display_name":"P090 Reader"}'),
  ('e0900000-0000-4000-8000-0000000000ee', 'p090-x@test', now(), '{"role":"author","display_name":"P090 Xen"}');
insert into public.staff_members (user_id, role) values
  ('e0900000-0000-4000-8000-0000000000c1', 'owner');
insert into public.pen_names (id, author_id, name) values
  ('e0900005-0000-4000-8000-00000000000a', 'e0900000-0000-4000-8000-00000000000a', 'P090 Ana Two');

-- ============================================================
-- Part 1: categories, 18+, reading age, edition number, language.
-- ============================================================
insert into public.books (id, author_id, title, genre) values
  ('e0900001-0000-4000-8000-000000000001', 'e0900000-0000-4000-8000-00000000000a', 'P090 c1', 'Poezi');
insert into public.books (id, author_id, title, categories) values
  ('e0900001-0000-4000-8000-000000000002', 'e0900000-0000-4000-8000-00000000000a', 'P090 c2', array['Fantazi', 'Horror']);
select pg_temp.assert((select categories = array['Poezi'] from public.books where id = 'e0900001-0000-4000-8000-000000000001'),
  'part1: an insert with genre only gets categories {genre} (the app before P2)');
select pg_temp.assert((select genre = 'Fantazi' from public.books where id = 'e0900001-0000-4000-8000-000000000002'),
  'part1: an insert with categories keeps genre = the first category');

select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set genre = 'Poezi' where id = 'e0900001-0000-4000-8000-000000000002'$q$) = 'OK:1',
  'part1: a new genre becomes the first category; the others stay');
select pg_temp.assert((select categories = array['Poezi', 'Fantazi', 'Horror'] from public.books where id = 'e0900001-0000-4000-8000-000000000002'),
  'part1: a new genre becomes the first category; the others stay');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set genre = 'Horror' where id = 'e0900001-0000-4000-8000-000000000002'$q$) = 'OK:1',
  'part1: picking a listed category as genre moves it first, no repeat');
select pg_temp.assert((select categories = array['Horror', 'Poezi', 'Fantazi'] from public.books where id = 'e0900001-0000-4000-8000-000000000002'),
  'part1: picking a listed category as genre moves it first, no repeat');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set categories = array['Romancë'] where id = 'e0900001-0000-4000-8000-000000000002'$q$) = 'OK:1',
  'part1: new categories set genre to their first entry');
select pg_temp.assert((select genre = 'Romancë' from public.books where id = 'e0900001-0000-4000-8000-000000000002'),
  'part1: new categories set genre to their first entry');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set genre = null where id = 'e0900001-0000-4000-8000-000000000002'$q$) = 'OK:1',
  'part1: clearing genre clears categories');
select pg_temp.assert((select categories is null from public.books where id = 'e0900001-0000-4000-8000-000000000002'),
  'part1: clearing genre clears categories');

do $$
declare
  v_bad text[];
  v text;
begin
  foreach v in array array[
    $q$array['Poezi','Horror','Fantazi','Histori']$q$,
    $q$array['Poezi','Poezi']$q$,
    $q$array['Poezi','Horror','Poezi']$q$,
    $q$array['Kuzhinë']$q$,
    $q$'{}'::text[]$q$,
    $q$array['Poezi', null]$q$,
    $q$'[0:0]={Poezi}'::text[]$q$
  ] loop
    perform pg_temp.assert(pg_temp.run_as('service_role', null,
      format('update public.books set categories = %s where id = %L', v, 'e0900001-0000-4000-8000-000000000001'))
      like '23514:%books_categories_check%',
      format('part1: categories %s is refused', v));
  end loop;
end $$;

select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set is_adult = true, categories = array['Romancë', 'Për të rinj'] where id = 'e0900001-0000-4000-8000-000000000001'$q$)
  like '23514:%books_adult_categories_check%',
  'part1 (Q5): an 18+ book cannot be in "Për të rinj"');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set is_adult = true where id = 'e0900001-0000-4000-8000-000000000001'$q$) = 'OK:1',
  'part1 (Q5): ticking 18+ sets reading age 18');
select pg_temp.assert((select reading_age_min = 18 from public.books where id = 'e0900001-0000-4000-8000-000000000001'),
  'part1 (Q5): ticking 18+ sets reading age 18');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set reading_age_min = 12 where id = 'e0900001-0000-4000-8000-000000000001'$q$) = 'OK:1',
  'part1 (Q5): an 18+ book keeps reading age 18');
select pg_temp.assert((select reading_age_min = 18 from public.books where id = 'e0900001-0000-4000-8000-000000000001'),
  'part1 (Q5): an 18+ book keeps reading age 18');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set genre = 'Për fëmijë' where id = 'e0900001-0000-4000-8000-000000000001'$q$)
  like '23514:%books_adult_categories_check%',
  'part1 (Q5): nor in "Për fëmijë" through the old genre field');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set is_adult = false, reading_age_min = 5 where id = 'e0900001-0000-4000-8000-000000000001'$q$)
  like '23514:%books_reading_age_min_check%',
  'part1: a reading age outside the list is refused');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set is_adult = false, reading_age_min = 9, categories = array['Për fëmijë'] where id = 'e0900001-0000-4000-8000-000000000001'$q$) = 'OK:1',
  'part1: a children''s book with reading age 9 is fine');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set edition_number = 0 where id = 'e0900001-0000-4000-8000-000000000001'$q$)
  like '23514:%books_edition_number_check%'
  and pg_temp.run_as('service_role', null,
  $q$update public.books set edition_number = 2 where id = 'e0900001-0000-4000-8000-000000000001'$q$) = 'OK:1',
  'part1: edition number is a whole number from 1');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set language = 'it' where id = 'e0900001-0000-4000-8000-000000000001'$q$)
  like '23514:%books_language_check%'
  and pg_temp.run_as('service_role', null,
  $q$update public.books set language = 'en' where id = 'e0900001-0000-4000-8000-000000000001'$q$) = 'OK:1',
  'part1: language is sq or en');

-- ============================================================
-- Part 2: locked once published (N1, N3).
--   l1 published; l2 published once and unpublished; l3 never published
-- ============================================================
insert into public.books (id, author_id, title, status, price_all, published_at) values
  ('e0900001-0000-4000-8000-000000000011', 'e0900000-0000-4000-8000-00000000000a', 'P090 l1', 'published', 199, now()),
  ('e0900001-0000-4000-8000-000000000012', 'e0900000-0000-4000-8000-00000000000a', 'P090 l2', 'draft', 199, now()),
  ('e0900001-0000-4000-8000-000000000013', 'e0900000-0000-4000-8000-00000000000a', 'P090 l3', 'draft', 199, null);

select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set title = 'P090 l1 new' where id = 'e0900001-0000-4000-8000-000000000011'$q$) like 'LB480:%',
  'part2: the catalog writer cannot change a published book''s title');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set title = 'P090 l2 new' where id = 'e0900001-0000-4000-8000-000000000012'$q$) like 'LB480:%',
  'part2: nor one published once and unpublished');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set title = 'P090 l3 new' where id = 'e0900001-0000-4000-8000-000000000013'$q$) = 'OK:1',
  'part2: a never-published draft''s title changes');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set pen_name_id = 'e0900005-0000-4000-8000-00000000000a' where id = 'e0900001-0000-4000-8000-000000000011'$q$) like 'LB481:%'
  and pg_temp.run_as('service_role', null,
  $q$update public.books set pen_name_id = 'e0900005-0000-4000-8000-00000000000a' where id = 'e0900001-0000-4000-8000-000000000012'$q$) like 'LB481:%',
  'part2 (N1, N8): a once-published book cannot move to another pen name');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set pen_name_id = 'e0900005-0000-4000-8000-00000000000a' where id = 'e0900001-0000-4000-8000-000000000013'$q$) = 'OK:1',
  'part2: a never-published draft can');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set published_at = null where id = 'e0900001-0000-4000-8000-000000000012'$q$) like 'LB482:%'
  and pg_temp.run_as('service_role', null,
  $q$update public.books set published_at = now() - interval '1 day' where id = 'e0900001-0000-4000-8000-000000000011'$q$) like 'LB482:%',
  'part2 (N3): the first publication date is never cleared or moved');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set published_at = now() where id = 'e0900001-0000-4000-8000-000000000013'$q$) = 'OK:1',
  'part2: the first publication sets it');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set subtitle = 'Ok', status = 'draft' where id = 'e0900001-0000-4000-8000-000000000011'$q$) = 'OK:1',
  'part2: other fields and unpublishing still work');
select pg_temp.assert(pg_temp.run_as(null, null,
  $q$update public.books set title = 'P090 l1 fixed' where id = 'e0900001-0000-4000-8000-000000000011'$q$) = 'OK:1',
  'part2: Librum''s own SQL session (support, a migration) can still correct a title');

-- ============================================================
-- Part 3: public-domain editions (Q1).
-- ============================================================
insert into public.pd_works (id, title, original_author) values
  ('e0900006-0000-4000-8000-000000000001', 'P090 Work', 'Naim Frashëri');

select pg_temp.assert(pg_temp.run_as(null, null,
  $q$insert into public.books (id, author_id, title, price_all, pd_work_id) values
     ('e0900001-0000-4000-8000-0000000000f0', 'e0900000-0000-4000-8000-0000000000a1', 'P090 paid pd', 199, 'e0900006-0000-4000-8000-000000000001')$q$)
  like '23514:%books_pd_price_check%',
  'part3: a public-domain edition is free');
select pg_temp.assert(pg_temp.run_as(null, null,
  $q$insert into public.books (id, author_id, title, pd_editor_credit) values
     ('e0900001-0000-4000-8000-0000000000f0', 'e0900000-0000-4000-8000-0000000000a1', 'P090 credit', true)$q$)
  like '23514:%books_pd_editor_credit_check%',
  'part3: an editor mention needs a work');

-- p1 (U) published and picked; p2 (V) a candidate draft.
insert into public.books (id, author_id, title, status, price_all, published_at, pd_work_id) values
  ('e0900001-0000-4000-8000-0000000000f1', 'e0900000-0000-4000-8000-0000000000a1', 'P090 p1', 'published', 0, now(), 'e0900006-0000-4000-8000-000000000001'),
  ('e0900001-0000-4000-8000-0000000000f2', 'e0900000-0000-4000-8000-0000000000a2', 'P090 p2', 'draft', 0, null, 'e0900006-0000-4000-8000-000000000001');
update public.pd_works set picked_book_id = 'e0900001-0000-4000-8000-0000000000f1'
 where id = 'e0900006-0000-4000-8000-000000000001';
set constraints all immediate;
set constraints all deferred;
select pg_temp.assert(true, 'part3: a published picked edition commits');

select pg_temp.assert(pg_temp.run_as(null, null,
  $q$insert into public.books (id, author_id, title, status, price_all, published_at, pd_work_id) values
     ('e0900001-0000-4000-8000-0000000000f3', 'e0900000-0000-4000-8000-0000000000a2', 'P090 p3', 'published', 0, now(), 'e0900006-0000-4000-8000-000000000001')$q$)
  like 'LB485:%',
  'part3: a second published edition of the work is refused at commit');
select pg_temp.assert(pg_temp.run_as(null, null,
  $q$update public.pd_works set picked_book_id = 'e0900001-0000-4000-8000-0000000000f2' where id = 'e0900006-0000-4000-8000-000000000001'$q$)
  like 'LB485:%',
  'part3: picking another edition while the old one stays published is refused');
select pg_temp.assert(pg_temp.run_as(null, null,
  $q$update public.pd_works set picked_book_id = null where id = 'e0900006-0000-4000-8000-000000000001'$q$)
  like 'LB485:%',
  'part3: unpicking a published edition is refused');
select pg_temp.assert(pg_temp.run_as(null, null,
  $q$update public.books set pd_work_id = null where id = 'e0900001-0000-4000-8000-0000000000f1'$q$)
  like '23503:%',
  'part3: a picked edition cannot leave its work');
select pg_temp.assert(pg_temp.run_as(null, null,
  $q$update public.pd_works set picked_book_id = 'e0900001-0000-4000-8000-000000000011' where id = 'e0900006-0000-4000-8000-000000000001'$q$)
  like '23503:%',
  'part3: only an edition of this work can be picked');

-- The edition does not make the uploader's pen name public. (Hiding the
-- byline on the edition itself, and the owner clause of
-- public_pen_names, come with P7: BD15 P1 audit N1 and r2.)
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select count(*)::text from public.public_pen_names where name = 'P090 Uli'$q$) = '0',
  'part3 (Q1): the edition does not make the uploader''s pen name public');
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select count(*)::text from public.public_books where id = 'e0900001-0000-4000-8000-0000000000f2'$q$) = '0',
  'part3: a candidate edition (draft) is not public');

-- No series or bundle without an editor mention.
insert into public.series (id, author_id, title, pen_name_id)
  select 'e0900003-0000-4000-8000-0000000000a1', 'e0900000-0000-4000-8000-0000000000a1', 'P090 SU', b.pen_name_id
    from public.books b where b.id = 'e0900001-0000-4000-8000-0000000000f1';
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set series_id = 'e0900003-0000-4000-8000-0000000000a1', series_position = 1 where id = 'e0900001-0000-4000-8000-0000000000f1'$q$)
  -- BD15 P7 (migration 20261105180000): f1 is its work's picked
  -- edition, so its series is frozen first (LB497).
  similar to '(23514:%books_pd_series_check|LB497:)%',
  'part3: a public-domain edition without an editor mention cannot join a series');
insert into public.bundles (id, author_id, title, status, pen_name_id)
  select 'e0900004-0000-4000-8000-0000000000a1', 'e0900000-0000-4000-8000-0000000000a1', 'P090 BU', 'draft', b.pen_name_id
    from public.books b where b.id = 'e0900001-0000-4000-8000-0000000000f1';
select pg_temp.assert(pg_temp.run_as(null, null,
  $q$insert into public.bundle_books (bundle_id, book_id) values ('e0900004-0000-4000-8000-0000000000a1', 'e0900001-0000-4000-8000-0000000000f1')$q$)
  like 'LB487:%',
  'part3: nor a bundle');

-- With the editor mention the pen name shows, as an editor line.
update public.books set pd_editor_credit = true where id = 'e0900001-0000-4000-8000-0000000000f1';
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select count(*)::text from public.public_pen_names where name = 'P090 Uli'$q$) = '1',
  'part3 (Q1): with the editor mention the uploader''s pen name is public');
select pg_temp.assert(pg_temp.run_as(null, null,
  $q$insert into public.bundle_books (bundle_id, book_id) values ('e0900004-0000-4000-8000-0000000000a1', 'e0900001-0000-4000-8000-0000000000f1')$q$) = 'OK:1',
  'part3: and it may join a bundle');
select pg_temp.assert(pg_temp.run_as(null, null,
  $q$update public.books set pd_editor_credit = false where id = 'e0900001-0000-4000-8000-0000000000f1'$q$)
  like 'LB487:%',
  'part3: the mention cannot be removed while it is in a bundle');
delete from public.bundle_books where bundle_id = 'e0900004-0000-4000-8000-0000000000a1';
update public.books set pd_editor_credit = false where id = 'e0900001-0000-4000-8000-0000000000f1';

-- Q1 lock: the author cannot unpublish or delete the picked edition.
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set status = 'draft' where id = 'e0900001-0000-4000-8000-0000000000f1'$q$) like 'LB483:%',
  'part3 (Q1): the author''s unpublish (catalog writer) is refused');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$delete from public.books where id = 'e0900001-0000-4000-8000-0000000000f1'$q$) like 'LB484:%',
  'part3 (Q1): the catalog writer cannot delete it');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0900000-0000-4000-8000-0000000000a1',
  $q$delete from public.books where id = 'e0900001-0000-4000-8000-0000000000f1'$q$) like 'LB484:%',
  'part3 (Q1): nor can the author through the data API');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$delete from public.books where id = 'e0900001-0000-4000-8000-0000000000f2'$q$) = 'OK:1',
  'part3: a candidate edition can be deleted');
insert into public.books (id, author_id, title, status, price_all, published_at, pd_work_id) values
  ('e0900001-0000-4000-8000-0000000000f2', 'e0900000-0000-4000-8000-0000000000a2', 'P090 p2', 'draft', 0, null, 'e0900006-0000-4000-8000-000000000001');

-- A staff takedown still unpublishes it.
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0900000-0000-4000-8000-0000000000c1',
  $q$select public.admin_unpublish_book('e0900001-0000-4000-8000-0000000000f1', 'copyright', 'P090 probe')$q$) = 'OK:1',
  'part3: a staff takedown of the picked edition goes through');
select pg_temp.assert((select status = 'draft' from public.books where id = 'e0900001-0000-4000-8000-0000000000f1'),
  'part3: a staff takedown of the picked edition goes through');

-- Swap: pick p2 while p1 is unpublished, in one transaction.
select pg_temp.assert(pg_temp.run_as(null, null,
  $q$update public.pd_works set picked_book_id = 'e0900001-0000-4000-8000-0000000000f2' where id = 'e0900006-0000-4000-8000-000000000001'$q$) = 'OK:1',
  'part3: staff can swap the picked edition once the old one is unpublished');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$delete from public.books where id = 'e0900001-0000-4000-8000-0000000000f1'$q$) not like 'LB484:%',
  'part3: the swapped-out edition is no longer locked by the pick (its takedown still guards it)');

-- Deleting the uploader's account deletes the picked edition and clears
-- the pick.
select pg_temp.assert(pg_temp.run_as(null, null,
  $q$delete from auth.users where id = 'e0900000-0000-4000-8000-0000000000a2'$q$) = 'OK:1',
  'part3: deleting the uploader''s account deletes the picked edition and clears the pick');
select pg_temp.assert((select picked_book_id is null from public.pd_works where id = 'e0900006-0000-4000-8000-000000000001'),
  'part3: deleting the uploader''s account deletes the picked edition and clears the pick');

-- ============================================================
-- Part 4: at most 3 contributors.
-- ============================================================
insert into public.book_contributors (book_id, name, role) values
  ('e0900001-0000-4000-8000-000000000013', 'P090 One', 'Editor'),
  ('e0900001-0000-4000-8000-000000000013', 'P090 Two', 'Translator');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0900000-0000-4000-8000-00000000000a',
  $q$insert into public.book_contributors (book_id, name, role) values ('e0900001-0000-4000-8000-000000000013', 'P090 Three', 'Foreword')$q$) = 'OK:1',
  'part4: the third contributor is fine');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0900000-0000-4000-8000-00000000000a',
  $q$insert into public.book_contributors (book_id, name, role) values ('e0900001-0000-4000-8000-000000000013', 'P090 Four', 'Illustrator')$q$) like 'LB486:%'
  and pg_temp.run_as('service_role', null,
  $q$insert into public.book_contributors (book_id, name, role) values ('e0900001-0000-4000-8000-000000000013', 'P090 Four', 'Illustrator')$q$) like 'LB486:%',
  'part4: a fourth is refused, for the author and the service role');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0900000-0000-4000-8000-0000000000ee',
  $q$insert into public.book_contributors (book_id, name, role) values ('e0900001-0000-4000-8000-000000000013', 'P090 Five', 'Illustrator')$q$) like '42501:%',
  'part4: a stranger gets the RLS refusal, not the limit (no error oracle)');

-- ============================================================
-- Part 5: N2, bundles and their pen name.
-- ============================================================
-- X has no published book: a bundle cannot go live under X's pen name.
insert into public.bundles (id, author_id, title, status, pen_name_id)
  select 'e0900004-0000-4000-8000-0000000000ee', 'e0900000-0000-4000-8000-0000000000ee', 'P090 BX', 'draft', pn.id
    from public.pen_names pn where pn.author_id = 'e0900000-0000-4000-8000-0000000000ee';
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.bundles set status = 'published' where id = 'e0900004-0000-4000-8000-0000000000ee'$q$) like 'LB488:%',
  'part5 (N2): a bundle cannot be published under a pen name with no published book');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0900000-0000-4000-8000-0000000000ee',
  $q$select (pen_name_id is not null)::text from public.public_bundles where id = 'e0900004-0000-4000-8000-0000000000ee'$q$) = 'true',
  'part5: the bundle''s author sees their draft bundle and its pen name');
-- A bundle published while its pen name was public, whose books are
-- then deleted: readers see the bundle without the pen name.
insert into public.books (id, author_id, title, status, price_all, published_at) values
  ('e0900001-0000-4000-8000-0000000000e1', 'e0900000-0000-4000-8000-0000000000ee', 'P090 x1', 'published', 199, now());
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.bundles set status = 'published' where id = 'e0900004-0000-4000-8000-0000000000ee'$q$) = 'OK:1',
  'part5: with a published book of that pen name it can');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0900000-0000-4000-8000-0000000000aa',
  $q$select (pen_name_id is not null)::text from public.public_bundles where id = 'e0900004-0000-4000-8000-0000000000ee'$q$) = 'true',
  'part5 (N8): a signed-in reader sees the live bundle and its public pen name');
delete from public.books where id = 'e0900001-0000-4000-8000-0000000000e1';
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0900000-0000-4000-8000-0000000000aa',
  $q$select count(*)::text from public.public_bundles where id = 'e0900004-0000-4000-8000-0000000000ee'$q$) = '0'
  and pg_temp.value_as('anon', null,
  $q$select count(*)::text from public.public_bundles where id = 'e0900004-0000-4000-8000-0000000000ee'$q$) = '0',
  'part5 (N2, N8): once no book makes its pen name public, readers no longer see the bundle');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0900000-0000-4000-8000-0000000000ee',
  $q$select count(*)::text from public.public_bundles where id = 'e0900004-0000-4000-8000-0000000000ee'$q$) = '1',
  'part5: its author still does');

-- r2: every view column the Data API embeds through stays a plain
-- column. PostgREST finds a view's relationships only through plain
-- references to base-table columns; an expression (CASE) loses the
-- pen:public_pen_names embed the whole site uses.
select pg_temp.assert(
  pg_catalog.pg_get_viewdef('public.public_books'::regclass) !~* '\mcase\M'
  and pg_catalog.pg_get_viewdef('public.public_bundles'::regclass) !~* '\mcase\M'
  -- BD15 P7 (migration 20261105180000): still a plain column, now from
  -- books.public_pen_name_id (094 checks its source and its key).
  and pg_catalog.pg_get_viewdef('public.public_books'::regclass) ~ '\n\s+(public_pen_name_id AS )?pen_name_id,\n'
  and pg_catalog.pg_get_viewdef('public.public_bundles'::regclass) ~ '\n\s+pen_name_id\n\s+FROM ',
  'part5 (r2): pen_name_id is a plain column in public_books and public_bundles');

-- ============================================================
-- Part 6: N8, suspension seen by a signed-in reader.
-- ============================================================
insert into public.books (id, author_id, title, status, price_all, published_at) values
  ('e0900001-0000-4000-8000-0000000000e2', 'e0900000-0000-4000-8000-0000000000ee', 'P090 x2', 'published', 199, now());
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0900000-0000-4000-8000-0000000000aa',
  $q$select count(*)::text from public.public_pen_names where name = 'P090 Xen'$q$) = '1',
  'part6: before the suspension a signed-in reader sees X''s pen name');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0900000-0000-4000-8000-0000000000c1',
  $q$select public.admin_suspend_account('e0900000-0000-4000-8000-0000000000ee', 'P090 probe')$q$) like 'OK:%',
  'part6: staff suspend X');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0900000-0000-4000-8000-0000000000aa',
  $q$select count(*)::text from public.public_pen_names where name = 'P090 Xen'$q$) = '0',
  'part6 (N8): after it a signed-in reader no longer sees X''s pen name');

-- ============================================================
-- Part 7: the "AI used" answer.
-- ============================================================
insert into public.book_ai_disclosures (book_id, ai_used) values
  ('e0900001-0000-4000-8000-000000000013', true);
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0900000-0000-4000-8000-00000000000a',
  $q$select count(*)::text from public.book_ai_disclosures$q$) like '42501:%'
  and pg_temp.value_as('anon', null,
  $q$select count(*)::text from public.book_ai_disclosures$q$) like '42501:%',
  'part7: neither the author''s session nor anon can read the AI answer');
select pg_temp.assert(pg_temp.value_as('service_role', null,
  $q$select ai_used::text from public.book_ai_disclosures where book_id = 'e0900001-0000-4000-8000-000000000013'$q$) = 'true',
  'part7: the service role (staff pages, catalog writer) can');
select pg_temp.assert(not exists (
    select 1 from pg_catalog.pg_attribute
     where attrelid in ('public.books'::regclass, 'public.public_books'::regclass)
       and attname = 'ai_used'),
  'part7: no ai_used column on books or public_books');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0900000-0000-4000-8000-00000000000a',
  $q$select count(*)::text from public.pd_works$q$) like '42501:%',
  'part7: pd_works is staff only too');

do $$
begin
  perform pg_temp.assert((select n from pg_temp.assertions_run) >= 60,
    format('expected at least 60 assertions, ran %s', (select n from pg_temp.assertions_run)));
end $$;

select 'ALL PASSED: 090_bd15_upload_flow_foundation.test.sql (' || (select n from pg_temp.assertions_run) || ' assertions)' as result;

rollback;
