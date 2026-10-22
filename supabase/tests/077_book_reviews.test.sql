-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for ADMIN-3-REVIEW
-- (supabase/migrations/20261020120000_book_reviews.sql):
--
-- * books.review: owner and admin yes; moderator, editor, support, a
--   reader and anon no;
-- * book_reviews: RLS on; authenticated holds SELECT on the author-facing
--   columns only (select * and select id fail with 42501), anon nothing,
--   service_role SELECT only; nobody may INSERT, UPDATE or DELETE; an
--   author reads only their own rows;
-- * request_book_review / withdraw_book_review / book_review_state: only
--   the book's author, only in valid states; a stale pending review is
--   replaced (cancelled + new pending) in one call, never rewritten;
--   latest_sent_back only while the newest row is that send back;
-- * admin_approve_book_review / admin_send_back_book_review: the state
--   machine; a path, price, description or checklist mismatch is
--   refused; approve publishes in the same transaction and audits;
--   send back audits the reason, never the message;
-- * the publish gate (LB462) for service_role and the table owner
--   (authenticated has no status write at all, and no INSERT); republish
--   with a matching approval works (3a); a write that publishes AND
--   changes a path is refused (N4); an approval older than the latest
--   takedown does not count (9a); LB460 still fires first;
-- * the live-files guard (LB463), with the draft-in-the-same-write
--   escape;
-- * a deleted book's pending review is cancelled, directly and through
--   the account cascade; a takedown cancels a pending review;
-- * manuscripts storage: own tmp/ insert, upsert and delete work; a final
--   key cannot be inserted, updated, deleted or renamed onto; another
--   user's tmp/ cannot be touched;
-- * the audit list RPC accepts the two new actions;
-- * A1: a buyer_file_only row never satisfies the gate or approval_valid,
--   and request_book_review is allowed (Part 17).
--
-- The backfill (one grandfathered approval per published book, and one
-- grandfathered buyer_file_only approval per draft with a purchase, a past
-- publication or a takedown; none for other
-- drafts) runs only in the migration; 077_book_reviews_catalog_
-- equivalence.sh checks it over populated data, with the schema.sql /
-- migration equivalence.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance (on 16 strip ", maintain" from a copy of schema.sql):
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/077_book_reviews.test.sql
--
-- It must also pass against the base schema.sql plus the migration.
--
-- Everything runs inside one transaction and is rolled back at the end.
-- now() is one instant for the whole transaction, so where a test needs
-- "a takedown BEFORE an approval" it moves the takedown back in time.

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

-- Runs p_sql as p_role with auth.uid() = p_sub; returns 'OK:<rows>' or
-- '<sqlstate>:<message>'. Each call is its own subtransaction.
create function pg_temp.run_as(p_role text, p_sub text, p_sql text) returns text
  language plpgsql as $$
declare
  v_state text;
  v_msg text;
  v_rows bigint;
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
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

-- Same, for a query returning one text value.
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

-- The approve call as SQL text: review, paths, price, checklist.
create function pg_temp.approve_sql(p_review uuid, p_file text, p_cover text, p_price integer, p_checklist text) returns text
  language sql as $$
  select format('select public.admin_approve_book_review(%L, %L, %L, %s, %L::jsonb)::text',
                p_review, p_file, p_cover, coalesce(p_price::text, 'null'), p_checklist)
$$;

create function pg_temp.pending_id(p_book uuid) returns uuid language sql as $$
  select id from public.book_reviews where book_id = p_book and status = 'pending'
$$;
-- The whole file is one transaction, so now() never moves: age a book's
-- existing review rows so "newest" follows the real order of events.
create function pg_temp.age_reviews(p_book uuid) returns void language sql as $$
  update public.book_reviews
     set submitted_at = submitted_at - interval '1 hour',
         decided_at = decided_at - interval '1 hour'
   where book_id = p_book
$$;

-- ============================================================
-- Part 0: fixtures.
--   A  author: L (published, with a grandfathered approval as the
--      migration's backfill gives it), D (draft, never published, ready),
--      E2 (draft, ready), X (draft, to be deleted)
--   B  author: Q (draft, pending at the account cascade)
--   R  a reader; O owner, AD admin, M moderator, S support, ED editor
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0770000-0000-4000-8000-00000000000a', 'p077-a@test', now(), '{"role":"author","display_name":"P077 Ana"}'),
  ('e0770000-0000-4000-8000-00000000000b', 'p077-b@test', now(), '{"role":"author","display_name":"P077 Ben"}'),
  ('e0770000-0000-4000-8000-0000000000aa', 'p077-r@test', now(), '{"role":"reader","display_name":"P077 Reader"}'),
  ('e0770000-0000-4000-8000-0000000000c1', 'p077-o@test', now(), '{"role":"reader","display_name":"P077 Owner"}'),
  ('e0770000-0000-4000-8000-0000000000c2', 'p077-ad@test', now(), '{"role":"reader","display_name":"P077 Admin"}'),
  ('e0770000-0000-4000-8000-0000000000c3', 'p077-m@test', now(), '{"role":"reader","display_name":"P077 Moderator"}'),
  ('e0770000-0000-4000-8000-0000000000c4', 'p077-s@test', now(), '{"role":"reader","display_name":"P077 Support"}'),
  ('e0770000-0000-4000-8000-0000000000c5', 'p077-e@test', now(), '{"role":"reader","display_name":"P077 Editor"}');

insert into public.staff_members (user_id, role) values
  ('e0770000-0000-4000-8000-0000000000c1', 'owner'),
  ('e0770000-0000-4000-8000-0000000000c2', 'admin'),
  ('e0770000-0000-4000-8000-0000000000c3', 'moderator'),
  ('e0770000-0000-4000-8000-0000000000c4', 'support'),
  ('e0770000-0000-4000-8000-0000000000c5', 'editor');

insert into public.books (id, author_id, title, description, status, price_all, published_at, file_path, cover_path) values
  ('e0770001-0000-4000-8000-0000000000a1', 'e0770000-0000-4000-8000-00000000000a', 'P077 Live', 'About it.', 'published', 499, now(),
   'e0770000-0000-4000-8000-00000000000a/e0770001-0000-4000-8000-0000000000a1.epub', 'e077c0de-0000-4000-8000-0000000000a1/cover.jpg'),
  ('e0770001-0000-4000-8000-0000000000a2', 'e0770000-0000-4000-8000-00000000000a', 'P077 Draft', 'About it.', 'draft', 199, null,
   'e0770000-0000-4000-8000-00000000000a/e0770001-0000-4000-8000-0000000000a2/f0000000-0000-4000-8000-000000000001.epub', 'e077c0de-0000-4000-8000-0000000000a2/cover.png'),
  ('e0770001-0000-4000-8000-0000000000a3', 'e0770000-0000-4000-8000-00000000000a', 'P077 Second', 'About it.', 'draft', 0, null,
   'e0770000-0000-4000-8000-00000000000a/e0770001-0000-4000-8000-0000000000a3/f0000000-0000-4000-8000-000000000003.epub', 'e077c0de-0000-4000-8000-0000000000a3/cover.png'),
  ('e0770001-0000-4000-8000-0000000000a4', 'e0770000-0000-4000-8000-00000000000a', 'P077 Gone', 'About it.', 'draft', 0, null,
   'e0770000-0000-4000-8000-00000000000a/e0770001-0000-4000-8000-0000000000a4/f0000000-0000-4000-8000-000000000004.epub', 'e077c0de-0000-4000-8000-0000000000a4/cover.png'),
  ('e0770001-0000-4000-8000-0000000000b1', 'e0770000-0000-4000-8000-00000000000b', 'P077 Ben', 'About it.', 'draft', 0, null,
   'e0770000-0000-4000-8000-00000000000b/e0770001-0000-4000-8000-0000000000b1.epub', 'e077c0de-0000-4000-8000-0000000000b1/cover.jpg');

update public.books set librum_choice_at = now() where id = 'e0770001-0000-4000-8000-0000000000a2';

-- What the migration's backfill writes for a book that is live (1a).
insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, status, grandfathered, decided_at)
select id, title, author_id, file_path, cover_path, 'approved', true, now()
  from public.books where id = 'e0770001-0000-4000-8000-0000000000a1';

