-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for SECURITY-9B
-- (supabase/migrations/20261024200000_grants_tightening.sql):
--
-- * part1: wishlist_items, book_reports, book_views,
--   bundle_checkout_reservations, bundle_checkout_reader_holds: anon
--   holds nothing (TRUNCATE, REFERENCES and TRIGGER included);
--   authenticated holds exactly what the policies allow; service_role
--   keeps SELECT/INSERT/UPDATE/DELETE. Then the app's own operations as
--   a signed-in reader still work, and everything else is refused with
--   42501 before RLS is reached.
-- * part2: service_role EXECUTE on the 53 functions that only had it
--   through the platform's old default; NOT on
--   payment_intent_has_lost_dispute() and
--   author_lost_disputed_payment_intents() (test 037's rule).
-- * part3: closed by default: a table, sequence and function created by
--   postgres in public after schema.sql gets no privilege of its own for
--   anon, authenticated or service_role. PUBLIC keeps PostgreSQL's
--   global EXECUTE default on functions (documented in schema.sql).
-- * part4: anon can EXECUTE exactly nine public functions (fixed list).
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance (on 16 strip ", maintain" from a copy of schema.sql):
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/082_grants_tightening.test.sql
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
create function pg_temp.privs(p_role text, p_rel text) returns text
  language sql as $$
  select coalesce(string_agg(priv, ',' order by priv), '-')
    from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as priv
   where has_table_privilege(p_role, p_rel, priv)
$$;

-- ------------------------------------------------------------
-- part1: the five tables
-- ------------------------------------------------------------
select pg_temp.assert(pg_temp.privs('anon', 'public.' || t) = '-',
  'part1: anon holds nothing on public.' || t)
  from unnest(array['wishlist_items', 'book_reports', 'book_views',
                    'bundle_checkout_reservations', 'bundle_checkout_reader_holds']) as t;
select pg_temp.assert(pg_temp.privs('authenticated', 'public.wishlist_items') = 'DELETE,INSERT,SELECT'
  and pg_temp.privs('authenticated', 'public.book_reports') = 'INSERT,SELECT'
  and pg_temp.privs('authenticated', 'public.book_views') = 'SELECT'
  and pg_temp.privs('authenticated', 'public.bundle_checkout_reservations') = '-'
  and pg_temp.privs('authenticated', 'public.bundle_checkout_reader_holds') = '-',
  'part1: authenticated holds exactly what the policies allow');
select pg_temp.assert(has_table_privilege('service_role', 'public.' || t, 'SELECT, INSERT, UPDATE, DELETE')
  and has_table_privilege('service_role', 'public.' || t, 'SELECT')
  and has_table_privilege('service_role', 'public.' || t, 'INSERT')
  and has_table_privilege('service_role', 'public.' || t, 'UPDATE')
  and has_table_privilege('service_role', 'public.' || t, 'DELETE'),
  'part1: service_role keeps SELECT, INSERT, UPDATE, DELETE on public.' || t)
  from unnest(array['wishlist_items', 'book_reports', 'book_views',
                    'bundle_checkout_reservations', 'bundle_checkout_reader_holds']) as t;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0820000-0000-4000-8000-00000000000a', 'p082-a@test', now(), '{"role":"author","display_name":"P082 Ana"}'),
  ('e0820000-0000-4000-8000-0000000000a1', 'p082-r@test', now(), '{"role":"reader","display_name":"P082 Reader"}'),
  ('e0820000-0000-4000-8000-0000000000a2', 'p082-r2@test', now(), '{"role":"reader","display_name":"P082 Reader Two"}');
insert into public.books (id, author_id, title, description, status, price_all, published_at, file_path) values
  ('e0820001-0000-4000-8000-0000000000b1', 'e0820000-0000-4000-8000-00000000000a', 'P082 Live', 'About it.', 'published', 0, now(),
   'e0820000-0000-4000-8000-00000000000a/e0820001-0000-4000-8000-0000000000b1.epub');
insert into public.book_views (book_id) values ('e0820001-0000-4000-8000-0000000000b1'), ('e0820001-0000-4000-8000-0000000000b1');

-- What the application does as a signed-in reader or author.
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0820000-0000-4000-8000-0000000000a1',
  $q$insert into public.wishlist_items (reader_id, book_id) values ('e0820000-0000-4000-8000-0000000000a1', 'e0820001-0000-4000-8000-0000000000b1')$q$) = 'OK:1'
  and pg_temp.run_as('authenticated', 'e0820000-0000-4000-8000-0000000000a1',
  $q$select 1 from public.wishlist_items where reader_id = 'e0820000-0000-4000-8000-0000000000a1'$q$) = 'OK:1'
  and pg_temp.run_as('authenticated', 'e0820000-0000-4000-8000-0000000000a1',
  $q$delete from public.wishlist_items where book_id = 'e0820001-0000-4000-8000-0000000000b1' and reader_id = 'e0820000-0000-4000-8000-0000000000a1'$q$) = 'OK:1',
  'part1: a reader adds, reads and removes their own wishlist item');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0820000-0000-4000-8000-0000000000a1',
  $q$insert into public.book_reports (book_id, reporter_id, reason) values ('e0820001-0000-4000-8000-0000000000b1', 'e0820000-0000-4000-8000-0000000000a1', 'other')$q$) = 'OK:1',
  'part1: a reader reports a book');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0820000-0000-4000-8000-00000000000a',
  $q$select 1 from public.book_views where book_id = 'e0820001-0000-4000-8000-0000000000b1'$q$) = 'OK:2',
  'part1: an author reads their own book views');
