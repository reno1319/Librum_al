-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for the blog Editorial tick, hidden
-- keywords and blog search (migration
-- 20261117230000_blog_editorial_keywords.sql).
--   Part 1  shape on the final schema: the two columns and their
--           defaults, the five-value CHECK, the keyword-count CHECK,
--           the public column grant, the function signatures, rights
--           and grants.
--   Part 2  the save/publish rules: Editorial is a tick, not a
--           category; keyword limits; publish needs a keyword; a live
--           post keeps at least one; NULL on update keeps the row's own
--           tick and keywords.
--   Part 3  search_blog_posts(): published only (also for staff),
--           title/excerpt/keywords but never the body, accents,
--           capitals and hyphens ignored, every word must match,
--           wildcards are literal, newest first, limit clamped, anon
--           can call it.
--   Part 4  the row move through the real files: the rollback file, old
--           rows, the migration: "Pse ekziston Librum?" (by id) ->
--           tregu + tick, updated_at untouched.
--   Part 5  safety: another 'editorial' row stops the migration with
--           NOTHING changed.
--   Part 6  the rollback file itself (lossy) and running it twice.
--
-- Not one rolled-back transaction: it runs the real migration and
-- rollback files (each its own begin/commit) with \i. run-sql-tests.sh
-- gives every suite its own throwaway database. Run from the repo root:
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/104_blog_editorial_keywords.test.sql

set client_min_messages = warning;

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

create function pg_temp.check_def() returns text
  language sql as $$
  select pg_catalog.pg_get_constraintdef(c.oid)
  from pg_catalog.pg_constraint c
  where c.conrelid = 'public.blog_posts'::regclass and c.conname = 'blog_posts_category_check';
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

-- search_blog_posts() as the given role: the matching slugs, in order.
create function pg_temp.search(p_role text, p_term text, p_limit integer default 30) returns text
  language plpgsql as $$
declare
  v_out text;
begin
  execute format('set role %I', p_role);
  select coalesce(string_agg(b.slug, ',' order by s.ord), '-') into v_out
  from public.search_blog_posts(p_term, p_limit) with ordinality as s(post_id, ord)
  join public.blog_posts b on b.id = s.post_id;
  reset role;
  return v_out;
end;
$$;

grant usage on schema extensions to anon, authenticated;

insert into auth.users (id, email, raw_user_meta_data) values
  ('e1040000-0000-4000-8000-000000000001', 'p104-editor@test', '{"role":"reader","display_name":"Editor"}');
insert into public.staff_members (user_id, role) values
  ('e1040000-0000-4000-8000-000000000001', 'editor');

