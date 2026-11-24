-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for the G4 pre-order email failure
-- alert (supabase/migrations/20261124180000_preorder_email_failures.sql):
--
--   Part 1  shape: columns, CHECK, grants, SECURITY DEFINER + empty
--           search_path, the single alert row.
--   Part 2  staff list: Owner/Admin (people.view) only; failed rows
--           only, with the email kind.
--   Part 3  send again / mark handled: the row state, the audit row,
--           false on a row without a failure, refused for a moderator.
--   Part 4  claim_preorder_failure_alert(): counts new failures, once
--           per Tirana day; service role only.
--   Part 5  the real files: rollback twice, the migration again.
--
-- Made-up names only. NOT one rolled-back transaction: Part 5 runs the
-- real files with \i. Run from the repo root:
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/114_preorder_email_failures.test.sql
--
-- Against the BASE schema it fails in Part 1 (no send_failure column):
-- the negative control.

set client_min_messages = warning;

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

-- One text value read as the given role (and user id); or the error.
create function pg_temp.value_as(p_role text, p_uid text, p_sql text) returns text
  language plpgsql as $$
declare
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), false);
  execute format('set role %I', p_role);
  begin
    execute p_sql into v_out;
  exception when others then
    v_out := sqlerrm;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', false);
  return coalesce(v_out, '<null>');
end;
$$;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('11400000-0000-4000-8000-000000000001', 'p114-owner@test', now(), '{"role":"reader","display_name":"P114 Owner"}'),
  ('11400000-0000-4000-8000-000000000002', 'p114-mod@test', now(), '{"role":"reader","display_name":"P114 Mod"}'),
  ('11400000-0000-4000-8000-000000000003', 'p114-author@test', now(), '{"role":"author","display_name":"P114 Author"}'),
  ('11400000-0000-4000-8000-000000000011', 'p114-r1@test', now(), '{"role":"reader","display_name":"P114 Reader One"}'),
  ('11400000-0000-4000-8000-000000000012', 'p114-r2@test', now(), '{"role":"reader","display_name":"P114 Reader Two"}'),
  ('11400000-0000-4000-8000-000000000013', 'p114-r3@test', now(), '{"role":"reader","display_name":"P114 Reader Three"}'),
  ('11400000-0000-4000-8000-000000000014', 'p114-r4@test', now(), '{"role":"reader","display_name":"P114 Reader Four"}'),
  ('11400000-0000-4000-8000-000000000099', 'p114-admin@test', now(), '{"role":"reader","display_name":"P114 Admin"}');
update public.profiles set role = 'author', public_author_name = display_name
 where id = '11400000-0000-4000-8000-000000000003';
insert into public.staff_members (user_id, role) values
  ('11400000-0000-4000-8000-000000000001', 'owner'),
  ('11400000-0000-4000-8000-000000000002', 'moderator'),
  ('11400000-0000-4000-8000-000000000099', 'admin');

insert into public.books (id, author_id, title, description, status, price_all, published_at) values
  ('11410000-0000-4000-8000-0000000000b1', '11400000-0000-4000-8000-000000000003', 'P114 Out', 'About it.', 'published', 0, now()),
  ('11410000-0000-4000-8000-0000000000b2', '11400000-0000-4000-8000-000000000003', 'P114 Ended', 'About it.', 'draft', 0, null);

