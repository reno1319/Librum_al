-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for the blog "Written by" name
-- (supabase/migrations/20261122100000_blog_author_name.sql):
--
--   Part 1  shape: blog_posts.author_name (nullable, named CHECK), the
--           12/13-parameter functions only, their grants.
--   Part 2  the CHECK on direct values.
--   Part 3  create_blog_post(): trimmed, empty = none, too long or a
--           control character refused, the old 11-argument call still
--           works (no name).
--   Part 4  update_blog_post(): NULL (or the old call) keeps the name,
--           '' removes it, a new one replaces it; same refusals.
--   Part 5  who reads it: anon sees it on a published post only.
--   Part 6  the real files: rollback (lossy) twice, the migration again.
--
-- Unlike most suites this one is NOT one rolled-back transaction: Part
-- 6 runs the real migration and rollback files (each its own
-- begin/commit) with \i. run-sql-tests.sh gives every suite its own
-- throwaway database. Run from the repo root:
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/110_blog_author_name.test.sql
--
-- Against the BASE schema it fails in the set-up (no column): the negative
-- control.

set client_min_messages = warning;

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

-- Runs one statement as the given role (and user id); 'OK' or the error.
create function pg_temp.run_as(p_role text, p_uid text, p_sql text) returns text
  language plpgsql as $$
declare
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), false);
  execute format('set role %I', p_role);
  begin
    execute p_sql;
    v_out := 'OK';
  exception when others then
    v_out := sqlerrm;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', false);
  return v_out;
end;
$$;

-- 'ok' when this author_name value is accepted directly on the probe
-- post, 'refused' on a CHECK violation. Each try is undone.
create function pg_temp.try_value(p_value text) returns text
  language plpgsql as $$
begin
  update public.blog_posts set author_name = p_value where slug = 'p110-probe';
  raise exception using errcode = 'P0001', message = 'probe ok';
exception
  when check_violation then return 'refused';
  when raise_exception then
    if sqlerrm = 'probe ok' then return 'ok'; end if;
    raise;
end;
$$;

-- What the given role reads as author_name for a slug ('-' = no row).
create function pg_temp.read_as(p_role text, p_slug text) returns text
  language plpgsql as $$
declare
  v_out text;
begin
  execute format('set role %I', p_role);
  select coalesce(author_name, '(null)') into v_out from public.blog_posts where slug = p_slug;
  reset role;
  return coalesce(v_out, '-');
end;
$$;

create function pg_temp.name_of(p_slug text) returns text
  language sql as $$
  select coalesce(author_name, '(null)') from public.blog_posts where slug = p_slug;
$$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('e1100000-0000-4000-8000-000000000001', 'p110-editor@test', '{"role":"reader","display_name":"Editor"}'),
  ('e1100000-0000-4000-8000-000000000002', 'p110-reader@test', '{"role":"reader","display_name":"Reader"}');
insert into public.staff_members (user_id, role) values
  ('e1100000-0000-4000-8000-000000000001', 'editor');

\set EDITOR '''e1100000-0000-4000-8000-000000000001'''
\set READER '''e1100000-0000-4000-8000-000000000002'''

insert into public.blog_posts (title, slug, excerpt, content_markdown, category, created_by) values
  ('Probe', 'p110-probe', 'x', 'x', 'zeja', 'e1100000-0000-4000-8000-000000000001');

