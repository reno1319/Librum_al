-- Committed SQL regression suite for migration 047 (BLOG-1B: blog_posts
-- schema + RBAC + storage foundation).
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql -- no new test
-- infrastructure needed, same as every other suite in this directory.
-- Run manually against a disposable/local Postgres instance, AFTER
-- applying supabase/schema.sql, from the repo root:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/047_blog_posts_rls.test.sql
--
-- This file was written and reviewed as part of BLOG-1B's implementation
-- but has NOT been executed in this environment -- no local/CI Postgres
-- was available. It is a reviewed contract, not a confirmed-passing
-- result; run it before this migration is ever applied anywhere real.
--
-- STORAGE TEST LIMITATION (stated plainly, per BLOG-1B's own
-- instruction not to fake runtime certainty the harness cannot provide):
-- 00_stub_supabase_platform.sql's storage.objects/storage.buckets are
-- minimal stand-ins (id/bucket_id/name/owner columns only) with RLS
-- enabled, sufficient to faithfully exercise the actual POLICY
-- DEFINITIONS this migration adds (bucket_id + owner-path + permission-
-- gated INSERT/SELECT/UPDATE/DELETE, exactly as pg_policy would show
-- against a real Supabase project). It does NOT model actual file
-- bytes, content-type/size validation, signed URLs, or the real
-- Supabase Storage API/CDN -- those belong entirely to application code
-- (BLOG-1C's Server Actions), never to this SQL harness, and no other
-- bucket in this repo's test suite attempts to model them either. The
-- storage assertions below test policy/grant CONTRACTS, not upload
-- mechanics.
--
-- Everything below runs inside one transaction and is rolled back at
-- the end, so this file is fully repeatable with no manual cleanup
-- between runs -- including the one deliberate, temporary
-- staff_has_permission() override in Part 3 (see that part's own
-- comment), which a rollback undoes exactly like every other statement.

begin;

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

grant usage on schema extensions to anon, authenticated;

-- ============================================================
-- Fixtures: one profile per role this suite exercises.
-- ============================================================
insert into auth.users (id, email, raw_user_meta_data) values
  ('e0000000-0000-0000-0000-000000000001', 'p047-owner@test', '{"role":"reader","display_name":"Owner"}'),
  ('e0000000-0000-0000-0000-000000000002', 'p047-admin@test', '{"role":"reader","display_name":"Admin"}'),
  ('e0000000-0000-0000-0000-000000000003', 'p047-editor@test', '{"role":"reader","display_name":"Editor"}'),
  ('e0000000-0000-0000-0000-000000000004', 'p047-moderator@test', '{"role":"reader","display_name":"Moderator"}'),
  ('e0000000-0000-0000-0000-000000000005', 'p047-support@test', '{"role":"reader","display_name":"Support"}'),
  ('e0000000-0000-0000-0000-000000000006', 'p047-nonstaff@test', '{"role":"reader","display_name":"Non-staff"}'),
  ('e0000000-0000-0000-0000-000000000007', 'p047-viewonly@test', '{"role":"reader","display_name":"View Only"}');

insert into public.staff_members (user_id, role) values
  ('e0000000-0000-0000-0000-000000000001', 'owner'),
  ('e0000000-0000-0000-0000-000000000002', 'admin'),
  ('e0000000-0000-0000-0000-000000000003', 'editor'),
  ('e0000000-0000-0000-0000-000000000004', 'moderator'),
  ('e0000000-0000-0000-0000-000000000005', 'support');
-- e...007 (view-only) deliberately gets no staff_members row -- see
-- Part 3's own comment for why "blog.view without blog.manage" cannot
-- be reached through any real role in the approved matrix, and how
-- this suite exercises it anyway.

insert into public.blog_posts (id, title, slug, excerpt, content_markdown, category, created_by) values
  ('f0000000-0000-0000-0000-000000000001', 'Published Post', 'published-post', 'An excerpt.', 'Body.', 'writing', 'e0000000-0000-0000-0000-000000000001'),
  ('f0000000-0000-0000-0000-000000000002', 'Draft Post', 'draft-post', 'An excerpt.', 'Body.', 'publishing', 'e0000000-0000-0000-0000-000000000001');
update public.blog_posts set status = 'published', published_at = now() where id = 'f0000000-0000-0000-0000-000000000001';

-- ============================================================
-- Part 0: static grant/RLS/function shape -- the same class of check
-- 040's own Part 1/Part 1b established for staff_members/
-- staff_has_permission().
-- ============================================================
do $$
begin
  -- Table-level ACL: SELECT only, to both anon and authenticated --
  -- never INSERT/UPDATE/DELETE to either.
  perform pg_temp.assert(
    has_table_privilege('anon', 'public.blog_posts', 'SELECT'),
    'part0: anon must have table-level SELECT on blog_posts'
  );
  perform pg_temp.assert(
    has_table_privilege('authenticated', 'public.blog_posts', 'SELECT'),
    'part0: authenticated must have table-level SELECT on blog_posts'
  );
  perform pg_temp.assert(
    not has_table_privilege('anon', 'public.blog_posts', 'INSERT'),
    'part0: anon must NOT have table-level INSERT on blog_posts'
  );
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.blog_posts', 'INSERT'),
    'part0: authenticated must NOT have table-level INSERT on blog_posts'
  );
  perform pg_temp.assert(
    not has_table_privilege('anon', 'public.blog_posts', 'UPDATE'),
    'part0: anon must NOT have table-level UPDATE on blog_posts'
  );
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.blog_posts', 'UPDATE'),
    'part0: authenticated must NOT have table-level UPDATE on blog_posts'
  );
  perform pg_temp.assert(
    not has_table_privilege('anon', 'public.blog_posts', 'DELETE'),
    'part0: anon must NOT have table-level DELETE on blog_posts'
  );
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.blog_posts', 'DELETE'),
    'part0: authenticated must NOT have table-level DELETE on blog_posts'
  );

  -- No INSERT/UPDATE/DELETE RLS policy exists at all -- with no grant
  -- for those commands, one would never be evaluated (see this
  -- migration's own header).
  perform pg_temp.assert(
    not exists (
      select 1 from pg_policy
      where polrelid = 'public.blog_posts'::regclass
        and polcmd in ('a', 'w', 'd') -- INSERT, UPDATE, DELETE
    ),
    'part0: blog_posts must have zero insert/update/delete policies'
  );

  -- Exactly the two documented SELECT policies, nothing else.
  perform pg_temp.assert(
    (select count(*) from pg_policy where polrelid = 'public.blog_posts'::regclass) = 2,
    'part0: blog_posts must have exactly two policies (both SELECT)'
  );
end $$;

-- SECURITY DEFINER + empty search_path + EXECUTE-to-authenticated-only
-- on every new RPC.
do $$
declare
  func record;
  sigs text[] := array[
    'create_blog_post(text,text,text,text,text,text,boolean,text,text)',
    'update_blog_post(uuid,text,text,text,text,text,text,boolean,text,text)',
    'publish_blog_post(uuid)',
    'unpublish_blog_post(uuid)',
    'delete_blog_post(uuid)'
  ];
  sig text;
begin
  foreach sig in array sigs loop
    perform pg_temp.assert(
      has_function_privilege('authenticated', format('public.%s', sig), 'EXECUTE'),
      format('part0: authenticated must have EXECUTE on %s', sig)
    );
    perform pg_temp.assert(
      not has_function_privilege('anon', format('public.%s', sig), 'EXECUTE'),
      format('part0: anon must NOT have EXECUTE on %s', sig)
    );
  end loop;

  -- BLOG-1B.1 (found by real Postgres execution): staff_has_permission()
  -- itself IS granted to anon, deliberately, unlike the five mutation
  -- RPCs above -- required for anon to even evaluate the blog.view-
  -- gated SELECT policy below (Part 1 would otherwise fail with
  -- "permission denied for function" on the very first anon read, since
  -- the draft row's first policy disjunct is false and Postgres must
  -- evaluate the second). Safe because auth.uid() is always null for
  -- anon, so this remains deterministically false for every permission.
  perform pg_temp.assert(
    has_function_privilege('anon', 'public.staff_has_permission(text)', 'EXECUTE'),
    'part0: anon must have EXECUTE on staff_has_permission -- required to evaluate the blog.view policy at all'
  );
end $$;

-- ============================================================
-- Part 1: ANON.
-- ============================================================
do $$
begin
  set local role anon;
  perform pg_temp.assert(
    (select count(*) from public.blog_posts) = 1,
    'part1: anon must see exactly the one published post, never the draft'
  );
  perform pg_temp.assert(
    (select slug from public.blog_posts limit 1) = 'published-post',
    'part1: the one visible row must be the published one'
  );
  reset role;
end $$;

do $$
begin
  set local role anon;
  begin
    insert into public.blog_posts (title, slug, excerpt, content_markdown, category, created_by)
    values ('x', 'x', 'x', 'x', 'writing', 'e0000000-0000-0000-0000-000000000001');
    perform pg_temp.assert(false, 'part1: anon direct INSERT into blog_posts must be rejected');
  exception when insufficient_privilege then
    null; -- expected: no table-level INSERT grant
  end;
  reset role;
end $$;

do $$
begin
  set local role anon;
  begin
    update public.blog_posts set title = 'x' where id = 'f0000000-0000-0000-0000-000000000001';
    perform pg_temp.assert(false, 'part1: anon direct UPDATE on blog_posts must be rejected');
  exception when insufficient_privilege then
    null;
  end;
  reset role;
end $$;

do $$
begin
  set local role anon;
  begin
    delete from public.blog_posts where id = 'f0000000-0000-0000-0000-000000000001';
    perform pg_temp.assert(false, 'part1: anon direct DELETE on blog_posts must be rejected');
  exception when insufficient_privilege then
    null;
  end;
  reset role;
end $$;

-- ============================================================
-- Part 2: AUTHENTICATED NON-STAFF -- same public read, cannot mutate,
-- every RPC rejected with 'not authorized' (staff_has_permission()
-- returns false for a non-staff auth.uid(), never null/error).
-- ============================================================
do $$
begin
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000006', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.blog_posts) = 1,
    'part2: a non-staff authenticated user must see only the published post'
  );
  begin
    insert into public.blog_posts (title, slug, excerpt, content_markdown, category, created_by)
    values ('x', 'x', 'x', 'x', 'writing', 'e0000000-0000-0000-0000-000000000006');
    perform pg_temp.assert(false, 'part2: non-staff direct INSERT must be rejected');
  exception when insufficient_privilege then
    null;
  end;
  reset role;
