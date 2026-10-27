-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for DISCOUNT-LIMIT-1
-- (supabase/migrations/20261027120000_discount_code_use_limit.sql):
--
-- * part1: discount_codes.max_uses is null or 1..100000; authenticated
--   may INSERT it on its own code but never UPDATE it.
-- * part2: create_book_checkout_intent counts a limited code's uses
--   (completed, or open and unexpired; the caller's own open intents
--   not counted) and returns 'discount_used_up' once they reach
--   max_uses, changing nothing. A reader who drops the code frees the
--   use; a completed use stays used; an unlimited code never refuses.
-- * part3: discount_code_use_counts() returns the caller's own codes
--   only, counted the same way; anon cannot call it.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/084_discount_code_use_limit.test.sql
--
-- It must also pass against the base schema.sql plus the migration.
--
-- Everything runs inside one transaction and is rolled back at the end.

begin;

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

-- Runs p_sql as authenticated with auth.uid() = p_sub; returns 'OK' or
-- the SQLSTATE. Each call is its own subtransaction.
create function pg_temp.try_as(p_sub uuid, p_sql text) returns text
  language plpgsql as $$
declare
  v_state text;
begin
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
  set local role authenticated;
  execute p_sql;
  reset role;
  return 'OK';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate;
  reset role;
  return v_state;
end;
$$;

create function pg_temp.quote(p_reader uuid, p_book uuid, p_code text default null)
returns table (intent_id uuid, price_cents_at_checkout integer, discount_code_id uuid,
               expires_at timestamptz, quote_status text)
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_reader::text, true);
  set local role authenticated;
  return query select * from public.create_book_checkout_intent(p_book, p_code);
  reset role;
end;
$$;

create function pg_temp.counts(p_author uuid) returns text
language plpgsql as $$
declare
  v text;
begin
  perform set_config('request.jwt.claim.sub', p_author::text, true);
  set local role authenticated;
  select coalesce(string_agg(c.code || '=' || u.uses, ',' order by c.code), '<none>')
    into v
    from public.discount_code_use_counts() u
    join public.discount_codes c on c.id = u.discount_code_id;
  reset role;
  return v;
end;
$$;

create function pg_temp.intents_fingerprint() returns text
language sql as $$
  select coalesce(string_agg(i.id::text || ':' || coalesce(i.superseded_reason, '-'), '|' order by i.id), '<empty>')
  from public.book_checkout_intents i;
$$;

-- ============================================================
-- Fixtures: two authors, four readers, two books by author A, one by B.
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a0840000-0000-0000-0000-00000000000a', 'p084-author-a@test', now(), '{"role":"author","display_name":"P084 Author A"}'),
  ('a0840000-0000-0000-0000-00000000000b', 'p084-author-b@test', now(), '{"role":"author","display_name":"P084 Author B"}'),
  ('a0840000-0000-0000-0000-000000000001', 'p084-reader-1@test', now(), '{"role":"reader","display_name":"P084 Reader One"}'),
  ('a0840000-0000-0000-0000-000000000002', 'p084-reader-2@test', now(), '{"role":"reader","display_name":"P084 Reader Two"}'),
  ('a0840000-0000-0000-0000-000000000003', 'p084-reader-3@test', now(), '{"role":"reader","display_name":"P084 Reader Three"}'),
  ('a0840000-0000-0000-0000-000000000004', 'p084-reader-4@test', now(), '{"role":"reader","display_name":"P084 Reader Four"}');

insert into public.books (id, author_id, title, status, price_all) values
  ('b0840000-0000-0000-0000-000000000001', 'a0840000-0000-0000-0000-00000000000a', 'P084 Limited Book', 'published', 500),
  ('b0840000-0000-0000-0000-000000000002', 'a0840000-0000-0000-0000-00000000000a', 'P084 Open Book', 'published', 500),
  ('b0840000-0000-0000-0000-000000000003', 'a0840000-0000-0000-0000-00000000000b', 'P084 Other Author Book', 'published', 500);

insert into public.discount_codes (id, author_id, book_id, code, percent_off, max_uses) values
  ('c0840000-0000-0000-0000-000000000001', 'a0840000-0000-0000-0000-00000000000a', 'b0840000-0000-0000-0000-000000000001', 'TWO', 10, 2),
  ('c0840000-0000-0000-0000-000000000002', 'a0840000-0000-0000-0000-00000000000a', 'b0840000-0000-0000-0000-000000000002', 'OPEN', 10, null),
  ('c0840000-0000-0000-0000-000000000003', 'a0840000-0000-0000-0000-00000000000b', 'b0840000-0000-0000-0000-000000000003', 'BONE', 10, 1);

-- ============================================================
-- part1: the column and its privileges
-- ============================================================
do $$
declare
  v_state text;
