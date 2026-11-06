-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for BD16 CF1
-- (supabase/migrations/20261106200000_bd16_free_claim_guard.sql): a free
-- claim (a purchases row whose session id starts with 'free_') is saved
-- only while the book is live.
-- * part1  the trigger and its function: SECURITY DEFINER, empty
--          search_path, no role may execute it;
-- * part2  a new free claim: live saves; pre-order, unpublished draft
--          and taken-down book refused (LB509), nothing written;
-- * part3  getFreeBook()'s exact upsert over a refunded row: refused on
--          a book that isn't live, saved on a live one;
-- * part4  an existing free claim on a book that is no longer live:
--          kept, other changes and the reader detach still work;
--          clearing refunded_at or moving it to another book refused;
-- * part5  paid, ledger and bundle rows are never touched, even at 0
--          or over an old free row.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/096_bd16_free_claim_guard.test.sql
--
-- Against the BASE schema it fails at part1 (no trigger): the negative
-- control. The rollback is 096_bd16_free_claim_guard.rollback.sql.

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

-- getFreeBook()'s write, as the service role, exactly as the app sends
-- it (upsert on book_id, reader_id).
create function pg_temp.claim(p_book uuid, p_reader uuid) returns text language sql as $$
  select pg_temp.run_as('service_role', format(
    'insert into public.purchases as p (book_id, reader_id, amount_cents, stripe_checkout_session_id, stripe_payment_intent_id, refunded_at)
     values (%L, %L, 0, %L, null, null)
     on conflict (book_id, reader_id) do update set
       amount_cents = excluded.amount_cents,
       stripe_checkout_session_id = excluded.stripe_checkout_session_id,
       stripe_payment_intent_id = excluded.stripe_payment_intent_id,
       refunded_at = excluded.refunded_at',
    p_book, p_reader, 'free_' || gen_random_uuid()))
$$;

create function pg_temp.rows(p_book uuid) returns bigint language sql as $$
  select count(*) from public.purchases where book_id = p_book
$$;

-- ============================================================
-- Fixture: author A, readers R1..R4. Free books: L live, P a pre-order,
-- D an unpublished draft, T taken down (a draft with a takedown).
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0960000-0000-4000-8000-00000000000a', 'p096-a@test', now(), '{"role":"author","display_name":"P096 Ana"}'),
  ('e0960000-0000-4000-8000-0000000000d1', 'p096-r1@test', now(), '{"role":"reader","display_name":"P096 R1"}'),
  ('e0960000-0000-4000-8000-0000000000d2', 'p096-r2@test', now(), '{"role":"reader","display_name":"P096 R2"}'),
  ('e0960000-0000-4000-8000-0000000000d3', 'p096-r3@test', now(), '{"role":"reader","display_name":"P096 R3"}'),
  ('e0960000-0000-4000-8000-0000000000d4', 'p096-r4@test', now(), '{"role":"reader","display_name":"P096 R4"}');

insert into public.books (id, author_id, title, price_all, status, published_at) values
  ('e0960001-0000-4000-8000-00000000000a', 'e0960000-0000-4000-8000-00000000000a', 'P096 Live', 0, 'published', now()),
  ('e0960001-0000-4000-8000-00000000000d', 'e0960000-0000-4000-8000-00000000000a', 'P096 Draft', 0, 'draft', null),
  ('e0960001-0000-4000-8000-00000000000e', 'e0960000-0000-4000-8000-00000000000a', 'P096 Was live', 0, 'published', now());

insert into public.books (id, author_id, title, price_all, status, release_date, preorder_listed_at, preorder_count) values
  ('e0960001-0000-4000-8000-00000000000b', 'e0960000-0000-4000-8000-00000000000a', 'P096 Pre-order', 0, 'preorder',
   public.tirana_today() + 20, now(), 1);

insert into public.books (id, author_id, title, price_all, status, published_at) values
  ('e0960001-0000-4000-8000-00000000000c', 'e0960000-0000-4000-8000-00000000000a', 'P096 Taken down', 0, 'draft', now());
insert into public.book_takedowns (book_id, book_title, author_id, reason, message_to_author) values
  ('e0960001-0000-4000-8000-00000000000c', 'P096 Taken down', 'e0960000-0000-4000-8000-00000000000a', 'copyright', 'P096 test.');

