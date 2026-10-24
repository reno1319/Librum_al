-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for SECURITY-9A
-- (supabase/migrations/20261024190000_signup_readers_lift_signout.sql):
--
-- * handle_new_user(): every new auth.users row gets a READER profile,
--   whatever role its metadata sends (author, admin, junk, none), with
--   public_author_name null and no pen name; display_name from the
--   metadata, else the e-mail's local part; a later metadata change
--   changes nothing (INSERT only).
--   The stub's test-only author-fixture trigger is dropped first, so
--   this tests the database on its own.
-- * The server's reader -> author switch (the update the site makes)
--   still gives the new author a public name and a default pen name.
-- * handle_new_user(): still no EXECUTE for PUBLIC, anon, authenticated.
-- * admin_suspend_account(): deletes no session and no refresh token
--   (old and newer token format alike), so a device whose access token
--   has expired still finds its token and gets "user is banned" from
--   Supabase Auth, which the site turns into "This account is
--   suspended"; its audit row is unchanged.
-- * admin_lift_suspension(): deletes every refresh token (with or
--   without a session) and every session (including one holding a
--   newer-format token) of that account and of no other; the audit row
--   records sessions_deleted and refresh_tokens_deleted; a refused lift
--   (not signed in, not staff, no people.manage, not suspended) deletes
--   nothing; EXECUTE still for authenticated only.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance (on 16 strip ", maintain" from a copy of schema.sql):
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/081_signup_readers_lift_signout.test.sql
--
-- It must also pass against the base schema.sql plus the migration.
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

-- One admin_list_people() row as text, columns in order, for a given call.
-- ------------------------------------------------------------
-- part1: handle_new_user() makes readers only
-- ------------------------------------------------------------
drop trigger zz_test_fixture_site_switches_authors on auth.users;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0810000-0000-4000-8000-000000000001', 'p081-a@test', now(), '{"role":"author","display_name":"P081 Ana"}'),
  ('e0810000-0000-4000-8000-000000000002', 'p081-b@test', null,  '{"role":"admin","display_name":"P081 Ben"}'),
  ('e0810000-0000-4000-8000-000000000003', 'p081-c@test', now(), '{"role":"reader","display_name":"P081 Cara"}'),
  ('e0810000-0000-4000-8000-000000000004', 'p081-dita@test', now(), '{"role":["author"]}'),
  ('e0810000-0000-4000-8000-000000000005', 'p081-e@test', now(), '{}');

select pg_temp.assert((select count(*) from public.profiles
                        where id::text like 'e0810000-%' and role = 'reader' and public_author_name is null) = 5,
  'part1: every new account is a reader with no public author name, whatever its metadata says');
select pg_temp.assert((select display_name from public.profiles where id = 'e0810000-0000-4000-8000-000000000001') = 'P081 Ana'
  and (select display_name from public.profiles where id = 'e0810000-0000-4000-8000-000000000004') = 'p081-dita'
  and (select display_name from public.profiles where id = 'e0810000-0000-4000-8000-000000000005') = 'p081-e',
  'part1: display_name from the metadata, else the e-mail''s local part');
select pg_temp.assert(not exists (select 1 from public.pen_names
                                   where author_id::text like 'e0810000-%'),
  'part1: a new reader gets no pen name');
select pg_temp.assert(not has_function_privilege('anon', 'public.handle_new_user()', 'execute')
  and not has_function_privilege('authenticated', 'public.handle_new_user()', 'execute')
  and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where p.oid = 'public.handle_new_user()'::regprocedure and a.grantee = 0),
  'part1: handle_new_user() still has no EXECUTE for PUBLIC, anon or authenticated');

-- The server's switch (src/app/(public)/auth/actions.ts through the
-- author-role writer): reader -> author, public name = display name.
update public.profiles
   set role = 'author', public_author_name = 'P081 Ana'
 where id = 'e0810000-0000-4000-8000-000000000001' and role = 'reader';
select pg_temp.assert((select role = 'author' and public_author_name = 'P081 Ana'
                         from public.profiles where id = 'e0810000-0000-4000-8000-000000000001')
  and (select count(*) from public.pen_names
        where author_id = 'e0810000-0000-4000-8000-000000000001' and is_default and name = 'P081 Ana') = 1,
  'part1: the server switch makes an author with a default pen name');

-- The trigger only runs on INSERT.
update auth.users set raw_user_meta_data = '{"role":"author"}' where id = 'e0810000-0000-4000-8000-000000000003';
select pg_temp.assert((select role from public.profiles where id = 'e0810000-0000-4000-8000-000000000003') = 'reader',
  'part1: changing metadata later changes nothing');

