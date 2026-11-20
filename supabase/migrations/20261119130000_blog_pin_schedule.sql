-- Blog: one pinned article and scheduled publishing (Renato 2026-11-19,
-- for Enkelejd; pictures approved 12:31 UTC).
--
--   e3  A scheduled article goes live at the exact minute picked (Tirana
--       time in the app; stored as timestamptz). No timer job: a
--       scheduled article is a published row whose published_at is in
--       the future, and readers only ever see rows whose published_at
--       has passed. The time can be changed or cancelled until then.
--   e4  Only one article can be pinned. Pinning one unpins any other.
--   e5  The web address stays locked once an article is LIVE (a
--       scheduled article that is not live yet can still change it).
--
-- WHAT CHANGES
--   1. At most one featured (pinned) row: any extra pins are cleared
--      (the one the /blog page shows today is kept) and a unique
--      partial index stops a second pin.
--   2. The public read policy: published AND published_at has passed.
--   3. create_blog_post()/update_blog_post(): CREATE OR REPLACE, same
--      signatures, so owner and grants are kept. Pinning clears the
--      other pin first. The slug lock applies only once the row is
--      live.
--   4. unpublish_blog_post(): an article that was scheduled and is not
--      live yet goes back to a draft with published_at cleared (it was
--      never live), so a later Publish sets a fresh time. A post that
--      was live keeps its first published_at as before.
--   5. schedule_blog_post(p_id, p_go_live): new. A draft that has never
--      been live, or a scheduled article that is not live yet, becomes
--      published with published_at = p_go_live. The time must be more
--      than one minute and at most one year away. Needs at least one
--      keyword, like Publish. Audit row 'blog_post.scheduled'.
--   6. search_blog_posts(): same body plus "published_at has passed",
--      so a scheduled article never shows in search early, for staff
--      too.
--
-- SAFETY: one transaction. Section 1 changes at most the extra pins.
-- ROLLOUT ORDER: apply BEFORE the app in the same patch is deployed.
-- With the migration and the old app, readers see the same posts (no
-- row has a future published_at until someone schedules one, which
-- the old app cannot do), and saving a second pin clears the first.
-- ROLLBACK: supabase/tests/106_blog_pin_schedule.rollback.sql.

begin;

-- 1. One pin.
update public.blog_posts
set featured = false
where featured
  and id <> (
    select id from public.blog_posts
    where featured
    order by (status = 'published' and published_at <= pg_catalog.now()) desc,
             published_at desc nulls last, updated_at desc, id
    limit 1
  );

create unique index blog_posts_one_pin_idx on public.blog_posts (featured) where featured;

-- 2. Readers see live rows only.
drop policy "Anyone can read published blog posts" on public.blog_posts;
create policy "Anyone can read published blog posts"
  on public.blog_posts for select
  using (status = 'published' and published_at is not null and published_at <= pg_catalog.now());

-- 3a. create_blog_post: pin clears the other pin.
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

  if pg_catalog.cardinality(coalesce(p_keywords, '{}')) > 10 then
    raise exception 'too many keywords';
  end if;
  foreach v_keyword in array coalesce(p_keywords, '{}') loop
    if v_keyword is null or pg_catalog.char_length(pg_catalog.btrim(v_keyword)) = 0
       or pg_catalog.char_length(v_keyword) > 40 then
      raise exception 'each keyword must be between 1 and 40 characters';
    end if;
  end loop;

  -- e4: one pin.
  if coalesce(p_featured, false) then
    update public.blog_posts set featured = false where featured;
  end if;

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

-- 3b. update_blog_post: pin clears the other pin; slug locked once live.
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
  v_published_at timestamptz;
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

  select status, published_at, slug, is_editorial, keywords
    into v_status, v_published_at, v_current_slug, v_is_editorial, v_keywords
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
      updated_at = pg_catalog.now()
  where id = p_id;
end;
$$;

-- 4. unpublish_blog_post: a not-yet-live scheduled article goes back to
-- a draft that has never been live.
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
  v_was_scheduled boolean;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('blog.manage') then
    raise exception 'not authorized';
  end if;

  select published_at > pg_catalog.now() into v_was_scheduled
  from public.blog_posts
  where id = p_id and status = 'published'
  for update;

  update public.blog_posts
  set status = 'draft',
      published_at = case when coalesce(v_was_scheduled, false) then null else published_at end,
      updated_at = pg_catalog.now()
  where id = p_id and status = 'published'
  returning id, slug into v_updated_id, v_slug;

  if v_updated_id is null then
    raise exception 'no published post found for this id';
  end if;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (
    v_actor_id,
    case when coalesce(v_was_scheduled, false) then 'blog_post.schedule_cancelled' else 'blog_post.unpublished' end,
    'blog_posts', p_id, jsonb_build_object('slug', v_slug)
  );
end;
$$;

-- 5. schedule_blog_post.
create function public.schedule_blog_post(p_id uuid, p_go_live timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_status text;
  v_published_at timestamptz;
  v_keywords text[];
  v_slug text;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('blog.manage') then
    raise exception 'not authorized';
  end if;

  if p_go_live is null or p_go_live <= pg_catalog.now() + interval '1 minute' then
    raise exception 'the go-live time must be in the future';
  end if;
  if p_go_live > pg_catalog.now() + interval '1 year' then
    raise exception 'the go-live time must be within a year';
  end if;

  select status, published_at, keywords, slug
    into v_status, v_published_at, v_keywords, v_slug
  from public.blog_posts
  where id = p_id
  for update;

  if v_status is null then
    raise exception 'no such blog post';
  end if;

  if not (
    (v_status = 'draft' and v_published_at is null)
    or (v_status = 'published' and v_published_at > pg_catalog.now())
  ) then
    raise exception 'only a draft that has never been live can be scheduled';
  end if;

  if pg_catalog.cardinality(v_keywords) = 0 then
    raise exception 'a published article needs at least one keyword';
  end if;

  update public.blog_posts
  set status = 'published',
      published_at = p_go_live,
      updated_at = pg_catalog.now()
  where id = p_id;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'blog_post.scheduled', 'blog_posts', p_id,
          jsonb_build_object('slug', v_slug, 'go_live', p_go_live));
end;
$$;

revoke all on function public.schedule_blog_post(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.schedule_blog_post(uuid, timestamptz) to authenticated;

-- 6. search_blog_posts: live rows only.
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
    and p.published_at <= pg_catalog.now()
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