-- ============================================================
-- Part 1: the trigger and its function
-- ============================================================
select pg_temp.assert(
  (select count(*) from pg_trigger t
    where t.tgrelid = 'public.purchases'::regclass and t.tgname = 'purchases_free_claim_live_only'
      and not t.tgisinternal and t.tgenabled = 'O'
      and t.tgfoid = 'public.purchases_free_claim_live_only()'::regprocedure
      -- ROW (1) + BEFORE (2) + INSERT (4) + UPDATE (16) = 23
      and t.tgtype = 23) = 1,
  'part1: one BEFORE INSERT OR UPDATE row trigger on purchases');
select pg_temp.assert(
  (select p.prosecdef and p.proconfig = array['search_path=""']
     from pg_proc p where p.oid = 'public.purchases_free_claim_live_only()'::regprocedure),
  'part1: SECURITY DEFINER with an empty search_path');
select pg_temp.assert(
  not has_function_privilege('anon', 'public.purchases_free_claim_live_only()', 'execute')
  and not has_function_privilege('authenticated', 'public.purchases_free_claim_live_only()', 'execute')
  and not has_function_privilege('service_role', 'public.purchases_free_claim_live_only()', 'execute'),
  'part1: no API role may execute the trigger function');

-- ============================================================
-- Part 2: a new free claim
-- ============================================================
select pg_temp.assert(pg_temp.claim('e0960001-0000-4000-8000-00000000000a', 'e0960000-0000-4000-8000-0000000000d1') = 'OK:1',
  'part2: a live free book is claimed');
select pg_temp.assert(pg_temp.claim('e0960001-0000-4000-8000-00000000000b', 'e0960000-0000-4000-8000-0000000000d1')
  = 'LB509:A free book can be claimed only while it is live.',
  'part2: a pre-order is refused with LB509');
select pg_temp.assert(pg_temp.claim('e0960001-0000-4000-8000-00000000000d', 'e0960000-0000-4000-8000-0000000000d1') like 'LB509:%',
  'part2: an unpublished draft is refused');
select pg_temp.assert(pg_temp.claim('e0960001-0000-4000-8000-00000000000c', 'e0960000-0000-4000-8000-0000000000d1') like 'LB509:%',
  'part2: a taken-down book is refused');
select pg_temp.assert(
  pg_temp.rows('e0960001-0000-4000-8000-00000000000b') = 0
  and pg_temp.rows('e0960001-0000-4000-8000-00000000000c') = 0
  and pg_temp.rows('e0960001-0000-4000-8000-00000000000d') = 0,
  'part2: nothing written for the refused claims');
select pg_temp.assert(pg_temp.run_as(null,
  $q$insert into public.purchases (book_id, reader_id, amount_cents, stripe_checkout_session_id)
     values ('e0960001-0000-4000-8000-00000000000b', 'e0960000-0000-4000-8000-0000000000d2', 0, 'free_owner')$q$) like 'LB509:%',
  'part2: the table owner is refused too');

-- ============================================================
-- Part 3: getFreeBook()'s upsert over a refunded row
-- ============================================================
-- R2 holds a refunded paid row on the draft D and on the live L.
insert into public.purchases (book_id, reader_id, amount_cents, stripe_checkout_session_id, stripe_payment_intent_id, refunded_at) values
  ('e0960001-0000-4000-8000-00000000000d', 'e0960000-0000-4000-8000-0000000000d2', 19900, 'cs_p096_d', 'pi_p096_d', now()),
  ('e0960001-0000-4000-8000-00000000000a', 'e0960000-0000-4000-8000-0000000000d2', 19900, 'cs_p096_l', 'pi_p096_l', now());
select pg_temp.assert(pg_temp.claim('e0960001-0000-4000-8000-00000000000d', 'e0960000-0000-4000-8000-0000000000d2') like 'LB509:%',
  'part3: the upsert over a refunded row is refused on a book that is not live');
select pg_temp.assert(
  (select stripe_checkout_session_id = 'cs_p096_d' and refunded_at is not null
     from public.purchases where book_id = 'e0960001-0000-4000-8000-00000000000d'
      and reader_id = 'e0960000-0000-4000-8000-0000000000d2'),
  'part3: the refunded row is left as it was');
select pg_temp.assert(pg_temp.claim('e0960001-0000-4000-8000-00000000000a', 'e0960000-0000-4000-8000-0000000000d2') = 'OK:1',
  'part3: the same upsert on a live book re-claims it');
select pg_temp.assert(
  (select stripe_checkout_session_id like 'free\_%' and refunded_at is null and amount_cents = 0
     from public.purchases where book_id = 'e0960001-0000-4000-8000-00000000000a'
      and reader_id = 'e0960000-0000-4000-8000-0000000000d2'),
  'part3: and the row is now the free claim');