-- ------------------------------------------------------------
-- part2: suspending deletes nothing; lifting signs out everywhere
-- ------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0810000-0000-4000-8000-0000000000c1', 'p081-o@test', now(), '{"display_name":"P081 Owner"}'),
  ('e0810000-0000-4000-8000-0000000000c3', 'p081-m@test', now(), '{"display_name":"P081 Moderator"}');
insert into public.staff_members (user_id, role) values
  ('e0810000-0000-4000-8000-0000000000c1', 'owner'),
  ('e0810000-0000-4000-8000-0000000000c3', 'moderator');

-- A has an old-format session (a refresh_tokens row), a newer-format
-- session (its token lives on the session row: hmac key set, no
-- refresh_tokens row) and a token from before sessions existed.
insert into auth.sessions (id, user_id, refresh_token_hmac_key, refresh_token_counter) values
  ('e081aaaa-0000-4000-8000-000000000001', 'e0810000-0000-4000-8000-000000000001', null, null),
  ('e081aaaa-0000-4000-8000-000000000002', 'e0810000-0000-4000-8000-000000000001', 'test-hmac-key-a', 4),
  ('e081aaaa-0000-4000-8000-000000000003', 'e0810000-0000-4000-8000-000000000003', 'test-hmac-key-c', 1),
  ('e081aaaa-0000-4000-8000-000000000004', 'e0810000-0000-4000-8000-000000000003', null, null),
  ('e081aaaa-0000-4000-8000-0000000000c1', 'e0810000-0000-4000-8000-0000000000c1', null, null),
  ('e081aaaa-0000-4000-8000-0000000000c3', 'e0810000-0000-4000-8000-0000000000c3', null, null);
insert into auth.refresh_tokens (token, user_id, session_id) values
  ('t-a1', 'e0810000-0000-4000-8000-000000000001', 'e081aaaa-0000-4000-8000-000000000001'),
  ('t-a1-next', 'e0810000-0000-4000-8000-000000000001', 'e081aaaa-0000-4000-8000-000000000001'),
  ('t-a-old', 'e0810000-0000-4000-8000-000000000001', null),
  ('t-c', 'e0810000-0000-4000-8000-000000000003', 'e081aaaa-0000-4000-8000-000000000004'),
  ('t-c-old', 'e0810000-0000-4000-8000-000000000003', null),
  ('t-o', 'e0810000-0000-4000-8000-0000000000c1', 'e081aaaa-0000-4000-8000-0000000000c1');

create function pg_temp.auth_rows() returns text
  language sql as $$
  select (select count(*) from auth.sessions)::text || '/' || (select count(*) from auth.refresh_tokens)::text
$$;

select pg_temp.assert(pg_temp.auth_rows() = '6/6', 'part2: fixture');

-- Suspending deletes nothing, so an idle device (expired access token)
-- still finds its refresh token or session and Supabase Auth answers
-- "user is banned" (the ban the site sets after this call), which the
-- site shows as "This account is suspended".
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0810000-0000-4000-8000-0000000000c1',
  $q$select public.admin_suspend_account('e0810000-0000-4000-8000-000000000001', 'Spam')$q$) = 'OK:1',
  'part2: the owner suspends A');
select pg_temp.assert(pg_temp.auth_rows() = '6/6'
  and (select count(*) from auth.refresh_tokens where user_id = 'e0810000-0000-4000-8000-000000000001') = 3
  and exists (select 1 from auth.sessions where id = 'e081aaaa-0000-4000-8000-000000000002'
                                           and refresh_token_hmac_key is not null),
  'part2: suspending deletes no session and no refresh token (old and newer format), so a later refresh reaches the ban check');
select pg_temp.assert((select metadata = jsonb_build_object('reason', 'Spam', 'books_unpublished', 0,
                                                            'bundles_unpublished', 0, 'librum_choice_cleared', false)
                         from public.admin_audit_log
                        where action = 'account.suspended' and target_id = 'e0810000-0000-4000-8000-000000000001'),
  'part2: the suspension audit row is unchanged');
select pg_temp.assert((select prosrc !~* 'auth\.(sessions|refresh_tokens)' from pg_catalog.pg_proc
                         where oid = 'public.admin_suspend_account(uuid,text)'::regprocedure),
  'part2: admin_suspend_account touches no session or refresh token table');

