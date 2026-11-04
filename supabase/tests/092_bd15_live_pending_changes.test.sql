-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for BD15 P5b-1
-- (supabase/migrations/20261104170000_bd15_live_pending_changes.sql):
-- * part1  book_pending_changes: the catalog writer writes it only
--          through save/discard_book_pending_changes, a live book only
--          (LB491), no blank description, 18+ never meets a
--          children/teen category (LB493) and a pending cover is never
--          another book's (LB495), from either side;
-- * part2  the live guard (LB463) covers description and the 18+ label,
--          and a forged "applying" setting gets nothing through;
-- * part3  sending a live book's changes: nothing to send (LB494), the
--          AI answer still required (LB489), the snapshot, the book
--          stays live and unchanged, read-only while waiting (LB490);
-- * part4  send back and withdraw keep the live book and the changes;
--          approve applies them, keeps the book live, removes the row,
--          and makes the new file the buyers' file;
-- * part5  going offline (author unpublish, takedown, suspension): the
--          pending review is cancelled and the changes become the
--          draft; publishing again needs review; a taken-down book
--          can't be sent; a picked public-domain edition still can't be
--          unpublished by its author and keeps its changes;
-- * part6  the approval binds description and the 18+ label;
-- * part7  a live book keeps its rights basis (LB492);
-- * part8  deleting a live book removes its changes and cancels its
--          review.
--
-- The schema.sql / migration equivalence and the rollback are in
-- 092_bd15_live_pending_changes_catalog_equivalence.sh.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/092_bd15_live_pending_changes.test.sql
--
-- Against the BASE schema it fails at once (no book_pending_changes):
-- the negative control.
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
-- auth.uid() = p_sub; returns 'OK:<rows>' or '<sqlstate>:<message>'.
-- Each call is its own subtransaction.
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

create function pg_temp.checklist() returns text language sql as $$
  select '{"cover_is_fine": true, "file_opens": true, "not_someone_elses_work": true, "rights_declared": true}'
$$;

-- Staff approves the book's pending review with the given paths/price.
create function pg_temp.approve(p_book uuid, p_file text, p_cover text, p_price integer) returns text
  language sql as $$
  select pg_temp.value_as('authenticated', 'e0920000-0000-4000-8000-0000000000c1',
    format('select public.admin_approve_book_review(%L, %L, %L, %s, %L::jsonb)::text',
      (select id from public.book_reviews where book_id = p_book and status = 'pending'),
      p_file, p_cover, p_price, pg_temp.checklist()))
$$;

create function pg_temp.request(p_sub text, p_book uuid) returns text language sql as $$
  select pg_temp.value_as('authenticated', p_sub, format('select public.request_book_review(%L)::text', p_book))
$$;

-- The catalog writer's two writes (service_role).
create function pg_temp.save(p_author text, p_book text, p_file text, p_cover text, p_desc text, p_adult boolean,
                             p_original_author text default null) returns text language sql as $$
  select pg_temp.run_as('service_role', null,
    format('select public.save_book_pending_changes(%L, %L, %L, %L, %L, %L, %L)',
      p_author, p_book, p_file, p_cover, p_desc, p_adult, p_original_author))
$$;
create function pg_temp.discard(p_author text, p_book text) returns text language sql as $$
  select pg_temp.value_as('service_role', null,
    format('select public.discard_book_pending_changes(%L, %L)::text', p_author, p_book))
$$;

-- ============================================================
-- Fixture (as the table owner):
--   A author, B author (suspended later), S staff owner
--   live books l1..l7 and d1 a draft; each live book has an approved
--   review with the full snapshot and an AI answer, except l4 (no AI
--   answer, a book from before BD15 P3)
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0920000-0000-4000-8000-00000000000a', 'p092-a@test', now(), '{"role":"author","display_name":"P092 Ana"}'),
  ('e0920000-0000-4000-8000-00000000000b', 'p092-b@test', now(), '{"role":"author","display_name":"P092 Ben"}'),
  ('e0920000-0000-4000-8000-0000000000c1', 'p092-s@test', now(), '{"role":"reader","display_name":"P092 Staff"}');
insert into public.staff_members (user_id, role) values
  ('e0920000-0000-4000-8000-0000000000c1', 'owner');

