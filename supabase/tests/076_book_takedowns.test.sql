-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for ADMIN-2-TAKEDOWN
-- (supabase/migrations/20261020080000_book_takedowns.sql):
--
-- * book_takedowns: RLS on; authenticated holds SELECT on the author-
--   facing columns only (select * and select id fail with 42501), anon
--   nothing, service_role SELECT only; nobody may INSERT, UPDATE or
--   DELETE; an author reads only their own rows, staff with reports.view
--   every row, another author, a buyer and support none;
-- * admin_unpublish_book(): support, editor, a reader, the author and
--   anon are refused; owner/admin/moderator allowed; bad reason/message,
--   a missing book, and a report that is not an open report of this book
--   are refused; the book becomes a draft and loses Librum's choice;
--   exactly its PUBLISHED bundles are drafted and recorded; the report
--   it came from is resolved like review_book_report (other open reports
--   stay open) with both audit rows, and the book.unpublished metadata
--   never carries the message; a second takedown is refused; a draft
--   may be taken down;
-- * the lock trigger refuses status = 'published' for service_role and
--   the table owner while a takedown is active, and allows it once
--   lifted; other columns stay writable;
-- * admin_allow_book_again(): same guard; lifts, audits, leaves the book
--   and its bundles drafts; refuses when nothing is active;
-- * a DIRECT delete of a taken-down book (author, service_role, table
--   owner) is refused with LB461 until the takedown is lifted; deleting
--   the account (profiles or auth.users cascade) still works;
-- * buyers keep reading the book (public_books); the history survives deleting the
--   book and the account; the audit list RPC accepts the new actions and
--   target type.
--
-- The schema.sql / migration equivalence is in
-- 076_book_takedowns_catalog_equivalence.sh.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance (17 or newer: schema.sql uses the MAINTAIN privilege; on 16
-- strip ", maintain" from a copy):
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/076_book_takedowns.test.sql
--
-- It must also pass against the base schema.sql plus the migration.
-- Against the BASE schema alone it fails at once (no book_takedowns):
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

-- ============================================================
-- Part 0: fixtures.
--   A  author: P1 (published, Librum's choice, in published bundle U1
--      and draft bundle U2), P2 (published, in U1 and published U3),
--      P3 (published, in U3), D (draft)
--   B  author: Q (published)
--   R  reader who bought P1
--   O owner, AD admin, M moderator, S support, E editor
--   reports on P1: rep1 open (copyright), rep2 open, rep4 resolved;
--   rep3 open on P2
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0760000-0000-4000-8000-00000000000a', 'p076-a@test', now(), '{"role":"author","display_name":"P076 Ana"}'),
  ('e0760000-0000-4000-8000-00000000000b', 'p076-b@test', now(), '{"role":"author","display_name":"P076 Ben"}'),
  ('e0760000-0000-4000-8000-0000000000aa', 'p076-r@test', now(), '{"role":"reader","display_name":"P076 Reader"}'),
  ('e0760000-0000-4000-8000-0000000000c1', 'p076-o@test', now(), '{"role":"reader","display_name":"P076 Owner"}'),
  ('e0760000-0000-4000-8000-0000000000c2', 'p076-ad@test', now(), '{"role":"reader","display_name":"P076 Admin"}'),
  ('e0760000-0000-4000-8000-0000000000c3', 'p076-m@test', now(), '{"role":"reader","display_name":"P076 Moderator"}'),
  ('e0760000-0000-4000-8000-0000000000c4', 'p076-s@test', now(), '{"role":"reader","display_name":"P076 Support"}'),
  ('e0760000-0000-4000-8000-0000000000c5', 'p076-e@test', now(), '{"role":"reader","display_name":"P076 Editor"}');

insert into public.staff_members (user_id, role) values
  ('e0760000-0000-4000-8000-0000000000c1', 'owner'),
  ('e0760000-0000-4000-8000-0000000000c2', 'admin'),
  ('e0760000-0000-4000-8000-0000000000c3', 'moderator'),
  ('e0760000-0000-4000-8000-0000000000c4', 'support'),
  ('e0760000-0000-4000-8000-0000000000c5', 'editor');

insert into public.books (id, author_id, title, status, price_all, published_at) values
  ('e0760001-0000-4000-8000-0000000000a1', 'e0760000-0000-4000-8000-00000000000a', 'P076 One',   'published', 499, now()),
  ('e0760001-0000-4000-8000-0000000000a2', 'e0760000-0000-4000-8000-00000000000a', 'P076 Two',   'published', 199, now()),
  ('e0760001-0000-4000-8000-0000000000a3', 'e0760000-0000-4000-8000-00000000000a', 'P076 Three', 'published', 199, now()),
  ('e0760001-0000-4000-8000-0000000000a4', 'e0760000-0000-4000-8000-00000000000a', 'P076 Draft', 'draft',     199, null),
  ('e0760001-0000-4000-8000-0000000000b1', 'e0760000-0000-4000-8000-00000000000b', 'P076 Ben',   'published', 0,   now());

