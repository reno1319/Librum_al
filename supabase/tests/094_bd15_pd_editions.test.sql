-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for BD15 P7
-- (supabase/migrations/20261105180000_bd15_pd_editions.sql):
-- * part1  HARD GATE: public_books.pen_name_id stays a plain column, now
--          books.public_pen_name_id, with its own foreign key to
--          pen_names; Postgres keeps it (generated);
-- * part2  staff_set_pd_edition: who may call it, link to a new or an
--          existing work, refused for a non-public-domain book;
-- * part3  publishing: an unlinked public-domain book (LB498), a linked
--          one through the plain approval (LB485), through
--          admin_approve_pd_edition (picked);
-- * part4  an uncredited edition hides its uploader from every reader,
--          the author too; the editor mention shows it; a live edition
--          keeps its work;
-- * part5  Q1 a: a picked edition's no-review details and contributors
--          are frozen (LB497), with no error oracle;
-- * part6  Q2 a: a swap -- the new edition picked, the old one back to
--          draft and unfrozen, its page redirected; Q3 a: no hidden
--          candidate is ever published; audit r1 B1: owning (claiming)
--          an uncredited edition shows no row of public_pen_names for
--          its uploader;
-- * part7  unlinking a draft; privileges.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/094_bd15_pd_editions.test.sql
--
-- Against the BASE schema it fails at once (no public_pen_name_id): the
-- negative control. The rollback is 094_bd15_pd_editions.rollback.sql.
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

-- Staff S runs an approval RPC on the book's pending review; run_as
-- checks the deferred constraints too.
create function pg_temp.approve_with(p_fn text, p_book uuid) returns text
  language sql as $$
  select pg_temp.run_as('authenticated', 'e0940000-0000-4000-8000-0000000000c1',
    format('select public.%I(%L, %L, %L, %s, %L::jsonb)', p_fn,
      (select id from public.book_reviews where book_id = p_book and status = 'pending'),
      (select file_path from public.books where id = p_book),
      (select cover_path from public.books where id = p_book),
      (select price_all from public.books where id = p_book),
      pg_temp.checklist()))
$$;

create function pg_temp.set_edition(p_sub text, p_book text, p_work text, p_title text, p_author text, p_credit boolean)
  returns text language sql as $$
  select pg_temp.value_as('authenticated', p_sub,
    format('select coalesce(public.staff_set_pd_edition(%L, %L, %L, %L, %L)::text, ''unlinked'')',
      p_book, p_work, p_title, p_author, p_credit))
$$;

-- ============================================================
-- Fixture: uploaders A and B, staff S, reader R. A has a normal live
-- book (n1), so A's pen name is public. Drafts waiting for review:
-- d1 (A, public domain), d2 (B, public domain), d3 (A, own rights),
-- d4 (B, public domain, never linked).
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0940000-0000-4000-8000-00000000000a', 'p094-a@test', now(), '{"role":"author","display_name":"P094 Ana"}'),
  ('e0940000-0000-4000-8000-00000000000b', 'p094-b@test', now(), '{"role":"author","display_name":"P094 Ben"}'),
  ('e0940000-0000-4000-8000-0000000000c1', 'p094-s@test', now(), '{"role":"reader","display_name":"P094 Staff"}'),
  ('e0940000-0000-4000-8000-0000000000d1', 'p094-r@test', now(), '{"role":"reader","display_name":"P094 Reader"}');
insert into public.staff_members (user_id, role) values
  ('e0940000-0000-4000-8000-0000000000c1', 'owner');

