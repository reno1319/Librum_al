-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for FV1 file versions
-- (supabase/migrations/20261125120000_book_file_versions.sql):
--
-- * part1 the table: columns, one row per book and file, ON DELETE
--   CASCADE, the date and empty-path checks, RLS on with no policy.
-- * part2 who reads and writes it: service_role SELECT only; anon and
--   authenticated nothing; nobody but the trigger writes; nobody but
--   the owner calls the trigger function.
-- * part3 the trigger: a draft's file changes record nothing; a book
--   that goes live records its file once; a live book's new file closes
--   the old row and opens a new one; a file replaced after the book left
--   the shop is closed too; a book's rows go with it.
-- * part4 the backfill (audit r1 N1, r2 N1-r2): run again, it records a
--   published book's current file (open), and for a book taken off sale
--   the latest approved file (the one buyers are served): open while it
--   is still the current file, closed when taking it off sale swapped in
--   a waiting change or the draft's file changed since. A file never
--   approved and a book never on sale get nothing. Same statements as
--   the migration's section 3.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/116_book_file_versions.test.sql
--
-- Against the BASE schema it fails at part1 (no table): the negative
-- control. Everything runs inside one transaction and is rolled back.

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

-- ============================================================
-- Fixture: author A. L a live book with file v1, D a draft with file d1.
-- ============================================================
-- Part 3 swaps a live book's file and publishes a draft by hand, as an
-- approval does; the live-file guard and the approval gate (only an
-- approval may) are set aside for this test. The transaction rolls back.
alter table public.books disable trigger books_refuse_live_file_change;
alter table public.books disable trigger books_require_review_approval;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e1160000-0000-4000-8000-00000000000a', 'p116-a@test', now(), '{"role":"author","display_name":"P116 Ana"}');

insert into public.books (id, author_id, title, description, price_all, status, published_at, file_path, cover_path, categories)
values
  ('e1160001-0000-4000-8000-00000000000a', 'e1160000-0000-4000-8000-00000000000a', 'P116 Live', 'Live.', 0, 'published', now(),
   'a/l/v1.epub', 'e116000c-0000-4000-8000-00000000000a/cover.jpg', array['Horror']),
  ('e1160001-0000-4000-8000-00000000000d', 'e1160000-0000-4000-8000-00000000000a', 'P116 Draft', 'Draft.', 0, 'draft', null,
   'a/d/d1.epub', null, array['Horror']);

-- ============================================================
-- Part 1: the table
-- ============================================================
select pg_temp.assert(
  (select string_agg(a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text, ',' order by a.attnum)
     from pg_attribute a
    where a.attrelid = 'public.book_file_versions'::regclass and a.attnum > 0 and not a.attisdropped)
  = 'id:uuid:true,book_id:uuid:true,file_path:text:true,live_from:timestamp with time zone:true,replaced_at:timestamp with time zone:false',
  'part1: book_file_versions columns');
select pg_temp.assert(
  (select pg_catalog.pg_get_constraintdef(c.oid) from pg_constraint c
    where c.conrelid = 'public.book_file_versions'::regclass and c.conname = 'book_file_versions_book_file_key') = 'UNIQUE (book_id, file_path)',
  'part1: one row per book and file');
select pg_temp.assert(
  (select c.confdeltype = 'c' and c.confrelid = 'public.books'::regclass from pg_constraint c
    where c.conrelid = 'public.book_file_versions'::regclass and c.contype = 'f'),
  'part1: book_id references books ON DELETE CASCADE');
select pg_temp.assert(
  (select c.relrowsecurity from pg_class c where c.oid = 'public.book_file_versions'::regclass)
  and not exists (select 1 from pg_policy p where p.polrelid = 'public.book_file_versions'::regclass),
  'part1: RLS on, no policy');