insert into public.books (id, author_id, title, description, price_all, status, published_at, file_path, cover_path, categories) values
  ('e0920001-0000-4000-8000-000000000001', 'e0920000-0000-4000-8000-00000000000a', 'P092 l1', 'Old one.', 0, 'published', now(),
   'a/l1/v1.epub', 'e092000c-0000-4000-8000-000000000002/cover.jpg', array['Poezi']),
  ('e0920001-0000-4000-8000-000000000002', 'e0920000-0000-4000-8000-00000000000a', 'P092 l2', 'Old two.', 0, 'published', now(),
   'a/l2/v1.epub', 'e092000c-0000-4000-8000-000000000005/cover.jpg', array['Poezi']),
  ('e0920001-0000-4000-8000-000000000003', 'e0920000-0000-4000-8000-00000000000a', 'P092 l3', 'Old three.', 0, 'published', now(),
   'a/l3/v1.epub', 'e092000c-0000-4000-8000-000000000006/cover.jpg', array['Poezi']),
  ('e0920001-0000-4000-8000-000000000004', 'e0920000-0000-4000-8000-00000000000a', 'P092 l4', 'Old four.', 0, 'published', now(),
   'a/l4/v1.epub', 'e092000c-0000-4000-8000-000000000007/cover.jpg', array['Poezi']),
  ('e0920001-0000-4000-8000-000000000005', 'e0920000-0000-4000-8000-00000000000b', 'P092 l5', 'Old five.', 0, 'published', now(),
   'b/l5/v1.epub', 'e092000c-0000-4000-8000-000000000010/cover.jpg', array['Poezi']),
  ('e0920001-0000-4000-8000-000000000006', 'e0920000-0000-4000-8000-00000000000a', 'P092 l6', 'Old six.', 0, 'published', now(),
   'a/l6/v1.epub', 'e092000c-0000-4000-8000-000000000008/cover.jpg', array['Poezi']),
  ('e0920001-0000-4000-8000-000000000007', 'e0920000-0000-4000-8000-00000000000a', 'P092 l7', 'Old seven.', 0, 'published', now(),
   'a/l7/v1.epub', 'e092000c-0000-4000-8000-000000000009/cover.jpg', array['Poezi']),
  ('e0920001-0000-4000-8000-0000000000d1', 'e0920000-0000-4000-8000-00000000000a', 'P092 d1', 'Draft.', 0, 'draft', null,
   'a/d1/v1.epub', 'e092000c-0000-4000-8000-000000000001/cover.jpg', array['Poezi']);

insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, original_author, description, is_adult,
                                 status, checklist, submitted_at, decided_at)
select bo.id, bo.title, bo.author_id, bo.file_path, bo.cover_path, bo.original_author, bo.description, bo.is_adult,
       'approved', pg_temp.checklist()::jsonb, now() - interval '1 day', now() - interval '1 day'
  from public.books bo
 where bo.id::text like 'e0920001-%' and bo.status = 'published';

insert into public.book_ai_disclosures (book_id, ai_used)
select bo.id, false from public.books bo
 where bo.id::text like 'e0920001-%' and bo.id <> 'e0920001-0000-4000-8000-000000000004';

-- ============================================================
-- Part 1: who may hold and write pending changes
-- ============================================================
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0920000-0000-4000-8000-00000000000a',
  $q$select count(*) from public.book_pending_changes$q$) like '42501:%',
  'part1: the author''s session can''t read pending changes (the catalog writer does)');
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$insert into public.book_pending_changes (book_id, file_path, cover_path, description, is_adult)
     values ('e0920001-0000-4000-8000-000000000001', 'x', 'y', 'z', false)$q$) like '42501:%',
  'part1: anon can''t write pending changes');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0920000-0000-4000-8000-00000000000a',
  $q$insert into public.book_pending_changes (book_id, file_path, cover_path, description, is_adult)
     values ('e0920001-0000-4000-8000-000000000001', 'x', 'y', 'z', false)$q$) like '42501:%',
  'part1: the author''s session can''t write pending changes');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$insert into public.book_pending_changes (book_id, file_path, cover_path, description, is_adult)
     values ('e0920001-0000-4000-8000-000000000001', 'x', 'y', 'z', false)$q$) like '42501:%',
  'part1: the catalog writer writes only through the two functions (audit r1, F1)');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0920000-0000-4000-8000-00000000000a',
  format('select public.save_book_pending_changes(%L, %L, %L, %L, %L, false, null)',
    'e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000001', 'x', 'e092000c-0000-4000-8000-000000000099/cover.jpg', 'z'))
  like '42501:%', 'part1: the author''s session can''t call the save function');
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select public.discard_book_pending_changes('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000001')$q$)
  like '42501:%', 'part1: nor anon the discard function');
select pg_temp.assert(pg_temp.save('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-0000000000d1', 'a/d1/v2.epub', 'e092000c-0000-4000-8000-000000000001/cover.jpg', 'Draft.', false) like 'LB491:%',
  'part1: a draft keeps no pending changes (it changes the book itself)');
select pg_temp.assert(pg_temp.save('e0920000-0000-4000-8000-00000000000b', 'e0920001-0000-4000-8000-000000000001', 'a/l1/v2.epub', 'e092000c-0000-4000-8000-000000000003/cover.jpg', 'New one.', false) = 'P0001:no book found for this id',
  'part1: another author''s book is answered as missing');
select pg_temp.assert(pg_temp.save('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000001', 'a/l1/v2.epub', 'e092000c-0000-4000-8000-000000000003/cover.jpg', '   ', false) like '23514:%',
  'part1: a blank description is refused (audit r1, F5)');
select pg_temp.assert(pg_temp.save('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000001', 'a/l1/v2.epub', 'e092000c-0000-4000-8000-000000000003/cover.jpg', 'New one.', false) = 'OK:1',
  'part1: the catalog writer saves pending changes for a live book');
select pg_temp.assert(pg_temp.run_as(null, null,
  $q$update public.book_pending_changes set book_id = 'e0920001-0000-4000-8000-000000000002'
      where book_id = 'e0920001-0000-4000-8000-000000000001'$q$) like 'LB491:%',
  'part1: pending changes never move to another book');
select pg_temp.assert(pg_temp.save('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000001', 'a/l1/v2.epub', 'e092000c-0000-4000-8000-000000000003/cover.jpg', 'New one.', false, ' Homer') like '23514:%',
  'part1: the original author follows the books rule');
