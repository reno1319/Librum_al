-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for BD16 P1
-- (supabase/migrations/20261106120000_bd16_preorders.sql), pre-orders:
-- * part1  the schema: the status value, the columns and their CHECKs,
--          public_books.release_date a plain column, the public rules
--          still IMMUTABLE, privileges;
-- * part2  asking for a listing: 14 days to 6 months (LB500), no
--          manuscript needed (D5), cover and AI answer still needed
--          (LB489), never a public-domain book (LB502);
-- * part3  staff approve a listing: the 3-item checklist, the book is a
--          pre-order, listed, searchable, its pen name and series public,
--          followers not told (returns false); too late (LB506);
-- * part4  only Librum's steps move a pre-order (LB503), it is not
--          deleted (LB507), its title is locked (LB480);
-- * part5  fail closed: no checkout, no bundle, no ownership;
-- * part6  "Më njofto": own rows only, twice is once, LB508, "Hiq";
-- * part7  the author pushes the date once (Q2 a, LB504);
-- * part8  the final file: a waiting change, approved, the book still
--          waits for its day;
-- * part9  run_preorder_day: releases, slips (+30), cancels on the
--          second miss and marks the readers, lists overdue ones, gives
--          3 more days after a send-back (Q5 a), runs twice safely,
--          never for a later day, service role only;
-- * part10 a final file approved on the release day releases the book;
-- * part11 the author cancels, lists again, and the third time is
--          refused (Q3b a, LB501);
-- * part12 suspension pauses a pre-order and the lift brings it back;
--          a staff takedown ends one.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/095_bd16_preorders.test.sql
--
-- Against the BASE schema it fails at once (no release_date): the
-- negative control. The rollback is 095_bd16_preorders.rollback.sql.
--
-- Everything runs inside one transaction and is rolled back at the end
-- (so now() and the Tirana day are fixed for the whole file).

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

create function pg_temp.today() returns date language sql as $$ select public.tirana_today() $$;

create function pg_temp.full_list() returns text language sql as $$
  select '{"cover_is_fine": true, "file_opens": true, "not_someone_elses_work": true, "rights_declared": true}'
$$;
create function pg_temp.short_list() returns text language sql as $$
  select '{"cover_is_fine": true, "not_someone_elses_work": true, "rights_declared": true}'
$$;

-- Author A sends book p for review.
create function pg_temp.send(p_book uuid) returns text language sql as $$
  select pg_temp.value_as('authenticated', 'e0950000-0000-4000-8000-00000000000a',
    format('select (public.request_book_review(%L) is not null)::text', p_book))
$$;

-- Staff S approves the book's pending review with the given checklist.
create function pg_temp.approve(p_book uuid, p_list text) returns text language sql as $$
  select pg_temp.value_as('authenticated', 'e0950000-0000-4000-8000-0000000000c1',
    format('select public.admin_approve_book_review(%L, %L, %L, %s, %L::jsonb)::text',
      (select id from public.book_reviews where book_id = p_book and status = 'pending'),
      (select file_path from public.book_reviews where book_id = p_book and status = 'pending'),
      (select cover_path from public.book_reviews where book_id = p_book and status = 'pending'),
      (select price_all from public.books where id = p_book),
      p_list))
$$;

create function pg_temp.run_day(p_today date) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  set local role service_role;
  v := public.run_preorder_day(p_today);
  reset role;
  return v;
end;
$$;

-- ============================================================
-- Fixture: author A (no published book, so A's pen name is private),
-- staff S, readers R1 and R2. Drafts p1..p6 of A, each with a cover,
-- a description and the AI answer; only p4 has a manuscript.
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0950000-0000-4000-8000-00000000000a', 'p095-a@test', now(), '{"role":"author","display_name":"P095 Ana"}'),
  ('e0950000-0000-4000-8000-0000000000c1', 'p095-s@test', now(), '{"role":"reader","display_name":"P095 Staff"}'),
  ('e0950000-0000-4000-8000-0000000000d1', 'p095-r1@test', now(), '{"role":"reader","display_name":"P095 Reader One"}'),
  ('e0950000-0000-4000-8000-0000000000d2', 'p095-r2@test', now(), '{"role":"reader","display_name":"P095 Reader Two"}');
insert into public.staff_members (user_id, role) values
  ('e0950000-0000-4000-8000-0000000000c1', 'owner');

insert into public.books (id, author_id, title, description, price_all, status, file_path, cover_path, categories, release_date)
select ('e0950001-0000-4000-8000-0000000000' || n)::uuid, 'e0950000-0000-4000-8000-00000000000a', 'P095 Book ' || n,
       'About book ' || n || '.', 0, 'draft',
       case when n = 'a4' then 'a/p4/v1.epub' end,
       ('e095000c-0000-4000-8000-0000000000' || n || '/cover.jpg'),
       array['Poezi'], pg_temp.today() + 20
  from unnest(array['a1', 'a2', 'a3', 'a4', 'a5', 'a6']) n;

insert into public.series (id, author_id, title, pen_name_id)
select 'e0950002-0000-4000-8000-000000000001', author_id, 'P095 Series', pen_name_id
  from public.books where id = 'e0950001-0000-4000-8000-0000000000a1';
update public.books set series_id = 'e0950002-0000-4000-8000-000000000001', series_position = 1
 where id = 'e0950001-0000-4000-8000-0000000000a1';

insert into public.book_rights_declarations (book_id, book_title, author_id, author_public_name, basis, statement_version, statement_text)
select bo.id, bo.title, bo.author_id, 'P095',
       case when bo.id::text like '%a5' then 'public_domain' else 'own_rights' end, 'v', 'Statement.'
  from public.books bo where bo.id::text like 'e0950001-%';

insert into public.book_ai_disclosures (book_id, ai_used)
select bo.id, false from public.books bo where bo.id::text like 'e0950001-%' and bo.id::text not like '%a3';

-- ============================================================
-- Part 1: the schema
-- ============================================================
select pg_temp.assert(
  (select pg_get_constraintdef(c.oid) from pg_constraint c
    where c.conrelid = 'public.books'::regclass and c.conname = 'books_status_check')
  = 'CHECK ((status = ANY (ARRAY[''draft''::text, ''published''::text, ''preorder''::text])))',
  'part1: books.status allows preorder');
select pg_temp.assert(
  (select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull, ',' order by a.attnum)
     from pg_attribute a where a.attrelid = 'public.books'::regclass
      and a.attname in ('release_date', 'preorder_listed_at', 'preorder_slip_used', 'preorder_count', 'preorder_cancelled_at'))
  = 'release_date:date:false,preorder_listed_at:timestamp with time zone:false,preorder_slip_used:boolean:true,preorder_count:smallint:true,preorder_cancelled_at:timestamp with time zone:false',
  'part1: the five books columns');