insert into public.books (id, author_id, title, description, price_all, status, published_at, file_path, cover_path, categories, original_author)
values
  ('e0940001-0000-4000-8000-0000000000a1', 'e0940000-0000-4000-8000-00000000000a', 'P094 n1', 'Normal.', 0, 'published', now(),
   'a/n1/v1.epub', 'e094000c-0000-4000-8000-0000000000a1/cover.jpg', array['Poezi'], null),
  ('e0940001-0000-4000-8000-0000000000d1', 'e0940000-0000-4000-8000-00000000000a', 'P094 Lahuta', 'Edition A.', 0, 'draft', null,
   'a/d1/v1.epub', 'e094000c-0000-4000-8000-0000000000d1/cover.jpg', array['Poezi'], 'P094 Classic'),
  ('e0940001-0000-4000-8000-0000000000d2', 'e0940000-0000-4000-8000-00000000000b', 'P094 Lahuta B', 'Edition B.', 0, 'draft', null,
   'b/d2/v1.epub', 'e094000c-0000-4000-8000-0000000000d2/cover.jpg', array['Poezi'], 'P094 Classic'),
  ('e0940001-0000-4000-8000-0000000000d3', 'e0940000-0000-4000-8000-00000000000a', 'P094 Own', 'Own.', 0, 'draft', null,
   'a/d3/v1.epub', 'e094000c-0000-4000-8000-0000000000d3/cover.jpg', array['Poezi'], null),
  ('e0940001-0000-4000-8000-0000000000d4', 'e0940000-0000-4000-8000-00000000000b', 'P094 Unlinked', 'Unlinked.', 0, 'draft', null,
   'b/d4/v1.epub', 'e094000c-0000-4000-8000-0000000000d4/cover.jpg', array['Poezi'], 'P094 Classic');

insert into public.book_rights_declarations (book_id, book_title, author_id, author_public_name, basis, statement_version, statement_text)
select bo.id, bo.title, bo.author_id, 'P094',
       case when bo.id::text like '%a1' or bo.id::text like '%d3' then 'own_rights' else 'public_domain' end,
       'v', 'Statement.'
  from public.books bo where bo.id::text like 'e0940001-%';

insert into public.book_ai_disclosures (book_id, ai_used)
select bo.id, false from public.books bo where bo.id::text like 'e0940001-%';

-- n1's approved review; the drafts' pending ones.
insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, original_author, description, is_adult,
                                 status, checklist, submitted_at, decided_at)
select bo.id, bo.title, bo.author_id, bo.file_path, bo.cover_path, bo.original_author, bo.description, bo.is_adult,
       'approved', pg_temp.checklist()::jsonb, now() - interval '1 day', now() - interval '1 day'
  from public.books bo where bo.id = 'e0940001-0000-4000-8000-0000000000a1';
insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, original_author, description, is_adult,
                                 status, submitted_at)
select bo.id, bo.title, bo.author_id, bo.file_path, bo.cover_path, bo.original_author, bo.description, bo.is_adult,
       'pending', now() - interval '1 hour'
  from public.books bo where bo.id::text like 'e0940001-%' and bo.status = 'draft';

-- ============================================================
-- Part 1: HARD GATE -- the view column stays plain
-- ============================================================
select pg_temp.assert(
  pg_catalog.pg_get_viewdef('public.public_books'::regclass) !~* '\mcase\M'
  and pg_catalog.pg_get_viewdef('public.public_books'::regclass) ~ '\n\s+public_pen_name_id AS pen_name_id,\n',
  'part1: public_books.pen_name_id is the plain column books.public_pen_name_id');
-- What PostgREST reads: the view's rule depends on books.public_pen_name_id,
-- never on books.pen_name_id.
select pg_temp.assert(
  exists (select 1 from pg_depend d join pg_rewrite r on r.oid = d.objid
           join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
          where r.ev_class = 'public.public_books'::regclass and d.refobjid = 'public.books'::regclass
            and a.attname = 'public_pen_name_id')
  and not exists (select 1 from pg_depend d join pg_rewrite r on r.oid = d.objid
           join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
          where r.ev_class = 'public.public_books'::regclass and d.refobjid = 'public.books'::regclass
            and a.attname = 'pen_name_id'),
  'part1: the view reads public_pen_name_id and not pen_name_id');
select pg_temp.assert(
  (select pg_catalog.pg_get_constraintdef(c.oid) from pg_constraint c
    where c.conrelid = 'public.books'::regclass and c.conname = 'books_public_pen_name_id_fkey')
  = 'FOREIGN KEY (public_pen_name_id) REFERENCES pen_names(id)',
  'part1: public_pen_name_id has its own foreign key to pen_names (the embed''s relationship)');
select pg_temp.assert(
  (select a.attgenerated from pg_attribute a
    where a.attrelid = 'public.books'::regclass and a.attname = 'public_pen_name_id') = 's',
  'part1: Postgres keeps it (stored generated): no app role can write it');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set public_pen_name_id = null where id = 'e0940001-0000-4000-8000-0000000000a1'$q$) like '428C9:%',
  'part1: a write to it is refused');
