-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for DEL (migration
-- 20261118170000_account_deletion_grace.sql): account deletion with 30
-- days to change your mind.
--
-- * account_deletion_requests and account_deletion_feedback: RLS on, no
--   policy, service_role SELECT only; the feedback table has no account
--   column; EXECUTE on the new functions for exactly the intended role;
-- * request_account_deletion: the refusals (staff LB519, already pending
--   LB520, suspended LB521, a book ever acquired LB522, bad feedback
--   LB523); drafts exactly the live books, bundles and pre-orders (a
--   pause), clears the Librum's choice pick, records them, saves the
--   feedback without the account, signs out every session, 30 days;
-- * a pending account is hidden: public_pen_names, public_series;
--   its reviews stay in public_reviews (20261118190000); nothing of it
--   can be published again (LB518);
-- * my_account_status() and my_account_deletion_date() for the caller;
-- * restore_my_account brings back exactly what went offline;
-- * account_deletion_claim: only a due row, service role only; Restore
--   is 'too_late' after it;
-- * deleting a profile keeps its APPROVED reviews (reader_id null, the
--   review name kept, no verified badge) and deletes the others; the
--   pending row goes with the account.
--
-- Reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance (on 16 strip ", maintain" from a copy of schema.sql):
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/105_account_deletion_grace.test.sql
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
  if p_role is not null then
    execute format('set local role %I', p_role);
  end if;
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
-- Part 0: fixtures.
--   A  author, nothing ever acquired: a1 live + Librum's choice + in
--      series s1 under pen name pa, a2 draft, a3 a live pre-order;
--      bundle bu1 (a1) live
--   B  author: b1 live, bought by R2 (so B can't delete)
--   R  reader: one approved and one pending review on b1, review name
--   R2 reader: bought b1 (paid), one approved review on b1
--   SU reader, suspended
--   O  staff owner
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e1050000-0000-4000-8000-00000000000a', 'p105-a@test', now(), '{"role":"author","display_name":"P105 Ana"}'),
  ('e1050000-0000-4000-8000-00000000000b', 'p105-b@test', now(), '{"role":"author","display_name":"P105 Ben"}'),
  ('e1050000-0000-4000-8000-0000000000aa', 'p105-r@test', now(), '{"role":"reader","display_name":"P105 Reader"}'),
  ('e1050000-0000-4000-8000-0000000000ab', 'p105-r2@test', now(), '{"role":"reader","display_name":"P105 Reader Two"}'),
  ('e1050000-0000-4000-8000-0000000000ac', 'p105-su@test', now(), '{"role":"reader","display_name":"P105 Suspended"}'),
  ('e1050000-0000-4000-8000-0000000000c1', 'p105-o@test', now(), '{"role":"reader","display_name":"P105 Owner"}');

insert into public.staff_members (user_id, role) values
  ('e1050000-0000-4000-8000-0000000000c1', 'owner');

update public.profiles set review_name = 'Lexuesi R' where id = 'e1050000-0000-4000-8000-0000000000aa';
update public.profiles set review_name = 'Lexuesi Dy' where id = 'e1050000-0000-4000-8000-0000000000ab';

insert into public.pen_names (id, author_id, name) values
  ('e105be00-0000-4000-8000-0000000000a1', 'e1050000-0000-4000-8000-00000000000a', 'P105 Pena');

insert into public.series (id, author_id, title, pen_name_id) values
  ('e1050003-0000-4000-8000-0000000000a1', 'e1050000-0000-4000-8000-00000000000a', 'P105 Series',
   'e105be00-0000-4000-8000-0000000000a1');

insert into public.books (id, author_id, title, description, status, price_all, published_at, file_path, cover_path,
                          pen_name_id, series_id, series_position) values
  ('e1050001-0000-4000-8000-0000000000a1', 'e1050000-0000-4000-8000-00000000000a', 'P105 One', 'About it.', 'published', 499, now(),
   'e1050000-0000-4000-8000-00000000000a/e1050001-0000-4000-8000-0000000000a1.epub', 'e105c0de-0000-4000-8000-0000000000a1/cover.jpg',
   'e105be00-0000-4000-8000-0000000000a1', 'e1050003-0000-4000-8000-0000000000a1', 1),
  ('e1050001-0000-4000-8000-0000000000a2', 'e1050000-0000-4000-8000-00000000000a', 'P105 Two', 'About it.', 'draft', 0, null, null, null,
   'e105be00-0000-4000-8000-0000000000a1', null, null),
  ('e1050001-0000-4000-8000-0000000000b1', 'e1050000-0000-4000-8000-00000000000b', 'P105 Ben Live', 'About it.', 'published', 499, now(),
   'e1050000-0000-4000-8000-00000000000b/e1050001-0000-4000-8000-0000000000b1.epub', 'e105c0de-0000-4000-8000-0000000000b1/cover.jpg',
   null, null, null);

insert into public.books (id, author_id, title, description, status, price_all, file_path, cover_path,
                          pen_name_id, release_date, preorder_listed_at, preorder_count) values
  ('e1050001-0000-4000-8000-0000000000a3', 'e1050000-0000-4000-8000-00000000000a', 'P105 Soon', 'About it.', 'preorder', 499,
   'e1050000-0000-4000-8000-00000000000a/e1050001-0000-4000-8000-0000000000a3.epub', 'e105c0de-0000-4000-8000-0000000000a3/cover.jpg',
   'e105be00-0000-4000-8000-0000000000a1', current_date + 40, now(), 1);

update public.books set librum_choice_at = now() where id = 'e1050001-0000-4000-8000-0000000000a1';

-- The approvals live books carry (ADMIN-3-REVIEW's backfill).
insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, status, grandfathered, decided_at)
select id, title, author_id, file_path, cover_path, 'approved', true, now()
  from public.books where status in ('published', 'preorder');

insert into public.bundles (id, author_id, title, status, pen_name_id) values
  ('e1050002-0000-4000-8000-0000000000a1', 'e1050000-0000-4000-8000-00000000000a', 'P105 Bundle', 'published',
   'e105be00-0000-4000-8000-0000000000a1');
insert into public.bundle_books (bundle_id, book_id) values
  ('e1050002-0000-4000-8000-0000000000a1', 'e1050001-0000-4000-8000-0000000000a1');

insert into public.purchases (book_id, reader_id, amount_cents) values
  ('e1050001-0000-4000-8000-0000000000b1', 'e1050000-0000-4000-8000-0000000000ab', 499);

insert into public.reviews (book_id, reader_id, rating, body, status) values
  ('e1050001-0000-4000-8000-0000000000b1', 'e1050000-0000-4000-8000-0000000000ab', 5, 'P105 kept review', 'approved');

-- R's review of A's book, and of B's book (pending).
insert into public.reviews (book_id, reader_id, rating, body, status) values
  ('e1050001-0000-4000-8000-0000000000a1', 'e1050000-0000-4000-8000-0000000000aa', 4, 'P105 R on a1', 'approved'),
  ('e1050001-0000-4000-8000-0000000000b1', 'e1050000-0000-4000-8000-0000000000aa', 3, 'P105 R pending', 'pending');

insert into public.account_suspensions (user_id, reason) values
  ('e1050000-0000-4000-8000-0000000000ac', 'P105 test');

insert into auth.sessions (id, user_id) values
  ('e1050005-0000-4000-8000-0000000000a1', 'e1050000-0000-4000-8000-00000000000a'),
  ('e1050005-0000-4000-8000-0000000000b1', 'e1050000-0000-4000-8000-00000000000b');

-- ============================================================
-- Part 1: privileges.
-- ============================================================
do $$
declare
  t text;
begin
  foreach t in array array['account_deletion_requests', 'account_deletion_feedback'] loop
    perform pg_temp.assert((select relrowsecurity from pg_class where oid = ('public.' || t)::regclass),
      'part1: RLS is on for ' || t);
    perform pg_temp.assert(not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t),
      'part1: no policy on ' || t);
    perform pg_temp.assert(not has_table_privilege('anon', 'public.' || t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      'part1: anon holds nothing on ' || t);
    perform pg_temp.assert(not has_table_privilege('authenticated', 'public.' || t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      'part1: authenticated holds nothing on ' || t);
    perform pg_temp.assert(has_table_privilege('service_role', 'public.' || t, 'SELECT')
      and not has_table_privilege('service_role', 'public.' || t, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      'part1: service_role holds SELECT only on ' || t);
  end loop;

  perform pg_temp.assert(not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'account_deletion_feedback'
         and column_name not in ('id', 'reason', 'note', 'created_on')),
    'part1: the feedback table holds no account column');

  perform pg_temp.assert(has_function_privilege('authenticated', 'public.request_account_deletion(text, text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.request_account_deletion(text, text)', 'EXECUTE')
    and not has_function_privilege('service_role', 'public.request_account_deletion(text, text)', 'EXECUTE'),
    'part1: request_account_deletion for authenticated only');
  perform pg_temp.assert(has_function_privilege('authenticated', 'public.restore_my_account()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.restore_my_account()', 'EXECUTE'),
    'part1: restore_my_account for authenticated only');
  perform pg_temp.assert(has_function_privilege('authenticated', 'public.my_account_status()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.my_account_status()', 'EXECUTE'),
    'part1: my_account_status for authenticated only');
  perform pg_temp.assert(has_function_privilege('authenticated', 'public.my_account_deletion_date()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.my_account_deletion_date()', 'EXECUTE'),
    'part1: my_account_deletion_date for authenticated only');
  perform pg_temp.assert(has_function_privilege('service_role', 'public.account_deletion_claim(uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.account_deletion_claim(uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.account_deletion_claim(uuid)', 'EXECUTE'),
    'part1: account_deletion_claim for service_role only');
  perform pg_temp.assert(not has_function_privilege('authenticated', 'public.profiles_keep_approved_reviews()', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.books_refuse_publish_while_deletion_pending()', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.bundles_refuse_publish_while_deletion_pending()', 'EXECUTE'),
    'part1: trigger functions for nobody');
end $$;

-- ============================================================
-- Part 2: the refusals.
-- ============================================================
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1050000-0000-4000-8000-0000000000c1',
  $q$select public.request_account_deletion(null, null)$q$) like 'LB519:%', 'part2: staff refused');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1050000-0000-4000-8000-0000000000ac',
  $q$select public.request_account_deletion(null, null)$q$) like 'LB521:%', 'part2: suspended refused');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1050000-0000-4000-8000-00000000000b',
  $q$select public.request_account_deletion(null, null)$q$) like 'LB522:%', 'part2: an author with an acquired book refused');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1050000-0000-4000-8000-0000000000aa',
  $q$select public.request_account_deletion('bored', null)$q$) like 'LB523:%', 'part2: unknown reason refused');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1050000-0000-4000-8000-0000000000aa',
  format('select public.request_account_deletion(null, %L)', repeat('x', 501))) like 'LB523:%', 'part2: a note over 500 refused');
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select public.request_account_deletion(null, null)$q$) like '42501:%', 'part2: anon cannot call it');
select pg_temp.assert(not exists (select 1 from public.account_deletion_requests), 'part2: nothing pending after the refusals');
select pg_temp.assert(not exists (select 1 from public.account_deletion_feedback), 'part2: no feedback saved by a refusal');
select pg_temp.assert((select status from public.books where id = 'e1050001-0000-4000-8000-0000000000b1') = 'published',
  'part2: B''s book untouched');

