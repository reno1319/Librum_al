-- Blog categories (Renato 2026-11-17, design approved 17:25 UTC).
-- Replaces the four V1 blog categories (migration 047) with six:
--
--   editorial   Editorial                   (new; "Nga Librum" tag)
--   zeja        Zeja e Shkrimit             (was writing)
--   tregu       Tregu i Librit & Botimet    (was publishing + librum-guides)
--   kultura     Kulturë & Njohuri           (new)
--   reflektime  Reflektime & Frymëzim       (new)
--   vleresime   Vlerësimet & Rekomandimet   (new)
--
-- Stored values stay plain ASCII; the Albanian names live in
-- src/lib/blog-categories.ts.
--
-- WHAT CHANGES
--   1. blog_posts.category CHECK: the old list is dropped, existing rows
--      are moved, then the new list is added (validated against every
--      row).
--   2. Rows move: "Pse ekziston Librum?" -> editorial (Renato
--      2026-11-17, section 2a0); writing -> zeja; publishing and
--      librum-guides -> tregu (blog5). authors-books rows would be
--      placed post by post in section 2b: on 2026-11-17 neither staging
--      (0 posts) nor Production (4 posts: 2 publishing, 2 librum-guides)
--      has any, so 2b is empty and 2c guards it.
--   3. create_blog_post() and update_blog_post(): same bodies as 047,
--      only the allowed-category list changes. CREATE OR REPLACE keeps
--      their owner and grants (047 + 20261024200000_grants_tightening).
--
-- Nothing else changes: no column, index, policy, grant or other
-- function. updated_at is deliberately left alone on moved rows (a
-- category move is not an edit by staff).
--
-- SAFETY: one transaction. Section 2c stops the whole migration, with
-- nothing changed, if any row would still hold a value outside the new
-- six -- e.g. an authors-books post not yet listed in 2b.
--
-- ROLLOUT ORDER: apply on staging BEFORE the application in the same
-- patch is deployed there (the old app cannot save a post once this
-- runs; the new app cannot show a post until it has run). Production
-- gets it only at a release.
--
-- ROLLBACK: supabase/tests/102_blog_categories.rollback.sql (lossy:
-- see its header).

begin;

-- 1. Drop the old list.
alter table public.blog_posts drop constraint blog_posts_category_check;

-- 2a0. One post by hand (Renato 2026-11-17): Production's draft
-- "Pse ekziston Librum?" is Librum's own voice -> Editorial. Matched by
-- its id AND slug AND old category, so it touches that one row or none
-- (staging has no posts).
update public.blog_posts set category = 'editorial'
where id = '9a3e08e1-4f7a-4340-946c-6963f687c9b9'
  and slug = 'pse-ekziston-librum'
  and category = 'publishing';

-- 2a. Fixed moves.
update public.blog_posts set category = 'zeja'  where category = 'writing';
update public.blog_posts set category = 'tregu' where category in ('publishing', 'librum-guides');

-- 2b. authors-books, post by post: none exist on staging or Production
-- (counted 2026-11-17 from /admin/blog). Should one appear before this
-- runs, 2c stops the migration and a line must be added here.

-- 2c. Stop if anything is left on an old value.
do $$
declare
  v_left integer;
begin
  select pg_catalog.count(*) into v_left
  from public.blog_posts
  where category not in ('editorial', 'zeja', 'tregu', 'kultura', 'reflektime', 'vleresime');
  if v_left > 0 then
    raise exception 'blog categories: % post(s) still on an old category; list them in section 2b', v_left;
  end if;
end;
$$;

-- 3. The new list.
alter table public.blog_posts
  add constraint blog_posts_category_check
  check (category in ('editorial', 'zeja', 'tregu', 'kultura', 'reflektime', 'vleresime'));

-- 4. The two save functions, new list only.
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

  if p_category not in ('editorial', 'zeja', 'tregu', 'kultura', 'reflektime', 'vleresime') then
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

  if p_category not in ('editorial', 'zeja', 'tregu', 'kultura', 'reflektime', 'vleresime') then
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

commit;