-- r1: address refused (claimed); r2: unclear (claimed); r3: batch
-- refused (un-claimed); r4: sent fine. On b2 (cancelled): r1 batch refused.
insert into public.preorder_notify_requests (book_id, user_id, created_at, notified_at, book_cancelled_at, send_failure, send_failed_at) values
  ('11410000-0000-4000-8000-0000000000b1', '11400000-0000-4000-8000-000000000011', now() - interval '3 days', now() - interval '1 hour', null, 'address_refused', now() - interval '1 hour'),
  ('11410000-0000-4000-8000-0000000000b1', '11400000-0000-4000-8000-000000000012', now() - interval '3 days', now() - interval '1 hour', null, 'unclear', now() - interval '1 hour'),
  ('11410000-0000-4000-8000-0000000000b1', '11400000-0000-4000-8000-000000000013', now() - interval '3 days', null, null, 'batch_refused', now() - interval '1 hour'),
  ('11410000-0000-4000-8000-0000000000b1', '11400000-0000-4000-8000-000000000014', now() - interval '3 days', now() - interval '1 hour', null, null, null),
  ('11410000-0000-4000-8000-0000000000b2', '11400000-0000-4000-8000-000000000011', now() - interval '3 days', null, now() - interval '2 hours', 'batch_refused', now() - interval '30 minutes');

-- ============================================================
-- Part 1: shape.
-- ============================================================
do $$
declare
  v text;
begin
  perform pg_temp.assert(
    (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'preorder_notify_requests'
        and column_name in ('send_failure', 'send_failed_at')) = 2,
    'part1: the two columns exist');
  begin
    update public.preorder_notify_requests set send_failure = 'other', send_failed_at = now()
     where user_id = '11400000-0000-4000-8000-000000000014';
    v := 'OK';
  exception when check_violation then v := 'refused';
  end;
  perform pg_temp.assert(v = 'refused', 'part1: an unknown failure kind is refused');
  begin
    update public.preorder_notify_requests set send_failure = 'unclear', send_failed_at = null
     where user_id = '11400000-0000-4000-8000-000000000014';
    v := 'OK';
  exception when check_violation then v := 'refused';
  end;
  perform pg_temp.assert(v = 'refused', 'part1: a failure without its time is refused');

  perform pg_temp.assert(
    (select bool_and(p.prosecdef and p.proconfig = array['search_path=""'])
       from pg_proc p
      where p.oid in (
        'public.claim_preorder_failure_alert()'::regprocedure,
        'public.staff_list_preorder_email_failures()'::regprocedure,
        'public.staff_resend_preorder_email(uuid,uuid)'::regprocedure,
        'public.staff_mark_preorder_email_handled(uuid,uuid)'::regprocedure)),
    'part1: the four functions are SECURITY DEFINER with an empty search_path');
  perform pg_temp.assert(
    has_function_privilege('service_role', 'public.claim_preorder_failure_alert()', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.claim_preorder_failure_alert()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.claim_preorder_failure_alert()', 'EXECUTE'),
    'part1: the alert claim is service role only');
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.staff_list_preorder_email_failures()', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.staff_resend_preorder_email(uuid,uuid)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.staff_mark_preorder_email_handled(uuid,uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.staff_list_preorder_email_failures()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.staff_resend_preorder_email(uuid,uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.staff_mark_preorder_email_handled(uuid,uuid)', 'EXECUTE')
    and not has_function_privilege('service_role', 'public.staff_list_preorder_email_failures()', 'EXECUTE'),
    'part1: staff functions for signed-in callers only');
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.preorder_failure_alert_state', 'SELECT')
    and not has_table_privilege('service_role', 'public.preorder_failure_alert_state', 'SELECT')
    and not has_table_privilege('anon', 'public.preorder_failure_alert_state', 'SELECT'),
    'part1: nobody reads the alert state table directly');
  perform pg_temp.assert((select count(*) from public.preorder_failure_alert_state) = 1
    and (select last_alert_at is null from public.preorder_failure_alert_state),
    'part1: one alert row, never sent');
end $$;

-- ============================================================
-- Part 2: the staff list.
-- ============================================================
do $$
declare
  v text;