-- ============================================================
-- Part 3: A asks to delete.
-- ============================================================
select pg_temp.assert(
  pg_temp.value_as('authenticated', 'e1050000-0000-4000-8000-00000000000a', $q$select public.my_account_status()$q$) = 'active',
  'part3: active before');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1050000-0000-4000-8000-00000000000a',
  $q$select public.request_account_deletion('no_books', '  Nuk gjeta  ')$q$) = 'OK:1', 'part3: A asks to delete');

select pg_temp.assert((select delete_after between now() + interval '30 days' - interval '1 minute' and now() + interval '30 days' + interval '1 minute'
                         from public.account_deletion_requests where user_id = 'e1050000-0000-4000-8000-00000000000a'),
  'part3: deleted in 30 days');
select pg_temp.assert((select book_ids = array['e1050001-0000-4000-8000-0000000000a1'::uuid]
                          and bundle_ids = array['e1050002-0000-4000-8000-0000000000a1'::uuid]
                          and preorder_book_ids = array['e1050001-0000-4000-8000-0000000000a3'::uuid]
                          and processing_at is null
                         from public.account_deletion_requests where user_id = 'e1050000-0000-4000-8000-00000000000a'),
  'part3: records exactly what went offline');
select pg_temp.assert((select count(*) = 3 from public.books
                        where author_id = 'e1050000-0000-4000-8000-00000000000a' and status = 'draft'),
  'part3: every book of A is a draft');