begin
  foreach v_state in array array['0', '-1', '100001'] loop
    begin
      execute format($q$insert into public.discount_codes (author_id, book_id, code, percent_off, max_uses)
                        values ('a0840000-0000-0000-0000-00000000000a', 'b0840000-0000-0000-0000-000000000001', 'BAD%s', 10, %s)$q$,
                     pg_catalog.replace(v_state, '-', 'M'), v_state);
      raise exception 'FAIL: part1: max_uses % must be refused', v_state;
    exception when check_violation then
      null;
    end;
  end loop;
end $$;

select pg_temp.assert(pg_temp.try_as('a0840000-0000-0000-0000-00000000000a',
  $q$insert into public.discount_codes (id, author_id, book_id, code, percent_off, expires_at, max_uses)
     values ('c0840000-0000-0000-0000-0000000000a1', 'a0840000-0000-0000-0000-00000000000a',
             'b0840000-0000-0000-0000-000000000001', 'MAXONE', 10, null, 1)$q$) = 'OK',
  'part1: an author may create a code with max_uses 1');
select pg_temp.assert(pg_temp.try_as('a0840000-0000-0000-0000-00000000000a',
  $q$insert into public.discount_codes (id, author_id, book_id, code, percent_off, expires_at, max_uses)
     values ('c0840000-0000-0000-0000-0000000000a2', 'a0840000-0000-0000-0000-00000000000a',
             'b0840000-0000-0000-0000-000000000001', 'MAXTOP', 10, null, 100000)$q$) = 'OK',
  'part1: an author may create a code with max_uses 100000');
select pg_temp.assert(pg_temp.try_as('a0840000-0000-0000-0000-00000000000a',
  $q$update public.discount_codes set max_uses = 50 where id = 'c0840000-0000-0000-0000-0000000000a1'$q$) = '42501',
  'part1: an author may NOT change max_uses later');
select pg_temp.assert(pg_temp.try_as('a0840000-0000-0000-0000-00000000000b',
  $q$insert into public.discount_codes (id, author_id, book_id, code, percent_off, max_uses)
     values ('c0840000-0000-0000-0000-0000000000a3', 'a0840000-0000-0000-0000-00000000000b',
             'b0840000-0000-0000-0000-000000000001', 'STEAL', 10, 5)$q$) = '42501',
  'part1: the insert policy still refuses a code on someone else''s book');
select pg_temp.assert(
  (select max_uses from public.discount_codes where id = 'c0840000-0000-0000-0000-0000000000a1') = 1,
  'part1: max_uses unchanged after the refused update');
delete from public.discount_codes where id in ('c0840000-0000-0000-0000-0000000000a1', 'c0840000-0000-0000-0000-0000000000a2');

-- ============================================================
-- part2: the limit at checkout
-- ============================================================
do $$
declare
  r record;
  r1 record;
  v_before text;