-- ============================================================
-- Part 1: shape.
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    (select format_type(atttypid, atttypmod) = 'text' and not attnotnull
       from pg_attribute
      where attrelid = 'public.blog_posts'::regclass and attname = 'author_name' and not attisdropped),
    'part1: blog_posts.author_name is a nullable text column');
  perform pg_temp.assert(
    exists (select 1 from pg_constraint
             where conrelid = 'public.blog_posts'::regclass and conname = 'blog_posts_author_name_check'),
    'part1: the named CHECK exists');
  perform pg_temp.assert(
    (select count(*) from pg_proc where proname = 'create_blog_post' and pronamespace = 'public'::regnamespace) = 1
    and (select count(*) from pg_proc where proname = 'update_blog_post' and pronamespace = 'public'::regnamespace) = 1,
    'part1: exactly one create_blog_post and one update_blog_post');
  perform pg_temp.assert(
    to_regprocedure('public.create_blog_post(text,text,text,text,text,text,boolean,text,text,boolean,text[],text)') is not null
    and to_regprocedure('public.update_blog_post(uuid,text,text,text,text,text,text,boolean,text,text,boolean,text[],text)') is not null,
    'part1: both functions take p_author_name last');
  perform pg_temp.assert(
    (select bool_and(prosecdef and proconfig = array['search_path=""'])
       from pg_proc where proname in ('create_blog_post', 'update_blog_post') and pronamespace = 'public'::regnamespace),
    'part1: both stay SECURITY DEFINER with an empty search_path');
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.create_blog_post(text,text,text,text,text,text,boolean,text,text,boolean,text[],text)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.create_blog_post(text,text,text,text,text,text,boolean,text,text,boolean,text[],text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.create_blog_post(text,text,text,text,text,text,boolean,text,text,boolean,text[],text)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.update_blog_post(uuid,text,text,text,text,text,text,boolean,text,text,boolean,text[],text)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.update_blog_post(uuid,text,text,text,text,text,text,boolean,text,text,boolean,text[],text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.update_blog_post(uuid,text,text,text,text,text,text,boolean,text,text,boolean,text[],text)', 'EXECUTE'),
    'part1: EXECUTE for authenticated + service_role, never anon');
  perform pg_temp.assert(
    has_column_privilege('anon', 'public.blog_posts', 'author_name', 'SELECT')
    and has_column_privilege('authenticated', 'public.blog_posts', 'author_name', 'SELECT')
    and not has_column_privilege('authenticated', 'public.blog_posts', 'author_name', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.blog_posts', 'author_name', 'INSERT'),
    'part1: anon/authenticated may read the column, never write it');
end $$;

-- ============================================================
-- Part 2: the CHECK.
-- ============================================================
do $$
begin
  perform pg_temp.assert(pg_temp.try_value(null) = 'ok', 'part2: null accepted');
  perform pg_temp.assert(pg_temp.try_value('Arben Hoxha') = 'ok', 'part2: a plain name accepted');
  perform pg_temp.assert(pg_temp.try_value('Ëndërr Çela') = 'ok', 'part2: Albanian letters accepted');
  perform pg_temp.assert(pg_temp.try_value(repeat('a', 80)) = 'ok', 'part2: 80 characters accepted');
  perform pg_temp.assert(pg_temp.try_value(repeat('ë', 80)) = 'ok', 'part2: 80 characters counted, not bytes');
  perform pg_temp.assert(pg_temp.try_value(repeat('a', 81)) = 'refused', 'part2: 81 characters refused');
  perform pg_temp.assert(pg_temp.try_value('') = 'refused', 'part2: empty refused (null means none)');
  perform pg_temp.assert(pg_temp.try_value(' Arben') = 'refused', 'part2: leading space refused');
  perform pg_temp.assert(pg_temp.try_value('Arben ') = 'refused', 'part2: trailing space refused');
  perform pg_temp.assert(pg_temp.try_value('Arben' || chr(10) || 'Hoxha') = 'refused', 'part2: newline refused');
  perform pg_temp.assert(pg_temp.try_value('Arben' || chr(9) || 'Hoxha') = 'refused', 'part2: tab refused');
end $$;

-- ============================================================
-- Part 3: create_blog_post().
-- ============================================================
select pg_temp.assert(
  pg_temp.run_as('authenticated', :EDITOR,
    $q$select public.create_blog_post('A', 'p110-a', 'e', 'body', null, 'zeja', false, null, null, false, '{}', '  Arben Hoxha  ')$q$) = 'OK',
  'part3: editor creates with a name');
select pg_temp.assert(pg_temp.name_of('p110-a') = 'Arben Hoxha', 'part3: the name is trimmed');

select pg_temp.assert(
  pg_temp.run_as('authenticated', :EDITOR,
    $q$select public.create_blog_post('B', 'p110-b', 'e', 'body', null, 'zeja', false, null, null, false, '{}', '   ')$q$) = 'OK',
  'part3: only spaces is accepted');
select pg_temp.assert(pg_temp.name_of('p110-b') = '(null)', 'part3: only spaces = no name');

select pg_temp.assert(
  pg_temp.run_as('authenticated', :EDITOR,
    $q$select public.create_blog_post('C', 'p110-c', 'e', 'body', null, 'zeja', false, null, null, false, '{}')$q$) = 'OK',
  'part3: the old 11-argument call still works');
select pg_temp.assert(pg_temp.name_of('p110-c') = '(null)', 'part3: the old call saves no name');

select pg_temp.assert(
  pg_temp.run_as('authenticated', :EDITOR,
    $q$select public.create_blog_post('D', 'p110-d', 'e', 'body', null, 'zeja', false, null, null)$q$) = 'OK',
  'part3: the older 9-argument call still works');

select pg_temp.assert(
  pg_temp.run_as('authenticated', :EDITOR,
    format($q$select public.create_blog_post('E', 'p110-e', 'e', 'body', null, 'zeja', false, null, null, false, '{}', %L)$q$, repeat('a', 81)))
    = 'author_name must be 80 characters or fewer, with no control characters',
  'part3: 81 characters refused with the function''s message');
select pg_temp.assert(
  pg_temp.run_as('authenticated', :EDITOR,
    format($q$select public.create_blog_post('E', 'p110-e', 'e', 'body', null, 'zeja', false, null, null, false, '{}', %L)$q$, 'A' || chr(10) || 'B'))
    = 'author_name must be 80 characters or fewer, with no control characters',
  'part3: a newline refused');
select pg_temp.assert(
  pg_temp.run_as('authenticated', :READER,
    $q$select public.create_blog_post('E', 'p110-e', 'e', 'body', null, 'zeja', false, null, null, false, '{}', 'X')$q$) = 'not authorized',
  'part3: a reader cannot create');
select pg_temp.assert(not exists (select 1 from public.blog_posts where slug = 'p110-e'), 'part3: nothing saved by refused calls');

-- ============================================================
-- Part 4: update_blog_post().
-- ============================================================
\set UPD 'select public.update_blog_post((select id from public.blog_posts where slug = ''p110-a''), ''A'', ''p110-a'', ''e'', ''body'', null, ''zeja'', false, null, null'

select pg_temp.assert(pg_temp.run_as('authenticated', :EDITOR, :'UPD' || ', null, null, null)') = 'OK', 'part4: update with NULL');
select pg_temp.assert(pg_temp.name_of('p110-a') = 'Arben Hoxha', 'part4: NULL keeps the name');

select pg_temp.assert(pg_temp.run_as('authenticated', :EDITOR, :'UPD' || ', null, null)') = 'OK', 'part4: the old 12-argument call');
select pg_temp.assert(pg_temp.name_of('p110-a') = 'Arben Hoxha', 'part4: the old call keeps the name');

select pg_temp.assert(pg_temp.run_as('authenticated', :EDITOR, :'UPD' || ')') = 'OK', 'part4: the older 10-argument call (before keywords)');
select pg_temp.assert(pg_temp.name_of('p110-a') = 'Arben Hoxha', 'part4: the older call keeps the name');

select pg_temp.assert(pg_temp.run_as('authenticated', :EDITOR, :'UPD' || ', null, null, '' Drita Gjoni '')') = 'OK', 'part4: a new name');
select pg_temp.assert(pg_temp.name_of('p110-a') = 'Drita Gjoni', 'part4: the new name replaces the old, trimmed');

select pg_temp.assert(
  pg_temp.run_as('authenticated', :EDITOR, :'UPD' || ', null, null, ' || quote_literal(repeat('a', 81)) || ')')
    = 'author_name must be 80 characters or fewer, with no control characters',
  'part4: 81 characters refused');
select pg_temp.assert(pg_temp.name_of('p110-a') = 'Drita Gjoni', 'part4: a refused update changes nothing');

select pg_temp.assert(pg_temp.run_as('authenticated', :EDITOR, :'UPD' || ', null, null, '''')') = 'OK', 'part4: empty');
select pg_temp.assert(pg_temp.name_of('p110-a') = '(null)', 'part4: empty removes the name');

select pg_temp.assert(pg_temp.run_as('authenticated', :READER, :'UPD' || ', null, null, ''X'')') = 'not authorized', 'part4: a reader cannot update');

-- ============================================================
-- Part 5: who reads it.
-- ============================================================
update public.blog_posts set author_name = 'Arben Hoxha' where slug in ('p110-a', 'p110-c');
update public.blog_posts set status = 'published', published_at = now() - interval '1 day', keywords = array['k'] where slug = 'p110-a';

select pg_temp.assert(pg_temp.read_as('anon', 'p110-a') = 'Arben Hoxha', 'part5: anon reads the name on a published post');
select pg_temp.assert(pg_temp.read_as('anon', 'p110-c') = '-', 'part5: anon never sees a draft');

-- ============================================================
-- Part 6: the real files.
-- ============================================================
\i supabase/tests/110_blog_author_name.rollback.sql
\i supabase/tests/110_blog_author_name.rollback.sql

do $$
begin
  perform pg_temp.assert(
    not exists (select 1 from pg_attribute where attrelid = 'public.blog_posts'::regclass and attname = 'author_name' and not attisdropped),
    'part6: rollback drops the column');
  perform pg_temp.assert(
    to_regprocedure('public.create_blog_post(text,text,text,text,text,text,boolean,text,text,boolean,text[])') is not null
    and to_regprocedure('public.update_blog_post(uuid,text,text,text,text,text,text,boolean,text,text,boolean,text[])') is not null
    and (select count(*) from pg_proc where proname in ('create_blog_post', 'update_blog_post') and pronamespace = 'public'::regnamespace) = 2,
    'part6: rollback restores the 11/12-parameter functions only');
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.create_blog_post(text,text,text,text,text,text,boolean,text,text,boolean,text[])', 'EXECUTE')
    and has_function_privilege('service_role', 'public.update_blog_post(uuid,text,text,text,text,text,text,boolean,text,text,boolean,text[])', 'EXECUTE')
    and not has_function_privilege('anon', 'public.create_blog_post(text,text,text,text,text,text,boolean,text,text,boolean,text[])', 'EXECUTE')
    and not has_function_privilege('anon', 'public.update_blog_post(uuid,text,text,text,text,text,text,boolean,text,text,boolean,text[])', 'EXECUTE'),
    'part6: rollback restores the old grants');
  perform pg_temp.assert((select count(*) from public.blog_posts where slug like 'p110-%') = 5, 'part6: rollback keeps every post');
end $$;

select pg_temp.assert(
  pg_temp.run_as('authenticated', :EDITOR,
    $q$select public.create_blog_post('F', 'p110-f', 'e', 'body', null, 'zeja', false, null, null, false, '{}')$q$) = 'OK',
  'part6: after rollback the old app call works');

\i supabase/migrations/20261122100000_blog_author_name.sql

do $$
begin
  perform pg_temp.assert(
    (select count(*) from public.blog_posts where slug like 'p110-%' and author_name is null) = 6,
    'part6: the migration on existing posts sets no name');
  perform pg_temp.assert(
    (select count(*) from pg_proc where proname in ('create_blog_post', 'update_blog_post') and pronamespace = 'public'::regnamespace) = 2
    and to_regprocedure('public.create_blog_post(text,text,text,text,text,text,boolean,text,text,boolean,text[],text)') is not null,
    'part6: the migration again leaves one function each');
  perform pg_temp.assert(has_column_privilege('anon', 'public.blog_posts', 'author_name', 'SELECT'), 'part6: column grant back');
end $$;

select 'ALL PASS' as result;
