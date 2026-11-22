-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for one pinned article and scheduled
-- publishing (migration 20261119130000_blog_pin_schedule.sql).
--   Part 1  shape: the one-pin index, the public read policy,
--           schedule_blog_post() rights and grants.
--   Part 2  one pin: create and update move the pin; the index stops a
--           second pin written directly.
--   Part 3  scheduling: who may, which rows, the time window, the
--           keyword rule, readers and search never see it early, the
--           slug stays editable until live, cancel = never-live draft,
--           unpublishing a live post keeps its first published_at.
--   Part 4  the migration on old data: extra pins are cleared, the one
--           /blog shows today is kept.
--   Part 5  the rollback file (lossy) and running the migration again.
--
-- Run from the repo root (run-sql-tests.sh gives it its own database):
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/106_blog_pin_schedule.test.sql

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

-- Slugs the given role can read, sorted.
create function pg_temp.visible(p_role text, p_uid text) returns text
  language plpgsql as $$
declare
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), false);
  execute format('set role %I', p_role);
  select coalesce(string_agg(slug, ',' order by slug), '-') into v_out from public.blog_posts;
  reset role;
  perform set_config('request.jwt.claim.sub', '', false);
  return v_out;
end;
$$;

create function pg_temp.search(p_role text, p_uid text, p_term text) returns text
  language plpgsql as $$
declare
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), false);
  execute format('set role %I', p_role);
  select coalesce(string_agg(b.slug, ',' order by b.slug), '-') into v_out
  from public.search_blog_posts(p_term, 30) s
  join public.blog_posts b on b.id = s.post_id;
  reset role;
  perform set_config('request.jwt.claim.sub', '', false);
  return v_out;
end;
$$;

create function pg_temp.pins() returns text
  language sql as $$
  select coalesce(string_agg(slug, ',' order by slug), '-') from public.blog_posts where featured;
$$;

grant usage on schema extensions to anon, authenticated;

insert into auth.users (id, email, raw_user_meta_data) values
  ('e1060000-0000-4000-8000-000000000001', 'p106-editor@test', '{"role":"reader","display_name":"Editor"}'),
  ('e1060000-0000-4000-8000-000000000002', 'p106-reader@test', '{"role":"reader","display_name":"Reader"}');
insert into public.staff_members (user_id, role) values
  ('e1060000-0000-4000-8000-000000000001', 'editor');

\set ed '''e1060000-0000-4000-8000-000000000001'''
\set rd '''e1060000-0000-4000-8000-000000000002'''

-- ============================================================
-- Part 1: shape.
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    (select indisunique and pg_get_expr(indpred, indrelid) = 'featured'
       from pg_index where indexrelid = 'public.blog_posts_one_pin_idx'::regclass),
    'part1: unique partial index on featured where featured');
  perform pg_temp.assert(
    (select qual from pg_policies where tablename = 'blog_posts' and policyname = 'Anyone can read published blog posts')
      like '%published_at <= now()%',
    'part1: the public policy needs published_at to have passed');
  perform pg_temp.assert(
    (select p.prosecdef and p.proconfig = array['search_path=""'] from pg_proc p
      where p.oid = 'public.schedule_blog_post(uuid,timestamptz)'::regprocedure),
    'part1: schedule_blog_post is SECURITY DEFINER with an empty search_path');
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.schedule_blog_post(uuid,timestamptz)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.schedule_blog_post(uuid,timestamptz)', 'EXECUTE'),
    'part1: schedule_blog_post executable by authenticated only');
  perform pg_temp.assert(
    has_function_privilege('anon', 'public.create_blog_post(text,text,text,text,text,text,boolean,text,text,boolean,text[],text)', 'EXECUTE') = false
    and has_function_privilege('authenticated', 'public.update_blog_post(uuid,text,text,text,text,text,text,boolean,text,text,boolean,text[],text)', 'EXECUTE'),
    'part1: create/update grants kept by CREATE OR REPLACE');
end;
$$;

-- ============================================================
-- Part 2: one pin.
-- ============================================================
select pg_temp.assert(pg_temp.run_as('authenticated', :ed,
  $q$select public.create_blog_post('A', 'p-a', 'e', 'body', null, 'zeja', true, null, null, false, array['k'])$q$) = 'OK', 'part2: create pinned A');
