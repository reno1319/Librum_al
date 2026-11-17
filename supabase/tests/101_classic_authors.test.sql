-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for K6 free Albanian classics
-- (migration 20261116180000_classic_authors.sql).
--   Part 1  shape: classic_authors (RLS, no policy, service_role SELECT
--           only), pd_works.classic_author_id (ON DELETE SET NULL), the
--           public_classic_authors view grants, function grants.
--   Part 2  staff_save_classic_author: who may call it, add, edit, the
--           checks (LB515), the 70-year rule (LB516), a missing id
--           (LB517), a taken slug (23505).
--   Part 3  staff_set_pd_work_classic_author: who, link, unlink, LB517.
--   Part 4  public_classic_authors: only authors with a live picked
--           edition (K6 Q3 a), pd_work_ids exactly those works; anon
--           reads it.
--
-- Reproduce against a disposable PostgreSQL 17 instance:
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/101_classic_authors.test.sql
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

-- As a signed-in reader (role authenticated, auth.uid() = p_uid).
create function pg_temp.run_as_user(p_uid text, p_sql text) returns text
  language plpgsql as $$
declare
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', p_uid, true);
  v_out := pg_temp.run_as('authenticated', p_sql);
  perform set_config('request.jwt.claim.sub', '', true);
  return v_out;
end;
$$;


-- The scalar a statement returns, as p_uid (authenticated); or
-- '<sqlstate>:<message>'.
create function pg_temp.val_as_user(p_uid text, p_sql text) returns text
  language plpgsql as $$
declare
  v_state text;
  v_msg text;
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', p_uid, true);
  execute 'set local role authenticated';
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

create function pg_temp.save_sql(p_id text, p_slug text, p_name text, p_birth integer, p_death integer,
                                 p_bplace text, p_dplace text, p_bio text) returns text
  language sql as $$
  select format('select public.staff_save_classic_author(%L, %L, %L, %L, %L, %L, %L, %L)::text',
                p_id, p_slug, p_name, p_birth, p_death, p_bplace, p_dplace, p_bio)
$$;

-- ============================================================
-- Fixture: author A; staff admin (books.review) and moderator (not);
-- reader R. Work W1 with live picked edition L1, work W2 with a draft
-- edition D2 (not picked, not live), work W3 with live picked L3.
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e1010000-0000-4000-8000-00000000000a', 'p101-a@test', now(), '{"role":"author","display_name":"P101 Ana"}'),
  ('e1010000-0000-4000-8000-0000000000d1', 'p101-r@test', now(), '{"role":"reader","display_name":"P101 R"}'),
  ('e1010000-0000-4000-8000-0000000000e1', 'p101-adm@test', now(), '{"role":"reader","display_name":"P101 Adm"}'),
  ('e1010000-0000-4000-8000-0000000000e2', 'p101-mod@test', now(), '{"role":"reader","display_name":"P101 Mod"}');

insert into public.staff_members (user_id, role) values
  ('e1010000-0000-4000-8000-0000000000e1', 'admin'),
  ('e1010000-0000-4000-8000-0000000000e2', 'moderator');

insert into public.pd_works (id, title, original_author) values
  ('e1010002-0000-4000-8000-0000000000b1', 'P101 W1', 'P101 Naim'),
  ('e1010002-0000-4000-8000-0000000000b2', 'P101 W2', 'P101 Naim'),
  ('e1010002-0000-4000-8000-0000000000b3', 'P101 W3', 'P101 Naim');

insert into public.books (id, author_id, title, description, price_all, status, published_at, file_path, cover_path, categories,
                          original_author, pd_work_id)
