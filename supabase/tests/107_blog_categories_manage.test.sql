-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for categories staff manage
-- (migration 20261119180000_blog_categories_manage.sql).
--   Part 1  shape: the six rows, table grants and RLS, the CHECK and
--           foreign key, function grants, who holds blog.categories.
--   Part 2  create: who may, every input rule, goes last, audit row,
--           a new category can hold articles; Editorial never can.
--   Part 3  update: texts, colour and button; Editorial keeps gold.
--   Part 4  move: one place, ends do nothing, Editorial never moves.
--   Part 5  delete: Editorial never; articles (drafts too) must move
--           somewhere real; the order closes up; readers see the result.
--   Part 6  no direct writes; the foreign key backs the functions up.
--   Part 7  the real files: rollback (lossy), the migration on old
--           data, both run twice.
--
-- Unlike most suites this one is NOT one rolled-back transaction: Part
-- 7 runs the real migration and rollback files (each its own
-- begin/commit) with \i. run-sql-tests.sh gives every suite its own
-- throwaway database. Run from the repo root:
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/107_blog_categories_manage.test.sql

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

-- The category order as value list (Editorial included).
create function pg_temp.cat_order() returns text
  language sql as $$
  select string_agg(value || ':' || sort_order, ',' order by sort_order, value) from public.blog_categories;
$$;

-- What the given role reads from the table.
create function pg_temp.read_as(p_role text) returns text
  language plpgsql as $$
declare
  v_out text;
begin
  execute format('set role %I', p_role);
  select coalesce(string_agg(value, ',' order by sort_order, value), '-') into v_out from public.blog_categories;
  reset role;
  return v_out;
end;
$$;

grant usage on schema extensions to anon, authenticated;

insert into auth.users (id, email, raw_user_meta_data) values
  ('e1070000-0000-4000-8000-000000000001', 'p107-owner@test', '{"role":"reader","display_name":"Owner"}'),
  ('e1070000-0000-4000-8000-000000000002', 'p107-admin@test', '{"role":"reader","display_name":"Admin"}'),
  ('e1070000-0000-4000-8000-000000000003', 'p107-editor@test', '{"role":"reader","display_name":"Editor"}'),
  ('e1070000-0000-4000-8000-000000000004', 'p107-reader@test', '{"role":"reader","display_name":"Reader"}');
insert into public.staff_members (user_id, role) values
  ('e1070000-0000-4000-8000-000000000001', 'owner'),
  ('e1070000-0000-4000-8000-000000000002', 'admin'),
  ('e1070000-0000-4000-8000-000000000003', 'editor');

\set OWNER '''e1070000-0000-4000-8000-000000000001'''
\set ADMIN '''e1070000-0000-4000-8000-000000000002'''
\set EDITOR '''e1070000-0000-4000-8000-000000000003'''
\set READER '''e1070000-0000-4000-8000-000000000004'''

-- ============================================================
-- Part 1: shape.
-- ============================================================
do $$
declare
  v_fn text;
