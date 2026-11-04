-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for BD15 P5a
-- (supabase/migrations/20261104120000_bd15_review_guard.sql):
-- * part1  request_book_review() refuses a book with no manuscript, no
--          cover or no "AI used" answer (LB489), with no oracle for a
--          stranger;
-- * part2  a book waiting for review is read-only for the app's roles:
--          every locked books column, contributors, the AI answer and
--          the rights choice (LB490); unchanged values, series moves,
--          another book and the table owner are not refused; a deleted
--          series still clears series_id;
-- * part3  withdraw, send back and approve still work, and the lock
--          ends with the pending review;
-- * part4  a book in review can still be deleted by its author and by
--          an account deletion.
--
-- The schema.sql / migration equivalence and the rollback are in
-- 091_bd15_review_guard_catalog_equivalence.sh.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/091_bd15_review_guard.test.sql
--
-- Against the BASE schema it fails at part1 (no LB489): the negative
-- control.
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
--   A  author "P091 Ana"; X stranger author; S staff owner
--   b1 a draft A sends for review; b2 A's draft used for the LB489
--   cases; series s1 holds b1
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0910000-0000-4000-8000-00000000000a', 'p091-a@test', now(), '{"role":"author","display_name":"P091 Ana"}'),
  ('e0910000-0000-4000-8000-0000000000ee', 'p091-x@test', now(), '{"role":"author","display_name":"P091 Xen"}'),
  ('e0910000-0000-4000-8000-0000000000c1', 'p091-s@test', now(), '{"role":"reader","display_name":"P091 Staff"}');
insert into public.staff_members (user_id, role) values
  ('e0910000-0000-4000-8000-0000000000c1', 'owner');
insert into public.series (id, author_id, title) values
  ('e0910003-0000-4000-8000-000000000001', 'e0910000-0000-4000-8000-00000000000a', 'P091 s1');
insert into public.books (id, author_id, title, description, price_all, series_id, series_position) values
  ('e0910001-0000-4000-8000-000000000001', 'e0910000-0000-4000-8000-00000000000a', 'P091 b1', 'A description.', 0,
   'e0910003-0000-4000-8000-000000000001', 1),
  ('e0910001-0000-4000-8000-000000000002', 'e0910000-0000-4000-8000-00000000000a', 'P091 b2', 'A description.', 0, null, null);
insert into public.book_contributors (book_id, name, role) values
  ('e0910001-0000-4000-8000-000000000001', 'P091 Translator', 'Translator');

-- ============================================================
-- Part 1: only a complete book is sent for review (LB489).
-- ============================================================
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0910000-0000-4000-8000-00000000000a',
  $q$select public.request_book_review('e0910001-0000-4000-8000-000000000002')::text$q$) like 'LB489:%',
  'part1: no manuscript, no cover, no AI answer: refused');
update public.books set file_path = 'e0910000-0000-4000-8000-00000000000a/e0910001-0000-4000-8000-000000000002/v1.epub'
 where id = 'e0910001-0000-4000-8000-000000000002';
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0910000-0000-4000-8000-00000000000a',
  $q$select public.request_book_review('e0910001-0000-4000-8000-000000000002')::text$q$) like 'LB489:%',
  'part1: a manuscript only: refused');
update public.books set cover_path = 'e0910009-0000-4000-8000-000000000002/cover.jpg'
 where id = 'e0910001-0000-4000-8000-000000000002';
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0910000-0000-4000-8000-00000000000a',
  $q$select public.request_book_review('e0910001-0000-4000-8000-000000000002')::text$q$) like 'LB489:%',
  'part1: manuscript and cover but no AI answer: refused');
update public.books set file_path = null where id = 'e0910001-0000-4000-8000-000000000002';
insert into public.book_ai_disclosures (book_id, ai_used) values ('e0910001-0000-4000-8000-000000000002', false);
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0910000-0000-4000-8000-00000000000a',
  $q$select public.request_book_review('e0910001-0000-4000-8000-000000000002')::text$q$) like 'LB489:%',
  'part1: cover and AI answer but no manuscript: refused');
update public.books set file_path = 'e0910000-0000-4000-8000-00000000000a/e0910001-0000-4000-8000-000000000002/v1.epub', cover_path = null
 where id = 'e0910001-0000-4000-8000-000000000002';
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0910000-0000-4000-8000-00000000000a',
  $q$select public.request_book_review('e0910001-0000-4000-8000-000000000002')::text$q$) like 'LB489:%',
  'part1: manuscript and AI answer but no cover: refused');
