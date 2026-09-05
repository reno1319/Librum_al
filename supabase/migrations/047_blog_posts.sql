-- LIBRUM 2.0 BLOG-1B: schema + RBAC + storage foundation for the native
-- editorial Blog feature (BLOG-1). This migration is FOUNDATION ONLY --
-- no public /blog, no admin CMS pages, no Markdown rendering, no
-- sitemap integration. Those are later BLOG phases; this migration only
-- has to be safe to sit underneath them, unused, exactly as migration
-- 039 (book_reports) sat underneath MOD-1's own later admin UI.
--
-- ============================================================
-- SECURITY MODEL (BLOG-1A.1's approved correction to BLOG-1A's original
-- draft, verified against this repo's own precedent before writing a
-- single statement here):
--
-- RLS restricts ROWS, never COLUMNS -- a `blog.manage`-gated
-- USING/WITH CHECK policy on a direct table UPDATE would let any
-- genuinely authorized blog.manage staffer set status/published_at/
-- created_by/slug to anything at all in the same call, with no audit
-- trail, because those are legitimate rows for that policy to allow,
-- just with illegitimate column values inside them. This is the same
-- class of hole AUTHOR-1C found in profiles (migration 046's own
-- header): RLS alone cannot express "this column, on this otherwise-
-- permitted row, only through this specific transition."
--
-- The fix, and this repo's own actual convention for every comparably
-- sensitive table (book_reports, refund_requests, staff_members,
-- purchases, payment_disputes, admin_audit_log, book_checkout_intents --
-- all `revoke all ... grant select only`, every mutation through a
-- SECURITY DEFINER RPC): blog_posts gets ZERO table-level INSERT/UPDATE/
-- DELETE grant to anon or authenticated, at all, ever. There is
-- therefore no INSERT/UPDATE/DELETE RLS policy to write either -- with
-- no grant for those commands, a policy for them would never be
-- evaluated (same reasoning book_reports/refund_requests/staff_members
-- already apply: RLS does not grant privileges).
--
-- Every write -- including ordinary field edits, not just publish/
-- unpublish/delete -- goes through one of the five RPCs below. This is
-- deliberately NOT a column-grant-plus-trigger hybrid: a direct client
-- call under this design has no table privilege to reach a trigger
-- with in the first place, so "no grant at all" closes the threat more
-- simply than "grant plus a trigger that then has to re-derive the same
-- rule the RPC already enforces."
-- ============================================================