begin
  perform pg_temp.assert(
    pg_temp.cat_order() = 'editorial:0,zeja:1,tregu:2,kultura:3,reflektime:4,vleresime:5',
    'part1: the six rows in order, got ' || pg_temp.cat_order());
  perform pg_temp.assert(
    (select string_agg(value || '/' || url_slug || '/' || colour || '/' || cta || '/' || short_label, ' ' order by sort_order)
       from public.blog_categories)
    = 'editorial/editorial/gold/browse/Editorial zeja/zeja-e-shkrimit/green/publish/Zeja e Shkrimit '
      || 'tregu/tregu-i-librit-dhe-botimet/blue/publish/Botimet kultura/kulture-dhe-njohuri/terracotta/browse/Kulturë '
      || 'reflektime/reflektime-dhe-frymezim/purple/browse/Reflektime vleresime/vleresimet-dhe-rekomandimet/olive/browse/Vlerësime',
    'part1: addresses, colours, buttons and short names match the old fixed list');
  perform pg_temp.assert(
    (select label from public.blog_categories where value = 'tregu') = 'Tregu i Librit & Botimet',
    'part1: full names kept');

  perform pg_temp.assert((select relrowsecurity from pg_class where oid = 'public.blog_categories'::regclass), 'part1: RLS on');
  perform pg_temp.assert(has_table_privilege('anon', 'public.blog_categories', 'SELECT'), 'part1: anon reads');
  perform pg_temp.assert(has_table_privilege('authenticated', 'public.blog_categories', 'SELECT'), 'part1: authenticated reads');
  perform pg_temp.assert(not has_table_privilege('anon', 'public.blog_categories', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'), 'part1: anon writes nothing');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.blog_categories', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'), 'part1: authenticated writes nothing');
  perform pg_temp.assert(not has_table_privilege('service_role', 'public.blog_categories', 'SELECT, INSERT, UPDATE, DELETE'), 'part1: service_role has nothing');
  perform pg_temp.assert(pg_temp.read_as('anon') = 'editorial,zeja,tregu,kultura,reflektime,vleresime', 'part1: anon sees all six');

  perform pg_temp.assert(
    (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.blog_posts'::regclass and conname = 'blog_posts_category_check')
      = 'CHECK ((category <> ''editorial''::text))',
    'part1: the posts CHECK only keeps Editorial out');
  perform pg_temp.assert(
    (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.blog_posts'::regclass and conname = 'blog_posts_category_fkey')
      = 'FOREIGN KEY (category) REFERENCES blog_categories(value)',
    'part1: the foreign key, no cascade');

  foreach v_fn in array array[
    'public.create_blog_category(text,text,text,text,text,text)',
    'public.update_blog_category(text,text,text,text,text,text)',
    'public.move_blog_category(text,text)',
    'public.delete_blog_category(text,text)'] loop
    perform pg_temp.assert(has_function_privilege('authenticated', v_fn, 'execute'), 'part1: authenticated may call ' || v_fn);
    perform pg_temp.assert(not has_function_privilege('anon', v_fn, 'execute'), 'part1: anon may not call ' || v_fn);
    perform pg_temp.assert(not has_function_privilege('service_role', v_fn, 'execute'), 'part1: service_role may not call ' || v_fn);
    perform pg_temp.assert(
      (select prosecdef and proconfig = array['search_path=""'] from pg_proc where oid = v_fn::regprocedure),
      'part1: security definer with empty search_path: ' || v_fn);
  end loop;
end $$;

-- Who holds blog.categories.
select pg_temp.assert(pg_temp.run_as('authenticated', :OWNER,
  $q$do $x$ begin if not public.staff_has_permission('blog.categories') then raise exception 'no'; end if; end $x$ $q$) = 'OK', 'part1: owner holds it');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$do $x$ begin if not public.staff_has_permission('blog.categories') then raise exception 'no'; end if; end $x$ $q$) = 'OK', 'part1: admin holds it');
select pg_temp.assert(pg_temp.run_as('authenticated', :EDITOR,
  $q$do $x$ begin if public.staff_has_permission('blog.categories') then raise exception 'yes'; end if;
     if not public.staff_has_permission('blog.manage') then raise exception 'lost blog.manage'; end if; end $x$ $q$) = 'OK',
  'part1: editor does not hold it (b5 a) and keeps blog.manage');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$do $x$ begin if not (public.staff_has_permission('books.review') and public.staff_has_permission('people.manage')
     and public.staff_has_permission('finance.payout_operate')) then raise exception 'lost'; end if; end $x$ $q$) = 'OK',
  'part1: admin keeps its other permissions');

-- ============================================================
-- Part 2: create.
-- ============================================================
select pg_temp.assert(pg_temp.run_as('authenticated', :EDITOR,
  $q$select public.create_blog_category('Përkthime', 'Përkthime', 'Si përkthehet.', 'perkthime', 'teal', 'publish')$q$) = 'not authorized', 'part2: editor refused');
select pg_temp.assert(pg_temp.run_as('authenticated', :READER,
  $q$select public.create_blog_category('Përkthime', 'Përkthime', 'Si përkthehet.', 'perkthime', 'teal', 'publish')$q$) = 'not authorized', 'part2: reader refused');
select pg_temp.assert(pg_temp.run_as('authenticated', null,
  $q$select public.create_blog_category('Përkthime', 'Përkthime', 'Si përkthehet.', 'perkthime', 'teal', 'publish')$q$) = 'not authenticated', 'part2: no user refused');
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$select public.create_blog_category('Përkthime', 'Përkthime', 'Si përkthehet.', 'perkthime', 'teal', 'publish')$q$) like 'permission denied%', 'part2: anon cannot call it');

