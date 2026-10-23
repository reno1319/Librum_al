-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for PEOPLE-1
-- (supabase/migrations/20261023090000_account_suspensions.sql):
--
-- * people.view / people.manage: owner and admin yes; moderator, editor,
--   support and a reader no;
-- * account_suspensions: RLS on with no policy; service_role SELECT
--   only; anon, authenticated and PUBLIC nothing -- no client session,
--   staff or the suspended person, reads a row;
-- * function EXECUTE: the three admin RPCs and my_account_is_suspended()
--   for authenticated only; the four trigger functions for nobody;
-- * admin_list_people: search by account name, pen name and email (LIKE
--   wildcards are literal), kinds, the per-account counts (paid sales
--   exclude free and refunded purchases), staff flag, paging, one account
--   by id, the input checks and the permission check;
-- * admin_suspend_account: the refusals (permission, self, staff, empty
--   reason, unknown account, already suspended); drafts exactly the
--   published books and bundles, clears the Librum's choice pick,
--   records them and audits the reason;
-- * the locks (LB464 publish, LB465 direct delete) for every role, and
--   the account cascade still deleting a suspended author;
-- * my_account_is_suspended() for the caller only;
-- * public_pen_names, public_series and public_reviews hide a suspended
--   account; a buyer still sees a book they own;
-- * author_payout_eligibility(): account_suspended first, and
--   reserve_author_payout() reserves nothing while suspended;
-- * admin_lift_suspension: restores exactly the recorded books and
--   bundles, keeps a draft a book whose file changed (LB462) or that was
--   taken down, keeps a bundle draft unless every book is published, does
--   not restore the Librum's choice pick, audits, and a second suspension
--   later is a new history row;
-- * the audit list RPC accepts the two new actions and target type.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance (on 16 strip ", maintain" from a copy of schema.sql):
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/079_account_suspensions.test.sql
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
create function pg_temp.person(p_sub text, p_args text, p_user uuid) returns text
  language sql as $$
  select pg_temp.value_as('authenticated', p_sub, format(
    $f$select concat_ws('|', account_type, is_staff::text, live_books, in_review_books, draft_books,
                         paid_sales, owned_books, has_bank_account::text, suspended::text)
         from public.admin_list_people(%s) where user_id = %L$f$, p_args, p_user))
$$;

-- ============================================================
-- Part 0: fixtures.
--   A  author (suspended later): a1 live + Librum's choice, a2 live,
--      a3 live, a4 draft, a5 draft waiting for review; bundles bu1 (a1)
--      and bu2 (a1, a2), both live; series s1; bank account; payout
--      settings and balance (eligible)
--   B  author: b1 live, b2 draft; a second pen name "Zana Quill"
--   C  author: c1 draft, bundle cu1 draft (account cascade case)
--   R  reader: buys a1 (paid) and a3 (free)
--   R2 reader: bought a1 and was refunded; reviews b1
--   O owner, AD admin, M moderator, S support, ED editor
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0790000-0000-4000-8000-00000000000a', 'p079-a@test', now(), '{"role":"author","display_name":"P079 Ana Hoxha"}'),
  ('e0790000-0000-4000-8000-00000000000b', 'p079-b@test', now(), '{"role":"author","display_name":"P079 Ben"}'),
  ('e0790000-0000-4000-8000-00000000000c', 'p079-c@test', now(), '{"role":"author","display_name":"P079 Cara"}'),
  ('e0790000-0000-4000-8000-0000000000aa', 'p079-r@test', now(), '{"role":"reader","display_name":"P079 Reader"}'),
  ('e0790000-0000-4000-8000-0000000000ab', 'p079-r2@test', now(), '{"role":"reader","display_name":"P079 Reader Two"}'),
  ('e0790000-0000-4000-8000-0000000000c1', 'p079-o@test', now(), '{"role":"reader","display_name":"P079 Owner"}'),
  ('e0790000-0000-4000-8000-0000000000c2', 'p079-ad@test', now(), '{"role":"reader","display_name":"P079 Admin"}'),
  ('e0790000-0000-4000-8000-0000000000c3', 'p079-m@test', now(), '{"role":"reader","display_name":"P079 Moderator"}'),
  ('e0790000-0000-4000-8000-0000000000c4', 'p079-s@test', now(), '{"role":"reader","display_name":"P079 Support"}'),
  ('e0790000-0000-4000-8000-0000000000c5', 'p079-e@test', now(), '{"role":"reader","display_name":"P079 Editor"}');

insert into public.staff_members (user_id, role) values
  ('e0790000-0000-4000-8000-0000000000c1', 'owner'),
  ('e0790000-0000-4000-8000-0000000000c2', 'admin'),
  ('e0790000-0000-4000-8000-0000000000c3', 'moderator'),
  ('e0790000-0000-4000-8000-0000000000c4', 'support'),
  ('e0790000-0000-4000-8000-0000000000c5', 'editor');