-- ============================================================
-- Part 1: privileges, functions, triggers, constraints.
-- ============================================================
do $$
declare
  c text;
  r text;
begin
  perform pg_temp.assert((select relrowsecurity from pg_class where oid = 'public.book_reviews'::regclass),
    'part1: RLS is on');
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    perform pg_temp.assert(not has_table_privilege(r, 'public.book_reviews', 'INSERT')
      and not has_table_privilege(r, 'public.book_reviews', 'UPDATE')
      and not has_table_privilege(r, 'public.book_reviews', 'DELETE')
      and not has_table_privilege(r, 'public.book_reviews', 'TRUNCATE')
      and not has_any_column_privilege(r, 'public.book_reviews', 'INSERT')
      and not has_any_column_privilege(r, 'public.book_reviews', 'UPDATE'),
      format('part1: %s cannot insert, update, delete or truncate', r));
  end loop;
  perform pg_temp.assert(not has_table_privilege('anon', 'public.book_reviews', 'SELECT')
    and not has_any_column_privilege('anon', 'public.book_reviews', 'SELECT'), 'part1: anon has no SELECT at all');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.book_reviews', 'SELECT'),
    'part1: authenticated has no table-level SELECT');
  foreach c in array array['book_id', 'book_title', 'author_id', 'status', 'submitted_at', 'reason', 'message_to_author', 'decided_at'] loop
    perform pg_temp.assert(has_column_privilege('authenticated', 'public.book_reviews', c, 'SELECT'),
      format('part1: authenticated reads %s', c));
  end loop;
  foreach c in array array['id', 'file_path', 'cover_path', 'checklist', 'decided_by', 'grandfathered'] loop
    perform pg_temp.assert(not has_column_privilege('authenticated', 'public.book_reviews', c, 'SELECT'),
      format('part1: authenticated cannot read %s', c));
  end loop;
  perform pg_temp.assert(has_table_privilege('service_role', 'public.book_reviews', 'SELECT'),
    'part1: service_role reads every column');

  foreach c in array array[
    'public.request_book_review(uuid)', 'public.withdraw_book_review(uuid)', 'public.book_review_state(uuid)',
    'public.admin_approve_book_review(uuid,text,text,integer,jsonb)', 'public.admin_send_back_book_review(uuid,text,text)'] loop
    perform pg_temp.assert(has_function_privilege('authenticated', c, 'EXECUTE')
      and not has_function_privilege('anon', c, 'EXECUTE')
      and not has_function_privilege('service_role', c, 'EXECUTE')
      and (select prosecdef from pg_proc where oid = c::regprocedure)
      and (select proconfig from pg_proc where oid = c::regprocedure) = array['search_path=""'],
      format('part1: %s is SECURITY DEFINER, search_path empty, EXECUTE for authenticated only', c));
  end loop;
  foreach c in array array[
    'public.book_review_approval_valid(uuid,text,text)', 'public.books_require_review_approval()',
    'public.books_refuse_live_file_change()', 'public.books_cancel_pending_review_on_delete()'] loop
    perform pg_temp.assert(not has_function_privilege('anon', c, 'EXECUTE')
      and not has_function_privilege('authenticated', c, 'EXECUTE')
      and not has_function_privilege('service_role', c, 'EXECUTE')
      and (select prosecdef from pg_proc where oid = c::regprocedure)
      and (select proconfig from pg_proc where oid = c::regprocedure) = array['search_path=""'],
      format('part1: %s is internal (no API EXECUTE), SECURITY DEFINER, search_path empty', c));
  end loop;

  perform pg_temp.assert((select pg_get_triggerdef(oid) from pg_trigger where tgname = 'books_require_review_approval')
      like '%BEFORE UPDATE OF status ON public.books FOR EACH ROW%',
    'part1: the gate is BEFORE UPDATE OF status only (no INSERT trigger)');
  perform pg_temp.assert((select pg_get_triggerdef(oid) from pg_trigger where tgname = 'books_refuse_live_file_change')
      like '%BEFORE UPDATE OF file_path, cover_path ON public.books FOR EACH ROW%',
    'part1: the live-files guard is BEFORE UPDATE OF file_path, cover_path');
  perform pg_temp.assert((select pg_get_triggerdef(oid) from pg_trigger where tgname = 'books_cancel_pending_review_on_delete')
      like '%BEFORE DELETE ON public.books FOR EACH ROW%',
    'part1: the cancel-on-delete trigger is BEFORE DELETE');
  perform pg_temp.assert('books_refuse_publish_while_taken_down' < 'books_require_review_approval',
    'part1: the takedown lock sorts (and so fires) before the review gate');
  perform pg_temp.assert(not exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                                      where c.relname = 'books' and not t.tgisinternal
                                        and (t.tgtype::int & 4) = 4
                                        and t.tgfoid = 'public.books_require_review_approval()'::regprocedure),
    'part1: no INSERT trigger runs the gate');

  -- Constraints the RPCs rely on.
  perform pg_temp.assert(pg_temp.run_as(current_user, null,
      $q$insert into public.book_reviews (book_id, book_title, status) values ('e0770001-0000-4000-8000-0000000000a3', 'x', 'sent_back')$q$)
      like '23514:%', 'part1: a send back needs a reason and a message');
  perform pg_temp.assert(pg_temp.run_as(current_user, null,
      $q$insert into public.book_reviews (book_id, book_title, status, decided_at) values ('e0770001-0000-4000-8000-0000000000a3', 'x', 'approved', now())$q$)
      like '23514:%', 'part1: a staff approval needs the checklist');
  perform pg_temp.assert(pg_temp.run_as(current_user, null,
      $q$insert into public.book_reviews (book_id, book_title, status, grandfathered, decided_at) values ('e0770001-0000-4000-8000-0000000000a3', 'x', 'withdrawn', true, now())$q$)
      like '23514:%', 'part1: only an approval can be grandfathered');
  perform pg_temp.assert(pg_temp.run_as(current_user, null,
      $q$insert into public.book_reviews (book_id, book_title, status, checklist, decided_at) values ('e0770001-0000-4000-8000-0000000000a3', 'x', 'approved', '{"cover_is_fine": true}', now())$q$)
      like '23514:%', 'part1: a partial checklist is refused');
  perform pg_temp.assert(pg_temp.run_as(current_user, null,
      $q$insert into public.book_reviews (book_id, book_title, status) values ('e0770001-0000-4000-8000-0000000000a3', 'x', 'cancelled')$q$)
      like '23514:%', 'part1: a decided row has decided_at');
end $$;

-- ============================================================
-- Part 2: books.review.
-- ============================================================
do $$
declare
  v text;
