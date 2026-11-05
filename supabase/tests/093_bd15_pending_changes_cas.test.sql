-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for BD15 P5b-3b
-- (supabase/migrations/20261105120000_bd15_pending_changes_cas.sql):
-- * part1  the row's version: a fresh number from one sequence on every
--          insert and update, whatever a writer puts in it;
-- * part2  save compares the version the caller read (LB496): a stale
--          version, null when a row exists, a version when none does;
--          the refused save changes nothing;
-- * part3  audit P5b-2 r1 F4: a Details save that read before a Content
--          save is refused and the row keeps the newer ballinë;
-- * part4  discard compares the version the same way; a row deleted and
--          created again never gets back a number an older request read
--          (audit P5b-3b r1, F1: the ABA case);
-- * part5  a row gone through approval or going offline: a save or
--          discard with the old version is refused;
-- * part6  who may call the two functions; the old signatures are gone;
--          both lock the book FOR SHARE before the row (audit P5b-1 r2,
--          R2-1: the discard's lock is what keeps a takedown from
--          deadlocking).
--
-- The schema.sql / migration equivalence and the rollback are in
-- 093_bd15_pending_changes_cas_catalog_equivalence.sh.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/093_bd15_pending_changes_cas.test.sql
--
-- Against the BASE schema it fails at once (no version column): the
-- negative control.
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

-- Runs p_sql as p_role (null = the table owner, role none) with
-- auth.uid() = p_sub; returns 'OK:<rows>' or '<sqlstate>:<message>'.
-- Each call is its own subtransaction.
create function pg_temp.run_as(p_role text, p_sub text, p_sql text) returns text
  language plpgsql as $$
declare
  v_state text;
  v_msg text;
  v_rows bigint;
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  if p_role is not null then
    execute format('set local role %I', p_role);
  end if;
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
    set constraints all immediate;
    set constraints all deferred;
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

create function pg_temp.checklist() returns text language sql as $$
  select '{"cover_is_fine": true, "file_opens": true, "not_someone_elses_work": true, "rights_declared": true}'
$$;

-- Staff approves the book's pending review with the given paths/price.
create function pg_temp.approve(p_book uuid, p_file text, p_cover text, p_price integer) returns text
  language sql as $$
  select pg_temp.value_as('authenticated', 'e0930000-0000-4000-8000-0000000000c1',
    format('select public.admin_approve_book_review(%L, %L, %L, %s, %L::jsonb)::text',
      (select id from public.book_reviews where book_id = p_book and status = 'pending'),
      p_file, p_cover, p_price, pg_temp.checklist()))
$$;

create function pg_temp.request(p_sub text, p_book uuid) returns text language sql as $$
  select pg_temp.value_as('authenticated', p_sub, format('select public.request_book_review(%L)::text', p_book))
$$;

-- The catalog writer's two writes (service_role), with the version
-- the caller read passed explicitly.
create function pg_temp.save(p_book text, p_expected bigint, p_cover text, p_desc text) returns text language sql as $$
  select pg_temp.value_as('service_role', null,
    format('select public.save_book_pending_changes(%L, %L, %L, %L, %L, %L, false, null)::text',
      'e0930000-0000-4000-8000-00000000000a', p_book, p_expected, 'a/x/v2.epub', p_cover, p_desc))
$$;
create function pg_temp.discard(p_book text, p_expected bigint) returns text language sql as $$
  select pg_temp.value_as('service_role', null,
    format('select public.discard_book_pending_changes(%L, %L, %L)::text', 'e0930000-0000-4000-8000-00000000000a', p_book, p_expected))
$$;
create function pg_temp.row_of(p_book text) returns text language sql as $$
  select coalesce((select c.version || '|' || c.cover_path || '|' || c.description
                     from public.book_pending_changes c where c.book_id = p_book::uuid), 'none')
$$;

-- ============================================================
-- Fixture: author A, staff S; live books l1..l4 with an approved review
-- and an AI answer.
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0930000-0000-4000-8000-00000000000a', 'p093-a@test', now(), '{"role":"author","display_name":"P093 Ana"}'),
  ('e0930000-0000-4000-8000-0000000000c1', 'p093-s@test', now(), '{"role":"reader","display_name":"P093 Staff"}');
insert into public.staff_members (user_id, role) values
  ('e0930000-0000-4000-8000-0000000000c1', 'owner');