insert into public.pen_names (id, author_id, name) values
  ('e079be00-0000-4000-8000-0000000000b2', 'e0790000-0000-4000-8000-00000000000b', 'Zana Quill');

insert into public.books (id, author_id, title, description, status, price_all, published_at, file_path, cover_path) values
  ('e0790001-0000-4000-8000-0000000000a1', 'e0790000-0000-4000-8000-00000000000a', 'P079 One', 'About it.', 'published', 499, now(),
   'e0790000-0000-4000-8000-00000000000a/e0790001-0000-4000-8000-0000000000a1.epub', 'e079c0de-0000-4000-8000-0000000000a1/cover.jpg'),
  ('e0790001-0000-4000-8000-0000000000a2', 'e0790000-0000-4000-8000-00000000000a', 'P079 Two', 'About it.', 'published', 299, now(),
   'e0790000-0000-4000-8000-00000000000a/e0790001-0000-4000-8000-0000000000a2.epub', 'e079c0de-0000-4000-8000-0000000000a2/cover.jpg'),
  ('e0790001-0000-4000-8000-0000000000a3', 'e0790000-0000-4000-8000-00000000000a', 'P079 Three', 'About it.', 'published', 0, now(),
   'e0790000-0000-4000-8000-00000000000a/e0790001-0000-4000-8000-0000000000a3.epub', 'e079c0de-0000-4000-8000-0000000000a3/cover.jpg'),
  ('e0790001-0000-4000-8000-0000000000a4', 'e0790000-0000-4000-8000-00000000000a', 'P079 Four', 'About it.', 'draft', 0, null, null, null),
  ('e0790001-0000-4000-8000-0000000000a5', 'e0790000-0000-4000-8000-00000000000a', 'P079 Five', 'About it.', 'draft', 199, null,
   'e0790000-0000-4000-8000-00000000000a/e0790001-0000-4000-8000-0000000000a5.epub', 'e079c0de-0000-4000-8000-0000000000a5/cover.jpg'),
  ('e0790001-0000-4000-8000-0000000000b1', 'e0790000-0000-4000-8000-00000000000b', 'P079 Ben Live', 'About it.', 'published', 499, now(),
   'e0790000-0000-4000-8000-00000000000b/e0790001-0000-4000-8000-0000000000b1.epub', 'e079c0de-0000-4000-8000-0000000000b1/cover.jpg'),
  ('e0790001-0000-4000-8000-0000000000b2', 'e0790000-0000-4000-8000-00000000000b', 'P079 Ben Draft', 'About it.', 'draft', 0, null, null, null),
  ('e0790001-0000-4000-8000-0000000000c1', 'e0790000-0000-4000-8000-00000000000c', 'P079 Cara Draft', 'About it.', 'draft', 0, null, null, null);

update public.books set librum_choice_at = now() where id = 'e0790001-0000-4000-8000-0000000000a1';

-- The approvals live books carry (ADMIN-3-REVIEW's backfill), and a5's
-- pending review.
insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, status, grandfathered, decided_at)
select id, title, author_id, file_path, cover_path, 'approved', true, now()
  from public.books where status = 'published';
insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, status)
select id, title, author_id, file_path, cover_path, 'pending'
  from public.books where id = 'e0790001-0000-4000-8000-0000000000a5';

insert into public.bundles (id, author_id, title, status) values
  ('e0790002-0000-4000-8000-0000000000a1', 'e0790000-0000-4000-8000-00000000000a', 'P079 Bundle One', 'published'),
  ('e0790002-0000-4000-8000-0000000000a2', 'e0790000-0000-4000-8000-00000000000a', 'P079 Bundle Two', 'published'),
  ('e0790002-0000-4000-8000-0000000000c1', 'e0790000-0000-4000-8000-00000000000c', 'P079 Cara Bundle', 'draft');
insert into public.bundle_books (bundle_id, book_id) values
  ('e0790002-0000-4000-8000-0000000000a1', 'e0790001-0000-4000-8000-0000000000a1'),
  ('e0790002-0000-4000-8000-0000000000a2', 'e0790001-0000-4000-8000-0000000000a1'),
  ('e0790002-0000-4000-8000-0000000000a2', 'e0790001-0000-4000-8000-0000000000a2'),
  ('e0790002-0000-4000-8000-0000000000c1', 'e0790001-0000-4000-8000-0000000000c1');

insert into public.series (id, author_id, title) values
  ('e0790003-0000-4000-8000-0000000000a1', 'e0790000-0000-4000-8000-00000000000a', 'P079 Series');

insert into public.purchases (book_id, reader_id, amount_cents, refunded_at) values
  ('e0790001-0000-4000-8000-0000000000a1', 'e0790000-0000-4000-8000-0000000000aa', 499, null),
  ('e0790001-0000-4000-8000-0000000000a3', 'e0790000-0000-4000-8000-0000000000aa', 0, null),
  ('e0790001-0000-4000-8000-0000000000a1', 'e0790000-0000-4000-8000-0000000000ab', 499, now()),
  ('e0790001-0000-4000-8000-0000000000b1', 'e0790000-0000-4000-8000-0000000000ab', 499, null);

