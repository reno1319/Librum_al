-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for the blog categories change
-- (migration 20261117180000_blog_categories.sql).
--   Part 1  shape on the final schema: the CHECK holds exactly the six
--           new values; create_blog_post()/update_blog_post() accept
--           each of them and reject the four old ones; their grants are
--           unchanged.
--   Part 2  the row moves: the rollback file puts the database back on
--           the old four, old rows are added, the migration file runs,
--           and every row lands where it should (incl. the one post
--           placed by hand, by id), updated_at untouched.
--   Part 3  safety: with an authors-books post not listed in section 2b
--           the migration stops and changes NOTHING (old CHECK, old
--           functions and the row's category all still in place).
--   Part 4  the rollback file itself (lossy moves, old CHECK back).
--
-- Unlike most suites this one is NOT one rolled-back transaction: it
-- runs the real migration and rollback files (each its own
-- begin/commit) with \i. run-sql-tests.sh gives every suite its own
-- throwaway database, so nothing outlives the run. Run from the repo
-- root:
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/102_blog_categories.test.sql

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

-- Calls create_blog_post() as the given staff user; returns 'OK' or the error.
create function pg_temp.try_create(p_uid text, p_slug text, p_category text) returns text
  language plpgsql as $$
declare
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', p_uid, false);
  set role authenticated;
  begin
    perform public.create_blog_post('t', p_slug, 'e', 'b', null, p_category, false, null, null);
    v_out := 'OK';
  exception when others then
    v_out := sqlerrm;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', false);
  return v_out;
end;
$$;

create function pg_temp.try_update(p_uid text, p_id uuid, p_slug text, p_category text) returns text
  language plpgsql as $$
declare
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', p_uid, false);
  set role authenticated;
  begin
    perform public.update_blog_post(p_id, 't', p_slug, 'e', 'b', null, p_category, false, null, null);
    v_out := 'OK';
  exception when others then
    v_out := sqlerrm;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', false);
  return v_out;
end;
$$;

grant usage on schema extensions to anon, authenticated;

insert into auth.users (id, email, raw_user_meta_data) values
  ('e1020000-0000-4000-8000-000000000001', 'p102-editor@test', '{"role":"reader","display_name":"Editor"}');
insert into public.staff_members (user_id, role) values
  ('e1020000-0000-4000-8000-000000000001', 'editor');

-- Migrations 20261117230000 (Editorial tick, keywords, search) and
-- 20261119180000 (categories table) changed
-- this schema again: their rollback files, newest first, put the database back
-- on this migration's final state, so every part below still tests 102
-- itself. (104's own suite tests the later migration.)
-- Migration 20261122100000 (Written by name) came later still: its
-- rollback goes first.
\i supabase/tests/110_blog_author_name.rollback.sql
\i supabase/tests/107_blog_categories_manage.rollback.sql
\i supabase/tests/104_blog_editorial_keywords.rollback.sql

-- ============================================================
-- Part 1: final schema shape (as 102 left it).
-- ============================================================
do $$
declare
  v_def text := pg_temp.check_def();
  v_value text;
  v_id uuid;
begin
  foreach v_value in array array['editorial', 'zeja', 'tregu', 'kultura', 'reflektime', 'vleresime'] loop
    perform pg_temp.assert(v_def like '%''' || v_value || '''%', format('part1: CHECK must allow %s (got %s)', v_value, v_def));
    perform pg_temp.assert(
      pg_temp.try_create('e1020000-0000-4000-8000-000000000001', 'p102-new-' || v_value, v_value) = 'OK',
      format('part1: create_blog_post must accept %s', v_value)
    );
  end loop;

  foreach v_value in array array['publishing', 'writing', 'authors-books', 'librum-guides'] loop
    perform pg_temp.assert(v_def not like '%''' || v_value || '''%', format('part1: CHECK must not allow %s', v_value));
    perform pg_temp.assert(
      pg_temp.try_create('e1020000-0000-4000-8000-000000000001', 'p102-old-' || v_value, v_value) = 'invalid category',
      format('part1: create_blog_post must reject %s', v_value)
    );
  end loop;

  select id into v_id from public.blog_posts where slug = 'p102-new-zeja';
  perform pg_temp.assert(
    pg_temp.try_update('e1020000-0000-4000-8000-000000000001', v_id, 'p102-new-zeja', 'writing') = 'invalid category',
    'part1: update_blog_post must reject an old value'
  );
  perform pg_temp.assert(
    pg_temp.try_update('e1020000-0000-4000-8000-000000000001', v_id, 'p102-new-zeja', 'vleresime') = 'OK',
    'part1: update_blog_post must accept a new value'
  );
  perform pg_temp.assert(
    (select category from public.blog_posts where id = v_id) = 'vleresime',
    'part1: update_blog_post must save the new category'
  );

  -- Grants unchanged by CREATE OR REPLACE.
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.create_blog_post(text,text,text,text,text,text,boolean,text,text)', 'execute')
    and has_function_privilege('authenticated', 'public.update_blog_post(uuid,text,text,text,text,text,text,boolean,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.create_blog_post(text,text,text,text,text,text,boolean,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.update_blog_post(uuid,text,text,text,text,text,text,boolean,text,text)', 'execute'),
    'part1: function grants must be unchanged'
  );
end $$;

delete from public.blog_posts;

-- ============================================================
-- Part 2: the row moves, through the real files.
-- ============================================================
\i supabase/tests/102_blog_categories.rollback.sql

do $$
begin
  perform pg_temp.assert(pg_temp.check_def() like '%''librum-guides''%', 'part2: rollback must restore the old CHECK');
end $$;

insert into public.blog_posts (title, slug, excerpt, content_markdown, category, status, published_at, created_by, updated_at) values
  ('w', 'p102-writing', 'x', 'x', 'writing', 'published', '2026-01-01', 'e1020000-0000-4000-8000-000000000001', '2026-02-01'),
  ('p', 'p102-publishing', 'x', 'x', 'publishing', 'draft', null, 'e1020000-0000-4000-8000-000000000001', '2026-02-01'),
  ('g', 'p102-guides', 'x', 'x', 'librum-guides', 'published', '2026-01-02', 'e1020000-0000-4000-8000-000000000001', '2026-02-01');
-- The one post placed by hand (section 2a0), and a look-alike that must
-- NOT move to editorial (same title idea, other id and slug).
insert into public.blog_posts (id, title, slug, excerpt, content_markdown, category, created_by, updated_at) values
  ('9a3e08e1-4f7a-4340-946c-6963f687c9b9', 'Pse ekziston Librum?', 'pse-ekziston-librum', 'x', 'x', 'publishing', 'e1020000-0000-4000-8000-000000000001', '2026-02-01'),
  ('9a3e08e1-0000-4000-8000-000000000000', 'Pse ekziston Librum?', 'pse-ekziston-librum-2', 'x', 'x', 'publishing', 'e1020000-0000-4000-8000-000000000001', '2026-02-01');

\i supabase/migrations/20261117180000_blog_categories.sql

do $$
begin
  perform pg_temp.assert((select category from public.blog_posts where slug = 'p102-writing') = 'zeja', 'part2: writing -> zeja');
  perform pg_temp.assert((select category from public.blog_posts where slug = 'p102-publishing') = 'tregu', 'part2: publishing -> tregu');
  perform pg_temp.assert((select category from public.blog_posts where slug = 'p102-guides') = 'tregu', 'part2: librum-guides -> tregu');
  perform pg_temp.assert((select category from public.blog_posts where slug = 'pse-ekziston-librum') = 'editorial', 'part2: Pse ekziston Librum? -> editorial');
  perform pg_temp.assert((select category from public.blog_posts where slug = 'pse-ekziston-librum-2') = 'tregu', 'part2: only that one id moves to editorial');
  perform pg_temp.assert(
    (select pg_catalog.count(*) from public.blog_posts where updated_at <> '2026-02-01'::timestamptz) = 0,
    'part2: updated_at must be left alone'
  );
  perform pg_temp.assert(
    (select pg_catalog.count(*) from public.blog_posts where status = 'published') = 2,
    'part2: status must be left alone'
  );
  perform pg_temp.assert(pg_temp.check_def() like '%''vleresime''%', 'part2: new CHECK in place');
  perform pg_temp.assert(
    pg_temp.try_create('e1020000-0000-4000-8000-000000000001', 'p102-after', 'editorial') = 'OK',
    'part2: create_blog_post accepts editorial after the migration'
  );
end $$;

-- ============================================================
-- Part 3: an unplaced authors-books post stops the migration with
-- nothing changed.
-- ============================================================
\i supabase/tests/102_blog_categories.rollback.sql

insert into public.blog_posts (title, slug, excerpt, content_markdown, category, created_by) values
  ('a', 'p102-authors', 'x', 'x', 'authors-books', 'e1020000-0000-4000-8000-000000000001'),
  ('w', 'p102-writing-2', 'x', 'x', 'writing', 'e1020000-0000-4000-8000-000000000001');

\set ON_ERROR_STOP 0
\i supabase/migrations/20261117180000_blog_categories.sql
\set ON_ERROR_STOP 1

do $$
begin
  perform pg_temp.assert((select category from public.blog_posts where slug = 'p102-authors') = 'authors-books', 'part3: the unplaced row must be untouched');
  perform pg_temp.assert((select category from public.blog_posts where slug = 'p102-writing-2') = 'writing', 'part3: the fixed moves must be undone too');
  perform pg_temp.assert(pg_temp.check_def() like '%''librum-guides''%', 'part3: the old CHECK must still be in place');
  perform pg_temp.assert(pg_temp.check_def() not like '%''zeja''%', 'part3: the new CHECK must not be in place');
  perform pg_temp.assert(
    pg_temp.try_create('e1020000-0000-4000-8000-000000000001', 'p102-old-fn', 'writing') = 'OK',
    'part3: the old create_blog_post must still be in place'
  );
end $$;

-- ============================================================
-- Part 4: the rollback's own moves (lossy), and running it twice.
-- ============================================================
delete from public.blog_posts;
\i supabase/migrations/20261117180000_blog_categories.sql

insert into public.blog_posts (title, slug, excerpt, content_markdown, category, created_by) values
  ('1', 'p102-rb-editorial', 'x', 'x', 'editorial', 'e1020000-0000-4000-8000-000000000001'),
  ('2', 'p102-rb-zeja', 'x', 'x', 'zeja', 'e1020000-0000-4000-8000-000000000001'),
  ('3', 'p102-rb-tregu', 'x', 'x', 'tregu', 'e1020000-0000-4000-8000-000000000001'),
  ('4', 'p102-rb-kultura', 'x', 'x', 'kultura', 'e1020000-0000-4000-8000-000000000001'),
  ('5', 'p102-rb-reflektime', 'x', 'x', 'reflektime', 'e1020000-0000-4000-8000-000000000001'),
  ('6', 'p102-rb-vleresime', 'x', 'x', 'vleresime', 'e1020000-0000-4000-8000-000000000001');

\i supabase/tests/102_blog_categories.rollback.sql
\i supabase/tests/102_blog_categories.rollback.sql

do $$
begin
  perform pg_temp.assert((select category from public.blog_posts where slug = 'p102-rb-zeja') = 'writing', 'part4: zeja -> writing');
  perform pg_temp.assert((select category from public.blog_posts where slug = 'p102-rb-tregu') = 'publishing', 'part4: tregu -> publishing');
  perform pg_temp.assert(
    (select pg_catalog.count(*) from public.blog_posts where category = 'authors-books') = 4,
    'part4: editorial, kultura, reflektime, vleresime -> authors-books'
  );
  perform pg_temp.assert(
    pg_temp.try_create('e1020000-0000-4000-8000-000000000001', 'p102-rb-new', 'zeja') = 'invalid category',
    'part4: the old create_blog_post is back'
  );
end $$;

select 'PASS: 102_blog_categories' as result;