select pg_temp.assert(not exists (select 1 from public.book_reviews where book_id = 'e0910001-0000-4000-8000-000000000002'),
  'part1: no refused request left a review row');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0910000-0000-4000-8000-0000000000ee',
  $q$select public.request_book_review('e0910001-0000-4000-8000-000000000002')::text$q$) like '%no book found for this id',
  'part1: a stranger learns nothing (ownership is checked before completeness)');

-- Audit r1 F5: an approved book needs no new review, so "already
-- approved" answers before the completeness check (a legacy book with
-- no AI answer keeps the republish path).
insert into public.books (id, author_id, title, description, price_all, file_path, cover_path, published_at) values
  ('e0910001-0000-4000-8000-000000000004', 'e0910000-0000-4000-8000-00000000000a', 'P091 legacy', 'A description.', 0,
   'e0910000-0000-4000-8000-00000000000a/e0910001-0000-4000-8000-000000000004/v1.epub', 'e0910009-0000-4000-8000-000000000004/cover.jpg',
   now() - interval '10 days');
insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, status, grandfathered, decided_at)
select id, title, author_id, file_path, cover_path, 'approved', true, now() - interval '10 days'
  from public.books where id = 'e0910001-0000-4000-8000-000000000004';
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0910000-0000-4000-8000-00000000000a',
  $q$select public.request_book_review('e0910001-0000-4000-8000-000000000004')::text$q$) like '%this book is already approved',
  'part1 (F5): an approved book without an AI answer is "already approved", not LB489');

-- b1 complete: the request goes through.
update public.books set file_path = 'e0910000-0000-4000-8000-00000000000a/e0910001-0000-4000-8000-000000000001/v1.epub',
                        cover_path = 'e0910009-0000-4000-8000-000000000001/cover.jpg'
 where id = 'e0910001-0000-4000-8000-000000000001';
insert into public.book_ai_disclosures (book_id, ai_used) values ('e0910001-0000-4000-8000-000000000001', true);
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0910000-0000-4000-8000-00000000000a',
  $q$select public.request_book_review('e0910001-0000-4000-8000-000000000001')::text$q$) ~ '^[0-9a-f-]{36}$',
  'part1: a complete book is sent for review');
select pg_temp.assert((select count(*) = 1 from public.book_reviews
                        where book_id = 'e0910001-0000-4000-8000-000000000001' and status = 'pending'),
  'part1: one pending review');

-- ============================================================
-- Part 2: a book waiting for review is read-only (LB490).
-- ============================================================
do $$
declare
  v text;
begin
  foreach v in array array[
    $q$title = 'Changed'$q$,
    $q$subtitle = 'Changed'$q$,
    $q$description = 'Changed.'$q$,
    $q$keywords = 'changed'$q$,
    $q$isbn = '9780306406157'$q$,
    $q$language = 'en'$q$,
    $q$publisher = 'Changed'$q$,
    $q$edition = '2'$q$,
    $q$original_publication_date = '2000-01-01'$q$,
    $q$genre = 'Poezi'$q$,
    $q$categories = array['Poezi']$q$,
    $q$cover_path = 'e0910009-0000-4000-8000-00000000000f/cover.png'$q$,
    $q$file_path = 'e0910000-0000-4000-8000-00000000000a/e0910001-0000-4000-8000-000000000001/v2.epub'$q$,
    $q$price_all = 199$q$,
    $q$original_author = 'Homeri'$q$,
    $q$is_adult = true$q$,
    $q$reading_age_min = 12$q$,
    $q$edition_number = 2$q$
  ] loop
    perform pg_temp.assert(pg_temp.run_as('service_role', null,
      format('update public.books set %s where id = %L', v, 'e0910001-0000-4000-8000-000000000001')) like 'LB490:%',
      format('part2: in review, %s is refused for the catalog writer', v));
    perform pg_temp.assert(pg_temp.run_as('authenticated', 'e0910000-0000-4000-8000-00000000000a',
      format('update public.books set %s where id = %L', v, 'e0910001-0000-4000-8000-000000000001')) not like 'OK:1',
      format('part2: in review, %s is not written by the author session either', v));
  end loop;
end $$;
select pg_temp.assert((select title = 'P091 b1' and price_all = 0 and file_path like '%/v1.epub'
                         from public.books where id = 'e0910001-0000-4000-8000-000000000001'),
  'part2: nothing changed');