select pg_temp.assert((select librum_choice_at is null from public.books where id = 'e1050001-0000-4000-8000-0000000000a1'),
  'part3: the Librum''s choice pick is cleared');
select pg_temp.assert((select release_date is not null and preorder_cancelled_at is null from public.books
                        where id = 'e1050001-0000-4000-8000-0000000000a3'),
  'part3: the pre-order is paused, not cancelled');
select pg_temp.assert((select status from public.bundles where id = 'e1050002-0000-4000-8000-0000000000a1') = 'draft',
  'part3: the bundle is a draft');
select pg_temp.assert((select count(*) = 1 and bool_and(reason = 'no_books' and note = 'Nuk gjeta' and created_on = current_date)
                         from public.account_deletion_feedback),
  'part3: the feedback is saved, trimmed, without the account');
select pg_temp.assert(not exists (select 1 from auth.sessions where user_id = 'e1050000-0000-4000-8000-00000000000a')
    and exists (select 1 from auth.sessions where user_id = 'e1050000-0000-4000-8000-00000000000b'),
  'part3: A is signed out everywhere, nobody else');

select pg_temp.assert(pg_temp.run_as('authenticated', 'e1050000-0000-4000-8000-00000000000a',
  $q$select public.request_account_deletion(null, null)$q$) like 'LB520:%', 'part3: a second request refused');