select pg_temp.assert(pg_temp.run_as(null, null,
  $q$insert into public.books (author_id, title, status) values ('e0950000-0000-4000-8000-00000000000a', 'P095 x', 'preorder')$q$)
  like '23514:%books_preorder_check%',
  'part1: a pre-order needs a date, a listing time and a count (CHECK)');
select pg_temp.assert(pg_temp.run_as(null, null,
  $q$update public.books set preorder_count = 3 where id = 'e0950001-0000-4000-8000-0000000000a1'$q$) like '23514:%books_preorder_count_check%',
  'part1: at most 2 pre-orders (CHECK)');
-- What PostgREST reads: release_date is a plain books column in the view.
select pg_temp.assert(
  exists (select 1 from pg_depend d join pg_rewrite r on r.oid = d.objid
           join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
          where r.ev_class = 'public.public_books'::regclass and d.refobjid = 'public.books'::regclass
            and a.attname = 'release_date')
  and pg_catalog.pg_get_viewdef('public.public_books'::regclass) !~* '\mcase\M',
  'part1: public_books.release_date is a plain column');
select pg_temp.assert(
  (select string_agg(p.provolatile::text, '' order by p.proname) from pg_proc p
    where p.oid in ('public.book_is_publicly_listed(public.books)'::regprocedure,
                    'public.book_makes_pen_name_public(public.books)'::regprocedure)) = 'ii',
  'part1: the two public rules stay IMMUTABLE (inlined in the views)');
select pg_temp.assert(
  has_function_privilege('authenticated', 'public.preorder_notify_me(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.preorder_notify_me(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.preorder_notify_remove(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.push_preorder_release_date(uuid,date)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.push_preorder_release_date(uuid,date)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.run_preorder_day(date)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.run_preorder_day(date)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.run_preorder_day(date)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.tirana_today()', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.books_preorder_rules()', 'EXECUTE'),
  'part1: function privileges');
select pg_temp.assert(
  (select relrowsecurity from pg_class where oid = 'public.preorder_notify_requests'::regclass)
  and has_table_privilege('authenticated', 'public.preorder_notify_requests', 'SELECT')
  and not has_table_privilege('authenticated', 'public.preorder_notify_requests', 'INSERT, UPDATE, DELETE')
  and not has_table_privilege('anon', 'public.preorder_notify_requests', 'SELECT')
  and has_table_privilege('service_role', 'public.preorder_notify_requests', 'SELECT, UPDATE, DELETE')
  and not has_table_privilege('service_role', 'public.preorder_notify_requests', 'INSERT'),
  'part1: preorder_notify_requests: RLS on, readers SELECT, the job SELECT/UPDATE/DELETE');
select pg_temp.assert(
  (select count(*) from pg_proc p
    where p.oid in ('public.books_preorder_rules()'::regprocedure, 'public.preorder_notify_me(uuid)'::regprocedure,
                    'public.preorder_notify_remove(uuid)'::regprocedure,
                    'public.push_preorder_release_date(uuid,date)'::regprocedure,
                    'public.run_preorder_day(date)'::regprocedure)
      and p.prosecdef and p.proconfig = array['search_path=""']) = 5,
  'part1: every new function is SECURITY DEFINER with an empty search_path');

-- ============================================================
-- Part 2: asking for a pre-order listing
-- ============================================================
update public.books set release_date = pg_temp.today() + 13 where id = 'e0950001-0000-4000-8000-0000000000a1';
select pg_temp.assert(pg_temp.send('e0950001-0000-4000-8000-0000000000a1') like 'LB500:%',
  'part2: 13 days ahead is too soon (Q1 a)');
update public.books set release_date = (pg_temp.today() + interval '6 months')::date + 1 where id = 'e0950001-0000-4000-8000-0000000000a1';
select pg_temp.assert(pg_temp.send('e0950001-0000-4000-8000-0000000000a1') like 'LB500:%',
  'part2: more than 6 months ahead is too late');
select pg_temp.assert(pg_temp.send('e0950001-0000-4000-8000-0000000000a3') like 'LB489:%',
  'part2: the AI answer is still required');
select pg_temp.assert(pg_temp.send('e0950001-0000-4000-8000-0000000000a5') like 'LB502:%',
  'part2: a public-domain book can''t be a pre-order (D3)');
update public.books set release_date = pg_temp.today() + 14 where id = 'e0950001-0000-4000-8000-0000000000a1';
select pg_temp.assert(pg_temp.send('e0950001-0000-4000-8000-0000000000a1') = 'true',
  'part2: 14 days ahead, without a manuscript, is sent (D5)');
select pg_temp.assert(
  (select release_date = pg_temp.today() + 14 and file_path is null from public.book_reviews
    where book_id = 'e0950001-0000-4000-8000-0000000000a1' and status = 'pending'),
  'part2: the review keeps the date asked for');
select pg_temp.assert(pg_temp.send('e0950001-0000-4000-8000-0000000000a1') like '%already waiting for review',
  'part2: the same request twice is one');
select pg_temp.assert(pg_temp.send('e0950001-0000-4000-8000-0000000000a4') = 'true',
  'part2: a pre-order with its manuscript is sent too');

-- ============================================================
-- Part 3: staff approve the listing
-- ============================================================
select pg_temp.assert(pg_temp.approve('e0950001-0000-4000-8000-0000000000a1', pg_temp.full_list()) like '%invalid checklist',
  'part3: a listing without a file has no "file opens" item');
select pg_temp.assert(pg_temp.value_as('anon', null,
  format('select count(*)::text from public.public_pen_names where id = %L',
         (select pen_name_id from public.books where id = 'e0950001-0000-4000-8000-0000000000a1'))) = '0'
  and pg_temp.value_as('anon', null,
  $q$select count(*)::text from public.public_series where id = 'e0950002-0000-4000-8000-000000000001'$q$) = '0',
  'part3: before the listing the pen name and the series are private');
select pg_temp.assert(pg_temp.approve('e0950001-0000-4000-8000-0000000000a1', pg_temp.short_list()) = 'false',
  'part3: the listing is approved; not a first publication (followers wait, D2)');
select pg_temp.assert(
  (select status = 'preorder' and preorder_listed_at = now() and preorder_count = 1 and not preorder_slip_used
          and published_at is null and release_date = pg_temp.today() + 14
     from public.books where id = 'e0950001-0000-4000-8000-0000000000a1'),
  'part3: the book is a pre-order, listed now, count 1, never published');
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select status || ':' || release_date::text from public.public_books where id = 'e0950001-0000-4000-8000-0000000000a1'$q$)
  = 'preorder:' || (pg_temp.today() + 14)::text,
  'part3: readers see it, with its date');
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select count(*)::text from public.public_pen_names
      where id = (select pen_name_id from public.public_books where id = 'e0950001-0000-4000-8000-0000000000a1')$q$) = '1'
  and pg_temp.value_as('anon', null,
  $q$select count(*)::text from public.public_series where id = 'e0950002-0000-4000-8000-000000000001'$q$) = '1',
  'part3: its pen name and its series are public');
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select count(*)::text from public.search_books('P095 Book a1')$q$) = '1',
  'part3: search finds it (D1)');