update public.books set librum_choice_at = now() where id = 'e0760001-0000-4000-8000-0000000000a1';

insert into public.bundles (id, author_id, title, status, price_all) values
  ('e0760003-0000-4000-8000-000000000001', 'e0760000-0000-4000-8000-00000000000a', 'U1 published', 'published', 599),
  ('e0760003-0000-4000-8000-000000000002', 'e0760000-0000-4000-8000-00000000000a', 'U2 draft',     'draft',     599),
  ('e0760003-0000-4000-8000-000000000003', 'e0760000-0000-4000-8000-00000000000a', 'U3 published', 'published', 299);
insert into public.bundle_books (bundle_id, book_id) values
  ('e0760003-0000-4000-8000-000000000001', 'e0760001-0000-4000-8000-0000000000a1'),
  ('e0760003-0000-4000-8000-000000000001', 'e0760001-0000-4000-8000-0000000000a2'),
  ('e0760003-0000-4000-8000-000000000002', 'e0760001-0000-4000-8000-0000000000a1'),
  ('e0760003-0000-4000-8000-000000000002', 'e0760001-0000-4000-8000-0000000000a4'),
  ('e0760003-0000-4000-8000-000000000003', 'e0760001-0000-4000-8000-0000000000a2'),
  ('e0760003-0000-4000-8000-000000000003', 'e0760001-0000-4000-8000-0000000000a3');

insert into public.purchases (id, book_id, reader_id, stripe_payment_intent_id, amount_cents, regime) values
  ('e0760004-0000-4000-8000-000000000001', 'e0760001-0000-4000-8000-0000000000a1', 'e0760000-0000-4000-8000-0000000000aa', null, 0, 'legacy_stripe_connect_v1');

insert into public.book_reports (id, book_id, reporter_id, reason, status) values
  ('e0760005-0000-4000-8000-000000000001', 'e0760001-0000-4000-8000-0000000000a1', 'e0760000-0000-4000-8000-0000000000aa', 'Copyright infringement', 'open'),
  ('e0760005-0000-4000-8000-000000000002', 'e0760001-0000-4000-8000-0000000000a1', 'e0760000-0000-4000-8000-0000000000aa', 'Other', 'open'),
  ('e0760005-0000-4000-8000-000000000003', 'e0760001-0000-4000-8000-0000000000a2', 'e0760000-0000-4000-8000-0000000000aa', 'Other', 'open'),
  ('e0760005-0000-4000-8000-000000000004', 'e0760001-0000-4000-8000-0000000000a1', 'e0760000-0000-4000-8000-0000000000aa', 'Other', 'resolved');

-- ============================================================
-- Part 1: privileges.
-- ============================================================
do $$
declare
  c text;
  r text;
begin
  perform pg_temp.assert((select relrowsecurity from pg_class where oid = 'public.book_takedowns'::regclass),
    'part1: RLS is on');
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    perform pg_temp.assert(not has_table_privilege(r, 'public.book_takedowns', 'INSERT')
      and not has_table_privilege(r, 'public.book_takedowns', 'UPDATE')
      and not has_table_privilege(r, 'public.book_takedowns', 'DELETE')
      and not has_table_privilege(r, 'public.book_takedowns', 'TRUNCATE'),
      format('part1: %s cannot insert, update, delete or truncate', r));
  end loop;
  perform pg_temp.assert(not has_table_privilege('anon', 'public.book_takedowns', 'SELECT')
    and not has_any_column_privilege('anon', 'public.book_takedowns', 'SELECT'), 'part1: anon has no SELECT at all');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.book_takedowns', 'SELECT'),
    'part1: authenticated has no table-level SELECT');
  foreach c in array array['book_id', 'book_title', 'author_id', 'reason', 'message_to_author', 'bundle_ids', 'taken_down_at', 'lifted_at'] loop
    perform pg_temp.assert(has_column_privilege('authenticated', 'public.book_takedowns', c, 'SELECT'),
      format('part1: authenticated reads %s', c));
  end loop;
  foreach c in array array['id', 'report_id', 'taken_down_by', 'lifted_by'] loop
    perform pg_temp.assert(not has_column_privilege('authenticated', 'public.book_takedowns', c, 'SELECT'),
      format('part1: authenticated cannot read %s', c));
  end loop;
  perform pg_temp.assert(has_table_privilege('service_role', 'public.book_takedowns', 'SELECT'),
    'part1: service_role reads every column');

  foreach c in array array['public.admin_unpublish_book(uuid,text,text,uuid)', 'public.admin_allow_book_again(uuid)'] loop
    perform pg_temp.assert(has_function_privilege('authenticated', c, 'EXECUTE')
      and not has_function_privilege('anon', c, 'EXECUTE')
      and not has_function_privilege('service_role', c, 'EXECUTE')
      and (select prosecdef from pg_proc where oid = c::regprocedure)
      and (select proconfig from pg_proc where oid = c::regprocedure) = array['search_path=""'],
      format('part1: %s is SECURITY DEFINER, search_path empty, EXECUTE for authenticated only', c));
  end loop;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    perform pg_temp.assert(not has_function_privilege(r, 'public.books_refuse_publish_while_taken_down()', 'EXECUTE'),
      format('part1: %s cannot execute the lock trigger function', r));
  end loop;
  perform pg_temp.assert((select prosecdef from pg_proc where oid = 'public.books_refuse_publish_while_taken_down()'::regprocedure),
    'part1: the lock trigger function is SECURITY DEFINER');
  perform pg_temp.assert((select pg_get_triggerdef(oid) from pg_trigger where tgname = 'books_refuse_publish_while_taken_down')
      like '%BEFORE UPDATE OF status ON public.books%',
    'part1: the lock trigger is BEFORE UPDATE OF status only');