insert into public.reviews (book_id, reader_id, rating, body) values
  ('e0790001-0000-4000-8000-0000000000b1', 'e0790000-0000-4000-8000-0000000000ab', 5, 'P079 review');

insert into public.payout_minimum_policy (currency, minimum_threshold_minor, is_active) values ('ALL', 1500, true);
insert into public.author_payout_settings (author_id, currency, threshold_minor) values
  ('e0790000-0000-4000-8000-00000000000a', 'ALL', 2000);
insert into public.author_ledger_entries (author_id, entry_type, amount_minor, currency, available_at) values
  ('e0790000-0000-4000-8000-00000000000a', 'adjustment', 10000, 'ALL', now() - interval '1 day');
insert into public.author_payout_destinations (author_id, currency, beneficiary_name, iban) values
  ('e0790000-0000-4000-8000-00000000000a', 'ALL', 'P079 Ana Hoxha', 'AL47212110090000000235698741');

-- ============================================================
-- Part 1: privileges and permissions.
-- ============================================================
do $$
declare
  r text;
  f text;
begin
  perform pg_temp.assert((select relrowsecurity from pg_class where oid = 'public.account_suspensions'::regclass),
    'part1: RLS is on');
  perform pg_temp.assert(not has_table_privilege('anon', 'public.account_suspensions', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
    'part1: anon holds nothing on account_suspensions');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.account_suspensions', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
    'part1: authenticated holds nothing on account_suspensions');
  perform pg_temp.assert(has_table_privilege('service_role', 'public.account_suspensions', 'SELECT')
    and not has_table_privilege('service_role', 'public.account_suspensions', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
    'part1: service_role holds SELECT only');
  perform pg_temp.assert(not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'account_suspensions'),
    'part1: no policy, so no client session reads a row');
  perform pg_temp.assert(not exists (
      select 1 from pg_class c, aclexplode(c.relacl) a
       where c.oid = 'public.account_suspensions'::regclass and a.grantee = 0),
    'part1: nothing granted to PUBLIC');

  foreach f in array array[
    'public.admin_list_people(text,text,integer,integer,uuid)',
    'public.admin_suspend_account(uuid,text)',
    'public.admin_lift_suspension(uuid)',
    'public.my_account_is_suspended()'
  ] loop
    perform pg_temp.assert(has_function_privilege('authenticated', f, 'EXECUTE'), format('part1: authenticated executes %s', f));
    perform pg_temp.assert(not has_function_privilege('anon', f, 'EXECUTE'), format('part1: anon does not execute %s', f));
    perform pg_temp.assert(not has_function_privilege('service_role', f, 'EXECUTE'), format('part1: service_role does not execute %s', f));
    perform pg_temp.assert(not exists (
        select 1 from pg_proc p, aclexplode(p.proacl) a
         where p.oid = f::regprocedure and a.grantee = 0),
      format('part1: PUBLIC does not execute %s', f));
    perform pg_temp.assert((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = f::regprocedure),
      format('part1: %s is SECURITY DEFINER with an empty search_path', f));
  end loop;

  foreach f in array array[
    'public.books_refuse_publish_while_author_suspended()',
    'public.bundles_refuse_publish_while_author_suspended()',
    'public.books_refuse_delete_while_author_suspended()',
    'public.bundles_refuse_delete_while_author_suspended()'
  ] loop
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      perform pg_temp.assert(not has_function_privilege(r, f, 'EXECUTE'), format('part1: %s does not execute %s', r, f));
    end loop;
    perform pg_temp.assert((select proacl is not null from pg_proc where oid = f::regprocedure)
      and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = f::regprocedure and a.grantee = 0),
      format('part1: PUBLIC does not execute %s', f));
  end loop;

  -- The payout function keeps its grants: service_role only.
  perform pg_temp.assert(has_function_privilege('service_role', 'public.author_payout_eligibility(uuid,text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.author_payout_eligibility(uuid,text)', 'EXECUTE'),
    'part1: author_payout_eligibility grants unchanged');

  perform pg_temp.assert(exists (select 1 from pg_trigger where tgname = 'books_refuse_publish_while_author_suspended' and tgrelid = 'public.books'::regclass)
    and exists (select 1 from pg_trigger where tgname = 'bundles_refuse_publish_while_author_suspended' and tgrelid = 'public.bundles'::regclass)
    and exists (select 1 from pg_trigger where tgname = 'books_refuse_delete_while_author_suspended' and tgrelid = 'public.books'::regclass)
    and exists (select 1 from pg_trigger where tgname = 'bundles_refuse_delete_while_author_suspended' and tgrelid = 'public.bundles'::regclass),
    'part1: the four lock triggers exist');
end;
$$;