select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set title = 'P091 b1', description = 'A description.', price_all = 0 where id = 'e0910001-0000-4000-8000-000000000001'$q$) = 'OK:1',
  'part2: a write of the same values changes nothing and is not refused');
-- Audit r1 F1: pen name, series and position are locked too.
insert into public.series (id, author_id, title) values
  ('e0910003-0000-4000-8000-000000000002', 'e0910000-0000-4000-8000-00000000000a', 'P091 s2');
insert into public.pen_names (id, author_id, name) values
  ('e0910005-0000-4000-8000-000000000001', 'e0910000-0000-4000-8000-00000000000a', 'P091 Ana Two');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0910000-0000-4000-8000-00000000000a',
  $q$update public.books set series_position = 2 where id = 'e0910001-0000-4000-8000-000000000001'$q$) like 'LB490:%',
  'part2: the author cannot move the position (series_position is locked)');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0910000-0000-4000-8000-00000000000a',
  $q$update public.books set series_id = 'e0910003-0000-4000-8000-000000000002' where id = 'e0910001-0000-4000-8000-000000000001'$q$) like 'LB490:%',
  'part2: the author cannot move the book to another series');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0910000-0000-4000-8000-00000000000a',
  $q$update public.books set series_id = null, series_position = null where id = 'e0910001-0000-4000-8000-000000000001'$q$) like 'LB490:%',
  'part2: the author cannot take the book out of its series directly');
-- Audit r1 F6 (S16): a contributor row cannot be moved off a book in review.
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.book_contributors set book_id = 'e0910001-0000-4000-8000-000000000002' where book_id = 'e0910001-0000-4000-8000-000000000001'$q$) like 'LB490:%',
  'part2: a contributor cannot be moved off a book in review to another book');

-- Contributors, the AI answer, the rights choice.
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0910000-0000-4000-8000-00000000000a',
  $q$insert into public.book_contributors (book_id, name, role) values ('e0910001-0000-4000-8000-000000000001', 'New', 'Editor')$q$) like 'LB490:%',
  'part2: adding a contributor is refused');
-- Audit r2 (N3): a stranger cannot tell a book in review from one that
-- is not; RLS answers both the same way.
select pg_temp.assert(
  split_part(pg_temp.run_as('authenticated', 'e0910000-0000-4000-8000-0000000000ee',
    $q$insert into public.book_contributors (book_id, name, role) values ('e0910001-0000-4000-8000-000000000001', 'Probe', 'Editor')$q$), ':', 1)
  = split_part(pg_temp.run_as('authenticated', 'e0910000-0000-4000-8000-0000000000ee',
    $q$insert into public.book_contributors (book_id, name, role) values ('e0910001-0000-4000-8000-000000000002', 'Probe', 'Editor')$q$), ':', 1)
  and pg_temp.run_as('authenticated', 'e0910000-0000-4000-8000-0000000000ee',
    $q$insert into public.book_contributors (book_id, name, role) values ('e0910001-0000-4000-8000-000000000001', 'Probe', 'Editor')$q$) like '42501:%',
  'part2: a stranger gets the same RLS refusal for a book in review and one not in review (no oracle)');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0910000-0000-4000-8000-00000000000a',
  $q$delete from public.book_contributors where book_id = 'e0910001-0000-4000-8000-000000000001'$q$) like 'LB490:%',
  'part2: removing a contributor is refused');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.book_contributors set name = 'Renamed' where book_id = 'e0910001-0000-4000-8000-000000000001'$q$) like 'LB490:%',
  'part2: renaming a contributor is refused');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.book_ai_disclosures set ai_used = false where book_id = 'e0910001-0000-4000-8000-000000000001'$q$) like 'LB490:%',
  'part2: changing the AI answer is refused');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$insert into public.book_ai_disclosures (book_id, ai_used) values ('e0910001-0000-4000-8000-000000000001', false)
     on conflict (book_id) do update set ai_used = excluded.ai_used$q$) like 'LB490:%',
  'part2: the app''s upsert of the AI answer is refused');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$insert into public.book_rights_declarations (book_id, book_title, author_id, author_public_name, basis, statement_version, statement_text)
     values ('e0910001-0000-4000-8000-000000000001', 'P091 b1', 'e0910000-0000-4000-8000-00000000000a', 'P091 Ana', 'public_domain', 'v1', 'A statement.')$q$) like 'LB490:%',
  'part2: a new rights choice is refused');