select pg_temp.assert(
  (select (public_pen_name_id = pen_name_id)::text from public.books where id = 'e0940001-0000-4000-8000-0000000000a1') = 'true',
  'part1: a normal book shows its pen name');
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select (pen_name_id is not null)::text from public.public_books where id = 'e0940001-0000-4000-8000-0000000000a1'$q$) = 'true',
  'part1: readers see a normal book''s pen name');

-- ============================================================
-- Part 2: staff link a book to a work
-- ============================================================
select pg_temp.assert(pg_temp.set_edition('e0940000-0000-4000-8000-0000000000d1', 'e0940001-0000-4000-8000-0000000000d1', null,
  'P094 Lahuta', 'P094 Classic', false) like '%not authorized',
  'part2: a reader may not link');
select pg_temp.assert(pg_temp.set_edition('e0940000-0000-4000-8000-00000000000a', 'e0940001-0000-4000-8000-0000000000d1', null,
  'P094 Lahuta', 'P094 Classic', false) like '%not authorized',
  'part2: the uploader may not link their own book');
select pg_temp.assert(pg_temp.set_edition('e0940000-0000-4000-8000-0000000000c1', 'e0940001-0000-4000-8000-0000000000d3', null,
  'P094 Own work', 'P094 Someone', false) like 'LB499:%',
  'part2: a book whose rights choice is own rights is refused');
select pg_temp.assert((select count(*) from public.pd_works where title = 'P094 Own work') = 0,
  'part2: the refused call created no work');
select pg_temp.assert(pg_temp.set_edition('e0940000-0000-4000-8000-0000000000c1', 'e0940001-0000-4000-8000-0000000000d1', null,
  '  ', 'P094 Classic', false) like 'LB499:%',
  'part2: a new work needs a title');
create temp table p094_out (v text) on commit drop;
insert into p094_out select pg_temp.set_edition('e0940000-0000-4000-8000-0000000000c1', 'e0940001-0000-4000-8000-0000000000d1', null,
  ' P094 Lahuta ', ' P094 Classic ', false);
select pg_temp.assert((select v from p094_out) = (select id::text from public.pd_works where title = 'P094 Lahuta'),
  'part2: staff link d1 to a new work (trimmed); its id comes back');
select pg_temp.assert(
  (select (b.pd_work_id = w.id and not b.pd_editor_credit and w.picked_book_id is null)::text
     from public.books b join public.pd_works w on w.title = 'P094 Lahuta'
    where b.id = 'e0940001-0000-4000-8000-0000000000d1') = 'true',
  'part2: d1 is linked, not picked, without a mention');
select pg_temp.assert(
  exists (select 1 from public.admin_audit_log
           where action = 'book.pd_edition_set' and target_id = 'e0940001-0000-4000-8000-0000000000d1'
             and actor_id = 'e0940000-0000-4000-8000-0000000000c1'),
  'part2: the audit log has it');
select pg_temp.assert(pg_temp.set_edition('e0940000-0000-4000-8000-0000000000c1', 'e0940001-0000-4000-8000-0000000000d2',
  (select id::text from public.pd_works where title = 'P094 Lahuta'), null, null, false)
  = (select id::text from public.pd_works where title = 'P094 Lahuta'),
  'part2: d2 is linked to the same work');
select pg_temp.assert(pg_temp.set_edition('e0940000-0000-4000-8000-0000000000c1', 'e0940001-0000-4000-8000-0000000000d2',
  'e0949999-0000-4000-8000-000000000000', null, null, false) like 'LB499:%',
  'part2: a work that does not exist is refused');

-- ============================================================
-- Part 3: publishing
-- ============================================================
select pg_temp.assert(pg_temp.approve_with('admin_approve_book_review', 'e0940001-0000-4000-8000-0000000000d4') like 'LB498:%',
  'part3: an unlinked public-domain book is not published (LB498)');
select pg_temp.assert(pg_temp.approve_with('admin_approve_pd_edition', 'e0940001-0000-4000-8000-0000000000d4') like 'LB499:%',
  'part3: nor through the edition approval');
select pg_temp.assert(pg_temp.approve_with('admin_approve_book_review', 'e0940001-0000-4000-8000-0000000000d1') like 'LB485:%',
  'part3: a linked book that is not picked is not published by the plain approval (LB485)');
