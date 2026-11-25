-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for gifts
-- (supabase/migrations/20261125140000_cart_gifts.sql):
--
-- * part1 the table: row level security on; anon has nothing;
--   authenticated reads only the listed columns (never token_hash or
--   claimed_by) and writes nothing; the buyer sees only their own gifts.
-- * part2 gift_preview: book, buyer's first name, note, state for a good
--   token (signed out too); nothing for a wrong or short token.
-- * part3 claim_gift: signed out -> 'signed_out'; the buyer -> 'own_gift';
--   a reader who owns the book -> 'owned' (gift stays open, g3 a); another
--   reader -> 'claimed' with a purchases row (amount 0, 'gift_<id>'),
--   then the link -> 'used'. Wrong token -> 'invalid'.
-- * part4 gift_resend / gift_change_email (b2q3 a): only the buyer
--   (LB530); once a day (LB532); at most 3 emails to an address
--   (LB531), the same address again counts on (audit F2); a new email
--   starts a new count and reopens a recipient_owns gift; a claimed gift
--   can't be resent (LB533); a bad email (LB534). Two steps (audit S1):
--   a send is PENDING until gift_confirm_send (then the new link is live
--   and the old one stops working); gift_cancel_send after a failed
--   email uses nothing up; one pending send at a time (LB535); only the
--   pending link can be confirmed (LB536).
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/118_cart_gifts.test.sql
--
-- Against the BASE schema it fails at part1 (no table): the negative
-- control. Everything runs inside one transaction and is rolled back.

begin;

set local client_min_messages = warning;

create table pg_temp.assertions_run (n integer not null);
insert into pg_temp.assertions_run values (0);
create table pg_temp.kept (k text primary key, v text);

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  update pg_temp.assertions_run set n = n + 1;
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

-- Runs p_sql as p_role/p_uid; returns 'OK:<rows>' or the SQLSTATE. A
-- single-value select is returned as 'V:<value>'.
create function pg_temp.run_as(p_role text, p_uid uuid, p_sql text) returns text
  language plpgsql as $$
declare
  v_rows bigint;
  v_out text;
  v_val text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  execute format('set local role %I', p_role);
  begin
    if p_sql like 'select %' then
      execute p_sql into v_val;
      v_out := 'V:' || coalesce(v_val, '<null>');
    else
      execute p_sql;
      get diagnostics v_rows = row_count;
      v_out := 'OK:' || v_rows;
    end if;
  exception when others then
    v_out := sqlstate;
  end;
  reset role;
  return v_out;
end;
$$;

-- A = author, B = buyer, F = friend, O = a reader who owns the book.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e1180000-0000-4000-8000-00000000000a', 'r118-a@test', now(), '{"role":"author","display_name":"R118 Autor"}'),
  ('e1180000-0000-4000-8000-00000000000b', 'r118-b@test', now(), '{"role":"reader","display_name":"Ana Blerësja"}'),
  ('e1180000-0000-4000-8000-00000000000f', 'r118-f@test', now(), '{"role":"reader","display_name":"R118 Friend"}'),
  ('e1180000-0000-4000-8000-00000000000e', 'r118-o@test', now(), '{"role":"reader","display_name":"R118 Owner"}');

insert into public.books (id, author_id, title, description, keywords, status, price_all, published_at) values
  ('e1181000-0000-4000-8000-0000000000b1', 'e1180000-0000-4000-8000-00000000000a', 'R118 Paid', 'x', '', 'published', 299, now());
insert into public.purchases (book_id, reader_id, stripe_checkout_session_id, amount_cents)
  values ('e1181000-0000-4000-8000-0000000000b1', 'e1180000-0000-4000-8000-00000000000e', 'cs_r118', 29900);