update public.book_pending_changes set updated_at = '2000-01-01' where book_id = 'e0920001-0000-4000-8000-000000000001';
select pg_temp.assert(pg_temp.save('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000001', 'a/l1/v2.epub', 'e092000c-0000-4000-8000-000000000003/cover.jpg', 'New one.', false) = 'OK:1'
  and (select updated_at > '2001-01-01' from public.book_pending_changes where book_id = 'e0920001-0000-4000-8000-000000000001'),
  'part1: saving again updates the row; updated_at is the write time');
select pg_temp.assert((select count(*) = 1 from public.book_pending_changes where book_id = 'e0920001-0000-4000-8000-000000000001'),
  'part1: one row per book');

-- LB493 from both sides.
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set categories = array['Poezi', 'Për fëmijë'] where id = 'e0920001-0000-4000-8000-000000000002'$q$) = 'OK:1',
  'part1: l2 is in a children''s category');
select pg_temp.assert(pg_temp.save('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000002', 'a/l2/v1.epub', 'e092000c-0000-4000-8000-000000000005/cover.jpg', 'Old two.', true) like 'LB493:%',
  'part1: an 18+ change on a children''s book is refused');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set categories = array['Poezi'] where id = 'e0920001-0000-4000-8000-000000000002'$q$) = 'OK:1',
  'part1: l2 leaves the children''s category');
select pg_temp.assert(pg_temp.save('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000002', 'a/l2/v1.epub', 'e092000c-0000-4000-8000-000000000005/cover.jpg', 'Old two.', true) = 'OK:1',
  'part1: now the 18+ change is saved');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set categories = array['Për të rinj'] where id = 'e0920001-0000-4000-8000-000000000002'$q$) like 'LB493:%',
  'part1: a teen category while an 18+ change waits is refused');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set genre = 'Për fëmijë' where id = 'e0920001-0000-4000-8000-000000000002'$q$) like 'LB493:%',
  'part1: and through the old genre column too');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set categories = array['Horror', 'Poezi'] where id = 'e0920001-0000-4000-8000-000000000002'$q$) = 'OK:1',
  'part1: other categories still save at once');
select pg_temp.assert(pg_temp.discard('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000002') = 'true',
  'part1: the author discards the changes ("Hidh poshtë ndryshimet")');
select pg_temp.assert(pg_temp.discard('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000002') = 'false',
  'part1: discarding nothing says so');
select pg_temp.assert(pg_temp.discard('e0920000-0000-4000-8000-00000000000b', 'e0920001-0000-4000-8000-000000000001') like 'P0001:no book found%',
  'part1: another author can''t discard');

-- LB495: a pending cover is never another book's (audit r1, F2).
select pg_temp.assert(pg_temp.save('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000002', 'a/l2/v1.epub', 'e092000c-0000-4000-8000-000000000006/cover.jpg', 'Old two.', false) like 'LB495:%',
  'part1: a pending cover that is another book''s live cover is refused');
select pg_temp.assert(pg_temp.save('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000002', 'a/l2/v1.epub', 'e092000c-0000-4000-8000-000000000011/cover.jpg', 'Old two.', false) = 'OK:1',
  'part1: l2 saves a new cover');
select pg_temp.assert(pg_temp.save('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000006', 'a/l6/v1.epub', 'e092000c-0000-4000-8000-000000000011/cover.jpg', 'Old six.', false) like '23505:%book_pending_changes_cover_path_key%',
  'part1: two books'' pending changes never share a cover');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set cover_path = 'e092000c-0000-4000-8000-000000000011/cover.jpg' where id = 'e0920001-0000-4000-8000-0000000000d1'$q$) like 'LB495:%',
  'part1: a book can''t take a cover another book''s change holds');
select pg_temp.assert(pg_temp.run_as(null, null,
  $q$insert into public.books (author_id, title, cover_path) values ('e0920000-0000-4000-8000-00000000000a', 'P092 x', 'e092000c-0000-4000-8000-000000000011/cover.jpg')$q$) like 'LB495:%',
  'part1: nor a new book');
select pg_temp.assert(pg_temp.discard('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000002') = 'true',
  'part1: l2 discards again');

-- ============================================================
-- Part 2: the live guard
-- ============================================================
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set description = 'Sneaky.' where id = 'e0920001-0000-4000-8000-000000000001'$q$) like 'LB463:%',
  'part2: a live description changes only through review');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set is_adult = true where id = 'e0920001-0000-4000-8000-000000000001'$q$) like 'LB463:%',
  'part2: a live 18+ label changes only through review');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set file_path = 'a/l1/v2.epub' where id = 'e0920001-0000-4000-8000-000000000001'$q$) like 'LB463:%',
  'part2: a live manuscript changes only through review');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set cover_path = 'e092000c-0000-4000-8000-000000000003/cover.jpg' where id = 'e0920001-0000-4000-8000-000000000001'$q$) like 'LB463:%',
  'part2: a live cover changes only through review');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set original_author = 'Homer' where id = 'e0920001-0000-4000-8000-000000000001'$q$) like 'LB463:%',
  'part2: a live original author changes only through review');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set description = 'Old one.', subtitle = 'Sub', keywords = 'k', price_all = 0
      where id = 'e0920001-0000-4000-8000-000000000001'$q$) = 'OK:1',
  'part2: unchanged review fields and the instant fields save at once');