select pg_temp.assert(
  pg_temp.run_as(null, $q$insert into public.book_file_versions (book_id, file_path)
    values ('e1160001-0000-4000-8000-00000000000a', '')$q$) like '23514:%'
  and pg_temp.run_as(null, $q$insert into public.book_file_versions (book_id, file_path, live_from, replaced_at)
    values ('e1160001-0000-4000-8000-00000000000a', 'a/l/x.epub', now(), now() - interval '1 day')$q$) like '23514:%'
  and pg_temp.run_as(null, $q$insert into public.book_file_versions (book_id, file_path)
    values ('e1160001-0000-4000-8000-00000000000f', 'a/f/v1.epub')$q$) like '23503:%',
  'part1: an empty path, replaced before live and an unknown book are refused');

-- ============================================================
-- Part 2: who reads and writes it
-- ============================================================
select pg_temp.assert(
  pg_temp.run_as('service_role', $q$select 1 from public.book_file_versions$q$) like 'OK:%',
  'part2: service_role reads');
select pg_temp.assert(
  pg_temp.run_as('service_role', $q$insert into public.book_file_versions (book_id, file_path)
    values ('e1160001-0000-4000-8000-00000000000a', 'a/l/x.epub')$q$) like '42501:%'
  and pg_temp.run_as('service_role', $q$update public.book_file_versions set replaced_at = now()$q$) like '42501:%'
  and pg_temp.run_as('service_role', $q$delete from public.book_file_versions$q$) like '42501:%',
  'part2: service_role can''t insert, update or delete');
select pg_temp.assert(
  pg_temp.run_as('anon', $q$select 1 from public.book_file_versions$q$) like '42501:%'
  and pg_temp.run_as('authenticated', $q$select 1 from public.book_file_versions$q$) like '42501:%',
  'part2: anon and authenticated can''t read');