select pg_temp.assert(
  pg_temp.value_as('authenticated', 'e1050000-0000-4000-8000-00000000000a', $q$select public.my_account_status()$q$) = 'deletion_pending',
  'part3: deletion_pending');
select pg_temp.assert(
  pg_temp.value_as('authenticated', 'e1050000-0000-4000-8000-00000000000a', $q$select public.my_account_deletion_date()::text$q$)
    = (select delete_after::text from public.account_deletion_requests where user_id = 'e1050000-0000-4000-8000-00000000000a'),
  'part3: the caller''s own date');
select pg_temp.assert(
  pg_temp.value_as('authenticated', 'e1050000-0000-4000-8000-0000000000aa', $q$select coalesce(public.my_account_deletion_date()::text, 'none')$q$) = 'none',
  'part3: nobody else''s date');
select pg_temp.assert(
  pg_temp.value_as('authenticated', 'e1050000-0000-4000-8000-0000000000ac', $q$select public.my_account_status()$q$) = 'suspended',
  'part3: suspended');

-- Hidden from others; the author still sees their own.
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select count(*)::text from public.public_pen_names where id = 'e105be00-0000-4000-8000-0000000000a1'$q$) = '0',
  'part3: the pen name is hidden');
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select count(*)::text from public.public_series where id = 'e1050003-0000-4000-8000-0000000000a1'$q$) = '0',
  'part3: the series is hidden');
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select count(*)::text from public.public_books where id = 'e1050001-0000-4000-8000-0000000000a1'$q$) = '0',
  'part3: the book is hidden');