do $$
declare
  v text;
begin
  -- A forged "applying" setting naming an approved review whose snapshot
  -- is not the new values gets nothing through.
  perform set_config('librum.applying_review',
    (select id::text from public.book_reviews where book_id = 'e0920001-0000-4000-8000-000000000001' and status = 'approved'), true);
  v := pg_temp.run_as('service_role', null,
    $q$update public.books set description = 'Sneaky.' where id = 'e0920001-0000-4000-8000-000000000001'$q$);
  perform pg_temp.assert(v like 'LB463:%', format('part2: a forged applying setting is refused -- got %s', v));
  perform set_config('librum.applying_review', 'not-a-uuid', true);
  v := pg_temp.run_as('service_role', null,
    $q$update public.books set description = 'Sneaky.' where id = 'e0920001-0000-4000-8000-000000000001'$q$);
  perform pg_temp.assert(v like 'LB463:%', format('part2: a garbage applying setting is refused -- got %s', v));
  perform set_config('librum.applying_review', '', true);
end $$;
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set description = 'Draft two.' where id = 'e0920001-0000-4000-8000-0000000000d1'$q$) = 'OK:1',
  'part2: a draft still changes freely');

-- ============================================================
-- Part 3: sending a live book's changes
-- ============================================================
select pg_temp.assert(pg_temp.request('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000003')
  like 'LB494:%', 'part3: no pending changes: nothing to send');
select pg_temp.assert(pg_temp.save('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000003', 'a/l3/v1.epub', 'e092000c-0000-4000-8000-000000000006/cover.jpg', 'Old three.', false) = 'OK:1',
  'part3: pending changes equal to the live book are saved');
select pg_temp.assert(pg_temp.request('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000003')
  like 'LB494:%', 'part3: and are still nothing to send');
select pg_temp.assert(pg_temp.save('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000004', 'a/l4/v2.epub', 'e092000c-0000-4000-8000-000000000007/cover.jpg', 'Old four.', false) = 'OK:1',
  'part3: l4 (no AI answer) saves a new manuscript');
select pg_temp.assert(pg_temp.request('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000004')
  like 'LB489:%', 'part3: a live book without the AI answer must give it before review');
select pg_temp.assert(pg_temp.request('e0920000-0000-4000-8000-00000000000b', 'e0920001-0000-4000-8000-000000000001')
  = 'P0001:no book found for this id', 'part3: another author can''t send it');

select pg_temp.assert(pg_temp.request('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000001')
  ~ '^[0-9a-f-]{36}$', 'part3: the author sends l1''s changes');
select pg_temp.assert((select (r.file_path, r.cover_path, r.description, r.is_adult, r.original_author)
                              is not distinct from ('a/l1/v2.epub', 'e092000c-0000-4000-8000-000000000003/cover.jpg', 'New one.', false, null::text)
                         from public.book_reviews r
                        where r.book_id = 'e0920001-0000-4000-8000-000000000001' and r.status = 'pending'),
  'part3: the review snapshots the pending changes');
select pg_temp.assert((select (status, file_path, cover_path, description) = ('published', 'a/l1/v1.epub', 'e092000c-0000-4000-8000-000000000002/cover.jpg', 'Old one.')
                         from public.books where id = 'e0920001-0000-4000-8000-000000000001'),
  'part3: the book stays live with its approved version');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0920000-0000-4000-8000-00000000000a',
  $q$select public.book_review_state('e0920001-0000-4000-8000-000000000001')::text$q$)::jsonb
  = '{"pending": true, "approval_valid": true, "latest_sent_back": null}'::jsonb,
  'part3: the author sees it waiting, and the live version still approved');
select pg_temp.assert(pg_temp.request('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000001')
  = 'P0001:this book is already waiting for review', 'part3: sending twice is refused');
-- Read-only while waiting (Renato, Q2 a).
select pg_temp.assert(pg_temp.save('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000001', 'a/l1/v2.epub', 'e092000c-0000-4000-8000-000000000003/cover.jpg', 'Newer.', false) like 'LB490:%',
  'part3: the pending changes are read-only while waiting');
select pg_temp.assert(pg_temp.discard('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000001') like 'LB490:%',
  'part3: and can''t be discarded while waiting');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set price_all = 5 where id = 'e0920001-0000-4000-8000-000000000001'$q$) like 'LB490:%',
  'part3: the price is locked while waiting');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set keywords = 'new' where id = 'e0920001-0000-4000-8000-000000000001'$q$) like 'LB490:%',
  'part3: so are the instant fields');

-- ============================================================
-- Part 4: send back, withdraw, approve
-- ============================================================
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0920000-0000-4000-8000-0000000000c1',
  format($q$select public.admin_send_back_book_review(%L, 'other', 'Fix the cover.')$q$,
    (select id from public.book_reviews where book_id = 'e0920001-0000-4000-8000-000000000001' and status = 'pending'))) = 'OK:1',
  'part4: staff send the changes back');
select pg_temp.assert((select status = 'published' and description = 'Old one.' from public.books where id = 'e0920001-0000-4000-8000-000000000001')
  and exists (select 1 from public.book_pending_changes where book_id = 'e0920001-0000-4000-8000-000000000001'),
  'part4: after a send back the book is live and the changes wait for a fix');