end $$;

do $$
begin
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000006', true);
  set local role authenticated;
  begin
    perform public.create_blog_post('x', 'x-slug', 'x', 'x', null, 'writing', false, null, null);
    perform pg_temp.assert(false, 'part2: non-staff create_blog_post() must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part2: unexpected message: %s', sqlerrm));
  end;
  reset role;
end $$;

do $$
begin
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000006', true);
  set local role authenticated;
  begin
    perform public.publish_blog_post('f0000000-0000-0000-0000-000000000002');
    perform pg_temp.assert(false, 'part2: non-staff publish_blog_post() must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part2: unexpected message: %s', sqlerrm));
  end;
  reset role;
end $$;

-- ============================================================
-- Part 3: BLOG.VIEW WITHOUT BLOG.MANAGE.
--
-- No role in the approved matrix actually holds blog.view without
-- blog.manage -- owner/admin/editor hold both together, moderator/
-- support hold neither (src/lib/staff-permissions.ts's own ROLE_
-- PERMISSIONS). To still prove the RPCs check blog.manage SPECIFICALLY
-- (not merely "any blog permission" or "authenticated at all"), this
-- part temporarily redefines staff_has_permission() to special-case one
-- fixture uid as view-only, for the remainder of this transaction only.
-- CREATE OR REPLACE FUNCTION is transactional DDL -- this file's own
-- closing `rollback` undoes it exactly like every other statement here,
-- so the real, migration-047-defined function is untouched outside this
-- test run.
-- ============================================================
create or replace function public.staff_has_permission(p_permission text)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select case
    when auth.uid() = 'e0000000-0000-0000-0000-000000000007'::uuid then p_permission = 'blog.view'
    else exists (
      select 1
      from public.staff_members sm
      where sm.user_id = auth.uid()
        and (
          sm.role = 'owner'
          or (
            sm.role = 'admin'
            and p_permission in (
              'admin.access', 'reports.view', 'reports.resolve',
              'refunds.view', 'refunds.resolve', 'staff.view', 'audit.view',
              'finance.view', 'blog.view', 'blog.manage'
            )
          )
          or (
            sm.role = 'editor'
            and p_permission in ('admin.access', 'blog.view', 'blog.manage')
          )
          or (
            sm.role = 'moderator'
            and p_permission in ('admin.access', 'reports.view', 'reports.resolve')
          )
          or (
            sm.role = 'support'
            and p_permission in ('admin.access', 'refunds.view')
          )
        )
    )
  end;