-- Nothing goes live again outside Restore.
select pg_temp.assert(pg_temp.run_as(null, null,
  $q$update public.books set status = 'published' where id = 'e1050001-0000-4000-8000-0000000000a1'$q$) like 'LB518:%',
  'part3: a book can''t be published while pending');
select pg_temp.assert(pg_temp.run_as(null, null,
  $q$update public.bundles set status = 'published' where id = 'e1050002-0000-4000-8000-0000000000a1'$q$) like 'LB518:%',
  'part3: a bundle can''t be published while pending');

-- ============================================================
-- Part 4: Restore.
-- ============================================================
select pg_temp.assert(
  pg_temp.value_as('authenticated', 'e1050000-0000-4000-8000-0000000000aa', $q$select public.restore_my_account()$q$) = 'not_pending',
  'part4: nothing to restore for an active account');
select pg_temp.assert(
  pg_temp.value_as('authenticated', 'e1050000-0000-4000-8000-00000000000a', $q$select public.restore_my_account()$q$) = 'restored',
  'part4: A restores');
select pg_temp.assert(not exists (select 1 from public.account_deletion_requests), 'part4: nothing pending');
select pg_temp.assert((select status from public.books where id = 'e1050001-0000-4000-8000-0000000000a1') = 'published',
  'part4: the live book is back');
select pg_temp.assert((select status from public.books where id = 'e1050001-0000-4000-8000-0000000000a2') = 'draft',
  'part4: the draft stays a draft');
select pg_temp.assert((select status from public.books where id = 'e1050001-0000-4000-8000-0000000000a3') = 'preorder',
  'part4: the pre-order is back');
select pg_temp.assert((select status from public.bundles where id = 'e1050002-0000-4000-8000-0000000000a1') = 'published',
  'part4: the bundle is back');
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select count(*)::text from public.public_pen_names where id = 'e105be00-0000-4000-8000-0000000000a1'$q$) = '1',
  'part4: the pen name is public again');
select pg_temp.assert(
  pg_temp.value_as('authenticated', 'e1050000-0000-4000-8000-00000000000a', $q$select public.my_account_status()$q$) = 'active',
  'part4: active again');

-- ============================================================
-- Part 5: R asks to delete; claim; the real deletion.
-- ============================================================
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select count(*)::text from public.public_reviews where body like 'P105 R%'$q$) = '1',
  'part5: R''s approved review is public');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1050000-0000-4000-8000-0000000000aa',
  $q$select public.request_account_deletion(null, null)$q$) = 'OK:1', 'part5: R asks to delete');
select pg_temp.assert((select count(*) = 1 from public.account_deletion_feedback),
  'part5: no feedback row when nothing was given');
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select count(*)::text from public.public_reviews where body like 'P105 R%'$q$) = '1',
  'part5: R''s review stays public while pending');
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select reviewer_name from public.public_reviews where body like 'P105 R%'$q$) = 'Lexuesi R',
  'part5: with the review name while pending');

select pg_temp.assert(pg_temp.run_as('authenticated', 'e1050000-0000-4000-8000-0000000000aa',
  $q$select public.account_deletion_claim('e1050000-0000-4000-8000-0000000000aa')$q$) like '42501:%',
  'part5: a user can''t claim');
select pg_temp.assert(pg_temp.value_as('service_role', null,
  $q$select public.account_deletion_claim('e1050000-0000-4000-8000-0000000000aa')::text$q$) = 'false',
  'part5: not due yet');

update public.account_deletion_requests
   set requested_at = now() - interval '31 days', delete_after = now() - interval '1 day'
 where user_id = 'e1050000-0000-4000-8000-0000000000aa';

