-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for LBN
-- (supabase/migrations/20261124190000_lbn_book_number.sql):
--
-- * part1 the column: books.lbn is NOT NULL text, UNIQUE
--   (books_lbn_key) and checked (books_lbn_check); lbn_issued exists
--   with row level security and no grants.
-- * part2 the code: lbn_check_char() gives the same check characters
--   as src/lib/lbn.ts (shared vectors); lbn_is_valid() accepts only
--   "LE"/"LP" + 8 alphabet characters with the right check character.
-- * part3 given at creation: a new book gets a valid "LE" code even when
--   the insert sends one; every code is recorded in lbn_issued.
-- * part4 never changes: any change is refused with LB528, also for the
--   table owner; an author session can't write it (42501); other
--   columns still update.
-- * part5 never reused: a deleted book's code stays in lbn_issued, and
--   lbn_generate() never hands out a code that is already there.
-- * part6 who reads it: public_books shows it (its last column) for a
--   published book; a draft stays its author's; no role but the owner
--   reads lbn_issued or calls the three LBN functions.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/115_lbn_book_number.test.sql
--
-- Against the BASE schema it fails at part1 (no column): the negative
-- control. Everything runs inside one transaction and is rolled back.

begin;

set local client_min_messages = warning;

create table pg_temp.assertions_run (n integer not null);
insert into pg_temp.assertions_run values (0);

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  update pg_temp.assertions_run set n = n + 1;
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

-- Runs one statement as a role with a JWT subject; 'OK:<rows>' or the
-- error code.
create function pg_temp.run_as(p_role text, p_uid uuid, p_sql text) returns text
  language plpgsql as $$
declare
  v_rows bigint;
  v_out text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
    v_out := 'OK:' || v_rows;
  exception when others then
    v_out := sqlstate;
  end;
  reset role;
  return v_out;
end;
$$;

-- Runs one query as a role and returns its single text value (or the
-- error code).
create function pg_temp.value_as(p_role text, p_uid uuid, p_sql text) returns text
  language plpgsql as $$
declare
  v_out text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql into v_out;
  exception when others then
    v_out := 'ERR:' || sqlstate;
  end;
  reset role;
  return v_out;
end;
$$;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e1150000-0000-4000-8000-00000000000a', 'r115-a@test', now(), '{"role":"author","display_name":"R115 A"}'),
  ('e1150000-0000-4000-8000-00000000000b', 'r115-b@test', now(), '{"role":"reader","display_name":"R115 B"}');

-- part3 (the insert itself): a supplied lbn is replaced.
insert into public.books (id, author_id, title, description, keywords, status, price_all, published_at, lbn) values
  ('e1151000-0000-4000-8000-0000000000a1', 'e1150000-0000-4000-8000-00000000000a', 'R115 Live', 'x', '', 'published', 0, now(), 'LE7K4M9X2D'),
  ('e1151000-0000-4000-8000-0000000000a2', 'e1150000-0000-4000-8000-00000000000a', 'R115 Draft', 'x', '', 'draft', 0, null, 'not a code');
insert into public.books (id, author_id, title, description, keywords, status, price_all, published_at) values
  ('e1151000-0000-4000-8000-0000000000a3', 'e1150000-0000-4000-8000-00000000000a', 'R115 Gone', 'x', '', 'draft', 0, null);

-- part1
select pg_temp.assert(
  (select a.attnotnull and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'text' and not a.atthasdef
     from pg_catalog.pg_attribute a
    where a.attrelid = 'public.books'::regclass and a.attname = 'lbn' and not a.attisdropped),
  'part1: books.lbn is NOT NULL text with no default');
select pg_temp.assert(
  exists (select 1 from pg_catalog.pg_constraint
           where conrelid = 'public.books'::regclass and conname = 'books_lbn_key' and contype = 'u')
  and exists (select 1 from pg_catalog.pg_constraint
               where conrelid = 'public.books'::regclass and conname = 'books_lbn_check' and contype = 'c' and convalidated),
  'part1: books_lbn_key (unique) and books_lbn_check (validated) exist');
