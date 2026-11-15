-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for the download count and the
-- feedback button (migration 20261115200000_download_count_feedback.sql).
--   Part 1  shape: the table, RLS with no policy, no table grant to
--           anyone; function grants (anon only for the count).
--   Part 2  book_download_count: one per active purchase of a published
--           book; refunds, lost disputes, drafts and pre-orders give no
--           number; anon may call it.
--   Part 3  submit_reader_feedback: own account only, the checks
--           (LB510-LB514), trimmed text, the hourly limit.
--   Part 4  staff_list_reader_feedback / staff_set_reader_feedback_done:
--           permissions, filters, the email only with people.view,
--           done/open again; delete with
--           the account.
--
-- Reproduce against a disposable PostgreSQL 17 instance:
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/100_download_count_feedback.test.sql
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

-- As a signed-in reader (role authenticated, auth.uid() = p_uid).
create function pg_temp.run_as_user(p_uid text, p_sql text) returns text
  language plpgsql as $$
declare
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', p_uid, true);
  v_out := pg_temp.run_as('authenticated', p_sql);
  perform set_config('request.jwt.claim.sub', '', true);
  return v_out;
end;
$$;

-- ============================================================
-- Fixture: author A with live books K and L; reader R owns K and L;
-- reader S owns K; reader T owns nothing.
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e1000000-0000-4000-8000-00000000000a', 'p100-a@test', now(), '{"role":"author","display_name":"P100 Ana"}'),
  ('e1000000-0000-4000-8000-0000000000d1', 'p100-r@test', now(), '{"role":"reader","display_name":"P100 R"}'),
  ('e1000000-0000-4000-8000-0000000000d2', 'p100-s@test', now(), '{"role":"reader","display_name":"P100 S"}'),
  ('e1000000-0000-4000-8000-0000000000d3', 'p100-t@test', now(), '{"role":"reader","display_name":"P100 T"}'),
  ('e1000000-0000-4000-8000-0000000000d4', 'p100-u@test', now(), '{"role":"reader","display_name":"P100 U"}'),
  ('e1000000-0000-4000-8000-0000000000e1', 'p100-mod@test', now(), '{"role":"reader","display_name":"P100 Mod"}'),
  ('e1000000-0000-4000-8000-0000000000e2', 'p100-sup@test', now(), '{"role":"reader","display_name":"P100 Sup"}');

insert into public.staff_members (user_id, role) values
  ('e1000000-0000-4000-8000-0000000000e1', 'moderator'),
  ('e1000000-0000-4000-8000-0000000000e2', 'support');

insert into public.books (id, author_id, title, description, price_all, status, published_at, file_path, cover_path, categories)
values
  ('e1000001-0000-4000-8000-00000000000b', 'e1000000-0000-4000-8000-00000000000a', 'P100 K', 'K.', 199, 'published', now(),
   'a/k/v1.epub', 'e100000c-0000-4000-8000-00000000000b/cover.jpg', array['Horror']),
  ('e1000001-0000-4000-8000-00000000000c', 'e1000000-0000-4000-8000-00000000000a', 'P100 L', 'L.', 199, 'published', now(),
   'a/l/v1.epub', 'e100000c-0000-4000-8000-00000000000c/cover.jpg', array['Horror']);

insert into public.purchases (book_id, reader_id, amount_cents, stripe_checkout_session_id, stripe_payment_intent_id) values
  ('e1000001-0000-4000-8000-00000000000b', 'e1000000-0000-4000-8000-0000000000d1', 19900, 'cs_p100_1', 'pi_p100_1'),
  ('e1000001-0000-4000-8000-00000000000b', 'e1000000-0000-4000-8000-0000000000d2', 19900, 'cs_p100_2', 'pi_p100_2'),
  ('e1000001-0000-4000-8000-00000000000b', 'e1000000-0000-4000-8000-0000000000d3', 19900, 'cs_p100_3', 'pi_p100_3'),
  ('e1000001-0000-4000-8000-00000000000b', 'e1000000-0000-4000-8000-0000000000d4', 19900, 'cs_p100_4', 'pi_p100_4'),
  ('e1000001-0000-4000-8000-00000000000c', 'e1000000-0000-4000-8000-0000000000d1', 19900, 'cs_p100_5', 'pi_p100_5');

-- ============================================================
-- Part 1: shape and grants
-- ============================================================
select pg_temp.assert(
  (select string_agg(a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text, ',' order by a.attnum)
     from pg_attribute a where a.attrelid = 'public.reader_feedback'::regclass and a.attnum > 0 and not a.attisdropped)
  = 'id:uuid:true,reader_id:uuid:true,kind:text:true,body:text:true,page_path:text:true,created_at:timestamp with time zone:true,done_at:timestamp with time zone:false,done_by:uuid:false',
  'part1: reader_feedback columns');