-- Refused lifts delete nothing.
select pg_temp.assert(pg_temp.run_as('authenticated', null,
  $q$select public.admin_lift_suspension('e0810000-0000-4000-8000-000000000001')$q$) = 'P0001:not authenticated'
  and pg_temp.run_as('authenticated', 'e0810000-0000-4000-8000-000000000003',
  $q$select public.admin_lift_suspension('e0810000-0000-4000-8000-000000000001')$q$) = 'P0001:not authorized'
  and pg_temp.run_as('authenticated', 'e0810000-0000-4000-8000-0000000000c3',
  $q$select public.admin_lift_suspension('e0810000-0000-4000-8000-000000000001')$q$) = 'P0001:not authorized'
  and pg_temp.run_as('authenticated', 'e0810000-0000-4000-8000-0000000000c1',
  $q$select public.admin_lift_suspension('e0810000-0000-4000-8000-000000000003')$q$) = 'P0001:this account is not suspended'
  and pg_temp.run_as('anon', null,
  $q$select public.admin_lift_suspension('e0810000-0000-4000-8000-000000000001')$q$) like '42501:%',
  'part2: refused lifts');
select pg_temp.assert(pg_temp.auth_rows() = '6/6'
  and (select lifted_at is null from public.account_suspensions where user_id = 'e0810000-0000-4000-8000-000000000001'),
  'part2: a refused lift deletes no session or token and lifts nothing');

select pg_temp.assert(pg_temp.run_as('authenticated', 'e0810000-0000-4000-8000-0000000000c1',
  $q$select public.admin_lift_suspension('e0810000-0000-4000-8000-000000000001')$q$) = 'OK:1',
  'part2: the owner lifts A');
-- Own statements: a subquery in the same expression would be evaluated
-- before the call above.
select pg_temp.assert(not exists (select 1 from auth.refresh_tokens where user_id = 'e0810000-0000-4000-8000-000000000001')
  and not exists (select 1 from auth.sessions where user_id = 'e0810000-0000-4000-8000-000000000001'),
  'part2: lift deletes every refresh token of A (with or without a session) and every session of A, newer format included');
select pg_temp.assert(pg_temp.auth_rows() = '4/3'
  and (select count(*) from auth.sessions where user_id = 'e0810000-0000-4000-8000-000000000003') = 2
  and (select count(*) from auth.refresh_tokens where user_id = 'e0810000-0000-4000-8000-000000000003') = 2
  and exists (select 1 from auth.refresh_tokens where token = 't-o'),
  'part2: nobody else''s sessions or tokens are touched');
select pg_temp.assert((select metadata->'sessions_deleted' = '2'::jsonb and metadata->'refresh_tokens_deleted' = '3'::jsonb
                         from public.admin_audit_log
                        where action = 'account.suspension_lifted' and target_id = 'e0810000-0000-4000-8000-000000000001'),
  'part2: the lift audit row records sessions_deleted and refresh_tokens_deleted');

-- A second lift is refused and deletes nothing; a lift with nothing to
-- delete records 0 and 0.
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0810000-0000-4000-8000-0000000000c1',
  $q$select public.admin_lift_suspension('e0810000-0000-4000-8000-000000000001')$q$) = 'P0001:this account is not suspended'
  and pg_temp.auth_rows() = '4/3',
  'part2: a second lift is refused and deletes nothing');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0810000-0000-4000-8000-0000000000c1',
  $q$select public.admin_suspend_account('e0810000-0000-4000-8000-000000000005', 'Spam')$q$) = 'OK:1',
  'part2: the owner suspends a reader with no sessions');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0810000-0000-4000-8000-0000000000c1',
  $q$select public.admin_lift_suspension('e0810000-0000-4000-8000-000000000005')$q$) = 'OK:1',
  'part2: the owner lifts that reader');
select pg_temp.assert((select metadata->'sessions_deleted' = '0'::jsonb and metadata->'refresh_tokens_deleted' = '0'::jsonb
                         from public.admin_audit_log
                        where action = 'account.suspension_lifted' and target_id = 'e0810000-0000-4000-8000-000000000005')
  and pg_temp.auth_rows() = '4/3',
  'part2: nothing to delete: sessions_deleted 0, refresh_tokens_deleted 0');

select pg_temp.assert(not has_function_privilege('anon', 'public.admin_lift_suspension(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.admin_lift_suspension(uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.admin_lift_suspension(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.admin_suspend_account(uuid, text)', 'execute')
  and has_function_privilege('authenticated', 'public.admin_suspend_account(uuid, text)', 'execute')
  and not has_function_privilege('service_role', 'public.admin_suspend_account(uuid, text)', 'execute'),
  'part2: admin_lift_suspension and admin_suspend_account EXECUTE still for authenticated only');

do $$
begin
  if (select n from pg_temp.assertions_run) <> 22 then
    raise exception 'FAIL: expected 22 assertions to run, found %', (select n from pg_temp.assertions_run);
  end if;
  raise warning '081_signup_readers_lift_signout: % assertions passed', (select n from pg_temp.assertions_run);
end;
$$;

rollback;