select pg_temp.assert(pg_temp.value_as('authenticated', 'e0790000-0000-4000-8000-0000000000c1',
  $q$select public.staff_has_permission('people.view') and public.staff_has_permission('people.manage')$q$) = 'true', 'part1: owner holds people.*');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0790000-0000-4000-8000-0000000000c2',
  $q$select public.staff_has_permission('people.view') and public.staff_has_permission('people.manage')$q$) = 'true', 'part1: admin holds people.*');
select pg_temp.assert(pg_temp.value_as('authenticated', s,
  $q$select public.staff_has_permission('people.view') or public.staff_has_permission('people.manage')$q$) = 'false',
  format('part1: %s holds no people.*', s))
  from unnest(array['e0790000-0000-4000-8000-0000000000c3', 'e0790000-0000-4000-8000-0000000000c4',
                    'e0790000-0000-4000-8000-0000000000c5', 'e0790000-0000-4000-8000-0000000000aa']) s;

-- ============================================================
-- Part 2: the People list.
-- ============================================================
-- Permission.
select pg_temp.assert(pg_temp.run_as('authenticated', s, $q$select * from public.admin_list_people()$q$) = 'P0001:not authorized',
  format('part2: %s may not list people', s))
  from unnest(array['e0790000-0000-4000-8000-0000000000c3', 'e0790000-0000-4000-8000-0000000000c4',
                    'e0790000-0000-4000-8000-0000000000c5', 'e0790000-0000-4000-8000-0000000000aa']) s;
select pg_temp.assert(pg_temp.run_as('anon', null, $q$select * from public.admin_list_people()$q$) like '42501:%',
  'part2: anon may not call admin_list_people');
select pg_temp.assert(pg_temp.run_as('authenticated', null, $q$select * from public.admin_list_people()$q$) = 'P0001:not authenticated',
  'part2: no session, no list');

-- Everyone, paging, total.
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0790000-0000-4000-8000-0000000000c1', $q$select * from public.admin_list_people()$q$) = 'OK:10',
  'part2: owner lists all ten accounts');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0790000-0000-4000-8000-0000000000c2',
  $q$select count(*)::text || '/' || min(total_count)::text from public.admin_list_people(null, 'everyone', 3, 0)$q$) = '3/10',
  'part2: a page of 3, total 10');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0790000-0000-4000-8000-0000000000c2',
  $q$select count(*)::text from public.admin_list_people(null, 'everyone', 3, 9)$q$) = '1',
  'part2: the last page');

-- Kinds.
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0790000-0000-4000-8000-0000000000c2',
  $q$select string_agg(display_name, ',' order by display_name) from public.admin_list_people(null, 'authors')$q$) = 'P079 Ana Hoxha,P079 Ben,P079 Cara',
  'part2: authors');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0790000-0000-4000-8000-0000000000c2',
  $q$select count(*)::text from public.admin_list_people(null, 'readers')$q$) = '7',
  'part2: readers (staff accounts are readers)');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0790000-0000-4000-8000-0000000000c2',
  $q$select count(*)::text from public.admin_list_people(null, 'suspended')$q$) = '0',
  'part2: nobody suspended yet');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0790000-0000-4000-8000-0000000000c2',
  $q$select * from public.admin_list_people(null, 'staff')$q$) = 'P0001:invalid kind', 'part2: invalid kind');

-- Search: account name, email, pen name; wildcards literal; length.
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0790000-0000-4000-8000-0000000000c2',
  $q$select string_agg(display_name, ',') from public.admin_list_people('  hoxha ')$q$) = 'P079 Ana Hoxha',
  'part2: search by account name, trimmed, any case');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0790000-0000-4000-8000-0000000000c2',
  $q$select string_agg(display_name || ':' || email, ',') from public.admin_list_people('P079-B@')$q$) = 'P079 Ben:p079-b@test',
  'part2: search by email, email returned');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0790000-0000-4000-8000-0000000000c2',
  $q$select string_agg(display_name, ',') from public.admin_list_people('zana quill')$q$) = 'P079 Ben',
  'part2: search by a non-default pen name');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0790000-0000-4000-8000-0000000000c2',
  $q$select count(*)::text from public.admin_list_people('%')$q$) = '0'
  and pg_temp.value_as('authenticated', 'e0790000-0000-4000-8000-0000000000c2',
  $q$select count(*)::text from public.admin_list_people('p079_')$q$) = '0',
  'part2: % and _ are literal');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0790000-0000-4000-8000-0000000000c2',
  format('select * from public.admin_list_people(%L)', repeat('x', 201))) = 'P0001:invalid query', 'part2: query too long');

-- Counts: type|staff|live|in review|draft|paid sales|owned|bank|suspended.
select pg_temp.assert(pg_temp.person('e0790000-0000-4000-8000-0000000000c2', 'null', 'e0790000-0000-4000-8000-00000000000a')
  = 'author|false|3|1|1|1|0|true|false', 'part2: author A counts (paid sales exclude free and refunded)');