insert into public.books (id, author_id, title, description, price_all, status, published_at, file_path, cover_path, categories)
select ('e0930001-0000-4000-8000-00000000000' || n)::uuid, 'e0930000-0000-4000-8000-00000000000a', 'P093 l' || n, 'Old ' || n || '.',
       0, 'published', now(), 'a/l' || n || '/v1.epub', ('e093000c-0000-4000-8000-00000000000' || n || '/cover.jpg'), array['Poezi']
  from generate_series(1, 4) n;

insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, original_author, description, is_adult,
                                 status, checklist, submitted_at, decided_at)
select bo.id, bo.title, bo.author_id, bo.file_path, bo.cover_path, bo.original_author, bo.description, bo.is_adult,
       'approved', pg_temp.checklist()::jsonb, now() - interval '1 day', now() - interval '1 day'
  from public.books bo
 where bo.id::text like 'e0930001-%';

insert into public.book_ai_disclosures (book_id, ai_used)
select bo.id, false from public.books bo where bo.id::text like 'e0930001-%';

-- ============================================================
-- Part 1: the version
-- ============================================================
-- The numbers below count from 1 in this transaction: every insert and
-- update (also one later refused by a CHECK) draws the next one.
alter sequence public.book_pending_changes_version_seq restart with 1;
select pg_temp.assert(pg_temp.save('e0930001-0000-4000-8000-000000000001', null, 'e093000c-0000-4000-8000-000000000021/cover.jpg', 'New 1.') = '1',
  'part1: a first save (read no row) creates a row and returns its version');
select pg_temp.assert(pg_temp.save('e0930001-0000-4000-8000-000000000001', 1, 'e093000c-0000-4000-8000-000000000022/cover.jpg', 'Newer 1.') = '2',
  'part1: a save with the version read returns a new one');
select pg_temp.assert(pg_temp.row_of('e0930001-0000-4000-8000-000000000001') = '2|e093000c-0000-4000-8000-000000000022/cover.jpg|Newer 1.',
  'part1: the row holds the second save');
select pg_temp.assert(pg_temp.run_as(null, null,
  $q$update public.book_pending_changes set version = 99, description = 'Owner.' where book_id = 'e0930001-0000-4000-8000-000000000001'$q$) = 'OK:1'
  and pg_temp.row_of('e0930001-0000-4000-8000-000000000001') like '3|%|Owner.',
  'part1: any update takes a new number, whatever it writes into version');
select pg_temp.assert(pg_temp.run_as(null, null,
  $q$update public.book_pending_changes set description = 'Newer 1.' where book_id = 'e0930001-0000-4000-8000-000000000001'$q$) = 'OK:1'
  and pg_temp.row_of('e0930001-0000-4000-8000-000000000001') like '4|%',
  'part1: (back to the saved text, version 4)');
select pg_temp.assert(pg_temp.run_as(null, null,
  $q$insert into public.book_pending_changes (book_id, file_path, cover_path, description, is_adult, version)
     values ('e0930001-0000-4000-8000-000000000004', 'a/l4/v2.epub', 'e093000c-0000-4000-8000-000000000041/cover.jpg', 'Owner 4.', false, 42)$q$) = 'OK:1'
  and pg_temp.row_of('e0930001-0000-4000-8000-000000000004') like '5|%',
  'part1: an insert takes the next number, never the writer''s');

-- ============================================================
-- Part 2: save compares
-- ============================================================
select pg_temp.assert(pg_temp.save('e0930001-0000-4000-8000-000000000001', 3, 'e093000c-0000-4000-8000-000000000023/cover.jpg', 'Stale.') like 'LB496:%',
  'part2: a stale version is refused');
select pg_temp.assert(pg_temp.save('e0930001-0000-4000-8000-000000000001', null, 'e093000c-0000-4000-8000-000000000023/cover.jpg', 'Stale.') like 'LB496:%',
  'part2: "read no row" while one exists is refused');
select pg_temp.assert(pg_temp.save('e0930001-0000-4000-8000-000000000001', 99, 'e093000c-0000-4000-8000-000000000023/cover.jpg', 'Stale.') like 'LB496:%',
  'part2: a version from the future is refused');
select pg_temp.assert(pg_temp.save('e0930001-0000-4000-8000-000000000001', 5, 'e093000c-0000-4000-8000-000000000023/cover.jpg', 'Stale.') like 'LB496:%',
  'part2: another book''s version is refused');
select pg_temp.assert(pg_temp.save('e0930001-0000-4000-8000-000000000002', 1, 'e093000c-0000-4000-8000-000000000023/cover.jpg', 'Stale.') like 'LB496:%',
  'part2: a version when no row exists (it went away) is refused');