do $$
declare
  v text;
begin
  -- The setting naming the SENT-BACK review (snapshot = the new values,
  -- decided in this transaction) gets nothing through: only an approved
  -- one counts (audit r1, F3).
  perform set_config('librum.applying_review',
    (select id::text from public.book_reviews where book_id = 'e0920001-0000-4000-8000-000000000001' and status = 'sent_back'), true);
  execute 'set local role service_role';
  begin
    update public.books
       set file_path = 'a/l1/v2.epub', cover_path = 'e092000c-0000-4000-8000-000000000003/cover.jpg',
           description = 'New one.', is_adult = false
     where id = 'e0920001-0000-4000-8000-000000000001';
    v := 'OK';
  exception when others then
    v := sqlstate;
  end;
  reset role;
  perform set_config('librum.applying_review', '', true);
  perform pg_temp.assert(v = 'LB463', format('part4: a sent-back review in the setting is refused -- got %s', v));
end $$;
select pg_temp.assert(pg_temp.save('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000001', 'a/l1/v2.epub', 'e092000c-0000-4000-8000-000000000004/cover.jpg', 'New one.', false) = 'OK:1',
  'part4: the author fixes the changes');
select pg_temp.assert(pg_temp.request('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000001')
  ~ '^[0-9a-f-]{36}$', 'part4: and sends them again');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0920000-0000-4000-8000-00000000000a',
  $q$select public.withdraw_book_review('e0920001-0000-4000-8000-000000000001')$q$) = 'OK:1',
  'part4: the author cancels the review');
select pg_temp.assert((select status = 'published' from public.books where id = 'e0920001-0000-4000-8000-000000000001')
  and exists (select 1 from public.book_pending_changes where book_id = 'e0920001-0000-4000-8000-000000000001'),
  'part4: the book is live and the changes are kept');
select pg_temp.assert(pg_temp.save('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000001', 'a/l1/v2.epub', 'e092000c-0000-4000-8000-000000000004/cover.jpg', 'New one.', true) = 'OK:1',
  'part4: the author adds the 18+ label to the changes');
select pg_temp.assert(pg_temp.request('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000001')
  ~ '^[0-9a-f-]{36}$', 'part4: and sends again');

select pg_temp.assert(pg_temp.approve('e0920001-0000-4000-8000-000000000001', 'a/l1/v1.epub', 'e092000c-0000-4000-8000-000000000004/cover.jpg', 0)
  = 'P0001:the author changed the file or cover', 'part4: approve binds the file staff opened');
select pg_temp.assert(pg_temp.approve('e0920001-0000-4000-8000-000000000001', 'a/l1/v2.epub', 'e092000c-0000-4000-8000-000000000002/cover.jpg', 0)
  = 'P0001:the author changed the file or cover', 'part4: and the cover staff saw');
select pg_temp.assert(pg_temp.approve('e0920001-0000-4000-8000-000000000001', 'a/l1/v2.epub', 'e092000c-0000-4000-8000-000000000004/cover.jpg', 5)
  = 'P0001:the author changed the book', 'part4: and the price');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0920000-0000-4000-8000-00000000000a',
    format('select public.admin_approve_book_review(%L, %L, %L, 0, %L::jsonb)::text',
      (select id from public.book_reviews where book_id = 'e0920001-0000-4000-8000-000000000001' and status = 'pending'),
      'a/l1/v2.epub', 'e092000c-0000-4000-8000-000000000004/cover.jpg', pg_temp.checklist())) = 'P0001:not authorized',
  'part4: the author can''t approve');
-- Librum's own session tampers with the waiting row: approve notices.
update public.book_pending_changes set description = 'Tampered.' where book_id = 'e0920001-0000-4000-8000-000000000001';
select pg_temp.assert(pg_temp.approve('e0920001-0000-4000-8000-000000000001', 'a/l1/v2.epub', 'e092000c-0000-4000-8000-000000000004/cover.jpg', 0)
  = 'P0001:the author changed the book', 'part4: approve checks the pending row still equals what was sent (audit r1, F3)');
update public.book_pending_changes set description = 'New one.' where book_id = 'e0920001-0000-4000-8000-000000000001';
update public.books set librum_choice_at = now() where id = 'e0920001-0000-4000-8000-000000000001';
select pg_temp.assert(pg_temp.approve('e0920001-0000-4000-8000-000000000001', 'a/l1/v2.epub', 'e092000c-0000-4000-8000-000000000004/cover.jpg', 0)
  = 'false', 'part4: staff approve; not a first publication');
select pg_temp.assert((select (status, file_path, cover_path, description, is_adult, reading_age_min)
                              = ('published', 'a/l1/v2.epub', 'e092000c-0000-4000-8000-000000000004/cover.jpg', 'New one.', true, 18::smallint)
                         from public.books where id = 'e0920001-0000-4000-8000-000000000001'),
  'part4: the live book has the approved version (18+ means reading age 18)');
select pg_temp.assert((select published_at = now() and librum_choice_at is not null
                         from public.books where id = 'e0920001-0000-4000-8000-000000000001'),
  'part4: first publication date and Librum''s choice stay');
select pg_temp.assert(not exists (select 1 from public.book_pending_changes where book_id = 'e0920001-0000-4000-8000-000000000001'),
  'part4: the pending changes are gone');