select pg_temp.assert(pg_temp.approve_with('admin_approve_book_review', 'e0940001-0000-4000-8000-0000000000d3') = 'OK:1',
  'part3: an own-rights book is approved as before');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0940000-0000-4000-8000-0000000000d1',
  format('select public.admin_approve_pd_edition(%L, %L, %L, 0, %L::jsonb)::text',
    (select id from public.book_reviews where book_id = 'e0940001-0000-4000-8000-0000000000d1' and status = 'pending'),
    'a/d1/v1.epub', 'e094000c-0000-4000-8000-0000000000d1/cover.jpg', pg_temp.checklist())) like '%not authorized',
  'part3: a reader may not approve');
select pg_temp.assert(pg_temp.approve_with('admin_approve_pd_edition', 'e0940001-0000-4000-8000-0000000000d1') = 'OK:1',
  'part3: staff approve d1 as the edition');
select pg_temp.assert(
  (select (b.status = 'published' and w.picked_book_id = b.id)::text
     from public.books b join public.pd_works w on w.id = b.pd_work_id
    where b.id = 'e0940001-0000-4000-8000-0000000000d1') = 'true',
  'part3: d1 is live and is its work''s picked edition');

-- ============================================================
-- Part 4: the uploader stays hidden unless credited
-- ============================================================
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select coalesce(pen_name_id::text, 'null') from public.public_books where id = 'e0940001-0000-4000-8000-0000000000d1'$q$) = 'null',
  'part4: a visitor sees the edition with no pen name');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0940000-0000-4000-8000-0000000000d1',
  $q$select coalesce(pen_name_id::text, 'null') from public.public_books where id = 'e0940001-0000-4000-8000-0000000000d1'$q$) = 'null',
  'part4: so does a signed-in reader');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0940000-0000-4000-8000-00000000000a',
  $q$select coalesce(pen_name_id::text, 'null') from public.public_books where id = 'e0940001-0000-4000-8000-0000000000d1'$q$) = 'null',
  'part4: and its uploader');
select pg_temp.assert(pg_temp.value_as('anon', null,
  format('select string_agg(title, '','' order by title collate "C") from public.public_books where pen_name_id = %L',
    (select pen_name_id from public.books where id = 'e0940001-0000-4000-8000-0000000000a1'))) = 'P094 Own,P094 n1',
  'part4: the pen name''s own book list (its author page) has its normal books only');
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select string_agg(pb.title, ',' order by pb.title collate "C") from public.search_books(search_term => 'P094 Ana') s join public.public_books pb on pb.id = s.book_id$q$) = 'P094 Own,P094 n1',
  'part4: a search for the pen name finds its normal books, not the edition');
select pg_temp.assert(pg_temp.set_edition('e0940000-0000-4000-8000-0000000000c1', 'e0940001-0000-4000-8000-0000000000d1',
  (select pd_work_id::text from public.books where id = 'e0940001-0000-4000-8000-0000000000d1'), null, null, true)
  = (select pd_work_id::text from public.books where id = 'e0940001-0000-4000-8000-0000000000d1'),
  'part4: staff give the live edition the editor mention');
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select pen_name_id::text from public.public_books where id = 'e0940001-0000-4000-8000-0000000000d1'$q$)
  = (select pen_name_id::text from public.books where id = 'e0940001-0000-4000-8000-0000000000a1'),
  'part4: with it, readers see the uploader''s pen name');
select pg_temp.assert(pg_temp.set_edition('e0940000-0000-4000-8000-0000000000c1', 'e0940001-0000-4000-8000-0000000000d1',
  null, 'P094 Other', 'P094 Classic', true) like 'LB499:%'
  and pg_temp.set_edition('e0940000-0000-4000-8000-0000000000c1', 'e0940001-0000-4000-8000-0000000000d1',
  null, null, null, false) like 'LB499:%',
  'part4: a live edition keeps its work (no new work, no unlink)');
select pg_temp.assert(pg_temp.set_edition('e0940000-0000-4000-8000-0000000000c1', 'e0940001-0000-4000-8000-0000000000d1',
  (select pd_work_id::text from public.books where id = 'e0940001-0000-4000-8000-0000000000d1'), null, null, false) not like '%:%',
  'part4: staff take the mention back');
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select coalesce(pen_name_id::text, 'null') from public.public_books where id = 'e0940001-0000-4000-8000-0000000000d1'$q$) = 'null',
  'part4: the mention taken back hides the uploader again');

