-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for blog reactions
-- (supabase/migrations/20261123190000_blog_post_reactions.sql):
--
--   Part 1  shape: the table, its CHECK and keys, RLS, grants; both
--           functions SECURITY DEFINER with an empty search_path and
--           their EXECUTE grants.
--   Part 2  toggle_blog_post_reaction(): on, off, on again; several
--           reactions per reader; refusals (signed out, unknown
--           reaction, draft, scheduled, missing article, suspended,
--           waiting for deletion); no direct writes.
--   Part 3  who reads what: a reader reads only their own rows; anon
--           reads no rows; blog_post_reaction_counts() gives numbers for
--           live articles only, to anon too; more than 500 ids refused.
--   Part 4  cascades: a deleted account and a deleted article take
--           their reactions.
--   Part 5  the real files: rollback twice, the migration again.
--
-- NOT one rolled-back transaction: Part 5 runs the real migration and
-- rollback files with \i. run-sql-tests.sh gives every suite its own
-- throwaway database. Run from the repo root:
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/111_blog_post_reactions.test.sql
--
-- Against the BASE schema it fails in Part 1 (no table): the negative
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

-- What toggle returns for the given reader ('true'/'false') or the error.
create function pg_temp.toggle_as(p_uid text, p_slug text, p_reaction text) returns text
  language plpgsql as $$
declare
  v_out text;
  v_id uuid := (select id from public.blog_posts where slug = p_slug);
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), false);
  set role authenticated;
  begin
    v_out := public.toggle_blog_post_reaction(coalesce(v_id, '00000000-0000-4000-8000-000000000000'), p_reaction)::text;
  exception when others then
    v_out := sqlerrm;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', false);
  return v_out;
end;
$$;

-- How many rows the given role (and user id) can read in the table.
create function pg_temp.rows_as(p_role text, p_uid text) returns text
  language plpgsql as $$
declare
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), false);
  execute format('set role %I', p_role);
  begin
    select count(*)::text into v_out from public.blog_post_reactions;
  exception when others then
    v_out := sqlerrm;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', false);
  return v_out;
end;
$$;

-- The totals the given role reads for every p111 article, as text like
-- 'p111-live:helpful=1,like=2' (articles in slug order; '-' = none).
create function pg_temp.counts_as(p_role text) returns text
  language plpgsql as $$
declare
  v_ids uuid[] := (select array_agg(id) from public.blog_posts where slug like 'p111-%');
  v_out text;
begin
  execute format('set role %I', p_role);
  select coalesce(string_agg(line, ' ' order by line collate "C"), '-') into v_out
    from (select p.slug || ':' || string_agg(c.reaction || '=' || c.total, ',' order by c.reaction) as line
            from public.blog_post_reaction_counts(v_ids) c
            join public.blog_posts p on p.id = c.post_id
           group by p.slug) x;
  reset role;
  return v_out;
exception when others then
  reset role;
  return sqlerrm;
end;
$$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('e1110000-0000-4000-8000-000000000001', 'p111-editor@test', '{"role":"reader","display_name":"Editor"}'),
  ('e1110000-0000-4000-8000-000000000002', 'p111-reader-a@test', '{"role":"reader","display_name":"Reader A"}'),
  ('e1110000-0000-4000-8000-000000000003', 'p111-reader-b@test', '{"role":"reader","display_name":"Reader B"}'),
  ('e1110000-0000-4000-8000-000000000004', 'p111-suspended@test', '{"role":"reader","display_name":"Suspended"}'),
  ('e1110000-0000-4000-8000-000000000005', 'p111-leaving@test', '{"role":"reader","display_name":"Leaving"}');

\set EDITOR '''e1110000-0000-4000-8000-000000000001'''
\set A '''e1110000-0000-4000-8000-000000000002'''
\set B '''e1110000-0000-4000-8000-000000000003'''
\set SUSP '''e1110000-0000-4000-8000-000000000004'''
\set LEAV '''e1110000-0000-4000-8000-000000000005'''

insert into public.blog_posts (title, slug, excerpt, content_markdown, category, created_by) values
  ('Live', 'p111-live', 'x', 'x', 'zeja', 'e1110000-0000-4000-8000-000000000001'),
  ('Live 2', 'p111-live2', 'x', 'x', 'zeja', 'e1110000-0000-4000-8000-000000000001'),
  ('Draft', 'p111-draft', 'x', 'x', 'zeja', 'e1110000-0000-4000-8000-000000000001'),
  ('Later', 'p111-later', 'x', 'x', 'zeja', 'e1110000-0000-4000-8000-000000000001');
update public.blog_posts set status = 'published', published_at = now() - interval '1 day', keywords = array['k']
 where slug in ('p111-live', 'p111-live2');
update public.blog_posts set status = 'published', published_at = now() + interval '1 day', keywords = array['k']
 where slug = 'p111-later';

insert into public.account_suspensions (user_id, reason, suspended_by)
  values ('e1110000-0000-4000-8000-000000000004', 'p111 test', 'e1110000-0000-4000-8000-000000000001');
insert into public.account_deletion_requests (user_id, delete_after)
  values ('e1110000-0000-4000-8000-000000000005', now() + interval '30 days');