values
  ('e1010001-0000-4000-8000-0000000000a1', 'e1010000-0000-4000-8000-00000000000a', 'P101 L1', 'L1.', 0, 'published', now(),
   'a/l1/v1.epub', 'e101000c-0000-4000-8000-0000000000a1/cover.jpg', array['Poezi'], 'P101 Naim', 'e1010002-0000-4000-8000-0000000000b1'),
  ('e1010001-0000-4000-8000-0000000000a2', 'e1010000-0000-4000-8000-00000000000a', 'P101 D2', 'D2.', 0, 'draft', null,
   'a/d2/v1.epub', 'e101000c-0000-4000-8000-0000000000a2/cover.jpg', array['Poezi'], 'P101 Naim', 'e1010002-0000-4000-8000-0000000000b2'),
  ('e1010001-0000-4000-8000-0000000000a3', 'e1010000-0000-4000-8000-00000000000a', 'P101 L3', 'L3.', 0, 'published', now(),
   'a/l3/v1.epub', 'e101000c-0000-4000-8000-0000000000a3/cover.jpg', array['Poezi'], 'P101 Naim', 'e1010002-0000-4000-8000-0000000000b3');
update public.pd_works set picked_book_id = 'e1010001-0000-4000-8000-0000000000a1' where id = 'e1010002-0000-4000-8000-0000000000b1';
update public.pd_works set picked_book_id = 'e1010001-0000-4000-8000-0000000000a3' where id = 'e1010002-0000-4000-8000-0000000000b3';
select pg_temp.assert(
  (select count(*) from public.public_books where id in ('e1010001-0000-4000-8000-0000000000a1', 'e1010001-0000-4000-8000-0000000000a3')) = 2,
  'fixture: L1 and L3 are live');

-- ============================================================
-- Part 1: shape and grants
-- ============================================================
select pg_temp.assert(
  (select string_agg(a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text, ',' order by a.attnum)
     from pg_attribute a where a.attrelid = 'public.classic_authors'::regclass and a.attnum > 0 and not a.attisdropped)
  = 'id:uuid:true,slug:text:true,name:text:true,birth_year:integer:true,death_year:integer:true,birth_place:text:false,death_place:text:false,bio:text:true,created_at:timestamp with time zone:true,updated_at:timestamp with time zone:true',
  'part1: classic_authors columns');
select pg_temp.assert(
  (select c.relrowsecurity from pg_class c where c.oid = 'public.classic_authors'::regclass)
  and not exists (select 1 from pg_policy p where p.polrelid = 'public.classic_authors'::regclass),
  'part1: RLS on, no policy');
select pg_temp.assert(
  not exists (select 1 from information_schema.role_table_grants g
               where g.table_schema = 'public' and g.table_name = 'classic_authors'
                 and (g.grantee in ('PUBLIC', 'anon', 'authenticated')
                      or (g.grantee = 'service_role' and g.privilege_type <> 'SELECT')))
  and pg_temp.run_as('anon', $q$select 1 from public.classic_authors$q$) like '42501:%'
  and pg_temp.run_as('authenticated', $q$select 1 from public.classic_authors$q$) like '42501:%'
  and pg_temp.run_as('service_role', $q$select 1 from public.classic_authors$q$) like 'OK:%'
  and pg_temp.run_as('service_role', $q$insert into public.classic_authors (slug, name, birth_year, death_year, bio) values ('x', 'X', 1800, 1850, 'X')$q$) like '42501:%',
  'part1: service_role SELECT only');
select pg_temp.assert(
  (select c.confdeltype from pg_constraint c where c.conname = 'pd_works_classic_author_id_fkey') = 'n'
  and (select a.attnotnull from pg_attribute a where a.attrelid = 'public.pd_works'::regclass and a.attname = 'classic_author_id') = false
  and (select count(*) from public.pd_works where classic_author_id is not null) = 0,
  'part1: pd_works.classic_author_id nullable, ON DELETE SET NULL, empty');
select pg_temp.assert(
  (select string_agg(a.attname, ',' order by a.attnum) from pg_attribute a
    where a.attrelid = 'public.public_classic_authors'::regclass and a.attnum > 0 and not a.attisdropped)
  = 'id,slug,name,birth_year,death_year,birth_place,death_place,bio,pd_work_ids'
  and not exists (select 1 from information_schema.role_table_grants g
                   where g.table_schema = 'public' and g.table_name = 'public_classic_authors'
                     and (g.grantee = 'PUBLIC'
                          or (g.grantee in ('anon', 'authenticated', 'service_role') and g.privilege_type <> 'SELECT')))
  and pg_temp.run_as('anon', $q$select 1 from public.public_classic_authors$q$) like 'OK:%'
  and pg_temp.run_as('authenticated', $q$select 1 from public.public_classic_authors$q$) like 'OK:%',
  'part1: public_classic_authors columns; SELECT only, anon and authenticated');