begin
  v := pg_temp.value_as('authenticated', '11400000-0000-4000-8000-000000000001',
    $q$select count(*)::text from public.staff_list_preorder_email_failures()$q$);
  perform pg_temp.assert(v = '4', format('part2: the owner sees the 4 failed rows -- got %s', v));
  v := pg_temp.value_as('authenticated', '11400000-0000-4000-8000-000000000099',
    $q$select count(*)::text from public.staff_list_preorder_email_failures()$q$);
  perform pg_temp.assert(v = '4', format('part2: an admin sees them too -- got %s', v));
  v := pg_temp.value_as('authenticated', '11400000-0000-4000-8000-000000000002',
    $q$select count(*)::text from public.staff_list_preorder_email_failures()$q$);
  perform pg_temp.assert(v like '%not authorized%', format('part2: a moderator is refused -- got %s', v));
  v := pg_temp.value_as('authenticated', '11400000-0000-4000-8000-000000000011',
    $q$select count(*)::text from public.staff_list_preorder_email_failures()$q$);
  perform pg_temp.assert(v like '%not authorized%', format('part2: a reader is refused -- got %s', v));
  v := pg_temp.value_as('authenticated', null,
    $q$select count(*)::text from public.staff_list_preorder_email_failures()$q$);
  perform pg_temp.assert(v like '%not authenticated%', format('part2: signed out is refused -- got %s', v));

  v := pg_temp.value_as('authenticated', '11400000-0000-4000-8000-000000000001',
    $q$select string_agg(reader_name || '/' || email_kind || '/' || send_failure || '/' || book_title, ';' order by reader_name, email_kind)
         from public.staff_list_preorder_email_failures()$q$);
  perform pg_temp.assert(v = 'P114 Reader One/cancelled/batch_refused/P114 Ended;P114 Reader One/released/address_refused/P114 Out;P114 Reader Three/released/batch_refused/P114 Out;P114 Reader Two/released/unclear/P114 Out',
    format('part2: names, kinds, failures and titles -- got %s', v));
  v := pg_temp.value_as('authenticated', '11400000-0000-4000-8000-000000000001',
    $q$select reader_name from public.staff_list_preorder_email_failures() limit 1$q$);
  perform pg_temp.assert(v = 'P114 Reader One', format('part2: newest failure first -- got %s', v));
end $$;

-- ============================================================
-- Part 3: send again / mark handled.
-- ============================================================
do $$
declare
  v text;
  r record;