-- ============================================================
-- Part 5: Q1 a -- a picked edition is frozen
-- ============================================================
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set subtitle = 'New' where id = 'e0940001-0000-4000-8000-0000000000d1'$q$) like 'LB497:%',
  'part5: the subtitle can''t change (the catalog writer, as the author''s save)');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set keywords = 'x' where id = 'e0940001-0000-4000-8000-0000000000d1'$q$) like 'LB497:%'
  and pg_temp.run_as('service_role', null,
  $q$update public.books set isbn = '9780306406157' where id = 'e0940001-0000-4000-8000-0000000000d1'$q$) like 'LB497:%'
  and pg_temp.run_as('service_role', null,
  $q$update public.books set categories = array['Roman'] where id = 'e0940001-0000-4000-8000-0000000000d1'$q$) like 'LB497:%',
  'part5: nor keywords, ISBN or categories');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set subtitle = subtitle, keywords = keywords, categories = categories where id = 'e0940001-0000-4000-8000-0000000000d1'$q$) = 'OK:1',
  'part5: a save that changes none of them passes');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0940000-0000-4000-8000-00000000000a',
  $q$insert into public.book_contributors (book_id, name, role) values ('e0940001-0000-4000-8000-0000000000d1', 'Me', 'Editor')$q$) like 'LB497:%',
  'part5: the uploader can''t add a contributor');
select pg_temp.assert(pg_temp.run_as('authenticated', 'e0940000-0000-4000-8000-00000000000b',
  $q$insert into public.book_contributors (book_id, name, role) values ('e0940001-0000-4000-8000-0000000000d1', 'Me', 'Editor')$q$) not like 'LB497:%',
  'part5: another account is answered by RLS, not LB497 (no oracle)');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set status = 'draft' where id = 'e0940001-0000-4000-8000-0000000000d1'$q$) like 'LB483:%',
  'part5: the author still can''t unpublish it (P1, LB483)');
select pg_temp.assert(pg_temp.run_as(null, null,
  $q$update public.books set subtitle = 'Owner' where id = 'e0940001-0000-4000-8000-0000000000d1'$q$) = 'OK:1'
  and pg_temp.run_as(null, null,
  $q$update public.books set subtitle = null where id = 'e0940001-0000-4000-8000-0000000000d1'$q$) = 'OK:1',
  'part5: Librum''s own SQL session is not refused');

-- ============================================================
-- Part 6: Q2 a / Q3 a -- a swap
-- ============================================================
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select coalesce(public.pd_edition_redirect('e0940001-0000-4000-8000-0000000000d2')::text, 'null')$q$) = 'null',
  'part6: a never-published candidate has no redirect (and is not public)');
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select count(*)::text from public.public_books where id = 'e0940001-0000-4000-8000-0000000000d2'$q$) = '0',
  'part6: the candidate is not listed');
select pg_temp.assert(pg_temp.approve_with('admin_approve_pd_edition', 'e0940001-0000-4000-8000-0000000000d2') = 'OK:1',
  'part6: staff approve d2: a swap');
select pg_temp.assert(
  (select (w.picked_book_id = 'e0940001-0000-4000-8000-0000000000d2')::text from public.pd_works w where w.title = 'P094 Lahuta') = 'true'
  and (select status from public.books where id = 'e0940001-0000-4000-8000-0000000000d2') = 'published'
  and (select status || '|' || (published_at is not null)::text from public.books where id = 'e0940001-0000-4000-8000-0000000000d1') = 'draft|true',
  'part6: d2 is picked and live; d1 is a draft again (it was published once)');
select pg_temp.assert(
  exists (select 1 from public.admin_audit_log
           where action = 'book.pd_edition_replaced' and target_id = 'e0940001-0000-4000-8000-0000000000d1'
             and metadata->>'replaced_by' = 'e0940001-0000-4000-8000-0000000000d2'),
  'part6: the audit log names both');
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select coalesce(public.pd_edition_redirect('e0940001-0000-4000-8000-0000000000d1')::text, 'null')$q$)
  = 'e0940001-0000-4000-8000-0000000000d2',
  'part6: d1''s old page sends readers to d2');
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select coalesce(public.pd_edition_redirect('e0940001-0000-4000-8000-0000000000d2')::text, 'null')$q$) = 'null'
  and pg_temp.value_as('anon', null,
  $q$select coalesce(public.pd_edition_redirect('e0940001-0000-4000-8000-0000000000a1')::text, 'null')$q$) = 'null',
  'part6: a listed book or a normal book has none');
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set subtitle = 'Fixed' where id = 'e0940001-0000-4000-8000-0000000000d1'$q$) = 'OK:1'
  and pg_temp.run_as('service_role', null,
  $q$update public.books set subtitle = 'Frozen' where id = 'e0940001-0000-4000-8000-0000000000d2'$q$) like 'LB497:%',
  'part6: the old edition is no longer frozen; the new one is');