select pg_temp.assert((select metadata->>'preorder_listing' from public.admin_audit_log
                        where action = 'book.review_approved' and target_id = 'e0950001-0000-4000-8000-0000000000a1') = 'true',
  'part3: the audit row says it was a listing');
-- p4 (with its file): the full checklist; then too late for p2.
select pg_temp.assert(pg_temp.approve('e0950001-0000-4000-8000-0000000000a4', pg_temp.full_list()) = 'false',
  'part3: a listing with its file needs the full checklist (the call)');
select pg_temp.assert((select status from public.books where id = 'e0950001-0000-4000-8000-0000000000a4') = 'preorder',
  'part3: a listing with its file needs the full checklist');
update public.books set release_date = pg_temp.today() + 20 where id = 'e0950001-0000-4000-8000-0000000000a2';
select pg_temp.assert(pg_temp.send('e0950001-0000-4000-8000-0000000000a2') = 'true', 'part3: p2 sent');
update public.book_reviews set release_date = pg_temp.today() + 2
 where book_id = 'e0950001-0000-4000-8000-0000000000a2' and status = 'pending';
update public.books set release_date = pg_temp.today() + 2 where id = 'e0950001-0000-4000-8000-0000000000a2';
select pg_temp.assert(pg_temp.approve('e0950001-0000-4000-8000-0000000000a2', pg_temp.short_list()) like 'LB506:%',
  'part3: past the file due date a listing is refused (LB506) (the call)');
select pg_temp.assert((select status from public.books where id = 'e0950001-0000-4000-8000-0000000000a2') = 'draft',
  'part3: past the file due date a listing is refused (LB506)');
update public.books set release_date = pg_temp.today() + 25 where id = 'e0950001-0000-4000-8000-0000000000a2';
select pg_temp.assert(pg_temp.approve('e0950001-0000-4000-8000-0000000000a2', pg_temp.short_list()) like '%the author changed the book',
  'part3: a date changed after sending is refused');

-- ============================================================
-- Part 4: only Librum's steps move a pre-order
-- ============================================================
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set status = 'published' where id = 'e0950001-0000-4000-8000-0000000000a4'$q$) like 'LB503:%',
  'part4: the catalog writer can''t release a pre-order');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set release_date = release_date + 1 where id = 'e0950001-0000-4000-8000-0000000000a1'$q$) like 'LB503:%',
  'part4: nor move its date');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set preorder_count = 0 where id = 'e0950001-0000-4000-8000-0000000000a1'$q$) like 'LB503:%',
  'part4: nor reset its count');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set status = 'preorder', preorder_listed_at = now(), preorder_count = 1
      where id = 'e0950001-0000-4000-8000-0000000000a2'$q$) like 'LB503:%',
  'part4: nor make a draft a pre-order');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$insert into public.books (author_id, title, status, release_date, preorder_listed_at, preorder_count)
      values ('e0950000-0000-4000-8000-00000000000a', 'P095 sneaky', 'preorder', current_date + 30, now(), 1)$q$) like 'LB503:%',
  'part4: nor insert one');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0950000-0000-4000-8000-00000000000a',
  $q$delete from public.books where id = 'e0950001-0000-4000-8000-0000000000a1'$q$) like 'LB507:%',
  'part4: a pre-order is not deleted; cancel first');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set title = 'P095 renamed' where id = 'e0950001-0000-4000-8000-0000000000a1'$q$) like 'LB480:%',
  'part4: its title is locked from the listing (D4)');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set cover_path = 'e095000c-0000-4000-8000-0000000000f1/cover.jpg'
      where id = 'e0950001-0000-4000-8000-0000000000a1'$q$) like 'LB463:%',
  'part4: its cover changes only through review, like a live book');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$insert into public.book_rights_declarations (book_id, book_title, author_id, author_public_name, basis, statement_version, statement_text)
      values ('e0950001-0000-4000-8000-0000000000a1', 'P095 Book a1', 'e0950000-0000-4000-8000-00000000000a', 'P095',
              'public_domain', 'v', 'Statement.')$q$) like 'LB492:%',
  'part4: it keeps its rights basis');

