-- LOCAL/DISPOSABLE DATABASE, or an authorized database run only.
--
-- Blog Editorial tick / keywords / search ROLLBACK: undoes migration
-- 20261117230000_blog_editorial_keywords.sql. Puts back the six-value
-- category list (Editorial as a category), 102's create_blog_post() /
-- update_blog_post() (9/10 arguments, same grants), 047's
-- publish_blog_post(), and drops search_blog_posts(), keywords and
-- is_editorial.
--
-- LOSSY. Every keyword is dropped. A ticked post becomes category
-- 'editorial' (its own category is not kept), so a re-run of the
-- forward migration needs its section 2a for each such post.
--
-- Run only together with the app revert. Safe to run more than once.

begin;

drop function if exists public.search_blog_posts(text, integer);

alter table public.blog_posts drop constraint if exists blog_posts_category_check;

do $$
begin
  if exists (select 1 from pg_catalog.pg_attribute
             where attrelid = 'public.blog_posts'::regclass and attname = 'is_editorial' and not attisdropped) then
    execute 'update public.blog_posts set category = ''editorial'' where is_editorial';
  end if;
end;
$$;

alter table public.blog_posts
  add constraint blog_posts_category_check
  check (category in ('editorial', 'zeja', 'tregu', 'kultura', 'reflektime', 'vleresime'));

drop function if exists public.create_blog_post(text, text, text, text, text, text, boolean, text, text, boolean, text[]);
drop function if exists public.update_blog_post(uuid, text, text, text, text, text, text, boolean, text, text, boolean, text[]);

alter table public.blog_posts drop column if exists keywords;
alter table public.blog_posts drop column if exists is_editorial;

-- 102's two save functions (copied from migration 20261117180000).
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

revoke all on function public.create_blog_post(text, text, text, text, text, text, boolean, text, text)
  from public, anon, authenticated;
grant execute on function public.create_blog_post(text, text, text, text, text, text, boolean, text, text)
  to authenticated, service_role;
revoke all on function public.update_blog_post(uuid, text, text, text, text, text, text, boolean, text, text)
  from public, anon, authenticated;
grant execute on function public.update_blog_post(uuid, text, text, text, text, text, text, boolean, text, text)
  to authenticated, service_role;

-- 047's publish_blog_post() (no keyword check). CREATE OR REPLACE keeps
-- its owner and grants.
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

commit;