-- Two gifts from B: G1 (token 'a'x64), G2 (token 'b'x64). One from F: G3.
insert into public.gifts (id, buyer_id, book_id, recipient_email, note, token_hash, send_count, last_sent_at) values
  ('e1182000-0000-4000-8000-0000000000a1', 'e1180000-0000-4000-8000-00000000000b', 'e1181000-0000-4000-8000-0000000000b1', 'friend@example.test', 'Gëzuar!', public.gift_token_hash(repeat('a', 64)), 1, now() - interval '2 days'),
  ('e1182000-0000-4000-8000-0000000000a2', 'e1180000-0000-4000-8000-00000000000b', 'e1181000-0000-4000-8000-0000000000b1', 'other@example.test', null, public.gift_token_hash(repeat('b', 64)), 1, now() - interval '2 days'),
  ('e1182000-0000-4000-8000-0000000000a3', 'e1180000-0000-4000-8000-00000000000f', 'e1181000-0000-4000-8000-0000000000b1', 'z@example.test', null, public.gift_token_hash(repeat('c', 64)), 1, now() - interval '2 days');

-- part1
select pg_temp.assert(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.gifts'::regclass),
  'part1: gifts has row level security');
select pg_temp.assert(
  not exists (select 1 from information_schema.role_table_grants
               where table_schema = 'public' and table_name = 'gifts' and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')),
  'part1: no table-wide grant for anyone');
select pg_temp.assert(
  (select string_agg(privilege_type || ':' || column_name, ',' order by column_name, privilege_type)
     from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'gifts' and grantee = 'authenticated')
  = 'SELECT:book_id,SELECT:buyer_id,SELECT:claimed_at,SELECT:created_at,SELECT:id,SELECT:last_sent_at,SELECT:note,SELECT:recipient_email,SELECT:send_count,SELECT:status',
  'part1: authenticated may read only the listed columns');
select pg_temp.assert(
  not exists (select 1 from information_schema.column_privileges
               where table_schema = 'public' and table_name = 'gifts' and grantee in ('anon', 'service_role', 'PUBLIC')),
  'part1: no column grants for anon, service_role or PUBLIC');
select pg_temp.assert(pg_temp.run_as('anon', null, 'select count(*) from public.gifts') = '42501',
  'part1: anon cannot read gifts');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
  'select count(*) from public.gifts') = 'V:2', 'part1: B sees B''s 2 gifts only');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
  'select token_hash from public.gifts limit 1') = '42501', 'part1: B cannot read token_hash');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
  'select claimed_by::text from public.gifts limit 1') = '42501', 'part1: B cannot read claimed_by');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
  $q$update public.gifts set recipient_email = 'x@example.test'$q$) = '42501', 'part1: B cannot update directly');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
  $q$insert into public.gifts (buyer_id, book_id, recipient_email, token_hash) values ('e1180000-0000-4000-8000-00000000000b', 'e1181000-0000-4000-8000-0000000000b1', 'x@example.test', repeat('0', 64))$q$) = '42501',
  'part1: B cannot create a gift');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
  'delete from public.gifts') = '42501', 'part1: B cannot delete');
select pg_temp.assert(
  not has_function_privilege('authenticated', 'public.gift_for_send(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.gift_token_hash(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.gift_new_token()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.gift_buyer_first_name(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.claim_gift(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.gift_resend(uuid)', 'EXECUTE')
  and has_function_privilege('anon', 'public.gift_preview(text)', 'EXECUTE'),
  'part1: helper functions are not callable; anon may only preview');

-- part2
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select concat_ws('|', book_id, buyer_name, note, status) from public.gift_preview(repeat('a', 64))$q$)
  = 'V:e1181000-0000-4000-8000-0000000000b1|Ana|Gëzuar!|waiting',
  'part2: a signed-out visitor sees the book, the first name, the note');
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select count(*) from public.gift_preview(repeat('d', 64))$q$) = 'V:0', 'part2: a wrong token shows nothing');
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select count(*) from public.gift_preview('aaaa')$q$) = 'V:0', 'part2: a short token shows nothing');