select pg_temp.assert(
  (select c.relrowsecurity from pg_class c where c.oid = 'public.reader_feedback'::regclass)
  and not exists (select 1 from pg_policy p where p.polrelid = 'public.reader_feedback'::regclass),
  'part1: RLS on, no policy');
select pg_temp.assert(
  (select c.confdeltype from pg_constraint c
    where c.conrelid = 'public.reader_feedback'::regclass and c.contype = 'f'
      and c.conkey = array[(select attnum from pg_attribute where attrelid = 'public.reader_feedback'::regclass and attname = 'reader_id')]) = 'c',
  'part1: reader_id cascades with the account');
select pg_temp.assert(
  not exists (select 1 from information_schema.role_table_grants g
               where g.table_schema = 'public' and g.table_name = 'reader_feedback'
                 and g.grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role'))
  and pg_temp.run_as('anon', $q$select 1 from public.reader_feedback$q$) like '42501:%'
  and pg_temp.run_as('authenticated', $q$select 1 from public.reader_feedback$q$) like '42501:%'
  and pg_temp.run_as('service_role', $q$select 1 from public.reader_feedback$q$) like '42501:%',
  'part1: no table grant to anyone');
select pg_temp.assert(
  has_function_privilege('anon', 'public.book_download_count(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.book_download_count(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.submit_reader_feedback(text,text,text)', 'execute')
  and has_function_privilege('authenticated', 'public.submit_reader_feedback(text,text,text)', 'execute')
  and not has_function_privilege('anon', 'public.staff_list_reader_feedback(text)', 'execute')
  and not has_function_privilege('anon', 'public.staff_set_reader_feedback_done(uuid,boolean)', 'execute')
  and not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) x
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('book_download_count', 'submit_reader_feedback', 'staff_list_reader_feedback', 'staff_set_reader_feedback_done')
       and (x.grantee = 0 or x.grantee = 'service_role'::regrole)),
  'part1: function grants (no PUBLIC, no service_role)');
select pg_temp.assert(
  (select pg_catalog.count(*) from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('book_download_count', 'submit_reader_feedback', 'staff_list_reader_feedback', 'staff_set_reader_feedback_done')
      and p.prosecdef and p.proconfig = array['search_path=""']) = 4,
  'part1: all four are SECURITY DEFINER with an empty search_path');
-- Staging run 15 Nov: a backslash-u escape in a body sent through the
-- database tool arrives as the character itself. The four bodies stay
-- plain ASCII (one byte per character), so what is sent is what is stored.
select pg_temp.assert(
  (select pg_catalog.count(*) from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('book_download_count', 'submit_reader_feedback', 'staff_list_reader_feedback', 'staff_set_reader_feedback_done')
      and pg_catalog.octet_length(p.prosrc) = pg_catalog.char_length(p.prosrc)
      and pg_catalog.strpos(p.prosrc, chr(92) || 'u') = 0) = 4,
  'part1: all four bodies are plain ASCII with no backslash-u escape');

-- ============================================================
-- Part 2: the download count
-- ============================================================
select pg_temp.assert(public.book_download_count('e1000001-0000-4000-8000-00000000000b') = 4, 'part2: 4 buyers');
select pg_temp.assert(public.book_download_count('e1000001-0000-4000-8000-00000000000c') = 1, 'part2: 1 buyer');
select pg_temp.assert(public.book_download_count('e1000001-0000-4000-8000-0000000000ff') = 0, 'part2: unknown book is 0');
select pg_temp.assert(public.book_download_count(null) = 0, 'part2: null is 0');
select pg_temp.assert(
  pg_temp.run_as('anon', $q$select public.book_download_count('e1000001-0000-4000-8000-00000000000b')$q$) = 'OK:1',
  'part2: anon may call it');

update public.purchases set refunded_at = now() where stripe_payment_intent_id = 'pi_p100_4';
select pg_temp.assert(public.book_download_count('e1000001-0000-4000-8000-00000000000b') = 3, 'part2: a refund does not count');

insert into public.payment_disputes (stripe_dispute_id, stripe_payment_intent_id, status, reason, amount_cents)
values ('dp_p100_3', 'pi_p100_3', 'lost', 'fraudulent', 19900);
select pg_temp.assert(public.book_download_count('e1000001-0000-4000-8000-00000000000b') = 2, 'part2: a lost dispute does not count');

update public.books set status = 'draft' where id = 'e1000001-0000-4000-8000-00000000000c';
select pg_temp.assert(public.book_download_count('e1000001-0000-4000-8000-00000000000c') = 0, 'part2: a draft gives 0');