-- ============================================================
-- Part 5: fail closed
-- ============================================================
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0950000-0000-4000-8000-0000000000d1',
  $q$select * from public.create_book_checkout_intent('e0950001-0000-4000-8000-0000000000a4')$q$)
  like '%book not available for purchase',
  'part5: a pre-order can''t be bought');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0950000-0000-4000-8000-0000000000d1',
  $q$select public.user_owns_book('e0950001-0000-4000-8000-0000000000a4')::text$q$) = 'false',
  'part5: nobody owns it');
insert into public.bundles (id, author_id, title, pen_name_id)
select 'e0950003-0000-4000-8000-000000000001', author_id, 'P095 Bundle', pen_name_id
  from public.books where id = 'e0950001-0000-4000-8000-0000000000a1';
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$select * from public.replace_bundle_membership('e0950003-0000-4000-8000-000000000001', 'e0950000-0000-4000-8000-00000000000a',
      array['e0950001-0000-4000-8000-0000000000a1', 'e0950001-0000-4000-8000-0000000000a4']::uuid[])$q$)
  like '%every book must be the author''s own published book',
  'part5: a pre-order is not put in a bundle (D6)');

-- ============================================================
-- Part 6: "Më njofto"
-- ============================================================
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0950000-0000-4000-8000-0000000000d1',
  $q$select public.preorder_notify_me('e0950001-0000-4000-8000-0000000000a1')::text$q$) = 'true'
  and pg_temp.value_as('authenticated', 'e0950000-0000-4000-8000-0000000000d1',
  $q$select public.preorder_notify_me('e0950001-0000-4000-8000-0000000000a1')::text$q$) = 'false',
  'part6: a reader asks once; twice is once');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0950000-0000-4000-8000-0000000000d2',
  $q$select public.preorder_notify_me('e0950001-0000-4000-8000-0000000000a1')::text$q$) = 'true'
  and pg_temp.value_as('authenticated', 'e0950000-0000-4000-8000-0000000000d2',
  $q$select public.preorder_notify_me('e0950001-0000-4000-8000-0000000000a4')::text$q$) = 'true',
  'part6: a second reader, on two books');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0950000-0000-4000-8000-0000000000d1',
  $q$select count(*)::text from public.preorder_notify_requests$q$) = '1'
  and pg_temp.value_as('authenticated', 'e0950000-0000-4000-8000-00000000000a',
  $q$select count(*)::text from public.preorder_notify_requests$q$) = '0',
  'part6: each reader sees only their own rows; the author sees none');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0950000-0000-4000-8000-0000000000d1',
  $q$select public.preorder_notify_me('e0950001-0000-4000-8000-0000000000a2')::text$q$) like 'LB508:%',
  'part6: only for a live pre-order');
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select public.preorder_notify_me('e0950001-0000-4000-8000-0000000000a1')::text$q$) like '42501:%',
  'part6: signed-in readers only');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0950000-0000-4000-8000-0000000000d2',
  $q$select public.preorder_notify_remove('e0950001-0000-4000-8000-0000000000a4')::text$q$) = 'true'
  and pg_temp.value_as('authenticated', 'e0950000-0000-4000-8000-0000000000d2',
  $q$select public.preorder_notify_remove('e0950001-0000-4000-8000-0000000000a4')::text$q$) = 'false',
  'part6: "Hiq" removes it');

-- ============================================================
-- Part 7: the author pushes the date once (Q2 a)
-- ============================================================
create function pg_temp.push(p_book uuid, p_date date) returns text language sql as $$
  select pg_temp.value_as('authenticated', 'e0950000-0000-4000-8000-00000000000a',
    format('select public.push_preorder_release_date(%L, %L)::text', p_book, p_date))
$$;
select pg_temp.assert(pg_temp.push('e0950001-0000-4000-8000-0000000000a2', pg_temp.today() + 30) like 'LB504:%',
  'part7: only a pre-order');
select pg_temp.assert(pg_temp.push('e0950001-0000-4000-8000-0000000000a1', pg_temp.today() + 14 + 31) like 'LB504:%'
  and pg_temp.push('e0950001-0000-4000-8000-0000000000a1', pg_temp.today() + 14) like 'LB504:%',
  'part7: later by 1 to 30 days');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0950000-0000-4000-8000-0000000000d1',
  format('select public.push_preorder_release_date(%L, %L)::text', 'e0950001-0000-4000-8000-0000000000a1', pg_temp.today() + 20))
  = 'P0001:no book found for this id',
  'part7: only its author');
select pg_temp.assert(pg_temp.push('e0950001-0000-4000-8000-0000000000a1', pg_temp.today() + 44) = (pg_temp.today() + 44)::text,
  'part7: pushed 30 days; that is the slip (the call)');
select pg_temp.assert((select release_date = pg_temp.today() + 44 and preorder_slip_used from public.books
        where id = 'e0950001-0000-4000-8000-0000000000a1'),
  'part7: pushed 30 days; that is the slip');