select pg_temp.assert(pg_temp.value_as('anon', null,
  $q$select coalesce(pen_name_id::text, 'null') from public.public_books where id = 'e0940001-0000-4000-8000-0000000000d2'$q$) = 'null',
  'part6: d2''s uploader is hidden too');
-- Audit r1 B1: owning the edition (a free claim) does not show its
-- hidden uploader through public_pen_names either. B has no other
-- public book, so any row for B's pen name would name the uploader.
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0940000-0000-4000-8000-0000000000d1',
  format('select count(*)::text from public.public_pen_names where id = %L',
    (select pen_name_id from public.books where id = 'e0940001-0000-4000-8000-0000000000d2'))) = '0',
  'part6 B1: before claiming, reader R sees no row for d2''s uploader');
insert into public.purchases (book_id, reader_id, amount_cents)
values ('e0940001-0000-4000-8000-0000000000d2', 'e0940000-0000-4000-8000-0000000000d1', 0);
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0940000-0000-4000-8000-0000000000d1',
  $q$select public.user_owns_book('e0940001-0000-4000-8000-0000000000d2')::text$q$) = 'true',
  'part6 B1: R now owns d2');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0940000-0000-4000-8000-0000000000d1',
  format('select count(*)::text from public.public_pen_names where id = %L',
    (select pen_name_id from public.books where id = 'e0940001-0000-4000-8000-0000000000d2'))) = '0',
  'part6 B1: owning the uncredited edition shows R no row for its uploader');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0940000-0000-4000-8000-0000000000d1',
  $q$select coalesce(string_agg(name, ',' order by name), '') from public.public_pen_names where name like 'P094%'$q$)
  = pg_temp.value_as('anon', null,
  $q$select coalesce(string_agg(name, ',' order by name), '') from public.public_pen_names where name like 'P094%'$q$),
  'part6 B1: R''s whole list of pen names is a visitor''s list');
select pg_temp.assert(pg_temp.set_edition('e0940000-0000-4000-8000-0000000000c1', 'e0940001-0000-4000-8000-0000000000d2',
  (select pd_work_id::text from public.books where id = 'e0940001-0000-4000-8000-0000000000d2'), null, null, true) not like '%:%',
  'part6 B1: staff set the editor mention to true');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0940000-0000-4000-8000-0000000000d1',
  format('select count(*)::text from public.public_pen_names where id = %L',
    (select pen_name_id from public.books where id = 'e0940001-0000-4000-8000-0000000000d2'))) = '1',
  'part6 B1: with the editor mention, the uploader''s pen name shows');
select pg_temp.assert(pg_temp.set_edition('e0940000-0000-4000-8000-0000000000c1', 'e0940001-0000-4000-8000-0000000000d2',
  (select pd_work_id::text from public.books where id = 'e0940001-0000-4000-8000-0000000000d2'), null, null, false) not like '%:%',
  'part6 B1: staff set the editor mention to false');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0940000-0000-4000-8000-0000000000d1',
  format('select count(*)::text from public.public_pen_names where id = %L',
    (select pen_name_id from public.books where id = 'e0940001-0000-4000-8000-0000000000d2'))) = '0',
  'part6 B1: the mention taken back hides it from the owner again');
select pg_temp.assert(pg_temp.value_as('authenticated', 'e0940000-0000-4000-8000-0000000000d1',
  format('select count(*)::text from public.public_series where pen_name_id = %L',
    (select pen_name_id from public.books where id = 'e0940001-0000-4000-8000-0000000000d2'))) = '0',
  'part6 B1: no series of the uploader shows either (an edition is never in a series)');
-- One public edition: d1 can't come back by the plain approval.
insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, original_author, description, is_adult,
                                 status, submitted_at)