select pg_temp.assert(pg_temp.row_of('e0930001-0000-4000-8000-000000000001') = '4|e093000c-0000-4000-8000-000000000022/cover.jpg|Newer 1.'
  and pg_temp.row_of('e0930001-0000-4000-8000-000000000002') = 'none',
  'part2: the refused saves changed nothing');
select pg_temp.assert(pg_temp.save('e0930001-0000-4000-8000-000000000001', 4, 'e093000c-0000-4000-8000-000000000023/cover.jpg', 'Newest 1.') = '6',
  'part2: the right version still saves');
-- The other rules still come first or still hold.
select pg_temp.assert(pg_temp.save('e0930001-0000-4000-8000-000000000001', 6, 'e093000c-0000-4000-8000-000000000023/cover.jpg', '  ') like '23514:%',
  'part2: a blank description is still refused');
select pg_temp.assert(pg_temp.value_as('service_role', null,
  format('select public.save_book_pending_changes(%L, %L, null, %L, %L, %L, false, null)::text',
    'e0930000-0000-4000-8000-0000000000c1', 'e0930001-0000-4000-8000-000000000002', 'x', 'e093000c-0000-4000-8000-000000000029/cover.jpg', 'X.'))
  = 'P0001:no book found for this id', 'part2: another account''s book is still answered as missing');

-- ============================================================
-- Part 3: audit P5b-2 r1 F4
-- ============================================================
-- Details (A) reads l3's row at version 1 (cover C1); Content (B) saves
-- a new ballinë C2 with version 1; A then saves its stale base.
select pg_temp.assert(pg_temp.save('e0930001-0000-4000-8000-000000000003', null, 'e093000c-0000-4000-8000-000000000031/cover.jpg', 'Waiting 3.') = '8',
  'part3: l3 waits with ballinë C1 (7 went to the save the CHECK refused)');
select pg_temp.assert(pg_temp.save('e0930001-0000-4000-8000-000000000003', 8, 'e093000c-0000-4000-8000-000000000032/cover.jpg', 'Waiting 3.') = '9',
  'part3: B saves ballinë C2');
select pg_temp.assert(pg_temp.save('e0930001-0000-4000-8000-000000000003', 8, 'e093000c-0000-4000-8000-000000000031/cover.jpg', 'Edited 3.') like 'LB496:%',
  'part3: A''s save from the older read is refused');
select pg_temp.assert(pg_temp.row_of('e0930001-0000-4000-8000-000000000003') = '9|e093000c-0000-4000-8000-000000000032/cover.jpg|Waiting 3.',
  'part3: the row still names C2, never the removed C1');

-- ============================================================
-- Part 4: discard compares
-- ============================================================
select pg_temp.assert(pg_temp.discard('e0930001-0000-4000-8000-000000000003', 8) like 'LB496:%',
  'part4: a stale version is refused');
select pg_temp.assert(pg_temp.discard('e0930001-0000-4000-8000-000000000003', null) like 'LB496:%',
  'part4: "read no row" while one exists is refused');
select pg_temp.assert(pg_temp.row_of('e0930001-0000-4000-8000-000000000003') like '9|%',
  'part4: the refused discards kept the row');
select pg_temp.assert(pg_temp.discard('e0930001-0000-4000-8000-000000000003', 9) = 'true'
  and pg_temp.row_of('e0930001-0000-4000-8000-000000000003') = 'none',
  'part4: the right version discards');
select pg_temp.assert(pg_temp.discard('e0930001-0000-4000-8000-000000000003', null) = 'false',
  'part4: nothing read, nothing there: false');
select pg_temp.assert(pg_temp.discard('e0930001-0000-4000-8000-000000000003', 9) like 'LB496:%',
  'part4: a version read when the row has gone since is refused');
select pg_temp.assert(pg_temp.save('e0930001-0000-4000-8000-000000000003', null, 'e093000c-0000-4000-8000-000000000033/cover.jpg', 'Again 3.') = '10',
  'part4: after a discard the next row takes a new number, never one an older read saw');