-- ============================================================
-- Part 4: an existing free claim on a book that is no longer live
-- ============================================================
-- R3 claimed E while it was live (one row refunded, for the test of
-- clearing refunded_at); then E is unpublished.
select pg_temp.assert(pg_temp.claim('e0960001-0000-4000-8000-00000000000e', 'e0960000-0000-4000-8000-0000000000d3') = 'OK:1',
  'part4: R3 claims E while it is live');
select pg_temp.assert(pg_temp.claim('e0960001-0000-4000-8000-00000000000e', 'e0960000-0000-4000-8000-0000000000d4') = 'OK:1',
  'part4: R4 claims E while it is live');
update public.purchases set refunded_at = now()
 where book_id = 'e0960001-0000-4000-8000-00000000000e' and reader_id = 'e0960000-0000-4000-8000-0000000000d4';
update public.books set status = 'draft' where id = 'e0960001-0000-4000-8000-00000000000e';
select pg_temp.assert((select status from public.books where id = 'e0960001-0000-4000-8000-00000000000e') = 'draft',
  'part4: E is unpublished');

select pg_temp.assert(pg_temp.claim('e0960001-0000-4000-8000-00000000000e', 'e0960000-0000-4000-8000-0000000000d3') like 'LB509:%',
  'part4: claiming E again (a new free_ id) is refused');
select pg_temp.assert(pg_temp.run_as('service_role',
  $q$update public.purchases set created_at = created_at
      where book_id = 'e0960001-0000-4000-8000-00000000000e' and reader_id = 'e0960000-0000-4000-8000-0000000000d3'$q$) = 'OK:1',
  'part4: any other change to R3''s existing row still works');
select pg_temp.assert(pg_temp.run_as('service_role',
  $q$update public.purchases set refunded_at = now()
      where book_id = 'e0960001-0000-4000-8000-00000000000e' and reader_id = 'e0960000-0000-4000-8000-0000000000d3'$q$) = 'OK:1',
  'part4: setting refunded_at still works');
select pg_temp.assert(pg_temp.run_as('service_role',
  $q$update public.purchases set refunded_at = null
      where book_id = 'e0960001-0000-4000-8000-00000000000e' and reader_id = 'e0960000-0000-4000-8000-0000000000d4'$q$) like 'LB509:%',
  'part4: clearing refunded_at (a new claim) is refused');
select pg_temp.assert(pg_temp.run_as('service_role',
  $q$update public.purchases set book_id = 'e0960001-0000-4000-8000-00000000000b'
      where book_id = 'e0960001-0000-4000-8000-00000000000a' and reader_id = 'e0960000-0000-4000-8000-0000000000d1'$q$) like 'LB509:%',
  'part4: moving a live free claim onto a pre-order is refused');
select pg_temp.assert(pg_temp.run_as('service_role',
  $q$update public.purchases set reader_id = 'e0960000-0000-4000-8000-0000000000d4'
      where book_id = 'e0960001-0000-4000-8000-00000000000e' and reader_id = 'e0960000-0000-4000-8000-0000000000d3'$q$) like 'LB509:%',
  'part4: handing an existing free claim on E to another reader is refused');
-- R3's account is deleted: the row stays, its reader is set to null.
select pg_temp.assert(pg_temp.run_as(null,
  $q$delete from public.profiles where id = 'e0960000-0000-4000-8000-0000000000d3'$q$) = 'OK:1',
  'part4: deleting R3''s profile is not blocked');
select pg_temp.assert(
  (select count(*) from public.purchases
    where book_id = 'e0960001-0000-4000-8000-00000000000e' and reader_id is null) = 1,
  'part4: R3''s free claim is kept, detached from the deleted profile');

-- ============================================================
-- Part 5: paid and ledger rows are never touched
-- ============================================================
select pg_temp.assert(pg_temp.run_as('service_role',
  $q$insert into public.purchases (book_id, reader_id, amount_cents, stripe_checkout_session_id, stripe_payment_intent_id)
     values ('e0960001-0000-4000-8000-00000000000d', 'e0960000-0000-4000-8000-0000000000d1', 0, 'cs_p096_full_discount', null)$q$) = 'OK:1',
  'part5: a paid row at 0 (full discount) on a draft is saved');
