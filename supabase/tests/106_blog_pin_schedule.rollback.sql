-- ROLLBACK for migration 20261119130000_blog_pin_schedule.sql.
-- LOCAL/DISPOSABLE DATABASE TEST, or a deliberate rollback only.
-- Lossy: an article that is scheduled and not live yet goes back to a
-- draft that has never been live (status 'draft', published_at null);
-- the single remaining pin is kept.
-- Restores: the public read policy (published only), create/update/
-- search as in migration 20261117230000, unpublish as in migration 047;
-- drops schedule_blog_post() and the one-pin index.

begin;

update public.blog_posts
set status = 'draft', published_at = null
where status = 'published' and published_at > pg_catalog.now();

drop function if exists public.schedule_blog_post(uuid, timestamptz);
drop index if exists public.blog_posts_one_pin_idx;

drop policy "Anyone can read published blog posts" on public.blog_posts;
create policy "Anyone can read published blog posts"
  on public.blog_posts for select
  using (status = 'published');

create or replace function public.create_blog_post(
  p_title text,
  p_slug text,
  p_excerpt text,
  p_content_markdown text,
  p_cover_image_path text,
  p_category text,
  p_featured boolean,
  p_seo_title text,
  p_seo_description text,
  p_is_editorial boolean default false,
  p_keywords text[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_new_id uuid;
  v_keyword text;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('blog.manage') then
    raise exception 'not authorized';
  end if;

  if p_category is null or p_category not in ('zeja', 'tregu', 'kultura', 'reflektime', 'vleresime') then
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

  -- bs4: at most 10 keywords, each 1-40 characters (no blanks/NULLs).
  if pg_catalog.cardinality(coalesce(p_keywords, '{}')) > 10 then
    raise exception 'too many keywords';
  end if;
  foreach v_keyword in array coalesce(p_keywords, '{}') loop
    if v_keyword is null or pg_catalog.char_length(pg_catalog.btrim(v_keyword)) = 0
       or pg_catalog.char_length(v_keyword) > 40 then
      raise exception 'each keyword must be between 1 and 40 characters';
    end if;
  end loop;

  insert into public.blog_posts
    (title, slug, excerpt, content_markdown, cover_image_path, category, featured,
     seo_title, seo_description, status, created_by, is_editorial, keywords)
  values
    (p_title, p_slug, p_excerpt, p_content_markdown, p_cover_image_path, p_category, coalesce(p_featured, false),
     nullif(trim(coalesce(p_seo_title, '')), ''), nullif(trim(coalesce(p_seo_description, '')), ''),
     'draft', v_actor_id, coalesce(p_is_editorial, false), coalesce(p_keywords, '{}'))
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
  p_seo_description text,
  p_is_editorial boolean default null,
  p_keywords text[] default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_current_slug text;
  v_is_editorial boolean;
  v_keywords text[];
  v_keyword text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('blog.manage') then
    raise exception 'not authorized';
  end if;

  select status, slug, is_editorial, keywords
    into v_status, v_current_slug, v_is_editorial, v_keywords
  from public.blog_posts
  where id = p_id;

  if v_status is null then
    raise exception 'no such blog post';
  end if;

  if v_status = 'published' and p_slug is distinct from v_current_slug then
    raise exception 'slug is immutable once a post is published';
  end if;

  if p_category is null or p_category not in ('zeja', 'tregu', 'kultura', 'reflektime', 'vleresime') then
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

  -- NULL = keep what the row has (an older caller that does not send
  -- the two new parameters).
  v_is_editorial := coalesce(p_is_editorial, v_is_editorial);
  v_keywords := coalesce(p_keywords, v_keywords);

  if pg_catalog.cardinality(v_keywords) > 10 then
    raise exception 'too many keywords';
  end if;
  foreach v_keyword in array v_keywords loop
    if v_keyword is null or pg_catalog.char_length(pg_catalog.btrim(v_keyword)) = 0
       or pg_catalog.char_length(v_keyword) > 40 then
      raise exception 'each keyword must be between 1 and 40 characters';
    end if;
  end loop;

  -- bs4: a live post always keeps at least one keyword.
  if v_status = 'published' and pg_catalog.cardinality(v_keywords) = 0 then
    raise exception 'a published article needs at least one keyword';
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
      is_editorial = v_is_editorial,
      keywords = v_keywords,
      updated_at = pg_catalog.now()
  where id = p_id;
end;
$$;

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

create or replace function public.search_blog_posts(search_term text, result_limit integer default 30)
returns table (post_id uuid)
language sql
security invoker
set search_path = ''
stable
as $$
  with raw_words as (
    select w
    from pg_catalog.regexp_split_to_table(pg_catalog.btrim(pg_catalog.left(coalesce(search_term, ''), 200)), '\s+') as w
    where w <> ''
    limit 5
  ),
  words as (
    select pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
             pg_catalog.replace(extensions.unaccent(w), '-', ''),
             '\', '\\'), '%', '\%'), '_', '\_') as pattern
    from raw_words
  ),
  usable as (
    select pattern from words where pattern <> ''
  )
  select p.id as post_id
  from public.blog_posts p
  where p.status = 'published'
    and exists (select 1 from usable)
    and not exists (
      select 1
      from usable u
      where not (
        pg_catalog.replace(
          extensions.unaccent(p.title || ' ' || p.excerpt || ' ' || pg_catalog.array_to_string(p.keywords, ' ')),
          '-', ''
        ) ilike '%' || u.pattern || '%'
      )
    )
  order by p.published_at desc nulls last, p.id
  limit least(greatest(coalesce(result_limit, 30), 1), 50);
$$;

commit;