select pg_temp.assert(pg_temp.push('e0950001-0000-4000-8000-0000000000a1', pg_temp.today() + 45) like 'LB504:%',
  'part7: once only');

-- ============================================================
-- Part 8: the final file comes as a waiting change
-- ============================================================
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$select public.save_book_pending_changes('e0950000-0000-4000-8000-00000000000a', 'e0950001-0000-4000-8000-0000000000a1', null,
      null, 'e095000c-0000-4000-8000-0000000000a1/cover.jpg', 'A better description.', false, null)$q$) = 'OK:1',
  'part8: a pre-order without its file keeps waiting changes without one');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$select public.save_book_pending_changes('e0950000-0000-4000-8000-00000000000a', 'e0950001-0000-4000-8000-0000000000a4',
      (select version from public.book_pending_changes where book_id = 'e0950001-0000-4000-8000-0000000000a4'),
      null, 'e095000c-0000-4000-8000-0000000000a4/cover.jpg', 'About book a4.', false, null)$q$) like 'LB491:%',
  'part8: one that has its file can''t drop it');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$select public.save_book_pending_changes('e0950000-0000-4000-8000-00000000000a', 'e0950001-0000-4000-8000-0000000000a1',
      (select version from public.book_pending_changes where book_id = 'e0950001-0000-4000-8000-0000000000a1'),
      'a/p1/final.epub', 'e095000c-0000-4000-8000-0000000000a1/cover.jpg', 'A better description.', false, null)$q$) = 'OK:1',
  'part8: the final file is saved and sent (step 1)');
select pg_temp.assert(pg_temp.send('e0950001-0000-4000-8000-0000000000a1') = 'true',
  'part8: the final file is saved and sent');
select pg_temp.assert(pg_temp.approve('e0950001-0000-4000-8000-0000000000a1', pg_temp.full_list()) = 'false',
  'part8: approved, applied; the book still waits for its day (the call)');
select pg_temp.assert((select status = 'preorder' and file_path = 'a/p1/final.epub' and description = 'A better description.'
         from public.books where id = 'e0950001-0000-4000-8000-0000000000a1'),
  'part8: approved, applied; the book still waits for its day');

-- ============================================================
-- Part 9: the daily job
-- ============================================================
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0950000-0000-4000-8000-0000000000c1',
  $q$select public.run_preorder_day(null)$q$) like '42501:%',
  'part9: service role only');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  format('select public.run_preorder_day(%L)', pg_temp.today() + 1)) like 'P0001:%later day%',
  'part9: never for a later day');
-- a. p1 (file approved) reaches its day: released.
update public.books set release_date = pg_temp.today() where id = 'e0950001-0000-4000-8000-0000000000a1';
-- b. p4 has its file too but its day is later: untouched.
select pg_temp.assert(
  (pg_temp.run_day(null)->'released_book_ids') = pg_catalog.to_jsonb(array['e0950001-0000-4000-8000-0000000000a1']::uuid[]),
  'part9: the due book with an approved file is released, the other waits (the call)');
select pg_temp.assert((select status = 'published' and published_at = now() from public.books where id = 'e0950001-0000-4000-8000-0000000000a1')
  and (select status from public.books where id = 'e0950001-0000-4000-8000-0000000000a4') = 'preorder',
  'part9: the due book with an approved file is released, the other waits');
select pg_temp.assert(
  (select count(*) from public.preorder_notify_requests
    where book_id = 'e0950001-0000-4000-8000-0000000000a1' and notified_at is null and book_cancelled_at is null) = 2,
  'part9: its two readers wait for the release email (sent by the route)');
select pg_temp.assert(pg_temp.run_day(null)->'released_book_ids' = '[]'::jsonb,
  'part9: a second run releases nothing more');

-- Missed deadlines on p2: listed (a fresh book state) with no file.
update public.books set release_date = pg_temp.today() + 20 where id = 'e0950001-0000-4000-8000-0000000000a2';
update public.book_reviews set status = 'cancelled', decided_at = now()
 where book_id = 'e0950001-0000-4000-8000-0000000000a2' and status = 'pending';
select pg_temp.assert(pg_temp.send('e0950001-0000-4000-8000-0000000000a2') = 'true',
  'part9: p2 listed without a file (step 1)');
select pg_temp.assert(pg_temp.approve('e0950001-0000-4000-8000-0000000000a2', pg_temp.short_list()) = 'false',
  'part9: p2 listed without a file');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0950000-0000-4000-8000-0000000000d1',
  $q$select public.preorder_notify_me('e0950001-0000-4000-8000-0000000000a2')::text$q$) = 'true',
  'part9: a reader waits for p2');
-- The due date (day - 3) is today: not missed yet.
update public.books set release_date = pg_temp.today() + 3 where id = 'e0950001-0000-4000-8000-0000000000a2';
select pg_temp.assert(pg_temp.run_day(null)->'slipped' = '[]'::jsonb,
  'part9: on the due date itself nothing is missed');
-- Q5 a: sent back yesterday, due date passed: 3 days from the send-back.
-- (The listing is moved 3 days back, so the send-back comes after it.)
update public.book_reviews set decided_at = now() - interval '3 days'
 where book_id = 'e0950001-0000-4000-8000-0000000000a2' and status = 'approved' and release_date is not null;
update public.books set release_date = pg_temp.today() + 2 where id = 'e0950001-0000-4000-8000-0000000000a2';
insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, description, is_adult,
                                 status, reason, message_to_author, submitted_at, decided_at)
select id, title, author_id, 'a/p2/bad.epub', cover_path, description, is_adult, 'sent_back', 'broken_file', 'Fix it.',
       now() - interval '2 days', now() - interval '1 day'
  from public.books where id = 'e0950001-0000-4000-8000-0000000000a2';