select pg_temp.assert(pg_temp.person('e0790000-0000-4000-8000-0000000000c2', 'null', 'e0790000-0000-4000-8000-0000000000aa')
  = 'reader|false|0|0|0|0|2|false|false', 'part2: reader R owns two books');
select pg_temp.assert(pg_temp.person('e0790000-0000-4000-8000-0000000000c2', 'null', 'e0790000-0000-4000-8000-0000000000ab')
  = 'reader|false|0|0|0|0|1|false|false', 'part2: a refunded purchase is not owned');
select pg_temp.assert(pg_temp.person('e0790000-0000-4000-8000-0000000000c2', 'null', 'e0790000-0000-4000-8000-0000000000c1')
  = 'reader|true|0|0|0|0|0|false|false', 'part2: the owner is flagged staff');

-- One account by id.
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0790000-0000-4000-8000-0000000000c2',
  $q$select count(*)::text || ':' || min(total_count)::text
       from public.admin_list_people(null, 'everyone', 50, 0, 'e0790000-0000-4000-8000-00000000000b')$q$) = '1:1',
  'part2: one account by id');

-- ============================================================
-- Part 3: suspend.
-- ============================================================
select pg_temp.assert(pg_temp.run_as('authenticated', s,
  $q$select public.admin_suspend_account('e0790000-0000-4000-8000-00000000000a', 'Spam')$q$) = 'P0001:not authorized',
  format('part3: %s may not suspend', s))
  from unnest(array['e0790000-0000-4000-8000-0000000000c3', 'e0790000-0000-4000-8000-0000000000c4',
                    'e0790000-0000-4000-8000-0000000000c5', 'e0790000-0000-4000-8000-0000000000aa']) s;
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select public.admin_suspend_account('e0790000-0000-4000-8000-00000000000a', 'Spam')$q$) like '42501:%',
  'part3: anon may not call admin_suspend_account');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0790000-0000-4000-8000-0000000000c2',
  $q$select public.admin_suspend_account('e0790000-0000-4000-8000-0000000000c2', 'Spam')$q$) = 'P0001:you cannot suspend yourself',
  'part3: nobody suspends themselves');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0790000-0000-4000-8000-0000000000c2',
  format('select public.admin_suspend_account(%L, %L)', s, 'Spam')) = 'P0001:staff cannot be suspended',
  format('part3: staff %s cannot be suspended', s))
  from unnest(array['e0790000-0000-4000-8000-0000000000c1', 'e0790000-0000-4000-8000-0000000000c3']) s;
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0790000-0000-4000-8000-0000000000c1',
  $q$select public.admin_suspend_account('e0790000-0000-4000-8000-0000000000c2', 'Spam')$q$) = 'P0001:staff cannot be suspended',
  'part3: the owner cannot suspend an admin either');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0790000-0000-4000-8000-0000000000c2',
  format('select public.admin_suspend_account(%L, %L)', 'e0790000-0000-4000-8000-00000000000a', r)) = 'P0001:invalid reason',
  format('part3: reason %L refused', r))
  from unnest(array['', E'  \n ', repeat('x', 2001)]) r;
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0790000-0000-4000-8000-0000000000c2',
  $q$select public.admin_suspend_account('e0790000-0000-4000-8000-0000000000ff', 'Spam')$q$) = 'P0001:no account found for this id',
  'part3: unknown account');
select pg_temp.assert(not exists (select 1 from public.account_suspensions), 'part3: no refusal wrote a row');

-- The suspension.
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0790000-0000-4000-8000-0000000000c2',
  $q$select public.admin_suspend_account('e0790000-0000-4000-8000-00000000000a', '  Spam books  ')$q$) = 'OK:1',
  'part3: the admin suspends author A');

select pg_temp.assert((select count(*) from public.books where author_id = 'e0790000-0000-4000-8000-00000000000a' and status = 'published') = 0,
  'part3: none of A''s books is live');
select pg_temp.assert((select count(*) from public.bundles where author_id = 'e0790000-0000-4000-8000-00000000000a' and status = 'published') = 0,
  'part3: none of A''s bundles is live');
select pg_temp.assert((select librum_choice_at from public.books where id = 'e0790001-0000-4000-8000-0000000000a1') is null,
  'part3: the Librum''s choice pick is cleared');
select pg_temp.assert((select status from public.book_reviews where book_id = 'e0790001-0000-4000-8000-0000000000a5') = 'pending',
  'part3: a pending review stays pending');
select pg_temp.assert((select reason = 'Spam books'
                          and book_ids = array['e0790001-0000-4000-8000-0000000000a1', 'e0790001-0000-4000-8000-0000000000a2',
                                               'e0790001-0000-4000-8000-0000000000a3']::uuid[]
                          and bundle_ids = array['e0790002-0000-4000-8000-0000000000a1', 'e0790002-0000-4000-8000-0000000000a2']::uuid[]
                          and suspended_by = 'e0790000-0000-4000-8000-0000000000c2'
                          and lifted_at is null and lifted_by is null
                         from public.account_suspensions where user_id = 'e0790000-0000-4000-8000-00000000000a'),
  'part3: the row records the trimmed reason and exactly what was unpublished');