select pg_temp.assert(
  not has_function_privilege('anon', 'public.staff_save_classic_author(uuid,text,text,integer,integer,text,text,text)', 'execute')
  and has_function_privilege('authenticated', 'public.staff_save_classic_author(uuid,text,text,integer,integer,text,text,text)', 'execute')
  and not has_function_privilege('anon', 'public.staff_set_pd_work_classic_author(uuid,uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.staff_set_pd_work_classic_author(uuid,uuid)', 'execute')
  and not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) x
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('staff_save_classic_author', 'staff_set_pd_work_classic_author')
       and (x.grantee = 0 or x.grantee = 'service_role'::regrole)),
  'part1: function grants (no PUBLIC, no service_role)');
select pg_temp.assert(
  (select pg_catalog.count(*) from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('staff_save_classic_author', 'staff_set_pd_work_classic_author')
      and p.prosecdef and p.proconfig = array['search_path=""']
      and pg_catalog.octet_length(p.prosrc) = pg_catalog.char_length(p.prosrc)
      and pg_catalog.strpos(p.prosrc, chr(92)) = 0) = 2,
  'part1: both SECURITY DEFINER, empty search_path, plain ASCII, no backslash');

-- ============================================================
-- Part 2: staff_save_classic_author
-- ============================================================
select pg_temp.assert(
  pg_temp.run_as('anon', pg_temp.save_sql(null, 'naim', 'Naim', 1846, 1900, null, null, 'Bio.')) like '42501:%',
  'part2: anon cannot call it');
select pg_temp.assert(
  pg_temp.run_as_user('e1010000-0000-4000-8000-0000000000d1', pg_temp.save_sql(null, 'naim', 'Naim', 1846, 1900, null, null, 'Bio.')) like '%not authorized',
  'part2: a reader is refused');
select pg_temp.assert(
  pg_temp.run_as_user('e1010000-0000-4000-8000-0000000000e2', pg_temp.save_sql(null, 'naim', 'Naim', 1846, 1900, null, null, 'Bio.')) like '%not authorized',
  'part2: a moderator (no books.review) is refused');
select pg_temp.assert(not exists (select 1 from public.classic_authors), 'part2: nothing saved by the refused calls');

create temp table p101_ids (k text primary key, v text);
grant select, insert on p101_ids to authenticated;
insert into p101_ids values ('naim',
  pg_temp.val_as_user('e1010000-0000-4000-8000-0000000000e1',
    pg_temp.save_sql(null, 'naim-frasheri', 'P101 Naim', 1846, 1900, 'Frashër', 'Stamboll', E'Poet.\nRilindas.')));
select pg_temp.assert(
  (select ca.id::text = (select v from p101_ids where k = 'naim') and ca.slug = 'naim-frasheri' and ca.birth_year = 1846
          and ca.death_year = 1900 and ca.birth_place = 'Frashër' and ca.death_place = 'Stamboll' and ca.bio = E'Poet.\nRilindas.'
     from public.classic_authors ca),
  'part2: an admin adds an author (a line feed in the bio is kept)');

insert into p101_ids values ('migjeni',
  pg_temp.val_as_user('e1010000-0000-4000-8000-0000000000e1',
    pg_temp.save_sql(null, 'migjeni', 'P101 Migjeni', 1911, 1938, null, null, 'Poet.')));
select pg_temp.assert((select count(*) from public.classic_authors) = 2, 'part2: a second author, no places');

select pg_temp.assert(
  pg_temp.val_as_user('e1010000-0000-4000-8000-0000000000e1',
    pg_temp.save_sql((select v from p101_ids where k = 'migjeni'), 'migjeni', 'P101 Migjeni', 1911, 1938, 'Shkodër', null, 'Poet i ri.'))
  = (select v from p101_ids where k = 'migjeni'),
  'part2: an admin edits an author');
select pg_temp.assert(
  (select birth_place = 'Shkodër' and bio = 'Poet i ri.' and updated_at >= created_at from public.classic_authors where slug = 'migjeni'),
  'part2: the edit is stored');