select pg_temp.assert(pg_temp.run_day(null)->'slipped' = '[]'::jsonb,
  'part9: a send-back gives 3 more days (Q5 a)');
-- Audit r1 F3: a sent-back change without a file (a cover or a
-- description) gives no extra days.
update public.book_reviews set file_path = null
 where book_id = 'e0950001-0000-4000-8000-0000000000a2' and status = 'sent_back';
-- So this run is the first miss: +30 days, the slip is used.
select pg_temp.assert(
  (pg_temp.run_day(null)->'slipped') = pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
     'book_id', 'e0950001-0000-4000-8000-0000000000a2', 'release_date', (pg_temp.today() + 32)::text)),
  'part9: a sent-back cover change gives no extra days, so the first miss moves the date 30 days (audit r1 F3; the call)');
select pg_temp.assert((select release_date = pg_temp.today() + 32 and preorder_slip_used and status = 'preorder'
         from public.books where id = 'e0950001-0000-4000-8000-0000000000a2'),
  'part9: the first miss moves the date 30 days');
select pg_temp.assert(pg_temp.run_day(null)->'slipped' = '[]'::jsonb,
  'part9: a second run the same day moves nothing');
-- Overdue: the file sent in time, not approved, the day passed: waits.
update public.books set release_date = pg_temp.today() - 1 where id = 'e0950001-0000-4000-8000-0000000000a2';
insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, description, is_adult, status)
select id, title, author_id, 'a/p2/final.epub', cover_path, description, is_adult, 'pending'
  from public.books where id = 'e0950001-0000-4000-8000-0000000000a2';
select pg_temp.assert(
  (pg_temp.run_day(null)->'overdue_book_ids') = pg_catalog.to_jsonb(array['e0950001-0000-4000-8000-0000000000a2']::uuid[]),
  'part9: sent in time but not approved: overdue, not a miss (the call)');
select pg_temp.assert((select status from public.books where id = 'e0950001-0000-4000-8000-0000000000a2') = 'preorder',
  'part9: sent in time but not approved: overdue, not a miss');
-- Second miss: cancelled; the waiting reader is marked.
update public.book_reviews set status = 'withdrawn', decided_at = now()
 where book_id = 'e0950001-0000-4000-8000-0000000000a2' and status = 'pending';
select pg_temp.assert(
  (pg_temp.run_day(null)->'cancelled_book_ids') = pg_catalog.to_jsonb(array['e0950001-0000-4000-8000-0000000000a2']::uuid[]),
  'part9: the second miss cancels: draft, date cleared, cancel time set (the call)');
select pg_temp.assert((select status = 'draft' and release_date is null and preorder_cancelled_at = now() and preorder_listed_at is not null
         from public.books where id = 'e0950001-0000-4000-8000-0000000000a2'),
  'part9: the second miss cancels: draft, date cleared, cancel time set');
select pg_temp.assert(
  (select count(*) from public.preorder_notify_requests
    where book_id = 'e0950001-0000-4000-8000-0000000000a2' and book_cancelled_at = now() and notified_at is null) = 1,
  'part9: its reader is marked for the "cancelled" email (Q4 a)');
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select count(*)::text from public.public_books where id = 'e0950001-0000-4000-8000-0000000000a2'$q$) = '0',
  'part9: a cancelled pre-order is not listed');

-- ============================================================
-- Part 10: a final file approved after the day releases the book
-- ============================================================
-- p3 gets its AI answer and is listed without a file.
insert into public.book_ai_disclosures (book_id, ai_used) values ('e0950001-0000-4000-8000-0000000000a3', true);
select pg_temp.assert(pg_temp.send('e0950001-0000-4000-8000-0000000000a3') = 'true',
  'part10: p3 listed (step 1)');
select pg_temp.assert(pg_temp.approve('e0950001-0000-4000-8000-0000000000a3', pg_temp.short_list()) = 'false',
  'part10: p3 listed');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$select public.save_book_pending_changes('e0950000-0000-4000-8000-00000000000a', 'e0950001-0000-4000-8000-0000000000a3', null,
      'a/p3/final.epub', 'e095000c-0000-4000-8000-0000000000a3/cover.jpg', 'About book a3.', false, null)$q$) = 'OK:1',
  'part10: its final file sent (step 1)');
select pg_temp.assert(pg_temp.send('e0950001-0000-4000-8000-0000000000a3') = 'true',
  'part10: its final file sent');
-- Staff approve on the release day itself (audit r1 F2, M8: on the
-- day counts, not only after it).
update public.books set release_date = pg_temp.today() where id = 'e0950001-0000-4000-8000-0000000000a3';
select pg_temp.assert(pg_temp.approve('e0950001-0000-4000-8000-0000000000a3', pg_temp.full_list()) = 'true',
  'part10: the approval releases it at once; a first publication (true) (the call)');
select pg_temp.assert((select status = 'published' and published_at = now() and file_path = 'a/p3/final.epub'
         from public.books where id = 'e0950001-0000-4000-8000-0000000000a3'),
  'part10: the approval releases it at once; a first publication (true)');

-- ============================================================
-- Part 11: cancel, list again, and the limit of 2 (Q3 b, Q3b a)
-- ============================================================
-- p4 is a pre-order with a reader; the author cancels (unpublishes).
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0950000-0000-4000-8000-0000000000d1',
  $q$select public.preorder_notify_me('e0950001-0000-4000-8000-0000000000a4')::text$q$) = 'true',
  'part11: a reader waits for p4');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set status = 'draft' where id = 'e0950001-0000-4000-8000-0000000000a4'$q$) = 'OK:1',
  'part11: the author cancels; the reader is marked (the call)');