select pg_temp.assert((select r.file_path from public.book_reviews r
                        where r.book_id = 'e0920001-0000-4000-8000-000000000001' and r.status = 'approved'
                        order by r.decided_at desc, r.id desc limit 1) = 'a/l1/v2.epub',
  'part4: the newest approval (the buyers'' file) is the new manuscript');
select pg_temp.assert((select metadata = '{"first_publication": false, "live_update": true}'::jsonb
                         from public.admin_audit_log
                        where target_id = 'e0920001-0000-4000-8000-000000000001' and action = 'book.review_approved'),
  'part4: the audit row says it was a live update');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0920000-0000-4000-8000-00000000000a',
  $q$select public.book_review_state('e0920001-0000-4000-8000-000000000001')::text$q$)::jsonb
  - 'latest_sent_back' = '{"pending": false, "approval_valid": true}'::jsonb,
  -- (latest_sent_back left out: every row here has the same timestamps)
  'part4: the author sees the new version approved');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set keywords = 'after' where id = 'e0920001-0000-4000-8000-000000000001'$q$) = 'OK:1',
  'part4: the book is editable again');
do $$
declare
  v text;
begin
  -- The setting naming the OLD approval (decided yesterday) can't bring
  -- the old version back (audit r1, F4).
  perform set_config('librum.applying_review',
    (select id::text from public.book_reviews
      where book_id = 'e0920001-0000-4000-8000-000000000001' and status = 'approved' and file_path = 'a/l1/v1.epub'), true);
  execute 'set local role service_role';
  begin
    update public.books
       set file_path = 'a/l1/v1.epub', cover_path = 'e092000c-0000-4000-8000-000000000002/cover.jpg',
           description = 'Old one.', is_adult = false
     where id = 'e0920001-0000-4000-8000-000000000001';
    v := 'OK';
  exception when others then
    v := sqlstate;
  end;
  reset role;
  perform set_config('librum.applying_review', '', true);
  perform pg_temp.assert(v = 'LB463', format('part4: an earlier approval in the setting is refused -- got %s', v));
end $$;

-- ============================================================
-- Part 5: going offline
-- ============================================================
-- l3: the author takes the book off sale with changes saved, not sent.
select pg_temp.assert(pg_temp.save('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000003', 'a/l3/v2.epub', 'e092000c-0000-4000-8000-000000000006/cover.jpg', 'New three.', false) = 'OK:1',
  'part5: l3 has changes saved');
select pg_temp.assert(pg_temp.request('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000003')
  ~ '^[0-9a-f-]{36}$', 'part5: and sent');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set status = 'draft' where id = 'e0920001-0000-4000-8000-000000000003'$q$) = 'OK:1',
  'part5: the author takes l3 off sale');
select pg_temp.assert((select (status, file_path, description) = ('draft', 'a/l3/v2.epub', 'New three.')
                         from public.books where id = 'e0920001-0000-4000-8000-000000000003')
  and not exists (select 1 from public.book_pending_changes where book_id = 'e0920001-0000-4000-8000-000000000003'),
  'part5: the changes became the draft (Q3 a)');
select pg_temp.assert(not exists (select 1 from public.book_reviews where book_id = 'e0920001-0000-4000-8000-000000000003' and status = 'pending')
  and exists (select 1 from public.book_reviews where book_id = 'e0920001-0000-4000-8000-000000000003' and status = 'cancelled'),
  'part5: the author''s unpublish cancelled the waiting review (audit r1, F3)');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set status = 'published' where id = 'e0920001-0000-4000-8000-000000000003'$q$) like 'LB462:%',
  'part5: publishing it again needs review');
select pg_temp.assert(pg_temp.request('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000003')
  ~ '^[0-9a-f-]{36}$', 'part5: the draft is sent the usual way');

-- l6: changes sent for review, then Librum takes the book down.
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set reading_age_min = 12 where id = 'e0920001-0000-4000-8000-000000000006'$q$) = 'OK:1',
  'part5: l6 is for readers 12+ (an instant field)');
select pg_temp.assert(pg_temp.save('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000006', 'a/l6/v2.epub', 'e092000c-0000-4000-8000-000000000008/cover.jpg', 'New six.', true) = 'OK:1',
  'part5: l6 has changes, with the 18+ label');
select pg_temp.assert(pg_temp.request('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000006')
  ~ '^[0-9a-f-]{36}$', 'part5: and sends them');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0920000-0000-4000-8000-0000000000c1',
  $q$select public.admin_unpublish_book('e0920001-0000-4000-8000-000000000006', 'copyright', 'A complaint.')$q$) = 'OK:1',
  'part5: staff take l6 down while its changes wait');
select pg_temp.assert((select (status, file_path, description, is_adult, reading_age_min) = ('draft', 'a/l6/v2.epub', 'New six.', true, 18::smallint)
                         from public.books where id = 'e0920001-0000-4000-8000-000000000006')
  and not exists (select 1 from public.book_pending_changes where book_id = 'e0920001-0000-4000-8000-000000000006')
  and not exists (select 1 from public.book_reviews where book_id = 'e0920001-0000-4000-8000-000000000006' and status = 'pending')
  and exists (select 1 from public.book_reviews where book_id = 'e0920001-0000-4000-8000-000000000006' and status = 'cancelled')
  and exists (select 1 from public.book_takedowns where book_id = 'e0920001-0000-4000-8000-000000000006' and lifted_at is null),
  'part5: the review is cancelled, the changes are the draft (18+ means reading age 18, audit r1 F3), the takedown is recorded');
