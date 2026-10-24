-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for DOWNLOADS-1
-- (supabase/migrations/20261024090000_book_downloads.sql):
--
-- * book_downloads: RLS on with no policy; service_role SELECT only;
--   anon, authenticated and PUBLIC nothing; nobody writes it directly;
-- * function EXECUTE: record_book_download() and
--   purchase_download_states() for service_role only,
--   my_purchase_download_states() for authenticated only;
-- * record_book_download(): records the purchase's payment at that
--   moment, the reader and the file key; refuses a missing reader or
--   book (LB470), a missing, empty or over-long key (LB471), and a
--   refunded, lost-disputed or missing purchase (LB472);
-- * the cancel window: open for 14 days from the payment while nothing
--   in that payment was downloaded; one download closes it for every
--   book of the same payment (a bundle); never open for a free book, a
--   legacy row, a refunded purchase, a lost dispute, a payment that is
--   not 'succeeded' or after 14 days; a refunded book bought again gets
--   a fresh window (the old payment's downloads do not count);
-- * my_purchase_download_states(): the caller's own rows, three columns;
-- * a deleted purchase takes its download rows with it; a deleted
--   account keeps them with reader_id null.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance (on 16 strip ", maintain" from a copy of schema.sql):
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/080_book_downloads.test.sql
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

-- One purchase_download_states() row as text, for a reader and a book.
create function pg_temp.state(p_reader uuid, p_book uuid) returns text
  language sql as $$
  select pg_temp.value_as('service_role', null, format(
    $f$select concat_ws('|', coalesce(payment_id::text, 'nopay'), download_count,
                         (first_downloaded_at is not null)::text,
                         (payment_first_downloaded_at is not null)::text,
                         coalesce(to_char(cancel_open_until at time zone 'UTC', 'YYYY-MM-DD HH24:MI'), 'closed'))
         from public.purchase_download_states(%L) where book_id = %L$f$, p_reader, p_book))
$$;

-- now() is the transaction's start, fixed for the whole test.
create function pg_temp.until(p_days_ago integer) returns text
  language sql as $$
  select to_char((now() - make_interval(days => p_days_ago) + interval '14 days') at time zone 'UTC',
                 'YYYY-MM-DD HH24:MI')
$$;

-- ============================================================
-- Part 0: fixtures.
--   A  author: b1 and b2 paid, b3 free
--   R  reader: bundle payment P1 (1 day ago) for b1 + b2; b3 free
--   R2 reader: P2 for b1, 20 days ago
--   R3 reader: P3 for b1, refunded
--   R4 reader: legacy Stripe purchase of b2 with a lost dispute
--   R5 reader: P4 for b1, still pending (never succeeded)
--   R6 reader: P5 for b1, downloaded, refunded, then bought again (P6)
--   N  reader with no purchase
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0800000-0000-4000-8000-00000000000a', 'd080-a@test', now(), '{"role":"author","display_name":"D080 Author"}'),
  ('e0800000-0000-4000-8000-0000000000a1', 'd080-r@test', now(), '{"role":"reader","display_name":"D080 R"}'),
  ('e0800000-0000-4000-8000-0000000000a2', 'd080-r2@test', now(), '{"role":"reader","display_name":"D080 R2"}'),
  ('e0800000-0000-4000-8000-0000000000a3', 'd080-r3@test', now(), '{"role":"reader","display_name":"D080 R3"}'),
  ('e0800000-0000-4000-8000-0000000000a4', 'd080-r4@test', now(), '{"role":"reader","display_name":"D080 R4"}'),
  ('e0800000-0000-4000-8000-0000000000a5', 'd080-r5@test', now(), '{"role":"reader","display_name":"D080 R5"}'),
  ('e0800000-0000-4000-8000-0000000000a6', 'd080-r6@test', now(), '{"role":"reader","display_name":"D080 R6"}'),
  ('e0800000-0000-4000-8000-0000000000ff', 'd080-n@test', now(), '{"role":"reader","display_name":"D080 N"}');

insert into public.books (id, author_id, title, description, status, price_all, published_at, file_path) values
  ('e0800001-0000-4000-8000-0000000000b1', 'e0800000-0000-4000-8000-00000000000a', 'D080 One', 'About it.', 'published', 499, now(),
   'e0800000-0000-4000-8000-00000000000a/e0800001-0000-4000-8000-0000000000b1.epub'),
  ('e0800001-0000-4000-8000-0000000000b2', 'e0800000-0000-4000-8000-00000000000a', 'D080 Two', 'About it.', 'published', 299, now(),
   'e0800000-0000-4000-8000-00000000000a/e0800001-0000-4000-8000-0000000000b2.epub'),
  ('e0800001-0000-4000-8000-0000000000b3', 'e0800000-0000-4000-8000-00000000000a', 'D080 Free', 'About it.', 'published', 0, now(),
   'e0800000-0000-4000-8000-00000000000a/e0800001-0000-4000-8000-0000000000b3.epub');

insert into public.payments (id, provider, provider_payment_id, buyer_id, amount_minor, currency, status, paid_at) values
  ('e0800002-0000-4000-8000-0000000000d1', 'pok', 'd080-p1', 'e0800000-0000-4000-8000-0000000000a1', 798, 'ALL', 'succeeded', now() - interval '1 day'),
  ('e0800002-0000-4000-8000-0000000000d2', 'pok', 'd080-p2', 'e0800000-0000-4000-8000-0000000000a2', 499, 'ALL', 'succeeded', now() - interval '20 days'),
  ('e0800002-0000-4000-8000-0000000000d3', 'pok', 'd080-p3', 'e0800000-0000-4000-8000-0000000000a3', 499, 'ALL', 'refunded', now() - interval '2 days'),
  ('e0800002-0000-4000-8000-0000000000d4', 'pok', 'd080-p4', 'e0800000-0000-4000-8000-0000000000a5', 499, 'ALL', 'pending', null),
  ('e0800002-0000-4000-8000-0000000000d5', 'pok', 'd080-p5', 'e0800000-0000-4000-8000-0000000000a6', 499, 'ALL', 'refunded', now() - interval '5 days'),
  ('e0800002-0000-4000-8000-0000000000d6', 'pok', 'd080-p6', 'e0800000-0000-4000-8000-0000000000a6', 499, 'ALL', 'succeeded', now() - interval '3 days');

insert into public.purchases (id, book_id, reader_id, amount_cents, payment_id, regime, stripe_payment_intent_id, refunded_at) values
  ('e0800003-0000-4000-8000-0000000000e1', 'e0800001-0000-4000-8000-0000000000b1', 'e0800000-0000-4000-8000-0000000000a1', 499,
   'e0800002-0000-4000-8000-0000000000d1', 'librum_ledger_v1', null, null),
  ('e0800003-0000-4000-8000-0000000000e2', 'e0800001-0000-4000-8000-0000000000b2', 'e0800000-0000-4000-8000-0000000000a1', 299,
   'e0800002-0000-4000-8000-0000000000d1', 'librum_ledger_v1', null, null),
  ('e0800003-0000-4000-8000-0000000000e3', 'e0800001-0000-4000-8000-0000000000b3', 'e0800000-0000-4000-8000-0000000000a1', 0,
   null, 'librum_ledger_v1', null, null),
  ('e0800003-0000-4000-8000-0000000000e4', 'e0800001-0000-4000-8000-0000000000b1', 'e0800000-0000-4000-8000-0000000000a2', 499,
   'e0800002-0000-4000-8000-0000000000d2', 'librum_ledger_v1', null, null),
  ('e0800003-0000-4000-8000-0000000000e5', 'e0800001-0000-4000-8000-0000000000b1', 'e0800000-0000-4000-8000-0000000000a3', 499,
   'e0800002-0000-4000-8000-0000000000d3', 'librum_ledger_v1', null, now() - interval '1 day'),
  ('e0800003-0000-4000-8000-0000000000e6', 'e0800001-0000-4000-8000-0000000000b2', 'e0800000-0000-4000-8000-0000000000a4', 299,
   null, 'legacy_stripe_connect_v1', 'pi_d080_lost', null),
  ('e0800003-0000-4000-8000-0000000000e7', 'e0800001-0000-4000-8000-0000000000b1', 'e0800000-0000-4000-8000-0000000000a5', 499,
   'e0800002-0000-4000-8000-0000000000d4', 'librum_ledger_v1', null, null),
  ('e0800003-0000-4000-8000-0000000000e8', 'e0800001-0000-4000-8000-0000000000b1', 'e0800000-0000-4000-8000-0000000000a6', 499,
   'e0800002-0000-4000-8000-0000000000d5', 'librum_ledger_v1', null, null);

insert into public.payment_disputes (stripe_dispute_id, stripe_payment_intent_id, status, amount_cents, reason)
values ('dp_d080', 'pi_d080_lost', 'lost', 299, 'fraudulent');

-- ============================================================
-- Part 1: privileges.
-- ============================================================
select pg_temp.assert(c.relrowsecurity, 'p1: RLS is on')
  from pg_class c where c.oid = 'public.book_downloads'::regclass;
select pg_temp.assert(not exists (select 1 from pg_policy where polrelid = 'public.book_downloads'::regclass),
  'p1: no policy on book_downloads');

do $$
declare
  v_role text;
  v_priv text;
begin
  foreach v_role in array array['anon', 'authenticated', 'public'] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
      perform pg_temp.assert(
        not has_table_privilege(v_role, 'public.book_downloads', v_priv),
        format('p1: %s holds no %s on book_downloads', v_role, v_priv));
    end loop;
  end loop;
  perform pg_temp.assert(has_table_privilege('service_role', 'public.book_downloads', 'SELECT'),
    'p1: service_role reads book_downloads');
  foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
    perform pg_temp.assert(
      not has_table_privilege('service_role', 'public.book_downloads', v_priv),
      format('p1: service_role holds no %s on book_downloads', v_priv));
  end loop;
end $$;

select pg_temp.assert(
  has_function_privilege(r, 'public.record_book_download(uuid, uuid, text)', 'EXECUTE') = (r = 'service_role'),
  'p1: record_book_download EXECUTE for service_role only: ' || r)
  from unnest(array['anon', 'authenticated', 'service_role', 'public']) r;
select pg_temp.assert(
  has_function_privilege(r, 'public.purchase_download_states(uuid)', 'EXECUTE') = (r = 'service_role'),
  'p1: purchase_download_states EXECUTE for service_role only: ' || r)
  from unnest(array['anon', 'authenticated', 'service_role', 'public']) r;
select pg_temp.assert(
  has_function_privilege(r, 'public.my_purchase_download_states()', 'EXECUTE') = (r = 'authenticated'),
  'p1: my_purchase_download_states EXECUTE for authenticated only: ' || r)
  from unnest(array['anon', 'authenticated', 'service_role', 'public']) r;

select pg_temp.assert(p.prosecdef and p.proconfig = array['search_path=""'],
  'p1: security definer with an empty search_path: ' || p.proname)
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('record_book_download', 'purchase_download_states', 'my_purchase_download_states');

select pg_temp.assert(
  pg_temp.run_as('service_role', null, $q$insert into public.book_downloads (purchase_id, file_path)
     values ('e0800003-0000-4000-8000-0000000000e1', 'x')$q$) like '42501:%',
  'p1: service_role cannot insert directly');
select pg_temp.assert(
  pg_temp.run_as('authenticated', 'e0800000-0000-4000-8000-0000000000a1',
    $q$select * from public.book_downloads$q$) like '42501:%',
  'p1: a buyer cannot read the table');
select pg_temp.assert(
  pg_temp.run_as('authenticated', 'e0800000-0000-4000-8000-0000000000a1',
    $q$select public.record_book_download('e0800000-0000-4000-8000-0000000000a1',
        'e0800001-0000-4000-8000-0000000000b1', 'x')$q$) like '42501:%',
  'p1: a buyer cannot record a download');

-- ============================================================
-- Part 2: the cancel window before any download.
-- ============================================================
select pg_temp.assert(
  pg_temp.state('e0800000-0000-4000-8000-0000000000a1', 'e0800001-0000-4000-8000-0000000000b1')
    = 'e0800002-0000-4000-8000-0000000000d1|0|false|false|' || pg_temp.until(1),
  'p2: R b1 open until P1 + 14 days');
select pg_temp.assert(
  pg_temp.state('e0800000-0000-4000-8000-0000000000a1', 'e0800001-0000-4000-8000-0000000000b2')
    = 'e0800002-0000-4000-8000-0000000000d1|0|false|false|' || pg_temp.until(1),
  'p2: R b2 open until P1 + 14 days');
select pg_temp.assert(
  pg_temp.state('e0800000-0000-4000-8000-0000000000a1', 'e0800001-0000-4000-8000-0000000000b3')
    = 'nopay|0|false|false|closed', 'p2: a free book never has a cancel window');
select pg_temp.assert(
  pg_temp.state('e0800000-0000-4000-8000-0000000000a2', 'e0800001-0000-4000-8000-0000000000b1') like '%|closed',
  'p2: closed after 14 days');
select pg_temp.assert(
  pg_temp.state('e0800000-0000-4000-8000-0000000000a3', 'e0800001-0000-4000-8000-0000000000b1') like '%|closed',
  'p2: closed when refunded');
select pg_temp.assert(
  pg_temp.state('e0800000-0000-4000-8000-0000000000a4', 'e0800001-0000-4000-8000-0000000000b2') = 'nopay|0|false|false|closed',
  'p2: closed for a legacy row with a lost dispute');
select pg_temp.assert(
  pg_temp.state('e0800000-0000-4000-8000-0000000000a5', 'e0800001-0000-4000-8000-0000000000b1') like '%|closed',
  'p2: closed for a payment that never succeeded');
select pg_temp.assert(
  pg_temp.value_as('service_role', null,
    $q$select count(*)::text from public.purchase_download_states('e0800000-0000-4000-8000-0000000000ff')$q$) = '0',
  'p2: no rows for an account without purchases');
select pg_temp.assert(
  pg_temp.value_as('service_role', null,
    $q$select count(*)::text from public.purchase_download_states(null)$q$) = '0',
  'p2: no rows for a null account');
select pg_temp.assert(
  pg_temp.value_as('service_role', null,
    $q$select concat_ws('|', amount_minor, currency, (bought_at = now() - interval '1 day')::text, (refunded_at is null)::text)
         from public.purchase_download_states('e0800000-0000-4000-8000-0000000000a1')
        where book_id = 'e0800001-0000-4000-8000-0000000000b1'$q$) = '499|ALL|true|true',
  'p2: amount, currency, bought_at = paid_at');

-- ============================================================
-- Part 3: record_book_download.
-- ============================================================
select pg_temp.assert(
  pg_temp.value_as('service_role', null,
    $q$select (public.record_book_download('e0800000-0000-4000-8000-0000000000a1',
        'e0800001-0000-4000-8000-0000000000b1',
        'e0800000-0000-4000-8000-00000000000a/e0800001-0000-4000-8000-0000000000b1.epub') is not null)::text$q$) = 'true',
  'p3: R downloads b1');
select pg_temp.assert(
  (select count(*) = 1 from public.book_downloads d
    where d.purchase_id = 'e0800003-0000-4000-8000-0000000000e1'
      and d.payment_id = 'e0800002-0000-4000-8000-0000000000d1'
      and d.reader_id = 'e0800000-0000-4000-8000-0000000000a1'
      and d.file_path = 'e0800000-0000-4000-8000-00000000000a/e0800001-0000-4000-8000-0000000000b1.epub'
      and d.downloaded_at = now()),
  'p3: the row holds the purchase, its payment, the reader, the key and the time');
select pg_temp.assert(
  pg_temp.state('e0800000-0000-4000-8000-0000000000a1', 'e0800001-0000-4000-8000-0000000000b1')
    = 'e0800002-0000-4000-8000-0000000000d1|1|true|true|closed',
  'p3: downloading b1 closes its window');
select pg_temp.assert(
  pg_temp.state('e0800000-0000-4000-8000-0000000000a1', 'e0800001-0000-4000-8000-0000000000b2')
    = 'e0800002-0000-4000-8000-0000000000d1|0|false|true|closed',
  'p3: downloading b1 closes b2 too (same payment, a bundle)');

select pg_temp.assert(
  pg_temp.run_as('service_role', null, $q$select public.record_book_download(null,
     'e0800001-0000-4000-8000-0000000000b1', 'x')$q$) like 'LB470:%', 'p3: null reader LB470');
select pg_temp.assert(
  pg_temp.run_as('service_role', null, $q$select public.record_book_download(
     'e0800000-0000-4000-8000-0000000000a1', null, 'x')$q$) like 'LB470:%', 'p3: null book LB470');
select pg_temp.assert(
  pg_temp.run_as('service_role', null, $q$select public.record_book_download(
     'e0800000-0000-4000-8000-0000000000a1', 'e0800001-0000-4000-8000-0000000000b2', null)$q$) like 'LB471:%',
  'p3: null key LB471');
select pg_temp.assert(
  pg_temp.run_as('service_role', null, $q$select public.record_book_download(
     'e0800000-0000-4000-8000-0000000000a1', 'e0800001-0000-4000-8000-0000000000b2', '')$q$) like 'LB471:%',
  'p3: empty key LB471');
select pg_temp.assert(
  pg_temp.run_as('service_role', null, format($q$select public.record_book_download(
     'e0800000-0000-4000-8000-0000000000a1', 'e0800001-0000-4000-8000-0000000000b2', %L)$q$, repeat('x', 1025))) like 'LB471:%',
  'p3: 1025-character key LB471');
select pg_temp.assert(
  pg_temp.run_as('service_role', null, format($q$select public.record_book_download(
     'e0800000-0000-4000-8000-0000000000a1', 'e0800001-0000-4000-8000-0000000000b2', %L)$q$, repeat('x', 1024))) = 'OK:1',
  'p3: 1024-character key accepted');
select pg_temp.assert(
  pg_temp.run_as('service_role', null, $q$select public.record_book_download(
     'e0800000-0000-4000-8000-0000000000a3', 'e0800001-0000-4000-8000-0000000000b1', 'x')$q$) like 'LB472:%',
  'p3: refunded purchase LB472');
select pg_temp.assert(
  pg_temp.run_as('service_role', null, $q$select public.record_book_download(
     'e0800000-0000-4000-8000-0000000000a4', 'e0800001-0000-4000-8000-0000000000b2', 'x')$q$) like 'LB472:%',
  'p3: lost dispute LB472');
select pg_temp.assert(
  pg_temp.run_as('service_role', null, $q$select public.record_book_download(
     'e0800000-0000-4000-8000-0000000000ff', 'e0800001-0000-4000-8000-0000000000b1', 'x')$q$) like 'LB472:%',
  'p3: no purchase LB472');
select pg_temp.assert(
  pg_temp.run_as('service_role', null, $q$select public.record_book_download(
     'e0800000-0000-4000-8000-0000000000a1', 'e0800001-0000-4000-8000-00000000ffff', 'x')$q$) like 'LB472:%',
  'p3: unknown book LB472');
select pg_temp.assert(
  (select count(*) = 2 from public.book_downloads), 'p3: refusals wrote nothing');

-- A free book: recorded with no payment, never a window.
select pg_temp.assert(
  pg_temp.run_as('service_role', null, $q$select public.record_book_download(
     'e0800000-0000-4000-8000-0000000000a1', 'e0800001-0000-4000-8000-0000000000b3', 'k3')$q$) = 'OK:1',
  'p3: a free download is recorded');
select pg_temp.assert(
  pg_temp.state('e0800000-0000-4000-8000-0000000000a1', 'e0800001-0000-4000-8000-0000000000b3') = 'nopay|1|true|false|closed',
  'p3: a free download has no payment and no window');

-- ============================================================
-- Part 4: a refunded book bought again gets a fresh window.
-- ============================================================
select pg_temp.assert(
  pg_temp.run_as('service_role', null, $q$select public.record_book_download(
     'e0800000-0000-4000-8000-0000000000a6', 'e0800001-0000-4000-8000-0000000000b1', 'old')$q$) = 'OK:1',
  'p4: R6 downloads under P5');
update public.purchases set refunded_at = now() where id = 'e0800003-0000-4000-8000-0000000000e8';
update public.purchases set refunded_at = null, payment_id = 'e0800002-0000-4000-8000-0000000000d6'
 where id = 'e0800003-0000-4000-8000-0000000000e8';
select pg_temp.assert(
  pg_temp.state('e0800000-0000-4000-8000-0000000000a6', 'e0800001-0000-4000-8000-0000000000b1')
    = 'e0800002-0000-4000-8000-0000000000d6|0|false|false|' || pg_temp.until(3),
  'p4: the old payment''s download does not count against the new one');
select pg_temp.assert(
  pg_temp.run_as('service_role', null, $q$select public.record_book_download(
     'e0800000-0000-4000-8000-0000000000a6', 'e0800001-0000-4000-8000-0000000000b1', 'new')$q$) = 'OK:1',
  'p4: R6 downloads under P6');
select pg_temp.assert(
  pg_temp.state('e0800000-0000-4000-8000-0000000000a6', 'e0800001-0000-4000-8000-0000000000b1')
    = 'e0800002-0000-4000-8000-0000000000d6|1|true|true|closed',
  'p4: and now it is closed');

-- ============================================================
-- Part 5: the buyer's own view.
-- ============================================================
select pg_temp.assert(
  pg_temp.value_as('authenticated', 'e0800000-0000-4000-8000-0000000000a1',
    $q$select string_agg(concat_ws('|', book_id, (first_downloaded_at is not null)::text, (cancel_open_until is not null)::text), ',' order by book_id)
         from public.my_purchase_download_states()$q$)
    = 'e0800001-0000-4000-8000-0000000000b1|true|false,e0800001-0000-4000-8000-0000000000b2|true|false,e0800001-0000-4000-8000-0000000000b3|true|false',
  'p5: R sees exactly their three rows');
select pg_temp.assert(
  pg_temp.value_as('authenticated', 'e0800000-0000-4000-8000-0000000000a2',
    $q$select string_agg(book_id::text, ',') from public.my_purchase_download_states()$q$)
    = 'e0800001-0000-4000-8000-0000000000b1',
  'p5: R2 sees only their own row');
select pg_temp.assert(
  pg_temp.value_as('authenticated', 'e0800000-0000-4000-8000-0000000000a6',
    $q$select (cancel_open_until is null)::text from public.my_purchase_download_states()$q$) = 'true',
  'p5: R6 closed');
select pg_temp.assert(
  pg_temp.value_as('authenticated', null,
    $q$select count(*)::text from public.my_purchase_download_states()$q$) = '0',
  'p5: no session, no rows');
select pg_temp.assert(
  pg_temp.run_as('anon', null, $q$select * from public.my_purchase_download_states()$q$) like '42501:%',
  'p5: anon cannot call it');
select pg_temp.assert(
  (select string_agg(a.attname, ',' order by a.attnum)
     from pg_proc p, unnest(p.proargnames) with ordinality a(attname, attnum)
    where p.oid = 'public.my_purchase_download_states()'::regprocedure)
    = 'book_id,first_downloaded_at,cancel_open_until',
  'p5: three columns, no payment id and no file key');

-- An open window seen by the buyer: R5's pending payment succeeds.
update public.payments set status = 'succeeded', paid_at = now() - interval '2 days'
 where id = 'e0800002-0000-4000-8000-0000000000d4';
select pg_temp.assert(
  pg_temp.value_as('authenticated', 'e0800000-0000-4000-8000-0000000000a5',
    $q$select to_char(cancel_open_until at time zone 'UTC', 'YYYY-MM-DD HH24:MI') from public.my_purchase_download_states()$q$)
    = pg_temp.until(2),
  'p5: R5 sees the open window');

-- ============================================================
-- Part 6: retention.
-- ============================================================
delete from auth.users where id = 'e0800000-0000-4000-8000-0000000000a1';
select pg_temp.assert(
  (select count(*) = 3 and bool_and(reader_id is null) from public.book_downloads
    where purchase_id in ('e0800003-0000-4000-8000-0000000000e1', 'e0800003-0000-4000-8000-0000000000e2',
                          'e0800003-0000-4000-8000-0000000000e3')),
  'p6: a deleted account keeps its download rows, without the account');
delete from public.purchases where id = 'e0800003-0000-4000-8000-0000000000e8';
select pg_temp.assert(
  not exists (select 1 from public.book_downloads where purchase_id = 'e0800003-0000-4000-8000-0000000000e8'),
  'p6: a deleted purchase takes its download rows with it');

select pg_temp.assert(true, 'done');
do $$
declare v_n int;
begin
  select n into v_n from pg_temp.assertions_run;
  raise notice 'ALL PASSED: 080_book_downloads.test.sql (% assertions)', v_n;
end $$;

rollback;