select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.create_blog_category('X', 'X', 'D', 'ok-slug', 'gold', 'publish')$q$) = 'invalid colour', 'part2: gold is Editorial''s only');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.create_blog_category('X', 'X', 'D', 'ok-slug', 'pink', 'publish')$q$) = 'invalid colour', 'part2: unknown colour');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.create_blog_category('X', 'X', 'D', 'ok-slug', 'teal', 'shop')$q$) = 'invalid bottom button', 'part2: unknown button');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.create_blog_category('X', 'X', 'D', 'Përkthime', 'teal', 'browse')$q$) = 'invalid category address', 'part2: address must be a-z0-9 and dashes');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.create_blog_category('X', 'X', 'D', 'a--b', 'teal', 'browse')$q$) = 'invalid category address', 'part2: no double dash');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.create_blog_category('X', 'X', 'D', repeat('a', 61), 'teal', 'browse')$q$) = 'invalid category address', 'part2: address at most 60');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.create_blog_category('   ', 'X', 'D', 'ok-slug', 'teal', 'browse')$q$) = 'category name must be between 1 and 60 characters', 'part2: blank name');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.create_blog_category('X', repeat('s', 25), 'D', 'ok-slug', 'teal', 'browse')$q$) = 'short name must be between 1 and 24 characters', 'part2: short name at most 24');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.create_blog_category('X', 'X', repeat('d', 201), 'ok-slug', 'teal', 'browse')$q$) = 'description must be between 1 and 200 characters', 'part2: description at most 200');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.create_blog_category('X', 'X', 'D', 'zeja-e-shkrimit', 'teal', 'browse')$q$) = 'category address already used', 'part2: an address in use');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.create_blog_category('X', 'X', 'D', 'zeja', 'teal', 'browse')$q$) = 'category address already used', 'part2: an existing stored value');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.create_blog_category('X', 'X', 'D', 'editorial', 'teal', 'browse')$q$) = 'category address already used', 'part2: editorial');
select pg_temp.assert((select count(*) from public.blog_categories) = 6, 'part2: nothing created by the refusals');

select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.create_blog_category('  Përkthime  ', ' Përkthime ', ' Si përkthehet një libër. ', 'perkthime', 'teal', 'publish')$q$) = 'OK', 'part2: admin creates');
select pg_temp.assert(pg_temp.run_as('authenticated', :OWNER,
  $q$select public.create_blog_category('Poezi', 'Poezi', 'Poezi shqip.', 'poezi', 'rose', 'browse')$q$) = 'OK', 'part2: owner creates');
select pg_temp.assert(
  (select label || '|' || short_label || '|' || description || '|' || url_slug || '|' || colour || '|' || cta
     from public.blog_categories where value = 'perkthime') = 'Përkthime|Përkthime|Si përkthehet një libër.|perkthime|teal|publish',
  'part2: saved trimmed, value = address');
select pg_temp.assert(pg_temp.cat_order() like '%vleresime:5,perkthime:6,poezi:7', 'part2: new ones go last, got ' || pg_temp.cat_order());
select pg_temp.assert(
  (select count(*) from public.admin_audit_log where action = 'blog_category.created'
     and metadata->>'value' in ('perkthime', 'poezi') and target_type = 'blog_categories') = 2, 'part2: audit rows');

-- A new category holds articles; Editorial and unknown values never.
select pg_temp.assert(pg_temp.run_as('authenticated', :EDITOR,
  $q$select public.create_blog_post('t', 'p107-a', 'e', 'b', null, 'perkthime', false, null, null)$q$) = 'OK', 'part2: editor files an article in the new category');
select pg_temp.assert(pg_temp.run_as('authenticated', :EDITOR,
  $q$select public.create_blog_post('t', 'p107-b', 'e', 'b', null, 'editorial', false, null, null)$q$) = 'invalid category', 'part2: never in Editorial');
select pg_temp.assert(pg_temp.run_as('authenticated', :EDITOR,
  $q$select public.create_blog_post('t', 'p107-c', 'e', 'b', null, 'nope', false, null, null)$q$) = 'invalid category', 'part2: unknown category');
select pg_temp.assert(pg_temp.run_as('authenticated', :EDITOR,
  $q$select public.update_blog_post((select id from public.blog_posts where slug = 'p107-a'), 't', 'p107-a', 'e', 'b', null, 'poezi', false, null, null)$q$) = 'OK',
  'part2: update moves it to another new category');