begin
  -- Two uses: readers 1 and 2 each start a checkout with the code.
  select * into r1 from pg_temp.quote('a0840000-0000-0000-0000-000000000001', 'b0840000-0000-0000-0000-000000000001', 'TWO');
  perform pg_temp.assert(r1.quote_status = 'minted' and r1.price_cents_at_checkout = 45000
                         and r1.discount_code_id = 'c0840000-0000-0000-0000-000000000001',
    format('part2: first use must mint at 45000 with the code, got %s / %s', r1.quote_status, r1.price_cents_at_checkout));
  select * into r from pg_temp.quote('a0840000-0000-0000-0000-000000000002', 'b0840000-0000-0000-0000-000000000001', 'two ');
  perform pg_temp.assert(r.quote_status = 'minted' and r.price_cents_at_checkout = 45000,
    format('part2: second use (lowercase, padded) must mint, got %s', r.quote_status));

  -- The third reader is refused, and nothing changes.
  v_before := pg_temp.intents_fingerprint();
  select * into r from pg_temp.quote('a0840000-0000-0000-0000-000000000003', 'b0840000-0000-0000-0000-000000000001', 'TWO');
  perform pg_temp.assert(r.quote_status = 'discount_used_up' and r.intent_id is null
                         and r.price_cents_at_checkout is null and r.discount_code_id is null,
    format('part2: third use must be discount_used_up with no intent, got %s', r.quote_status));
  perform pg_temp.assert(pg_temp.intents_fingerprint() = v_before,
    'part2: the refusal must change nothing');

  -- Without the code the third reader buys at the full price.
  select * into r from pg_temp.quote('a0840000-0000-0000-0000-000000000003', 'b0840000-0000-0000-0000-000000000001');
  perform pg_temp.assert(r.quote_status = 'minted' and r.price_cents_at_checkout = 50000 and r.discount_code_id is null,
    'part2: without the code the full price mints');

  -- A reader's own open checkout is not counted against them.
  select * into r from pg_temp.quote('a0840000-0000-0000-0000-000000000001', 'b0840000-0000-0000-0000-000000000001', 'TWO');
  perform pg_temp.assert(r.quote_status = 'reused' and r.intent_id = r1.intent_id,
    format('part2: reader 1 must get their own quote back, got %s', r.quote_status));

  -- Reader 2 drops the code: their quote is superseded and the use is free.
  select * into r from pg_temp.quote('a0840000-0000-0000-0000-000000000002', 'b0840000-0000-0000-0000-000000000001');
  perform pg_temp.assert(r.quote_status = 'minted' and r.discount_code_id is null,
    'part2: reader 2 without the code mints at full price');
  select * into r from pg_temp.quote('a0840000-0000-0000-0000-000000000003', 'b0840000-0000-0000-0000-000000000001', 'TWO');
  perform pg_temp.assert(r.quote_status = 'minted' and r.discount_code_id = 'c0840000-0000-0000-0000-000000000001',
    format('part2: the freed use must go to reader 3, got %s', r.quote_status));

  -- Both uses held again; reader 4 refused.
  select * into r from pg_temp.quote('a0840000-0000-0000-0000-000000000004', 'b0840000-0000-0000-0000-000000000001', 'TWO');
  perform pg_temp.assert(r.quote_status = 'discount_used_up', 'part2: reader 4 refused while both uses are held');

  -- An expired open checkout no longer holds a use.
  update public.book_checkout_intents set created_at = now() - interval '2 days', expires_at = now() - interval '1 day'
   where reader_id = 'a0840000-0000-0000-0000-000000000003' and discount_code_id is not null;
  select * into r from pg_temp.quote('a0840000-0000-0000-0000-000000000004', 'b0840000-0000-0000-0000-000000000001', 'TWO');
  perform pg_temp.assert(r.quote_status = 'minted', format('part2: an expired hold frees the use, got %s', r.quote_status));

  -- A completed (paid) checkout stays a use, even after it expires or
  -- is refunded: reader 1's quote is paid, then reader 3 is refused.
  update public.book_checkout_intents
     set completed_at = now(), fulfilled_at = now(),
         created_at = now() - interval '2 days', expires_at = now() - interval '1 day'
   where id = r1.intent_id;
  delete from public.book_checkout_intents
   where reader_id = 'a0840000-0000-0000-0000-000000000003';
  select * into r from pg_temp.quote('a0840000-0000-0000-0000-000000000003', 'b0840000-0000-0000-0000-000000000001', 'TWO');
  perform pg_temp.assert(r.quote_status = 'discount_used_up',
    format('part2: a completed use (paid, then expired) stays used, got %s', r.quote_status));

  -- An unlimited code never refuses.
  foreach r1.intent_id in array array['a0840000-0000-0000-0000-000000000001', 'a0840000-0000-0000-0000-000000000002',
                                      'a0840000-0000-0000-0000-000000000003', 'a0840000-0000-0000-0000-000000000004']::uuid[] loop
    select * into r from pg_temp.quote(r1.intent_id, 'b0840000-0000-0000-0000-000000000002', 'OPEN');
    perform pg_temp.assert(r.quote_status = 'minted', 'part2: an unlimited code must always apply');
  end loop;

  -- A disabled code is still the old silent fall-back (unchanged).
  update public.discount_codes set active = false where id = 'c0840000-0000-0000-0000-000000000003';
  select * into r from pg_temp.quote('a0840000-0000-0000-0000-000000000001', 'b0840000-0000-0000-0000-000000000003', 'BONE');
  perform pg_temp.assert(r.quote_status = 'minted' and r.discount_code_id is null,
    'part2: a disabled limited code is not selected, as before');
  update public.discount_codes set active = true where id = 'c0840000-0000-0000-0000-000000000003';
end $$;

-- ============================================================
-- part3: discount_code_use_counts()
-- ============================================================
-- Author A: TWO = reader 1 (completed) + reader 4 (open); OPEN = four open.
select pg_temp.assert(pg_temp.counts('a0840000-0000-0000-0000-00000000000a') = 'OPEN=4,TWO=2',
  format('part3: author A counts, got %s', pg_temp.counts('a0840000-0000-0000-0000-00000000000a')));
-- Author B: BONE has one open checkout from reader 1 (minted without it,
-- so zero uses); B never sees A's codes.
select pg_temp.assert(pg_temp.counts('a0840000-0000-0000-0000-00000000000b') = '<none>',
  format('part3: author B counts, got %s', pg_temp.counts('a0840000-0000-0000-0000-00000000000b')));
-- A reader sees nothing.
select pg_temp.assert(pg_temp.counts('a0840000-0000-0000-0000-000000000004') = '<none>',
  'part3: a reader owns no codes');
select pg_temp.assert(not has_function_privilege('anon', 'public.discount_code_use_counts()', 'EXECUTE'),
  'part3: anon cannot call discount_code_use_counts');
select pg_temp.assert(not has_function_privilege('service_role', 'public.discount_code_use_counts()', 'EXECUTE'),
  'part3: service_role has no EXECUTE of its own');
select pg_temp.assert(
  (select prosecdef and proconfig = array['search_path=""'] from pg_proc
    where oid = 'public.discount_code_use_counts()'::regprocedure),
  'part3: SECURITY DEFINER with an empty search_path');

rollback;