-- part3
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
  $q$select public.claim_gift(repeat('a', 64))$q$) = 'V:own_gift', 'part3: the buyer cannot claim their own gift');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000e',
  $q$select public.claim_gift(repeat('a', 64))$q$) = 'V:owned', 'part3: a reader who owns the book is told');
select pg_temp.assert((select status from public.gifts where id = 'e1182000-0000-4000-8000-0000000000a1') = 'recipient_owns',
  'part3: the gift is marked recipient_owns (g3 a)');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000f',
  $q$select public.claim_gift(repeat('e', 64))$q$) = 'V:invalid', 'part3: a wrong token is invalid');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000f',
  $q$select public.claim_gift(repeat('a', 64))$q$) = 'V:claimed', 'part3: F claims with the link (b2q4 a)');
select pg_temp.assert(
  (select count(*) from public.purchases p join public.gifts g on g.purchase_id = p.id
    where p.reader_id = 'e1180000-0000-4000-8000-00000000000f' and p.amount_cents = 0
      and p.stripe_checkout_session_id = 'gift_e1182000-0000-4000-8000-0000000000a1'
      and g.status = 'claimed' and g.claimed_by = 'e1180000-0000-4000-8000-00000000000f' and g.claimed_at is not null) = 1,
  'part3: F now has the book, and the gift is claimed');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000f',
  $q$select public.user_owns_book('e1181000-0000-4000-8000-0000000000b1')::text$q$) = 'V:true', 'part3: user_owns_book says F owns it');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000e',
  $q$select public.claim_gift(repeat('a', 64))$q$) = 'V:used', 'part3: the link works once');
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select public.claim_gift(repeat('b', 64))$q$) = '42501', 'part3: anon cannot call claim_gift');

-- part4
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000f',
  $q$select token from public.gift_resend('e1182000-0000-4000-8000-0000000000a2')$q$) = 'LB530', 'part4: only the buyer can resend');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
  $q$select token from public.gift_resend('e1182000-0000-4000-8000-0000000000a1')$q$) = 'LB533', 'part4: a claimed gift is not resent');
-- A resend makes a PENDING link only: nothing live changes until the
-- email went out (audit S1).
insert into pg_temp.kept
  select 'tok2', pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
    $q$select recipient_email || '|' || token || '|' || buyer_name from public.gift_resend('e1182000-0000-4000-8000-0000000000a2')$q$);
select pg_temp.assert((select v from pg_temp.kept where k = 'tok2') ~ '^V:other@example\.test\|[0-9a-f]{64}\|Ana$', 'part4: resend returns a new link');
select pg_temp.assert((select send_count = 1 and last_sent_at < now() - interval '1 day' and pending_at is not null from public.gifts where id = 'e1182000-0000-4000-8000-0000000000a2'),
  'part4: before the email went out, the count and the day are unchanged');
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select count(*) from public.gift_preview(repeat('b', 64))$q$) = 'V:1', 'part4: the old link still works while the send is pending');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
  $q$select token from public.gift_resend('e1182000-0000-4000-8000-0000000000a2')$q$) = 'LB535', 'part4: one send pending at a time');
-- The email failed: cancel. Nothing used up, the old link keeps working.
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000f',
  format($q$select 'ok' from public.gift_cancel_send('e1182000-0000-4000-8000-0000000000a2', %L)$q$, split_part((select v from pg_temp.kept where k = 'tok2'), '|', 2))) = 'V:ok',
  'part4: someone else''s cancel runs but changes nothing');
select pg_temp.assert((select pending_at is not null from public.gifts where id = 'e1182000-0000-4000-8000-0000000000a2'), 'part4: still pending after someone else''s cancel');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
  format($q$select 'ok' from public.gift_cancel_send('e1182000-0000-4000-8000-0000000000a2', %L)$q$, split_part((select v from pg_temp.kept where k = 'tok2'), '|', 2))) = 'V:ok',
  'part4: the buyer cancels a send that failed');