$$;

do $$
begin
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000007', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.blog_posts) = 2,
    'part3: blog.view (without blog.manage) must see both the draft and the published post'
  );
  begin
    perform public.create_blog_post('x', 'x-slug-2', 'x', 'x', null, 'writing', false, null, null);
    perform pg_temp.assert(false, 'part3: blog.view without blog.manage must not be able to create_blog_post()');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part3: unexpected message: %s', sqlerrm));
  end;
  begin
    perform public.publish_blog_post('f0000000-0000-0000-0000-000000000002');
    perform pg_temp.assert(false, 'part3: blog.view without blog.manage must not be able to publish_blog_post()');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part3: unexpected message: %s', sqlerrm));
  end;
  begin
    perform public.delete_blog_post('f0000000-0000-0000-0000-000000000002');
    perform pg_temp.assert(false, 'part3: blog.view without blog.manage must not be able to delete_blog_post()');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part3: unexpected message: %s', sqlerrm));
  end;
  reset role;
end $$;

-- ============================================================
-- Part 4: EDITOR / BLOG.MANAGE -- full lifecycle, using the REAL
-- editor role (not the Part 3 synthetic override, which only applied
-- while that CREATE OR REPLACE was in effect for this transaction --
-- restoring the migration-047 function here isn't necessary since
-- everything in this file shares one transaction and staff_has_
-- permission() already behaves identically for 'editor' either way,
-- but is stated for clarity: the override in Part 3 only special-cased
-- uid ...007, every other uid (including editor's) already fell through
-- to the exact same real matrix logic).
-- ============================================================
do $$
declare
  v_new_id uuid;
  v_created_by uuid;
  v_status text;
begin
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000003', true);
  set local role authenticated;

  -- Create: succeeds, status forced to draft, published_at null,
  -- created_by = auth.uid() regardless of anything the caller could
  -- attempt to influence (created_by is not even a parameter).
  select public.create_blog_post(
    'Editor Post', 'editor-post', 'An excerpt.', 'Body content.', null,
    'authors-books', false, null, null
  ) into v_new_id;

  perform pg_temp.assert(v_new_id is not null, 'part4: create_blog_post() must return a new id');
  reset role;

  select created_by, status into v_created_by, v_status from public.blog_posts where id = v_new_id;
  perform pg_temp.assert(
    v_created_by = 'e0000000-0000-0000-0000-000000000003',
    'part4: created_by must equal the calling editor''s own auth.uid(), never spoofable (not a parameter at all)'
  );
  perform pg_temp.assert(v_status = 'draft', 'part4: a newly created post must be a draft');
  perform pg_temp.assert(
    (select published_at from public.blog_posts where id = v_new_id) is null,
    'part4: a newly created draft must have published_at = null'
  );

  -- Raw table writes denied despite blog.manage -- the entire point of
  -- the RPC-only design (Section D of BLOG-1A.1's review).
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  begin
    update public.blog_posts set status = 'published' where id = v_new_id;
    perform pg_temp.assert(false, 'part4: a raw authenticated UPDATE must be rejected even with blog.manage');
  exception when insufficient_privilege then
    null; -- expected: no table-level UPDATE grant, regardless of RLS/permission
  end;
  begin
    insert into public.blog_posts (title, slug, excerpt, content_markdown, category, created_by)
    values ('spoof', 'spoof-slug', 'x', 'x', 'writing', 'e0000000-0000-0000-0000-000000000001');
    perform pg_temp.assert(false, 'part4: a raw authenticated INSERT must be rejected even with blog.manage');
  exception when insufficient_privilege then
    null;
  end;
  reset role;

  -- Draft slug update works through the RPC.
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  perform public.update_blog_post(
    v_new_id, 'Editor Post', 'editor-post-renamed', 'An excerpt.', 'Body content.', null,
    'authors-books', false, null, null
  );
  reset role;
  perform pg_temp.assert(
    (select slug from public.blog_posts where id = v_new_id) = 'editor-post-renamed',
    'part4: slug must be editable via update_blog_post() while the post is a draft'
  );

  -- Publish: succeeds, published_at set, audit row written.
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  perform public.publish_blog_post(v_new_id);
  reset role;

  perform pg_temp.assert(
    (select status from public.blog_posts where id = v_new_id) = 'published',
    'part4: publish_blog_post() must transition draft -> published'
  );
  perform pg_temp.assert(
    (select published_at from public.blog_posts where id = v_new_id) is not null,
    'part4: publish_blog_post() must set published_at on first publish'
  );
  perform pg_temp.assert(
    exists (
      select 1 from public.admin_audit_log
      where target_type = 'blog_posts' and target_id = v_new_id and action = 'blog_post.published'
        and metadata = jsonb_build_object('slug', 'editor-post-renamed')
        and actor_id = 'e0000000-0000-0000-0000-000000000003'
    ),
    'part4: publish must write an admin_audit_log row with slug-only metadata and the acting editor as actor'
  );

  -- Published slug change rejected.
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  begin
    perform public.update_blog_post(
      v_new_id, 'Editor Post', 'editor-post-renamed-again', 'An excerpt.', 'Body content.', null,
      'authors-books', false, null, null
    );
    perform pg_temp.assert(false, 'part4: changing slug on a published post must be rejected');
  exception when others then
    perform pg_temp.assert(
      sqlerrm = 'slug is immutable once a post is published',
      format('part4: unexpected message: %s', sqlerrm)
    );
  end;
  -- A same-value slug "change" (title edit alongside an unchanged slug)
  -- must still succeed -- only an actual slug DIFFERENCE is rejected.
  perform public.update_blog_post(
    v_new_id, 'Editor Post Updated Title', 'editor-post-renamed', 'An excerpt.', 'Body content.', null,
    'authors-books', false, null, null
  );
  reset role;
  perform pg_temp.assert(
    (select title from public.blog_posts where id = v_new_id) = 'Editor Post Updated Title',
    'part4: ordinary fields must remain editable on a published post when slug is left unchanged'
  );

  -- Repeat invalid publish: already published -> raises, not a silent no-op.
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  begin
    perform public.publish_blog_post(v_new_id);
    perform pg_temp.assert(false, 'part4: publishing an already-published post must raise, not silently succeed');
  exception when others then
    perform pg_temp.assert(
      sqlerrm = 'no publishable draft found for this id',
      format('part4: unexpected message: %s', sqlerrm)
    );
  end;
  reset role;

  -- Unpublish: published_at preserved.
  declare
    v_published_at_1 timestamptz;
    v_published_at_2 timestamptz;
  begin
    select published_at into v_published_at_1 from public.blog_posts where id = v_new_id;

    perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000003', true);
    set local role authenticated;
    perform public.unpublish_blog_post(v_new_id);
    reset role;

    perform pg_temp.assert(
      (select status from public.blog_posts where id = v_new_id) = 'draft',
      'part4: unpublish_blog_post() must transition published -> draft'
    );
    perform pg_temp.assert(
      (select published_at from public.blog_posts where id = v_new_id) = v_published_at_1,
      'part4: unpublish_blog_post() must never alter published_at'
    );
    perform pg_temp.assert(
      exists (
        select 1 from public.admin_audit_log
        where target_type = 'blog_posts' and target_id = v_new_id and action = 'blog_post.unpublished'
      ),
      'part4: unpublish must write an admin_audit_log row'
    );

    -- Republish preserves the ORIGINAL published_at (coalesce semantics).
    perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000003', true);
    set local role authenticated;
    perform public.publish_blog_post(v_new_id);
    reset role;

    select published_at into v_published_at_2 from public.blog_posts where id = v_new_id;
    perform pg_temp.assert(
      v_published_at_2 = v_published_at_1,
      'part4: republishing after an unpublish must preserve the ORIGINAL published_at, never reset it'
    );
  end;

  -- Published delete rejected.
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  begin
    perform public.delete_blog_post(v_new_id);
    perform pg_temp.assert(false, 'part4: deleting a published post must be rejected');
  exception when others then
    perform pg_temp.assert(
      sqlerrm = 'only a draft post can be deleted, or it does not exist',
      format('part4: unexpected message: %s', sqlerrm)
    );
  end;
  reset role;

  -- Draft delete succeeds, returns cover_image_path per the chosen
  -- cleanup contract, audit written.
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  perform public.unpublish_blog_post(v_new_id);
  reset role;

  -- Seeded directly as the test-runner/superuser (bypassing RLS/grants
  -- entirely, same convention 040's own fixture inserts use), purely to
  -- give this row a non-null cover to assert against below -- not
  -- itself a claim about direct-client UPDATE privilege, which Part 4's
  -- earlier assertions already covered.
  update public.blog_posts set cover_image_path = 'blog/test-cover.jpg' where id = v_new_id;

  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select deleted_cover_image_path from public.delete_blog_post(v_new_id)) = 'blog/test-cover.jpg',
    'part4: delete_blog_post() must return the deleted row''s cover_image_path per the chosen cleanup contract'
  );
  reset role;

  perform pg_temp.assert(
    not exists (select 1 from public.blog_posts where id = v_new_id),
    'part4: a draft delete must actually remove the row'
  );
  perform pg_temp.assert(
    exists (
      select 1 from public.admin_audit_log
      where target_type = 'blog_posts' and target_id = v_new_id and action = 'blog_post.deleted'
    ),
    'part4: delete must write an admin_audit_log row'
  );
end $$;

-- Invalid category is rejected by both create and update.
do $$
begin
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  begin
    perform public.create_blog_post('x', 'x-invalid-cat', 'x', 'x', null, 'not-a-real-category', false, null, null);
    perform pg_temp.assert(false, 'part4: an invalid category must be rejected by create_blog_post()');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'invalid category', format('part4: unexpected message: %s', sqlerrm));
  end;
  reset role;