begin
  -- A moderator can't act.
  v := pg_temp.value_as('authenticated', '11400000-0000-4000-8000-000000000002',
    $q$select public.staff_resend_preorder_email('11410000-0000-4000-8000-0000000000b1', '11400000-0000-4000-8000-000000000011')::text$q$);
  perform pg_temp.assert(v like '%not authorized%', format('part3: a moderator cannot send again -- got %s', v));
  v := pg_temp.value_as('authenticated', '11400000-0000-4000-8000-000000000002',
    $q$select public.staff_mark_preorder_email_handled('11410000-0000-4000-8000-0000000000b1', '11400000-0000-4000-8000-000000000011')::text$q$);
  perform pg_temp.assert(v like '%not authorized%', format('part3: a moderator cannot mark handled -- got %s', v));

  -- Send again on the address-refused row: waits again, mark cleared.
  v := pg_temp.value_as('authenticated', '11400000-0000-4000-8000-000000000001',
    $q$select public.staff_resend_preorder_email('11410000-0000-4000-8000-0000000000b1', '11400000-0000-4000-8000-000000000011')::text$q$);
  perform pg_temp.assert(v = 'true', format('part3: send again answers true -- got %s', v));
  select * into r from public.preorder_notify_requests
   where book_id = '11410000-0000-4000-8000-0000000000b1' and user_id = '11400000-0000-4000-8000-000000000011';
  perform pg_temp.assert(r.notified_at is null and r.send_failure is null and r.send_failed_at is null,
    'part3: after send again the row waits for the sweep, without a mark');
  perform pg_temp.assert(exists (select 1 from public.admin_audit_log
     where action = 'preorder_email.send_again' and actor_id = '11400000-0000-4000-8000-000000000001'
       and target_id = '11410000-0000-4000-8000-0000000000b1'
       and metadata = jsonb_build_object('user_id', '11400000-0000-4000-8000-000000000011', 'failure', 'address_refused')),
    'part3: send again writes the audit log');

  -- Again on the same row: no failure now, so false and no audit row.
  v := pg_temp.value_as('authenticated', '11400000-0000-4000-8000-000000000001',
    $q$select public.staff_resend_preorder_email('11410000-0000-4000-8000-0000000000b1', '11400000-0000-4000-8000-000000000011')::text$q$);
  perform pg_temp.assert(v = 'false', format('part3: a second send again answers false -- got %s', v));
  perform pg_temp.assert((select count(*) from public.admin_audit_log where action = 'preorder_email.send_again') = 1,
    'part3: no audit row for a no-op');

  -- The sent-fine row has no failure: neither action touches it.
  v := pg_temp.value_as('authenticated', '11400000-0000-4000-8000-000000000001',
    $q$select public.staff_mark_preorder_email_handled('11410000-0000-4000-8000-0000000000b1', '11400000-0000-4000-8000-000000000014')::text$q$);
  perform pg_temp.assert(v = 'false', format('part3: mark handled on a fine row answers false -- got %s', v));

  -- Mark handled on the batch-refused (un-claimed) row: counts as sent (g4e2 a).
  v := pg_temp.value_as('authenticated', '11400000-0000-4000-8000-000000000099',
    $q$select public.staff_mark_preorder_email_handled('11410000-0000-4000-8000-0000000000b1', '11400000-0000-4000-8000-000000000013')::text$q$);
  perform pg_temp.assert(v = 'true', format('part3: an admin marks handled -- got %s', v));
  select * into r from public.preorder_notify_requests
   where book_id = '11410000-0000-4000-8000-0000000000b1' and user_id = '11400000-0000-4000-8000-000000000013';
  perform pg_temp.assert(r.notified_at is not null and r.send_failure is null and r.send_failed_at is null,
    'part3: a handled batch-refused row counts as sent, so it is not retried');

  -- Mark handled on the unclear (claimed) row keeps its notified_at.
  select notified_at::text into v from public.preorder_notify_requests
   where book_id = '11410000-0000-4000-8000-0000000000b1' and user_id = '11400000-0000-4000-8000-000000000012';
  perform pg_temp.value_as('authenticated', '11400000-0000-4000-8000-000000000001',
    $q$select public.staff_mark_preorder_email_handled('11410000-0000-4000-8000-0000000000b1', '11400000-0000-4000-8000-000000000012')::text$q$);
  perform pg_temp.assert((select notified_at::text from public.preorder_notify_requests
     where book_id = '11410000-0000-4000-8000-0000000000b1' and user_id = '11400000-0000-4000-8000-000000000012') = v,
    'part3: mark handled keeps an existing notified_at');
  perform pg_temp.assert((select count(*) from public.admin_audit_log where action = 'preorder_email.handled') = 2,
    'part3: two handled audit rows');

  -- Null arguments.
  v := pg_temp.value_as('authenticated', '11400000-0000-4000-8000-000000000001',
    $q$select public.staff_resend_preorder_email(null, '11400000-0000-4000-8000-000000000011')::text$q$);
  perform pg_temp.assert(v like '%invalid arguments%', format('part3: null arguments refused -- got %s', v));

  v := pg_temp.value_as('authenticated', '11400000-0000-4000-8000-000000000001',
    $q$select count(*)::text from public.staff_list_preorder_email_failures()$q$);
  perform pg_temp.assert(v = '1', format('part3: one failed row left (b2) -- got %s', v));
end $$;

-- ============================================================
-- Part 4: one alert a day.
-- ============================================================
do $$
declare
  v text;