select pg_temp.assert(
  not has_function_privilege('anon', 'public.books_track_file_versions()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.books_track_file_versions()', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.books_track_file_versions()', 'EXECUTE'),
  'part2: no role but the owner calls the trigger function');
select pg_temp.assert(
  (select p.prosecdef and p.proconfig = array['search_path=""'] from pg_proc p
    where p.oid = 'public.books_track_file_versions()'::regprocedure),
  'part2: the trigger function is SECURITY DEFINER with an empty search_path');

-- ============================================================
-- Part 3: the trigger
-- ============================================================
select pg_temp.assert(
  (select count(*) from public.book_file_versions
    where book_id = 'e1160001-0000-4000-8000-00000000000a' and file_path = 'a/l/v1.epub' and replaced_at is null) = 1,
  'part3: a book created live records its file');
select pg_temp.assert(
  not exists (select 1 from public.book_file_versions where book_id = 'e1160001-0000-4000-8000-00000000000d'),
  'part3: a draft records nothing');
update public.books set file_path = 'a/d/d2.epub' where id = 'e1160001-0000-4000-8000-00000000000d';
select pg_temp.assert(
  not exists (select 1 from public.book_file_versions where book_id = 'e1160001-0000-4000-8000-00000000000d'),
  'part3: a draft''s new file records nothing (fv4 a)');
update public.books set status = 'published', published_at = now() where id = 'e1160001-0000-4000-8000-00000000000d';
select pg_temp.assert(
  (select string_agg(file_path || ':' || (replaced_at is null)::text, ',') from public.book_file_versions
    where book_id = 'e1160001-0000-4000-8000-00000000000d') = 'a/d/d2.epub:true',
  'part3: publishing records the file that went live');
update public.books set title = 'P116 Draft renamed' where id = 'e1160001-0000-4000-8000-00000000000d';
update public.books set status = 'published' where id = 'e1160001-0000-4000-8000-00000000000d';
select pg_temp.assert(
  (select count(*) from public.book_file_versions where book_id = 'e1160001-0000-4000-8000-00000000000d') = 1,
  'part3: other updates add no row');
update public.books set file_path = 'a/l/v2.epub' where id = 'e1160001-0000-4000-8000-00000000000a';
select pg_temp.assert(
  (select string_agg(file_path || ':' || (replaced_at is not null)::text, ',' order by file_path) from public.book_file_versions
    where book_id = 'e1160001-0000-4000-8000-00000000000a') = 'a/l/v1.epub:true,a/l/v2.epub:false',
  'part3: a live book''s new file closes the old row and opens a new one');
select pg_temp.assert(
  (select replaced_at >= live_from from public.book_file_versions
    where book_id = 'e1160001-0000-4000-8000-00000000000a' and file_path = 'a/l/v1.epub'),
  'part3: replaced_at is set');
update public.books set status = 'draft' where id = 'e1160001-0000-4000-8000-00000000000a';
update public.books set file_path = 'a/l/v3.epub' where id = 'e1160001-0000-4000-8000-00000000000a';
select pg_temp.assert(
  (select string_agg(file_path || ':' || (replaced_at is not null)::text, ',' order by file_path) from public.book_file_versions
    where book_id = 'e1160001-0000-4000-8000-00000000000a') = 'a/l/v1.epub:true,a/l/v2.epub:true',
  'part3: a once-live file replaced after unpublishing is closed; the draft''s new file adds nothing');
update public.books set file_path = null where id = 'e1160001-0000-4000-8000-00000000000d';
select pg_temp.assert(
  (select replaced_at is not null from public.book_file_versions
    where book_id = 'e1160001-0000-4000-8000-00000000000d' and file_path = 'a/d/d2.epub'),
  'part3: a removed file is closed too');
delete from public.books where id = 'e1160001-0000-4000-8000-00000000000d';
select pg_temp.assert(
  not exists (select 1 from public.book_file_versions where book_id = 'e1160001-0000-4000-8000-00000000000d'),
  'part3: a deleted book''s rows go with it (fv5 a)');
select pg_temp.assert(
  (select count(*) from pg_trigger t where t.tgrelid = 'public.books'::regclass
    and t.tgname = 'books_track_file_versions' and t.tgenabled = 'O') = 1,
  'part3: the trigger is enabled on books');

-- ============================================================
-- Part 4: the backfill (audit r1 N1, r2 N1-r2)
-- ============================================================
-- Books as they stood before the migration (their trigger rows are
-- deleted below). P published; U off sale, still on its latest approved
-- file u1 (u0 approved before it); C off sale, its file changed after
-- approval (c1 approved, c2 current); S live with approved s1 and a
-- waiting change s2, then taken off sale (the swap); N never on sale.
insert into public.books (id, author_id, title, description, price_all, status, published_at, file_path, cover_path, categories)
values
  ('e1160001-0000-4000-8000-0000000000b1', 'e1160000-0000-4000-8000-00000000000a', 'P116 P', 'x', 0, 'published', '2026-10-05T10:00:00Z', 'a/p/p1.epub', null, array['Horror']),
  ('e1160001-0000-4000-8000-0000000000b2', 'e1160000-0000-4000-8000-00000000000a', 'P116 U', 'x', 0, 'draft', '2026-10-06T10:00:00Z', 'a/u/u1.epub', null, array['Horror']),
  ('e1160001-0000-4000-8000-0000000000b3', 'e1160000-0000-4000-8000-00000000000a', 'P116 C', 'x', 0, 'draft', '2026-10-07T10:00:00Z', 'a/c/c2.epub', null, array['Horror']),
  ('e1160001-0000-4000-8000-0000000000b4', 'e1160000-0000-4000-8000-00000000000a', 'P116 N', 'x', 0, 'draft', null, 'a/n/n1.epub', null, array['Horror']),
  ('e1160001-0000-4000-8000-0000000000b5', 'e1160000-0000-4000-8000-00000000000a', 'P116 S', 'x', 0, 'published', '2026-10-08T10:00:00Z', 'a/s/s1.epub', null, array['Horror']);
insert into public.book_reviews (book_id, book_title, author_id, file_path, status, grandfathered, decided_at)
values
  ('e1160001-0000-4000-8000-0000000000b2', 'P116 U', 'e1160000-0000-4000-8000-00000000000a', 'a/u/u0.epub', 'approved', true, now() - interval '3 days'),
  ('e1160001-0000-4000-8000-0000000000b2', 'P116 U', 'e1160000-0000-4000-8000-00000000000a', 'a/u/u1.epub', 'approved', true, now() - interval '2 days'),
  ('e1160001-0000-4000-8000-0000000000b3', 'P116 C', 'e1160000-0000-4000-8000-00000000000a', 'a/c/c1.epub', 'approved', true, now() - interval '2 days'),
  ('e1160001-0000-4000-8000-0000000000b4', 'P116 N', 'e1160000-0000-4000-8000-00000000000a', 'a/n/n1.epub', 'cancelled', false, now()),
  ('e1160001-0000-4000-8000-0000000000b5', 'P116 S', 'e1160000-0000-4000-8000-00000000000a', 'a/s/s1.epub', 'approved', true, now() - interval '2 days');
insert into public.book_pending_changes (book_id, file_path, cover_path, description, is_adult)
values ('e1160001-0000-4000-8000-0000000000b5', 'a/s/s2.epub', 'e1160001-0000-4000-8000-0000000000b5/cover.jpg', 'x', false);
update public.books set status = 'draft' where id = 'e1160001-0000-4000-8000-0000000000b5';
select pg_temp.assert(
  (select file_path from public.books where id = 'e1160001-0000-4000-8000-0000000000b5') = 'a/s/s2.epub',
  'part4: taking S off sale swapped its waiting file in');
-- The trigger recorded some of these; the pre-migration state has none.
delete from public.book_file_versions where book_id::text like 'e1160001-0000-4000-8000-0000000000b%';

insert into public.book_file_versions (book_id, file_path, live_from)
select b.id, b.file_path, least(coalesce(b.published_at, pg_catalog.now()), pg_catalog.now())
  from public.books b
 where b.status = 'published'
   and b.file_path is not null
   and b.file_path <> ''
on conflict on constraint book_file_versions_book_file_key do nothing;

insert into public.book_file_versions (book_id, file_path, live_from, replaced_at)
select b.id, a.file_path,
       least(b.published_at, pg_catalog.now()),
       case when a.file_path = b.file_path then null else pg_catalog.now() end
  from public.books b
  cross join lateral (select r.file_path
                        from public.book_reviews r
                       where r.book_id = b.id
                         and r.status = 'approved'
                         and r.file_path is not null
                         and r.file_path <> ''
                       order by r.decided_at desc nulls last, r.submitted_at desc, r.id desc
                       limit 1) a
 where b.status = 'draft'
   and b.published_at is not null
on conflict on constraint book_file_versions_book_file_key do nothing;

select pg_temp.assert(
  (select string_agg(v.file_path || '@' || to_char(v.live_from at time zone 'UTC', 'YYYY-MM-DD') || ':' || (v.replaced_at is null)::text, ',' order by v.file_path)
     from public.book_file_versions v where v.book_id::text like 'e1160001-0000-4000-8000-0000000000b%')
  = 'a/c/c1.epub@2026-10-07:false,a/p/p1.epub@2026-10-05:true,a/s/s1.epub@2026-10-08:false,a/u/u1.epub@2026-10-06:true',
  'part4: P''s file open; U''s latest approved file open; C''s and S''s approved files closed; no never-approved file, no older approval, nothing for N');
update public.books set file_path = 'a/u/u2.epub' where id = 'e1160001-0000-4000-8000-0000000000b2';
select pg_temp.assert(
  (select replaced_at is not null from public.book_file_versions
    where book_id = 'e1160001-0000-4000-8000-0000000000b2' and file_path = 'a/u/u1.epub')
  and not exists (select 1 from public.book_file_versions
    where book_id = 'e1160001-0000-4000-8000-0000000000b2' and file_path = 'a/u/u2.epub'),
  'part4: replacing the off-sale book''s file keeps the once-live one as an earlier file (fv4 a)');

select pg_temp.assert((select n from pg_temp.assertions_run) >= 23, 'all assertions ran');

rollback;