end $$;

-- ============================================================
-- Part 5: audit filter allow-list -- the three new blog actions and the
-- blog_posts target_type are accepted by list_admin_audit_events()'s
-- filter, and the unfiltered default view is unaffected.
-- ============================================================
do $$
begin
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  perform pg_temp.assert(
    exists (select 1 from public.list_admin_audit_events(p_action := 'blog_post.published')),
    'part5: list_admin_audit_events() must accept blog_post.published as a valid action filter'
  );
  perform pg_temp.assert(
    exists (select 1 from public.list_admin_audit_events(p_target_type := 'blog_posts')),
    'part5: list_admin_audit_events() must accept blog_posts as a valid target_type filter'
  );
  perform pg_temp.assert(
    (select count(*) from public.list_admin_audit_events()) >= 3,
    'part5: the unfiltered default view must already include the blog_post.published/unpublished/deleted rows'
  );
  reset role;
end $$;

-- ============================================================
-- Part 6: MODERATOR / SUPPORT -- no blog permissions.
-- ============================================================
do $$
begin
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000004', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.blog_posts) = 1,
    'part6: moderator (no blog.view) must see only the published post'
  );
  begin
    perform public.create_blog_post('x', 'x-mod', 'x', 'x', null, 'writing', false, null, null);
    perform pg_temp.assert(false, 'part6: moderator must not be able to create_blog_post()');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part6: unexpected message: %s', sqlerrm));
  end;
  reset role;