select pg_temp.assert(pg_temp.run_as('authenticated', :ed,
  $q$select public.create_blog_post('B', 'p-b', 'e', 'body', null, 'zeja', true, null, null, false, array['k'])$q$) = 'OK', 'part2: create pinned B');
select pg_temp.assert(pg_temp.pins() = 'p-b', 'part2: creating B pinned moves the pin (got ' || pg_temp.pins() || ')');

select pg_temp.assert(pg_temp.run_as('authenticated', :ed, format(
  $q$select public.update_blog_post(%L, 'A', 'p-a', 'e', 'body', null, 'zeja', true, null, null)$q$,
  (select id from public.blog_posts where slug = 'p-a'))) = 'OK', 'part2: pin A by update');
select pg_temp.assert(pg_temp.pins() = 'p-a', 'part2: updating A pinned moves the pin (got ' || pg_temp.pins() || ')');

select pg_temp.assert(pg_temp.run_as('authenticated', :ed, format(
  $q$select public.update_blog_post(%L, 'A', 'p-a', 'e', 'body', null, 'zeja', true, null, null)$q$,
  (select id from public.blog_posts where slug = 'p-a'))) = 'OK', 'part2: saving the pinned post again keeps it pinned');
select pg_temp.assert(pg_temp.pins() = 'p-a', 'part2: still A');

select pg_temp.assert(pg_temp.run_as('authenticated', :ed, format(
  $q$select public.update_blog_post(%L, 'A', 'p-a', 'e', 'body', null, 'zeja', false, null, null)$q$,
  (select id from public.blog_posts where slug = 'p-a'))) = 'OK', 'part2: unpin A');
select pg_temp.assert(pg_temp.pins() = '-', 'part2: no pin');

do $$
declare
  v_err text := 'none';
begin
  update public.blog_posts set featured = true where slug in ('p-a', 'p-b');
exception when unique_violation then
  v_err := 'unique';
end;
$$;
select pg_temp.assert(pg_temp.pins() = '-', 'part2: a direct double pin is refused by the index');

-- ============================================================
-- Part 3: scheduling.
-- ============================================================
delete from public.blog_posts;
insert into public.blog_posts (title, slug, excerpt, content_markdown, category, status, published_at, created_by, keywords) values
  ('Live', 's-live', 'Fjala', 'body', 'zeja', 'published', now() - interval '1 day', 'e1060000-0000-4000-8000-000000000001', array['fjala']),
  ('Draft', 's-draft', 'Fjala', 'body', 'zeja', 'draft', null, 'e1060000-0000-4000-8000-000000000001', array['fjala']),
  ('Was live', 's-was', 'Fjala', 'body', 'zeja', 'draft', now() - interval '3 days', 'e1060000-0000-4000-8000-000000000001', array['fjala']),
  ('No words', 's-nowords', 'Fjala', 'body', 'zeja', 'draft', null, 'e1060000-0000-4000-8000-000000000001', '{}');

create function pg_temp.sched(p_uid text, p_slug text, p_when text) returns text
  language sql as $$
  select pg_temp.run_as('authenticated', p_uid, format('select public.schedule_blog_post(%L, %s)',
    (select id from public.blog_posts where slug = p_slug), p_when));
$$;

select pg_temp.assert(pg_temp.sched('e1060000-0000-4000-8000-000000000002', 's-draft', $w$now() + interval '1 hour'$w$) = 'not authorized',
  'part3: a non-staff user cannot schedule');
select pg_temp.assert(pg_temp.run_as('anon', null, format('select public.schedule_blog_post(%L, now() + interval ''1 hour'')',
  (select id from public.blog_posts where slug = 's-draft'))) like 'permission denied%', 'part3: anon cannot call it');