-- Another book of the same author is not locked.
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set title = 'P091 b2 renamed' where id = 'e0910001-0000-4000-8000-000000000002'$q$) = 'OK:1',
  'part2: the author''s other draft is not locked');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.book_ai_disclosures set ai_used = true where book_id = 'e0910001-0000-4000-8000-000000000002'$q$) = 'OK:1',
  'part2: the other draft''s AI answer is not locked');
-- Librum's own SQL session (no app role) is not checked, as in P1.
select pg_temp.assert(pg_temp.run_as(null, null,
  $q$update public.books set subtitle = 'Owner fix' where id = 'e0910001-0000-4000-8000-000000000001'$q$) = 'OK:1',
  'part2: the table owner (a migration, Librum''s SQL session) is not checked');
update public.books set subtitle = null where id = 'e0910001-0000-4000-8000-000000000001';

-- A deleted series still clears series_id on a book in review.
-- Audit r2 (N2): the author's other draft joins the series too; the
-- app's unlink of the whole series fails because b1 is in review.
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set series_id = 'e0910003-0000-4000-8000-000000000001', series_position = 2 where id = 'e0910001-0000-4000-8000-000000000002'$q$) = 'OK:1',
  'part2: the other draft joins the series');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0910000-0000-4000-8000-00000000000a',
  $q$update public.books set series_id = null, series_position = null where series_id = 'e0910003-0000-4000-8000-000000000001'$q$) like 'LB490:%',
  'part2: the app''s unlink of a series with a book in review is refused as a whole');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$delete from public.series where id = 'e0910003-0000-4000-8000-000000000001'$q$) = 'OK:1',
  'part2: a series delete still clears series_id on a book in review (foreign key)');
select pg_temp.assert((select series_id is null and series_position is null from public.books where id = 'e0910001-0000-4000-8000-000000000001'),
  'part2: series_id cleared, and its position with it (audit r2, N2)');
select pg_temp.assert((select series_id is null and series_position is null from public.books where id = 'e0910001-0000-4000-8000-000000000002'),
  'part2: the other draft of the deleted series keeps no position either');
-- Out of its series now, so the pen name rule (LB452) no longer answers
-- first: the review lock refuses the pen name change.
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set pen_name_id = 'e0910005-0000-4000-8000-000000000001' where id = 'e0910001-0000-4000-8000-000000000001'$q$) like 'LB490:%',
  'part2: the pen name cannot change (catalog writer)');

-- ============================================================
-- Part 3: the review itself still works, and the lock ends with it.
-- ============================================================
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0910000-0000-4000-8000-00000000000a',
  $q$select public.request_book_review('e0910001-0000-4000-8000-000000000001')::text$q$) like '%already waiting for review',
  'part3: a second request is still "already waiting"');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0910000-0000-4000-8000-00000000000a',
  $q$select public.withdraw_book_review('e0910001-0000-4000-8000-000000000001')$q$) = 'OK:1',
  'part3: the author cancels the review');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set description = 'Edited after cancelling.' where id = 'e0910001-0000-4000-8000-000000000001'$q$) = 'OK:1',
  'part3: after cancelling, the book can be edited');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0910000-0000-4000-8000-00000000000a',
  $q$insert into public.book_contributors (book_id, name, role) values ('e0910001-0000-4000-8000-000000000001', 'New', 'Editor')$q$) = 'OK:1',
  'part3: after cancelling, a contributor can be added');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0910000-0000-4000-8000-00000000000a',
  $q$select public.request_book_review('e0910001-0000-4000-8000-000000000001')::text$q$) ~ '^[0-9a-f-]{36}$',
  'part3: sent again');

-- Send back ends the lock.
do $$
begin
  perform pg_temp.assert(pg_temp.run_as('authenticated', 'e0910000-0000-4000-8000-0000000000c1',
    format('select public.admin_send_back_book_review(%L, %L, %L)',
      (select id from public.book_reviews where book_id = 'e0910001-0000-4000-8000-000000000001' and status = 'pending'),
      'other', 'Please fix the cover.')) = 'OK:1',
    'part3: staff send it back');
end $$;
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set cover_path = 'e0910009-0000-4000-8000-00000000000f/cover.png' where id = 'e0910001-0000-4000-8000-000000000001'$q$) = 'OK:1',
  'part3: after a send back, the cover can be replaced');