select pg_temp.assert(pg_temp.run_as('authenticated', :EDITOR,
  $q$select public.update_blog_post((select id from public.blog_posts where slug = 'p107-a'), 't', 'p107-a', 'e', 'b', null, 'editorial', false, null, null)$q$) = 'invalid category',
  'part2: update refuses Editorial');

-- The hidden cap of 50 (b6 b).
do $$
declare i integer;
begin
  for i in 1..42 loop
    insert into public.blog_categories (value, label, short_label, url_slug, description, colour, cta, sort_order)
    values ('cap-' || i, 'Cap ' || i, 'Cap', 'cap-' || i, 'D', 'slate', 'browse', 100 + i);
  end loop;
  perform pg_temp.assert((select count(*) from public.blog_categories) = 50, 'part2: 50 rows now');
end $$;
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.create_blog_category('One more', 'One', 'D', 'one-more', 'teal', 'browse')$q$) = 'too many categories', 'part2: the 51st is refused');
delete from public.blog_categories where value like 'cap-%';

-- ============================================================
-- Part 3: update.
-- ============================================================
select pg_temp.assert(pg_temp.run_as('authenticated', :EDITOR,
  $q$select public.update_blog_category('kultura', 'Histori', 'Histori', 'D', 'green', 'publish')$q$) = 'not authorized', 'part3: editor refused');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.update_blog_category('nope', 'Histori', 'Histori', 'D', 'green', 'publish')$q$) = 'no such category', 'part3: unknown');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.update_blog_category('kultura', 'Histori', 'Histori', 'D', 'gold', 'publish')$q$) = 'invalid colour', 'part3: gold refused');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.update_blog_category('kultura', ' Histori ', 'Histori', 'Histori e letërsisë.', 'green', 'publish')$q$) = 'OK', 'part3: admin updates');
select pg_temp.assert(
  (select label || '|' || description || '|' || colour || '|' || cta || '|' || url_slug from public.blog_categories where value = 'kultura')
    = 'Histori|Histori e letërsisë.|green|publish|kulture-dhe-njohuri',
  'part3: texts, colour and button change; the address does not (b4 a)');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.update_blog_category('editorial', 'Nga Redaksia', 'Redaksia', 'Zëri i redaksisë.', 'teal', 'publish')$q$) = 'OK', 'part3: Editorial renamed');
select pg_temp.assert(
  (select label || '|' || short_label || '|' || description || '|' || colour || '|' || cta || '|' || sort_order from public.blog_categories where value = 'editorial')
    = 'Nga Redaksia|Redaksia|Zëri i redaksisë.|gold|browse|0',
  'part3: Editorial keeps gold, its button and first place (b2 b)');
select pg_temp.assert(
  (select count(*) from public.admin_audit_log where action = 'blog_category.updated') = 2, 'part3: audit rows');

-- ============================================================
-- Part 4: move.
-- ============================================================
select pg_temp.assert(pg_temp.run_as('authenticated', :EDITOR,
  $q$select public.move_blog_category('poezi', 'up')$q$) = 'not authorized', 'part4: editor refused');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.move_blog_category('editorial', 'down')$q$) = 'editorial always comes first', 'part4: Editorial never moves');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.move_blog_category('poezi', 'left')$q$) = 'invalid direction', 'part4: direction');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.move_blog_category('nope', 'up')$q$) = 'no such category', 'part4: unknown');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.move_blog_category('poezi', 'up')$q$) = 'OK', 'part4: up');
select pg_temp.assert(pg_temp.cat_order() = 'editorial:0,zeja:1,tregu:2,kultura:3,reflektime:4,vleresime:5,poezi:6,perkthime:7',
  'part4: swapped with the one above, got ' || pg_temp.cat_order());
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.move_blog_category('zeja', 'up')$q$) = 'OK', 'part4: top going up is fine');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.move_blog_category('perkthime', 'down')$q$) = 'OK', 'part4: bottom going down is fine');
select pg_temp.assert(pg_temp.cat_order() = 'editorial:0,zeja:1,tregu:2,kultura:3,reflektime:4,vleresime:5,poezi:6,perkthime:7',
  'part4: ends change nothing');