begin
  v := pg_temp.value_as('authenticated', 'e0770000-0000-4000-8000-0000000000c1', $q$select public.staff_has_permission('books.review')::text$q$);
  perform pg_temp.assert(v = 'true', format('part2: owner has books.review -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0770000-0000-4000-8000-0000000000c2', $q$select public.staff_has_permission('books.review')::text$q$);
  perform pg_temp.assert(v = 'true', format('part2: admin has books.review -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0770000-0000-4000-8000-0000000000c3', $q$select public.staff_has_permission('books.review')::text$q$);
  perform pg_temp.assert(v = 'false', format('part2: moderator has not -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0770000-0000-4000-8000-0000000000c4', $q$select public.staff_has_permission('books.review')::text$q$);
  perform pg_temp.assert(v = 'false', format('part2: support has not -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0770000-0000-4000-8000-0000000000c5', $q$select public.staff_has_permission('books.review')::text$q$);
  perform pg_temp.assert(v = 'false', format('part2: editor has not -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0770000-0000-4000-8000-0000000000aa', $q$select public.staff_has_permission('books.review')::text$q$);
  perform pg_temp.assert(v = 'false', format('part2: a reader has not -- got %s', v));
  v := pg_temp.value_as('anon', null, $q$select public.staff_has_permission('books.review')::text$q$);
  perform pg_temp.assert(v = 'false', format('part2: anon has not -- got %s', v));
  -- The rest of the admin list is unchanged.
  v := pg_temp.value_as('authenticated', 'e0770000-0000-4000-8000-0000000000c2', $q$select public.staff_has_permission('finance.payout_operate')::text$q$);
  perform pg_temp.assert(v = 'true', format('part2: admin keeps finance.payout_operate -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0770000-0000-4000-8000-0000000000c2', $q$select public.staff_has_permission('staff.manage')::text$q$);
  perform pg_temp.assert(v = 'false', format('part2: admin still lacks staff.manage -- got %s', v));
end $$;

-- ============================================================
-- Part 3: the publish gate, before any review exists.
-- ============================================================
do $$
declare
  v text;
begin
  v := pg_temp.run_as('authenticated', 'e0770000-0000-4000-8000-00000000000a',
    $q$insert into public.books (author_id, title) values ('e0770000-0000-4000-8000-00000000000a', 'x')$q$);
  perform pg_temp.assert(v like '42501:%', format('part3: authenticated cannot INSERT books at all (M4) -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0770000-0000-4000-8000-00000000000a',
    $q$update public.books set status = 'published' where id = 'e0770001-0000-4000-8000-0000000000a2'$q$);
  perform pg_temp.assert(v like '42501:%', format('part3: the author session has no status write -- got %s', v));
  v := pg_temp.run_as('service_role', null,
    $q$update public.books set status = 'published' where id = 'e0770001-0000-4000-8000-0000000000a2'$q$);
  perform pg_temp.assert(v like 'LB462:%', format('part3: service_role cannot publish a never-reviewed draft -- got %s', v));
  begin
    update public.books set status = 'published' where id = 'e0770001-0000-4000-8000-0000000000a2';
    perform pg_temp.assert(false, 'part3: the table owner was not refused');
  exception when sqlstate 'LB462' then
    perform pg_temp.assert(true, 'part3: the table owner is refused too');
  end;
  v := pg_temp.run_as('service_role', null,
    $q$update public.books set title = 'P077 Draft', status = 'draft' where id = 'e0770001-0000-4000-8000-0000000000a2'$q$);
  perform pg_temp.assert(v = 'OK:1', format('part3: draft writes and other columns still work -- got %s', v));
  v := pg_temp.run_as('service_role', null,
    $q$update public.books set status = 'published', title = 'P077 Live' where id = 'e0770001-0000-4000-8000-0000000000a1'$q$);
  perform pg_temp.assert(v = 'OK:1', format('part3: a published -> published write is not gated -- got %s', v));
end $$;

-- ============================================================
-- Part 4: request_book_review and who reads reviews.
-- ============================================================
do $$
declare
  a constant text := 'e0770000-0000-4000-8000-00000000000a';
  d constant uuid := 'e0770001-0000-4000-8000-0000000000a2';
  v text;
  r record;
  cols constant text := 'book_id, book_title, author_id, status, submitted_at, reason, message_to_author, decided_at';
begin
  v := pg_temp.run_as('anon', null, format('select public.request_book_review(%L)', d));
  perform pg_temp.assert(v like '42501:%', format('part4: anon cannot execute -- got %s', v));
  v := pg_temp.run_as('service_role', null, format('select public.request_book_review(%L)', d));
  perform pg_temp.assert(v like '42501:%', format('part4: service_role cannot execute -- got %s', v));
  v := pg_temp.run_as('authenticated', null, format('select public.request_book_review(%L)', d));
  perform pg_temp.assert(v = 'P0001:not authenticated', format('part4: no session -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0770000-0000-4000-8000-00000000000b', format('select public.request_book_review(%L)', d));
  perform pg_temp.assert(v = 'P0001:no book found for this id', format('part4: another author is refused -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0770000-0000-4000-8000-0000000000c1', format('select public.request_book_review(%L)', d));
  perform pg_temp.assert(v = 'P0001:no book found for this id', format('part4: staff cannot request for an author -- got %s', v));
  v := pg_temp.run_as('authenticated', a, $q$select public.request_book_review('e0770001-0000-4000-8000-0000000000a1')$q$);
  perform pg_temp.assert(v = 'P0001:this book is already published', format('part4: a live book is refused -- got %s', v));
  v := pg_temp.run_as('authenticated', a, $q$select public.request_book_review('e0770001-0000-4000-8000-0000000000ff')$q$);
  perform pg_temp.assert(v = 'P0001:no book found for this id', format('part4: a missing book -- got %s', v));

  v := pg_temp.value_as('authenticated', a, format('select public.request_book_review(%L)::text', d));
  perform pg_temp.assert(v = (select id::text from public.book_reviews where book_id = d and status = 'pending'),
    format('part4: the author sends the draft; returns the id -- got %s', v));
  select * into r from public.book_reviews where book_id = d and status = 'pending';
  perform pg_temp.assert(r.book_title = 'P077 Draft' and r.author_id = a::uuid
    and r.file_path = (select file_path from public.books where id = d)
    and r.cover_path = (select cover_path from public.books where id = d)
    and r.decided_at is null and r.decided_by is null and r.checklist is null and not r.grandfathered,
    'part4: the pending row snapshots title, file and cover');
  v := pg_temp.run_as('authenticated', a, format('select public.request_book_review(%L)', d));
  perform pg_temp.assert(v = 'P0001:this book is already waiting for review', format('part4: a second request -- got %s', v));
  perform pg_temp.assert((select status from public.books where id = d) = 'draft', 'part4: the book stays a draft');

  v := pg_temp.value_as('authenticated', a,
    format($q$select string_agg(book_title || ':' || status, ',' order by book_title) from (select %s from public.book_reviews) t$q$, cols));
  perform pg_temp.assert(v = 'P077 Draft:pending,P077 Live:approved', format('part4: the author reads their own rows -- got %s', v));
  v := pg_temp.run_as('authenticated', a, 'select * from public.book_reviews');
  perform pg_temp.assert(v like '42501:%', format('part4: select * by an author session is 42501 -- got %s', v));
  v := pg_temp.run_as('authenticated', a, 'select id from public.book_reviews');
  perform pg_temp.assert(v like '42501:%', format('part4: select id is 42501 -- got %s', v));
  v := pg_temp.run_as('authenticated', a, 'select file_path from public.book_reviews');
  perform pg_temp.assert(v like '42501:%', format('part4: paths are not readable by authors -- got %s', v));
  v := pg_temp.run_as('authenticated', a, 'select decided_by from public.book_reviews');
  perform pg_temp.assert(v like '42501:%', format('part4: the staff id is not readable by authors -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0770000-0000-4000-8000-00000000000b',
    format('select count(*)::text from (select %s from public.book_reviews) t', cols));
  perform pg_temp.assert(v = '0', format('part4: another author reads none -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0770000-0000-4000-8000-0000000000c1',
    format('select count(*)::text from (select %s from public.book_reviews) t', cols));
  perform pg_temp.assert(v = '0', format('part4: staff sessions read none (the admin pages use the service role) -- got %s', v));
  v := pg_temp.run_as('anon', null, 'select book_title from public.book_reviews');
  perform pg_temp.assert(v like '42501:%', format('part4: anon read is 42501 -- got %s', v));
  v := pg_temp.value_as('service_role', null, 'select count(*)::text from public.book_reviews');
  perform pg_temp.assert(v = '2', format('part4: service_role reads every row -- got %s', v));
end $$;

-- ============================================================
-- Part 5: nobody writes reviews directly.
-- ============================================================
do $$
declare
  v text;
  r text;
begin
  foreach r in array array['authenticated', 'service_role', 'anon'] loop
    v := pg_temp.run_as(r, 'e0770000-0000-4000-8000-00000000000a',
      $q$insert into public.book_reviews (book_id, book_title, author_id, status)
         values ('e0770001-0000-4000-8000-0000000000a3', 'x', 'e0770000-0000-4000-8000-00000000000a', 'pending')$q$);
    perform pg_temp.assert(v like '42501:%', format('part5: %s cannot insert -- got %s', r, v));
    v := pg_temp.run_as(r, 'e0770000-0000-4000-8000-00000000000a', $q$update public.book_reviews set status = 'approved'$q$);
    perform pg_temp.assert(v like '42501:%', format('part5: %s cannot update -- got %s', r, v));
    v := pg_temp.run_as(r, 'e0770000-0000-4000-8000-00000000000a', $q$delete from public.book_reviews$q$);
    perform pg_temp.assert(v like '42501:%', format('part5: %s cannot delete -- got %s', r, v));
  end loop;
end $$;

-- ============================================================
-- Part 6: book_review_state.
-- ============================================================
do $$
declare
  v text;
begin
  v := pg_temp.value_as('authenticated', 'e0770000-0000-4000-8000-00000000000a',
    $q$select public.book_review_state('e0770001-0000-4000-8000-0000000000a2')::text$q$);
  perform pg_temp.assert(v::jsonb = '{"pending": true, "approval_valid": false, "latest_sent_back": null}'::jsonb,
    format('part6: a pending draft -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0770000-0000-4000-8000-00000000000a',
    $q$select public.book_review_state('e0770001-0000-4000-8000-0000000000a1')::text$q$);
  perform pg_temp.assert(v::jsonb = '{"pending": false, "approval_valid": true, "latest_sent_back": null}'::jsonb,
    format('part6: the grandfathered live book is approved -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0770000-0000-4000-8000-00000000000a',
    $q$select public.book_review_state('e0770001-0000-4000-8000-0000000000a3')::text$q$);
  perform pg_temp.assert(v::jsonb = '{"pending": false, "approval_valid": false, "latest_sent_back": null}'::jsonb,
    format('part6: a draft with no review row -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0770000-0000-4000-8000-00000000000b',
    $q$select public.book_review_state('e0770001-0000-4000-8000-0000000000a2')::text$q$);
  perform pg_temp.assert(v = 'P0001:no book found for this id', format('part6: another author is refused -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0770000-0000-4000-8000-0000000000c1',
    $q$select public.book_review_state('e0770001-0000-4000-8000-0000000000a2')::text$q$);
  perform pg_temp.assert(v = 'P0001:no book found for this id', format('part6: staff are refused -- got %s', v));
  v := pg_temp.value_as('anon', null, $q$select public.book_review_state('e0770001-0000-4000-8000-0000000000a2')::text$q$);
  perform pg_temp.assert(v like '42501:%', format('part6: anon cannot execute -- got %s', v));
end $$;

-- ============================================================
-- Part 7: approve -- who, and every refusal.
-- ============================================================
do $$
declare
  d constant uuid := 'e0770001-0000-4000-8000-0000000000a2';
  rid uuid := pg_temp.pending_id('e0770001-0000-4000-8000-0000000000a2');
  f text := (select file_path from public.books where id = 'e0770001-0000-4000-8000-0000000000a2');
  c text := (select cover_path from public.books where id = 'e0770001-0000-4000-8000-0000000000a2');
  ad constant text := 'e0770000-0000-4000-8000-0000000000c2';
  v text;
  who text;
begin
  foreach who in array array['e0770000-0000-4000-8000-0000000000c3', 'e0770000-0000-4000-8000-0000000000c4',
                             'e0770000-0000-4000-8000-0000000000c5', 'e0770000-0000-4000-8000-00000000000a',
                             'e0770000-0000-4000-8000-0000000000aa'] loop
    v := pg_temp.run_as('authenticated', who, pg_temp.approve_sql(rid, f, c, 199, pg_temp.checklist()));
    perform pg_temp.assert(v = 'P0001:not authorized', format('part7: %s may not approve -- got %s', who, v));
    v := pg_temp.run_as('authenticated', who,
      format($q$select public.admin_send_back_book_review(%L, 'other', 'Probe')$q$, rid));
    perform pg_temp.assert(v = 'P0001:not authorized', format('part7: %s may not send back -- got %s', who, v));
  end loop;
  v := pg_temp.run_as('anon', null, pg_temp.approve_sql(rid, f, c, 199, pg_temp.checklist()));
  perform pg_temp.assert(v like '42501:%', format('part7: anon cannot execute -- got %s', v));
  v := pg_temp.run_as('service_role', null, pg_temp.approve_sql(rid, f, c, 199, pg_temp.checklist()));
  perform pg_temp.assert(v like '42501:%', format('part7: service_role cannot execute -- got %s', v));
  v := pg_temp.run_as('authenticated', null, pg_temp.approve_sql(rid, f, c, 199, pg_temp.checklist()));
  perform pg_temp.assert(v = 'P0001:not authenticated', format('part7: no session -- got %s', v));

  v := pg_temp.run_as('authenticated', ad, pg_temp.approve_sql('e0770009-0000-4000-8000-0000000000ff', f, c, 199, pg_temp.checklist()));
  perform pg_temp.assert(v = 'P0001:no review found for this id', format('part7: a missing review -- got %s', v));
  v := pg_temp.run_as('authenticated', ad, pg_temp.approve_sql(rid, f || 'x', c, 199, pg_temp.checklist()));
  perform pg_temp.assert(v = 'P0001:the author changed the file or cover', format('part7: the rendered file differs -- got %s', v));
  v := pg_temp.run_as('authenticated', ad, pg_temp.approve_sql(rid, f, null, 199, pg_temp.checklist()));
  perform pg_temp.assert(v = 'P0001:the author changed the file or cover', format('part7: the rendered cover differs -- got %s', v));
  v := pg_temp.run_as('authenticated', ad, pg_temp.approve_sql(rid, f, c, 0, pg_temp.checklist()));
  perform pg_temp.assert(v = 'P0001:the author changed the book', format('part7: the price staff checked differs (free -> paid race) -- got %s', v));
  v := pg_temp.run_as('authenticated', ad, pg_temp.approve_sql(rid, f, c, null, pg_temp.checklist()));
  perform pg_temp.assert(v = 'P0001:the author changed the book', format('part7: a null price -- got %s', v));
  v := pg_temp.run_as('authenticated', ad, pg_temp.approve_sql(rid, f, c, 199, '{"cover_is_fine": true, "file_opens": true, "not_someone_elses_work": true}'));
  perform pg_temp.assert(v = 'P0001:invalid checklist', format('part7: a missing checklist item -- got %s', v));
  v := pg_temp.run_as('authenticated', ad, pg_temp.approve_sql(rid, f, c, 199, '{"cover_is_fine": true, "file_opens": false, "not_someone_elses_work": true, "rights_declared": true}'));
  perform pg_temp.assert(v = 'P0001:invalid checklist', format('part7: an unticked checklist item -- got %s', v));
  v := pg_temp.run_as('authenticated', ad, pg_temp.approve_sql(rid, f, c, 199, null));
  perform pg_temp.assert(v = 'P0001:invalid checklist', format('part7: no checklist -- got %s', v));

  update public.books set description = '' where id = d;
  v := pg_temp.run_as('authenticated', ad, pg_temp.approve_sql(rid, f, c, 199, pg_temp.checklist()));
  perform pg_temp.assert(v = 'P0001:the author changed the book', format('part7: an empty description -- got %s', v));
  update public.books set description = 'About it.' where id = d;

  -- The author changed the price after staff read it: the row's price is
  -- what counts.
  update public.books set price_all = 299 where id = d;
  v := pg_temp.run_as('authenticated', ad, pg_temp.approve_sql(rid, f, c, 199, pg_temp.checklist()));
  perform pg_temp.assert(v = 'P0001:the author changed the book', format('part7: a price edited after the check -- got %s', v));
  update public.books set price_all = 199 where id = d;

  perform pg_temp.assert((select status from public.books where id = d) = 'draft'
    and (select status from public.book_reviews where id = rid) = 'pending'
    and not exists (select 1 from public.admin_audit_log where action like 'book.review%'),
    'part7: refusals changed nothing');
end $$;

-- ============================================================
-- Part 8: approve publishes (first publication), in one transaction.
-- ============================================================
do $$
declare
  d constant uuid := 'e0770001-0000-4000-8000-0000000000a2';
  rid uuid := pg_temp.pending_id('e0770001-0000-4000-8000-0000000000a2');
  f text := (select file_path from public.books where id = 'e0770001-0000-4000-8000-0000000000a2');
  c text := (select cover_path from public.books where id = 'e0770001-0000-4000-8000-0000000000a2');
  ad constant uuid := 'e0770000-0000-4000-8000-0000000000c2';
  v text;
  r record;
begin
  v := pg_temp.value_as('authenticated', ad::text, pg_temp.approve_sql(rid, f, c, 199, pg_temp.checklist()));
  perform pg_temp.assert(v = 'true', format('part8: the admin approves; first publication -- got %s', v));
  select * into r from public.books where id = d;
  perform pg_temp.assert(r.status = 'published' and r.published_at is not null and r.librum_choice_at is null,
    'part8: the book is live, published_at set, Librum''s choice cleared');
  select * into r from public.book_reviews where id = rid;
  perform pg_temp.assert(r.status = 'approved' and r.decided_by = ad and r.decided_at is not null
    and r.checklist = pg_temp.checklist()::jsonb and not r.grandfathered,
    'part8: the review is approved with who, when and the checklist');
  perform pg_temp.assert((select metadata from public.admin_audit_log
                           where action = 'book.review_approved' and target_type = 'books' and target_id = d and actor_id = ad)
      = '{"first_publication": true}'::jsonb,
    'part8: book.review_approved audit row');
  v := pg_temp.run_as('authenticated', ad::text, pg_temp.approve_sql(rid, f, c, 199, pg_temp.checklist()));
  perform pg_temp.assert(v = 'P0001:this review is no longer waiting', format('part8: approve twice -- got %s', v));
  v := pg_temp.run_as('authenticated', ad::text, format($q$select public.admin_send_back_book_review(%L, 'other', 'Probe')$q$, rid));
  perform pg_temp.assert(v = 'P0001:this review is no longer waiting', format('part8: send back after approve -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0770000-0000-4000-8000-00000000000a',
    format('select public.book_review_state(%L)::text', d));
  perform pg_temp.assert(v::jsonb = '{"pending": false, "approval_valid": true, "latest_sent_back": null}'::jsonb,
    format('part8: the author sees the approval -- got %s', v));
end $$;

-- ============================================================
-- Part 9: the live-files guard, and republish (3a, N4).
-- ============================================================
do $$
declare
  d constant text := 'e0770001-0000-4000-8000-0000000000a2';
  f2 constant text := 'e0770000-0000-4000-8000-00000000000a/e0770001-0000-4000-8000-0000000000a2/f0000000-0000-4000-8000-000000000002.epub';
  v text;
begin
  v := pg_temp.run_as('service_role', null, format('update public.books set file_path = %L where id = %L', f2, d));
  perform pg_temp.assert(v like 'LB463:%', format('part9: a live book''s file cannot change -- got %s', v));
  v := pg_temp.run_as('service_role', null, format($q$update public.books set cover_path = 'e077c0de-0000-4000-8000-0000000000b2/cover.png' where id = %L$q$, d));
  perform pg_temp.assert(v like 'LB463:%', format('part9: nor its cover -- got %s', v));
  v := pg_temp.run_as('service_role', null, format('update public.books set cover_path = null where id = %L', d));
  perform pg_temp.assert(v like 'LB463:%', format('part9: nor be cleared -- got %s', v));
  begin
    execute format('update public.books set file_path = %L where id = %L', f2, d);
    perform pg_temp.assert(false, 'part9: the table owner was not refused');
  exception when sqlstate 'LB463' then
    perform pg_temp.assert(true, 'part9: the table owner is refused too');
  end;
  v := pg_temp.run_as('service_role', null, format('update public.books set file_path = file_path, title = %L where id = %L', 'P077 Draft', d));
  perform pg_temp.assert(v = 'OK:1', format('part9: rewriting the same path and text edits are fine -- got %s', v));

  -- Unpublish, then republish with the same files: the approval holds (3a).
  v := pg_temp.run_as('service_role', null, format($q$update public.books set status = 'draft' where id = %L$q$, d));
  perform pg_temp.assert(v = 'OK:1', format('part9: unpublish -- got %s', v));
  v := pg_temp.run_as('service_role', null, format($q$update public.books set status = 'published' where id = %L$q$, d));
  perform pg_temp.assert(v = 'OK:1', format('part9: republish with the approved files goes straight live (3a) -- got %s', v));

  -- One write that publishes AND changes the file: the NEW paths count (N4).
  v := pg_temp.run_as('service_role', null, format($q$update public.books set status = 'draft' where id = %L$q$, d));
  v := pg_temp.run_as('service_role', null, format($q$update public.books set status = 'published', file_path = %L where id = %L$q$, f2, d));
  perform pg_temp.assert(v like 'LB462:%', format('part9: publish + new file in one write is refused (N4) -- got %s', v));
  v := pg_temp.run_as('service_role', null,
    format($q$update public.books set status = 'published', cover_path = 'e077c0de-0000-4000-8000-0000000000b2/cover.png' where id = %L$q$, d));
  perform pg_temp.assert(v like 'LB462:%', format('part9: publish + new cover in one write is refused (N4) -- got %s', v));

  -- On the live book: a new file with draft in the same write is the way.
  v := pg_temp.run_as('service_role', null, format($q$update public.books set status = 'published' where id = %L$q$, d));
  perform pg_temp.assert(v = 'OK:1', format('part9: live again -- got %s', v));
  v := pg_temp.run_as('service_role', null,
    format($q$update public.books set status = 'draft', librum_choice_at = null, file_path = %L where id = %L$q$, f2, d));
  perform pg_temp.assert(v = 'OK:1', format('part9: new file + draft in one write works (2b) -- got %s', v));
  v := pg_temp.run_as('service_role', null, format($q$update public.books set status = 'published' where id = %L$q$, d));
  perform pg_temp.assert(v like 'LB462:%', format('part9: and it cannot go live again without a new approval -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0770000-0000-4000-8000-00000000000a',
    format('select public.book_review_state(%L)::text', d));
  perform pg_temp.assert(v::jsonb = '{"pending": false, "approval_valid": false, "latest_sent_back": null}'::jsonb,
    format('part9: the author sees no valid approval -- got %s', v));
end $$;

-- ============================================================
-- Part 10: send back; latest_sent_back only while newest (P4).
-- ============================================================
do $$
declare
  a constant text := 'e0770000-0000-4000-8000-00000000000a';
  d constant uuid := 'e0770001-0000-4000-8000-0000000000a2';
  ad constant uuid := 'e0770000-0000-4000-8000-0000000000c2';
  rid uuid;
  v text;
  r record;
begin
  perform pg_temp.age_reviews(d);
  v := pg_temp.run_as('authenticated', a, format('select public.request_book_review(%L)', d));
  perform pg_temp.assert(v = 'OK:1', format('part10: the author sends the new file -- got %s', v));
  rid := pg_temp.pending_id(d);
  v := pg_temp.run_as('authenticated', ad::text, format($q$select public.admin_send_back_book_review(%L, 'spam', 'Probe')$q$, rid));
  perform pg_temp.assert(v = 'P0001:invalid reason', format('part10: an unknown reason -- got %s', v));
  v := pg_temp.run_as('authenticated', ad::text, format($q$select public.admin_send_back_book_review(%L, 'author_asked', 'Probe')$q$, rid));
  perform pg_temp.assert(v = 'P0001:invalid reason', format('part10: "Author asked" is not a send-back reason -- got %s', v));
  v := pg_temp.run_as('authenticated', ad::text, format($q$select public.admin_send_back_book_review(%L, 'other', E'  \n ')$q$, rid));
  perform pg_temp.assert(v = 'P0001:invalid message', format('part10: a blank message -- got %s', v));
  v := pg_temp.run_as('authenticated', ad::text, format($q$select public.admin_send_back_book_review(%L, 'other', %L)$q$, rid, repeat('x', 2001)));
  perform pg_temp.assert(v = 'P0001:invalid message', format('part10: 2001 characters -- got %s', v));
  v := pg_temp.run_as('authenticated', ad::text, format($q$select public.admin_send_back_book_review(%L, 'broken_file', %L)$q$,
    rid, E'  The book file doesn''t open.\nPlease upload it again.  '));
  perform pg_temp.assert(v = 'OK:1', format('part10: the admin sends it back -- got %s', v));
  select * into r from public.book_reviews where id = rid;
  perform pg_temp.assert(r.status = 'sent_back' and r.reason = 'broken_file'
    and r.message_to_author = E'The book file doesn''t open.\nPlease upload it again.'
    and r.decided_by = ad and r.decided_at is not null,
    'part10: the row (message trimmed)');
  perform pg_temp.assert((select status from public.books where id = d) = 'draft', 'part10: the book stays a draft');
  perform pg_temp.assert((select metadata from public.admin_audit_log where action = 'book.review_sent_back' and target_id = d)
      = '{"reason": "broken_file"}'::jsonb
    and not exists (select 1 from public.admin_audit_log where metadata::text ilike '%doesn''t open%'),
    'part10: book.review_sent_back audit row carries the reason, never the message');
  v := pg_temp.value_as('authenticated', a, format('select public.book_review_state(%L)::text', d));
  perform pg_temp.assert((v::jsonb) - 'latest_sent_back' = '{"pending": false, "approval_valid": false}'::jsonb
    and (v::jsonb -> 'latest_sent_back' ->> 'reason') = 'broken_file'
    and (v::jsonb -> 'latest_sent_back' ->> 'message') = E'The book file doesn''t open.\nPlease upload it again.'
    and (v::jsonb -> 'latest_sent_back' ->> 'decided_at') is not null,
    format('part10: the author sees the send back -- got %s', v));
  v := pg_temp.value_as('authenticated', a,
    format($q$select reason || ':' || message_to_author from public.book_reviews where book_id = %L and status = 'sent_back'$q$, d));
  perform pg_temp.assert(v = E'broken_file:The book file doesn''t open.\nPlease upload it again.',
    format('part10: and reads it through the granted columns -- got %s', v));

  -- Sending it again: the newest row is pending, so no send back is shown.
  v := pg_temp.run_as('authenticated', a, format('select public.request_book_review(%L)', d));
  perform pg_temp.assert(v = 'OK:1', format('part10: the author sends it again -- got %s', v));
  v := pg_temp.value_as('authenticated', a, format('select public.book_review_state(%L)::text', d));
  perform pg_temp.assert(v::jsonb = '{"pending": true, "approval_valid": false, "latest_sent_back": null}'::jsonb,
    format('part10: an older send back is not returned (P4) -- got %s', v));
end $$;

-- ============================================================
-- Part 11: withdraw.
-- ============================================================
do $$
declare
  a constant text := 'e0770000-0000-4000-8000-00000000000a';
  d constant uuid := 'e0770001-0000-4000-8000-0000000000a2';
  rid uuid := pg_temp.pending_id('e0770001-0000-4000-8000-0000000000a2');
  v text;
begin
  perform pg_temp.age_reviews(d);
  v := pg_temp.run_as('authenticated', 'e0770000-0000-4000-8000-00000000000b', format('select public.withdraw_book_review(%L)', d));
  perform pg_temp.assert(v = 'P0001:no book found for this id', format('part11: another author -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0770000-0000-4000-8000-0000000000c2', format('select public.withdraw_book_review(%L)', d));
  perform pg_temp.assert(v = 'P0001:no book found for this id', format('part11: staff cannot withdraw -- got %s', v));
  v := pg_temp.run_as('anon', null, format('select public.withdraw_book_review(%L)', d));
  perform pg_temp.assert(v like '42501:%', format('part11: anon -- got %s', v));
  v := pg_temp.run_as('authenticated', a, format('select public.withdraw_book_review(%L)', d));
  perform pg_temp.assert(v = 'OK:1', format('part11: the author withdraws -- got %s', v));
  perform pg_temp.assert((select status = 'withdrawn' and decided_at is not null and decided_by = a::uuid
                            from public.book_reviews where id = rid), 'part11: the row is withdrawn');
  v := pg_temp.run_as('authenticated', a, format('select public.withdraw_book_review(%L)', d));
  perform pg_temp.assert(v = 'P0001:this book is not waiting for review', format('part11: nothing pending -- got %s', v));
  v := pg_temp.value_as('authenticated', a, format('select public.book_review_state(%L)::text', d));
  perform pg_temp.assert(v::jsonb = '{"pending": false, "approval_valid": false, "latest_sent_back": null}'::jsonb,
    format('part11: state after withdraw -- got %s', v));
  -- An approved, still-valid book cannot be sent again.
  v := pg_temp.run_as('authenticated', a, $q$select public.request_book_review('e0770001-0000-4000-8000-0000000000a1')$q$);
  perform pg_temp.assert(v = 'P0001:this book is already published', format('part11: live book -- got %s', v));
end $$;

-- ============================================================
-- Part 12: a stale pending review is replaced, never rewritten (P1).
-- ============================================================
do $$
declare
  a constant text := 'e0770000-0000-4000-8000-00000000000a';
  d constant uuid := 'e0770001-0000-4000-8000-0000000000a2';
  f3 constant text := 'e0770000-0000-4000-8000-00000000000a/e0770001-0000-4000-8000-0000000000a2/f0000000-0000-4000-8000-000000000003.epub';
  old_id uuid;
  v text;
begin
  v := pg_temp.run_as('authenticated', a, format('select public.request_book_review(%L)', d));
  old_id := pg_temp.pending_id(d);
  v := pg_temp.run_as('service_role', null, format('update public.books set file_path = %L where id = %L', f3, d));
  perform pg_temp.assert(v = 'OK:1', format('part12: a draft''s file may change while pending -- got %s', v));
  v := pg_temp.run_as('authenticated', a, format('select public.request_book_review(%L)', d));
  perform pg_temp.assert(v = 'OK:1', format('part12: the request with the new file is accepted -- got %s', v));
  perform pg_temp.assert((select status = 'cancelled' and decided_at is not null and file_path <> f3
                            from public.book_reviews where id = old_id),
    'part12: the stale pending row is cancelled and keeps its snapshot');
  perform pg_temp.assert((select file_path from public.book_reviews where book_id = d and status = 'pending') = f3
    and (select count(*) from public.book_reviews where book_id = d and status = 'pending') = 1,
    'part12: exactly one pending row, with the new file');
end $$;

-- ============================================================
-- Part 13: takedowns. A takedown cancels a pending review; nothing can
-- be sent or approved while taken down; an approval older than the
-- latest takedown no longer counts (9a); LB460 fires before LB462.
-- ============================================================
do $$
declare
  a constant text := 'e0770000-0000-4000-8000-00000000000a';
  d constant uuid := 'e0770001-0000-4000-8000-0000000000a2';
  live constant uuid := 'e0770001-0000-4000-8000-0000000000a1';
  m constant text := 'e0770000-0000-4000-8000-0000000000c3';
  ad constant text := 'e0770000-0000-4000-8000-0000000000c2';
  rid uuid := pg_temp.pending_id('e0770001-0000-4000-8000-0000000000a2');
  fake uuid;
  v text;
begin
  v := pg_temp.run_as('authenticated', m, format($q$select public.admin_unpublish_book(%L, 'broken_file', 'Probe.')$q$, d));
  perform pg_temp.assert(v = 'OK:1', format('part13: the moderator takes the pending draft down -- got %s', v));
  perform pg_temp.assert((select status = 'cancelled' and decided_at is not null from public.book_reviews where id = rid),
    'part13: the takedown cancelled the pending review');
  v := pg_temp.run_as('authenticated', a, format('select public.request_book_review(%L)', d));
  perform pg_temp.assert(v like 'LB460:%', format('part13: no request while taken down -- got %s', v));

  -- A pending row that somehow exists under a takedown cannot be approved.
  insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, status)
  select id, title, author_id, file_path, cover_path, 'pending' from public.books where id = d
  returning id into fake;
  v := pg_temp.run_as('authenticated', ad, pg_temp.approve_sql(fake,
    (select file_path from public.books where id = d), (select cover_path from public.books where id = d), 199, pg_temp.checklist()));
  perform pg_temp.assert(v = 'P0001:this book is taken down', format('part13: no approval while taken down -- got %s', v));
  delete from public.book_reviews where id = fake;

  -- 9a: the live (grandfathered) book is taken down and allowed again; its
  -- old approval no longer counts.
  v := pg_temp.run_as('authenticated', m, format($q$select public.admin_unpublish_book(%L, 'other', 'Probe.')$q$, live));
  perform pg_temp.assert(v = 'OK:1', format('part13: the live book is taken down -- got %s', v));
  v := pg_temp.run_as('service_role', null, format($q$update public.books set status = 'published' where id = %L$q$, live));
  perform pg_temp.assert(v like 'LB460:%', format('part13: LB460 still fires first -- got %s', v));
  update public.book_takedowns set taken_down_at = now() - interval '1 hour' where book_id in (d, live);
  update public.book_reviews set decided_at = now() - interval '2 hours', submitted_at = now() - interval '3 hours'
   where book_id = live and grandfathered;
  v := pg_temp.run_as('authenticated', m, format('select public.admin_allow_book_again(%L)', live));
  v := pg_temp.run_as('service_role', null, format($q$update public.books set status = 'published' where id = %L$q$, live));
  perform pg_temp.assert(v like 'LB462:%', format('part13: after "allow again" the old approval does not count (9a) -- got %s', v));
  v := pg_temp.value_as('authenticated', a, format('select public.book_review_state(%L)::text', live));
  perform pg_temp.assert(v::jsonb = '{"pending": false, "approval_valid": false, "latest_sent_back": null}'::jsonb,
    format('part13: and the author sees it needs review -- got %s', v));
  v := pg_temp.run_as('authenticated', a, format('select public.request_book_review(%L)', live));
  perform pg_temp.assert(v = 'OK:1', format('part13: so the next publish goes into review -- got %s', v));
  v := pg_temp.value_as('authenticated', ad, pg_temp.approve_sql(pg_temp.pending_id(live),
    (select file_path from public.books where id = live), (select cover_path from public.books where id = live), 499, pg_temp.checklist()));
  perform pg_temp.assert(v = 'false', format('part13: approved after the takedown: live again, not a first publication -- got %s', v));
  perform pg_temp.assert((select status from public.books where id = live) = 'published', 'part13: live');
end $$;

-- ============================================================
-- Part 14: deleting a book cancels its pending review -- directly and
-- through the account cascade (M3).
-- ============================================================
do $$
declare
  a constant text := 'e0770000-0000-4000-8000-00000000000a';
  x constant uuid := 'e0770001-0000-4000-8000-0000000000a4';
  q constant uuid := 'e0770001-0000-4000-8000-0000000000b1';
  rid uuid;
  v text;
begin
  v := pg_temp.run_as('authenticated', a, format('select public.request_book_review(%L)', x));
  rid := pg_temp.pending_id(x);
  v := pg_temp.run_as('authenticated', a, format('delete from public.books where id = %L', x));
  perform pg_temp.assert(v = 'OK:1', format('part14: the author deletes the pending draft -- got %s', v));
  perform pg_temp.assert((select status = 'cancelled' and decided_at is not null and book_id is null and book_title = 'P077 Gone'
                            from public.book_reviews where id = rid),
    'part14: the review is cancelled and kept (book_id null, title kept)');

  v := pg_temp.run_as('authenticated', 'e0770000-0000-4000-8000-00000000000b', format('select public.request_book_review(%L)', q));
  rid := pg_temp.pending_id(q);
  delete from auth.users where id = 'e0770000-0000-4000-8000-00000000000b';
  perform pg_temp.assert((select status = 'cancelled' and decided_at is not null and book_id is null and author_id is null
                            from public.book_reviews where id = rid),
    'part14: the account cascade cancels it too');
  perform pg_temp.assert(not exists (select 1 from public.book_reviews where status = 'pending' and book_id is null),
    'part14: no pending review without a book');
end $$;

-- ============================================================
-- Part 15: manuscripts storage (M1).
-- ============================================================
do $$
declare
  a constant text := 'e0770000-0000-4000-8000-00000000000a';
  b constant text := 'e0770000-0000-4000-8000-0000000000aa';
  final_key constant text := 'e0770000-0000-4000-8000-00000000000a/e0770001-0000-4000-8000-0000000000a1.epub';
  versioned_key constant text := 'e0770000-0000-4000-8000-00000000000a/e0770001-0000-4000-8000-0000000000a1/f0000000-0000-4000-8000-00000000000f.epub';
  kind text;
  v text;
begin
  -- Objects the server wrote.
  insert into storage.objects (bucket_id, name) values ('manuscripts', final_key), ('manuscripts', versioned_key),
    ('manuscripts', b || '/tmp/epub/11111111-1111-4111-8111-111111111111.epub');

  foreach kind in array array['epub/22222222-2222-4222-8222-222222222222.epub', 'docx/22222222-2222-4222-8222-222222222222.docx',
                              'cover/22222222-2222-4222-8222-222222222222.png', 'avatar/22222222-2222-4222-8222-222222222222.jpg',
                              'blog/22222222-2222-4222-8222-222222222222.png'] loop
    v := pg_temp.run_as('authenticated', a,
      format($q$insert into storage.objects (bucket_id, name) values ('manuscripts', %L)$q$, a || '/tmp/' || kind));
    perform pg_temp.assert(v = 'OK:1', format('part15: own tmp/%s upload works -- got %s', kind, v));
  end loop;
  v := pg_temp.run_as('authenticated', a,
    format($q$update storage.objects set owner_id = 'x' where bucket_id = 'manuscripts' and name = %L$q$,
           a || '/tmp/epub/22222222-2222-4222-8222-222222222222.epub'));
  perform pg_temp.assert(v = 'OK:1', format('part15: an upsert (UPDATE) of an own tmp object works -- got %s', v));
  v := pg_temp.run_as('authenticated', a,
    format($q$update storage.objects set name = %L where bucket_id = 'manuscripts' and name = %L$q$,
           a || '/e0770001-0000-4000-8000-0000000000a1.epub', a || '/tmp/epub/22222222-2222-4222-8222-222222222222.epub'));
  perform pg_temp.assert(v like '42501:%', format('part15: renaming a tmp object onto a final key is refused -- got %s', v));
  v := pg_temp.run_as('authenticated', a,
    format($q$delete from storage.objects where bucket_id = 'manuscripts' and name = %L$q$,
           a || '/tmp/docx/22222222-2222-4222-8222-222222222222.docx'));
  perform pg_temp.assert(v = 'OK:1', format('part15: deleting an own tmp object works -- got %s', v));

  v := pg_temp.run_as('authenticated', a,
    format($q$insert into storage.objects (bucket_id, name) values ('manuscripts', %L)$q$, a || '/e0770001-0000-4000-8000-0000000000a2.epub'));
  perform pg_temp.assert(v like '42501:%', format('part15: a final canonical key cannot be inserted -- got %s', v));
  v := pg_temp.run_as('authenticated', a,
    format($q$insert into storage.objects (bucket_id, name) values ('manuscripts', %L)$q$, a || '/e0770001-0000-4000-8000-0000000000a2/33333333-3333-4333-8333-333333333333.epub'));
  perform pg_temp.assert(v like '42501:%', format('part15: a final versioned key cannot be inserted -- got %s', v));
  v := pg_temp.run_as('authenticated', a,
    format($q$update storage.objects set owner_id = 'x' where bucket_id = 'manuscripts' and name in (%L, %L)$q$, final_key, versioned_key));
  perform pg_temp.assert(v = 'OK:0', format('part15: a final key cannot be overwritten -- got %s', v));
  v := pg_temp.run_as('authenticated', a,
    format($q$delete from storage.objects where bucket_id = 'manuscripts' and name in (%L, %L)$q$, final_key, versioned_key));
  perform pg_temp.assert(v = 'OK:0', format('part15: a final key cannot be deleted -- got %s', v));
  perform pg_temp.assert((select count(*) from storage.objects where name in (final_key, versioned_key) and owner_id is null) = 2,
    'part15: both final objects are untouched');
  v := pg_temp.value_as('authenticated', a,
    format($q$select count(*)::text from storage.objects where bucket_id = 'manuscripts' and name in (%L, %L)$q$, final_key, versioned_key));
  perform pg_temp.assert(v = '2', format('part15: the author still reads their own objects -- got %s', v));

  v := pg_temp.run_as('authenticated', a,
    format($q$insert into storage.objects (bucket_id, name) values ('manuscripts', %L)$q$, b || '/tmp/epub/44444444-4444-4444-8444-444444444444.epub'));
  perform pg_temp.assert(v like '42501:%', format('part15: another user''s tmp cannot be written -- got %s', v));
  v := pg_temp.run_as('authenticated', a,
    format($q$delete from storage.objects where bucket_id = 'manuscripts' and name = %L$q$, b || '/tmp/epub/11111111-1111-4111-8111-111111111111.epub'));
  perform pg_temp.assert(v = 'OK:0', format('part15: another user''s tmp cannot be deleted -- got %s', v));
  v := pg_temp.run_as('anon', null,
    format($q$insert into storage.objects (bucket_id, name) values ('manuscripts', %L)$q$, a || '/tmp/epub/55555555-5555-4555-8555-555555555555.epub'));
  perform pg_temp.assert(v like '42501:%', format('part15: anon cannot write -- got %s', v));
  perform pg_temp.assert((select string_agg(policyname, ',' order by policyname) from pg_catalog.pg_policies
                           where schemaname = 'storage' and (coalesce(qual, '') || coalesce(with_check, '')) ~ '''manuscripts''')
      = 'Authors can delete their own manuscripts,Authors can read their own manuscripts,Authors can replace their own manuscripts,Authors can upload their own manuscripts',
    'part15: the same four policy names');
end $$;

-- ============================================================
-- Part 16: the audit list knows the new events.
-- ============================================================
do $$
declare
  v text;
begin
  v := pg_temp.value_as('authenticated', 'e0770000-0000-4000-8000-0000000000c1',
    $q$select count(*)::text from public.list_admin_audit_events(p_action => 'book.review_approved')$q$);
  perform pg_temp.assert(v = '2', format('part16: filter by book.review_approved -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0770000-0000-4000-8000-0000000000c1',
    $q$select count(*)::text from public.list_admin_audit_events(p_action => 'book.review_sent_back')$q$);
  perform pg_temp.assert(v = '1', format('part16: filter by book.review_sent_back -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0770000-0000-4000-8000-0000000000c1',
    $q$select count(*)::text from public.list_admin_audit_events(p_action => 'book.allowed_again')$q$);
  perform pg_temp.assert(v = '1', format('part16: ADMIN-2''s filters still accepted -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0770000-0000-4000-8000-0000000000c1',
    $q$select count(*)::text from public.list_admin_audit_events(p_action => 'book.review_withdrawn')$q$);
  perform pg_temp.assert(v = 'P0001:invalid action filter', format('part16: an unknown action is still refused -- got %s', v));
end $$;

-- ============================================================
-- Part 17: A1 = a (Q1/R1/U2): a buyer_file_only row, as the migration's
-- backfill writes it for a draft readers may already hold, is never a
-- publishable approval. Inserted directly (only the backfill writes
-- buyer_file_only = true; no function does).
-- ============================================================
insert into public.books (id, author_id, title, description, status, price_all, published_at, file_path, cover_path) values
  ('e0770001-0000-4000-8000-0000000000a7', 'e0770000-0000-4000-8000-00000000000a', 'P077 Held', 'About it.', 'draft', 299, now() - interval '30 days',
   'e0770000-0000-4000-8000-00000000000a/e0770001-0000-4000-8000-0000000000a7.epub', 'e077c0de-0000-4000-8000-0000000000a7/cover.jpg');
insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, status, grandfathered, decided_at, buyer_file_only)
select id, title, author_id, file_path, cover_path, 'approved', true, now(), true
  from public.books where id = 'e0770001-0000-4000-8000-0000000000a7';

do $$
declare
  a constant text := 'e0770000-0000-4000-8000-00000000000a';
  h constant uuid := 'e0770001-0000-4000-8000-0000000000a7';
  v text;
begin
  perform pg_temp.assert(
    exists (select 1 from pg_constraint where conrelid = 'public.book_reviews'::regclass
             and conname = 'book_reviews_buyer_file_only_check'),
    'part17: the constraint is named book_reviews_buyer_file_only_check');
  perform pg_temp.assert(not has_column_privilege('authenticated', 'public.book_reviews', 'buyer_file_only', 'SELECT'),
    'part17: authenticated cannot read buyer_file_only (not in the column grant)');
  begin
    insert into public.book_reviews (book_id, book_title, author_id, file_path, status, grandfathered, decided_at, checklist, buyer_file_only)
    values (h, 'x', a::uuid, 'x', 'approved', false, now(), pg_temp.checklist()::jsonb, true);
    perform pg_temp.assert(false, 'part17: buyer_file_only without grandfathered was accepted');
  exception when check_violation then
    perform pg_temp.assert(sqlerrm like '%book_reviews_buyer_file_only_check%',
      format('part17: buyer_file_only needs grandfathered -- got %s', sqlerrm));
  end;
  perform pg_temp.assert(not public.book_review_approval_valid(h,
      (select file_path from public.books where id = h), (select cover_path from public.books where id = h)),
    'part17: the validity function ignores a buyer_file_only row with matching paths');
  v := pg_temp.run_as('service_role', null,
    $q$update public.books set status = 'published' where id = 'e0770001-0000-4000-8000-0000000000a7'$q$);
  perform pg_temp.assert(v like 'LB462:%', format('part17: publishing a buyer_file_only draft is refused -- got %s', v));
  v := pg_temp.value_as('authenticated', a,
    $q$select public.book_review_state('e0770001-0000-4000-8000-0000000000a7')::text$q$);
  perform pg_temp.assert(v::jsonb = '{"pending": false, "approval_valid": false, "latest_sent_back": null}'::jsonb,
    format('part17: book_review_state.approval_valid is false -- got %s', v));
  v := pg_temp.run_as('authenticated', a, $q$select public.request_book_review('e0770001-0000-4000-8000-0000000000a7')$q$);
  perform pg_temp.assert(v = 'OK:1', format('part17: request_book_review is allowed -- got %s', v));
  perform pg_temp.assert(
    (select count(*) from public.book_reviews where book_id = h and status = 'pending') = 1
    and (select count(*) from public.book_reviews where book_id = h and status = 'approved' and buyer_file_only) = 1,
    'part17: the review is pending and the readers'' copy row is kept');
end $$;

do $$
begin
  perform pg_temp.assert((select n from pg_temp.assertions_run) >= 130,
    format('expected at least 130 assertions, ran %s', (select n from pg_temp.assertions_run)));
end $$;

select 'ALL PASSED: 077_book_reviews.test.sql (' || (select n from pg_temp.assertions_run) || ' assertions)' as result;

rollback;