-- ============================================================
-- Part 1: shape.
-- ============================================================
do $$
begin
  perform pg_temp.assert(to_regclass('public.blog_post_reactions') is not null, 'part1: the table exists');
  perform pg_temp.assert(
    (select relrowsecurity from pg_class where oid = 'public.blog_post_reactions'::regclass),
    'part1: RLS is on');
  perform pg_temp.assert(
    (select pg_get_constraintdef(oid) from pg_constraint
      where conrelid = 'public.blog_post_reactions'::regclass and contype = 'p') = 'PRIMARY KEY (post_id, user_id, reaction)',
    'part1: one row per article, reader and reaction');
  perform pg_temp.assert(
    exists (select 1 from pg_constraint
             where conrelid = 'public.blog_post_reactions'::regclass and conname = 'blog_post_reactions_reaction_check'),
    'part1: the named CHECK exists');
  perform pg_temp.assert(
    (select count(*) from pg_constraint
      where conrelid = 'public.blog_post_reactions'::regclass and contype = 'f' and confdeltype = 'c') = 2,
    'part1: both foreign keys cascade');
  perform pg_temp.assert(
    has_table_privilege('authenticated', 'public.blog_post_reactions', 'SELECT')
    and not has_table_privilege('authenticated', 'public.blog_post_reactions', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not has_table_privilege('anon', 'public.blog_post_reactions', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not has_table_privilege('service_role', 'public.blog_post_reactions', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
    'part1: authenticated SELECT only; anon and service_role nothing');
  perform pg_temp.assert(
    (select bool_and(prosecdef and proconfig = array['search_path=""'])
       from pg_proc where proname in ('blog_post_reaction_counts', 'toggle_blog_post_reaction')
        and pronamespace = 'public'::regnamespace)
    and (select count(*) from pg_proc where proname in ('blog_post_reaction_counts', 'toggle_blog_post_reaction')
          and pronamespace = 'public'::regnamespace) = 2,
    'part1: both functions SECURITY DEFINER with an empty search_path');
  perform pg_temp.assert(
    has_function_privilege('anon', 'public.blog_post_reaction_counts(uuid[])', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.blog_post_reaction_counts(uuid[])', 'EXECUTE')
    and not has_function_privilege('service_role', 'public.blog_post_reaction_counts(uuid[])', 'EXECUTE'),
    'part1: counts for anon + authenticated');
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.toggle_blog_post_reaction(uuid,text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.toggle_blog_post_reaction(uuid,text)', 'EXECUTE')
    and not has_function_privilege('service_role', 'public.toggle_blog_post_reaction(uuid,text)', 'EXECUTE'),
    'part1: toggle for authenticated only');
end $$;

-- ============================================================
-- Part 2: toggle_blog_post_reaction().
-- ============================================================
select pg_temp.assert(pg_temp.toggle_as(:A, 'p111-live', 'like') = 'true', 'part2: first tap turns it on');
select pg_temp.assert(pg_temp.toggle_as(:A, 'p111-live', 'helpful') = 'true', 'part2: a second reaction on the same article');
select pg_temp.assert(pg_temp.toggle_as(:A, 'p111-live', 'inspired') = 'true', 'part2: all three at once');
select pg_temp.assert(pg_temp.toggle_as(:A, 'p111-live', 'inspired') = 'false', 'part2: tapping again turns it off');
select pg_temp.assert(pg_temp.toggle_as(:B, 'p111-live', 'like') = 'true', 'part2: another reader');
select pg_temp.assert(pg_temp.toggle_as(:B, 'p111-live2', 'helpful') = 'true', 'part2: another article');
select pg_temp.assert(
  (select string_agg(reaction, ',' order by reaction) from public.blog_post_reactions
    where user_id = 'e1110000-0000-4000-8000-000000000002') = 'helpful,like',
  'part2: reader A has like + helpful');

select pg_temp.assert(pg_temp.toggle_as(null, 'p111-live', 'like') = 'not authenticated', 'part2: signed out refused');
select pg_temp.assert(pg_temp.toggle_as(:A, 'p111-live', 'love') = 'toggle_blog_post_reaction: invalid reaction', 'part2: unknown reaction refused');
select pg_temp.assert(pg_temp.toggle_as(:A, 'p111-live', null) = 'toggle_blog_post_reaction: invalid reaction', 'part2: null reaction refused');
select pg_temp.assert(pg_temp.toggle_as(:A, 'p111-draft', 'like') = 'toggle_blog_post_reaction: article not live', 'part2: a draft refused');
select pg_temp.assert(pg_temp.toggle_as(:A, 'p111-later', 'like') = 'toggle_blog_post_reaction: article not live', 'part2: a scheduled article refused');
select pg_temp.assert(pg_temp.toggle_as(:A, 'p111-missing', 'like') = 'toggle_blog_post_reaction: article not live', 'part2: a missing article refused');
select pg_temp.assert(pg_temp.toggle_as(:SUSP, 'p111-live', 'like') = 'toggle_blog_post_reaction: account not active', 'part2: a suspended account refused');
select pg_temp.assert(pg_temp.toggle_as(:LEAV, 'p111-live', 'like') = 'toggle_blog_post_reaction: account not active', 'part2: an account waiting for deletion refused');

select pg_temp.assert(
  pg_temp.run_as('authenticated', :A,
    $q$insert into public.blog_post_reactions (post_id, user_id, reaction)
       select id, 'e1110000-0000-4000-8000-000000000002', 'inspired' from public.blog_posts where slug = 'p111-live'$q$)
    like 'permission denied%',
  'part2: no direct insert');
select pg_temp.assert(
  pg_temp.run_as('authenticated', :A, $q$delete from public.blog_post_reactions$q$) like 'permission denied%',
  'part2: no direct delete');
select pg_temp.assert(
  pg_temp.run_as('anon', null, $q$select public.toggle_blog_post_reaction(gen_random_uuid(), 'like')$q$) like 'permission denied%',
  'part2: anon cannot call toggle');
select pg_temp.assert((select count(*) from public.blog_post_reactions) = 4, 'part2: refused calls saved nothing');

-- ============================================================
-- Part 3: who reads what.
-- ============================================================
select pg_temp.assert(pg_temp.rows_as('authenticated', :A) = '2', 'part3: reader A reads their own two rows');
select pg_temp.assert(pg_temp.rows_as('authenticated', :B) = '2', 'part3: reader B reads their own two rows');
select pg_temp.assert(pg_temp.rows_as('authenticated', :EDITOR) = '0', 'part3: staff read no reader rows');
select pg_temp.assert(pg_temp.rows_as('anon', null) like 'permission denied%', 'part3: anon reads no rows');

select pg_temp.assert(pg_temp.counts_as('anon') = 'p111-live2:helpful=1 p111-live:helpful=1,like=2', 'part3: anon reads the totals');
select pg_temp.assert(pg_temp.counts_as('authenticated') = 'p111-live2:helpful=1 p111-live:helpful=1,like=2', 'part3: authenticated reads the same totals');

-- A reaction left on an article that later goes back to draft is not counted.
insert into public.blog_post_reactions (post_id, user_id, reaction)
  select id, 'e1110000-0000-4000-8000-000000000002', 'like' from public.blog_posts where slug = 'p111-draft';
select pg_temp.assert(pg_temp.counts_as('anon') = 'p111-live2:helpful=1 p111-live:helpful=1,like=2', 'part3: a draft''s rows are never counted');
delete from public.blog_posts where slug = 'p111-draft';

select pg_temp.assert(
  pg_temp.run_as('anon', null, $q$select * from public.blog_post_reaction_counts(null)$q$) = 'OK',
  'part3: null ids gives no rows, no error');
select pg_temp.assert(
  pg_temp.run_as('anon', null,
    $q$select * from public.blog_post_reaction_counts(array(select gen_random_uuid() from generate_series(1, 501)))$q$)
    = 'blog_post_reaction_counts: too many articles',
  'part3: more than 500 ids refused');
select pg_temp.assert(
  pg_temp.run_as('anon', null,
    $q$select * from public.blog_post_reaction_counts(array(select gen_random_uuid() from generate_series(1, 500)))$q$) = 'OK',
  'part3: 500 ids accepted');
select pg_temp.assert(
  (select array_to_string(proargnames, ',') from pg_proc where oid = 'public.blog_post_reaction_counts(uuid[])'::regprocedure)
      = 'p_post_ids,post_id,reaction,total',
  'part3: the totals carry no user id');

-- ============================================================
-- Part 4: cascades.
-- ============================================================
delete from auth.users where id = 'e1110000-0000-4000-8000-000000000003';
select pg_temp.assert(pg_temp.counts_as('anon') = 'p111-live:helpful=1,like=1', 'part4: a deleted account takes its reactions');
delete from public.blog_posts where slug = 'p111-live';
select pg_temp.assert(not exists (select 1 from public.blog_post_reactions), 'part4: a deleted article takes its reactions');

-- ============================================================
-- Part 5: the real files.
-- ============================================================
select pg_temp.toggle_as(:A, 'p111-live2', 'like');

\i supabase/tests/111_blog_post_reactions.rollback.sql
\i supabase/tests/111_blog_post_reactions.rollback.sql

do $$
begin
  perform pg_temp.assert(to_regclass('public.blog_post_reactions') is null, 'part5: rollback drops the table');
  perform pg_temp.assert(
    to_regprocedure('public.blog_post_reaction_counts(uuid[])') is null
    and to_regprocedure('public.toggle_blog_post_reaction(uuid,text)') is null,
    'part5: rollback drops both functions');
  perform pg_temp.assert(exists (select 1 from public.blog_posts where slug = 'p111-live2'), 'part5: rollback keeps every post');
end $$;

\i supabase/migrations/20261123190000_blog_post_reactions.sql

select pg_temp.assert(pg_temp.toggle_as(:A, 'p111-live2', 'like') = 'true', 'part5: the migration again works');
select pg_temp.assert(pg_temp.counts_as('anon') = 'p111-live2:like=1', 'part5: totals again');

select 'ALL PASS' as result;