-- ============================================================
-- Table
-- ============================================================
create table public.blog_posts (
  id                uuid primary key default gen_random_uuid(),
  title             text not null check (char_length(title) <= 200),
  slug              text not null unique check (char_length(slug) <= 200),
  excerpt           text not null check (char_length(excerpt) <= 500),
  content_markdown  text not null check (char_length(content_markdown) <= 50000),
  cover_image_path  text,
  category          text not null check (category in ('publishing', 'writing', 'authors-books', 'librum-guides')),
  status            text not null default 'draft' check (status in ('draft', 'published')),
  featured          boolean not null default false,
  seo_title         text check (seo_title is null or char_length(seo_title) <= 70),
  seo_description   text check (seo_description is null or char_length(seo_description) <= 160),
  -- system-authoritative -- set exactly once, by publish_blog_post()
  -- below, on a genuine draft -> published transition, never accepted
  -- from client-submitted data, never reset by a later unpublish/
  -- republish cycle (see publish_blog_post()'s own comment). Mirrors
  -- books.published_at's exact semantics (migration 044).
  published_at      timestamptz,
  -- server/auth-derived only -- never a parameter to create_blog_post(),
  -- so there is no path by which a client can supply this at all, let
  -- alone spoof another staff member's id (see create_blog_post()'s
  -- own comment).
  created_by        uuid not null references public.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Serves both the public /blog listing (status='published', filtered by
-- category, newest first) and the featured/latest queries a later BLOG
-- phase will add -- a single partial index on exactly the predicate
-- every public-facing query shares, mirroring books_status_idx's own
-- shape. Not used by any staff/draft query (blog.view reads span both
-- statuses and are expected to stay small at BLOG-1's scale).
create index blog_posts_public_listing_idx
  on public.blog_posts (status, category, published_at desc)
  where status = 'published';

-- ============================================================
-- Table privileges + RLS: a read-only surface at the grant layer.
-- No insert/update/delete policy exists below -- see this migration's
-- own header for why one would never be evaluated anyway.
-- ============================================================
alter table public.blog_posts enable row level security;

revoke all on public.blog_posts from anon, authenticated;

grant select on public.blog_posts to anon, authenticated;

create policy "Anyone can read published blog posts"
  on public.blog_posts for select
  using (status = 'published');

create policy "Staff with blog.view can read any blog post"
  on public.blog_posts for select
  using (public.staff_has_permission('blog.view'));

-- ============================================================
-- create_blog_post: the only path by which a blog_posts row can ever be
-- created (authenticated has no table-level INSERT grant at all).
-- created_by is deliberately not a parameter -- it is derived
-- exclusively from auth.uid() inside this function body, so a client
-- cannot supply it, let alone spoof another staff member's id, by any
-- means. status is hardcoded 'draft'; published_at is left null --
-- both mirror books' own createBook() invariants exactly. Ordinary
-- creation is not audit-logged, matching this codebase's existing
-- convention that only moderation/state-transition actions are (a plain
-- createBook()/updateBook() isn't audited either).
-- ============================================================
create or replace function public.create_blog_post(
  p_title text,
  p_slug text,
  p_excerpt text,
  p_content_markdown text,
  p_cover_image_path text,
  p_category text,
  p_featured boolean,
  p_seo_title text,
  p_seo_description text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_new_id uuid;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('blog.manage') then
    raise exception 'not authorized';
  end if;

  if p_category not in ('publishing', 'writing', 'authors-books', 'librum-guides') then
    raise exception 'invalid category';
  end if;

  if p_title is null or pg_catalog.char_length(p_title) = 0 or pg_catalog.char_length(p_title) > 200 then
    raise exception 'title must be between 1 and 200 characters';
  end if;
  if p_slug is null or pg_catalog.char_length(p_slug) = 0 or pg_catalog.char_length(p_slug) > 200 then
    raise exception 'slug must be between 1 and 200 characters';
  end if;
  if p_excerpt is null or pg_catalog.char_length(p_excerpt) = 0 or pg_catalog.char_length(p_excerpt) > 500 then
    raise exception 'excerpt must be between 1 and 500 characters';
  end if;
  if p_content_markdown is null or pg_catalog.char_length(p_content_markdown) = 0
     or pg_catalog.char_length(p_content_markdown) > 50000 then
    raise exception 'content_markdown must be between 1 and 50000 characters';
  end if;
  if p_seo_title is not null and pg_catalog.char_length(p_seo_title) > 70 then
    raise exception 'seo_title must be 70 characters or fewer';
  end if;
  if p_seo_description is not null and pg_catalog.char_length(p_seo_description) > 160 then
    raise exception 'seo_description must be 160 characters or fewer';
  end if;

  insert into public.blog_posts
    (title, slug, excerpt, content_markdown, cover_image_path, category, featured,
     seo_title, seo_description, status, created_by)
  values
    (p_title, p_slug, p_excerpt, p_content_markdown, p_cover_image_path, p_category, coalesce(p_featured, false),
     nullif(trim(coalesce(p_seo_title, '')), ''), nullif(trim(coalesce(p_seo_description, '')), ''),
     'draft', v_actor_id)
  returning id into v_new_id;

  return v_new_id;
end;
$$;

revoke all on function public.create_blog_post(text, text, text, text, text, text, boolean, text, text)
  from public, anon, authenticated;
grant execute on function public.create_blog_post(text, text, text, text, text, text, boolean, text, text)
  to authenticated;

-- ============================================================
-- update_blog_post: the only path by which any editable field can
-- change (authenticated has no table-level UPDATE grant at all).
-- status/published_at/created_by/created_at are not parameters at all --
-- there is no way to pass them in, let alone set them, through this
-- function. slug is the one field whose legality depends on the row's
-- CURRENT state (read fresh from the table, never trusted from the
-- caller): editable while status='draft', rejected once
-- status='published' -- this is what makes slug immutability-once-
-- published a database-enforced invariant rather than an admin-UI
-- affordance.
-- ============================================================
create or replace function public.update_blog_post(
  p_id uuid,
  p_title text,
  p_slug text,
  p_excerpt text,
  p_content_markdown text,
  p_cover_image_path text,
  p_category text,
  p_featured boolean,
  p_seo_title text,
  p_seo_description text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_current_slug text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('blog.manage') then
    raise exception 'not authorized';
  end if;

  select status, slug into v_status, v_current_slug
  from public.blog_posts
  where id = p_id;

  if v_status is null then
    raise exception 'no such blog post';
  end if;

  if v_status = 'published' and p_slug is distinct from v_current_slug then
    raise exception 'slug is immutable once a post is published';
  end if;

  if p_category not in ('publishing', 'writing', 'authors-books', 'librum-guides') then
    raise exception 'invalid category';
  end if;

  if p_title is null or pg_catalog.char_length(p_title) = 0 or pg_catalog.char_length(p_title) > 200 then
    raise exception 'title must be between 1 and 200 characters';
  end if;
  if p_slug is null or pg_catalog.char_length(p_slug) = 0 or pg_catalog.char_length(p_slug) > 200 then
    raise exception 'slug must be between 1 and 200 characters';
  end if;
  if p_excerpt is null or pg_catalog.char_length(p_excerpt) = 0 or pg_catalog.char_length(p_excerpt) > 500 then
    raise exception 'excerpt must be between 1 and 500 characters';
  end if;
  if p_content_markdown is null or pg_catalog.char_length(p_content_markdown) = 0
     or pg_catalog.char_length(p_content_markdown) > 50000 then
    raise exception 'content_markdown must be between 1 and 50000 characters';
  end if;
  if p_seo_title is not null and pg_catalog.char_length(p_seo_title) > 70 then
    raise exception 'seo_title must be 70 characters or fewer';
  end if;
  if p_seo_description is not null and pg_catalog.char_length(p_seo_description) > 160 then
    raise exception 'seo_description must be 160 characters or fewer';
  end if;

  update public.blog_posts
  set title = p_title,
      slug = p_slug,
      excerpt = p_excerpt,
      content_markdown = p_content_markdown,
      cover_image_path = p_cover_image_path,
      category = p_category,
      featured = coalesce(p_featured, false),
      seo_title = nullif(trim(coalesce(p_seo_title, '')), ''),
      seo_description = nullif(trim(coalesce(p_seo_description, '')), ''),
      updated_at = pg_catalog.now()
  where id = p_id;
end;
$$;

revoke all on function public.update_blog_post(uuid, text, text, text, text, text, text, boolean, text, text)
  from public, anon, authenticated;
grant execute on function public.update_blog_post(uuid, text, text, text, text, text, text, boolean, text, text)
  to authenticated;

-- ============================================================
-- publish_blog_post: draft -> published only. published_at uses
-- coalesce(published_at, now()) rather than an unconditional now() --
-- since the WHERE guard below only ever matches a 'draft' row,
-- published_at at that point is either genuinely null (a true first
-- publish) or still holds its original value from before an earlier
-- unpublish (a republish) -- coalesce makes both cases correct with one
-- expression, so "first publication sets it, a later republish never
-- resets it" holds without a separate branch. Raises (does not silently
-- no-op) when the row is already published or doesn't exist, matching
-- review_book_report()'s own "must find an expected starting state"
-- convention -- this is a single staff button click, not an
-- at-least-once webhook callback, so a repeat click should surface as
-- "already published," not silently succeed a second time.
-- ============================================================
create or replace function public.publish_blog_post(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_updated_id uuid;
  v_slug text;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('blog.manage') then
    raise exception 'not authorized';
  end if;

  update public.blog_posts
  set status = 'published',
      published_at = coalesce(published_at, pg_catalog.now()),
      updated_at = pg_catalog.now()
  where id = p_id and status = 'draft'
  returning id, slug into v_updated_id, v_slug;

  if v_updated_id is null then
    raise exception 'no publishable draft found for this id';
  end if;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'blog_post.published', 'blog_posts', p_id, jsonb_build_object('slug', v_slug));
end;
$$;

revoke all on function public.publish_blog_post(uuid) from public, anon, authenticated;
grant execute on function public.publish_blog_post(uuid) to authenticated;

-- ============================================================
-- unpublish_blog_post: published -> draft only. published_at is
-- deliberately never included in the SET list at all -- the only way
-- to guarantee "unpublish never alters it" under any future edit to
-- this function is for the column to simply not appear here.
-- ============================================================
create or replace function public.unpublish_blog_post(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_updated_id uuid;
  v_slug text;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('blog.manage') then
    raise exception 'not authorized';
  end if;

  update public.blog_posts
  set status = 'draft',
      updated_at = pg_catalog.now()
  where id = p_id and status = 'published'
  returning id, slug into v_updated_id, v_slug;

  if v_updated_id is null then
    raise exception 'no published post found for this id';
  end if;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'blog_post.unpublished', 'blog_posts', p_id, jsonb_build_object('slug', v_slug));
end;
$$;

revoke all on function public.unpublish_blog_post(uuid) from public, anon, authenticated;
grant execute on function public.unpublish_blog_post(uuid) to authenticated;

-- ============================================================
-- delete_blog_post: draft rows only -- the WHERE clause is the entire
-- enforcement of "a published post can never be deleted," since this
-- is the only statement in the entire schema that ever deletes a
-- blog_posts row (authenticated has no table-level DELETE grant).
--
-- Returns the deleted row's cover_image_path (nullable) so the future
-- Server Action (BLOG-1C) can remove the permanent public cover from
-- storage AFTER this DELETE has already committed, without a second
-- SELECT against a row that no longer exists. Chosen over forcing the
-- caller to fetch cover_image_path beforehand (a stale read: the file
-- could be replaced between the read and the delete, deleting the
-- WRONG object from storage) or making storage deletion part of this
-- RPC (out of scope for a SQL function, and storage cleanup succeeding/
-- failing has no bearing on whether the DB delete itself should
-- commit). RETURNS a single-row TABLE rather than adding an OUT
-- parameter, so a future caller can distinguish "deleted, no cover to
-- clean up" (cover_image_path is null) from "not deleted" (the
-- exception path, no row returned at all) unambiguously.
-- ============================================================
create or replace function public.delete_blog_post(p_id uuid)
returns table (deleted_cover_image_path text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_deleted_id uuid;
  v_slug text;
  v_cover_image_path text;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('blog.manage') then
    raise exception 'not authorized';
  end if;

  delete from public.blog_posts
  where id = p_id and status = 'draft'
  returning id, slug, cover_image_path into v_deleted_id, v_slug, v_cover_image_path;

  if v_deleted_id is null then
    raise exception 'only a draft post can be deleted, or it does not exist';
  end if;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'blog_post.deleted', 'blog_posts', p_id, jsonb_build_object('slug', v_slug));

  return query select v_cover_image_path;
end;
$$;

revoke all on function public.delete_blog_post(uuid) from public, anon, authenticated;
grant execute on function public.delete_blog_post(uuid) to authenticated;

-- ============================================================
-- Storage: staging reuses the existing PRIVATE manuscripts bucket and
-- its existing owner-path policies -- audited directly against this
-- migration's own precondition (BLOG-1A.1's storage review): those
-- policies check only `auth.uid()::text = (storage.foldername(name))[1]`,
-- with no role/permission condition at all, so any authenticated user
-- (staff or not) already has insert/select/update/delete on any path
-- whose first folder segment is their own uid -- <staff-uid>/tmp/blog/
-- <uuid>.<ext> is already a legal path under those existing policies.
-- No new staging policy is added here; adding one would be redundant,
-- not merely unnecessary. A staged-but-never-finalized object under a
-- staffer's own uid is inert, exactly like an abandoned book-cover temp
-- upload today -- the real boundary is the finalize step (BLOG-1C's
-- Server Action, which requires blog.manage before ever calling
-- create_blog_post/update_blog_post with a resulting cover_image_path),
-- never the staging step itself.
--
-- The permanent bucket IS new -- public read (blog cover images are
-- meant to be publicly viewable article assets), writes gated by
-- blog.manage rather than an owner-path check, since blog covers are
-- staff-managed institutional content, not owned by an individual the
-- way author book covers/avatars are.
-- ============================================================
insert into storage.buckets (id, name, public)
values ('blog', 'blog', true)
on conflict (id) do nothing;

create policy "Blog images are publicly readable"
  on storage.objects for select
  using (bucket_id = 'blog');

create policy "Staff with blog.manage can upload blog images"
  on storage.objects for insert
  with check (bucket_id = 'blog' and public.staff_has_permission('blog.manage'));

create policy "Staff with blog.manage can replace blog images"
  on storage.objects for update
  using (bucket_id = 'blog' and public.staff_has_permission('blog.manage'));

create policy "Staff with blog.manage can delete blog images"
  on storage.objects for delete
  using (bucket_id = 'blog' and public.staff_has_permission('blog.manage'));

-- ============================================================
-- Permission matrix: blog.view/blog.manage granted to owner, admin, and
-- editor; editor also gains admin.access (the structural prerequisite
-- to enter /admin/(protected) at all -- see src/lib/staff-permissions.ts's
-- own comment on this). moderator/support are unchanged. This
-- `create or replace` supersedes every earlier one in schema.sql/prior
-- migrations -- the full CASE expression is restated here (not just the
-- new arms) because CASE/CASE-branch bodies replace the whole function,
-- never merge with a previous definition.
--
-- BLOG-1B.1 (found by real Postgres execution, not by inspection):
-- blog_posts is the first table in this schema where BOTH (a) anon
-- holds a genuine table-level SELECT grant and (b) one of its RLS
-- policies OR's in a staff_has_permission() call ("Staff with
-- blog.view can read any blog post"). Every earlier table this
-- function is referenced from (staff_members, book_reports,
-- refund_requests) never grants anon SELECT at all, so anon never
-- reached RLS evaluation there and this gap never surfaced. For the
-- blog_posts draft row, the policy's first disjunct (status='published')
-- is false, so Postgres must evaluate the second (staff_has_permission)
-- for anon too -- which previously raised "permission denied for
-- function" outright, before the function could even return its
-- answer, breaking anon's ability to read the PUBLISHED row as well
-- (the whole query fails, not just the hidden draft row).
--
-- The fix is a widened EXECUTE grant, not a change to the function's
-- own logic or to any table's RLS: staff_has_permission() is `security
-- definer` over `... where sm.user_id = auth.uid() ...`, and anon's
-- auth.uid() is always null (no JWT) -- so for anon this is
-- deterministically false for every permission, with no dependence on
-- which permission is asked or what staff_members actually contains.
-- Granting anon EXECUTE here reveals nothing an anonymous caller
-- couldn't already infer (staff status is never true for anon), and
-- changes no other table's behavior at all -- book_reports/
-- refund_requests/staff_members still grant anon no table-level SELECT
-- whatsoever, so this widened EXECUTE grant is simply never reachable
-- from those tables' own RLS evaluation.
-- ============================================================
create or replace function public.staff_has_permission(p_permission text)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
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
  );
$$;

revoke all on function public.staff_has_permission(text) from public, anon, authenticated;
grant execute on function public.staff_has_permission(text) to anon, authenticated;

-- ============================================================
-- Audit filter allow-lists: list_admin_audit_events() validates its
-- optional p_action/p_target_type filters against a closed vocabulary
-- (migration 042). Only the FILTER is gated this way -- the unfiltered
-- default view (both params null) already shows every admin_audit_log
-- row regardless of this list, so blog events are visible there with no
-- change at all; this addition only lets the filter dropdown narrow to
-- them specifically. Full function body restated (same reasoning as
-- staff_has_permission() above: CREATE OR REPLACE replaces the whole
-- function).
-- ============================================================
create or replace function public.list_admin_audit_events(
  p_action text default null,
  p_actor_id uuid default null,
  p_target_type text default null,
  p_created_after timestamptz default null,
  p_created_before timestamptz default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 25
)
returns table (
  id uuid,
  actor_id uuid,
  actor_display_name text,
  action text,
  target_type text,
  target_id uuid,
  metadata jsonb,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_limit integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('audit.view') then
    raise exception 'not authorized';
  end if;

  if p_action is not null and p_action not in (
    'staff.added', 'staff.role_changed', 'staff.removed',
    'report.resolved', 'report.dismissed',
    'refund.review_approved', 'refund.review_rejected',
    'refund.issuance_submitted',
    'blog_post.published', 'blog_post.unpublished', 'blog_post.deleted'
  ) then
    raise exception 'invalid action filter';
  end if;

  if p_target_type is not null and p_target_type not in (
    'staff_members', 'book_reports', 'refund_requests', 'blog_posts'
  ) then
    raise exception 'invalid target_type filter';
  end if;

  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception 'invalid cursor';
  end if;

  if p_created_after is not null and p_created_before is not null
     and p_created_after >= p_created_before then
    raise exception 'invalid date range';
  end if;

  v_limit := coalesce(p_limit, 25);
  if v_limit < 1 then
    v_limit := 1;
  elsif v_limit > 100 then
    v_limit := 100;
  end if;

  return query
    select
      aal.id,
      aal.actor_id,
      p.display_name as actor_display_name,
      aal.action,
      aal.target_type,
      aal.target_id,
      aal.metadata,
      aal.created_at
    from public.admin_audit_log aal
    left join public.profiles p on p.id = aal.actor_id
    where (p_action is null or aal.action = p_action)
      and (p_actor_id is null or aal.actor_id = p_actor_id)
      and (p_target_type is null or aal.target_type = p_target_type)
      and (p_created_after is null or aal.created_at >= p_created_after)
      and (p_created_before is null or aal.created_at < p_created_before)
      and (
        p_cursor_created_at is null
        or (aal.created_at, aal.id) < (p_cursor_created_at, p_cursor_id)
      )
    order by aal.created_at desc, aal.id desc
    limit v_limit;
end;
$$;

revoke all on function public.list_admin_audit_events(
  text, uuid, text, timestamptz, timestamptz, timestamptz, uuid, integer
) from public, anon, authenticated;
grant execute on function public.list_admin_audit_events(
  text, uuid, text, timestamptz, timestamptz, timestamptz, uuid, integer
) to authenticated;