-- RLS still decides rows: another reader sees nothing of the first's.
insert into public.wishlist_items (reader_id, book_id) values ('e0820000-0000-4000-8000-0000000000a1', 'e0820001-0000-4000-8000-0000000000b1');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0820000-0000-4000-8000-0000000000a2',
  $q$select 1 from public.wishlist_items$q$) = 'OK:0',
  'part1: RLS still hides another reader''s wishlist');

-- Everything else is refused by privilege (42501), before RLS.
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0820000-0000-4000-8000-0000000000a1', q) like '42501:%',
  'part1: authenticated refused: ' || q)
  from unnest(array[
    $q$update public.wishlist_items set book_id = book_id$q$,
    $q$update public.book_reports set details = 'x'$q$,
    $q$delete from public.book_reports$q$,
    $q$insert into public.book_views (book_id) values ('e0820001-0000-4000-8000-0000000000b1')$q$,
    $q$delete from public.book_views$q$,
    $q$select 1 from public.bundle_checkout_reservations$q$,
    $q$select 1 from public.bundle_checkout_reader_holds$q$,
    $q$truncate public.wishlist_items$q$
  ]) as q;
select pg_temp.assert(pg_temp.run_as('anon', null, q) like '42501:%',
  'part1: anon refused: ' || q)
  from unnest(array[
    $q$select 1 from public.wishlist_items$q$,
    $q$insert into public.wishlist_items (reader_id, book_id) values ('e0820000-0000-4000-8000-0000000000a1', 'e0820001-0000-4000-8000-0000000000b1')$q$,
    $q$select 1 from public.book_reports$q$,
    $q$insert into public.book_reports (book_id, reporter_id, reason) values ('e0820001-0000-4000-8000-0000000000b1', 'e0820000-0000-4000-8000-0000000000a1', 'other')$q$,
    $q$select 1 from public.book_views$q$,
    $q$delete from public.bundle_checkout_reservations$q$,
    $q$truncate public.bundle_checkout_reader_holds$q$
  ]) as q;
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$insert into public.book_views (book_id) values ('e0820001-0000-4000-8000-0000000000b1')$q$) = 'OK:1',
  'part1: the service role still records a book view');

-- ------------------------------------------------------------
-- part2: functions
-- ------------------------------------------------------------
select pg_temp.assert((select count(*) from unnest(array[
    'public.add_staff_member_by_email(text,text)',
    'public.begin_refund_issuance_attempt(uuid,text)',
    'public.books_enforce_pen_name()',
    'public.bundle_books_enforce_pen_name()',
    'public.bundles_check_member_pen_names()',
    'public.bundles_enforce_pen_name()',
    'public.cancel_refund_request(uuid)',
    'public.change_staff_role(uuid,text)',
    'public.clear_expired_book_reservations()',
    'public.clear_expired_reader_holds()',
    'public.complete_refund_issuance_attempt(uuid,text,text)',
    'public.create_blog_post(text,text,text,text,text,text,boolean,text,text)',
    'public.create_book_checkout_intent(uuid,text,boolean,uuid)',
    'public.create_bundle_checkout_snapshot(uuid,text,text,integer)',
    'public.delete_blog_post(uuid)',
    'public.enforce_book_checkout_intents_transition_rules()',
    'public.enforce_pok_book_checkout_orders_transition_rules()',
    'public.fail_refund_issuance_attempt(uuid,text)',
    'public.get_author_financial_summary()',
    'public.get_author_payout_overview()',
    'public.get_book_checkout_quote(uuid,uuid)',
    'public.get_finance_summary_counts()',
    'public.handle_new_user()',
    'public.is_admin()',
    'public.list_admin_audit_events(text,uuid,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,uuid,integer)',
    'public.list_author_financial_activity(integer,timestamp with time zone,uuid)',
    'public.list_author_payout_history(integer,timestamp with time zone,uuid)',
    'public.list_payout_batch_export(uuid)',
    'public.list_purchase_currencies(uuid[])',
    'public.list_refund_request_currencies(uuid[])',
    'public.list_staff_members()',
    'public.pen_name_follows_refuse_own()',
    'public.pen_names_after_update()',
    'public.pen_names_before_delete()',
    'public.pen_names_sync_profile_default()',
    'public.publish_blog_post(uuid)',
    'public.refund_reconciliation_rows()',
    'public.remove_staff_member(uuid)',
    'public.request_refund(text,text)',
    'public.review_book_report(uuid,text,text)',
    'public.review_refund_request(uuid,text,text)',
    'public.search_books(text,text,integer,integer,integer)',
    'public.series_enforce_pen_name()',
    'public.set_author_payout_destination(text,text,text)',
    'public.set_author_payout_threshold(text,bigint)',
    'public.set_pok_book_checkout_order_updated_at()',
    'public.staff_has_permission(text)',
    'public.staff_members_protect_last_owner()',
    'public.staff_profile_display_names(uuid[])',
    'public.staff_remove_pen_name_links(uuid)',
    'public.unpublish_blog_post(uuid)',
    'public.update_blog_post(uuid,text,text,text,text,text,text,boolean,text,text)',
    'public.user_owns_book(uuid)'
  ]) as f where has_function_privilege('service_role', f::regprocedure, 'EXECUTE')) = 53,
  'part2: service_role holds EXECUTE on all 53 functions');