select pg_temp.assert((select metadata = jsonb_build_object('reason', 'Spam books', 'books_unpublished', 3,
                                                            'bundles_unpublished', 2, 'librum_choice_cleared', true)
                         from public.admin_audit_log
                        where action = 'account.suspended' and target_type = 'profiles'
                          and target_id = 'e0790000-0000-4000-8000-00000000000a'
                          and actor_id = 'e0790000-0000-4000-8000-0000000000c2'),
  'part3: one account.suspended audit row');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0790000-0000-4000-8000-0000000000c1',
  $q$select public.admin_suspend_account('e0790000-0000-4000-8000-00000000000a', 'Again')$q$) = 'P0001:this account is already suspended',
  'part3: already suspended');
select pg_temp.assert(pg_temp.person('e0790000-0000-4000-8000-0000000000c2', $q$null, 'suspended'$q$, 'e0790000-0000-4000-8000-00000000000a')
  = 'author|false|0|1|4|1|0|true|true', 'part3: the list shows A suspended, books as drafts');

-- The locks, for every role.
select pg_temp.assert(pg_temp.run_as(r,
  null, $q$update public.books set status = 'published' where id = 'e0790001-0000-4000-8000-0000000000a1'$q$) like 'LB464:%',
  format('part3: %s cannot publish a suspended author''s book', r))
  from unnest(array['service_role', 'postgres']) r;
select pg_temp.assert(pg_temp.run_as('service_role',
  null, $q$update public.bundles set status = 'published' where id = 'e0790002-0000-4000-8000-0000000000a1'$q$) like 'LB464:%',
  'part3: nor a bundle');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$insert into public.books (author_id, title, description, status, price_all) values ('e0790000-0000-4000-8000-00000000000a', 'New', 'x', 'published', 0)$q$) like 'LB464:%',
  'part3: nor insert one live');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$insert into public.bundles (author_id, title, status) values ('e0790000-0000-4000-8000-00000000000a', 'New', 'published')$q$) like 'LB464:%',
  'part3: nor insert a live bundle');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0790000-0000-4000-8000-00000000000a',
  $q$delete from public.books where id = 'e0790001-0000-4000-8000-0000000000a4'$q$) like 'LB465:%',
  'part3: the suspended author cannot delete a book with a leftover token');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0790000-0000-4000-8000-00000000000a',
  $q$delete from public.bundles where id = 'e0790002-0000-4000-8000-0000000000a1'$q$) like 'LB465:%',
  'part3: nor a bundle');
select pg_temp.assert(pg_temp.run_as(r, null, $q$delete from public.books where id = 'e0790001-0000-4000-8000-0000000000a4'$q$) like 'LB465:%',
  format('part3: nor can %s delete it directly', r))
  from unnest(array['service_role', 'postgres']) r;
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0790000-0000-4000-8000-00000000000b',
  $q$delete from public.books where id = 'e0790001-0000-4000-8000-0000000000b2'$q$) = 'OK:1',
  'part3: another author still deletes their own draft');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set title = 'P079 Four renamed' where id = 'e0790001-0000-4000-8000-0000000000a4'$q$) = 'OK:1',
  'part3: other writes to a suspended author''s draft still work');

-- my_account_is_suspended(): the caller only.
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0790000-0000-4000-8000-00000000000a', $q$select public.my_account_is_suspended()::text$q$) = 'true',
  'part3: A is suspended');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0790000-0000-4000-8000-00000000000b', $q$select public.my_account_is_suspended()::text$q$) = 'false',
  'part3: B is not');
select pg_temp.assert(pg_temp.value_as('authenticated', null, $q$select public.my_account_is_suspended()::text$q$) = 'false',
  'part3: no session is not suspended');
select pg_temp.assert(pg_temp.run_as('anon', null, $q$select public.my_account_is_suspended()$q$) like '42501:%',
  'part3: anon may not call it');

-- Who reads the suspension rows: the service role only (the person page
-- reads them after requireStaff("people.view")).
select pg_temp.assert(pg_temp.run_as('authenticated', s, $q$select * from public.account_suspensions$q$) like '42501:%',
  format('part3: %s cannot read the suspension rows', s))
  from unnest(array['e0790000-0000-4000-8000-00000000000a', 'e0790000-0000-4000-8000-0000000000c1',
                    'e0790000-0000-4000-8000-0000000000c2', 'e0790000-0000-4000-8000-0000000000aa']) s;
select pg_temp.assert(pg_temp.value_as('service_role', null, $q$select count(*)::text from public.account_suspensions$q$) = '1',
  'part3: the service role reads the suspension row');
select pg_temp.assert(pg_temp.run_as('anon', null, $q$select * from public.account_suspensions$q$) like '42501:%',
  'part3: anon reads nothing');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0790000-0000-4000-8000-0000000000c1',
  $q$update public.account_suspensions set lifted_at = now()$q$) like '42501:%'
  and pg_temp.run_as('service_role', null, $q$delete from public.account_suspensions$q$) like '42501:%',
  'part3: nobody writes the rows directly');