end $$;

-- ============================================================
-- Part 2: who may unpublish.
-- ============================================================
do $$
declare
  v text;
  sql text := $q$select public.admin_unpublish_book('e0760001-0000-4000-8000-0000000000a1', 'copyright', 'Probe')$q$;
begin
  v := pg_temp.run_as('authenticated', 'e0760000-0000-4000-8000-0000000000c4', sql);
  perform pg_temp.assert(v = 'P0001:not authorized', format('part2: support refused -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0760000-0000-4000-8000-0000000000c5', sql);
  perform pg_temp.assert(v = 'P0001:not authorized', format('part2: editor refused -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0760000-0000-4000-8000-0000000000aa', sql);
  perform pg_temp.assert(v = 'P0001:not authorized', format('part2: a reader refused -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0760000-0000-4000-8000-00000000000a', sql);
  perform pg_temp.assert(v = 'P0001:not authorized', format('part2: the author refused -- got %s', v));
  v := pg_temp.run_as('authenticated', null, sql);
  perform pg_temp.assert(v = 'P0001:not authenticated', format('part2: no session refused -- got %s', v));
  v := pg_temp.run_as('anon', null, sql);
  perform pg_temp.assert(v like '42501:%', format('part2: anon cannot execute -- got %s', v));
  v := pg_temp.run_as('service_role', null, sql);
  perform pg_temp.assert(v like '42501:%', format('part2: service_role cannot execute -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0760000-0000-4000-8000-0000000000c4',
    $q$select public.admin_allow_book_again('e0760001-0000-4000-8000-0000000000a1')$q$);
  perform pg_temp.assert(v = 'P0001:not authorized', format('part2: support cannot allow again -- got %s', v));

  perform pg_temp.assert((select status from public.books where id = 'e0760001-0000-4000-8000-0000000000a1') = 'published'
    and not exists (select 1 from public.book_takedowns)
    and not exists (select 1 from public.admin_audit_log where action like 'book.%'),
    'part2: refusals changed nothing');
end $$;

-- ============================================================
-- Part 3: validation (as the moderator).
-- ============================================================
do $$
declare
  m text := 'e0760000-0000-4000-8000-0000000000c3';
  v text;
begin
  v := pg_temp.run_as('authenticated', m,
    $q$select public.admin_unpublish_book('e0760001-0000-4000-8000-0000000000a1', 'spam', 'Probe')$q$);
  perform pg_temp.assert(v = 'P0001:invalid reason', format('part3: unknown reason refused -- got %s', v));
  v := pg_temp.run_as('authenticated', m,
    $q$select public.admin_unpublish_book('e0760001-0000-4000-8000-0000000000a1', 'other', E'  \n\t ')$q$);
  perform pg_temp.assert(v = 'P0001:invalid message', format('part3: blank message refused -- got %s', v));
  v := pg_temp.run_as('authenticated', m,
    $q$select public.admin_unpublish_book('e0760001-0000-4000-8000-0000000000a1', 'other', null)$q$);
  perform pg_temp.assert(v = 'P0001:invalid message', format('part3: null message refused -- got %s', v));
  v := pg_temp.run_as('authenticated', m,
    format($q$select public.admin_unpublish_book('e0760001-0000-4000-8000-0000000000a1', 'other', %L)$q$, repeat('x', 2001)));
  perform pg_temp.assert(v = 'P0001:invalid message', format('part3: 2001 characters refused -- got %s', v));
  v := pg_temp.run_as('authenticated', m,
    $q$select public.admin_unpublish_book('e0760001-0000-4000-8000-0000000000ff', 'other', 'Probe')$q$);
  perform pg_temp.assert(v = 'P0001:no book found for this id', format('part3: missing book refused -- got %s', v));
  v := pg_temp.run_as('authenticated', m,
    $q$select public.admin_unpublish_book('e0760001-0000-4000-8000-0000000000a1', 'other', 'Probe', 'e0760005-0000-4000-8000-000000000003')$q$);
  perform pg_temp.assert(v = 'P0001:no open report for this book', format('part3: a report of another book refused -- got %s', v));
  v := pg_temp.run_as('authenticated', m,
    $q$select public.admin_unpublish_book('e0760001-0000-4000-8000-0000000000a1', 'other', 'Probe', 'e0760005-0000-4000-8000-000000000004')$q$);
  perform pg_temp.assert(v = 'P0001:no open report for this book', format('part3: a resolved report refused -- got %s', v));
  v := pg_temp.run_as('authenticated', m,
    $q$select public.admin_unpublish_book('e0760001-0000-4000-8000-0000000000a1', 'other', 'Probe', 'e0760005-0000-4000-8000-0000000000ff')$q$);
  perform pg_temp.assert(v = 'P0001:no open report for this book', format('part3: a missing report refused -- got %s', v));

  perform pg_temp.assert((select status from public.books where id = 'e0760001-0000-4000-8000-0000000000a1') = 'published'
    and (select status from public.bundles where id = 'e0760003-0000-4000-8000-000000000001') = 'published'
    and not exists (select 1 from public.book_takedowns),
    'part3: refusals changed nothing (the transaction rolled back)');
end $$;

-- ============================================================
-- Part 4: the moderator takes P1 down from rep1.
-- ============================================================
do $$
declare
  m uuid := 'e0760000-0000-4000-8000-0000000000c3';
  p1 uuid := 'e0760001-0000-4000-8000-0000000000a1';
  v text;
  t record;
  a jsonb;
begin
  v := pg_temp.value_as('authenticated', m::text,
    $q$select public.admin_unpublish_book('e0760001-0000-4000-8000-0000000000a1', 'copyright',
         E'  We received a copyright complaint about this book.\n Please reply.  ', 'e0760005-0000-4000-8000-000000000001')::text$q$);
  perform pg_temp.assert(v = (select id::text from public.book_takedowns where book_id = p1),
    format('part4: returns the takedown id -- got %s', v));

  perform pg_temp.assert((select status from public.books where id = p1) = 'draft', 'part4: the book is a draft');
  perform pg_temp.assert((select librum_choice_at from public.books where id = p1) is null, 'part4: Librum''s choice cleared');
  perform pg_temp.assert((select status from public.bundles where id = 'e0760003-0000-4000-8000-000000000001') = 'draft',
    'part4: the published bundle holding it is drafted');
  perform pg_temp.assert((select status from public.bundles where id = 'e0760003-0000-4000-8000-000000000002') = 'draft'
    and (select status from public.bundles where id = 'e0760003-0000-4000-8000-000000000003') = 'published'
    and (select status from public.books where id = 'e0760001-0000-4000-8000-0000000000a2') = 'published',
    'part4: a draft bundle, an unrelated bundle and the other books are untouched');

  select * into t from public.book_takedowns where book_id = p1;
  perform pg_temp.assert(t.book_title = 'P076 One' and t.author_id = 'e0760000-0000-4000-8000-00000000000a'
    and t.reason = 'copyright'
    and t.message_to_author = E'We received a copyright complaint about this book.\n Please reply.'
    and t.report_id = 'e0760005-0000-4000-8000-000000000001'
    and t.bundle_ids = array['e0760003-0000-4000-8000-000000000001']::uuid[]
    and t.taken_down_by = m and t.lifted_at is null and t.lifted_by is null,
    'part4: the takedown row (message trimmed, only the published bundle recorded)');

  perform pg_temp.assert((select status = 'resolved' and reviewed_by = m and reviewed_at is not null
                            and admin_notes = 'Copyright complaint'
                            from public.book_reports where id = 'e0760005-0000-4000-8000-000000000001'),
    'part4: the report is resolved with the reason label as notes');
  perform pg_temp.assert((select status from public.book_reports where id = 'e0760005-0000-4000-8000-000000000002') = 'open'
    and (select status from public.book_reports where id = 'e0760005-0000-4000-8000-000000000003') = 'open',
    'part4: other open reports stay open');

  select metadata into a from public.admin_audit_log
   where action = 'report.resolved' and target_id = 'e0760005-0000-4000-8000-000000000001' and actor_id = m;
  perform pg_temp.assert(a = '{"old_status":"open","new_status":"resolved","notes_added":true}'::jsonb
    and (select target_type from public.admin_audit_log where action = 'report.resolved' and actor_id = m) = 'book_reports',
    format('part4: report.resolved audit row as review_book_report writes it -- got %s', a));
  select metadata into a from public.admin_audit_log
   where action = 'book.unpublished' and target_type = 'books' and target_id = p1 and actor_id = m;
  perform pg_temp.assert(a = jsonb_build_object('reason', 'copyright', 'report_id', 'e0760005-0000-4000-8000-000000000001',
                                                'bundles_unpublished', 1, 'librum_choice_cleared', true),
    format('part4: book.unpublished audit metadata -- got %s', a));
  perform pg_temp.assert(not exists (select 1 from public.admin_audit_log
                                      where metadata::text ilike '%copyright complaint about%'),
    'part4: no audit row carries the message text');

  v := pg_temp.run_as('authenticated', m::text,
    $q$select public.admin_unpublish_book('e0760001-0000-4000-8000-0000000000a1', 'other', 'Again')$q$);
  perform pg_temp.assert(v = 'P0001:this book is already taken down', format('part4: a second takedown is refused -- got %s', v));
end $$;

-- ============================================================
-- Part 5: the lock.
-- ============================================================
do $$
declare
  v text;
begin
  v := pg_temp.run_as('service_role', null,
    $q$update public.books set status = 'published' where id = 'e0760001-0000-4000-8000-0000000000a1'$q$);
  perform pg_temp.assert(v like 'LB460:Librum took this book down.%', format('part5: service_role publish refused by the trigger -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0760000-0000-4000-8000-00000000000a',
    $q$update public.books set status = 'published' where id = 'e0760001-0000-4000-8000-0000000000a1'$q$);
  perform pg_temp.assert(v like '42501:%', format('part5: the author session has no status write at all -- got %s', v));
  begin
    update public.books set status = 'published' where id = 'e0760001-0000-4000-8000-0000000000a1';
    perform pg_temp.assert(false, 'part5: the table owner was not refused');
  exception when sqlstate 'LB460' then
    perform pg_temp.assert(true, 'part5: the table owner is refused too');
  end;
  v := pg_temp.run_as('service_role', null,
    $q$update public.books set status = 'draft', title = 'P076 One' where id = 'e0760001-0000-4000-8000-0000000000a1'$q$);
  perform pg_temp.assert(v = 'OK:1', format('part5: a draft write and other columns still work -- got %s', v));
  v := pg_temp.run_as('service_role', null,
    $q$update public.books set status = 'published' where id = 'e0760001-0000-4000-8000-0000000000a2'$q$);
  perform pg_temp.assert(v = 'OK:1', format('part5: another book is unaffected -- got %s', v));
end $$;

-- ============================================================
-- Part 6: who reads takedowns.
-- ============================================================
do $$
declare
  v text;
  cols text := 'book_id, book_title, author_id, reason, message_to_author, bundle_ids, taken_down_at, lifted_at';
begin
  v := pg_temp.value_as('authenticated', 'e0760000-0000-4000-8000-00000000000a',
    format($q$select string_agg(book_title || ':' || reason || ':' || cardinality(bundle_ids), ',') from (select %s from public.book_takedowns) t$q$, cols));
  perform pg_temp.assert(v = 'P076 One:copyright:1', format('part6: the author reads their own takedown -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0760000-0000-4000-8000-00000000000a', 'select * from public.book_takedowns');
  perform pg_temp.assert(v like '42501:%', format('part6: select * by an author session is 42501 -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0760000-0000-4000-8000-00000000000a', 'select id from public.book_takedowns');
  perform pg_temp.assert(v like '42501:%', format('part6: select id by an author session is 42501 -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0760000-0000-4000-8000-00000000000a', 'select taken_down_by from public.book_takedowns');
  perform pg_temp.assert(v like '42501:%', format('part6: staff ids are not readable by an author session -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0760000-0000-4000-8000-00000000000b',
    format('select count(*)::text from (select %s from public.book_takedowns) t', cols));
  perform pg_temp.assert(v = '0', format('part6: another author reads none -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0760000-0000-4000-8000-0000000000aa',
    format('select count(*)::text from (select %s from public.book_takedowns) t', cols));
  perform pg_temp.assert(v = '0', format('part6: a buyer of the book reads none -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0760000-0000-4000-8000-0000000000c4',
    format('select count(*)::text from (select %s from public.book_takedowns) t', cols));
  perform pg_temp.assert(v = '0', format('part6: support (no reports.view) reads none -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0760000-0000-4000-8000-0000000000c3',
    format('select count(*)::text from (select %s from public.book_takedowns) t', cols));
  perform pg_temp.assert(v = '1', format('part6: the moderator (reports.view) reads it -- got %s', v));
  v := pg_temp.run_as('anon', null, 'select book_title from public.book_takedowns');
  perform pg_temp.assert(v like '42501:%', format('part6: anon read is 42501 -- got %s', v));
  v := pg_temp.value_as('service_role', null, 'select count(*)::text from public.book_takedowns');
  perform pg_temp.assert(v = '1', format('part6: service_role reads every row -- got %s', v));

  -- 3a: the buyer still reads the (now draft) book itself, through
  -- public_books (PEN-NAMES-2: readers read the catalogue through the
  -- account-free views; the base table shows authors their own rows).
  v := pg_temp.value_as('authenticated', 'e0760000-0000-4000-8000-0000000000aa',
    $q$select title from public.public_books where id = 'e0760001-0000-4000-8000-0000000000a1'$q$);
  perform pg_temp.assert(v = 'P076 One', format('part6: the buyer keeps the book -- got %s', v));
  v := pg_temp.value_as('anon', null,
    $q$select count(*)::text from public.public_books where id = 'e0760001-0000-4000-8000-0000000000a1'$q$);
  perform pg_temp.assert(v = '0', format('part6: the book left the public catalogue -- got %s', v));
end $$;

-- ============================================================
-- Part 7: nobody writes takedowns directly.
-- ============================================================
do $$
declare
  v text;
  r text;
begin
  foreach r in array array['authenticated', 'service_role'] loop
    v := pg_temp.run_as(r, 'e0760000-0000-4000-8000-0000000000c3',
      $q$insert into public.book_takedowns (book_id, book_title, author_id, reason, message_to_author)
         values ('e0760001-0000-4000-8000-0000000000b1', 'x', 'e0760000-0000-4000-8000-00000000000b', 'other', 'x')$q$);
    perform pg_temp.assert(v like '42501:%', format('part7: %s cannot insert -- got %s', r, v));
    v := pg_temp.run_as(r, 'e0760000-0000-4000-8000-00000000000a',
      $q$update public.book_takedowns set lifted_at = now()$q$);
    perform pg_temp.assert(v like '42501:%', format('part7: %s cannot update -- got %s', r, v));
    v := pg_temp.run_as(r, 'e0760000-0000-4000-8000-00000000000a', $q$delete from public.book_takedowns$q$);
    perform pg_temp.assert(v like '42501:%', format('part7: %s cannot delete -- got %s', r, v));
  end loop;
end $$;

-- ============================================================
-- Part 8: the audit list knows the new events.
-- ============================================================
do $$
declare
  v text;
begin
  v := pg_temp.value_as('authenticated', 'e0760000-0000-4000-8000-0000000000c1',
    $q$select count(*)::text from public.list_admin_audit_events(p_action => 'book.unpublished')$q$);
  perform pg_temp.assert(v = '1', format('part8: filter by book.unpublished -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0760000-0000-4000-8000-0000000000c1',
    $q$select count(*)::text from public.list_admin_audit_events(p_target_type => 'books')$q$);
  perform pg_temp.assert(v = '1', format('part8: filter by target type books -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0760000-0000-4000-8000-0000000000c1',
    $q$select count(*)::text from public.list_admin_audit_events(p_action => 'book.allowed_again')$q$);
  perform pg_temp.assert(v = '0', format('part8: book.allowed_again is an accepted filter -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0760000-0000-4000-8000-0000000000c1',
    $q$select count(*)::text from public.list_admin_audit_events(p_action => 'pen_name.links_removed')$q$);
  perform pg_temp.assert(v = '0', format('part8: PEN-NAMES-1''s filter still accepted -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0760000-0000-4000-8000-0000000000c1',
    $q$select count(*)::text from public.list_admin_audit_events(p_action => 'book.deleted')$q$);
  perform pg_temp.assert(v = 'P0001:invalid action filter', format('part8: an unknown action is still refused -- got %s', v));
end $$;

-- ============================================================
-- Part 9: allow again.
-- ============================================================
do $$
declare
  m uuid := 'e0760000-0000-4000-8000-0000000000c3';
  v text;
begin
  v := pg_temp.run_as('authenticated', m::text,
    $q$select public.admin_allow_book_again('e0760001-0000-4000-8000-0000000000a1')$q$);
  perform pg_temp.assert(v = 'OK:1', format('part9: the moderator allows it again -- got %s', v));
  perform pg_temp.assert((select lifted_at is not null and lifted_by = m from public.book_takedowns
                           where book_id = 'e0760001-0000-4000-8000-0000000000a1'),
    'part9: the takedown is lifted, by whom');
  perform pg_temp.assert((select status from public.books where id = 'e0760001-0000-4000-8000-0000000000a1') = 'draft'
    and (select status from public.bundles where id = 'e0760003-0000-4000-8000-000000000001') = 'draft',
    'part9: the book and its bundle stay drafts');
  perform pg_temp.assert((select metadata = '{}'::jsonb from public.admin_audit_log
                           where action = 'book.allowed_again' and target_type = 'books'
                             and target_id = 'e0760001-0000-4000-8000-0000000000a1' and actor_id = m),
    'part9: book.allowed_again audit row');
  v := pg_temp.run_as('authenticated', m::text,
    $q$select public.admin_allow_book_again('e0760001-0000-4000-8000-0000000000a1')$q$);
  perform pg_temp.assert(v = 'P0001:this book is not taken down', format('part9: nothing active to lift -- got %s', v));

  v := pg_temp.run_as('service_role', null,
    $q$update public.books set status = 'published' where id = 'e0760001-0000-4000-8000-0000000000a1'$q$);
  perform pg_temp.assert(v = 'OK:1', format('part9: the author''s publish works again -- got %s', v));
  perform pg_temp.assert((select count(*) from public.book_takedowns where book_id = 'e0760001-0000-4000-8000-0000000000a1') = 1,
    'part9: the history row is kept');
  v := pg_temp.value_as('authenticated', 'e0760000-0000-4000-8000-00000000000a',
    $q$select count(*)::text from (select lifted_at from public.book_takedowns where lifted_at is not null) t$q$);
  perform pg_temp.assert(v = '1', format('part9: the author still reads the past takedown -- got %s', v));
end $$;

-- ============================================================
-- Part 10: owner and admin may unpublish; a draft may be taken down;
-- a book may be taken down again after a lift.
-- ============================================================
do $$
declare
  v text;
begin
  v := pg_temp.run_as('authenticated', 'e0760000-0000-4000-8000-0000000000c1',
    $q$select public.admin_unpublish_book('e0760001-0000-4000-8000-0000000000a4', 'broken_file', 'The file is broken.')$q$);
  perform pg_temp.assert(v = 'OK:1', format('part10: the owner takes a draft down -- got %s', v));
  perform pg_temp.assert((select bundle_ids = '{}'::uuid[] and report_id is null from public.book_takedowns
                           where book_id = 'e0760001-0000-4000-8000-0000000000a4'),
    'part10: no bundles, no report recorded');
  perform pg_temp.assert((select metadata = jsonb_build_object('reason', 'broken_file', 'report_id', null,
                                   'bundles_unpublished', 0, 'librum_choice_cleared', false)
                            from public.admin_audit_log where action = 'book.unpublished'
                             and target_id = 'e0760001-0000-4000-8000-0000000000a4'),
    'part10: audit metadata for a draft without a report');
  v := pg_temp.run_as('service_role', null,
    $q$update public.books set status = 'published' where id = 'e0760001-0000-4000-8000-0000000000a4'$q$);
  perform pg_temp.assert(v like 'LB460:%', format('part10: the taken-down draft is locked -- got %s', v));

  v := pg_temp.run_as('authenticated', 'e0760000-0000-4000-8000-0000000000c2',
    $q$select public.admin_unpublish_book('e0760001-0000-4000-8000-0000000000a1', 'author_asked', 'At your request.')$q$);
  perform pg_temp.assert(v = 'OK:1', format('part10: the admin takes P1 down again after the lift -- got %s', v));
  perform pg_temp.assert((select count(*) from public.book_takedowns where book_id = 'e0760001-0000-4000-8000-0000000000a1') = 2
    and (select count(*) from public.book_takedowns where book_id = 'e0760001-0000-4000-8000-0000000000a1' and lifted_at is null) = 1,
    'part10: one active row and one past row');
  v := pg_temp.run_as('authenticated', 'e0760000-0000-4000-8000-0000000000c2',
    format($q$select public.admin_unpublish_book('e0760001-0000-4000-8000-0000000000a3', 'other', %L)$q$, repeat('y', 2000)));
  perform pg_temp.assert(v = 'OK:1', format('part10: a 2000-character message is accepted -- got %s', v));
  perform pg_temp.assert((select status from public.bundles where id = 'e0760003-0000-4000-8000-000000000003') = 'draft'
    and (select bundle_ids from public.book_takedowns where book_id = 'e0760001-0000-4000-8000-0000000000a3' and lifted_at is null)
        = array['e0760003-0000-4000-8000-000000000003']::uuid[],
    'part10: P3''s published bundle U3 is drafted and recorded');
end $$;

-- ============================================================
-- Part 11: no DIRECT delete of a taken-down book (audit A1 = a).
-- P076 Draft (a4) is taken down (part 10). The author (data API),
-- service_role and the table owner are all refused with LB461; after
-- "allow again" the author's delete goes through and the history row
-- stays (book_id null, title kept).
-- ============================================================
do $$
declare
  a4 constant text := 'e0760001-0000-4000-8000-0000000000a4';
  v text;
begin
  delete from public.book_reports where book_id = a4::uuid;
  delete from public.bundle_books where book_id = a4::uuid;

  -- The trigger itself, so a dropped, disabled or weakened trigger is a
  -- failure here and not only in the behaviour checks below.
  perform pg_temp.assert(exists (
      select 1 from pg_catalog.pg_trigger tg
       where tg.tgrelid = 'public.books'::regclass
         and tg.tgname = 'books_refuse_delete_while_taken_down'
         and not tg.tgisinternal
         and tg.tgenabled = 'O'
         and tg.tgfoid = 'public.books_refuse_delete_while_taken_down()'::regprocedure
         and (tg.tgtype::int & 1) = 1     -- FOR EACH ROW
         and (tg.tgtype::int & 2) = 2     -- BEFORE
         and (tg.tgtype::int & 8) = 8     -- DELETE
         and (tg.tgtype::int & 20) = 0),  -- not INSERT/UPDATE
    'part11: the BEFORE DELETE row trigger is on books');
  perform pg_temp.assert((select p.prosecdef and p.proconfig = array['search_path=""']
                            from pg_catalog.pg_proc p
                           where p.oid = 'public.books_refuse_delete_while_taken_down()'::regprocedure),
    'part11: the delete-lock function is SECURITY DEFINER with an empty search_path');
  perform pg_temp.assert(not has_function_privilege('anon', 'public.books_refuse_delete_while_taken_down()', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.books_refuse_delete_while_taken_down()', 'EXECUTE')
    and not has_function_privilege('service_role', 'public.books_refuse_delete_while_taken_down()', 'EXECUTE'),
    'part11: nobody may EXECUTE the delete-lock function directly');

  v := pg_temp.run_as('authenticated', 'e0760000-0000-4000-8000-00000000000a',
    format('delete from public.books where id = %L', a4));
  perform pg_temp.assert(v like 'LB461:%', format('part11: the author''s direct delete is refused -- got %s', v));
  v := pg_temp.run_as('service_role', null, format('delete from public.books where id = %L', a4));
  perform pg_temp.assert(v like 'LB461:%', format('part11: service_role''s direct delete is refused -- got %s', v));
  v := pg_temp.run_as(current_user, null, format('delete from public.books where id = %L', a4));
  perform pg_temp.assert(v like 'LB461:%', format('part11: the table owner''s direct delete is refused -- got %s', v));
  perform pg_temp.assert((select count(*) from public.books where id = a4::uuid) = 1, 'part11: the book is still there');

  -- Another author's delete of an untaken-down book is unaffected: RLS
  -- simply shows them nothing to delete.
  v := pg_temp.run_as('authenticated', 'e0760000-0000-4000-8000-00000000000b', format('delete from public.books where id = %L', a4));
  perform pg_temp.assert(v = 'OK:0', format('part11: another author deletes nothing -- got %s', v));

  v := pg_temp.run_as('authenticated', 'e0760000-0000-4000-8000-0000000000c3',
    format('select public.admin_allow_book_again(%L)', a4));
  perform pg_temp.assert(v = 'OK:1', format('part11: the moderator allows it again -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0760000-0000-4000-8000-00000000000a',
    format('delete from public.books where id = %L', a4));
  perform pg_temp.assert(v = 'OK:1', format('part11: after the lift the author deletes it -- got %s', v));
  perform pg_temp.assert((select count(*) from public.book_takedowns
                           where book_id is null and book_title = 'P076 Draft' and reason = 'broken_file') = 1,
    'part11: deleting the book keeps the takedown (book_id null, title kept)');
end $$;

-- ============================================================
-- Part 12: the history outlives the account, and deleting an account
-- is never blocked by an ACTIVE takedown (a cascade, not a direct
-- delete: pg_trigger_depth() is 2 there).
--   * profiles -> books (B, whose book Q is taken down first)
--   * auth.users -> profiles -> books (A, with P1 and P3 taken down)
-- ============================================================
do $$
declare
  v text;
begin
  v := pg_temp.run_as('authenticated', 'e0760000-0000-4000-8000-0000000000c3',
    $q$select public.admin_unpublish_book('e0760001-0000-4000-8000-0000000000b1', 'other', 'Probe.')$q$);
  perform pg_temp.assert(v = 'OK:1', format('part12: Q is taken down -- got %s', v));
  v := pg_temp.run_as('service_role', null, $q$delete from public.books where id = 'e0760001-0000-4000-8000-0000000000b1'$q$);
  perform pg_temp.assert(v like 'LB461:%', format('part12: Q itself cannot be deleted directly -- got %s', v));

  delete from public.profiles where id = 'e0760000-0000-4000-8000-00000000000b';
  perform pg_temp.assert((select count(*) from public.books where id = 'e0760001-0000-4000-8000-0000000000b1') = 0,
    'part12: deleting the profile cascades through the active takedown');
  perform pg_temp.assert((select count(*) from public.book_takedowns
                           where book_title = 'P076 Ben' and book_id is null and author_id is null and lifted_at is null) = 1,
    'part12: the takedown row survives the profile cascade');

  perform pg_temp.assert((select count(*) from public.book_takedowns
                           where author_id = 'e0760000-0000-4000-8000-00000000000a' and lifted_at is null) >= 2,
    'part12: A still has active takedowns before the account deletion');
  delete from public.purchases where book_id in (select id from public.books where author_id = 'e0760000-0000-4000-8000-00000000000a');
  delete from auth.users where id = 'e0760000-0000-4000-8000-00000000000a';
  perform pg_temp.assert((select count(*) from public.books where author_id = 'e0760000-0000-4000-8000-00000000000a') = 0,
    'part12: deleting the account removed every book of it');
  perform pg_temp.assert((select count(*) from public.book_takedowns
                           where author_id is null and book_id is null
                             and book_title in ('P076 One', 'P076 Three', 'P076 Draft')) = 4,
    'part12: deleting the account with active takedowns works and keeps every row');
end $$;

do $$
begin
  perform pg_temp.assert((select n from pg_temp.assertions_run) >= 70,
    format('expected at least 70 assertions, ran %s', (select n from pg_temp.assertions_run)));
end $$;

select 'ALL PASSED: 076_book_takedowns.test.sql (' || (select n from pg_temp.assertions_run) || ' assertions)' as result;

rollback;