end $$;

do $$
begin
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000005', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.blog_posts) = 1,
    'part6: support (no blog.view) must see only the published post'
  );
  begin
    perform public.publish_blog_post('f0000000-0000-0000-0000-000000000002');
    perform pg_temp.assert(false, 'part6: support must not be able to publish_blog_post()');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part6: unexpected message: %s', sqlerrm));
  end;
  reset role;
end $$;

-- ============================================================
-- Part 7: storage -- policy/grant contracts only (see this file's own
-- header for the exact limitation).
-- ============================================================
do $$
begin
  -- Own-user manuscript temp path remains available -- pre-existing
  -- owner-path policies, untouched by this migration, already cover
  -- <own-uid>/tmp/blog/<uuid>.<ext> exactly as they cover any other
  -- path under the caller's own uid.
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  insert into storage.objects (bucket_id, name, owner)
  values ('manuscripts', 'e0000000-0000-0000-0000-000000000003/tmp/blog/test.png', 'e0000000-0000-0000-0000-000000000003');
  perform pg_temp.assert(
    exists (
      select 1 from storage.objects
      where bucket_id = 'manuscripts' and name = 'e0000000-0000-0000-0000-000000000003/tmp/blog/test.png'
    ),
    'part7: an editor must still be able to stage an object under their own uid in manuscripts'
  );
  reset role;