select pg_temp.assert(
  pg_temp.val_as_user('e1010000-0000-4000-8000-0000000000e1',
    pg_temp.save_sql(null, 'migjeni', 'P101 Other', 1900, 1940, null, null, 'X.')) like '23505:%',
  'part2: a taken slug is refused (23505)');
select pg_temp.assert(
  pg_temp.val_as_user('e1010000-0000-4000-8000-0000000000e1',
    pg_temp.save_sql('e1019999-0000-4000-8000-000000000000', 'nobody', 'Nobody', 1800, 1850, null, null, 'X.')) like 'LB517:%',
  'part2: editing a missing id is LB517');
select pg_temp.assert(
  pg_temp.val_as_user('e1010000-0000-4000-8000-0000000000e1',
    pg_temp.save_sql(null, 'recent', 'Recent', 1900, extract(year from now())::integer - 70, null, null, 'X.')) like 'LB516:%'
  and pg_temp.val_as_user('e1010000-0000-4000-8000-0000000000e1',
    pg_temp.save_sql(null, 'old-enough', 'Old enough', 1880, extract(year from now())::integer - 71, null, null, 'X.')) ~ '^[0-9a-f-]{36}$',
  'part2: the 70-year rule: died this year minus 70 is refused, minus 71 is allowed');

select pg_temp.assert(
  pg_temp.val_as_user('e1010000-0000-4000-8000-0000000000e1', pg_temp.save_sql(null, 'Bad Slug', 'X', 1800, 1850, null, null, 'X.')) like 'LB515:%'
  and pg_temp.val_as_user('e1010000-0000-4000-8000-0000000000e1', pg_temp.save_sql(null, '-x', 'X', 1800, 1850, null, null, 'X.')) like 'LB515:%'
  and pg_temp.val_as_user('e1010000-0000-4000-8000-0000000000e1', pg_temp.save_sql(null, 'x', ' X', 1800, 1850, null, null, 'X.')) like 'LB515:%'
  and pg_temp.val_as_user('e1010000-0000-4000-8000-0000000000e1', pg_temp.save_sql(null, 'x', 'X', 1860, 1850, null, null, 'X.')) like 'LB515:%'
  and pg_temp.val_as_user('e1010000-0000-4000-8000-0000000000e1', pg_temp.save_sql(null, 'x', 'X', 1800, 1850, '', null, 'X.')) like 'LB515:%'
  and pg_temp.val_as_user('e1010000-0000-4000-8000-0000000000e1', pg_temp.save_sql(null, 'x', 'X', 1800, 1850, null, null, '')) like 'LB515:%'
  and pg_temp.val_as_user('e1010000-0000-4000-8000-0000000000e1', pg_temp.save_sql(null, 'x', 'X', 1800, 1850, null, null, 'X' || chr(9) || 'Y')) like 'LB515:%'
  and pg_temp.val_as_user('e1010000-0000-4000-8000-0000000000e1', pg_temp.save_sql(null, 'x', 'X', 1800, 1850, null, null, repeat('a', 3001))) like 'LB515:%'
  and pg_temp.val_as_user('e1010000-0000-4000-8000-0000000000e1', pg_temp.save_sql(null, 'x', null, 1800, 1850, null, null, 'X.')) like 'LB515:%',
  'part2: bad slug, untrimmed name, birth after death, empty place, empty bio, a tab, too long, a missing field: LB515');
select pg_temp.assert((select count(*) from public.classic_authors) = 3, 'part2: no refused row was saved');

-- ============================================================
-- Part 3: staff_set_pd_work_classic_author
-- ============================================================
select pg_temp.assert(
  pg_temp.run_as_user('e1010000-0000-4000-8000-0000000000e2',
    format('select public.staff_set_pd_work_classic_author(%L, %L)', 'e1010002-0000-4000-8000-0000000000b1', (select v from p101_ids where k = 'naim'))) like '%not authorized'
  and pg_temp.run_as('anon',
    format('select public.staff_set_pd_work_classic_author(%L, %L)', 'e1010002-0000-4000-8000-0000000000b1', (select v from p101_ids where k = 'naim'))) like '42501:%',
  'part3: a moderator and anon are refused');