select pg_temp.assert((select r.file_path from public.book_reviews r
                        where r.book_id = 'e0920001-0000-4000-8000-000000000006' and r.status = 'approved'
                        order by r.decided_at desc, r.id desc limit 1) = 'a/l6/v1.epub',
  'part5: readers keep the approved file');
select pg_temp.assert(pg_temp.request('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000006')
  like 'LB460:%', 'part5: a taken-down book can''t be sent around the takedown');

-- l5: author B is suspended with changes saved.
select pg_temp.assert(pg_temp.save('e0920000-0000-4000-8000-00000000000b', 'e0920001-0000-4000-8000-000000000005', 'b/l5/v2.epub', 'e092000c-0000-4000-8000-000000000010/cover.jpg', 'Old five.', false) = 'OK:1',
  'part5: l5 has changes');
insert into public.book_ai_disclosures (book_id, ai_used) values ('e0920001-0000-4000-8000-000000000005', false)
  on conflict (book_id) do nothing;
select pg_temp.assert(pg_temp.request('e0920000-0000-4000-8000-00000000000b', 'e0920001-0000-4000-8000-000000000005')
  ~ '^[0-9a-f-]{36}$', 'part5: and sends them');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0920000-0000-4000-8000-0000000000c1',
  $q$select public.admin_suspend_account('e0920000-0000-4000-8000-00000000000b', 'Spam.')$q$) = 'OK:1',
  'part5: staff suspend B');
select pg_temp.assert((select (status, file_path) = ('draft', 'b/l5/v2.epub') from public.books where id = 'e0920001-0000-4000-8000-000000000005')
  and not exists (select 1 from public.book_pending_changes where book_id = 'e0920001-0000-4000-8000-000000000005'),
  'part5: a suspension also makes the changes the draft');
select pg_temp.assert(not exists (select 1 from public.book_reviews where book_id = 'e0920001-0000-4000-8000-000000000005' and status = 'pending'),
  'part5: and cancels the waiting review (audit r1, F3)');

-- l7: a picked public-domain edition can't be taken off sale by its
-- author; its changes stay pending.
insert into public.pd_works (id, title, original_author) values
  ('e0920006-0000-4000-8000-000000000001', 'P092 Work', 'Naim Frashëri');
update public.books set pd_work_id = 'e0920006-0000-4000-8000-000000000001' where id = 'e0920001-0000-4000-8000-000000000007';
update public.pd_works set picked_book_id = 'e0920001-0000-4000-8000-000000000007' where id = 'e0920006-0000-4000-8000-000000000001';
select pg_temp.assert(pg_temp.save('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000007', 'a/l7/v2.epub', 'e092000c-0000-4000-8000-000000000009/cover.jpg', 'Old seven.', false) = 'OK:1',
  'part5: l7 has changes');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set status = 'draft' where id = 'e0920001-0000-4000-8000-000000000007'$q$) like 'LB483:%',
  'part5: the picked edition can''t be taken off sale by its author');
select pg_temp.assert((select (status, file_path) = ('published', 'a/l7/v1.epub') from public.books where id = 'e0920001-0000-4000-8000-000000000007')
  and exists (select 1 from public.book_pending_changes where book_id = 'e0920001-0000-4000-8000-000000000007'),
  'part5: so it stays live and its changes stay pending');

-- ============================================================
-- Part 6: the approval binds description and the 18+ label
-- ============================================================
-- l2 (no pending changes): off sale and back needs no review ...
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set status = 'draft' where id = 'e0920001-0000-4000-8000-000000000002'$q$) = 'OK:1'
  and pg_temp.run_as('service_role', null,
  $q$update public.books set status = 'published' where id = 'e0920001-0000-4000-8000-000000000002'$q$) = 'OK:1',
  'part6: off sale and back with the approved version works');
-- ... but a new description, or the 18+ label, on the draft does.
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set status = 'draft' where id = 'e0920001-0000-4000-8000-000000000002'$q$) = 'OK:1'
  and pg_temp.run_as('service_role', null,
  $q$update public.books set description = 'Changed offline.' where id = 'e0920001-0000-4000-8000-000000000002'$q$) = 'OK:1',
  'part6: off sale, then a new description');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set status = 'published' where id = 'e0920001-0000-4000-8000-000000000002'$q$) like 'LB462:%',
  'part6: a new description needs review before going live again');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set description = 'Old two.', is_adult = true where id = 'e0920001-0000-4000-8000-000000000002'$q$) = 'OK:1'
  and pg_temp.run_as('service_role', null,
  $q$update public.books set status = 'published' where id = 'e0920001-0000-4000-8000-000000000002'$q$) like 'LB462:%',
  'part6: so does the 18+ label');
-- A row from before the migration (null snapshot) still binds the files.
select pg_temp.assert(
  public.book_review_approval_valid('e0920001-0000-4000-8000-0000000000d1', 'a/d1/v1.epub', 'e092000c-0000-4000-8000-000000000001/cover.jpg', null, 'Anything', true) = false,
  'part6: (no approval for d1 yet)');
insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, status, checklist, decided_at)
values ('e0920001-0000-4000-8000-0000000000d1', 'P092 d1', 'e0920000-0000-4000-8000-00000000000a', 'a/d1/v1.epub', 'e092000c-0000-4000-8000-000000000001/cover.jpg',
        'approved', pg_temp.checklist()::jsonb, now());
select pg_temp.assert(
  public.book_review_approval_valid('e0920001-0000-4000-8000-0000000000d1', 'a/d1/v1.epub', 'e092000c-0000-4000-8000-000000000001/cover.jpg', null, 'Anything', true)
  and not public.book_review_approval_valid('e0920001-0000-4000-8000-0000000000d1', 'a/d1/v2.epub', 'e092000c-0000-4000-8000-000000000001/cover.jpg', null, 'Anything', true),
  'part6: an old approval with no description snapshot binds only the files');

-- ============================================================
-- Part 7: a live book keeps its rights basis (Q4 a)
-- ============================================================
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$insert into public.book_rights_declarations (book_id, book_title, author_id, author_public_name, basis, statement_version, statement_text)
     values ('e0920001-0000-4000-8000-000000000001', 'P092 l1', 'e0920000-0000-4000-8000-00000000000a', 'P092 Ana', 'own_rights', 'v', 'Mine.')$q$) = 'OK:1',
  'part7: a live book records its own-rights statement again (a send)');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$insert into public.book_rights_declarations (book_id, book_title, author_id, author_public_name, basis, statement_version, statement_text)
     values ('e0920001-0000-4000-8000-000000000001', 'P092 l1', 'e0920000-0000-4000-8000-00000000000a', 'P092 Ana', 'public_domain', 'v', 'PD.')$q$) like 'LB492:%',
  'part7: a live book can''t switch to public domain');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$insert into public.book_rights_declarations (book_id, book_title, author_id, author_public_name, basis, statement_version, statement_text)
     values ('e0920001-0000-4000-8000-000000000001', 'P092 l1', 'e0920000-0000-4000-8000-00000000000a', 'P092 Ana', 'bogus', 'v', 'X.')$q$) like '23514:%',
  'part7: an unknown basis is still the CHECK''s answer');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$insert into public.book_rights_declarations (book_id, book_title, author_id, author_public_name, basis, statement_version, statement_text)
     values ('e0920001-0000-4000-8000-000000000004', 'P092 l4', 'e0920000-0000-4000-8000-00000000000a', 'P092 Ana', 'public_domain_original', 'v', 'PD.')$q$) like 'LB492:%',
  'part7: a live book with no statement yet may only state its own rights');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$insert into public.book_rights_declarations (book_id, book_title, author_id, author_public_name, basis, statement_version, statement_text)
     values ('e0920001-0000-4000-8000-000000000003', 'P092 l3', 'e0920000-0000-4000-8000-00000000000a', 'P092 Ana', 'public_domain', 'v', 'PD.')$q$) like 'LB490:%',
  'part7: (l3 is a draft in review, so P5a''s lock answers)');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$insert into public.book_rights_declarations (book_id, book_title, author_id, author_public_name, basis, statement_version, statement_text)
     values ('e0920001-0000-4000-8000-0000000000d1', 'P092 d1', 'e0920000-0000-4000-8000-00000000000a', 'P092 Ana', 'public_domain', 'v', 'PD.')$q$) = 'OK:1',
  'part7: a draft may switch its basis');
select pg_temp.assert(pg_temp.run_as(null, null,
  $q$insert into public.book_rights_declarations (book_id, book_title, author_id, author_public_name, basis, statement_version, statement_text)
     values ('e0920001-0000-4000-8000-000000000001', 'P092 l1', 'e0920000-0000-4000-8000-00000000000a', 'P092 Ana', 'public_domain', 'v', 'Support.')$q$) = 'OK:1',
  'part7: Librum''s own SQL session (support) is not checked');

-- ============================================================
-- Part 8: deleting a live book with changes waiting
-- ============================================================
select pg_temp.assert((select count(*) = 1 from public.book_pending_changes where book_id = 'e0920001-0000-4000-8000-000000000004'),
  'part8: l4 has one pending row');
insert into public.book_ai_disclosures (book_id, ai_used) values ('e0920001-0000-4000-8000-000000000004', true);
select pg_temp.assert(pg_temp.request('e0920000-0000-4000-8000-00000000000a', 'e0920001-0000-4000-8000-000000000004')
  ~ '^[0-9a-f-]{36}$', 'part8: with the AI answer given, l4''s changes are sent');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$delete from public.books where id = 'e0920001-0000-4000-8000-000000000004'$q$) = 'OK:1',
  'part8: the author deletes l4 while its changes wait');
select pg_temp.assert(not exists (select 1 from public.book_pending_changes where book_id = 'e0920001-0000-4000-8000-000000000004')
  and exists (select 1 from public.book_reviews where book_title = 'P092 l4' and status = 'cancelled'),
  'part8: the changes are gone and the review is cancelled');

do $$
begin
  perform pg_temp.assert((select n from pg_temp.assertions_run) >= 105,
    format('expected at least 105 assertions, ran %s', (select n from pg_temp.assertions_run)));
end $$;

select 'ALL PASSED: 092_bd15_live_pending_changes.test.sql (' || (select n from pg_temp.assertions_run) || ' assertions)' as result;

rollback;