select pg_temp.assert((select send_count = 1 and pending_token_hash is null and pending_email is null and pending_at is null from public.gifts where id = 'e1182000-0000-4000-8000-0000000000a2'),
  'part4: a failed send uses nothing up');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
  format($q$select 'ok' from public.gift_confirm_send('e1182000-0000-4000-8000-0000000000a2', %L)$q$, split_part((select v from pg_temp.kept where k = 'tok2'), '|', 2))) = 'LB536',
  'part4: a cancelled link cannot be confirmed');
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select count(*) from public.gift_preview(repeat('b', 64))$q$) = 'V:1', 'part4: the old link still works after a failed send');
-- The email went out: confirm.
insert into pg_temp.kept
  select 'tok3', pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
    $q$select token from public.gift_resend('e1182000-0000-4000-8000-0000000000a2')$q$);
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000f',
  format($q$select 'ok' from public.gift_confirm_send('e1182000-0000-4000-8000-0000000000a2', %L)$q$, substr((select v from pg_temp.kept where k = 'tok3'), 3))) = 'LB530',
  'part4: only the buyer confirms');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
  $q$select 'ok' from public.gift_confirm_send('e1182000-0000-4000-8000-0000000000a2', repeat('c', 64))$q$) = 'LB536', 'part4: a wrong link is not confirmed');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
  format($q$select 'ok' from public.gift_confirm_send('e1182000-0000-4000-8000-0000000000a2', %L)$q$, substr((select v from pg_temp.kept where k = 'tok3'), 3))) = 'V:ok',
  'part4: the buyer confirms a sent email');
select pg_temp.assert((select send_count = 2 and last_sent_at > now() - interval '1 minute' and pending_at is null from public.gifts where id = 'e1182000-0000-4000-8000-0000000000a2'),
  'part4: the count goes to 2');
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select count(*) from public.gift_preview(repeat('b', 64))$q$) = 'V:0', 'part4: the old link stops working');
select pg_temp.assert(pg_temp.run_as('anon', null,
  format($q$select status from public.gift_preview(%L)$q$, substr((select v from pg_temp.kept where k = 'tok3'), 3))) = 'V:waiting',
  'part4: the new link works');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
  $q$select token from public.gift_resend('e1182000-0000-4000-8000-0000000000a2')$q$) = 'LB532', 'part4: once a day');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
  $q$select token from public.gift_change_email('e1182000-0000-4000-8000-0000000000a2', 'new@example.test')$q$) = 'LB532', 'part4: a new email is also once a day');
update public.gifts set send_count = 3, last_sent_at = now() - interval '2 days' where id = 'e1182000-0000-4000-8000-0000000000a2';
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
  $q$select token from public.gift_resend('e1182000-0000-4000-8000-0000000000a2')$q$) = 'LB531', 'part4: at most 3 emails');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
  $q$select token from public.gift_change_email('e1182000-0000-4000-8000-0000000000a2', '  Other@Example.test ')$q$) = 'LB531',
  'part4: the same email again does not start a new count (audit F2)');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
  $q$select token from public.gift_change_email('e1182000-0000-4000-8000-0000000000a2', 'not an email')$q$) = 'LB534', 'part4: a bad email is refused');
insert into pg_temp.kept
  select 'tok4', pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
    $q$select recipient_email || '|' || token from public.gift_change_email('e1182000-0000-4000-8000-0000000000a2', '  New@Example.test ')$q$);
select pg_temp.assert(split_part((select v from pg_temp.kept where k = 'tok4'), '|', 1) = 'V:new@example.test',
  'part4: a new email (trimmed, lower case)');
select pg_temp.assert((select recipient_email = 'other@example.test' and send_count = 3 from public.gifts where id = 'e1182000-0000-4000-8000-0000000000a2'),
  'part4: the address changes only once the email went out');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
  format($q$select 'ok' from public.gift_confirm_send('e1182000-0000-4000-8000-0000000000a2', %L)$q$, split_part((select v from pg_temp.kept where k = 'tok4'), '|', 2))) = 'V:ok',
  'part4: the email to the new address went out');
