-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for BD3-P4
-- (supabase/migrations/20261101170000_bd3_original_author.sql):
--
-- * part1 the column: books.original_author is nullable text with one
--   named CHECK (books_original_author_check): trimmed, 1..200
--   characters, no control characters.
-- * part2 who reads and writes it: public_books shows it to anon and
--   to readers for a published book only (a draft stays the author's);
--   an author session may not write it (only the service-role catalog
--   writer does); books itself stays closed to anon.
-- * part3 search_books(): finds a published book by its original
--   author, accent-blind, for anon and authenticated alike; a draft,
--   or a book whose original author does not match, is not returned;
--   the title still matches.
-- * part4 the review approval binds to the original author (16:37Z 2b,
--   16:45Z a): the 4-argument approval function (internal; the
--   3-argument one is gone), the snapshot column (authors cannot read
--   it), request_book_review() snapshots it and replaces a stale pending
--   row, approve refuses a changed one, the live-files guard (LB463)
--   and the publish gate (LB462) hold, an approval covers only the name
--   it was given for.
--
-- The migration over populated data, catalog equivalence and the
-- rollback are proven by 087_bd3_original_author_catalog_equivalence.sh.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance (on 16 strip ", maintain" from a copy of schema.sql):
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/087_bd3_original_author.test.sql
--
-- Everything runs inside one transaction and is rolled back at the end.

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

-- 'ok' when this original_author value is accepted on a book, 'refused'
-- on a CHECK violation. Each try is undone. The probe book is live, so
-- the same write takes it to draft (the live-files guard, LB463, refuses
-- a live book's original author changing otherwise -- part4).
create function pg_temp.try_value(p_value text) returns text
  language plpgsql as $$
begin
  update public.books set original_author = p_value, status = 'draft' where id = 'e0871000-0000-4000-8000-0000000000a1';
  raise exception using errcode = 'P0001', message = 'probe ok';
exception
  when check_violation then return 'refused';
  when raise_exception then
    if sqlerrm = 'probe ok' then return 'ok'; end if;
    raise;
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

-- Like run_as, but an error comes back as '<code>:<message>'.
create function pg_temp.run_msg(p_role text, p_uid uuid, p_sql text) returns text
  language plpgsql as $$
declare
  v_out text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql;
    v_out := 'OK';
  exception when others then
    v_out := sqlstate || ':' || sqlerrm;
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
  ('e0870000-0000-4000-8000-00000000000a', 'r087-a@test', now(), '{"role":"author","display_name":"R087 A"}'),
  ('e0870000-0000-4000-8000-00000000000b', 'r087-b@test', now(), '{"role":"reader","display_name":"R087 B"}'),
  ('e0870000-0000-4000-8000-00000000000c', 'r087-c@test', now(), '{"role":"reader","display_name":"R087 Staff"}');

insert into public.staff_members (user_id, role) values ('e0870000-0000-4000-8000-00000000000c', 'admin');

insert into public.books (id, author_id, title, description, keywords, status, price_all, published_at, original_author) values
  ('e0871000-0000-4000-8000-0000000000a1', 'e0870000-0000-4000-8000-00000000000a', 'R087 Ana', 'x', '', 'published', 0, now(), 'Lev Tolstoi Ëç'),
  ('e0871000-0000-4000-8000-0000000000a2', 'e0870000-0000-4000-8000-00000000000a', 'R087 Draft', 'x', '', 'draft', 0, null, 'Lev Tolstoi Ëç'),
  ('e0871000-0000-4000-8000-0000000000a3', 'e0870000-0000-4000-8000-00000000000a', 'R087 Own', 'x', '', 'published', 0, now(), null);

-- part4's book: a ready draft, never sent.
insert into public.books (id, author_id, title, description, keywords, status, price_all, published_at, file_path, cover_path, original_author) values
  ('e0871000-0000-4000-8000-0000000000a4', 'e0870000-0000-4000-8000-00000000000a', 'R087 Review', 'About it.', '', 'draft', 199, null,
   'e0870000-0000-4000-8000-00000000000a/e0871000-0000-4000-8000-0000000000a4/f0000000-0000-4000-8000-000000000001.epub',
   'e087c0de-0000-4000-8000-0000000000a4/cover.png', 'Homeri');

-- part1
select pg_temp.assert(
  (select not a.attnotnull and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'text'
     from pg_catalog.pg_attribute a
    where a.attrelid = 'public.books'::regclass and a.attname = 'original_author' and not a.attisdropped),
  'part1: books.original_author is nullable text');
select pg_temp.assert(
  (select count(*) from pg_catalog.pg_constraint
    where conrelid = 'public.books'::regclass and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) like '%original_author%') = 1
  and exists (select 1 from pg_catalog.pg_constraint
               where conrelid = 'public.books'::regclass and conname = 'books_original_author_check' and convalidated),
  'part1: exactly one CHECK mentions original_author, named books_original_author_check, validated');

do $$
declare
  v text;
begin
  foreach v in array array['Lev Tolstoi', 'Ismail Kadare', 'A', 'Fan S. Noli', 'Gjergj Fishta, At', repeat('ë', 200)] loop
    perform pg_temp.assert(pg_temp.try_value(v) = 'ok', 'part1: accepts "' || left(v, 20) || '"');
  end loop;
  foreach v in array array['', ' ', ' Tolstoi', 'Tolstoi ', 'Tol' || chr(9) || 'stoi', 'Tol' || chr(10) || 'stoi',
                           'Tol' || chr(0127) || 'stoi', repeat('a', 201)] loop
    perform pg_temp.assert(pg_temp.try_value(v) = 'refused', 'part1: refuses "' || left(replace(v, chr(10), '\n'), 20) || '"');
  end loop;
  perform pg_temp.assert(pg_temp.try_value(null) = 'ok', 'part1: accepts NULL');
end $$;

-- part2
do $$
declare
  v text;
begin
  v := pg_temp.value_as('anon', null,
    $q$select original_author from public.public_books where id = 'e0871000-0000-4000-8000-0000000000a1'$q$);
  perform pg_temp.assert(v = 'Lev Tolstoi Ëç', format('part2: anon reads a published book''s original author -- got %s', v));
  v := pg_temp.value_as('anon', null,
    $q$select count(*)::text from public.public_books where id = 'e0871000-0000-4000-8000-0000000000a2'$q$);
  perform pg_temp.assert(v = '0', format('part2: anon does not see a draft -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0870000-0000-4000-8000-00000000000b',
    $q$select count(*)::text from public.public_books where id = 'e0871000-0000-4000-8000-0000000000a2'$q$);
  perform pg_temp.assert(v = '0', format('part2: another account does not see a draft -- got %s', v));
  v := pg_temp.value_as('authenticated', 'e0870000-0000-4000-8000-00000000000a',
    $q$select original_author from public.public_books where id = 'e0871000-0000-4000-8000-0000000000a2'$q$);
  perform pg_temp.assert(v = 'Lev Tolstoi Ëç', format('part2: the author reads their draft''s original author -- got %s', v));
  v := pg_temp.value_as('anon', null,
    $q$select original_author from public.books limit 1$q$);
  perform pg_temp.assert(v = 'ERR:42501', format('part2: anon may not read books -- got %s', v));

  v := pg_temp.run_as('authenticated', 'e0870000-0000-4000-8000-00000000000a',
    $q$update public.books set original_author = 'X' where id = 'e0871000-0000-4000-8000-0000000000a1'$q$);
  perform pg_temp.assert(v = '42501', format('part2: an author session may not update original_author -- got %s', v));
  v := pg_temp.run_as('authenticated', 'e0870000-0000-4000-8000-00000000000a',
    $q$update public.public_books set original_author = 'X' where id = 'e0871000-0000-4000-8000-0000000000a1'$q$);
  perform pg_temp.assert(v = '42501', format('part2: nobody writes through public_books -- got %s', v));
end $$;

select pg_temp.assert(
  (select original_author from public.books where id = 'e0871000-0000-4000-8000-0000000000a1') = 'Lev Tolstoi Ëç',
  'part2: the refused writes changed nothing');

-- part3
do $$
declare
  v text;
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    v := pg_temp.value_as(r, 'e0870000-0000-4000-8000-00000000000b',
      $q$select string_agg(book_id::text, ',' order by book_id) from public.search_books('tolstoi ec', null, null, null, 500)$q$);
    perform pg_temp.assert(v = 'e0871000-0000-4000-8000-0000000000a1',
      format('part3: %s finds the published book by its original author, accent-blind, never the draft -- got %s', r, v));
    v := pg_temp.value_as(r, 'e0870000-0000-4000-8000-00000000000b',
      $q$select count(*)::text from public.search_books('Kadare', null, null, null, 500)$q$);
    perform pg_temp.assert(v = '0', format('part3: %s gets no false match -- got %s', r, v));
    v := pg_temp.value_as(r, 'e0870000-0000-4000-8000-00000000000b',
      $q$select count(*)::text from public.search_books('R087 Own', null, null, null, 500)$q$);
    perform pg_temp.assert(v = '1', format('part3: %s still finds a book without one by its title -- got %s', r, v));
  end loop;
end $$;

-- part4: the review approval binds to the original author (Renato
-- 16:37Z 2b, 16:45Z a).
do $$
declare
  bk constant uuid := 'e0871000-0000-4000-8000-0000000000a4';
  au constant uuid := 'e0870000-0000-4000-8000-00000000000a';
  st constant uuid := 'e0870000-0000-4000-8000-00000000000c';
  f text := (select file_path from public.books where id = 'e0871000-0000-4000-8000-0000000000a4');
  c text := (select cover_path from public.books where id = 'e0871000-0000-4000-8000-0000000000a4');
  rid uuid;
  v text;
  ck constant text := '{"cover_is_fine": true, "file_opens": true, "not_someone_elses_work": true, "rights_declared": true}';
begin
  -- The function and the trigger.
  perform pg_temp.assert(to_regprocedure('public.book_review_approval_valid(uuid,text,text)') is null,
    'part4: the 3-argument approval function is gone');
  perform pg_temp.assert(
    not has_function_privilege('anon', 'public.book_review_approval_valid(uuid,text,text,text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.book_review_approval_valid(uuid,text,text,text)', 'EXECUTE')
    and not has_function_privilege('service_role', 'public.book_review_approval_valid(uuid,text,text,text)', 'EXECUTE')
    and (select prosecdef from pg_proc where oid = 'public.book_review_approval_valid(uuid,text,text,text)'::regprocedure)
    and (select proconfig from pg_proc where oid = 'public.book_review_approval_valid(uuid,text,text,text)'::regprocedure)
        = array['search_path=""'],
    'part4: the 4-argument approval function is internal, SECURITY DEFINER, search_path empty');
  perform pg_temp.assert((select pg_get_triggerdef(oid) from pg_trigger where tgname = 'books_refuse_live_file_change')
      like '%BEFORE UPDATE OF file_path, cover_path, original_author ON public.books FOR EACH ROW%',
    'part4: the live-files guard also fires on original_author');
  perform pg_temp.assert(
    (select not a.attnotnull and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'text'
       from pg_catalog.pg_attribute a
      where a.attrelid = 'public.book_reviews'::regclass and a.attname = 'original_author' and not a.attisdropped),
    'part4: book_reviews.original_author is nullable text');
  v := pg_temp.value_as('authenticated', au,
    $q$select original_author from public.book_reviews limit 1$q$);
  perform pg_temp.assert(v = 'ERR:42501', format('part4: an author cannot read the snapshot column -- got %s', v));

  -- Sending snapshots it; the same again is "already waiting".
  v := pg_temp.run_msg('authenticated', au, format('select public.request_book_review(%L)', bk));
  perform pg_temp.assert(v = 'OK', format('part4: the author sends the book -- got %s', v));
  perform pg_temp.assert((select original_author from public.book_reviews where book_id = bk and status = 'pending') = 'Homeri',
    'part4: the pending row snapshots the original author');
  v := pg_temp.run_msg('authenticated', au, format('select public.request_book_review(%L)', bk));
  perform pg_temp.assert(v = 'P0001:this book is already waiting for review', format('part4: same again -- got %s', v));

  -- A new original author replaces the pending row.
  update public.books set original_author = 'Homer' where id = bk;
  v := pg_temp.run_msg('authenticated', au, format('select public.request_book_review(%L)', bk));
  perform pg_temp.assert(v = 'OK', format('part4: a new original author is a new request -- got %s', v));
  perform pg_temp.assert(
    (select count(*) from public.book_reviews where book_id = bk and status = 'cancelled' and original_author = 'Homeri') = 1
    and (select original_author from public.book_reviews where book_id = bk and status = 'pending') = 'Homer',
    'part4: the stale pending row is cancelled, the new one carries the new name');
  rid := (select id from public.book_reviews where book_id = bk and status = 'pending');

  -- Approve refuses when the book's original author is no longer the snapshot's.
  update public.books set original_author = 'Homeri' where id = bk;
  v := pg_temp.run_msg('authenticated', st,
    format('select public.admin_approve_book_review(%L, %L, %L, 199, %L::jsonb)', rid, f, c, ck));
  perform pg_temp.assert(v = 'P0001:the author changed the book', format('part4: approve after a change is refused -- got %s', v));
  update public.books set original_author = null where id = bk;
  v := pg_temp.run_msg('authenticated', st,
    format('select public.admin_approve_book_review(%L, %L, %L, 199, %L::jsonb)', rid, f, c, ck));
  perform pg_temp.assert(v = 'P0001:the author changed the book', format('part4: nor after it is cleared -- got %s', v));
  update public.books set original_author = 'Homer' where id = bk;
  v := pg_temp.run_msg('authenticated', st,
    format('select public.admin_approve_book_review(%L, %L, %L, 199, %L::jsonb)', rid, f, c, ck));
  perform pg_temp.assert(v = 'OK', format('part4: the matching original author is approved -- got %s', v));
  perform pg_temp.assert((select status from public.books where id = bk) = 'published', 'part4: and the book is live');

  -- Live: the original author changes only with a move to draft in the same write.
  v := pg_temp.run_msg('service_role', null, format($q$update public.books set original_author = 'X' where id = %L$q$, bk));
  perform pg_temp.assert(v like 'LB463:%', format('part4: a live book''s original author cannot change -- got %s', v));
  v := pg_temp.run_msg('service_role', null, format($q$update public.books set original_author = null where id = %L$q$, bk));
  perform pg_temp.assert(v like 'LB463:%', format('part4: nor be cleared -- got %s', v));
  v := pg_temp.run_msg('service_role', null, format($q$update public.books set original_author = 'Homer' where id = %L$q$, bk));
  perform pg_temp.assert(v = 'OK', format('part4: writing the same value is fine -- got %s', v));
  v := pg_temp.run_msg('service_role', null,
    format($q$update public.books set original_author = 'X', status = 'draft' where id = %L$q$, bk));
  perform pg_temp.assert(v = 'OK', format('part4: with the move to draft it saves -- got %s', v));

  -- The old approval does not cover the new name.
  v := pg_temp.run_msg('service_role', null, format($q$update public.books set status = 'published' where id = %L$q$, bk));
  perform pg_temp.assert(v like 'LB462:%', format('part4: the old approval cannot publish the new name -- got %s', v));
  v := pg_temp.value_as('authenticated', au, format('select (public.book_review_state(%L) ->> ''approval_valid'')', bk));
  perform pg_temp.assert(v = 'false', format('part4: book_review_state says not approved -- got %s', v));
  v := pg_temp.run_msg('authenticated', au, format('select public.request_book_review(%L)', bk));
  perform pg_temp.assert(v = 'OK', format('part4: so it can be sent again -- got %s', v));

  -- Back to the approved name while that review waits (audit r2, M1):
  -- the approval is valid again, a new request says so, and the stale
  -- pending review is withdrawn (the app does this on that answer).
  update public.books set original_author = 'Homer' where id = bk;
  v := pg_temp.value_as('authenticated', au, format('select (public.book_review_state(%L) ->> ''approval_valid'')', bk));
  perform pg_temp.assert(v = 'true', format('part4: the approved name is approved again -- got %s', v));
  v := pg_temp.run_msg('authenticated', au, format('select public.request_book_review(%L)', bk));
  perform pg_temp.assert(v = 'P0001:this book is already approved', format('part4: and needs no new request -- got %s', v));
  v := pg_temp.run_msg('authenticated', au, format('select public.withdraw_book_review(%L)', bk));
  perform pg_temp.assert(v = 'OK', format('part4: the stale pending review can be withdrawn -- got %s', v));
  perform pg_temp.assert(not exists (select 1 from public.book_reviews where book_id = bk and status = 'pending'),
    'part4: nothing is left waiting');
  v := pg_temp.run_msg('service_role', null, format($q$update public.books set status = 'published' where id = %L$q$, bk));
  perform pg_temp.assert(v = 'OK', format('part4: and can go live -- got %s', v));
end $$;

-- An approval given before this migration (null snapshot) still covers a
-- book with no original author.
select pg_temp.assert(
  public.book_review_approval_valid('e0871000-0000-4000-8000-0000000000a4',
    (select file_path from public.books where id = 'e0871000-0000-4000-8000-0000000000a4'),
    (select cover_path from public.books where id = 'e0871000-0000-4000-8000-0000000000a4'), 'Homer')
  and not public.book_review_approval_valid('e0871000-0000-4000-8000-0000000000a4',
    (select file_path from public.books where id = 'e0871000-0000-4000-8000-0000000000a4'),
    (select cover_path from public.books where id = 'e0871000-0000-4000-8000-0000000000a4'), null),
  'part4: the approval function compares the original author like the file and cover (null is not ''Homer'')');

do $$
declare v_n int;
begin
  select n into v_n from pg_temp.assertions_run;
  -- Audit r1 (N7): a dropped block must not pass quietly.
  if v_n < 55 then
    raise exception 'FAIL: only % assertions ran (expected at least 55)', v_n;
  end if;
  raise warning '087_bd3_original_author: % assertions passed', v_n;
  raise notice 'ALL PASSED: 087_bd3_original_author.test.sql (% assertions)', v_n;
end $$;

rollback;
