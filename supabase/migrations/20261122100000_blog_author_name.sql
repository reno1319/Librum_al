-- Blog: a "Written by" name on an article (Renato 2026-11-22, item 4;
-- pictures approved 09:43 UTC).
--
--   au1 a  Staff type any name in an optional "Written by" box; empty =
--          no name; it is not linked to an account.
--   au2 a  A typed name shows as "Nga [name]" on any article. No name:
--          an Editorial article shows "Nga Librum", others no byline
--          (as before). That choice is the app's; the database only
--          keeps the name.
--
-- WHAT CHANGES (no row is updated):
--   1. blog_posts.author_name: new nullable text column with a named
--      CHECK (trimmed, 1..80 characters, no control characters). Every
--      existing row gets null, which the CHECK accepts. Added to the
--      public column SELECT grant (blog_posts uses column grants, see
--      migration 20261117230000).
--   2. create_blog_post()/update_blog_post() are DROPPED and re-created
--      with one more parameter at the end, p_author_name, with a
--      default so the current 11-argument calls still resolve: create
--      defaults to NULL (no name); update defaults to NULL = "keep what
--      the row has", '' (or only spaces) removes the name. Bodies are
--      the ones from migration 20261119180000 plus the name lines.
--      Grants are re-stated exactly as before (authenticated +
--      service_role only).
--
-- SAFETY: one transaction; nothing is copied or moved.
-- ROLLOUT ORDER: apply BEFORE the app in the same patch is deployed (the
-- new app reads author_name and sends p_author_name). The old app keeps
-- working on the migrated database: its calls resolve through the
-- defaults and never touch the name.
-- ROLLBACK: supabase/tests/110_blog_author_name.rollback.sql (lossy: the
-- names are dropped with the column).

begin;

-- 1. The column.
alter table public.blog_posts
  add column author_name text
    constraint blog_posts_author_name_check
    check (author_name is null
           or (pg_catalog.char_length(author_name) between 1 and 80
               and author_name = pg_catalog.btrim(author_name)
               and author_name !~ '[[:cntrl:]]'));

grant select (author_name) on public.blog_posts to anon, authenticated;

-- 2. The two functions, one parameter more.
drop function public.create_blog_post(text, text, text, text, text, text, boolean, text, text, boolean, text[]);
drop function public.update_blog_post(uuid, text, text, text, text, text, text, boolean, text, text, boolean, text[]);

create function public.create_blog_post(
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
  p_keywords text[] default '{}',
  p_author_name text default null
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
  -- Written by: trimmed; empty = no name ("Nga Librum" / none).
  v_author_name text := nullif(pg_catalog.btrim(coalesce(p_author_name, '')), '');
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('blog.manage') then
    raise exception 'not authorized';
  end if;

  -- Patch B: any blog_categories row except the Editorial section.
  if p_category is null or p_category = 'editorial'
     or not exists (select 1 from public.blog_categories c where c.value = p_category) then
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

  if pg_catalog.cardinality(coalesce(p_keywords, '{}')) > 10 then
    raise exception 'too many keywords';
  end if;
  foreach v_keyword in array coalesce(p_keywords, '{}') loop
    if v_keyword is null or pg_catalog.char_length(pg_catalog.btrim(v_keyword)) = 0
       or pg_catalog.char_length(v_keyword) > 40 then
      raise exception 'each keyword must be between 1 and 40 characters';
    end if;
  end loop;

  if v_author_name is not null
     and (pg_catalog.char_length(v_author_name) > 80 or v_author_name ~ '[[:cntrl:]]') then
    raise exception 'author_name must be 80 characters or fewer, with no control characters';
  end if;

  -- e4: one pin.
  if coalesce(p_featured, false) then
    update public.blog_posts set featured = false where featured;
  end if;

  insert into public.blog_posts
    (title, slug, excerpt, content_markdown, cover_image_path, category, featured,
     seo_title, seo_description, status, created_by, is_editorial, keywords, author_name)
  values
    (p_title, p_slug, p_excerpt, p_content_markdown, p_cover_image_path, p_category, coalesce(p_featured, false),
     nullif(trim(coalesce(p_seo_title, '')), ''), nullif(trim(coalesce(p_seo_description, '')), ''),
     'draft', v_actor_id, coalesce(p_is_editorial, false), coalesce(p_keywords, '{}'), v_author_name)
  returning id into v_new_id;

  return v_new_id;
end;
$$;

create function public.update_blog_post(
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
  p_keywords text[] default null,
  p_author_name text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_published_at timestamptz;
  v_current_slug text;
  v_is_editorial boolean;
  v_keywords text[];
  v_keyword text;
  v_author_name text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('blog.manage') then
    raise exception 'not authorized';
  end if;

  select status, published_at, slug, is_editorial, keywords, author_name
    into v_status, v_published_at, v_current_slug, v_is_editorial, v_keywords, v_author_name
  from public.blog_posts
  where id = p_id;

  if v_status is null then
    raise exception 'no such blog post';
  end if;

  -- e5: locked once live. A scheduled article that is not live yet
  -- can still change it.
  if v_status = 'published' and v_published_at <= pg_catalog.now()
     and p_slug is distinct from v_current_slug then
    raise exception 'slug is immutable once a post is published';
  end if;

  -- Patch B: any blog_categories row except the Editorial section.
  if p_category is null or p_category = 'editorial'
     or not exists (select 1 from public.blog_categories c where c.value = p_category) then
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

  -- A live or scheduled post always keeps at least one keyword.
  if v_status = 'published' and pg_catalog.cardinality(v_keywords) = 0 then
    raise exception 'a published article needs at least one keyword';
  end if;

  -- Written by: NULL = keep what the row has (an older call without
  -- the parameter); '' or spaces = remove the name; otherwise trimmed.
  if p_author_name is not null then
    v_author_name := nullif(pg_catalog.btrim(p_author_name), '');
  end if;
  if v_author_name is not null
     and (pg_catalog.char_length(v_author_name) > 80 or v_author_name ~ '[[:cntrl:]]') then
    raise exception 'author_name must be 80 characters or fewer, with no control characters';
  end if;

  -- e4: one pin.
  if coalesce(p_featured, false) then
    update public.blog_posts set featured = false where featured and id <> p_id;
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
      author_name = v_author_name,
      updated_at = pg_catalog.now()
  where id = p_id;
end;
$$;

revoke all on function public.create_blog_post(text, text, text, text, text, text, boolean, text, text, boolean, text[], text)
  from public, anon, authenticated;
grant execute on function public.create_blog_post(text, text, text, text, text, text, boolean, text, text, boolean, text[], text)
  to authenticated, service_role;

revoke all on function public.update_blog_post(uuid, text, text, text, text, text, text, boolean, text, text, boolean, text[], text)
  from public, anon, authenticated;
grant execute on function public.update_blog_post(uuid, text, text, text, text, text, text, boolean, text, text, boolean, text[], text)
  to authenticated, service_role;

commit;