begin
  v := pg_temp.value_as('authenticated', '11400000-0000-4000-8000-000000000001',
    $q$select public.claim_preorder_failure_alert()::text$q$);
  perform pg_temp.assert(v like '%permission denied%', format('part4: staff cannot claim the alert -- got %s', v));

  v := pg_temp.value_as('service_role', null, $q$select public.claim_preorder_failure_alert()::text$q$);
  perform pg_temp.assert(v = '1', format('part4: the first claim counts the 1 failure -- got %s', v));
  perform pg_temp.assert((select last_alert_at is not null from public.preorder_failure_alert_state),
    'part4: the claim stamps the alert');

  -- A new failure the same Tirana day, AFTER the alert stamp (r3, audit
  -- N3: now() is fixed in this transaction, so a failure at now() would
  -- not count anyway; one second later it would, but for the day rule).
  update public.preorder_notify_requests set send_failure = 'unclear', send_failed_at = now() + interval '1 second'
   where book_id = '11410000-0000-4000-8000-0000000000b1' and user_id = '11400000-0000-4000-8000-000000000014';
  perform pg_temp.assert((select count(*) = 1 from public.preorder_notify_requests r, public.preorder_failure_alert_state s
                           where r.send_failure is not null and r.send_failed_at > s.last_alert_at),
    'part4: setup -- exactly one failure is newer than the alert stamp');
  v := pg_temp.value_as('service_role', null, $q$select public.claim_preorder_failure_alert()::text$q$);
  perform pg_temp.assert(v = '0', format('part4: a second claim the same Tirana day answers 0 (g4q7 a) -- got %s', v));
  perform pg_temp.assert((select last_alert_at = now() from public.preorder_failure_alert_state),
    'part4: the refused same-day claim leaves the stamp as it was');

  -- The last alert was yesterday: the new failure counts, the old one
  -- (before the last alert) does not.
  update public.preorder_failure_alert_state set last_alert_at = now() - interval '1 day';
  update public.preorder_notify_requests set send_failed_at = now() - interval '2 days'
   where book_id = '11410000-0000-4000-8000-0000000000b2';
  v := pg_temp.value_as('service_role', null, $q$select public.claim_preorder_failure_alert()::text$q$);
  perform pg_temp.assert(v = '1', format('part4: next day counts only failures since the last alert -- got %s', v));

  -- Nothing new: 0 and the stamp stays.
  update public.preorder_failure_alert_state set last_alert_at = now() - interval '1 day';
  update public.preorder_notify_requests set send_failed_at = now() - interval '2 days' where send_failure is not null;
  v := pg_temp.value_as('service_role', null, $q$select public.claim_preorder_failure_alert()::text$q$);
  perform pg_temp.assert(v = '0', format('part4: no new failure answers 0 -- got %s', v));
  perform pg_temp.assert((select last_alert_at < now() - interval '23 hours' from public.preorder_failure_alert_state),
    'part4: a 0 answer does not stamp');
end $$;

-- ============================================================
-- Part 5: the real files.
-- ============================================================
\i supabase/tests/114_preorder_email_failures.rollback.sql
\i supabase/tests/114_preorder_email_failures.rollback.sql

do $$
begin
  perform pg_temp.assert(to_regprocedure('public.claim_preorder_failure_alert()') is null
    and to_regprocedure('public.staff_list_preorder_email_failures()') is null
    and to_regclass('public.preorder_failure_alert_state') is null,
    'part5: rollback drops the functions and the table');
  perform pg_temp.assert(
    (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'preorder_notify_requests'
        and column_name in ('send_failure', 'send_failed_at')) = 0,
    'part5: rollback drops the two columns');
  perform pg_temp.assert((select count(*) from public.preorder_notify_requests) = 5,
    'part5: rollback keeps every request row');
end $$;

\i supabase/migrations/20261124180000_preorder_email_failures.sql

do $$
begin
  perform pg_temp.assert(to_regprocedure('public.claim_preorder_failure_alert()') is not null
    and has_function_privilege('authenticated', 'public.staff_mark_preorder_email_handled(uuid,uuid)', 'EXECUTE')
    and (select count(*) from public.preorder_failure_alert_state) = 1,
    'part5: the migration applies again after a rollback');
end $$;

select 'PASS: 114_preorder_email_failures' as result;