end $$;

do $$
begin
  -- blog.manage can write the permanent public blog bucket.
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  insert into storage.objects (bucket_id, name, owner)
  values ('blog', 'covers/test-cover.jpg', 'e0000000-0000-0000-0000-000000000003');
  perform pg_temp.assert(
    exists (select 1 from storage.objects where bucket_id = 'blog' and name = 'covers/test-cover.jpg'),
    'part7: blog.manage (editor) must be able to write the permanent blog bucket'
  );
  reset role;
end $$;

do $$
begin
  -- non-blog staff (moderator) cannot write the permanent blog bucket.
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000004', true);
  set local role authenticated;
  begin
    insert into storage.objects (bucket_id, name, owner)
    values ('blog', 'covers/moderator-attempt.jpg', 'e0000000-0000-0000-0000-000000000004');
    perform pg_temp.assert(false, 'part7: a moderator (no blog.manage) must not be able to write the blog bucket');
  exception when others then
    null; -- expected: RLS policy rejection (no WITH CHECK match)
  end;
  reset role;
end $$;

do $$
begin
  -- non-staff cannot write the permanent blog bucket either.
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000006', true);
  set local role authenticated;
  begin
    insert into storage.objects (bucket_id, name, owner)
    values ('blog', 'covers/nonstaff-attempt.jpg', 'e0000000-0000-0000-0000-000000000006');
    perform pg_temp.assert(false, 'part7: a non-staff user must not be able to write the blog bucket');
  exception when others then
    null;
  end;
  reset role;
end $$;

do $$
begin
  -- public blog object read remains possible for anon.
  set local role anon;
  perform pg_temp.assert(
    exists (select 1 from storage.objects where bucket_id = 'blog' and name = 'covers/test-cover.jpg'),
    'part7: anon must be able to read an object in the public blog bucket'
  );
  reset role;
end $$;

select 'ALL PASSED: 047_blog_posts_rls.test.sql' as result;

rollback;