select pg_temp.assert(pg_temp.sched(:ed, 's-draft', 'now()') = 'the go-live time must be in the future', 'part3: now is refused');
select pg_temp.assert(pg_temp.sched(:ed, 's-draft', $w$now() + interval '30 seconds'$w$) = 'the go-live time must be in the future', 'part3: under a minute is refused');
select pg_temp.assert(pg_temp.sched(:ed, 's-draft', $w$now() + interval '13 months'$w$) = 'the go-live time must be within a year', 'part3: over a year is refused');
select pg_temp.assert(pg_temp.sched(:ed, 's-was', $w$now() + interval '1 hour'$w$) = 'only a draft that has never been live can be scheduled', 'part3: a once-live draft cannot be scheduled');
select pg_temp.assert(pg_temp.sched(:ed, 's-live', $w$now() + interval '1 hour'$w$) = 'only a draft that has never been live can be scheduled', 'part3: a live post cannot be scheduled');
select pg_temp.assert(pg_temp.sched(:ed, 's-nowords', $w$now() + interval '1 hour'$w$) = 'a published article needs at least one keyword', 'part3: keyword needed');
select pg_temp.assert(pg_temp.sched(:ed, 's-draft', $w$now() + interval '1 hour'$w$) = 'OK', 'part3: schedule the draft');

select pg_temp.assert((select status = 'published' and published_at > now() + interval '59 minutes'
  from public.blog_posts where slug = 's-draft'), 'part3: scheduled = published with a future time');
select pg_temp.assert((select count(*) = 1 from public.admin_audit_log where action = 'blog_post.scheduled'
  and metadata->>'slug' = 's-draft'), 'part3: audit row written');

select pg_temp.assert(pg_temp.visible('anon', null) = 's-live', 'part3: anon sees only the live post (got ' || pg_temp.visible('anon', null) || ')');
select pg_temp.assert(pg_temp.visible('authenticated', :rd) = 's-live', 'part3: a signed-in reader sees only the live post');
select pg_temp.assert(pg_temp.search('anon', null, 'fjala') = 's-live', 'part3: search shows only the live post to anon');
select pg_temp.assert(pg_temp.search('authenticated', :ed, 'fjala') = 's-live', 'part3: search shows only the live post to staff too');

select pg_temp.assert(pg_temp.sched(:ed, 's-draft', $w$now() + interval '2 days'$w$) = 'OK', 'part3: change the time');
select pg_temp.assert((select published_at > now() + interval '1 day' from public.blog_posts where slug = 's-draft'), 'part3: new time stored');

-- The slug can still change while scheduled.
select pg_temp.assert(pg_temp.run_as('authenticated', :ed, format(
  $q$select public.update_blog_post(%L, 'Draft', 's-draft-2', 'Fjala', 'body', null, 'zeja', false, null, null)$q$,
  (select id from public.blog_posts where slug = 's-draft'))) = 'OK', 'part3: slug editable while scheduled');
select pg_temp.assert(pg_temp.run_as('authenticated', :ed, format(
  $q$select public.update_blog_post(%L, 'Draft', 's-draft-2', 'Fjala', 'body', null, 'zeja', false, null, null, null, '{}')$q$,
  (select id from public.blog_posts where slug = 's-draft-2'))) = 'a published article needs at least one keyword', 'part3: a scheduled post keeps a keyword');
select pg_temp.assert(pg_temp.run_as('authenticated', :ed, format(
  $q$select public.delete_blog_post(%L)$q$,
  (select id from public.blog_posts where slug = 's-draft-2'))) <> 'OK', 'part3: a scheduled post cannot be deleted');

-- Cancel: back to a never-live draft.
select pg_temp.assert(pg_temp.run_as('authenticated', :ed, format('select public.unpublish_blog_post(%L)',
  (select id from public.blog_posts where slug = 's-draft-2'))) = 'OK', 'part3: cancel the schedule');
select pg_temp.assert((select status = 'draft' and published_at is null from public.blog_posts where slug = 's-draft-2'),
  'part3: cancelled = draft with no published_at');
select pg_temp.assert((select count(*) = 1 from public.admin_audit_log where action = 'blog_post.schedule_cancelled'),
  'part3: cancel audited as schedule_cancelled');
select pg_temp.assert(pg_temp.sched(:ed, 's-draft-2', $w$now() + interval '1 hour'$w$) = 'OK', 'part3: can be scheduled again');