select pg_temp.assert((select count(*) from public.admin_audit_log where action = 'blog_category.moved') = 1, 'part4: one audit row (ends write none)');
-- Gaps and ties close up on the next move.
update public.blog_categories set sort_order = 40 where value = 'tregu';
update public.blog_categories set sort_order = 40 where value = 'kultura';
select pg_temp.assert(pg_temp.run_as('authenticated', :OWNER,
  $q$select public.move_blog_category('zeja', 'down')$q$) = 'OK', 'part4: down');
select pg_temp.assert(pg_temp.cat_order() = 'editorial:0,reflektime:1,zeja:2,vleresime:3,poezi:4,perkthime:5,kultura:6,tregu:7',
  'part4: renumbered 1..n with ties broken by value, got ' || pg_temp.cat_order());

-- ============================================================
-- Part 5: delete.
-- ============================================================
insert into public.blog_posts (title, slug, excerpt, content_markdown, category, status, published_at, keywords, created_by) values
  ('d', 'p107-draft', 'x', 'x', 'perkthime', 'draft', null, '{}', 'e1070000-0000-4000-8000-000000000003'),
  ('s', 'p107-sched', 'x', 'x', 'perkthime', 'published', now() + interval '2 days', '{k}', 'e1070000-0000-4000-8000-000000000003'),
  ('l', 'p107-live', 'x', 'x', 'perkthime', 'published', now() - interval '2 days', '{k}', 'e1070000-0000-4000-8000-000000000003');

select pg_temp.assert(pg_temp.run_as('authenticated', :EDITOR,
  $q$select public.delete_blog_category('perkthime', 'zeja')$q$) = 'not authorized', 'part5: editor refused');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.delete_blog_category('editorial', 'zeja')$q$) = 'editorial cannot be deleted', 'part5: Editorial never');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.delete_blog_category('nope', 'zeja')$q$) = 'no such category', 'part5: unknown');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.delete_blog_category('perkthime', null)$q$) = 'choose where its articles move', 'part5: no target');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.delete_blog_category('perkthime', 'perkthime')$q$) = 'choose where its articles move', 'part5: not itself');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.delete_blog_category('perkthime', 'editorial')$q$) = 'choose where its articles move', 'part5: not Editorial');
select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$select public.delete_blog_category('perkthime', 'nope')$q$) = 'choose where its articles move', 'part5: not unknown');
select pg_temp.assert((select count(*) from public.blog_posts where category = 'perkthime') = 3, 'part5: refusals moved nothing');

select pg_temp.assert(pg_temp.run_as('authenticated', :ADMIN,
  $q$do $x$ begin if public.delete_blog_category('perkthime', 'kultura') <> 3 then raise exception 'count'; end if; end $x$ $q$) = 'OK',
  'part5: deletes and says 3 moved');
select pg_temp.assert(
  (select string_agg(slug || ':' || category || ':' || status, ',' order by slug) from public.blog_posts where slug in ('p107-draft', 'p107-sched', 'p107-live'))
    = 'p107-draft:kultura:draft,p107-live:kultura:published,p107-sched:kultura:published',
  'part5: draft, scheduled and live all moved; status untouched');
select pg_temp.assert(not exists (select 1 from public.blog_categories where value = 'perkthime'), 'part5: gone');
select pg_temp.assert(pg_temp.cat_order() = 'editorial:0,reflektime:1,zeja:2,vleresime:3,poezi:4,kultura:5,tregu:6',
  'part5: order closed up, got ' || pg_temp.cat_order());
select pg_temp.assert(
  (select metadata->>'articles_moved' || '|' || (metadata->>'moved_to') || '|' || (metadata->>'url_slug')
     from public.admin_audit_log where action = 'blog_category.deleted') = '3|kultura|perkthime',
  'part5: audit row');

-- An empty category needs no target.
select pg_temp.assert(pg_temp.run_as('authenticated', :OWNER,
  $q$do $x$ begin if public.delete_blog_category('vleresime', null) <> 0 then raise exception 'count'; end if; end $x$ $q$) = 'OK',
  'part5: an empty category deletes with no target');
select pg_temp.assert(pg_temp.read_as('anon') = 'editorial,reflektime,zeja,poezi,kultura,tregu', 'part5: readers see the new list');

-- ============================================================
-- Part 6: no direct writes; the foreign key.
-- ============================================================
select pg_temp.assert(pg_temp.run_as('authenticated', :OWNER,
  $q$insert into public.blog_categories (value, label, short_label, url_slug, description, colour, cta, sort_order) values ('x', 'x', 'x', 'x', 'x', 'teal', 'browse', 9)$q$)
  like 'permission denied%', 'part6: owner cannot insert directly');