-- Audit P5b-3b r1, F1 (ABA): a request that read the discarded row
-- (version 9) and is still running saves now: refused, the new row
-- (another tab's ballinë) stands.
select pg_temp.assert(pg_temp.save('e0930001-0000-4000-8000-000000000003', 9, 'e093000c-0000-4000-8000-000000000031/cover.jpg', 'Stale 3.') like 'LB496:%',
  'part4: a save from a read of the discarded row is refused (ABA)');
select pg_temp.assert(pg_temp.discard('e0930001-0000-4000-8000-000000000003', 9) like 'LB496:%',
  'part4: and so is a discard from it');
select pg_temp.assert(pg_temp.row_of('e0930001-0000-4000-8000-000000000003') = '10|e093000c-0000-4000-8000-000000000033/cover.jpg|Again 3.',
  'part4: the new row is untouched');

-- ============================================================
-- Part 5: the row went through approval or offline
-- ============================================================
select pg_temp.assert(pg_temp.request('e0930000-0000-4000-8000-00000000000a', 'e0930001-0000-4000-8000-000000000001') ~ '^[0-9a-f-]{36}$',
  'part5: l1''s changes are sent');
select pg_temp.assert(pg_temp.save('e0930001-0000-4000-8000-000000000001', 6, 'e093000c-0000-4000-8000-000000000024/cover.jpg', 'In review.') like 'LB490:%',
  'part5: in review, the row is still read-only (LB490 before any compare)');
select pg_temp.assert(pg_temp.approve('e0930001-0000-4000-8000-000000000001', 'a/x/v2.epub', 'e093000c-0000-4000-8000-000000000023/cover.jpg', 0) = 'false',
  'part5: staff approve l1');
select pg_temp.assert(pg_temp.row_of('e0930001-0000-4000-8000-000000000001') = 'none'
  and pg_temp.save('e0930001-0000-4000-8000-000000000001', 6, 'e093000c-0000-4000-8000-000000000025/cover.jpg', 'Late.') like 'LB496:%',
  'part5: a save read before the approval is refused');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set status = 'draft' where id = 'e0930001-0000-4000-8000-000000000004'$q$) = 'OK:1'
  and pg_temp.row_of('e0930001-0000-4000-8000-000000000004') = 'none',
  'part5: l4 goes offline and its row becomes the draft');
select pg_temp.assert(pg_temp.discard('e0930001-0000-4000-8000-000000000004', 5) like 'LB496:%',
  'part5: a discard read before it went offline is refused (not a silent false)');

-- ============================================================
-- Part 6: who may call; the old forms; the lock order
-- ============================================================
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0930000-0000-4000-8000-00000000000a',
  format('select public.save_book_pending_changes(%L, %L, null, %L, %L, %L, false, null)',
    'e0930000-0000-4000-8000-00000000000a', 'e0930001-0000-4000-8000-000000000002', 'x', 'e093000c-0000-4000-8000-000000000098/cover.jpg', 'z'))
  like '42501:%', 'part6: the author''s session can''t call save');
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select public.discard_book_pending_changes('e0930000-0000-4000-8000-00000000000a', 'e0930001-0000-4000-8000-000000000002', null)$q$)
  like '42501:%', 'part6: nor anon discard');
select pg_temp.assert(not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('save_book_pending_changes', 'discard_book_pending_changes')
       and p.pronargs not in (3, 8)),
  'part6: the seven- and two-argument forms are gone');
select pg_temp.assert(has_function_privilege('service_role', 'public.save_book_pending_changes(uuid, uuid, bigint, text, text, text, boolean, text)', 'execute')
  and has_function_privilege('service_role', 'public.discard_book_pending_changes(uuid, uuid, bigint)', 'execute')
  and not has_function_privilege('authenticated', 'public.save_book_pending_changes(uuid, uuid, bigint, text, text, text, boolean, text)', 'execute')
  and not has_function_privilege('anon', 'public.discard_book_pending_changes(uuid, uuid, bigint)', 'execute')
  and not has_function_privilege('authenticated', 'public.book_pending_changes_set_version()', 'execute'),
  'part6: only the catalog writer executes them');
select pg_temp.assert(not has_sequence_privilege('service_role', 'public.book_pending_changes_version_seq', 'usage')
  and not has_sequence_privilege('service_role', 'public.book_pending_changes_version_seq', 'update')
  and not has_sequence_privilege('authenticated', 'public.book_pending_changes_version_seq', 'usage')
  and not has_sequence_privilege('anon', 'public.book_pending_changes_version_seq', 'select'),
  'part6: nobody but the owner can draw from or reset the version sequence');
select pg_temp.assert((select bool_and(
           position('for share' in p.prosrc) > 0
       and position('for update' in p.prosrc) > position('for share' in p.prosrc))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('save_book_pending_changes', 'discard_book_pending_changes')),
  'part6: both lock the book FOR SHARE, then the row (audit P5b-1 r2, R2-1)');

do $$
begin
  perform pg_temp.assert((select n from pg_temp.assertions_run) > 40,
    format('expected more than 40 assertions, ran %s', (select n from pg_temp.assertions_run)));
end $$;

select 'ALL PASSED: 093_bd15_pending_changes_cas.test.sql (' || (select n from pg_temp.assertions_run) || ' assertions)' as result;

rollback;