select pg_temp.assert(pg_temp.run_as('service_role',
  $q$insert into public.purchases (book_id, reader_id, amount_cents, stripe_checkout_session_id, stripe_payment_intent_id)
     values ('e0960001-0000-4000-8000-00000000000b', 'e0960000-0000-4000-8000-0000000000d4', 0, null, 'pok_p096_share')$q$) = 'OK:1',
  'part5: a ledger row (no session id) at 0 on a pre-order is saved');
-- A bundle sale upserted over R4's refunded free row on E (the bundle
-- path keeps the session id and sets the paid share): saved.
select pg_temp.assert(pg_temp.run_as('service_role',
  $q$insert into public.purchases (book_id, reader_id, amount_cents, stripe_checkout_session_id, stripe_payment_intent_id, refunded_at)
     values ('e0960001-0000-4000-8000-00000000000e', 'e0960000-0000-4000-8000-0000000000d4', 150, null, 'pok_p096_bundle', null)
     on conflict (book_id, reader_id) do update set
       stripe_payment_intent_id = excluded.stripe_payment_intent_id,
       amount_cents = excluded.amount_cents,
       refunded_at = null$q$) = 'OK:1',
  'part5: a paid bundle share over an old free row on a draft is saved');
select pg_temp.assert(
  (select stripe_checkout_session_id like 'free\_%' and amount_cents = 150 and refunded_at is null
     from public.purchases where book_id = 'e0960001-0000-4000-8000-00000000000e'
      and reader_id = 'e0960000-0000-4000-8000-0000000000d4'),
  'part5: and the row now carries the paid share');
-- Audit r1 L1: a free book inside a paid bundle (share 0) over a
-- refunded free row, on a book that is no longer live: still granted.
insert into public.books (id, author_id, title, price_all, status, published_at) values
  ('e0960001-0000-4000-8000-00000000000f', 'e0960000-0000-4000-8000-00000000000a', 'P096 Bundle free', 0, 'published', now());
select pg_temp.assert(pg_temp.claim('e0960001-0000-4000-8000-00000000000f', 'e0960000-0000-4000-8000-0000000000d1') = 'OK:1',
  'part5: R1 claims F while it is live');
update public.purchases set refunded_at = now()
 where book_id = 'e0960001-0000-4000-8000-00000000000f' and reader_id = 'e0960000-0000-4000-8000-0000000000d1';
update public.books set status = 'draft' where id = 'e0960001-0000-4000-8000-00000000000f';
select pg_temp.assert(pg_temp.run_as('service_role',
  $q$insert into public.purchases (book_id, reader_id, amount_cents, stripe_checkout_session_id, stripe_payment_intent_id, refunded_at)
     values ('e0960001-0000-4000-8000-00000000000f', 'e0960000-0000-4000-8000-0000000000d1', 0, null, 'pok_p096_bundle0', null)
     on conflict (book_id, reader_id) do update set
       stripe_payment_intent_id = excluded.stripe_payment_intent_id,
       amount_cents = excluded.amount_cents,
       refunded_at = null$q$) = 'OK:1',
  'part5: a paid bundle share of 0 over a refunded free row on a draft is saved');
select pg_temp.assert(
  (select stripe_payment_intent_id = 'pok_p096_bundle0' and refunded_at is null
     from public.purchases where book_id = 'e0960001-0000-4000-8000-00000000000f'
      and reader_id = 'e0960000-0000-4000-8000-0000000000d1'),
  'part5: and the bundle grant stands');
select pg_temp.assert(pg_temp.run_as('service_role',
  $q$update public.purchases set stripe_payment_intent_id = null, refunded_at = now()
      where book_id = 'e0960001-0000-4000-8000-00000000000f' and reader_id = 'e0960000-0000-4000-8000-0000000000d1'$q$) = 'OK:1',
  'part5: (setup) the row refunded again with no payment id');
select pg_temp.assert(pg_temp.run_as('service_role',
  $q$update public.purchases set refunded_at = null
      where book_id = 'e0960001-0000-4000-8000-00000000000f' and reader_id = 'e0960000-0000-4000-8000-0000000000d1'$q$) like 'LB509:%',
  'part5: without a payment id, clearing refunded_at on F is still refused');

do $$
begin
  perform pg_temp.assert((select n from pg_temp.assertions_run) >= 25,
    format('expected at least 25 assertions, ran %s', (select n from pg_temp.assertions_run)));
end $$;

select 'ALL PASSED: 096_bd16_free_claim_guard.test.sql (' || (select n from pg_temp.assertions_run) || ' assertions)' as result;

rollback;