select pg_temp.assert(pg_temp.run_as('authenticated', :OWNER,
  $q$update public.blog_categories set label = 'x'$q$) like 'permission denied%', 'part6: no direct update');
select pg_temp.assert(pg_temp.run_as('anon', null,
  $q$delete from public.blog_categories$q$) like 'permission denied%', 'part6: no direct delete');
do $$
begin
  begin
    delete from public.blog_categories where value = 'kultura';
    raise exception 'FAIL: part6: a category with articles must not delete directly';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into public.blog_categories (value, label, short_label, url_slug, description, colour, cta, sort_order)
    values ('x2', 'x', 'x', 'x2', 'x', 'gold', 'browse', 9);
    raise exception 'FAIL: part6: gold outside Editorial';
  exception when check_violation then null;
  end;
  begin
    update public.blog_categories set colour = 'teal' where value = 'editorial';
    raise exception 'FAIL: part6: Editorial must stay gold';
  exception when check_violation then null;
  end;
end $$;

-- ============================================================
-- Part 7: the real files.
-- ============================================================
delete from public.blog_posts;
insert into public.blog_posts (title, slug, excerpt, content_markdown, category, created_by, updated_at) values
  ('n', 'p107-new-cat', 'x', 'x', 'poezi', 'e1070000-0000-4000-8000-000000000003', '2026-02-01'),
  ('k', 'p107-kultura', 'x', 'x', 'kultura', 'e1070000-0000-4000-8000-000000000003', '2026-02-01');

\i supabase/tests/107_blog_categories_manage.rollback.sql
\i supabase/tests/107_blog_categories_manage.rollback.sql

do $$
begin
  perform pg_temp.assert(to_regclass('public.blog_categories') is null, 'part7: rollback drops the table');
  perform pg_temp.assert(to_regprocedure('public.delete_blog_category(text,text)') is null, 'part7: rollback drops the functions');
  perform pg_temp.assert((select category from public.blog_posts where slug = 'p107-new-cat') = 'zeja', 'part7: a later category moves to zeja');
  perform pg_temp.assert((select category from public.blog_posts where slug = 'p107-kultura') = 'kultura', 'part7: the five stay');
  perform pg_temp.assert(
    (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.blog_posts'::regclass and conname = 'blog_posts_category_check')
      like '%''vleresime''%', 'part7: the five-value CHECK is back');
  perform pg_temp.assert(pg_temp.run_as('authenticated', 'e1070000-0000-4000-8000-000000000002',
    $q$do $x$ begin if public.staff_has_permission('blog.categories') then raise exception 'still'; end if; end $x$ $q$) = 'OK',
    'part7: admin no longer holds blog.categories');
  perform pg_temp.assert(pg_temp.run_as('authenticated', 'e1070000-0000-4000-8000-000000000003',
    $q$select public.create_blog_post('t', 'p107-old', 'e', 'b', null, 'tregu', false, null, null)$q$) = 'OK',
    'part7: the old create_blog_post works');
end $$;

\i supabase/migrations/20261119180000_blog_categories_manage.sql

do $$
begin
  perform pg_temp.assert(
    pg_temp.cat_order() = 'editorial:0,zeja:1,tregu:2,kultura:3,reflektime:4,vleresime:5', 'part7: migration refills the six');
  perform pg_temp.assert(
    (select count(*) from public.blog_posts where updated_at = '2026-02-01'::timestamptz) = 2, 'part7: existing posts untouched');
  perform pg_temp.assert(pg_temp.run_as('authenticated', 'e1070000-0000-4000-8000-000000000002',
    $q$select public.create_blog_category('Përkthime', 'Përkthime', 'D', 'perkthime', 'teal', 'publish')$q$) = 'OK',
    'part7: works again after the migration');
end $$;

-- Running the migration a second time fails as a whole (the table
-- exists) and changes nothing.
\set ON_ERROR_STOP 0
\i supabase/migrations/20261119180000_blog_categories_manage.sql
\set ON_ERROR_STOP 1
do $$
begin
  perform pg_temp.assert(exists (select 1 from public.blog_categories where value = 'perkthime'), 'part7: second run changed nothing');
end $$;

select 'PASS: 107_blog_categories_manage' as result;