-- ============================================================
-- Part 3: sending
-- ============================================================
select pg_temp.assert(
  pg_temp.run_as('anon', $q$select public.submit_reader_feedback('idea', 'x', '/')$q$) like '42501:%',
  'part3: anon cannot send');
select pg_temp.assert(
  pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000d1',
    $q$select public.submit_reader_feedback('problem', E'  Butoni nuk punon.\n ', '/libra/x')$q$) = 'OK:1',
  'part3: a reader sends a problem');
select pg_temp.assert(
  (select f.body = 'Butoni nuk punon.' and f.kind = 'problem' and f.page_path = '/libra/x'
          and f.reader_id = 'e1000000-0000-4000-8000-0000000000d1' and f.done_at is null
     from public.reader_feedback f),
  'part3: stored trimmed, for the caller');
select pg_temp.assert(
  pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000d1', $q$select public.submit_reader_feedback('bug', 'x', '/')$q$) like 'LB511:%'
  and pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000d1', $q$select public.submit_reader_feedback(null, 'x', '/')$q$) like 'LB511:%',
  'part3: kind must be problem or idea');
select pg_temp.assert(
  pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000d1', $q$select public.submit_reader_feedback('idea', '   ', '/')$q$) like 'LB512:%'
  and pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000d1', $q$select public.submit_reader_feedback('idea', null, '/')$q$) like 'LB512:%'
  and pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000d1', format($q$select public.submit_reader_feedback('idea', %L, '/')$q$, repeat('a', 1001))) like 'LB512:%'
  and pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000d1', format($q$select public.submit_reader_feedback('idea', %L, '/')$q$, repeat('a', 1000))) = 'OK:1',
  'part3: text 1-1000 characters');
select pg_temp.assert(
  pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000d1', $q$select public.submit_reader_feedback('idea', 'x', 'https://evil.test/')$q$) like 'LB513:%'
  and pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000d1', $q$select public.submit_reader_feedback('idea', 'x', '//evil.test')$q$) like 'LB513:%'
  and pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000d1', $q$select public.submit_reader_feedback('idea', 'x', null)$q$) like 'LB513:%'
  -- Audit r1 F1: a browser reads these as https://evil.example/.
  and pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000d1', $q$select public.submit_reader_feedback('idea', 'x', E'/\\evil.example')$q$) like 'LB513:%'
  and pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000d1', $q$select public.submit_reader_feedback('idea', 'x', E'/\t/evil.example')$q$) like 'LB513:%'
  and pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000d1', $q$select public.submit_reader_feedback('idea', 'x', E'/a\nb')$q$) like 'LB513:%'
  and pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000d1', format($q$select public.submit_reader_feedback('idea', 'x', %L)$q$, '/' || repeat('a', 300))) like 'LB513:%',
  'part3: the page must be a site path');
select pg_temp.assert(
  pg_temp.run_as('postgres', $q$insert into public.reader_feedback (reader_id, kind, body, page_path)
     values ('e1000000-0000-4000-8000-0000000000d1', 'idea', 'x', E'/\\evil.example')$q$) like '23514:%'
  and pg_temp.run_as('postgres', $q$insert into public.reader_feedback (reader_id, kind, body, page_path)
     values ('e1000000-0000-4000-8000-0000000000d1', 'idea', 'x', E'/\t/evil.example')$q$) like '23514:%',
  'part3: the table check refuses a backslash or a control character too');
-- Audit r1 F3: only invisible characters is an empty message.
select pg_temp.assert(
  pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000d1', $q$select public.submit_reader_feedback('idea', E'\u00a0\u00a0', '/')$q$) like 'LB512:%'
  and pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000d1', $q$select public.submit_reader_feedback('idea', E'\u200b\ufeff \u2060', '/')$q$) like 'LB512:%',
  'part3: no-break and zero-width spaces alone are empty');

-- d1 has sent 2; 8 more pass, the 11th in the hour is refused.
select pg_temp.assert(
  (select bool_and(pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000d1',
     $q$select public.submit_reader_feedback('idea', 'y', '/')$q$) = 'OK:1') from generate_series(1, 8)),
  'part3: up to 10 in an hour');
select pg_temp.assert(
  pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000d1', $q$select public.submit_reader_feedback('idea', 'z', '/')$q$) like 'LB514:%',
  'part3: the 11th in the hour is refused');
update public.reader_feedback set created_at = now() - interval '61 minutes' where reader_id = 'e1000000-0000-4000-8000-0000000000d1';
select pg_temp.assert(
  pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000d1', $q$select public.submit_reader_feedback('idea', 'later', '/')$q$) = 'OK:1',
  'part3: the limit is per hour');