select pg_temp.assert((select send_count = 1 and status = 'waiting' and recipient_email = 'new@example.test' from public.gifts where id = 'e1182000-0000-4000-8000-0000000000a2'),
  'part4: a new email starts a new count');
-- The same address again counts on (audit F2).
update public.gifts set last_sent_at = now() - interval '2 days' where id = 'e1182000-0000-4000-8000-0000000000a2';
insert into pg_temp.kept
  select 'tok5', pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
    $q$select token from public.gift_change_email('e1182000-0000-4000-8000-0000000000a2', 'new@example.test')$q$);
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
  format($q$select 'ok' from public.gift_confirm_send('e1182000-0000-4000-8000-0000000000a2', %L)$q$, substr((select v from pg_temp.kept where k = 'tok5'), 3))) = 'V:ok',
  'part4: the same address again is sent');
select pg_temp.assert((select send_count from public.gifts where id = 'e1182000-0000-4000-8000-0000000000a2') = 2, 'part4: the same address counts on (2, not 1)');
-- A recipient_owns gift reopens with a new email.
update public.gifts set status = 'recipient_owns', last_sent_at = now() - interval '2 days' where id = 'e1182000-0000-4000-8000-0000000000a2';
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
  $q$select token from public.gift_resend('e1182000-0000-4000-8000-0000000000a2')$q$) = 'LB533', 'part4: a recipient_owns gift is not resent to the same person');
insert into pg_temp.kept
  select 'tok6', pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
    $q$select token from public.gift_change_email('e1182000-0000-4000-8000-0000000000a2', 'third@example.test')$q$);
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
  format($q$select 'ok' from public.gift_confirm_send('e1182000-0000-4000-8000-0000000000a2', %L)$q$, substr((select v from pg_temp.kept where k = 'tok6'), 3))) = 'V:ok',
  'part4: send it to someone else (g3 a)');
select pg_temp.assert((select status = 'waiting' and recipient_email = 'third@example.test' and send_count = 1 from public.gifts where id = 'e1182000-0000-4000-8000-0000000000a2'),
  'part4: it waits again, for the new person');
-- A claim while a send is pending: the confirm is refused.
update public.gifts set last_sent_at = now() - interval '2 days' where id = 'e1182000-0000-4000-8000-0000000000a2';
insert into pg_temp.kept
  select 'tok7', pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
    $q$select token from public.gift_resend('e1182000-0000-4000-8000-0000000000a2')$q$);
-- (Someone claims the live link meanwhile; claim_gift itself is part3.)
update public.gifts set status = 'claimed', claimed_at = now() where id = 'e1182000-0000-4000-8000-0000000000a2';
select pg_temp.assert(pg_temp.run_as('authenticated', 'e1180000-0000-4000-8000-00000000000b',
  format($q$select 'ok' from public.gift_confirm_send('e1182000-0000-4000-8000-0000000000a2', %L)$q$, substr((select v from pg_temp.kept where k = 'tok7'), 3))) = 'LB533',
  'part4: a pending send of a claimed gift is not confirmed');
select pg_temp.assert(
  not has_function_privilege('anon', 'public.gift_confirm_send(uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.gift_cancel_send(uuid,text)', 'EXECUTE'),
  'part4: anon cannot confirm or cancel');

do $$
declare v_n int;
begin
  select n into v_n from pg_temp.assertions_run;
  if v_n < 58 then
    raise exception 'FAIL: only % assertions ran (expected at least 58)', v_n;
  end if;
  raise warning '118_cart_gifts: % assertions passed', v_n;
  raise notice 'ALL PASSED: 118_cart_gifts.test.sql (% assertions)', v_n;
end $$;

rollback;