select pg_temp.assert(not has_function_privilege('service_role', 'public.payment_intent_has_lost_dispute(text)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.author_lost_disputed_payment_intents()', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.author_lost_disputed_payment_intents()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.payment_intent_has_lost_dispute(text)', 'EXECUTE'),
  'part2: the two functions test 037 closes to service_role');
-- user_owns_book() calls payment_intent_has_lost_dispute() as its owner,
-- so a service-role read of public_books still works.
select pg_temp.assert(pg_temp.run_as('service_role', null, $q$select 1 from public.public_books$q$) like 'OK:%',
  'part2: the service role still reads public_books');

-- ------------------------------------------------------------
-- part3: closed by default for what postgres creates next
-- ------------------------------------------------------------
set local role postgres;
create table public.zz_082_new_table (id serial primary key);
create function public.zz_082_new_function() returns int language sql as $$ select 1 $$;
reset role;
select pg_temp.assert(pg_temp.privs(r, 'public.zz_082_new_table') = '-',
  'part3: a new table gives ' || r || ' nothing')
  from unnest(array['anon', 'authenticated', 'service_role']) as r;
select pg_temp.assert(not has_sequence_privilege(r, 'public.zz_082_new_table_id_seq', 'USAGE, SELECT, UPDATE'),
  'part3: a new sequence gives ' || r || ' nothing')
  from unnest(array['anon', 'authenticated', 'service_role']) as r;
select pg_temp.assert(not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                   where p.oid = 'public.zz_082_new_function()'::regprocedure
                                     and a.grantee = r::regrole),
  'part3: a new function gives ' || r || ' no EXECUTE of its own')
  from unnest(array['anon', 'authenticated', 'service_role']) as r;
-- PostgreSQL's global EXECUTE-for-PUBLIC default stays (see schema.sql);
-- the project rule is that every function revokes it, and part4 guards
-- what anon can reach.
select pg_temp.assert(exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                               where p.oid = 'public.zz_082_new_function()'::regprocedure and a.grantee = 0),
  'part3: PUBLIC keeps PostgreSQL''s own EXECUTE default (documented, not closed)');
drop function public.zz_082_new_function();

-- ------------------------------------------------------------
-- part4: anon can EXECUTE exactly these public functions (extension
-- functions aside). A new function anon can reach fails here until it
-- is added on purpose.
-- ------------------------------------------------------------
select pg_temp.assert(
  (select coalesce(string_agg(p.oid::regprocedure::text, ' ; ' order by p.oid::regprocedure::text), '-')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      and has_function_privilege('anon', p.oid, 'EXECUTE'))
  = 'enforce_author_payouts_immutability() ; enforce_book_rights_declarations_append_only() ; '
    || 'enforce_bundle_checkout_snapshots_financial_facts_immutability() ; enforce_payout_reversal_matches_original() ; '
    || 'pen_name_links_valid(jsonb) ; reject_payout_destination_snapshot_mutation() ; '
    || 'search_books(text,text,integer,integer,integer) ; staff_has_permission(text) ; user_owns_book(uuid)',
  'part4: anon can EXECUTE exactly the nine allowed public functions');

do $$
begin
  if (select n from pg_temp.assertions_run) <> 45 then
    raise exception 'FAIL: expected 45 assertions to run, found %', (select n from pg_temp.assertions_run);
  end if;
  raise warning '082_grants_tightening: % assertions passed', (select n from pg_temp.assertions_run);
end;
$$;

rollback;