insert into public.account_suspensions (user_id, reason) values ('e1000000-0000-4000-8000-0000000000d2', 'P100 test');
select pg_temp.assert(
  pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000d2', $q$select public.submit_reader_feedback('idea', 'x', '/')$q$) like 'LB510:%',
  'part3: a suspended account cannot send');

select pg_temp.assert(
  pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000d3', $q$select public.submit_reader_feedback('idea', 'Modalitet i errët.', '/librari')$q$) = 'OK:1',
  'part3: another reader sends an idea');

-- ============================================================
-- Part 4: the admin side
-- ============================================================
select pg_temp.assert(
  pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000d1', $q$select * from public.staff_list_reader_feedback('all')$q$) like '%not authorized%'
  and pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000e2', $q$select * from public.staff_list_reader_feedback('all')$q$) like '%not authorized%',
  'part4: a reader and support cannot list');
select pg_temp.assert(
  pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000e1', $q$select * from public.staff_list_reader_feedback('open')$q$) = 'OK:12',
  'part4: a moderator lists the 12 open messages');
select pg_temp.assert(
  pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000e1', $q$select * from public.staff_list_reader_feedback('nope')$q$) like '%invalid status%',
  'part4: bad status refused');

-- One transaction has one now(): move the newest a second ahead.
update public.reader_feedback set created_at = now() + interval '1 second' where body = 'Modalitet i errët.';
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-0000000000e1', true);
set local role authenticated;
create temp table p100_rows as select * from public.staff_list_reader_feedback('open');
reset role;
select set_config('request.jwt.claim.sub', '', true);
-- Audit r1 F2 (mod a): a moderator gets no email.
select pg_temp.assert(
  (select pg_catalog.count(*) from p100_rows where sender_email is not null) = 0,
  'part4: a moderator sees no reader email');
insert into public.staff_members (user_id, role) values ('e1000000-0000-4000-8000-0000000000d4', 'admin');
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-0000000000d4', true);
set local role authenticated;
create temp table p100_admin_rows as select * from public.staff_list_reader_feedback('open');
reset role;
select set_config('request.jwt.claim.sub', '', true);
select pg_temp.assert(
  (select sender_email from p100_admin_rows where body = 'Modalitet i errët.') = 'p100-t@test'
  and (select body from p100_admin_rows order by created_at desc, id limit 1) = 'Modalitet i errët.',
  'part4: an admin sees newest first, with the sender email');

select pg_temp.assert(
  pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000e2',
    format($q$select public.staff_set_reader_feedback_done(%L, true)$q$, (select id from p100_rows where body = 'Modalitet i errët.'))) like '%not authorized%',
  'part4: support cannot mark done');
select pg_temp.assert(
  pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000e1',
    format($q$select public.staff_set_reader_feedback_done(%L, true)$q$, (select id from p100_rows where body = 'Modalitet i errët.'))) = 'OK:1',
  'part4: a moderator marks one done');
-- (a separate statement: one statement's snapshot does not see its own call's update)
select pg_temp.assert(
  (select done_at is not null and done_by = 'e1000000-0000-4000-8000-0000000000e1'
     from public.reader_feedback where body = 'Modalitet i errët.'),
  'part4: done_at and done_by recorded');
select pg_temp.assert(
  pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000e1', $q$select * from public.staff_list_reader_feedback('open')$q$) = 'OK:11'
  and pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000e1', $q$select * from public.staff_list_reader_feedback('done')$q$) = 'OK:1'
  and pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000e1', $q$select * from public.staff_list_reader_feedback('all')$q$) = 'OK:12',
  'part4: open / done / all filters');
select pg_temp.assert(
  pg_temp.run_as_user('e1000000-0000-4000-8000-0000000000e1',
    format($q$select public.staff_set_reader_feedback_done(%L, false)$q$, (select id from p100_rows where body = 'Modalitet i errët.'))) = 'OK:1',
  'part4: open again');
select pg_temp.assert(
  (select done_at is null and done_by is null from public.reader_feedback where body = 'Modalitet i errët.'),
  'part4: open again clears done_at and done_by');

delete from auth.users where id = 'e1000000-0000-4000-8000-0000000000d3';
select pg_temp.assert(
  not exists (select 1 from public.reader_feedback where body = 'Modalitet i errët.'),
  'part4: deleted with the account');

select pg_temp.assert((select n from pg_temp.assertions_run) >= 30, 'all assertions ran');
select 'PASS: 100_download_count_feedback (' || n || ' assertions)' from pg_temp.assertions_run;

rollback;