-- Approve still publishes under the lock (it writes status only).
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0910000-0000-4000-8000-00000000000a',
  $q$select public.request_book_review('e0910001-0000-4000-8000-000000000001')::text$q$) ~ '^[0-9a-f-]{36}$',
  'part3: sent again after the send back');
do $$
begin
  perform pg_temp.assert(pg_temp.value_as('authenticated', 'e0910000-0000-4000-8000-0000000000c1',
    format('select public.admin_approve_book_review(%L, %L, %L, 0, %L::jsonb)::text',
      (select id from public.book_reviews where book_id = 'e0910001-0000-4000-8000-000000000001' and status = 'pending'),
      'e0910000-0000-4000-8000-00000000000a/e0910001-0000-4000-8000-000000000001/v1.epub',
      'e0910009-0000-4000-8000-00000000000f/cover.png',
      '{"cover_is_fine": true, "file_opens": true, "not_someone_elses_work": true, "rights_declared": true}')) = 'true',
    'part3: staff approve; the book is published');
end $$;
select pg_temp.assert((select status = 'published' from public.books where id = 'e0910001-0000-4000-8000-000000000001'),
  'part3: published');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set keywords = 'live edit' where id = 'e0910001-0000-4000-8000-000000000001'$q$) = 'OK:1',
  'part3: a live book (no pending review) is not locked');

-- ============================================================
-- Part 4: a book in review can still be deleted, by its author and by
-- an account deletion; its contributors and AI answer go with it.
-- ============================================================
update public.books set file_path = 'e0910000-0000-4000-8000-00000000000a/e0910001-0000-4000-8000-000000000002/v1.epub',
                        cover_path = 'e0910009-0000-4000-8000-000000000002/cover.jpg'
 where id = 'e0910001-0000-4000-8000-000000000002';
insert into public.book_contributors (book_id, name, role) values
  ('e0910001-0000-4000-8000-000000000002', 'P091 Editor', 'Editor');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0910000-0000-4000-8000-00000000000a',
  $q$select public.request_book_review('e0910001-0000-4000-8000-000000000002')::text$q$) ~ '^[0-9a-f-]{36}$',
  'part4: b2 is sent for review');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0910000-0000-4000-8000-00000000000a',
  $q$delete from public.books where id = 'e0910001-0000-4000-8000-000000000002'$q$) = 'OK:1',
  'part4: the author deletes a book in review');
select pg_temp.assert(not exists (select 1 from public.book_contributors where book_id = 'e0910001-0000-4000-8000-000000000002')
                  and not exists (select 1 from public.book_ai_disclosures where book_id = 'e0910001-0000-4000-8000-000000000002'),
  'part4: its contributors and AI answer went with it');

insert into public.books (id, author_id, title, description, price_all, file_path, cover_path) values
  ('e0910001-0000-4000-8000-000000000003', 'e0910000-0000-4000-8000-00000000000a', 'P091 b3', 'A description.', 0,
   'e0910000-0000-4000-8000-00000000000a/e0910001-0000-4000-8000-000000000003/v1.epub', 'e0910009-0000-4000-8000-000000000003/cover.jpg');
insert into public.book_ai_disclosures (book_id, ai_used) values ('e0910001-0000-4000-8000-000000000003', false);
insert into public.book_contributors (book_id, name, role) values
  ('e0910001-0000-4000-8000-000000000003', 'P091 Editor', 'Editor');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0910000-0000-4000-8000-00000000000a',
  $q$select public.request_book_review('e0910001-0000-4000-8000-000000000003')::text$q$) ~ '^[0-9a-f-]{36}$',
  'part4: b3 is sent for review');
-- The profile delete is the cascade an account deletion runs (auth's
-- own role deletes auth.users; service_role is the stricter case here,
-- because the lock checks it).
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$delete from public.profiles where id = 'e0910000-0000-4000-8000-00000000000a'$q$) = 'OK:1',
  'part4: deleting the account (cascade) still works with a book in review');
select pg_temp.assert(not exists (select 1 from public.books where author_id = 'e0910000-0000-4000-8000-00000000000a'),
  'part4: the books are gone');

do $$
begin
  perform pg_temp.assert((select n from pg_temp.assertions_run) >= 60,
    format('expected at least 60 assertions, ran %s', (select n from pg_temp.assertions_run)));
end $$;

select 'ALL PASSED: 091_bd15_review_guard.test.sql (' || (select n from pg_temp.assertions_run) || ' assertions)' as result;

rollback;