-- Going live: the time passes (moved into the past directly).
update public.blog_posts set published_at = now() - interval '1 minute' where slug = 's-draft-2';
select pg_temp.assert(pg_temp.visible('anon', null) = 's-draft-2,s-live', 'part3: live once the time passes');
select pg_temp.assert(pg_temp.search('anon', null, 'fjala') = 's-draft-2,s-live', 'part3: in search once live');
select pg_temp.assert(pg_temp.run_as('authenticated', :ed, format(
  $q$select public.update_blog_post(%L, 'Draft', 's-draft-3', 'Fjala', 'body', null, 'zeja', false, null, null)$q$,
  (select id from public.blog_posts where slug = 's-draft-2'))) = 'slug is immutable once a post is published', 'part3: slug locked once live');
select pg_temp.assert(pg_temp.sched(:ed, 's-draft-2', $w$now() + interval '1 hour'$w$) = 'only a draft that has never been live can be scheduled', 'part3: a live post cannot be rescheduled');

-- Unpublishing a live post keeps its first published_at.
select pg_temp.assert(pg_temp.run_as('authenticated', :ed, format('select public.unpublish_blog_post(%L)',
  (select id from public.blog_posts where slug = 's-live'))) = 'OK', 'part3: unpublish live');
select pg_temp.assert((select status = 'draft' and published_at < now() - interval '23 hours' from public.blog_posts where slug = 's-live'),
  'part3: a live post keeps its published_at when unpublished');
select pg_temp.assert((select count(*) = 1 from public.admin_audit_log where action = 'blog_post.unpublished'),
  'part3: unpublish audited as unpublished');

-- ============================================================
-- Part 4: the migration on old data (extra pins cleared).
-- ============================================================
-- Migration 20261122100000 (Written by name) came later still: its
-- rollback goes first.
\i supabase/tests/110_blog_author_name.rollback.sql
\i supabase/tests/106_blog_pin_schedule.rollback.sql
delete from public.blog_posts;
insert into public.blog_posts (title, slug, excerpt, content_markdown, category, status, published_at, featured, created_by, keywords, updated_at) values
  ('Old live pin', 'm-old', 'e', 'body', 'zeja', 'published', now() - interval '5 days', true, 'e1060000-0000-4000-8000-000000000001', array['k'], now() - interval '1 day'),
  ('New live pin', 'm-new', 'e', 'body', 'zeja', 'published', now() - interval '2 days', true, 'e1060000-0000-4000-8000-000000000001', array['k'], now() - interval '3 days'),
  ('Draft pin', 'm-draft', 'e', 'body', 'zeja', 'draft', null, true, 'e1060000-0000-4000-8000-000000000001', array['k'], now());
\i supabase/migrations/20261119130000_blog_pin_schedule.sql
select pg_temp.assert(pg_temp.pins() = 'm-new', 'part4: the newest live pin is kept (got ' || pg_temp.pins() || ')');
select pg_temp.assert((select updated_at < now() - interval '2 days' from public.blog_posts where slug = 'm-new'), 'part4: updated_at untouched');

-- ============================================================
-- Part 5: the rollback file and running the migration again.
-- ============================================================
select pg_temp.assert(pg_temp.sched(:ed, 'm-draft', $w$now() + interval '1 hour'$w$) = 'OK', 'part5: schedule before rollback');
\i supabase/tests/106_blog_pin_schedule.rollback.sql
select pg_temp.assert((select status = 'draft' and published_at is null from public.blog_posts where slug = 'm-draft'),
  'part5: rollback turns a scheduled post back into a never-live draft');
select pg_temp.assert(to_regprocedure('public.schedule_blog_post(uuid,timestamptz)') is null, 'part5: function dropped');
select pg_temp.assert(to_regclass('public.blog_posts_one_pin_idx') is null, 'part5: index dropped');
select pg_temp.assert(
  (select qual from pg_policies where tablename = 'blog_posts' and policyname = 'Anyone can read published blog posts') = '(status = ''published''::text)',
  'part5: old policy back');
select pg_temp.assert(has_function_privilege('authenticated', 'public.unpublish_blog_post(uuid)', 'EXECUTE'), 'part5: grants kept');
\i supabase/migrations/20261119130000_blog_pin_schedule.sql
select pg_temp.assert(to_regprocedure('public.schedule_blog_post(uuid,timestamptz)') is not null, 'part5: migration runs again');

select 'PASS 106_blog_pin_schedule' as result;