-- Migration 20261119180000 (categories table) replaced this
-- migration's CHECK with a foreign key: its rollback file first puts the
-- five-value CHECK back, so every part below still tests 104 itself.
-- (107's own suite tests the later migration.)
\i supabase/tests/107_blog_categories_manage.rollback.sql

-- ============================================================
-- Part 1: final schema shape.
-- ============================================================
do $$
declare
  v_def text := pg_temp.check_def();
  v_value text;
begin
  foreach v_value in array array['zeja', 'tregu', 'kultura', 'reflektime', 'vleresime'] loop
    perform pg_temp.assert(v_def like '%''' || v_value || '''%', format('part1: CHECK must allow %s (got %s)', v_value, v_def));
  end loop;
  perform pg_temp.assert(v_def not like '%''editorial''%', 'part1: CHECK must not allow editorial');

  perform pg_temp.assert(
    (select format_type(atttypid, atttypmod) || '|' || attnotnull || '|' || pg_get_expr(d.adbin, d.adrelid)
       from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = 'public.blog_posts'::regclass and a.attname = 'is_editorial') = 'boolean|true|false',
    'part1: is_editorial boolean not null default false');
  perform pg_temp.assert(
    (select format_type(atttypid, atttypmod) || '|' || attnotnull || '|' || pg_get_expr(d.adbin, d.adrelid)
       from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = 'public.blog_posts'::regclass and a.attname = 'keywords') = 'text[]|true|''{}''::text[]',
    'part1: keywords text[] not null default {}');
  perform pg_temp.assert(
    exists (select 1 from pg_constraint where conrelid = 'public.blog_posts'::regclass
             and conname = 'blog_posts_keywords_count_check'),
    'part1: keyword count CHECK exists');

  perform pg_temp.assert(
    has_column_privilege('anon', 'public.blog_posts', 'is_editorial', 'SELECT')
    and has_column_privilege('anon', 'public.blog_posts', 'keywords', 'SELECT')
    and has_column_privilege('authenticated', 'public.blog_posts', 'keywords', 'SELECT')
    and not has_column_privilege('anon', 'public.blog_posts', 'keywords', 'UPDATE')
    and not has_column_privilege('anon', 'public.blog_posts', 'created_by', 'SELECT'),
    'part1: the two new columns are publicly readable, nothing else changed');

  -- Old signatures gone, new ones definer + empty search_path, staff only.
  perform pg_temp.assert(to_regprocedure('public.create_blog_post(text,text,text,text,text,text,boolean,text,text)') is null
    and to_regprocedure('public.update_blog_post(uuid,text,text,text,text,text,text,boolean,text,text)') is null,
    'part1: the old 9/10-argument functions are gone');
  perform pg_temp.assert(
    (select bool_and(p.prosecdef and p.proconfig = array['search_path=""'])
       from pg_proc p
      where p.oid in ('public.create_blog_post(text,text,text,text,text,text,boolean,text,text,boolean,text[])'::regprocedure,
                      'public.update_blog_post(uuid,text,text,text,text,text,text,boolean,text,text,boolean,text[])'::regprocedure,
                      'public.publish_blog_post(uuid)'::regprocedure)),
    'part1: save/publish functions are SECURITY DEFINER with an empty search_path');
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.create_blog_post(text,text,text,text,text,text,boolean,text,text,boolean,text[])', 'execute')
    and has_function_privilege('authenticated', 'public.update_blog_post(uuid,text,text,text,text,text,text,boolean,text,text,boolean,text[])', 'execute')
    and has_function_privilege('service_role', 'public.create_blog_post(text,text,text,text,text,text,boolean,text,text,boolean,text[])', 'execute')
    and has_function_privilege('service_role', 'public.update_blog_post(uuid,text,text,text,text,text,text,boolean,text,text,boolean,text[])', 'execute')
    and not has_function_privilege('anon', 'public.create_blog_post(text,text,text,text,text,text,boolean,text,text,boolean,text[])', 'execute')
    and not has_function_privilege('anon', 'public.update_blog_post(uuid,text,text,text,text,text,text,boolean,text,text,boolean,text[])', 'execute')
    and has_function_privilege('authenticated', 'public.publish_blog_post(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.publish_blog_post(uuid)', 'execute'),
    'part1: save/publish grants: authenticated + service_role, never anon');

  perform pg_temp.assert(
    (select not p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""']
       from pg_proc p where p.oid = 'public.search_blog_posts(text,integer)'::regprocedure),
    'part1: search_blog_posts is SECURITY INVOKER, STABLE, empty search_path');
  perform pg_temp.assert(
    has_function_privilege('anon', 'public.search_blog_posts(text,integer)', 'execute')
    and has_function_privilege('authenticated', 'public.search_blog_posts(text,integer)', 'execute')
    and has_function_privilege('service_role', 'public.search_blog_posts(text,integer)', 'execute')
    and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                     where p.oid = 'public.search_blog_posts(text,integer)'::regprocedure and a.grantee = 0),
    'part1: search_blog_posts EXECUTE to anon/authenticated/service_role, not PUBLIC');
end $$;

-- ============================================================
-- Part 2: save and publish rules.
-- ============================================================
do $$
declare
  ed constant text := 'e1040000-0000-4000-8000-000000000001';
  v_id uuid;
  v_draft uuid;
  v_row record;
begin
  -- Editorial is not a category any more.
  perform pg_temp.assert(pg_temp.run_as('authenticated', ed,
    $q$select public.create_blog_post('t', 'p104-ed-cat', 'e', 'b', null, 'editorial', false, null, null, false, array['k'])$q$)
    = 'invalid category', 'part2: create rejects category editorial');

  -- An old 9-argument call still works (defaults: no tick, no keywords).
  perform pg_temp.assert(pg_temp.run_as('authenticated', ed,
    $q$select public.create_blog_post('t', 'p104-old-call', 'e', 'b', null, 'zeja', false, null, null)$q$) = 'OK',
    'part2: a 9-argument call still resolves');
  select is_editorial, keywords into v_row from public.blog_posts where slug = 'p104-old-call';
  perform pg_temp.assert(v_row.is_editorial = false and v_row.keywords = '{}', 'part2: defaults false / {}');

  -- Tick + keywords saved as given.
  perform pg_temp.assert(pg_temp.run_as('authenticated', ed,
    $q$select public.create_blog_post('t', 'p104-ed', 'e', 'b', null, 'tregu', false, null, null, true, array['vetë-botim', 'e-libër'])$q$) = 'OK',
    'part2: create with tick + keywords');
  select id, category, is_editorial, keywords into v_row from public.blog_posts where slug = 'p104-ed';
  v_id := v_row.id;
  perform pg_temp.assert(v_row.category = 'tregu' and v_row.is_editorial and v_row.keywords = array['vetë-botim', 'e-libër'],
    'part2: category tregu + tick + keywords stored');

  -- Keyword limits (create and update).
  perform pg_temp.assert(pg_temp.run_as('authenticated', ed,
    $q$select public.create_blog_post('t', 'p104-k11', 'e', 'b', null, 'zeja', false, null, null, false,
       array['1','2','3','4','5','6','7','8','9','10','11'])$q$) = 'too many keywords', 'part2: 11 keywords rejected');
  perform pg_temp.assert(pg_temp.run_as('authenticated', ed,
    $q$select public.create_blog_post('t', 'p104-k10', 'e', 'b', null, 'zeja', false, null, null, false,
       array['1','2','3','4','5','6','7','8','9','10'])$q$) = 'OK', 'part2: 10 keywords accepted');
  perform pg_temp.assert(pg_temp.run_as('authenticated', ed,
    $q$select public.create_blog_post('t', 'p104-k41', 'e', 'b', null, 'zeja', false, null, null, false,
       array[repeat('a', 41)])$q$) = 'each keyword must be between 1 and 40 characters', 'part2: 41 characters rejected');
  perform pg_temp.assert(pg_temp.run_as('authenticated', ed,
    $q$select public.create_blog_post('t', 'p104-k40', 'e', 'b', null, 'zeja', false, null, null, false,
       array[repeat('a', 40)])$q$) = 'OK', 'part2: 40 characters accepted');
  perform pg_temp.assert(pg_temp.run_as('authenticated', ed,
    $q$select public.create_blog_post('t', 'p104-kblank', 'e', 'b', null, 'zeja', false, null, null, false,
       array['  '])$q$) = 'each keyword must be between 1 and 40 characters', 'part2: blank keyword rejected');
  perform pg_temp.assert(pg_temp.run_as('authenticated', ed,
    $q$select public.create_blog_post('t', 'p104-knull', 'e', 'b', null, 'zeja', false, null, null, false,
       array[null::text])$q$) = 'each keyword must be between 1 and 40 characters', 'part2: NULL keyword rejected');
  perform pg_temp.assert(pg_temp.run_as('authenticated', ed, format(
    $q$select public.update_blog_post(%L, 't', 'p104-ed', 'e', 'b', null, 'tregu', false, null, null, true,
       array['1','2','3','4','5','6','7','8','9','10','11'])$q$, v_id)) = 'too many keywords', 'part2: update rejects 11 keywords');
  -- The table CHECK holds even past the functions.
  begin
    update public.blog_posts set keywords = array['1','2','3','4','5','6','7','8','9','10','11'] where id = v_id;
    perform pg_temp.assert(false, 'part2: table CHECK must reject 11 keywords');
  exception when check_violation then null;
  end;

  -- Publish needs a keyword.
  select id into v_draft from public.blog_posts where slug = 'p104-old-call';
  perform pg_temp.assert(pg_temp.run_as('authenticated', ed, format($q$select public.publish_blog_post(%L)$q$, v_draft))
    = 'a published article needs at least one keyword', 'part2: publish without keywords rejected');
  perform pg_temp.assert((select status from public.blog_posts where id = v_draft) = 'draft', 'part2: still a draft');
  perform pg_temp.assert(pg_temp.run_as('authenticated', ed, format($q$select public.publish_blog_post(%L)$q$, v_id)) = 'OK',
    'part2: publish with keywords');
  perform pg_temp.assert((select status from public.blog_posts where id = v_id) = 'published', 'part2: published');
  perform pg_temp.assert(pg_temp.run_as('authenticated', ed, format($q$select public.publish_blog_post(%L)$q$, v_id))
    = 'no publishable draft found for this id', 'part2: publishing twice keeps its old message');

  -- A live post keeps at least one keyword; NULL keeps the row's own.
  perform pg_temp.assert(pg_temp.run_as('authenticated', ed, format(
    $q$select public.update_blog_post(%L, 't2', 'p104-ed', 'e', 'b', null, 'tregu', false, null, null, true, '{}'::text[])$q$, v_id))
    = 'a published article needs at least one keyword', 'part2: live post cannot drop to no keywords');
  perform pg_temp.assert(pg_temp.run_as('authenticated', ed, format(
    $q$select public.update_blog_post(%L, 't3', 'p104-ed', 'e', 'b', null, 'kultura', false, null, null)$q$, v_id)) = 'OK',
    'part2: a 10-argument update still resolves');
  select title, category, is_editorial, keywords into v_row from public.blog_posts where id = v_id;
  perform pg_temp.assert(v_row.title = 't3' and v_row.category = 'kultura' and v_row.is_editorial
    and v_row.keywords = array['vetë-botim', 'e-libër'], 'part2: NULL tick/keywords keep the row''s own');
  perform pg_temp.assert(pg_temp.run_as('authenticated', ed, format(
    $q$select public.update_blog_post(%L, 't4', 'p104-ed', 'e', 'b', null, 'tregu', false, null, null, false, array['nje'])$q$, v_id)) = 'OK',
    'part2: update can untick and replace keywords');
  select is_editorial, keywords into v_row from public.blog_posts where id = v_id;
  perform pg_temp.assert(not v_row.is_editorial and v_row.keywords = array['nje'], 'part2: untick + new keywords saved');
  perform pg_temp.assert(pg_temp.run_as('authenticated', ed, format(
    $q$select public.update_blog_post(%L, 't', 'p104-old-call', 'e', 'b', null, 'zeja', false, null, null, false, '{}'::text[])$q$, v_draft)) = 'OK',
    'part2: a draft may be saved with no keywords');
  perform pg_temp.assert(pg_temp.run_as('authenticated', ed, format(
    $q$select public.update_blog_post(%L, 't', 'p104-old-call', 'e', 'b', null, 'editorial', false, null, null)$q$, v_draft))
    = 'invalid category', 'part2: update rejects category editorial');

  -- Non-staff cannot save.
  perform pg_temp.assert(pg_temp.run_as('authenticated', 'e1040000-0000-4000-8000-0000000000ff',
    $q$select public.create_blog_post('t', 'p104-nostaff', 'e', 'b', null, 'zeja', false, null, null, false, array['k'])$q$)
    = 'not authorized', 'part2: non-staff create refused');
end $$;

delete from public.blog_posts;

-- ============================================================
-- Part 3: search_blog_posts().
-- ============================================================
insert into public.blog_posts (title, slug, excerpt, content_markdown, category, status, published_at, created_by, keywords, is_editorial) values
  ('Si ta çmoni librin tuaj', 's-cmim', 'Çmimi i e-librit.', 'body', 'tregu', 'published', '2026-03-01',
     'e1040000-0000-4000-8000-000000000001', array['vetë-botim'], false),
  ('Pse ekziston Librum', 's-pse', 'Zëri ynë.', 'body', 'tregu', 'published', '2026-03-03',
     'e1040000-0000-4000-8000-000000000001', array['vetë-botim', 'mision'], true),
  ('Dialogu i vërtetë', 's-dialog', 'Pesë rregulla.', 'sekreti-i-trupit vetebotim', 'zeja', 'published', '2026-03-02',
     'e1040000-0000-4000-8000-000000000001', array['shkrim'], false),
  ('Draft vetë-botim', 's-draft', 'Draft.', 'body', 'tregu', 'draft', null,
     'e1040000-0000-4000-8000-000000000001', array['vetë-botim'], false),
  ('100% e saktë', 's-percent', 'Me_nënvizë.', 'body', 'kultura', 'published', '2026-03-04',
     'e1040000-0000-4000-8000-000000000001', array['x'], false);

do $$
begin
  perform pg_temp.assert(pg_temp.search('anon', 'vetebotim') = 's-pse,s-cmim', 'part3: accent + hyphen folded, newest first, published only, never the body (got ' || pg_temp.search('anon', 'vetebotim') || ')');
  perform pg_temp.assert(pg_temp.search('anon', 'VETË-BOTIM') = 's-pse,s-cmim', 'part3: capitals ignored, hyphen in the word too');
  perform pg_temp.assert(pg_temp.search('anon', 'cmim') = 's-cmim', 'part3: ç = c in title/excerpt');
  perform pg_temp.assert(pg_temp.search('anon', 'vetebotim mision') = 's-pse', 'part3: every word must match');
  perform pg_temp.assert(pg_temp.search('anon', '   vetebotim    mision  ') = 's-pse', 'part3: extra spaces ignored');
  perform pg_temp.assert(pg_temp.search('anon', 'sekreti') = '-', 'part3: body text is not searched');
  perform pg_temp.assert(pg_temp.search('anon', 'zeri') = 's-pse', 'part3: excerpt searched, ë = e');
  perform pg_temp.assert(pg_temp.search('anon', '') = '-' and pg_temp.search('anon', null) = '-' and pg_temp.search('anon', '   ') = '-'
    and pg_temp.search('anon', '-') = '-', 'part3: no words, no rows');
  perform pg_temp.assert(pg_temp.search('anon', '%') = 's-percent', 'part3: % is literal (got ' || pg_temp.search('anon', '%') || ')');
  perform pg_temp.assert(pg_temp.search('anon', '_') = 's-percent', 'part3: _ is literal');
  perform pg_temp.assert(pg_temp.search('anon', 'draft') = '-', 'part3: drafts never found by anon');
  perform pg_temp.assert(pg_temp.search('authenticated', 'draft') = '-', 'part3: drafts never found by a reader');
  perform set_config('request.jwt.claim.sub', 'e1040000-0000-4000-8000-000000000001', false);
  perform pg_temp.assert(pg_temp.search('authenticated', 'draft') = '-', 'part3: drafts never found by staff either');
  perform set_config('request.jwt.claim.sub', '', false);
  perform pg_temp.assert(pg_temp.search('anon', 'vetebotim', 1) = 's-pse', 'part3: limit honoured');
  perform pg_temp.assert(pg_temp.search('anon', 'vetebotim', 0) = 's-pse', 'part3: limit clamped up to 1');
  perform pg_temp.assert(pg_temp.search('anon', 'e', 1000) <> '-', 'part3: a large limit still works (clamped to 50)');
  perform pg_temp.assert(pg_temp.search('anon', 'vetebotim mision ek ek zeri zzzz') = 's-pse', 'part3: only the first 5 words count');
  -- audit L1: only the first 200 characters of the term are read.
  perform pg_temp.assert(pg_temp.search('anon', 'vetebotim' || repeat(' ', 200) || 'zzzz') = 's-pse,s-cmim',
    'part3: text after 200 characters is ignored');
  perform pg_temp.assert(pg_temp.search('anon', 'vetebotim' || repeat(' ', 180) || 'zzzz') = '-',
    'part3: text inside 200 characters still counts');
  perform pg_temp.assert(pg_temp.search('anon', repeat('a', 4000000)) = '-', 'part3: a huge term is cut, not scanned whole');
end $$;

delete from public.blog_posts;

-- ============================================================
-- Part 4: the row move, through the real files.
-- ============================================================
\i supabase/tests/104_blog_editorial_keywords.rollback.sql

do $$
begin
  perform pg_temp.assert(pg_temp.check_def() like '%''editorial''%', 'part4: rollback must restore the six-value CHECK');
  perform pg_temp.assert(not exists (select 1 from pg_attribute where attrelid = 'public.blog_posts'::regclass
    and attname in ('is_editorial', 'keywords') and not attisdropped), 'part4: rollback drops the two columns');
  perform pg_temp.assert(to_regprocedure('public.search_blog_posts(text,integer)') is null, 'part4: rollback drops search');
end $$;

insert into public.blog_posts (id, title, slug, excerpt, content_markdown, category, status, published_at, created_by, updated_at) values
  ('9a3e08e1-4f7a-4340-946c-6963f687c9b9', 'Pse ekziston Librum?', 'pse-ekziston-librum', 'x', 'x', 'editorial', 'published', '2026-01-01',
     'e1040000-0000-4000-8000-000000000001', '2026-02-01'),
  ('9a3e08e1-0000-4000-8000-000000000001', 'Tregu', 'p104-tregu', 'x', 'x', 'tregu', 'published', '2026-01-02',
     'e1040000-0000-4000-8000-000000000001', '2026-02-01'),
  ('9a3e08e1-0000-4000-8000-000000000002', 'Zeja', 'p104-zeja', 'x', 'x', 'zeja', 'draft', null,
     'e1040000-0000-4000-8000-000000000001', '2026-02-01');

\i supabase/migrations/20261117230000_blog_editorial_keywords.sql

do $$
begin
  perform pg_temp.assert((select category || '|' || is_editorial from public.blog_posts where slug = 'pse-ekziston-librum') = 'tregu|true',
    'part4: Pse ekziston Librum? -> tregu + tick');
  perform pg_temp.assert((select category || '|' || is_editorial from public.blog_posts where slug = 'p104-tregu') = 'tregu|false',
    'part4: other rows keep their category, no tick');
  perform pg_temp.assert((select category || '|' || is_editorial from public.blog_posts where slug = 'p104-zeja') = 'zeja|false',
    'part4: other rows keep their category, no tick (2)');
  perform pg_temp.assert((select pg_catalog.count(*) from public.blog_posts where keywords <> '{}') = 0, 'part4: existing rows get no keywords');
  perform pg_temp.assert(
    (select pg_catalog.count(*) from public.blog_posts where updated_at <> '2026-02-01'::timestamptz) = 0,
    'part4: updated_at must be left alone');
  perform pg_temp.assert(
    (select pg_catalog.count(*) from public.blog_posts where status = 'published') = 2,
    'part4: status must be left alone (live posts with no keywords stay live)');
  perform pg_temp.assert(pg_temp.check_def() not like '%''editorial''%', 'part4: five-value CHECK in place');
end $$;

-- ============================================================
-- Part 5: an unplaced 'editorial' row stops the migration with nothing
-- changed.
-- ============================================================
\i supabase/tests/104_blog_editorial_keywords.rollback.sql

insert into public.blog_posts (title, slug, excerpt, content_markdown, category, created_by) values
  ('a', 'p104-other-editorial', 'x', 'x', 'editorial', 'e1040000-0000-4000-8000-000000000001');

\set ON_ERROR_STOP 0
\i supabase/migrations/20261117230000_blog_editorial_keywords.sql
\set ON_ERROR_STOP 1

do $$
begin
  perform pg_temp.assert((select category from public.blog_posts where slug = 'p104-other-editorial') = 'editorial', 'part5: the unplaced row is untouched');
  perform pg_temp.assert((select category from public.blog_posts where slug = 'pse-ekziston-librum') = 'editorial', 'part5: the listed row move is undone too');
  perform pg_temp.assert(pg_temp.check_def() like '%''editorial''%', 'part5: the six-value CHECK is still in place');
  perform pg_temp.assert(not exists (select 1 from pg_attribute where attrelid = 'public.blog_posts'::regclass
    and attname = 'keywords' and not attisdropped), 'part5: no keywords column');
  perform pg_temp.assert(to_regprocedure('public.create_blog_post(text,text,text,text,text,text,boolean,text,text)') is not null
    and to_regprocedure('public.search_blog_posts(text,integer)') is null, 'part5: old functions still in place, no search');
end $$;

-- ============================================================
-- Part 6: the rollback's own move (lossy), and running it twice.
-- ============================================================
delete from public.blog_posts where slug = 'p104-other-editorial';
\i supabase/migrations/20261117230000_blog_editorial_keywords.sql

insert into public.blog_posts (title, slug, excerpt, content_markdown, category, is_editorial, keywords, created_by) values
  ('1', 'p104-rb-ticked', 'x', 'x', 'kultura', true, array['k'], 'e1040000-0000-4000-8000-000000000001'),
  ('2', 'p104-rb-plain', 'x', 'x', 'kultura', false, array['k'], 'e1040000-0000-4000-8000-000000000001');

\i supabase/tests/104_blog_editorial_keywords.rollback.sql
\i supabase/tests/104_blog_editorial_keywords.rollback.sql

do $$
begin
  perform pg_temp.assert((select category from public.blog_posts where slug = 'p104-rb-ticked') = 'editorial', 'part6: ticked -> editorial');
  perform pg_temp.assert((select category from public.blog_posts where slug = 'p104-rb-plain') = 'kultura', 'part6: unticked keeps its category');
  perform pg_temp.assert((select category from public.blog_posts where slug = 'pse-ekziston-librum') = 'editorial', 'part6: Pse ekziston back to editorial');
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.create_blog_post(text,text,text,text,text,text,boolean,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.create_blog_post(text,text,text,text,text,text,boolean,text,text)', 'execute')
    and has_function_privilege('service_role', 'public.update_blog_post(uuid,text,text,text,text,text,text,boolean,text,text)', 'execute'),
    'part6: 102 function grants restored');
end $$;

-- And forward again, ending on the final schema (the lossy ticked row
-- would now stop it: section 2a lists only one post).
delete from public.blog_posts where slug = 'p104-rb-ticked';
\i supabase/migrations/20261117230000_blog_editorial_keywords.sql

do $$
begin
  perform pg_temp.assert((select category || '|' || is_editorial from public.blog_posts where slug = 'pse-ekziston-librum') = 'tregu|true',
    'part6: forward again works');
  raise warning '104_blog_editorial_keywords: all parts passed';
end $$;