-- Public views and the buyer.
select pg_temp.assert((select count(*) from public.public_pen_names v join public.pen_names x on x.id = v.id
                        where x.author_id = 'e0790000-0000-4000-8000-00000000000a') = 0
  and (select count(*) from public.public_pen_names v join public.pen_names x on x.id = v.id
        where x.author_id = 'e0790000-0000-4000-8000-00000000000b') = 1,
  'part3: A''s pen name is hidden, B''s is not');
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select count(*)::text from public.public_series where id = 'e0790003-0000-4000-8000-0000000000a1'$q$) = '0',
  'part3: A''s series is hidden');
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select count(*)::text from public.public_books where id = 'e0790001-0000-4000-8000-0000000000a1'$q$) = '0',
  'part3: A''s book is out of the store');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0790000-0000-4000-8000-0000000000aa',
  $q$select count(*)::text from public.public_books where id = 'e0790001-0000-4000-8000-0000000000a1'$q$) = '1',
  'part3: the buyer still sees the book they own (5a)');
select pg_temp.assert(pg_temp.value_as('anon', null, $q$select count(*)::text from public.public_reviews where body = 'P079 review'$q$) = '1',
  'part3: R2''s review is visible before R2 is suspended');

select pg_temp.assert(pg_temp.run_as('authenticated', 'e0790000-0000-4000-8000-0000000000c1',
  $q$select public.admin_suspend_account('e0790000-0000-4000-8000-0000000000ab', 'Abusive reviews')$q$) = 'OK:1',
  'part3: the owner suspends reader R2');
select pg_temp.assert(pg_temp.value_as('anon', null, $q$select count(*)::text from public.public_reviews where body = 'P079 review'$q$) = '0'
  and (select count(*) from public.reviews where body = 'P079 review') = 1,
  'part3: R2''s review is hidden, not deleted');

-- Payouts are held.
select pg_temp.assert((select not eligible and ineligible_reason = 'account_suspended'
                         from public.author_payout_eligibility('e0790000-0000-4000-8000-00000000000a', 'ALL')),
  'part3: A is not eligible: account_suspended');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$select * from public.reserve_author_payout('e0790000-0000-4000-8000-00000000000a', 'ALL')$q$) = 'OK:0'
  and not exists (select 1 from public.author_payouts where author_id = 'e0790000-0000-4000-8000-00000000000a'),
  'part3: no payout is reserved for A');
select pg_temp.assert((select ledger_available_minor = 10000 from public.author_payout_eligibility('e0790000-0000-4000-8000-00000000000a', 'ALL')),
  'part3: A''s balance is kept');

-- During the suspension: a2's file changes; a3 is taken down.
update public.books
   set file_path = 'e0790000-0000-4000-8000-00000000000a/e0790001-0000-4000-8000-0000000000a2/f0000000-0000-4000-8000-000000000002.epub'
 where id = 'e0790001-0000-4000-8000-0000000000a2';
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0790000-0000-4000-8000-0000000000c3',
  $q$select public.admin_unpublish_book('e0790001-0000-4000-8000-0000000000a3', 'copyright', 'Probe', null)$q$) = 'OK:1',
  'part3: a moderator takes a3 down');

-- ============================================================
-- Part 4: lift.
-- ============================================================
select pg_temp.assert(pg_temp.run_as('authenticated', s,
  $q$select public.admin_lift_suspension('e0790000-0000-4000-8000-00000000000a')$q$) = 'P0001:not authorized',
  format('part4: %s may not lift', s))
  from unnest(array['e0790000-0000-4000-8000-0000000000c3', 'e0790000-0000-4000-8000-0000000000aa',
                    'e0790000-0000-4000-8000-00000000000a']) s;
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0790000-0000-4000-8000-0000000000c2',
  $q$select public.admin_lift_suspension('e0790000-0000-4000-8000-00000000000b')$q$) = 'P0001:this account is not suspended',
  'part4: B is not suspended');

select pg_temp.assert(pg_temp.value_as('authenticated', 'e0790000-0000-4000-8000-0000000000c2',
  $q$select public.admin_lift_suspension('e0790000-0000-4000-8000-00000000000a')::text$q$)::jsonb
  = jsonb_build_object(
      'restored_book_ids', jsonb_build_array('e0790001-0000-4000-8000-0000000000a1'),
      'draft_book_ids', jsonb_build_array('e0790001-0000-4000-8000-0000000000a2', 'e0790001-0000-4000-8000-0000000000a3'),
      'restored_bundle_ids', jsonb_build_array('e0790002-0000-4000-8000-0000000000a1'),
      'draft_bundle_ids', jsonb_build_array('e0790002-0000-4000-8000-0000000000a2')),
  'part4: a1 and bu1 restored; a2 (file changed, LB462), a3 (taken down) and bu2 (holds a2) stay drafts');