select pg_temp.assert(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.lbn_issued'::regclass),
  'part1: lbn_issued has row level security');
select pg_temp.assert(
  not exists (select 1 from information_schema.role_table_grants
               where table_schema = 'public' and table_name = 'lbn_issued'
                 and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')),
  'part1: lbn_issued has no grants for PUBLIC, anon, authenticated or service_role');

-- part2: the shared vectors (src/lib/lbn.test.ts uses the same ones).
select pg_temp.assert(public.lbn_check_char('LE', '7K4M9X2') = 'D', 'part2: LE7K4M9X2 -> D');
select pg_temp.assert(public.lbn_check_char('LP', '7K4M9X2') = 'E', 'part2: LP7K4M9X2 -> E');
select pg_temp.assert(public.lbn_check_char('LE', '2222222') = '3', 'part2: LE2222222 -> 3');
select pg_temp.assert(public.lbn_check_char('LE', 'ZZZZZZZ') = '6', 'part2: LEZZZZZZZ -> 6');
select pg_temp.assert(public.lbn_check_char('LP', 'ABCDEFG') = 'X', 'part2: LPABCDEFG -> X');
select pg_temp.assert(public.lbn_check_char('LX', '7K4M9X2') is null, 'part2: unknown prefix -> null');
select pg_temp.assert(public.lbn_check_char('LE', '7K4M9X') is null, 'part2: 6 characters -> null');
select pg_temp.assert(public.lbn_check_char('LE', '7K4M9X0') is null, 'part2: a 0 -> null');

do $$
declare
  v text;
begin
  foreach v in array array['LE7K4M9X2D', 'LP7K4M9X2E', 'LE22222223', 'LEZZZZZZZ6', 'LPABCDEFGX'] loop
    perform pg_temp.assert(public.lbn_is_valid(v), 'part2: valid ' || v);
  end loop;
  foreach v in array array['le7k4m9x2d', 'LE7K4M9X2E', 'LE7K4M9X2', 'LE7K4M9X2DD', 'LX7K4M9X2D', 'LE7K4M9XD2',
                           'LE7K4N9X2D', 'LE0K4M9X2D', 'LEOK4M9X2D', 'LE1K4M9X2D', 'LEIK4M9X2D', 'LELK4M9X2D',
                           ' LE7K4M9X2D', 'LE7K4M9X2D ', ''] loop
    perform pg_temp.assert(not public.lbn_is_valid(v), 'part2: refused "' || v || '"');
  end loop;
  perform pg_temp.assert(not public.lbn_is_valid(null), 'part2: refused NULL');
  -- every single-character change of a valid code is caught
  for i in 3..10 loop
    for j in 1..31 loop
      v := overlay('LE7K4M9X2D' placing substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', j, 1) from i for 1);
      if v <> 'LE7K4M9X2D' and public.lbn_is_valid(v) then
        raise exception 'FAIL: part2: one changed character still valid: %', v;
      end if;
    end loop;
  end loop;
  perform pg_temp.assert(true, 'part2: every one-character change of LE7K4M9X2D is refused');
end $$;

-- part3
select pg_temp.assert(
  (select bool_and(public.lbn_is_valid(lbn) and lbn like 'LE%') from public.books where id::text like 'e1151000-%'),
  'part3: every new book has a valid LE code');
select pg_temp.assert(
  (select count(distinct lbn) from public.books where id::text like 'e1151000-%') = 3,
  'part3: three books, three different codes');
select pg_temp.assert(
  (select lbn from public.books where id = 'e1151000-0000-4000-8000-0000000000a2') <> 'not a code',
  'part3: a value sent with the insert is replaced');
select pg_temp.assert(
  (select count(*) from public.books b join public.lbn_issued i using (lbn) where b.id::text like 'e1151000-%') = 3,
  'part3: every code is recorded in lbn_issued');

-- part4
do $$
declare
  v_code text;
  v_bad text;
begin
  begin
    update public.books set lbn = 'LP7K4M9X2E' where id = 'e1151000-0000-4000-8000-0000000000a1';
    v_code := 'no error';
  exception when others then
    v_code := sqlstate;
  end;
  perform pg_temp.assert(v_code = 'LB528', format('part4: the table owner can''t change an LBN -- got %s', v_code));
  begin
    update public.books set lbn = lbn where id = 'e1151000-0000-4000-8000-0000000000a1';
    v_code := 'OK';
  exception when others then
    v_code := sqlstate;
  end;
  perform pg_temp.assert(v_code = 'OK', format('part4: writing the same value is not a change -- got %s', v_code));
  update public.books set title = 'R115 Live 2' where id = 'e1151000-0000-4000-8000-0000000000a1';
  perform pg_temp.assert(true, 'part4: other columns still update');
  -- Audit r3 N3: the CHECK is the backup behind the triggers. With the
  -- triggers off for a moment (replica mode: ordinary triggers do not
  -- fire, constraints still apply), a badly shaped code is refused.
  set local session_replication_role = replica;
  foreach v_bad in array array['not a code', 'le7k4m9x2d', 'LE0K4M9X2D', 'LX7K4M9X2D', 'LE7K4M9X2', 'LE7K4M9X2DD'] loop
    begin
      update public.books set lbn = v_bad where id = 'e1151000-0000-4000-8000-0000000000a1';
      v_code := 'no error';
    exception when others then
      v_code := sqlstate;
    end;
    perform pg_temp.assert(v_code = '23514', format('part4: books_lbn_check refuses %L -- got %s', v_bad, v_code));
  end loop;
  set local session_replication_role = origin;
  v_code := pg_temp.run_as('authenticated', 'e1150000-0000-4000-8000-00000000000a',
    $q$update public.books set lbn = 'LP7K4M9X2E' where id = 'e1151000-0000-4000-8000-0000000000a2'$q$);
  perform pg_temp.assert(v_code = '42501', format('part4: an author session may not write lbn -- got %s', v_code));
  v_code := pg_temp.run_as('service_role', null,
    $q$update public.books set lbn = 'LP7K4M9X2E' where id = 'e1151000-0000-4000-8000-0000000000a2'$q$);
  perform pg_temp.assert(v_code = 'LB528', format('part4: the service role can''t change an LBN -- got %s', v_code));
end $$;

-- part5
do $$
declare
  v_gone text;
  v_new text;
  v_seen integer;
begin
  select lbn into v_gone from public.books where id = 'e1151000-0000-4000-8000-0000000000a3';
  delete from public.books where id = 'e1151000-0000-4000-8000-0000000000a3';
  perform pg_temp.assert(exists (select 1 from public.lbn_issued where lbn = v_gone),
    'part5: a deleted book''s code stays in lbn_issued');
  select count(*) into v_seen from public.lbn_issued;
  for i in 1..300 loop
    v_new := public.lbn_generate('LE');
    perform pg_temp.assert(public.lbn_is_valid(v_new) and v_new like 'LE%' and v_new <> v_gone, 'part5: generated ' || v_new);
  end loop;
  perform pg_temp.assert((select count(*) from public.lbn_issued) = v_seen + 300,
    'part5: 300 generated codes, 300 new rows (none reused)');
  perform pg_temp.assert(public.lbn_generate('LP') like 'LP%', 'part5: LP prefix works');
  begin
    perform public.lbn_generate('LX');
    v_new := 'no error';
  exception when others then
    v_new := 'refused';
  end;
  perform pg_temp.assert(v_new = 'refused', 'part5: an unknown prefix is refused');
end $$;

-- part6
select pg_temp.assert(
  (select a.attname from pg_catalog.pg_attribute a
    where a.attrelid = 'public.public_books'::regclass and a.attnum > 0 and not a.attisdropped
    order by a.attnum desc limit 1) in ('lbn', 'only_on_librum')
  -- LR1 patch 2 (migration 20261125150000) appends only_on_librum right
  -- after it.
  and (select coalesce(max(a.attnum) filter (where a.attname = 'only_on_librum'),
                       max(a.attnum) filter (where a.attname = 'lbn') + 1)
         from pg_catalog.pg_attribute a
        where a.attrelid = 'public.public_books'::regclass and not a.attisdropped)
      = (select a.attnum + 1 from pg_catalog.pg_attribute a
          where a.attrelid = 'public.public_books'::regclass and a.attname = 'lbn'),
  'part6: lbn is public_books'' last column, or right before only_on_librum');

do $$
declare
  v text;
  v_live text;
begin
  select lbn into v_live from public.books where id = 'e1151000-0000-4000-8000-0000000000a1';
  v := pg_temp.value_as('anon', null,
    $q$select lbn from public.public_books where id = 'e1151000-0000-4000-8000-0000000000a1'$q$);
  perform pg_temp.assert(v = v_live, format('part6: anon reads a published book''s LBN -- got %s', v));
  v := pg_temp.value_as('anon', null,
    $q$select id::text from public.public_books where lbn = '$q$ || v_live || $q$'$q$);
  perform pg_temp.assert(v = 'e1151000-0000-4000-8000-0000000000a1', format('part6: anon finds a published book by LBN -- got %s', v));
  v := pg_temp.value_as('anon', null,
    $q$select count(*)::text from public.public_books where id = 'e1151000-0000-4000-8000-0000000000a2'$q$);
  perform pg_temp.assert(v = '0', format('part6: anon does not see a draft -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e1150000-0000-4000-8000-00000000000a',
    $q$select lbn from public.books where id = 'e1151000-0000-4000-8000-0000000000a2'$q$);
  perform pg_temp.assert(public.lbn_is_valid(v), format('part6: the author reads their draft''s LBN -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e1150000-0000-4000-8000-00000000000b',
    $q$select count(*)::text from public.books where id = 'e1151000-0000-4000-8000-0000000000a2'$q$);
  perform pg_temp.assert(v = '0', format('part6: another account does not see the draft -- got %s', v));
  v := pg_temp.value_as('anon', null, $q$select count(*)::text from public.lbn_issued$q$);
  perform pg_temp.assert(v = 'ERR:42501', format('part6: anon can''t read lbn_issued -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e1150000-0000-4000-8000-00000000000b', $q$select count(*)::text from public.lbn_issued$q$);
  perform pg_temp.assert(v = 'ERR:42501', format('part6: authenticated can''t read lbn_issued -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e1150000-0000-4000-8000-00000000000b', $q$select public.lbn_generate('LE')$q$);
  perform pg_temp.assert(v = 'ERR:42501', format('part6: authenticated can''t call lbn_generate -- got %s', v));
  v := pg_temp.value_as('service_role', null, $q$select public.lbn_generate('LE')$q$);
  perform pg_temp.assert(v = 'ERR:42501', format('part6: service_role can''t call lbn_generate -- got %s', v));
  v := pg_temp.value_as('anon', null, $q$select public.lbn_is_valid('LE7K4M9X2D')::text$q$);
  perform pg_temp.assert(v = 'ERR:42501', format('part6: anon can''t call lbn_is_valid -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e1150000-0000-4000-8000-00000000000b', $q$select public.lbn_check_char('LE', '7K4M9X2')$q$);
  perform pg_temp.assert(v = 'ERR:42501', format('part6: authenticated can''t call lbn_check_char -- got %s', v));
end $$;

do $$
declare v_n int;
begin
  select n into v_n from pg_temp.assertions_run;
  if v_n < 330 then
    raise exception 'FAIL: only % assertions ran (expected at least 330)', v_n;
  end if;
  raise warning '115_lbn_book_number: % assertions passed', v_n;
  raise notice 'ALL PASSED: 115_lbn_book_number.test.sql (% assertions)', v_n;
end $$;

rollback;