select pg_temp.assert((select status = 'draft' and release_date is null and preorder_cancelled_at = now() and preorder_count = 1
         from public.books where id = 'e0950001-0000-4000-8000-0000000000a4')
  and (select book_cancelled_at = now() from public.preorder_notify_requests
        where book_id = 'e0950001-0000-4000-8000-0000000000a4' and user_id = 'e0950000-0000-4000-8000-0000000000d1'),
  'part11: the author cancels; the reader is marked');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set title = 'P095 renamed' where id = 'e0950001-0000-4000-8000-0000000000a4'$q$) like 'LB480:%',
  'part11: the title stays locked after the cancel');
update public.books set release_date = pg_temp.today() + 30 where id = 'e0950001-0000-4000-8000-0000000000a4';
select pg_temp.assert(pg_temp.send('e0950001-0000-4000-8000-0000000000a4') = 'true',
  'part11: listed a second time, with a fresh slip (the call) (step 1)');
select pg_temp.assert(pg_temp.approve('e0950001-0000-4000-8000-0000000000a4', pg_temp.full_list()) = 'false',
  'part11: listed a second time, with a fresh slip (the call)');
select pg_temp.assert((select status = 'preorder' and preorder_count = 2 and not preorder_slip_used
         from public.books where id = 'e0950001-0000-4000-8000-0000000000a4'),
  'part11: listed a second time, with a fresh slip');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0950000-0000-4000-8000-0000000000d1',
  $q$select public.preorder_notify_me('e0950001-0000-4000-8000-0000000000a4')::text$q$) = 'true',
  'part11: the reader asks again; the old row becomes a fresh request (the call)');
select pg_temp.assert((select book_cancelled_at is null and notified_at is null from public.preorder_notify_requests
        where book_id = 'e0950001-0000-4000-8000-0000000000a4' and user_id = 'e0950000-0000-4000-8000-0000000000d1'),
  'part11: the reader asks again; the old row becomes a fresh request');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set status = 'draft' where id = 'e0950001-0000-4000-8000-0000000000a4'$q$) = 'OK:1',
  'part11: cancelled again');
update public.books set release_date = pg_temp.today() + 30 where id = 'e0950001-0000-4000-8000-0000000000a4';
select pg_temp.assert(pg_temp.send('e0950001-0000-4000-8000-0000000000a4') like 'LB501:%',
  'part11: a third pre-order is refused');
update public.books set release_date = null where id = 'e0950001-0000-4000-8000-0000000000a4';
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set status = 'published' where id = 'e0950001-0000-4000-8000-0000000000a4'$q$) = 'OK:1',
  'part11: it can still be published normally (its file and cover were approved)');

-- ============================================================
-- Part 12: suspension pauses, the lift brings it back; a takedown ends it
-- ============================================================
-- p5 (public domain) becomes own-rights and is listed with a file.
insert into public.book_rights_declarations (book_id, book_title, author_id, author_public_name, basis, statement_version, statement_text,
                                             declared_at)
values ('e0950001-0000-4000-8000-0000000000a5', 'P095 Book a5', 'e0950000-0000-4000-8000-00000000000a', 'P095',
        'own_rights', 'v', 'Statement.', now() + interval '1 second');
update public.books set file_path = 'a/p5/v1.epub', release_date = pg_temp.today() + 20
 where id = 'e0950001-0000-4000-8000-0000000000a5';
select pg_temp.assert(pg_temp.send('e0950001-0000-4000-8000-0000000000a5') = 'true',
  'part12: p5 listed (step 1)');
-- Audit r1 F2 (M3): a listing WITH its file is refused once its day has come.
update public.books set release_date = pg_temp.today() where id = 'e0950001-0000-4000-8000-0000000000a5';
update public.book_reviews set release_date = pg_temp.today()
 where book_id = 'e0950001-0000-4000-8000-0000000000a5' and status = 'pending';
select pg_temp.assert(pg_temp.approve('e0950001-0000-4000-8000-0000000000a5', pg_temp.full_list()) like 'LB506:%',
  'part12: a listing with its file is refused on its day (LB506)');
select pg_temp.assert((select status from public.books where id = 'e0950001-0000-4000-8000-0000000000a5') = 'draft',
  'part12: and stays a draft');
update public.books set release_date = pg_temp.today() + 20 where id = 'e0950001-0000-4000-8000-0000000000a5';
update public.book_reviews set release_date = pg_temp.today() + 20
 where book_id = 'e0950001-0000-4000-8000-0000000000a5' and status = 'pending';
select pg_temp.assert(pg_temp.approve('e0950001-0000-4000-8000-0000000000a5', pg_temp.full_list()) = 'false',
  'part12: p5 listed');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0950000-0000-4000-8000-0000000000d2',
  $q$select public.preorder_notify_me('e0950001-0000-4000-8000-0000000000a5')::text$q$) = 'true',
  'part12: a reader waits for p5');
-- Audit r1 F1: p6 is listed without a file and its final file waits
-- for review (the usual state of a pre-order) when the author is
-- suspended.
select pg_temp.assert(pg_temp.send('e0950001-0000-4000-8000-0000000000a6') = 'true',
  'part12: p6 sent (step 1)');
select pg_temp.assert(pg_temp.approve('e0950001-0000-4000-8000-0000000000a6', pg_temp.short_list()) = 'false',
  'part12: p6 listed');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$select public.save_book_pending_changes('e0950000-0000-4000-8000-00000000000a', 'e0950001-0000-4000-8000-0000000000a6', null,
      'a/p6/final.epub', 'e095000c-0000-4000-8000-0000000000a6/cover.jpg', 'About book a6.', false, null)$q$) = 'OK:1',
  'part12: p6 final file saved');