select pg_temp.assert((select string_agg(title || '=' || status, ',' order by title) from public.books
                        where author_id = 'e0790000-0000-4000-8000-00000000000a')
  = 'P079 Five=draft,P079 Four renamed=draft,P079 One=published,P079 Three=draft,P079 Two=draft',
  'part4: exactly a1 is live again; the drafts never published stay drafts');
select pg_temp.assert((select string_agg(title || '=' || status, ',' order by title) from public.bundles
                        where author_id = 'e0790000-0000-4000-8000-00000000000a')
  = 'P079 Bundle One=published,P079 Bundle Two=draft', 'part4: bundles');
select pg_temp.assert((select librum_choice_at from public.books where id = 'e0790001-0000-4000-8000-0000000000a1') is null,
  'part4: the Librum''s choice pick is not put back');
select pg_temp.assert((select lifted_at is not null and lifted_by = 'e0790000-0000-4000-8000-0000000000c2'
                         from public.account_suspensions where user_id = 'e0790000-0000-4000-8000-00000000000a'),
  'part4: the row is lifted, by the admin');
select pg_temp.assert((select metadata = jsonb_build_object('books_restored', 1, 'books_kept_draft', 2,
                                                            'bundles_restored', 1, 'bundles_kept_draft', 1)
                         from public.admin_audit_log
                        where action = 'account.suspension_lifted' and target_id = 'e0790000-0000-4000-8000-00000000000a'),
  'part4: one account.suspension_lifted audit row');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0790000-0000-4000-8000-00000000000a', $q$select public.my_account_is_suspended()::text$q$) = 'false',
  'part4: A is no longer suspended');
select pg_temp.assert((select count(*) from public.public_pen_names v join public.pen_names x on x.id = v.id
                        where x.author_id = 'e0790000-0000-4000-8000-00000000000a') = 1
  and pg_temp.value_as('anon', null, $q$select count(*)::text from public.public_series where id = 'e0790003-0000-4000-8000-0000000000a1'$q$) = '1',
  'part4: A''s pen name and series are back');
select pg_temp.assert((select eligible from public.author_payout_eligibility('e0790000-0000-4000-8000-00000000000a', 'ALL')),
  'part4: A is eligible for payouts again');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set status = 'published' where id = 'e0790001-0000-4000-8000-0000000000a2'$q$) like 'LB462:%',
  'part4: a2 now needs review, as any changed file does');

select pg_temp.assert(pg_temp.run_as('authenticated', 'e0790000-0000-4000-8000-0000000000c1',
  $q$select public.admin_lift_suspension('e0790000-0000-4000-8000-0000000000ab')$q$) = 'OK:1',
  'part4: the owner lifts R2');
select pg_temp.assert(pg_temp.value_as('anon', null, $q$select count(*)::text from public.public_reviews where body = 'P079 review'$q$) = '1',
  'part4: lifting R2 shows the review again');

-- A second suspension later is a new history row.
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0790000-0000-4000-8000-0000000000c1',
  $q$select public.admin_suspend_account('e0790000-0000-4000-8000-00000000000a', 'Second time')$q$) = 'OK:1',
  'part4: A suspended a second time');
select pg_temp.assert((select count(*) from public.account_suspensions where user_id = 'e0790000-0000-4000-8000-00000000000a') = 2
  and (select count(*) from public.account_suspensions where user_id = 'e0790000-0000-4000-8000-00000000000a' and lifted_at is null) = 1,
  'part4: the second suspension is a second row');

-- The account cascade still deletes a suspended author (C).
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0790000-0000-4000-8000-0000000000c2',
  $q$select public.admin_suspend_account('e0790000-0000-4000-8000-00000000000c', 'Fraud')$q$) = 'OK:1',
  'part4: C suspended');
delete from auth.users where id = 'e0790000-0000-4000-8000-00000000000c';
select pg_temp.assert(not exists (select 1 from public.books where id = 'e0790001-0000-4000-8000-0000000000c1')
  and not exists (select 1 from public.bundles where id = 'e0790002-0000-4000-8000-0000000000c1')
  and (select count(*) from public.account_suspensions where user_id is null and reason = 'Fraud') = 1,
  'part4: deleting C''s account cascades through the locks and keeps the history row');

-- The audit list accepts the new filters.
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0790000-0000-4000-8000-0000000000c1',
  $q$select count(*)::text from public.list_admin_audit_events(p_action => 'account.suspended')$q$) = '4'
  and pg_temp.value_as('authenticated', 'e0790000-0000-4000-8000-0000000000c1',
  $q$select count(*)::text from public.list_admin_audit_events(p_action => 'account.suspension_lifted', p_target_type => 'profiles')$q$) = '2',
  'part4: the audit list filters by the new actions and target type');

do $$
begin
  raise warning '079_account_suspensions: % assertions passed', (select n from pg_temp.assertions_run);
end;
$$;

rollback;