select bo.id, bo.title, bo.author_id, bo.file_path, bo.cover_path, bo.original_author, bo.description, bo.is_adult,
       'pending', now()
  from public.books bo where bo.id = 'e0940001-0000-4000-8000-0000000000d1';
select pg_temp.assert(pg_temp.approve_with('admin_approve_book_review', 'e0940001-0000-4000-8000-0000000000d1') like 'LB485:%',
  'part6: the old edition is never published beside the picked one');

-- ============================================================
-- Part 7: unlinking a draft; privileges
-- ============================================================
update public.book_reviews set status = 'cancelled', decided_at = now()
 where book_id = 'e0940001-0000-4000-8000-0000000000d1' and status = 'pending';
-- Audit r1 N1: 090 now also accepts LB497 for its series case (a picked
-- edition), so the CHECK itself is pinned here on a linked draft that
-- is not picked (no freeze on it).
insert into public.series (id, author_id, title, pen_name_id)
  select 'e0940003-0000-4000-8000-0000000000a1', b.author_id, 'P094 Series', b.pen_name_id
    from public.books b where b.id = 'e0940001-0000-4000-8000-0000000000d1';
select pg_temp.assert(pg_temp.run_as('service_role', null,
  $q$update public.books set series_id = 'e0940003-0000-4000-8000-0000000000a1', series_position = 1 where id = 'e0940001-0000-4000-8000-0000000000d1'$q$)
  like '23514:%books_pd_series_check%',
  'part7 N1: an uncredited linked draft cannot join a series (the CHECK, not the freeze)');
select pg_temp.assert(pg_temp.set_edition('e0940000-0000-4000-8000-0000000000c1', 'e0940001-0000-4000-8000-0000000000d1',
  null, null, null, true) = 'unlinked', 'part7: staff unlink a draft');
select pg_temp.assert((select (pd_work_id is null and not pd_editor_credit)::text from public.books where id = 'e0940001-0000-4000-8000-0000000000d1') = 'true',
  'part7: unlinked, the mention goes too');
select pg_temp.assert(
  not has_function_privilege('anon', 'public.staff_set_pd_edition(uuid, uuid, text, text, boolean)', 'execute')
  and not has_function_privilege('service_role', 'public.staff_set_pd_edition(uuid, uuid, text, text, boolean)', 'execute')
  and has_function_privilege('authenticated', 'public.staff_set_pd_edition(uuid, uuid, text, text, boolean)', 'execute')
  and not has_function_privilege('anon', 'public.admin_approve_pd_edition(uuid, text, text, integer, jsonb)', 'execute')
  and not has_function_privilege('service_role', 'public.admin_approve_pd_edition(uuid, text, text, integer, jsonb)', 'execute')
  and has_function_privilege('authenticated', 'public.admin_approve_pd_edition(uuid, text, text, integer, jsonb)', 'execute')
  and has_function_privilege('anon', 'public.pd_edition_redirect(uuid)', 'execute')
  and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                   where p.oid in ('public.books_freeze_picked_pd_edition()'::regprocedure,
                                   'public.book_contributors_freeze_picked_pd_edition()'::regprocedure,
                                   'public.books_require_pd_work_link()'::regprocedure)
                     and a.grantee <> p.proowner),
  'part7: who may call each function');
select pg_temp.assert(
  (select count(*) from pg_proc p where p.oid in (
     'public.staff_set_pd_edition(uuid, uuid, text, text, boolean)'::regprocedure,
     'public.admin_approve_pd_edition(uuid, text, text, integer, jsonb)'::regprocedure,
     'public.pd_edition_redirect(uuid)'::regprocedure,
     'public.books_freeze_picked_pd_edition()'::regprocedure,
     'public.book_contributors_freeze_picked_pd_edition()'::regprocedure,
     'public.books_require_pd_work_link()'::regprocedure)
     and p.prosecdef and p.proconfig = array['search_path=""']) = 6,
  'part7: every new function is SECURITY DEFINER with an empty search_path');

do $$
begin
  perform pg_temp.assert((select n from pg_temp.assertions_run) > 40,
    format('expected more than 40 assertions, ran %s', (select n from pg_temp.assertions_run)));
end $$;

select 'ALL PASSED: 094_bd15_pd_editions.test.sql (' || (select n from pg_temp.assertions_run) || ' assertions)' as result;

rollback;