-- Made staff, or suspended, during the 30 days: not claimed.
insert into public.staff_members (user_id, role) values ('e1050000-0000-4000-8000-0000000000aa', 'support');
select pg_temp.assert(pg_temp.value_as('service_role', null,
  $q$select public.account_deletion_claim('e1050000-0000-4000-8000-0000000000aa')::text$q$) = 'false',
  'part5: staff now: not claimed');
delete from public.staff_members where user_id = 'e1050000-0000-4000-8000-0000000000aa';
insert into public.account_suspensions (user_id, reason) values ('e1050000-0000-4000-8000-0000000000aa', 'P105 claim check');
select pg_temp.assert(pg_temp.value_as('service_role', null,
  $q$select public.account_deletion_claim('e1050000-0000-4000-8000-0000000000aa')::text$q$) = 'false',
  'part5: suspended now: not claimed');
update public.account_suspensions set lifted_at = now() where reason = 'P105 claim check';
select pg_temp.assert(
  (select processing_at is null from public.account_deletion_requests where user_id = 'e1050000-0000-4000-8000-0000000000aa'),
  'part5: nothing was marked');

select pg_temp.assert(pg_temp.value_as('service_role', null,
  $q$select public.account_deletion_claim('e1050000-0000-4000-8000-0000000000aa')::text$q$) = 'true',
  'part5: claimed when due');
select pg_temp.assert(pg_temp.value_as('service_role', null,
  $q$select public.account_deletion_claim('e1050000-0000-4000-8000-0000000000aa')::text$q$) = 'false',
  'part5: a second run within the hour can''t claim it again');
update public.account_deletion_requests set processing_at = now() - interval '2 hours'
 where user_id = 'e1050000-0000-4000-8000-0000000000aa';
select pg_temp.assert(pg_temp.value_as('service_role', null,
  $q$select public.account_deletion_claim('e1050000-0000-4000-8000-0000000000aa')::text$q$) = 'true',
  'part5: a failed claim from earlier is claimed again');
select pg_temp.assert(
  pg_temp.value_as('authenticated', 'e1050000-0000-4000-8000-0000000000aa', $q$select public.restore_my_account()$q$) = 'too_late',
  'part5: Restore refused once claimed');

-- The real deletion (the app's auth.admin.deleteUser cascades).
delete from auth.users where id = 'e1050000-0000-4000-8000-0000000000aa';

select pg_temp.assert(not exists (select 1 from public.account_deletion_requests), 'part5: the pending row went with it');
select pg_temp.assert((select reader_id is null and deleted_reader_review_name = 'Lexuesi R' and status = 'approved'
                         from public.reviews where body = 'P105 R on a1'),
  'part5: the approved review stays with the name');
select pg_temp.assert(not exists (select 1 from public.reviews where body = 'P105 R pending'),
  'part5: the pending review went');
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select reviewer_name || '|' || verified::text from public.public_reviews where body = 'P105 R on a1'$q$) = 'Lexuesi R|false',
  'part5: shown with the kept name, no badge');
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select reviewer_name || '|' || verified::text from public.public_reviews where body = 'P105 kept review'$q$) = 'Lexuesi Dy|true',
  'part5: a live reader''s review unchanged');

-- A pending author's account deletes too (books cascade; the pre-order
-- rules let a cascade through).
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1050000-0000-4000-8000-00000000000a',
  $q$select public.request_account_deletion(null, null)$q$) = 'OK:1', 'part5: A asks again');
delete from auth.users where id = 'e1050000-0000-4000-8000-00000000000a';
select pg_temp.assert(not exists (select 1 from public.books where author_id = 'e1050000-0000-4000-8000-00000000000a'),
  'part5: A''s books are gone');

select pg_temp.assert(true, 'done');
select 'assertions run: ' || n from pg_temp.assertions_run;

rollback;