select pg_temp.assert(
  pg_temp.run_as_user('e1010000-0000-4000-8000-0000000000e1',
    format('select public.staff_set_pd_work_classic_author(%L, %L)', 'e1010002-0000-4000-8000-0000000000b1', (select v from p101_ids where k = 'naim'))) = 'OK:1'
  and pg_temp.run_as_user('e1010000-0000-4000-8000-0000000000e1',
    format('select public.staff_set_pd_work_classic_author(%L, %L)', 'e1010002-0000-4000-8000-0000000000b2', (select v from p101_ids where k = 'naim'))) = 'OK:1'
  and pg_temp.run_as_user('e1010000-0000-4000-8000-0000000000e1',
    format('select public.staff_set_pd_work_classic_author(%L, %L)', 'e1010002-0000-4000-8000-0000000000b3', (select v from p101_ids where k = 'migjeni'))) = 'OK:1',
  'part3: an admin links W1 and W2 to Naim, W3 to Migjeni');
select pg_temp.assert(
  (select count(*) from public.pd_works where classic_author_id = (select v from p101_ids where k = 'naim')::uuid) = 2,
  'part3: the links are stored');
select pg_temp.assert(
  pg_temp.run_as_user('e1010000-0000-4000-8000-0000000000e1',
    format('select public.staff_set_pd_work_classic_author(%L, %L)', 'e1019999-0000-4000-8000-000000000000', (select v from p101_ids where k = 'naim'))) like 'LB517:%'
  and pg_temp.run_as_user('e1010000-0000-4000-8000-0000000000e1',
    format('select public.staff_set_pd_work_classic_author(%L, %L)', 'e1010002-0000-4000-8000-0000000000b1', 'e1019999-0000-4000-8000-000000000000')) like 'LB517:%'
  and pg_temp.run_as_user('e1010000-0000-4000-8000-0000000000e1',
    'select public.staff_set_pd_work_classic_author(null, null)') like 'LB517:%',
  'part3: a missing work or author is LB517');

-- ============================================================
-- Part 4: public_classic_authors
-- ============================================================
select pg_temp.assert(
  (select string_agg(slug || '=' || array_to_string(pd_work_ids, '+'), ',' order by slug) from public.public_classic_authors)
  = 'migjeni=e1010002-0000-4000-8000-0000000000b3,naim-frasheri=e1010002-0000-4000-8000-0000000000b1',
  'part4: Naim shows W1 only (W2 has no live edition), Migjeni shows W3; old-enough (no work) is hidden');
select pg_temp.assert(
  pg_temp.val_as_user('e1010000-0000-4000-8000-0000000000d1', 'select count(*)::text from public.public_classic_authors') = '2',
  'part4: a reader sees the same two');
select pg_temp.assert(
  pg_temp.run_as('anon', $q$select 1 from public.public_classic_authors where slug = 'naim-frasheri'$q$) = 'OK:1',
  'part4: anon sees Naim');

update public.books set status = 'draft' where id = 'e1010001-0000-4000-8000-0000000000a3';
select pg_temp.assert(
  not exists (select 1 from public.public_classic_authors where slug = 'migjeni'),
  'part4: Migjeni is hidden once his only live edition goes offline');

select pg_temp.assert(
  pg_temp.run_as_user('e1010000-0000-4000-8000-0000000000e1',
    format('select public.staff_set_pd_work_classic_author(%L, null)', 'e1010002-0000-4000-8000-0000000000b1')) = 'OK:1',
  'part4: an admin unlinks W1');
select pg_temp.assert(not exists (select 1 from public.public_classic_authors), 'part4: unlinking W1 hides Naim too');

delete from public.classic_authors where slug = 'migjeni';
select pg_temp.assert(
  (select classic_author_id is null from public.pd_works where id = 'e1010002-0000-4000-8000-0000000000b3'),
  'part4: deleting an author unlinks its works (SET NULL)');

select pg_temp.assert((select n from pg_temp.assertions_run) >= 25, 'all assertions ran');
select 'PASS: 101_classic_authors (' || n || ' assertions)' from pg_temp.assertions_run;

rollback;