select pg_temp.assert(pg_temp.send('e0950001-0000-4000-8000-0000000000a6') = 'true',
  'part12: p6 final file sent');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0950000-0000-4000-8000-0000000000d1',
  $q$select public.preorder_notify_me('e0950001-0000-4000-8000-0000000000a6')::text$q$) = 'true',
  'part12: a reader waits for p6');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0950000-0000-4000-8000-0000000000c1',
  $q$select public.admin_suspend_account('e0950000-0000-4000-8000-00000000000a', 'Test.')$q$) = 'OK:1',
  'part12: suspension pauses the pre-order: hidden, its date kept, nobody told (the call)');
select pg_temp.assert((select status = 'draft' and release_date = pg_temp.today() + 20 and preorder_cancelled_at is null
         from public.books where id = 'e0950001-0000-4000-8000-0000000000a5')
  and (select preorder_book_ids = array['e0950001-0000-4000-8000-0000000000a5', 'e0950001-0000-4000-8000-0000000000a6']::uuid[]
         from public.account_suspensions where user_id = 'e0950000-0000-4000-8000-00000000000a' and lifted_at is null)
  and (select book_cancelled_at is null from public.preorder_notify_requests
        where book_id = 'e0950001-0000-4000-8000-0000000000a5'),
  'part12: suspension pauses the pre-order: hidden, its date kept, nobody told');
select pg_temp.assert((select status = 'draft' and file_path is null and release_date is not null
         from public.books where id = 'e0950001-0000-4000-8000-0000000000a6')
  and (select file_path = 'a/p6/final.epub' from public.book_pending_changes
        where book_id = 'e0950001-0000-4000-8000-0000000000a6')
  and (select status from public.book_reviews
        where book_id = 'e0950001-0000-4000-8000-0000000000a6' and file_path = 'a/p6/final.epub') = 'cancelled',
  'part12: the pause keeps the approved version on the book and the waiting change saved; its review is cancelled');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0950000-0000-4000-8000-0000000000c1',
  $q$select (public.admin_lift_suspension('e0950000-0000-4000-8000-00000000000a')->'restored_preorder_ids')::text$q$)
  = '["e0950001-0000-4000-8000-0000000000a5", "e0950001-0000-4000-8000-0000000000a6"]',
  'part12: the lift brings both back (the call)');
select pg_temp.assert((select status = 'preorder' and release_date = pg_temp.today() + 20 and preorder_count = 1
         from public.books where id = 'e0950001-0000-4000-8000-0000000000a5'),
  'part12: the lift brings it back as it was');
select pg_temp.assert((select status = 'preorder' and preorder_count = 1 and preorder_cancelled_at is null and file_path is null
         from public.books where id = 'e0950001-0000-4000-8000-0000000000a6')
  and (select file_path = 'a/p6/final.epub' from public.book_pending_changes
        where book_id = 'e0950001-0000-4000-8000-0000000000a6')
  and (select book_cancelled_at is null from public.preorder_notify_requests
        where book_id = 'e0950001-0000-4000-8000-0000000000a6'),
  'part12: a pre-order whose final file was waiting comes back too: no cancel, no email, no pre-order used (audit r1 F1)');
select pg_temp.assert(pg_temp.send('e0950001-0000-4000-8000-0000000000a6') = 'true',
  'part12: the author sends the kept final file again');
-- A paused pre-order that can't come back (here: taken down while
-- the author was suspended) ends as a cancel at the lift; the kept
-- final file becomes the draft's file, as for any book going offline.
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0950000-0000-4000-8000-0000000000c1',
  $q$select public.admin_suspend_account('e0950000-0000-4000-8000-00000000000a', 'Again.')$q$) = 'OK:1',
  'part12: a second suspension pauses p5 and p6');
insert into public.book_takedowns (book_id, book_title, author_id, reason, message_to_author)
select id, title, author_id, 'other', 'Taken down.' from public.books where id = 'e0950001-0000-4000-8000-0000000000a6';
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0950000-0000-4000-8000-0000000000c1',
  $q$select (public.admin_lift_suspension('e0950000-0000-4000-8000-00000000000a')->'restored_preorder_ids')::text$q$)
  = '["e0950001-0000-4000-8000-0000000000a5"]',
  'part12: the lift brings back only p5 (the call)');
select pg_temp.assert((select status = 'draft' and release_date is null and preorder_cancelled_at = now()
                              and file_path = 'a/p6/final.epub'
         from public.books where id = 'e0950001-0000-4000-8000-0000000000a6')
  and not exists (select 1 from public.book_pending_changes where book_id = 'e0950001-0000-4000-8000-0000000000a6')
  and (select book_cancelled_at = now() from public.preorder_notify_requests
        where book_id = 'e0950001-0000-4000-8000-0000000000a6'),
  'part12: p6, taken down meanwhile, ends at the lift: cancelled, its kept final file on the draft, the reader marked');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0950000-0000-4000-8000-0000000000c1',
  $q$select public.admin_unpublish_book('e0950001-0000-4000-8000-0000000000a5', 'copyright', 'A complaint.')$q$) = 'OK:1',
  'part12: a staff takedown ends the pre-order; the reader is marked (the call)');
select pg_temp.assert((select status = 'draft' and release_date is null and preorder_cancelled_at = now()
         from public.books where id = 'e0950001-0000-4000-8000-0000000000a5')
  and (select book_cancelled_at = now() from public.preorder_notify_requests
        where book_id = 'e0950001-0000-4000-8000-0000000000a5'),
  'part12: a staff takedown ends the pre-order; the reader is marked');

do $$
begin
  perform pg_temp.assert((select n from pg_temp.assertions_run) > 70,
    format('expected more than 70 assertions, ran %s', (select n from pg_temp.assertions_run)));
end $$;

select 'ALL PASSED: 095_bd16_preorders.test.sql (' || (select n from pg_temp.assertions_run) || ' assertions)' as result;

rollback;
